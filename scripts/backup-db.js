const fs = require("fs");
const path = require("path");
const { resolveBusinessDbPath } = require("../backend/resolveBusinessDbPath");
const { resolverTenantDbRegistradoPorSlug } = require("../backend/tenantDbRegistry");
const { verificarTenantDbIdentity } = require("../backend/tenantDbIdentity");

const ROOT = path.resolve(__dirname, "..");
const dbPath = resolveBusinessDbPath();
const backupDir = process.env.GUERNICA_BACKUP_DIR
  ? path.resolve(process.env.GUERNICA_BACKUP_DIR)
  : path.join(ROOT, "backups");
const ifExists = process.argv.includes("--if-exists");
const maxBackups = Number(process.env.GUERNICA_BACKUP_MAX || 30);

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate())
  ].join("-")
    + "_"
    + [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join("-");
}

function pruneBackups() {
  if (!Number.isFinite(maxBackups) || maxBackups <= 0) return;
  const backups = fs.readdirSync(backupDir)
    .filter((name) => name.startsWith("guernica-") && name.endsWith(".db"))
    .map((name) => {
      const fullPath = path.join(backupDir, name);
      return { name, fullPath, mtime: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  for (const backup of backups.slice(maxBackups)) {
    fs.rmSync(backup.fullPath, { force: true });
  }
}

// MT-1D.2B: normalizacion identica a la de backend/server.js -- trim+lowercase, unset/vacio =
// legacy, cualquier valor invalido falla cerrado ANTES de copiar/crear directorio/prunear nada.
function normalizarAuthMode() {
  const raw = String(process.env.ATLAS_AUTH_MODE || "").trim().toLowerCase();
  const modo = raw || "legacy";
  if (modo !== "legacy" && modo !== "central") {
    console.error(`[FATAL] ATLAS_AUTH_MODE invalido: "${process.env.ATLAS_AUTH_MODE}". Valores permitidos: legacy, central.`);
    process.exit(1);
  }
  return modo;
}

// MT-1D.2B: contrato ALL_BUSINESS_DB_ACCESS -- un backup es una copia completa del contenido de la
// business DB, no solo una mutacion; en central debe verificar identidad ANTES de copiar, igual que
// el gate de arranque de backend/server.js, reutilizando las mismas funciones (nunca una
// reimplementacion). Cualquier fallo aca debe impedir copy/mkdir de backupDir/prune, sin excepcion.
async function validarTenantCentralAntesDeCopiar() {
  const empresaSlug = String(process.env.ATLAS_EMPRESA_SLUG || "").trim();
  if (!empresaSlug) {
    console.error("[FATAL] ATLAS_AUTH_MODE=central requiere ATLAS_EMPRESA_SLUG configurado.");
    process.exit(1);
  }

  const registry = await resolverTenantDbRegistradoPorSlug({
    empresaSlug,
    controlDbPath: process.env.ATLAS_CONTROL_DB_PATH || undefined
  });
  if (!registry.ok) {
    console.error(`[FATAL] Tenant registry invalido para ATLAS_EMPRESA_SLUG="${empresaSlug}": ${registry.errorCode} - ${registry.message}`);
    process.exit(1);
  }

  if (dbPath !== registry.db.resolvedPath) {
    console.error(`[FATAL] GUERNICA_DB_PATH configurado (${dbPath}) no coincide con el path registrado para la empresa (${registry.db.resolvedPath})`);
    process.exit(1);
  }

  const identity = await verificarTenantDbIdentity({
    dbPath,
    empresaId: registry.empresa.id,
    empresaSlug: registry.empresa.slug
  });
  if (!identity.ok) {
    console.error(`[FATAL] tenant_identity invalida en ${dbPath}: ${identity.errorCode} - ${identity.message}`);
    process.exit(1);
  }
}

function copiarBackup() {
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `guernica-${timestamp()}.db`);
  fs.copyFileSync(dbPath, backupPath);
  pruneBackups();
  console.log(`Backup creado: ${backupPath}`);
}

(async () => {
  const modo = normalizarAuthMode();

  if (modo === "central") {
    await validarTenantCentralAntesDeCopiar();
    copiarBackup();
    return;
  }

  if (!fs.existsSync(dbPath)) {
    if (ifExists) {
      console.log(`Backup omitido: no existe ${dbPath}`);
      process.exit(0);
    }
    console.error(`No existe la base de datos: ${dbPath}`);
    process.exit(1);
  }

  copiarBackup();
})();
