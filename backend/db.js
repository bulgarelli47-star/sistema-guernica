const sqlite3 = require("sqlite3").verbose();
const { resolveBusinessDbPath } = require("./resolveBusinessDbPath");

const dbPath = resolveBusinessDbPath();

// MT-1D.2B: apertura lazy. require("./db") por si solo NO debe abrir ni crear la business DB --
// eso permitiria que un proceso en modo central mutara/creara la DB de un tenant antes de que el
// gate de identidad (backend/server.js) tuviera oportunidad de rechazarlo. La conexion real recien
// se crea en el primer uso de runQuery/getQuery/allQuery (via getDb()), nunca al cargar el modulo.
let dbInstance = null;

function getDb() {
  if (!dbInstance) {
    dbInstance = new sqlite3.Database(dbPath);
  }
  return dbInstance;
}

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
