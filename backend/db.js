const sqlite3 = require("sqlite3").verbose();
const { resolveBusinessDbPath } = require("./resolveBusinessDbPath");
const { getTenantHandle } = require("./tenantRequestContext");

const dbPath = resolveBusinessDbPath();

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

function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().run(sql, params, function (err) {
      if (err) {
        reject(err);
        return;
      }

      resolve(this);
    });
  });
}

function getQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(row);
    });
  });
}

function allQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().all(sql, params, (err, rows) => {
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
