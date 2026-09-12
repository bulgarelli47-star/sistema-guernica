// MT-1E2C2B: primera herramienta administrativa con capacidad real de escritura sobre una
// business DB. Certifica el estado legacy de una business DB explicita (LEGACY o CENTRAL) y, si
// corresponde, registra "001_legacy_runtime_baseline" en atlas_schema_migrations. Toda autoridad
// final (identity, history, 252 invariantes, recheck de ambos) ocurre sobre la MISMA conexion A,
// dentro de un unico BEGIN IMMEDIATE -- nunca sobre un verifier path-based que abriria una
// segunda conexion. El backup WAL-safe pre-adopcion se crea con una conexion B de solo lectura
// mientras A mantiene el lock, y solo despues de confirmar que la adopcion realmente procedera
// (history UNVERSIONED + identity valida + 252 invariantes listas), para no dejar backups
// huerfanos. Deliberadamente SIN integracion runtime, SIN reparacion de schema, SIN migracion de
// datos, SIN provisioning de tenant_identity -- ver MT-1E2C2B.0/.1/.2 para el contrato cerrado.
const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3");
const { resolveEmpresaDbPath, getQuery: getQueryControl, closeDb: closeDbControl } = require("./init-control-db");
const { abrirControlDbSoloLectura } = require("../backend/centralAuthResolver");
const { verificarLegacyBaselineEnConexion } = require("../backend/legacyBaselineVerifier");
const { verificarBusinessSchemaVersionEnConexion, baselinePresent } = require("../backend/businessSchemaVersion");
const { verificarTenantDbIdentityEnConexion } = require("../backend/tenantDbIdentity");
const { crearBackupSQLite } = require("../backend/sqliteBackup");

const MIGRATION_ID = "001_legacy_runtime_baseline";

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
    throw crearError("INVALID_ARGUMENT", "adoptarLegacyBaseline: options debe ser un objeto");
  }
  if (options.mode !== "LEGACY" && options.mode !== "CENTRAL") {
    throw crearError("INVALID_ARGUMENT", "adoptarLegacyBaseline: mode debe ser exactamente \"LEGACY\" o \"CENTRAL\"");
  }
  const camposRequeridos = options.mode === "CENTRAL"
    ? ["controlDbPath", "empresaSlug", "businessDbPath", "backupPath"]
    : ["businessDbPath", "backupPath"];
  for (const campo of camposRequeridos) {
    if (typeof options[campo] !== "string" || options[campo].trim() === "") {
      throw crearError("INVALID_ARGUMENT", `adoptarLegacyBaseline: ${campo} debe ser un string no vacio`);
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

// ==== Helpers SQLite locales (promisificados, sin dependencias externas nuevas) ====

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
// exige el resolver runtime (backend/tenantDbRegistry.js). Adoption es una operacion
// administrativa de preparacion, no trafico runtime -- una empresa inactiva puede adoptarse. Se
// reutiliza resolveEmpresaDbPath (anti-path-traversal ya cerrado) en vez de reimplementarlo; NO
// se modifica backend/tenantDbRegistry.js. ====
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

// Codigos que este modulo ya construye deliberadamente con su semantica final -- cualquier otro
// error (excepcion nativa de sqlite3 no anticipada) se mapea a BUSINESS_DB_ERROR dentro de la
// ventana bloqueada, nunca se deja pasar crudo.
const CODIGOS_PROPIOS = new Set([
  "BUSINESS_DB_BUSY",
  "TENANT_DB_IDENTITY_MISSING",
  "TENANT_DB_IDENTITY_INVALID",
  "TENANT_DB_IDENTITY_MISMATCH",
  "TENANT_DB_IDENTITY_ARGUMENTOS_INVALIDOS",
  "TENANT_DB_IDENTITY_QUERY_ERROR",
  "BACKUP_ERROR",
  "BACKUP_INVALID",
  "ADOPTION_WRITE_ERROR"
]);

async function ejecutarAdopcion(options) {
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
      // 1. CENTRAL: identity sobre A (misma conexion).
      if (mode === "CENTRAL") {
        const identidad = await verificarTenantDbIdentityEnConexion(dbA, {
          empresaId: empresaBinding.id,
          empresaSlug: empresaBinding.slug
        });
        if (!identidad.ok) {
          throw crearError(identidad.errorCode, identidad.message);
        }
      }

      // 2-5. history sobre A (misma conexion).
      const historyInicial = await verificarBusinessSchemaVersionEnConexion(dbA);

      if (baselinePresent(historyInicial.state)) {
        await rollbackSeguro(dbA, transactionStartedRef);
        return { status: "ALREADY_BASELINED", migrationId: MIGRATION_ID };
      }
      if (historyInicial.state === "INVALID_HISTORY") {
        await rollbackSeguro(dbA, transactionStartedRef);
        return { status: "INVALID_HISTORY" };
      }
      if (historyInicial.state !== "UNVERSIONED") {
        throw crearError("BUSINESS_DB_ERROR", `Estado de history inesperado (fail-closed): ${historyInicial.state}`);
      }

      // 6. 252 invariantes sobre A (misma conexion).
      const readiness = await verificarLegacyBaselineEnConexion(dbA);
      if (!readiness.ready) {
        await rollbackSeguro(dbA, transactionStartedRef);
        return { status: "NOT_READY", failures: readiness.failures };
      }

      // 7. SOLO ahora (candidato real confirmado): backup, con A todavia en BEGIN IMMEDIATE.
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
        // Cerrar SIEMPRE antes de decidir limpieza -- en Windows, borrar un archivo con un
        // handle abierto falla silenciosamente (ver testMT1E2C2BBackupInvalidIntegrityBlocksAdoption).
        await cerrarDb(backupVerifier);
      }
      if (errorIntegridad) {
        limpiarBackupParcial(backupResuelto);
        throw errorIntegridad;
      }

      // === VALID_BACKUP alcanzado: desde aqui el backup NUNCA se borra por fallas posteriores. ===

      const historyRecheck = await verificarBusinessSchemaVersionEnConexion(dbA);
      if (historyRecheck.state !== "UNVERSIONED") {
        throw crearError("ADOPTION_WRITE_ERROR", "El history cambio entre el chequeo inicial y el recheck");
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

      try {
        await runQuery(
          dbA,
          `CREATE TABLE atlas_schema_migrations (
            sequence INTEGER NOT NULL UNIQUE CHECK(sequence >= 1),
            migration_id TEXT PRIMARY KEY NOT NULL,
            applied_at TEXT NOT NULL
          )`
        );
        await runQuery(
          dbA,
          "INSERT INTO atlas_schema_migrations (sequence, migration_id, applied_at) VALUES (1, ?, datetime('now'))",
          [MIGRATION_ID]
        );
        await runQuery(dbA, "COMMIT");
        transactionStartedRef.value = false;
      } catch (error) {
        throw crearError("ADOPTION_WRITE_ERROR", error.message);
      }

      return { status: "ADOPTED", migrationId: MIGRATION_ID, backupPath: backupResuelto };
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

function adoptarLegacyBaseline(options) {
  const validado = validarOptions(options);
  return ejecutarAdopcion(validado);
}

module.exports = {
  adoptarLegacyBaseline
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
      .then(() => adoptarLegacyBaseline(cliOptions))
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
