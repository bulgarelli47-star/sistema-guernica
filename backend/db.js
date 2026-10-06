const sqlite3 = require("sqlite3").verbose();
const { resolveBusinessDbPath } = require("./resolveBusinessDbPath");
const { getTenantHandle } = require("./tenantRequestContext");
// TX-1B: coordinacion de escrituras del MISMO tenant (TX-SAME-TENANT). Se invoca via el objeto del
// modulo (no desestructurado) en cada llamada.
const tenantWriteCoordinator = require("./tenantWriteCoordinator");

const dbPath = resolveBusinessDbPath();

// TX-1B: espera maxima en la cola de la conexion del tenant. Una request nunca espera indefinidamente
// detras de una transaccion fugada: al vencer rechaza con TENANT_WRITE_GATE_TIMEOUT y su sentencia
// jamas se ejecuta. Debe ser MAYOR que la gracia de recuperacion por abort del middleware de
// operacion (backend/server.js, TX_GATE_ABORT_GRACE_MS).
const TENANT_WRITE_GATE_WAIT_TIMEOUT_MS = 10000;

// MT-1D.2B: apertura lazy. require("./db") por si solo NO debe abrir ni crear la business DB --
// eso permitiria que un proceso en modo central mutara/creara la DB de un tenant antes de que el
// gate de identidad (backend/server.js) tuviera oportunidad de rechazarlo. La conexion real recien
// se crea en el primer uso de runQuery/getQuery/allQuery (via getDb()), nunca al cargar el modulo.
let dbInstance = null;

// MT-1E7B: OPEN_READWRITE explicito, sin OPEN_CREATE. El boot gate (backend/server.js) ya exige
// baseline ready + schema CURRENT antes de que este singleton se materialice -- una business DB
// verificada ya debe existir, asi que este runtime nunca tiene autoridad para crear una vacia.
//
// MT-1F2: resolucion consciente de contexto. Hay DOS estados distintos y nunca se mezclan:
// 1) SIN contexto de tenant (backend/tenantRequestContext.js): comportamiento singleton EXACTO de
//    siempre -- mismo path por entorno, misma apertura lazy, mismo OPEN_READWRITE, mismos errores.
// 2) CON contexto de tenant activo: se usa UNICAMENTE la conexion del handle verificado. Jamas se
//    consulta GUERNICA_DB_PATH ni se abre/toca el singleton desde dentro de un contexto: si esa
//    conexion ya estuviera cerrada, la operacion falla con el error de sqlite, sin fallback a otra DB.
// Como los helpers de abajo llaman getDb() al EJECUTAR (no al cargar), toda referencia ya
// desestructurada por los servicios (const { runQuery } = require("../db")) resuelve en ejecucion.
function getDb() {
  const tenantHandle = getTenantHandle();
  if (tenantHandle) {
    return tenantHandle.db;
  }
  if (!dbInstance) {
    dbInstance = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE);
  }
  return dbInstance;
}

// MT-1F2: closeDb es dueno UNICAMENTE de la conexion singleton legacy. Nunca cierra la conexion de un
// handle de tenant, este o no activo su contexto: el ciclo de vida de esos handles es del registry
// (closeTenantHandle/closeAllTenantHandles de backend/runtimeTenantRegistry.js).
function closeDb() {
  return new Promise((resolve, reject) => {
    if (!dbInstance) {
      resolve();
      return;
    }
    const instance = dbInstance;
    dbInstance = null;
    instance.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

// TX-1B: cada helper resuelve la conexion (getDb) en el contexto del LLAMADOR y la entrega al
// coordinador junto con un thunk que ejecuta la operacion ORIGINAL del driver. La operacion duena se
// captura al entrar a coordinarSentencia, nunca dentro de un callback de sqlite3 (TX-1A: el callback
// crudo del driver no hereda el contexto ALS). Contratos intactos: runQuery resuelve el `this` del
// callback de run (lastID/changes), getQuery la fila, allQuery las filas, y los errores de sqlite se
// rechazan sin envolver. Un fallo de getDb() sigue siendo un rechazo, nunca un throw sincronico.
function coordinarSobreConexion(sql, ejecutar) {
  let db;
  try {
    db = getDb();
  } catch (error) {
    return Promise.reject(error);
  }
  return tenantWriteCoordinator.coordinarSentencia(
    db,
    sql,
    () => new Promise((resolve, reject) => ejecutar(db, resolve, reject)),
    { timeoutMs: TENANT_WRITE_GATE_WAIT_TIMEOUT_MS }
  );
}

function runQuery(sql, params = []) {
  return coordinarSobreConexion(sql, (db, resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) {
        reject(err);
        return;
      }

      resolve(this);
    });
  });
}

function getQuery(sql, params = []) {
  return coordinarSobreConexion(sql, (db, resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(row);
    });
  });
}

function allQuery(sql, params = []) {
  return coordinarSobreConexion(sql, (db, resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(rows);
    });
  });
}

module.exports = {
  dbPath,
  getDb,
  closeDb,
  runQuery,
  getQuery,
  allQuery
};
