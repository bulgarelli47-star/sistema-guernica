const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const ALLOWED_DB_DIR = __dirname;
const DEFAULT_DB_PATH = path.join(ALLOWED_DB_DIR, "atlas_control.db");

const GUERNICA_SEED = {
  slug: "guernica",
  nombre: "Guernica",
  dbPath: "guernica.db",
  activa: 1
};

function openDb(dbPath) {
  return new sqlite3.Database(dbPath);
}

function closeDb(db) {
  return new Promise((resolve, reject) => {
    db.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function runQuery(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
}

function getQuery(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) reject(error);
      else resolve(row);
    });
  });
}

function allQuery(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

function resolveEmpresaDbPath(candidatePath) {
  const resolved = path.resolve(ALLOWED_DB_DIR, candidatePath);
  const normalizedRoot = ALLOWED_DB_DIR + path.sep;
  if (resolved !== ALLOWED_DB_DIR && !resolved.startsWith(normalizedRoot)) {
    throw new Error(`Ruta de base de datos fuera del directorio permitido: ${candidatePath}`);
  }
  return resolved;
}

async function initControlSchema(db) {
  await runQuery(
    db,
    `CREATE TABLE IF NOT EXISTS empresas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      nombre TEXT NOT NULL,
      db_path TEXT NOT NULL,
      activa INTEGER NOT NULL DEFAULT 1,
      creado_en TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  );
}

async function registrarEmpresa(db, { slug, nombre, dbPath, activa = 1 }) {
  resolveEmpresaDbPath(dbPath);
  await runQuery(
    db,
    `INSERT INTO empresas (slug, nombre, db_path, activa)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       nombre = excluded.nombre,
       db_path = excluded.db_path,
       activa = excluded.activa`,
    [slug, nombre, dbPath, activa ? 1 : 0]
  );
  return getQuery(db, "SELECT * FROM empresas WHERE slug = ?", [slug]);
}

async function seedGuernica(db) {
  return registrarEmpresa(db, GUERNICA_SEED);
}

async function bootstrapControlDb(dbPath = DEFAULT_DB_PATH, { seed = true } = {}) {
  const db = openDb(dbPath);
  await initControlSchema(db);
  if (seed) await seedGuernica(db);
  return db;
}

module.exports = {
  ALLOWED_DB_DIR,
  DEFAULT_DB_PATH,
  GUERNICA_SEED,
  openDb,
  closeDb,
  runQuery,
  getQuery,
  allQuery,
  resolveEmpresaDbPath,
  initControlSchema,
  registrarEmpresa,
  seedGuernica,
  bootstrapControlDb
};

if (require.main === module) {
  bootstrapControlDb()
    .then(async (db) => {
      console.log("Control plane listo.");
      await closeDb(db);
    })
    .catch((error) => {
      console.error("Error inicializando control plane:", error.message);
      process.exit(1);
    });
}
