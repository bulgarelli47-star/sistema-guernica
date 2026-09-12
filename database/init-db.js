const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const bcrypt = require("bcrypt");
const { crearBaseline001EnConexion } = require("./business-schema-baseline");
const { TENANT_IDENTITY_SCHEMA_SQL } = require("./provision-tenant-identity");
const { verificarLegacyBaselineEnConexion } = require("../backend/legacyBaselineVerifier");

const dbPath = process.env.GUERNICA_DB_PATH || path.join(__dirname, "guernica.db");
const db = new sqlite3.Database(dbPath);

function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) { reject(err); return; }
      resolve(this);
    });
  });
}

function getQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) { reject(err); return; }
      resolve(row);
    });
  });
}

function allQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) { reject(err); return; }
      resolve(rows);
    });
  });
}

function closeDb() {
  return new Promise((resolve) => {
    db.close((err) => {
      if (err) console.error("Error cerrando la base de datos:", err.message);
      resolve();
    });
  });
}

// MT-1E4C: guard fail-closed contra uso accidental sobre una DB no vacia. init-db.js es
// ONE-SHOT: solo opera sobre un archivo sin ninguna tabla de aplicacion todavia. Ignora
// unicamente objetos internos de SQLite (p.ej. sqlite_sequence, que SQLite crea junto con la
// primera tabla AUTOINCREMENT) -- cualquier tabla real preexistente detiene la ejecucion sin
// tocar nada. NO repair, NO ensure, NO reentrant schema healing.
async function verificarDbVacia() {
  const filas = await allQuery(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('sqlite_sequence')"
  );
  return filas.length === 0;
}

async function initDatabase() {
  try {
    const vacia = await verificarDbVacia();
    if (!vacia) {
      throw new Error(
        `init-db.js: la base de datos en ${dbPath} ya contiene tablas de aplicacion. ` +
        "init-db.js es one-shot y solo opera sobre una DB nueva/vacia -- no repara ni completa una DB existente."
      );
    }

    console.log("Creando base de datos...");

    await runQuery("BEGIN IMMEDIATE");
    let transactionStarted = true;
    try {
      await crearBaseline001EnConexion(db);
      await runQuery(TENANT_IDENTITY_SCHEMA_SQL);

      const readiness = await verificarLegacyBaselineEnConexion(db);
      if (!readiness.ready) {
        throw new Error(
          `init-db.js: el schema construido no paso la verificacion de baseline 001 (failures=${JSON.stringify(readiness.failures)})`
        );
      }

      await runQuery("COMMIT");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        await runQuery("ROLLBACK").catch(() => {});
      }
      throw error;
    }

    // Demo/dev seed -- fuera de la transaccion de baseline. Preserva el comportamiento
    // historico exacto (SELECT-then-INSERT condicional, sin recalcular el hash en reruns
    // porque init-db.js ya no corre sobre una DB existente).
    const existingUser = await getQuery("SELECT * FROM usuarios WHERE usuario = ?", ["admin"]);
    const existingClient = await getQuery("SELECT * FROM clientes WHERE nombre = ?", ["Consumidor Final"]);

    if (!existingUser) {
      const passwordHash = await bcrypt.hash("admin123", 10);
      await runQuery(
        `INSERT INTO usuarios (nombre, usuario, password, rol, activo, creado_en, actualizado_en)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["Administrador", "admin", passwordHash, "admin", 1, new Date().toISOString(), new Date().toISOString()]
      );
      console.log("Usuario admin creado.");
      console.log("Usuario: admin");
      console.log("Contrasena: admin123");
    } else {
      console.log("El usuario admin ya existe.");
    }

    if (!existingClient) {
      await runQuery(
        `INSERT INTO clientes (nombre, telefono, direccion, alias, observaciones, limite_fiado, activo)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["Consumidor Final", "", "", "", "", 0, 1]
      );
      await runQuery(
        `INSERT INTO clientes (nombre, telefono, direccion, alias, observaciones, limite_fiado, activo)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["Juan Perez", "1111111111", "", "", "", 0, 1]
      );
    }

    console.log("Base de datos lista.");
  } catch (error) {
    console.error("Error inicializando la base de datos:", error.message);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

initDatabase();
