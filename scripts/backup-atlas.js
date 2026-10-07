// BACKUP-1: snapshot operacional de ATLAS (Control DB + TODAS las business DB registradas + uploads +
// manifest verificable). Reemplaza la cobertura de scripts/backup-db.js (legacy, una sola business DB),
// que se conserva sin cambios mientras BACKUP-1 se certifica (prestart sigue usandolo).
//
// Uso: node scripts/backup-atlas.js --backup-dir <abs> [--uploads-root <abs>] [--keep <n>]
//   (o ATLAS_BACKUP_DIR / ATLAS_BACKUP_KEEP). Modo, Control y business DB salen del MISMO entorno que el
//   runtime: ATLAS_TENANCY_MODE, ATLAS_AUTH_MODE, ATLAS_CONTROL_DB_PATH, GUERNICA_DB_PATH, ATLAS_EMPRESA_SLUG.
//
// GARANTIA DE CONSISTENCIA: cada base se copia con la SQLite Online Backup API (backend/sqliteBackup.js,
// step(-1): todas las paginas en un unico paso bajo un lock de lectura) desde una conexion OPEN_READONLY,
// asi que CADA archivo del snapshot es una imagen transaccionalmente consistente de su base, aun con el
// servidor corriendo. NO hay garantia de un mismo instante ENTRE bases (Control vs tenants): para un
// snapshot globalmente consistente el procedimiento de Piloto 1 es detener el servidor y los workers
// (PM2) antes de correr este script. Las tenants se enumeran desde la COPIA de Control del snapshot.
//
// FAIL CLOSED: cualquier empresa que deba incluirse con path invalido/fuera del root permitido, symlink,
// archivo ausente (cualquier empresa registrada, activa o no), SQLite invalido o identity distinta hace
// fallar el snapshot COMPLETO:
// el directorio temporal se elimina, no se publica nada y no se aplica retencion.
//
// SECRETOS: el snapshot contiene las business DB tal cual, incluidas las credenciales de integraciones
// CIFRADAS (F5C). Jamas lee ni copia .env, ATLAS_INTEGRATION_MASTER_KEY_B64, secretos de sesion ni tokens
// legacy. Restaurar las bases NO basta para operar integraciones cifradas: hace falta continuidad externa
// de la MISMA master key.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const lib = require("./atlas-snapshot-lib");
const { ALLOWED_DB_DIR, DEFAULT_DB_PATH, resolveEmpresaDbPath } = require("../database/init-control-db");
const { resolveBusinessDbPath } = require("../backend/resolveBusinessDbPath");
const { crearBackupSQLite } = require("../backend/sqliteBackup");
const { verificarBusinessSchemaVersionEnConexion } = require("../backend/businessSchemaVersion");
const { CATEGORIAS_VALIDAS, esFilenameValido } = require("../backend/tenantUploadStorage");

const LEGACY_TENANT_SLUG = "guernica";
const KEEP_DEFAULT = 30;
const { crearError } = lib;

function leerArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!m) throw crearError("BACKUP_ARGUMENTO_INVALIDO", `Argumento invalido: ${argv[i]}`);
    args[m[1]] = m[2] !== undefined ? m[2] : argv[++i];
  }
  return args;
}

function resolverConfiguracion(env, args) {
  const tenancyRaw = String(env.ATLAS_TENANCY_MODE || "single").trim().toLowerCase();
  if (!["single", "multi"].includes(tenancyRaw)) throw crearError("BACKUP_CONFIG_INVALIDA", "ATLAS_TENANCY_MODE invalido");
  const authRaw = String(env.ATLAS_AUTH_MODE || "legacy").trim().toLowerCase();
  if (!["legacy", "central"].includes(authRaw)) throw crearError("BACKUP_CONFIG_INVALIDA", "ATLAS_AUTH_MODE invalido");
  const backupDirRaw = args["backup-dir"] || env.ATLAS_BACKUP_DIR;
  if (!backupDirRaw) throw crearError("BACKUP_DIR_REQUERIDO", "Falta --backup-dir o ATLAS_BACKUP_DIR (destino explicito fuera de los datos)");
  if (!path.isAbsolute(backupDirRaw)) throw crearError("BACKUP_DIR_INVALIDO", "El directorio de backup debe ser absoluto");
  const keep = Number(args.keep || env.ATLAS_BACKUP_KEEP || KEEP_DEFAULT);
  if (!Number.isInteger(keep) || keep < 1) throw crearError("BACKUP_CONFIG_INVALIDA", "keep debe ser un entero >= 1");
  const uploadsRaw = args["uploads-root"] || path.join(lib.ROOT, "uploads");
  if (!path.isAbsolute(uploadsRaw)) throw crearError("BACKUP_CONFIG_INVALIDA", "--uploads-root debe ser absoluto");
  return {
    tenancyMode: tenancyRaw,
    authMode: authRaw,
    controlDbPath: env.ATLAS_CONTROL_DB_PATH ? path.resolve(env.ATLAS_CONTROL_DB_PATH) : DEFAULT_DB_PATH,
    empresaSlug: String(env.ATLAS_EMPRESA_SLUG || "").trim(),
    backupDir: path.resolve(backupDirRaw),
    uploadsRoot: path.resolve(uploadsRaw),
    keep
  };
}

// El destino jamas puede vivir dentro del arbol que se respalda (repo, databases, uploads).
function prepararBackupDir(cfg) {
  for (const raiz of [lib.ROOT, ALLOWED_DB_DIR, cfg.uploadsRoot]) {
    if (lib.dentroDe(raiz, cfg.backupDir) || lib.dentroDe(cfg.backupDir, raiz)) {
      throw crearError("BACKUP_DIR_INVALIDO", "El directorio de backup no puede estar dentro (ni contener) el repo, las bases o los uploads");
    }
  }
  if (fs.existsSync(cfg.backupDir)) lib.exigirDirectorioReal(cfg.backupDir, "BACKUP_DIR_INVALIDO");
  else fs.mkdirSync(cfg.backupDir, { recursive: true });
}

function nuevoSnapshotId() {
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(".", "");
  return `atlas-${ts}-${crypto.randomBytes(3).toString("hex")}`;
}

function gitHead() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: lib.ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

// Copia consistente via Online Backup API y verificacion de la COPIA. Devuelve la conexion READONLY de
// la copia (para leer metadata de lo que efectivamente quedo en el snapshot); el caller la cierra.
async function copiarSqlite(origen, destino, codigoAusente) {
  lib.exigirArchivoRegular(origen, codigoAusente);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  let fuente;
  try {
    fuente = await lib.abrirSoloLectura(origen);
  } catch (error) {
    throw crearError("SNAPSHOT_DB_INACCESIBLE", `No se pudo abrir ${path.basename(origen)}: ${error.message}`);
  }
  try {
    await crearBackupSQLite(fuente, destino, { deadlineMs: 15000 });
  } catch (error) {
    throw crearError("SNAPSHOT_DB_COPIA_FALLIDA", `Online Backup fallo para ${path.basename(origen)}: ${error.message}`);
  } finally {
    await lib.cerrar(fuente);
  }
  const copia = await lib.abrirSoloLectura(destino);
  let integridad;
  try {
    integridad = await lib.integrityCheck(copia);
  } catch (error) {
    await lib.cerrar(copia);
    throw crearError("SNAPSHOT_DB_NO_SQLITE", `${path.basename(origen)} no es una base SQLite valida: ${error.message}`);
  }
  if (integridad !== "ok") {
    await lib.cerrar(copia);
    throw crearError("SNAPSHOT_DB_INTEGRIDAD", `integrity_check fallo en la copia de ${path.basename(origen)}`);
  }
  return copia;
}

// Mismas restricciones del registry (resolveEmpresaDbPath: dentro de ALLOWED_DB_DIR, no el root, no un
// directorio) + rechazo de symlink/junction y de realpath que escape del root permitido.
function resolverPathTenant(dbPathRegistrado) {
  let resuelto;
  try {
    if (typeof dbPathRegistrado !== "string" || !dbPathRegistrado.trim()) throw new Error("db_path vacio");
    resuelto = resolveEmpresaDbPath(dbPathRegistrado);
  } catch (error) {
    throw crearError("TENANT_DB_PATH_INVALID", `db_path registrado invalido: ${error.message}`);
  }
  if (path.resolve(resuelto) === path.resolve(ALLOWED_DB_DIR)) throw crearError("TENANT_DB_PATH_INVALID", "db_path apunta al root de databases");
  if (fs.existsSync(resuelto)) {
    const st = fs.lstatSync(resuelto);
    if (st.isSymbolicLink()) throw crearError("SNAPSHOT_SYMLINK_RECHAZADO", "db_path es un symlink/junction");
    if (st.isDirectory()) throw crearError("TENANT_DB_PATH_INVALID", "db_path apunta a un directorio");
    if (!lib.dentroDe(fs.realpathSync(ALLOWED_DB_DIR), fs.realpathSync(resuelto))) {
      throw crearError("TENANT_DB_PATH_INVALID", "db_path resuelve fuera del root permitido");
    }
  }
  return resuelto;
}

async function metadataTenant(copia) {
  const estado = await verificarBusinessSchemaVersionEnConexion(copia);
  return {
    identity: await lib.leerTenantIdentity(copia),
    schema: { estado: estado.state, ultima_migracion: await lib.leerUltimaMigracion(copia) }
  };
}

// ----- uploads -----
function copiarCategoria(dirOrigen, relBase, tmpDir, inventario) {
  lib.exigirDirectorioReal(dirOrigen, "UPLOAD_ESTRUCTURA_INESPERADA");
  for (const nombre of fs.readdirSync(dirOrigen).sort()) {
    const origen = path.join(dirOrigen, nombre);
    const st = fs.lstatSync(origen);
    if (st.isSymbolicLink()) throw crearError("SNAPSHOT_SYMLINK_RECHAZADO", `Symlink/junction en uploads: ${relBase}/${nombre}`);
    if (!st.isFile()) throw crearError("UPLOAD_ESTRUCTURA_INESPERADA", `Entrada no regular en uploads: ${relBase}/${nombre}`);
    if (!esFilenameValido(nombre)) throw crearError("UPLOAD_NOMBRE_INVALIDO", `Nombre de archivo invalido en uploads: ${relBase}`);
    const rel = `${relBase}/${nombre}`;
    const destino = path.join(tmpDir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    const shaOrigen = lib.sha256Archivo(origen);
    fs.copyFileSync(origen, destino, fs.constants.COPYFILE_EXCL);
    const shaDestino = lib.sha256Archivo(destino);
    if (shaOrigen !== shaDestino) throw crearError("UPLOAD_COPIA_INCONSISTENTE", `El archivo cambio durante la copia: ${rel}`);
    inventario.push({ path: rel, size: fs.statSync(destino).size, sha256: shaDestino });
  }
}

function copiarUploads(cfg, tmpDir, { incluirLegacy, empresaIds }) {
  const inventario = [];
  const noIncluidos = [];
  if (!fs.existsSync(cfg.uploadsRoot)) {
    return { raiz_presente: false, incluye_legacy: incluirLegacy, archivos: 0, bytes: 0, inventario, no_incluidos: noIncluidos };
  }
  lib.exigirDirectorioReal(cfg.uploadsRoot, "UPLOAD_ESTRUCTURA_INESPERADA");
  for (const nombre of fs.readdirSync(cfg.uploadsRoot).sort()) {
    const ruta = path.join(cfg.uploadsRoot, nombre);
    if (CATEGORIAS_VALIDAS.includes(nombre)) {
      if (incluirLegacy) copiarCategoria(ruta, `uploads/${nombre}`, tmpDir, inventario);
      else noIncluidos.push(`uploads/${nombre}`);
    } else if (nombre === "tenants") {
      lib.exigirDirectorioReal(ruta, "UPLOAD_ESTRUCTURA_INESPERADA");
      for (const idTexto of fs.readdirSync(ruta).sort()) {
        const id = Number(idTexto);
        if (!(Number.isInteger(id) && String(id) === idTexto && empresaIds.includes(id))) {
          noIncluidos.push(`uploads/tenants/${idTexto}`);
          continue;
        }
        const raizTenant = path.join(ruta, idTexto);
        lib.exigirDirectorioReal(raizTenant, "UPLOAD_ESTRUCTURA_INESPERADA");
        for (const categoria of fs.readdirSync(raizTenant).sort()) {
          if (CATEGORIAS_VALIDAS.includes(categoria)) {
            copiarCategoria(path.join(raizTenant, categoria), `uploads/tenants/${idTexto}/${categoria}`, tmpDir, inventario);
          } else {
            noIncluidos.push(`uploads/tenants/${idTexto}/${categoria}`);
          }
        }
      }
    } else {
      noIncluidos.push(`uploads/${nombre}`);
    }
  }
  return {
    raiz_presente: true,
    incluye_legacy: incluirLegacy,
    archivos: inventario.length,
    bytes: inventario.reduce((total, a) => total + a.size, 0),
    inventario,
    no_incluidos: noIncluidos
  };
}

// ----- construccion -----
async function construirMulti(cfg, tmpDir) {
  const control = await copiarSqlite(cfg.controlDbPath, path.join(tmpDir, "control", "atlas_control.db"), "CONTROL_DB_AUSENTE");
  let empresas;
  let tablasControl;
  try {
    tablasControl = await lib.leerTablas(control);
    if (!tablasControl.includes("empresas")) throw crearError("CONTROL_DB_INVALIDA", "La Control DB no tiene tabla empresas");
    empresas = await lib.consultar(control, "SELECT id, slug, nombre, db_path, activa FROM empresas ORDER BY id");
  } finally {
    await lib.cerrar(control);
  }

  // BACKUP-1A-R1: TODA fila de `empresas` del Control snapshot es backup-owned. `activa` es solo
  // metadata (habilitacion operativa), nunca un filtro de inclusion: una empresa registrada sin su
  // business DB hace fallar el snapshot completo, este activa o no.
  const tenants = [];
  const pathsVistos = new Map();
  for (const empresa of empresas) {
    const slug = String(empresa.slug || "");
    if (!lib.PATRON_SLUG_SEGURO.test(slug)) throw crearError("TENANT_SLUG_INSEGURO", `Slug no utilizable como carpeta: empresa ${empresa.id}`);
    const activa = Number(empresa.activa) === 1;
    const resuelto = resolverPathTenant(empresa.db_path);
    const clave = process.platform === "win32" ? resuelto.toLowerCase() : resuelto;
    if (pathsVistos.has(clave)) throw crearError("TENANT_DB_PATH_DUPLICADO", `db_path compartido entre empresas ${pathsVistos.get(clave)} y ${empresa.id}`);
    pathsVistos.set(clave, empresa.id);
    if (!fs.existsSync(resuelto)) throw crearError("TENANT_DB_AUSENTE", `Business DB ausente para la empresa registrada ${slug} (activa=${activa ? 1 : 0})`);
    const rel = `tenants/${slug}/business.db`;
    const copia = await copiarSqlite(resuelto, path.join(tmpDir, "tenants", slug, "business.db"), "TENANT_DB_AUSENTE");
    let meta;
    try {
      meta = await metadataTenant(copia);
    } finally {
      await lib.cerrar(copia);
    }
    if (!meta.identity) throw crearError("TENANT_DB_IDENTITY_MISSING", `La business DB de ${slug} no declara tenant_identity`);
    if (meta.identity.empresa_id !== empresa.id || meta.identity.slug !== slug) {
      throw crearError("TENANT_DB_IDENTITY_MISMATCH", `La business DB registrada para ${slug} declara otra identidad`);
    }
    tenants.push({ empresa_id: empresa.id, slug, activa, db_path_registrado: empresa.db_path, relative_path: rel, ...meta });
  }
  return {
    control: { relative_path: "control/atlas_control.db", schema: { tablas: tablasControl, s0: tablasControl.includes("sync_pendiente") && tablasControl.includes("operacion_idempotencia") } },
    tenants,
    uploadsOpciones: { incluirLegacy: tenants.some((t) => t.slug === LEGACY_TENANT_SLUG), empresaIds: tenants.map((t) => t.empresa_id) }
  };
}

async function construirSingle(cfg, tmpDir) {
  const businessPath = resolveBusinessDbPath();
  let control = null;
  let empresasControl = [];
  if (fs.existsSync(cfg.controlDbPath)) {
    const copia = await copiarSqlite(cfg.controlDbPath, path.join(tmpDir, "control", "atlas_control.db"), "CONTROL_DB_AUSENTE");
    try {
      const tablas = await lib.leerTablas(copia);
      control = { relative_path: "control/atlas_control.db", schema: { tablas, s0: tablas.includes("sync_pendiente") && tablas.includes("operacion_idempotencia") } };
      if (tablas.includes("empresas")) empresasControl = await lib.consultar(copia, "SELECT id, slug, db_path, activa FROM empresas ORDER BY id");
    } finally {
      await lib.cerrar(copia);
    }
  } else if (cfg.authMode === "central") {
    throw crearError("CONTROL_DB_AUSENTE", "ATLAS_AUTH_MODE=central requiere la Control DB");
  }

  let empresaCentral = null;
  if (cfg.authMode === "central") {
    if (!cfg.empresaSlug) throw crearError("BACKUP_CONFIG_INVALIDA", "ATLAS_AUTH_MODE=central requiere ATLAS_EMPRESA_SLUG");
    empresaCentral = empresasControl.find((e) => e.slug === cfg.empresaSlug);
    if (!empresaCentral) throw crearError("TENANT_REGISTRY_BINDING_INVALID", "ATLAS_EMPRESA_SLUG no existe en la Control DB");
    if (path.resolve(resolverPathTenant(empresaCentral.db_path)) !== path.resolve(businessPath)) {
      throw crearError("TENANT_DB_PATH_MISMATCH", "GUERNICA_DB_PATH no coincide con el path registrado para la empresa");
    }
  }

  const tmpBusiness = path.join(tmpDir, "tenants", "__single__", "business.db");
  const copia = await copiarSqlite(businessPath, tmpBusiness, "TENANT_DB_AUSENTE");
  let meta;
  try {
    meta = await metadataTenant(copia);
  } finally {
    await lib.cerrar(copia);
  }
  if (empresaCentral) {
    if (!meta.identity) throw crearError("TENANT_DB_IDENTITY_MISSING", "La business DB no declara tenant_identity");
    if (meta.identity.empresa_id !== empresaCentral.id || meta.identity.slug !== empresaCentral.slug) {
      throw crearError("TENANT_DB_IDENTITY_MISMATCH", "La business DB declara otra identidad");
    }
  }
  const slug = meta.identity ? meta.identity.slug : (cfg.empresaSlug || "default");
  if (!lib.PATRON_SLUG_SEGURO.test(slug)) throw crearError("TENANT_SLUG_INSEGURO", "Slug no utilizable como carpeta");
  fs.mkdirSync(path.join(tmpDir, "tenants", slug), { recursive: true });
  fs.renameSync(tmpBusiness, path.join(tmpDir, "tenants", slug, "business.db"));
  fs.rmdirSync(path.join(tmpDir, "tenants", "__single__"));
  const registrada = empresasControl.find((e) => e.slug === slug);
  return {
    control,
    tenants: [{
      empresa_id: meta.identity ? meta.identity.empresa_id : null,
      slug,
      activa: registrada ? Number(registrada.activa) === 1 : true,
      db_path_registrado: registrada ? registrada.db_path : null,
      relative_path: `tenants/${slug}/business.db`,
      ...meta
    }],
    uploadsOpciones: { incluirLegacy: true, empresaIds: [] }
  };
}

function componentes(manifest) {
  const lista = [];
  if (manifest.control) lista.push(manifest.control);
  for (const t of manifest.tenants) lista.push(t);
  for (const a of manifest.uploads.inventario) lista.push({ relative_path: a.path, size: a.size, sha256: a.sha256 });
  return lista;
}

function verificarSnapshotEnDisco(dir, manifest) {
  for (const c of componentes(manifest)) {
    if (!lib.esRutaRelativaSegura(c.relative_path)) throw crearError("SNAPSHOT_RUTA_INVALIDA", `Ruta invalida en manifest: ${c.relative_path}`);
    const ruta = path.join(dir, ...c.relative_path.split("/"));
    const st = lib.exigirArchivoRegular(ruta, "SNAPSHOT_COMPONENTE_AUSENTE");
    if (st.size !== c.size || lib.sha256Archivo(ruta) !== c.sha256) throw crearError("SNAPSHOT_HASH_MISMATCH", `Verificacion fallida: ${c.relative_path}`);
  }
  const texto = fs.readFileSync(path.join(dir, lib.MANIFEST), "utf8");
  if (fs.readFileSync(path.join(dir, lib.MANIFEST_CHECKSUM), "utf8").trim() !== lib.sha256Texto(texto)) {
    throw crearError("SNAPSHOT_MANIFEST_CHECKSUM", "Checksum del manifest invalido");
  }
}

// Retencion SOLO tras publicar y verificar el snapshot nuevo. Solo hijos directos del backup dir con
// nombre de snapshot, directorio real (no symlink) y manifest presente. Jamas toca .tmp-* ni otros nombres.
function aplicarRetencion(cfg, idActual) {
  const snapshots = fs.readdirSync(cfg.backupDir)
    .filter((nombre) => lib.PATRON_SNAPSHOT_ID.test(nombre))
    .filter((nombre) => {
      const st = fs.lstatSync(path.join(cfg.backupDir, nombre));
      return st.isDirectory() && !st.isSymbolicLink() && fs.existsSync(path.join(cfg.backupDir, nombre, lib.MANIFEST));
    })
    .sort();
  const eliminados = [];
  const sobrantes = snapshots.length - cfg.keep;
  for (let i = 0; i < sobrantes; i++) {
    const nombre = snapshots[i];
    if (nombre === idActual) continue;
    const ruta = path.join(cfg.backupDir, nombre);
    if (!lib.dentroDe(cfg.backupDir, ruta) || path.dirname(ruta) !== cfg.backupDir) continue;
    fs.rmSync(ruta, { recursive: true, force: true });
    eliminados.push(nombre);
  }
  return eliminados;
}

async function crearSnapshot(env = process.env, argv = process.argv.slice(2)) {
  const cfg = resolverConfiguracion(env, leerArgs(argv));
  prepararBackupDir(cfg);
  const id = nuevoSnapshotId();
  const tmpDir = path.join(cfg.backupDir, `.tmp-${id}`);
  const finalDir = path.join(cfg.backupDir, id);
  fs.mkdirSync(tmpDir);
  try {
    const parte = cfg.tenancyMode === "multi" ? await construirMulti(cfg, tmpDir) : await construirSingle(cfg, tmpDir);
    const archivo = (rel) => path.join(tmpDir, ...rel.split("/"));
    const conHash = (c) => ({ ...c, size: fs.statSync(archivo(c.relative_path)).size, sha256: lib.sha256Archivo(archivo(c.relative_path)) });
    const manifest = {
      format: lib.FORMATO,
      format_version: lib.FORMATO_VERSION,
      snapshot: {
        id,
        created_at: new Date().toISOString(),
        git_head: gitHead(),
        tenancy_mode: cfg.tenancyMode,
        auth_mode: cfg.authMode,
        garantia_consistencia: "por-base: SQLite Online Backup (step -1) desde conexion READONLY; consistencia global solo con el sistema detenido"
      },
      control: parte.control ? conHash({ ...parte.control, integrity: "ok" }) : null,
      tenants: parte.tenants.map((t) => conHash({ ...t, integrity: "ok" })),
      uploads: copiarUploads(cfg, tmpDir, parte.uploadsOpciones),
      secretos: {
        incluidos: false,
        credenciales_integraciones: "cifradas dentro de las business DB (F5C)",
        requiere_externo: ["ATLAS_INTEGRATION_MASTER_KEY_B64 (la MISMA clave)", ".env / variables del proceso", "credenciales de proveedores externos"]
      }
    };
    const texto = JSON.stringify(manifest, null, 2);
    fs.writeFileSync(path.join(tmpDir, lib.MANIFEST), texto);
    fs.writeFileSync(path.join(tmpDir, lib.MANIFEST_CHECKSUM), `${lib.sha256Texto(texto)}\n`);
    verificarSnapshotEnDisco(tmpDir, manifest);
    fs.renameSync(tmpDir, finalDir);
    const eliminados = aplicarRetencion(cfg, id);
    return { ok: true, snapshot_id: id, path: finalDir, tenants: manifest.tenants.length, uploads: manifest.uploads.archivos, retencion: { keep: cfg.keep, eliminados } };
  } catch (error) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }
}

if (require.main === module) {
  crearSnapshot().then(
    (resultado) => { console.log(JSON.stringify(resultado)); },
    (error) => {
      console.log(JSON.stringify({ ok: false, errorCode: error.code || "BACKUP_ERROR", message: error.message }));
      process.exitCode = 1;
    }
  );
}

module.exports = { crearSnapshot };
