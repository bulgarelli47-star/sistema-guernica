// GAP-1 (MT-1E2B): catalogo de migraciones + clasificador puro + verificador READONLY de estado
// de schema de una business DB explicita. Deliberadamente SIN integracion con backend/server.js,
// backend/db.js, database/init-db.js, tenant attach, connection registry ni tenant identity --
// este slice no migra, no crea schema, no escribe metadata, no adopta ningun baseline. Solo
// interpreta el estado de UNA business DB que el caller indica explicitamente.
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();
const { BUSINESS_MIGRATIONS } = require("../database/business-migrations");

// MT-1E2C3B: derivado de la unica fuente de verdad (database/business-migrations.js) en vez de un
// array hardcodeado aparte -- evita dos catalogos divergentes. Valor publico identico a antes:
// ["001_legacy_runtime_baseline"]. "001_legacy_runtime_baseline" significa "el estado
// estructural/comercial equivalente al contrato legacy baseline fue verificado" -- NUNCA "se
// ejecuto database/init-db.js". Este slice no adopta ninguna DB a este baseline; solo lo declara
// como el estado esperado final contra el cual comparar un historial ya existente.
const BUSINESS_SCHEMA_MIGRATIONS = Object.freeze(BUSINESS_MIGRATIONS.map((migration) => migration.migrationId));

const MIGRATIONS_TABLE = "atlas_schema_migrations";

function crearError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validarCatalogoEsperado(expectedCatalog) {
  if (!Array.isArray(expectedCatalog)) {
    throw crearError("INVALID_ARGUMENT", "clasificarHistorialMigraciones: expectedCatalog debe ser un array");
  }
  const vistos = new Set();
  for (const id of expectedCatalog) {
    if (typeof id !== "string" || id.trim() === "" || id !== id.trim()) {
      throw crearError("INVALID_ARGUMENT", "clasificarHistorialMigraciones: expectedCatalog contiene un migration id invalido");
    }
    if (vistos.has(id)) {
      throw crearError("INVALID_ARGUMENT", "clasificarHistorialMigraciones: expectedCatalog contiene un migration id duplicado");
    }
    vistos.add(id);
  }
}

function ultimoIdCatalogo(expectedCatalog) {
  return expectedCatalog.length > 0 ? expectedCatalog[expectedCatalog.length - 1] : null;
}

// Funcion pura: sin fs, sin SQLite, sin I/O, sin sort(), sin mutar appliedHistory. Recorre el
// array EXACTAMENTE en el orden recibido -- el contrato de entrada exige que la posicion i ya
// represente sequence=i+1; el propio recorrido detecta tanto un array mal ordenado (Categoria A:
// sequence 2 antes que sequence 1) como un historial de migraciones persistido invalido
// (Categoria B: sequences correctas pero migration_id en la posicion equivocada respecto del
// catalogo), sin necesidad de reordenar nada en ningun caso.
function clasificarHistorialMigraciones(appliedHistory, expectedCatalog) {
  if (!Array.isArray(appliedHistory)) {
    throw crearError("INVALID_ARGUMENT", "clasificarHistorialMigraciones: appliedHistory debe ser un array");
  }
  validarCatalogoEsperado(expectedCatalog);
  const expectedMigrationId = ultimoIdCatalogo(expectedCatalog);

  if (appliedHistory.length === 0) {
    return { state: "UNVERSIONED", currentMigrationId: null, expectedMigrationId };
  }

  const idsVistos = new Set();
  for (let i = 0; i < appliedHistory.length; i += 1) {
    const entry = appliedHistory[i];
    const sequence = entry && entry.sequence;
    const migrationId = entry && entry.migration_id;

    if (!Number.isInteger(sequence) || sequence < 1 || sequence !== i + 1) {
      return { state: "INVALID_HISTORY", currentMigrationId: null, expectedMigrationId };
    }
    if (typeof migrationId !== "string" || migrationId.trim() === "" || migrationId !== migrationId.trim()) {
      return { state: "INVALID_HISTORY", currentMigrationId: null, expectedMigrationId };
    }
    if (idsVistos.has(migrationId)) {
      return { state: "INVALID_HISTORY", currentMigrationId: null, expectedMigrationId };
    }
    idsVistos.add(migrationId);
  }

  // Contenido vs catalogo, posicion por posicion, sin reordenar -- esto es lo que detecta la
  // Categoria B (sequences correctas, migration_id equivocado en una posicion dentro del rango
  // conocido del catalogo).
  const limiteConocido = Math.min(appliedHistory.length, expectedCatalog.length);
  for (let i = 0; i < limiteConocido; i += 1) {
    if (appliedHistory[i].migration_id !== expectedCatalog[i]) {
      return { state: "INVALID_HISTORY", currentMigrationId: null, expectedMigrationId };
    }
  }

  const currentMigrationId = appliedHistory[appliedHistory.length - 1].migration_id;

  if (appliedHistory.length === expectedCatalog.length) {
    return { state: "CURRENT", currentMigrationId, expectedMigrationId };
  }
  if (appliedHistory.length < expectedCatalog.length) {
    return { state: "BEHIND", currentMigrationId, expectedMigrationId };
  }
  return { state: "AHEAD", currentMigrationId, expectedMigrationId };
}

// Regla de afinidad SQLite (no exportada, local al modulo): por sustring del tipo declarado,
// nunca por comparacion literal exacta -- mismo criterio que SQLite usa internamente.
function afinidadColumna(tipoDeclarado) {
  const tipo = String(tipoDeclarado || "").toUpperCase();
  if (tipo.includes("INT")) return "INTEGER";
  if (tipo.includes("CHAR") || tipo.includes("CLOB") || tipo.includes("TEXT")) return "TEXT";
  if (tipo.includes("BLOB") || tipo === "") return "BLOB";
  if (tipo.includes("REAL") || tipo.includes("FLOA") || tipo.includes("DOUB")) return "REAL";
  return "NUMERIC";
}

function abrirDbSoloLectura(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (error) => {
      if (error) { reject(error); return; }
      resolve(db);
    });
  });
}

function cerrarDb(db) {
  return new Promise((resolve) => {
    if (!db) { resolve(); return; }
    db.close(() => resolve());
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

function getQuery(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) { reject(error); return; }
      resolve(row);
    });
  });
}

// Valida el contrato estructural minimo via metadata SQLite (PRAGMA table_info/index_list/
// index_info) -- NUNCA comparando el CREATE TABLE crudo como string. CHECK(sequence >= 1) es
// parte del futuro creation contract, deliberadamente fuera de este verifier minimo (ver cabecera
// del modulo): la garantia operacional de "sequence >= 1" ya la certifica el classifier sobre los
// datos reales, no la existencia de la constraint en el DDL. Columnas adicionales estan
// permitidas.
async function tablaEsCompatible(db) {
  const columnas = await allQuery(db, `PRAGMA table_info(${MIGRATIONS_TABLE})`);
  if (!columnas || columnas.length === 0) return false;

  const porNombre = new Map(columnas.map((col) => [col.name, col]));

  const sequenceCol = porNombre.get("sequence");
  if (!sequenceCol) return false;
  if (afinidadColumna(sequenceCol.type) !== "INTEGER") return false;
  if (Number(sequenceCol.notnull) !== 1) return false;

  const migrationIdCol = porNombre.get("migration_id");
  if (!migrationIdCol) return false;
  if (afinidadColumna(migrationIdCol.type) !== "TEXT") return false;
  if (Number(migrationIdCol.notnull) !== 1) return false;
  if (!migrationIdCol.pk || Number(migrationIdCol.pk) === 0) return false;
  const columnasPk = columnas.filter((col) => Number(col.pk) > 0);
  if (columnasPk.length !== 1 || columnasPk[0].name !== "migration_id") return false;

  const appliedAtCol = porNombre.get("applied_at");
  if (!appliedAtCol) return false;
  if (afinidadColumna(appliedAtCol.type) !== "TEXT") return false;
  if (Number(appliedAtCol.notnull) !== 1) return false;

  const indices = await allQuery(db, `PRAGMA index_list(${MIGRATIONS_TABLE})`);
  let tieneUniqueSequence = false;
  for (const indice of indices || []) {
    if (Number(indice.unique) !== 1) continue;
    if (Number(indice.partial) !== 0) continue;
    const columnasIndice = await allQuery(db, `PRAGMA index_info(${indice.name})`);
    const nombres = (columnasIndice || []).map((c) => c.name);
    if (nombres.length === 1 && nombres[0] === "sequence") {
      tieneUniqueSequence = true;
      break;
    }
  }
  if (!tieneUniqueSequence) return false;

  return true;
}

// MT-1E2C2A: evaluacion pura sobre una conexion YA ABIERTA por el caller. No abre, no cierra, no
// escribe -- deja la conexion usable despues de retornar. Es la MISMA logica (deteccion de tabla
// metadata, tablaEsCompatible, lectura de history ORDER BY sequence ASC, clasificarHistorialMigraciones)
// que verificarBusinessSchemaVersion ya corria entre su open y su close; se extrae para que
// MT-1E2C2B pueda invocarla dentro de un BEGIN IMMEDIATE sobre la misma business DB connection.
// DB_ERROR es un estado de TARGET (archivo/conexion), no aplica aqui: cualquier fallo de query
// sobre una conexion ya validada como SQLite se propaga tal cual (el caller within-transaction
// decide como tratarlo).
async function verificarBusinessSchemaVersionEnConexion(db) {
  const expectedMigrationId = ultimoIdCatalogo(BUSINESS_SCHEMA_MIGRATIONS);

  const tablaRow = await getQuery(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [MIGRATIONS_TABLE]
  );

  if (!tablaRow) {
    return { state: "UNVERSIONED", currentMigrationId: null, expectedMigrationId };
  }

  const compatible = await tablaEsCompatible(db);
  if (!compatible) {
    return { state: "INVALID_HISTORY", currentMigrationId: null, expectedMigrationId };
  }

  const rows = await allQuery(
    db,
    `SELECT sequence, migration_id FROM ${MIGRATIONS_TABLE} ORDER BY sequence ASC`
  );

  return clasificarHistorialMigraciones(rows, BUSINESS_SCHEMA_MIGRATIONS);
}

// Punto de entrada unico y READONLY. dbPath es obligatorio y explicito -- nunca GUERNICA_DB_PATH,
// nunca ATLAS_EMPRESA_SLUG/ATLAS_AUTH_MODE, nunca un default a database/guernica.db. Abre
// exclusivamente sqlite3.OPEN_READONLY (jamas OPEN_CREATE): un dbPath inexistente falla ANTES de
// intentar abrir nada, nunca materializa un archivo. Cierra la conexion siempre que llego a
// abrirse, en cualquier salida (exito o error).
async function verificarBusinessSchemaVersion(dbPath) {
  if (typeof dbPath !== "string" || dbPath.trim() === "") {
    throw crearError("INVALID_ARGUMENT", "verificarBusinessSchemaVersion: dbPath es obligatorio y debe ser un string no vacio");
  }

  const expectedMigrationId = ultimoIdCatalogo(BUSINESS_SCHEMA_MIGRATIONS);

  if (!fs.existsSync(dbPath)) {
    return { state: "DB_NOT_FOUND", currentMigrationId: null, expectedMigrationId };
  }

  let db;
  try {
    db = await abrirDbSoloLectura(dbPath);
  } catch (error) {
    return { state: "DB_ERROR", currentMigrationId: null, expectedMigrationId };
  }

  try {
    return await verificarBusinessSchemaVersionEnConexion(db);
  } catch (error) {
    return { state: "DB_ERROR", currentMigrationId: null, expectedMigrationId };
  } finally {
    await cerrarDb(db);
  }
}

// MT-1E2C2A: puro, sin I/O. clasificarHistorialMigraciones ya valida posicion-por-posicion contra
// BUSINESS_SCHEMA_MIGRATIONS ANTES de resolver CURRENT/BEHIND/AHEAD (limiteConocido cubre siempre
// la posicion 0 cuando appliedHistory.length >= 1), y BUSINESS_SCHEMA_MIGRATIONS[0] es siempre
// "001_legacy_runtime_baseline". Por lo tanto, alcanzar cualquiera de esos tres estados YA certifica
// que sequence=1/migration_id="001_legacy_runtime_baseline" esta presente -- sin re-inspeccionar
// el history. Valido para cualquier crecimiento futuro del catalogo mientras su primera entrada
// no cambie.
function baselinePresent(state) {
  return state === "CURRENT" || state === "BEHIND" || state === "AHEAD";
}

module.exports = {
  BUSINESS_SCHEMA_MIGRATIONS,
  clasificarHistorialMigraciones,
  verificarBusinessSchemaVersion,
  verificarBusinessSchemaVersionEnConexion,
  baselinePresent
};
