// MT-1E2C3B: motor explicito de migracion de tenant DBs ya versionadas (BEHIND -> CURRENT).
// Complementa a database/adopt-legacy-baseline.js (que lleva UNVERSIONED -> 001) sin superponerse:
// el migrator NUNCA adopta -- una DB UNVERSIONED se rechaza con BASELINE_REQUIRED. Reutiliza
// exactamente las mismas autoridades same-connection ya publicadas (verificarBusinessSchemaVersionEnConexion,
// verificarTenantDbIdentityEnConexion) y el backup compartido de backend/sqliteBackup.js -- cero
// logica duplicada. Catalogo de produccion (database/business-migrations.js) contiene HOY
// UNICAMENTE "001_legacy_runtime_baseline" (kind BASELINE, sin up()) -- no existe una migracion 002
// real (ver MT-1E2C3B.0). El motor queda listo para procesar pendientes en cuanto una migracion
// real se agregue al catalogo, sin rediseñar locking/backup/history/transactions/concurrency/API.
// Deliberadamente SIN integracion runtime, SIN ejecucion automatica, SIN reparacion de schema.
const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3");
const { resolveEmpresaDbPath, getQuery: getQueryControl, closeDb: closeDbControl } = require("./init-control-db");
const { abrirControlDbSoloLectura } = require("../backend/centralAuthResolver");
const { verificarBusinessSchemaVersionEnConexion } = require("../backend/businessSchemaVersion");
const { verificarTenantDbIdentityEnConexion } = require("../backend/tenantDbIdentity");
const { crearBackupSQLite } = require("../backend/sqliteBackup");
const { BUSINESS_MIGRATIONS } = require("./business-migrations");

function crearError(code, message, extra) {
  const error = new Error(message);
  error.code = code;
  if (extra) Object.assign(error, extra);
  return error;
}

function normalizarPathComparacion(valor) {
  const resuelto = path.resolve(valor);
  return process.platform === "win32" ? resuelto.toLowerCase() : resuelto;
}

function validarOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw crearError("INVALID_ARGUMENT", "migrarTenantDb: options debe ser un objeto");
  }
  if (options.mode !== "DIRECT" && options.mode !== "CENTRAL") {
    throw crearError("INVALID_ARGUMENT", "migrarTenantDb: mode debe ser exactamente \"DIRECT\" o \"CENTRAL\"");
  }
  const camposRequeridos = options.mode === "CENTRAL"
    ? ["controlDbPath", "empresaSlug", "businessDbPath", "backupPath"]
    : ["businessDbPath", "backupPath"];
  for (const campo of camposRequeridos) {
    if (typeof options[campo] !== "string" || options[campo].trim() === "") {
      throw crearError("INVALID_ARGUMENT", `migrarTenantDb: ${campo} debe ser un string no vacio`);
    }
  }
  const validado = {
    mode: options.mode,
    businessDbPath: options.businessDbPath,
    backupPath: options.backupPath
  };
  if (options.mode === "CENTRAL") {
    validado.controlDbPath = options.controlDbPath;
    validado.empresaSlug = options.empresaSlug;
  }
  return validado;
}

// ==== Catalog validation (interna, NO exportada). Corre ANTES de cualquier I/O. El catalogo de
// produccion y los catalogos stub de tests pasan por la MISMA validacion. ====
function validarCatalogoMigraciones(catalog) {
  if (!Array.isArray(catalog) || catalog.length === 0) {
    throw crearError("MIGRATION_CATALOG_INVALID", "El catalogo de migraciones debe ser un array no vacio");
  }
  const idsVistos = new Set();
  for (let i = 0; i < catalog.length; i += 1) {
    const entry = catalog[i];
    if (!entry || typeof entry !== "object") {
      throw crearError("MIGRATION_CATALOG_INVALID", `Entrada de catalogo invalida en posicion ${i}`);
    }
    if (!Number.isInteger(entry.sequence) || entry.sequence < 1) {
      throw crearError("MIGRATION_CATALOG_INVALID", `sequence invalida en posicion ${i}`);
    }
    if (entry.sequence !== i + 1) {
      throw crearError("MIGRATION_CATALOG_INVALID", `sequence fuera de orden en posicion ${i}: esperado ${i + 1}, recibido ${entry.sequence}`);
    }
    if (typeof entry.migrationId !== "string" || entry.migrationId.trim() === "" || entry.migrationId !== entry.migrationId.trim()) {
      throw crearError("MIGRATION_CATALOG_INVALID", `migrationId invalido en posicion ${i}`);
    }
    if (idsVistos.has(entry.migrationId)) {
      throw crearError("MIGRATION_CATALOG_INVALID", `migrationId duplicado: ${entry.migrationId}`);
    }
    idsVistos.add(entry.migrationId);

    if (i === 0) {
      if (entry.sequence !== 1 || entry.migrationId !== "001_legacy_runtime_baseline" || entry.kind !== "BASELINE") {
        throw crearError("MIGRATION_CATALOG_INVALID", "La primera entrada debe ser sequence=1, migrationId=001_legacy_runtime_baseline, kind=BASELINE");
      }
    } else {
      if (entry.kind !== "MIGRATION") {
        throw crearError("MIGRATION_CATALOG_INVALID", `Entrada ${entry.migrationId} debe tener kind=MIGRATION`);
      }
      if (typeof entry.up !== "function") {
        throw crearError("MIGRATION_CATALOG_INVALID", `Entrada ${entry.migrationId} (kind=MIGRATION) requiere up(db)`);
      }
    }
  }
}

// ==== Helpers SQLite locales (promisificados, mismo patron que database/adopt-legacy-baseline.js) ====

function abrirReadOnly(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (error) => {
      if (error) { reject(error); return; }
      resolve(db);
    });
  });
}

function abrirReadWriteSinCrear(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (error) => {
      if (error) { reject(error); return; }
      resolve(db);
    });
  });
}

function runQuery(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) { reject(error); return; }
      resolve(this);
    });
  });
}

function getQuery(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) { reject(error); return; }
      resolve(row);
    });
  });
}

function allQuery(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) { reject(error); return; }
      resolve(rows);
    });
  });
}

function cerrarDb(db) {
  return new Promise((resolve) => {
    if (!db) { resolve(); return; }
    db.close(() => resolve());
  });
}

async function rollbackSeguro(db, transactionStartedRef) {
  if (!transactionStartedRef.value) return;
  transactionStartedRef.value = false;
  try {
    await runQuery(db, "ROLLBACK");
  } catch (error) {
    // best-effort: la conexion se cierra de todos modos en el finally del caller
  }
}

function limpiarBackupParcial(backupResuelto) {
  try {
    if (fs.existsSync(backupResuelto)) {
      fs.unlinkSync(backupResuelto);
    }
  } catch (error) {
    // no bloquear el flujo principal por un fallo de cleanup -- el error primario ya se lanza aparte
  }
}

// ==== CENTRAL: lookup administrativo READONLY, deliberadamente SIN el chequeo de "activa" que
// exige el resolver runtime (backend/tenantDbRegistry.js). Migracion es una operacion
// administrativa, no trafico runtime -- una empresa inactiva puede migrarse. Reutiliza
// resolveEmpresaDbPath (anti-path-traversal ya cerrado); NO modifica backend/tenantDbRegistry.js.
// Identico en espiritu al lookup de database/adopt-legacy-baseline.js. ====
async function lookupAdministrativoEmpresa({ controlDbPath, empresaSlug }) {
  if (!fs.existsSync(controlDbPath)) {
    throw crearError("CONTROL_DB_NOT_FOUND", `Control DB no encontrada: ${controlDbPath}`);
  }

  let controlDb;
  try {
    controlDb = await abrirControlDbSoloLectura(controlDbPath);
  } catch (error) {
    throw crearError("CONTROL_DB_ERROR", error.message);
  }

  try {
    let row;
    try {
      row = await getQueryControl(controlDb, "SELECT id, slug, db_path, activa FROM empresas WHERE slug = ?", [empresaSlug]);
    } catch (error) {
      throw crearError("CONTROL_DB_ERROR", error.message);
    }

    if (!row) {
      throw crearError("EMPRESA_NOT_FOUND", `No existe empresa registrada con slug=${empresaSlug}`);
    }

    let resolvedPath;
    try {
      resolvedPath = resolveEmpresaDbPath(row.db_path);
    } catch (error) {
      throw crearError("BUSINESS_DB_PATH_MISMATCH", error.message);
    }

    return {
      id: row.id,
      slug: row.slug,
      activa: Number(row.activa) === 1,
      resolvedPath
    };
  } finally {
    await closeDbControl(controlDb);
  }
}

async function validarBackupPathPreconditions(businessDbPath, backupPath) {
  const businessResuelto = path.resolve(businessDbPath);
  const backupResuelto = path.resolve(backupPath);

  if (normalizarPathComparacion(businessResuelto) === normalizarPathComparacion(backupResuelto)) {
    throw crearError("BACKUP_PATH_INVALID", "backupPath no puede coincidir con businessDbPath");
  }

  const parentDir = path.dirname(backupResuelto);
  let parentStat;
  try {
    parentStat = fs.statSync(parentDir);
  } catch (error) {
    throw crearError("BACKUP_PARENT_NOT_FOUND", `El directorio padre de backupPath no existe: ${parentDir}`);
  }
  if (!parentStat.isDirectory()) {
    throw crearError("BACKUP_PARENT_NOT_FOUND", `El padre de backupPath no es un directorio: ${parentDir}`);
  }

  if (fs.existsSync(backupResuelto)) {
    throw crearError("BACKUP_ALREADY_EXISTS", `El destino de backup ya existe: ${backupResuelto}`);
  }

  return backupResuelto;
}

// Codigos que este modulo construye deliberadamente con su semantica final -- cualquier otro error
// (excepcion nativa de sqlite3 no anticipada) se mapea a BUSINESS_DB_ERROR, nunca se deja pasar crudo.
const CODIGOS_PROPIOS = new Set([
  "MIGRATION_CATALOG_INVALID",
  "BUSINESS_DB_BUSY",
  "TENANT_DB_IDENTITY_MISSING",
  "TENANT_DB_IDENTITY_INVALID",
  "TENANT_DB_IDENTITY_MISMATCH",
  "TENANT_DB_IDENTITY_ARGUMENTOS_INVALIDOS",
  "TENANT_DB_IDENTITY_QUERY_ERROR",
  "BASELINE_REQUIRED",
  "DATABASE_AHEAD",
  "INVALID_HISTORY",
  "BACKUP_PATH_INVALID",
  "BACKUP_PARENT_NOT_FOUND",
  "BACKUP_ALREADY_EXISTS",
  "BACKUP_ERROR",
  "BACKUP_INVALID",
  "MIGRATION_FAILED"
]);

async function ejecutarMigracion(options) {
  const { mode, businessDbPath, backupPath, controlDbPath, empresaSlug } = options;

  let empresaBinding = null;
  if (mode === "CENTRAL") {
    empresaBinding = await lookupAdministrativoEmpresa({ controlDbPath, empresaSlug });
    if (normalizarPathComparacion(empresaBinding.resolvedPath) !== normalizarPathComparacion(businessDbPath)) {
      throw crearError(
        "BUSINESS_DB_PATH_MISMATCH",
        "El db_path registrado para la empresa no coincide con businessDbPath explicito"
      );
    }
  }

  if (!fs.existsSync(businessDbPath)) {
    throw crearError("BUSINESS_DB_NOT_FOUND", `La business DB no existe: ${businessDbPath}`);
  }

  const backupResuelto = await validarBackupPathPreconditions(businessDbPath, backupPath);

  let dbA;
  try {
    dbA = await abrirReadWriteSinCrear(businessDbPath);
  } catch (error) {
    throw crearError("BUSINESS_DB_ERROR", error.message);
  }

  const transactionStartedRef = { value: false };

  try {
    try {
      await runQuery(dbA, "PRAGMA busy_timeout = 5000");
      await runQuery(dbA, "BEGIN IMMEDIATE");
      transactionStartedRef.value = true;
    } catch (error) {
      const codigo = error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED" ? "BUSINESS_DB_BUSY" : "BUSINESS_DB_ERROR";
      throw crearError(codigo, error.message);
    }

    try {
      // CENTRAL: identity sobre A (misma conexion).
      if (mode === "CENTRAL") {
        const identidad = await verificarTenantDbIdentityEnConexion(dbA, {
          empresaId: empresaBinding.id,
          empresaSlug: empresaBinding.slug
        });
        if (!identidad.ok) {
          throw crearError(identidad.errorCode, identidad.message);
        }
      }

      // History sobre A (misma conexion).
      const history = await verificarBusinessSchemaVersionEnConexion(dbA);

      if (history.state === "UNVERSIONED") {
        throw crearError("BASELINE_REQUIRED", "La business DB debe ser adoptada (001_legacy_runtime_baseline) antes de migrar");
      }
      if (history.state === "CURRENT") {
        await rollbackSeguro(dbA, transactionStartedRef);
        return { status: "ALREADY_CURRENT", migrationId: history.currentMigrationId };
      }
      if (history.state === "AHEAD") {
        throw crearError("DATABASE_AHEAD", "El historial de la business DB esta mas avanzado que el catalogo conocido");
      }
      if (history.state === "INVALID_HISTORY") {
        throw crearError("INVALID_HISTORY", "El historial de migraciones de la business DB es invalido");
      }
      if (history.state !== "BEHIND") {
        throw crearError("BUSINESS_DB_ERROR", `Estado de history inesperado (fail-closed): ${history.state}`);
      }

      // BEHIND: leer history real aplicada y derivar pendientes -- nunca reparar/inferir.
      const appliedRows = await allQuery(
        dbA,
        "SELECT sequence, migration_id, applied_at FROM atlas_schema_migrations ORDER BY sequence ASC"
      );
      const pending = BUSINESS_MIGRATIONS.slice(appliedRows.length);
      const fromMigrationId = appliedRows[appliedRows.length - 1].migration_id;

      // SOLO ahora (candidato real confirmado): backup, con A todavia en BEGIN IMMEDIATE.
      let dbB;
      try {
        dbB = await abrirReadOnly(businessDbPath);
      } catch (error) {
        throw crearError("BACKUP_ERROR", error.message);
      }

      try {
        await crearBackupSQLite(dbB, backupResuelto, { deadlineMs: 5000 });
      } catch (error) {
        await cerrarDb(dbB);
        limpiarBackupParcial(backupResuelto);
        throw crearError("BACKUP_ERROR", error.message);
      }
      await cerrarDb(dbB);

      let backupVerifier;
      let errorIntegridad = null;
      try {
        backupVerifier = await abrirReadOnly(backupResuelto);
        const integridad = await getQuery(backupVerifier, "PRAGMA integrity_check");
        if (!integridad || integridad.integrity_check !== "ok") {
          errorIntegridad = crearError("BACKUP_INVALID", "El backup no paso PRAGMA integrity_check");
        }
      } catch (error) {
        errorIntegridad = error.code === "BACKUP_INVALID" ? error : crearError("BACKUP_INVALID", error.message);
      } finally {
        // Cerrar SIEMPRE antes de decidir limpieza -- en Windows, borrar un archivo con un handle
        // abierto falla silenciosamente.
        await cerrarDb(backupVerifier);
      }
      if (errorIntegridad) {
        limpiarBackupParcial(backupResuelto);
        throw errorIntegridad;
      }

      // === VALID_BACKUP alcanzado: desde aqui el backup NUNCA se borra por fallas posteriores. ===

      const historyRecheck = await verificarBusinessSchemaVersionEnConexion(dbA);
      if (historyRecheck.state !== "BEHIND") {
        throw crearError("MIGRATION_FAILED", "El history cambio entre el chequeo inicial y el recheck", {
          migrationId: pending[0].migrationId
        });
      }
      const appliedRowsRecheck = await allQuery(dbA, "SELECT sequence FROM atlas_schema_migrations");
      if (appliedRowsRecheck.length !== appliedRows.length) {
        throw crearError("MIGRATION_FAILED", "El historial cambio entre el chequeo inicial y el recheck", {
          migrationId: pending[0].migrationId
        });
      }

      if (mode === "CENTRAL") {
        const identidadRecheck = await verificarTenantDbIdentityEnConexion(dbA, {
          empresaId: empresaBinding.id,
          empresaSlug: empresaBinding.slug
        });
        if (!identidadRecheck.ok) {
          throw crearError(identidadRecheck.errorCode, identidadRecheck.message);
        }
      }

      const applied = [];
      let migracionEnCurso = pending[0].migrationId;
      try {
        for (const migration of pending) {
          migracionEnCurso = migration.migrationId;
          await migration.up(dbA);
          await runQuery(
            dbA,
            "INSERT INTO atlas_schema_migrations (sequence, migration_id, applied_at) VALUES (?, ?, datetime('now'))",
            [migration.sequence, migration.migrationId]
          );
          applied.push(migration.migrationId);
        }
      } catch (error) {
        throw crearError("MIGRATION_FAILED", error.message, { migrationId: migracionEnCurso });
      }

      const postBatch = await verificarBusinessSchemaVersionEnConexion(dbA);
      if (postBatch.state !== "CURRENT") {
        throw crearError(
          "MIGRATION_FAILED",
          `Post-batch verify fallo: estado final es ${postBatch.state}, se esperaba CURRENT`,
          { migrationId: applied[applied.length - 1] }
        );
      }

      try {
        await runQuery(dbA, "COMMIT");
        transactionStartedRef.value = false;
      } catch (error) {
        throw crearError("MIGRATION_FAILED", error.message, { migrationId: applied[applied.length - 1] });
      }

      return {
        status: "MIGRATED",
        fromMigrationId,
        toMigrationId: applied[applied.length - 1],
        applied,
        backupPath: backupResuelto
      };
    } catch (error) {
      await rollbackSeguro(dbA, transactionStartedRef);
      if (error.code && (CODIGOS_PROPIOS.has(error.code) || error.code.startsWith("TENANT_DB_IDENTITY_"))) {
        throw error;
      }
      if (error.code === "BUSINESS_DB_ERROR") throw error;
      throw crearError("BUSINESS_DB_ERROR", error.message);
    }
  } finally {
    await rollbackSeguro(dbA, transactionStartedRef);
    await cerrarDb(dbA);
  }
}

function migrarTenantDb(options) {
  const validado = validarOptions(options);
  validarCatalogoMigraciones(BUSINESS_MIGRATIONS);
  return ejecutarMigracion(validado);
}

module.exports = {
  migrarTenantDb
};

if (require.main === module) {
  (function cli() {
    const args = process.argv.slice(2);
    function getArg(name) {
      const idx = args.indexOf(`--${name}`);
      return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
    }

    const cliOptions = {
      mode: getArg("mode"),
      businessDbPath: getArg("business-db"),
      backupPath: getArg("backup")
    };
    if (cliOptions.mode === "CENTRAL") {
      cliOptions.controlDbPath = getArg("control-db");
      cliOptions.empresaSlug = getArg("empresa");
    }

    Promise.resolve()
      .then(() => migrarTenantDb(cliOptions))
      .then((resultado) => {
        process.stdout.write(`${JSON.stringify(resultado)}\n`);
        process.exit(0);
      })
      .catch((error) => {
        process.stderr.write(`${JSON.stringify({ code: error.code || "UNKNOWN", message: error.message })}\n`);
        process.exit(1);
      });
  })();
}
