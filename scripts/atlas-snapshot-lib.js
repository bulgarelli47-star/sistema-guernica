// BACKUP-1: utilidades compartidas por scripts/backup-atlas.js y scripts/restore-atlas.js.
// Sin efectos al cargarse. Ningun helper de aca escribe en bases ni en uploads de origen: las bases se
// abren SIEMPRE en OPEN_READONLY y los uploads solo se leen.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const ROOT = path.resolve(__dirname, "..");
const FORMATO = "atlas-snapshot";
const FORMATO_VERSION = 1;
const MANIFEST = "manifest.json";
const MANIFEST_CHECKSUM = "manifest.json.sha256";
const PATRON_SNAPSHOT_ID = /^atlas-\d{8}T\d{9}Z-[0-9a-f]{6}$/;
// Mismo criterio que el filesystem necesita para usar el slug como nombre de carpeta del snapshot.
const PATRON_SLUG_SEGURO = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

function crearError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256Archivo(rutaArchivo) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(rutaArchivo, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let leidos;
    while ((leidos = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, leidos));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function sha256Texto(texto) {
  return crypto.createHash("sha256").update(texto, "utf8").digest("hex");
}

function dentroDe(raiz, ruta) {
  const r = path.resolve(raiz);
  const p = path.resolve(ruta);
  const rc = process.platform === "win32" ? r.toLowerCase() : r;
  const pc = process.platform === "win32" ? p.toLowerCase() : p;
  return pc === rc || pc.startsWith(rc + path.sep);
}

// Archivo regular, sin symlink/junction en el propio elemento.
function exigirArchivoRegular(ruta, code) {
  let st;
  try { st = fs.lstatSync(ruta); } catch { throw crearError(code, `No existe: ${ruta}`); }
  if (st.isSymbolicLink()) throw crearError("SNAPSHOT_SYMLINK_RECHAZADO", `Symlink/junction rechazado: ${ruta}`);
  if (!st.isFile()) throw crearError(code, `No es un archivo regular: ${ruta}`);
  return st;
}

function exigirDirectorioReal(ruta, code) {
  let st;
  try { st = fs.lstatSync(ruta); } catch { throw crearError(code, `No existe: ${ruta}`); }
  if (st.isSymbolicLink()) throw crearError("SNAPSHOT_SYMLINK_RECHAZADO", `Symlink/junction rechazado: ${ruta}`);
  if (!st.isDirectory()) throw crearError(code, `No es un directorio: ${ruta}`);
  return st;
}

// Ruta relativa dentro del snapshot: POSIX, sin absolutos, sin '..', sin segmentos vacios.
function esRutaRelativaSegura(rel) {
  if (typeof rel !== "string" || !rel || rel.includes("\\") || rel.includes("\0")) return false;
  if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return false;
  return rel.split("/").every((seg) => seg && seg !== "." && seg !== "..");
}

function abrirSoloLectura(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve(db)));
  });
}

function cerrar(db) {
  return new Promise((resolve) => (db ? db.close(() => resolve()) : resolve()));
}

function consultar(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (error, filas) => (error ? reject(error) : resolve(filas))));
}

async function integrityCheck(db) {
  const filas = await consultar(db, "PRAGMA integrity_check");
  return filas.length === 1 && filas[0].integrity_check === "ok" ? "ok" : "fallo";
}

async function leerTenantIdentity(db) {
  const tabla = await consultar(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tenant_identity'");
  if (!tabla.length) return null;
  const filas = await consultar(db, "SELECT empresa_control_id, tenant_slug FROM tenant_identity WHERE id = 1");
  if (!filas.length) return null;
  return { empresa_id: filas[0].empresa_control_id, slug: filas[0].tenant_slug };
}

async function leerUltimaMigracion(db) {
  const tabla = await consultar(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'atlas_schema_migrations'");
  if (!tabla.length) return null;
  const filas = await consultar(db, "SELECT migration_id FROM atlas_schema_migrations ORDER BY sequence DESC LIMIT 1");
  return filas.length ? filas[0].migration_id : null;
}

async function leerTablas(db) {
  return (await consultar(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).map((f) => f.name);
}

module.exports = {
  ROOT,
  FORMATO,
  FORMATO_VERSION,
  MANIFEST,
  MANIFEST_CHECKSUM,
  PATRON_SNAPSHOT_ID,
  PATRON_SLUG_SEGURO,
  crearError,
  sha256Archivo,
  sha256Texto,
  dentroDe,
  exigirArchivoRegular,
  exigirDirectorioReal,
  esRutaRelativaSegura,
  abrirSoloLectura,
  cerrar,
  consultar,
  integrityCheck,
  leerTenantIdentity,
  leerUltimaMigracion,
  leerTablas
};
