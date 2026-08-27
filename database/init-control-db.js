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
  const db = new sqlite3.Database(dbPath);
  // Ambas tablas nuevas (usuarios, usuario_empresas) viven en este mismo archivo, asi que sus
  // FKs pueden ser reales -- pero sqlite3 no las aplica salvo que se active este pragma por
  // conexion. No afecta a "empresas" (no tiene columnas FK).
  db.run("PRAGMA foreign_keys = ON");
  return db;
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

  // MT-1B.1: identidad central en modo SHADOW. usuario_referencia/email NO son UNIQUE a
  // proposito -- dos empresas distintas pueden tener hoy un usuario local "juan" sin evidencia
  // de que sea la misma persona; nunca se fusiona por username/email en esta fase.
  await runQuery(
    db,
    `CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      usuario_referencia TEXT,
      password_hash TEXT NOT NULL,
      email TEXT,
      telefono TEXT,
      foto_url TEXT,
      activo INTEGER NOT NULL DEFAULT 1,
      ultimo_acceso TEXT,
      intentos_fallidos INTEGER NOT NULL DEFAULT 0,
      bloqueado_hasta TEXT,
      creado_en TEXT NOT NULL DEFAULT (datetime('now')),
      actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  );

  // rol vive aca (por empresa), no en usuarios central. usuario_local_id no tiene FK real
  // porque referencia una fila en OTRO archivo SQLite (la DB de esa empresa); usuario_id y
  // empresa_id si son FK reales, porque ambas tablas conviven en este mismo archivo.
  await runQuery(
    db,
    `CREATE TABLE IF NOT EXISTS usuario_empresas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
      empresa_id INTEGER NOT NULL REFERENCES empresas(id),
      usuario_local_id INTEGER NOT NULL,
      rol TEXT NOT NULL,
      activo INTEGER NOT NULL DEFAULT 1,
      creado_en TEXT NOT NULL DEFAULT (datetime('now')),
      actualizado_en TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (empresa_id, usuario_local_id),
      UNIQUE (usuario_id, empresa_id)
    )`
  );
}

async function crearUsuarioCentral(db, {
  nombre, usuarioReferencia, passwordHash, email, telefono, fotoUrl,
  activo = 1, ultimoAcceso, intentosFallidos = 0, bloqueadoHasta, creadoEn
}) {
  const result = await runQuery(
    db,
    `INSERT INTO usuarios
       (nombre, usuario_referencia, password_hash, email, telefono, foto_url,
        activo, ultimo_acceso, intentos_fallidos, bloqueado_hasta, creado_en, actualizado_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), datetime('now'))`,
    [
      nombre, usuarioReferencia || null, passwordHash, email || null, telefono || null, fotoUrl || null,
      activo ? 1 : 0, ultimoAcceso || null, intentosFallidos || 0, bloqueadoHasta || null, creadoEn || null
    ]
  );
  return getQuery(db, "SELECT * FROM usuarios WHERE id = ?", [result.lastID]);
}

async function actualizarUsuarioCentral(db, usuarioId, {
  nombre, usuarioReferencia, passwordHash, email, telefono, fotoUrl,
  activo, ultimoAcceso, intentosFallidos, bloqueadoHasta
}) {
  await runQuery(
    db,
    `UPDATE usuarios SET
       nombre = ?, usuario_referencia = ?, password_hash = ?, email = ?, telefono = ?, foto_url = ?,
       activo = ?, ultimo_acceso = ?, intentos_fallidos = ?, bloqueado_hasta = ?, actualizado_en = datetime('now')
     WHERE id = ?`,
    [
      nombre, usuarioReferencia || null, passwordHash, email || null, telefono || null, fotoUrl || null,
      activo ? 1 : 0, ultimoAcceso || null, intentosFallidos || 0, bloqueadoHasta || null, usuarioId
    ]
  );
  return getQuery(db, "SELECT * FROM usuarios WHERE id = ?", [usuarioId]);
}

async function crearMembership(db, { usuarioId, empresaId, usuarioLocalId, rol, activo = 1 }) {
  await runQuery(
    db,
    `INSERT INTO usuario_empresas (usuario_id, empresa_id, usuario_local_id, rol, activo)
     VALUES (?, ?, ?, ?, ?)`,
    [usuarioId, empresaId, usuarioLocalId, rol, activo ? 1 : 0]
  );
  return getQuery(db, "SELECT * FROM usuario_empresas WHERE empresa_id = ? AND usuario_local_id = ?", [empresaId, usuarioLocalId]);
}

async function actualizarMembership(db, membershipId, { rol, activo }) {
  await runQuery(
    db,
    `UPDATE usuario_empresas SET rol = ?, activo = ?, actualizado_en = datetime('now') WHERE id = ?`,
    [rol, activo ? 1 : 0, membershipId]
  );
  return getQuery(db, "SELECT * FROM usuario_empresas WHERE id = ?", [membershipId]);
}

async function getMembershipPorEmpresaYLocal(db, { empresaId, usuarioLocalId }) {
  return getQuery(
    db,
    "SELECT * FROM usuario_empresas WHERE empresa_id = ? AND usuario_local_id = ?",
    [empresaId, usuarioLocalId]
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
  bootstrapControlDb,
  crearUsuarioCentral,
  actualizarUsuarioCentral,
  crearMembership,
  actualizarMembership,
  getMembershipPorEmpresaYLocal
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
