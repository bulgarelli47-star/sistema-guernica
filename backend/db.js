const sqlite3 = require("sqlite3").verbose();
const { resolveBusinessDbPath } = require("./resolveBusinessDbPath");

const dbPath = resolveBusinessDbPath();

// MT-1D.2B: apertura lazy. require("./db") por si solo NO debe abrir ni crear la business DB --
// eso permitiria que un proceso en modo central mutara/creara la DB de un tenant antes de que el
// gate de identidad (backend/server.js) tuviera oportunidad de rechazarlo. La conexion real recien
// se crea en el primer uso de runQuery/getQuery/allQuery (via getDb()), nunca al cargar el modulo.
let dbInstance = null;

// MT-1E7B: OPEN_READWRITE explicito, sin OPEN_CREATE. El boot gate (backend/server.js) ya exige
// baseline ready + schema CURRENT antes de que este singleton se materialice -- una business DB
// verificada ya debe existir, asi que este runtime nunca tiene autoridad para crear una vacia.
function getDb() {
  if (!dbInstance) {
    dbInstance = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE);
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
