// MT-1E3B: puente operator-only, NARROW, entre "legacy UNVERSIONED casi-baseline" y "legacy
// UNVERSIONED BASELINE_READY". Complementa a database/adopt-legacy-baseline.js (que exige
// ready:true de entrada y NUNCA transforma schema) sin superponerse: esta herramienta SOLO aplica
// una whitelist cerrada de 4 columnas de sesiones (auth_mode, central_id, membership_id,
// empresa_id) cuando son EXACTAMENTE los unicos gaps reportados por
// verificarLegacyBaselineEnConexion. Cualquier otro gap (tabla, indice, default, data migration)
// fuera de esa whitelist produce NOT_APPLICABLE, nunca un intento de reparacion generica -- esta
// herramienta NUNCA debe convertirse en "ejecutar todas las ensure* de backend/server.js".
// Deliberadamente SIN adoptar (no crea atlas_schema_migrations), SIN migrar 002+, SIN integracion
// runtime -- ver MT-1E3A para el diseño cerrado que motiva este contrato.
const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3");
const { resolveEmpresaDbPath, getQuery: getQueryControl, closeDb: closeDbControl } = require("./init-control-db");
const { abrirControlDbSoloLectura } = require("../backend/centralAuthResolver");
const { verificarLegacyBaselineEnConexion } = require("../backend/legacyBaselineVerifier");
const { verificarBusinessSchemaVersionEnConexion } = require("../backend/businessSchemaVersion");
const { verificarTenantDbIdentityEnConexion } = require("../backend/tenantDbIdentity");
const { crearBackupSQLite } = require("../backend/sqliteBackup");

// Whitelist contractual EXACTA del baseline 001 vigente. Orden = orden de aplicacion. Las
// definiciones SQL son hardcodeadas (nunca derivadas de input externo) y coinciden byte a byte
// con las que backend/server.js:ensureUsuariosSchema ya aplica hoy via self-healing -- esta
// herramienta no inventa un contrato nuevo, solo lo aplica de forma explicita/auditable/con
// backup, en vez de implicita en cada boot de runtime.
const ALLOWED_COLUMN_GAPS = [
  { id: "COLUMN:sesiones.auth_mode", table: "sesiones", column: "auth_mode", definition: "TEXT NOT NULL DEFAULT 'legacy'" },
  { id: "COLUMN:sesiones.central_id", table: "sesiones", column: "central_id", definition: "INTEGER" },
  { id: "COLUMN:sesiones.membership_id", table: "sesiones", column: "membership_id", definition: "INTEGER" },
  { id: "COLUMN:sesiones.empresa_id", table: "sesiones", column: "empresa_id", definition: "INTEGER" }
];

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
    throw crearError("INVALID_ARGUMENT", "prepararLegacyParaBaseline001: options debe ser un objeto");
  }
  if (options.mode !== "DIRECT" && options.mode !== "CENTRAL") {
    throw crearError("INVALID_ARGUMENT", "prepararLegacyParaBaseline001: mode debe ser exactamente \"DIRECT\" o \"CENTRAL\"");
  }
  const camposRequeridos = options.mode === "CENTRAL"
    ? ["controlDbPath", "empresaSlug", "businessDbPath", "backupPath"]
    : ["businessDbPath", "backupPath"];
  for (const campo of camposRequeridos) {
    if (typeof options[campo] !== "string" || options[campo].trim() === "") {
      throw crearError("INVALID_ARGUMENT", `prepararLegacyParaBaseline001: ${campo} debe ser un string no vacio`);
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

// ==== Helpers SQLite locales (promisificados, mismo patron que adopt-legacy-baseline.js /
// migrate-tenant-db.js -- sin dependencias externas nuevas, sin reutilizar ensureColumn de
// backend/server.js, que esta prohibido importar/copiar) ====

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

// ==== CENTRAL: lookup administrativo READONLY, deliberadamente SIN el chequeo de "activa" --
// preparar el baseline es una operacion administrativa, no trafico runtime. Identico en espiritu
// al lookup de adopt-legacy-baseline.js / migrate-tenant-db.js. ====
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

// verificarLegacyBaselineEnConexion devuelve failures como { code, category, resource,
// description } -- NUNCA un campo "id" (ese campo solo existe en la definicion ESTATICA de los
// invariantes dentro de backend/legacyBaselineVerifier.js, no en el resultado de la evaluacion).
// Esta funcion reconstruye el identificador "COLUMN:tabla.columna" a partir de los campos REALES
// que la autoridad si devuelve (category + resource), sin recalcular ni recategorizar nada por
// cuenta propia -- solo para poder comparar contra ALLOWED_COLUMN_GAPS.
function esFailurePermitida(failure) {
  if (failure.category !== "SCHEMA_COLUMN") return null;
  return ALLOWED_COLUMN_GAPS.find((gap) => `${gap.table}.${gap.column}` === failure.resource) || null;
}

// Codigos que este modulo ya construye deliberadamente con su semantica final.
const CODIGOS_PROPIOS = new Set([
  "BUSINESS_DB_BUSY",
  "TENANT_DB_IDENTITY_MISSING",
  "TENANT_DB_IDENTITY_INVALID",
  "TENANT_DB_IDENTITY_MISMATCH",
  "TENANT_DB_IDENTITY_ARGUMENTOS_INVALIDOS",
  "TENANT_DB_IDENTITY_QUERY_ERROR",
  "ALREADY_VERSIONED",
  "BACKUP_ERROR",
  "BACKUP_INVALID",
  "LEGACY_UPGRADE_FAILED"
]);

async function ejecutarPreparacion(options) {
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

      // History sobre A (misma conexion). Esta herramienta SOLO opera sobre UNVERSIONED.
      const history = await verificarBusinessSchemaVersionEnConexion(dbA);
      if (history.state !== "UNVERSIONED") {
        await rollbackSeguro(dbA, transactionStartedRef);
        throw crearError("ALREADY_VERSIONED", "La business DB ya posee historial de versionado.");
      }

      // Baseline precheck sobre A (misma conexion).
      const readiness = await verificarLegacyBaselineEnConexion(dbA);
      if (readiness.ready) {
        await rollbackSeguro(dbA, transactionStartedRef);
        return { status: "ALREADY_BASELINE_READY" };
      }

      // Whitelist: TODOS los failures deben caer dentro de ALLOWED_COLUMN_GAPS, sin excepcion.
      const gapsElegibles = [];
      for (const failure of readiness.failures) {
        const gap = esFailurePermitida(failure);
        if (!gap) {
          await rollbackSeguro(dbA, transactionStartedRef);
          return { status: "NOT_APPLICABLE", failures: readiness.failures };
        }
        gapsElegibles.push(gap);
      }
      if (gapsElegibles.length === 0) {
        // ready:false pero sin ningun failure -- inconsistencia de la autoridad, fail-closed.
        throw crearError("LEGACY_UPGRADE_FAILED", "El baseline reporto ready:false sin failures elegibles ni no elegibles");
      }

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
      if (historyRecheck.state !== "UNVERSIONED") {
        throw crearError("LEGACY_UPGRADE_FAILED", "El history cambio entre el chequeo inicial y el recheck");
      }

      const readinessRecheck = await verificarLegacyBaselineEnConexion(dbA);
      if (readinessRecheck.ready) {
        throw crearError("LEGACY_UPGRADE_FAILED", "El baseline paso a ready:true entre el chequeo inicial y el recheck");
      }
      const gapsElegiblesRecheck = [];
      for (const failure of readinessRecheck.failures) {
        const gap = esFailurePermitida(failure);
        if (!gap) {
          throw crearError("LEGACY_UPGRADE_FAILED", "Aparecio un failure no elegible entre el chequeo inicial y el recheck");
        }
        gapsElegiblesRecheck.push(gap.id);
      }
      const idsIniciales = gapsElegibles.map((g) => g.id).sort();
      const idsRecheck = gapsElegiblesRecheck.slice().sort();
      if (idsIniciales.length !== idsRecheck.length || idsIniciales.some((id, i) => id !== idsRecheck[i])) {
        throw crearError("LEGACY_UPGRADE_FAILED", "El conjunto de gaps elegibles cambio entre el chequeo inicial y el recheck");
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

      // Write phase: SOLO las columnas presentes en gapsElegibles, en orden contractual fijo
      // (ALLOWED_COLUMN_GAPS ya esta en ese orden) -- nunca en el orden en que el verifier las
      // reporto, y nunca una columna que ya estaba presente.
      const idsElegiblesSet = new Set(gapsElegibles.map((g) => g.id));
      const applied = [];
      try {
        for (const gap of ALLOWED_COLUMN_GAPS) {
          if (!idsElegiblesSet.has(gap.id)) continue;
          await runQuery(dbA, `ALTER TABLE ${gap.table} ADD COLUMN ${gap.column} ${gap.definition}`);
          applied.push(gap.id);
        }
      } catch (error) {
        throw crearError("LEGACY_UPGRADE_FAILED", error.message);
      }

      // Post-verify: baseline debe quedar EXACTAMENTE ready:true, y history debe seguir
      // UNVERSIONED -- esta herramienta NUNCA crea atlas_schema_migrations.
      const postBaseline = await verificarLegacyBaselineEnConexion(dbA);
      if (!postBaseline.ready || postBaseline.failures.length !== 0) {
        throw crearError(
          "LEGACY_UPGRADE_FAILED",
          `Post-verify fallo: baseline no quedo ready tras aplicar los gaps (failures=${JSON.stringify(postBaseline.failures)})`
        );
      }
      const postHistory = await verificarBusinessSchemaVersionEnConexion(dbA);
      if (postHistory.state !== "UNVERSIONED") {
        throw crearError("LEGACY_UPGRADE_FAILED", `Post-verify fallo: history dejo de ser UNVERSIONED (${postHistory.state})`);
      }

      try {
        await runQuery(dbA, "COMMIT");
        transactionStartedRef.value = false;
      } catch (error) {
        throw crearError("LEGACY_UPGRADE_FAILED", error.message);
      }

      return { status: "PREPARED_BASELINE_001", applied, backupPath: backupResuelto };
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

function prepararLegacyParaBaseline001(options) {
  const validado = validarOptions(options);
  return ejecutarPreparacion(validado);
}

module.exports = {
  prepararLegacyParaBaseline001
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
      .then(() => prepararLegacyParaBaseline001(cliOptions))
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
