// BACKUP-1: restauracion de un snapshot de scripts/backup-atlas.js sobre un DESTINO AISLADO.
//
// Uso: node scripts/restore-atlas.js --snapshot <dir abs> --target <dir abs, inexistente>
//
// Este script NUNCA escribe sobre el runtime real: rechaza cualquier destino dentro del repo (incluye
// database/ y uploads/) o que ya exista. No existe flag de escritura "live": el reemplazo de las bases y
// uploads productivos es un procedimiento operativo manual (servidor y workers detenidos) a partir de un
// restore aislado ya verificado.
//
// Antes de escribir NADA valida: checksum del manifest, formato/version, rutas relativas seguras, que el
// conjunto de archivos del snapshot sea exactamente el declarado, y size + SHA256 de cada componente. Si
// algo falla no se crea el destino. La restauracion se arma en un temporal hermano del destino, se
// re-verifica (hashes, integrity_check, identity de cada tenant, Control -> empresa -> business DB) y
// recien entonces se publica con un rename atomico.
//
// Restaurar las bases no basta para operar integraciones cifradas (F5C): hace falta la MISMA
// ATLAS_INTEGRATION_MASTER_KEY_B64 y el resto de secretos externos (.env), que nunca forman parte del snapshot.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const lib = require("./atlas-snapshot-lib");
const { ALLOWED_DB_DIR } = require("../database/init-control-db");

const { crearError } = lib;

function leerArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!m) throw crearError("RESTORE_ARGUMENTO_INVALIDO", `Argumento invalido: ${argv[i]}`);
    args[m[1]] = m[2] !== undefined ? m[2] : argv[++i];
  }
  return args;
}

function validarDestino(snapshotDir, target) {
  if (!target || !path.isAbsolute(target)) throw crearError("RESTORE_TARGET_INVALIDO", "--target debe ser un path absoluto");
  const destino = path.resolve(target);
  for (const raiz of [lib.ROOT, ALLOWED_DB_DIR, path.join(lib.ROOT, "uploads")]) {
    if (lib.dentroDe(raiz, destino) || lib.dentroDe(destino, raiz)) {
      throw crearError("RESTORE_TARGET_LIVE_RECHAZADO", "El destino no puede estar dentro (ni contener) el repo, las bases o los uploads del runtime");
    }
  }
  if (lib.dentroDe(snapshotDir, destino) || lib.dentroDe(destino, snapshotDir)) throw crearError("RESTORE_TARGET_INVALIDO", "El destino no puede solaparse con el snapshot");
  if (fs.existsSync(destino)) throw crearError("RESTORE_TARGET_EXISTE", "El destino ya existe: el restore nunca sobrescribe");
  const padre = path.dirname(destino);
  lib.exigirDirectorioReal(padre, "RESTORE_TARGET_INVALIDO");
  return destino;
}

function leerManifest(snapshotDir) {
  lib.exigirDirectorioReal(snapshotDir, "RESTORE_SNAPSHOT_AUSENTE");
  const rutaManifest = path.join(snapshotDir, lib.MANIFEST);
  const rutaChecksum = path.join(snapshotDir, lib.MANIFEST_CHECKSUM);
  lib.exigirArchivoRegular(rutaManifest, "RESTORE_MANIFEST_AUSENTE");
  lib.exigirArchivoRegular(rutaChecksum, "RESTORE_MANIFEST_AUSENTE");
  const texto = fs.readFileSync(rutaManifest, "utf8");
  if (fs.readFileSync(rutaChecksum, "utf8").trim() !== lib.sha256Texto(texto)) throw crearError("RESTORE_MANIFEST_CHECKSUM", "El manifest fue alterado");
  let manifest;
  try { manifest = JSON.parse(texto); } catch { throw crearError("RESTORE_MANIFEST_INVALIDO", "manifest.json no es JSON valido"); }
  if (manifest.format !== lib.FORMATO || manifest.format_version !== lib.FORMATO_VERSION) {
    throw crearError("RESTORE_FORMATO_NO_SOPORTADO", "Formato o version de snapshot no soportados");
  }
  if (!Array.isArray(manifest.tenants) || !manifest.uploads || !Array.isArray(manifest.uploads.inventario)) {
    throw crearError("RESTORE_MANIFEST_INVALIDO", "manifest incompleto");
  }
  if (manifest.snapshot && manifest.snapshot.tenancy_mode === "multi" && !manifest.control) {
    throw crearError("RESTORE_MANIFEST_INVALIDO", "Un snapshot multi sin Control DB es invalido");
  }
  return manifest;
}

function listarComponentes(manifest) {
  const lista = [];
  if (manifest.control) {
    if (manifest.control.relative_path !== "control/atlas_control.db") throw crearError("RESTORE_RUTA_INVALIDA", "Ruta de Control inesperada");
    lista.push({ tipo: "control", ...manifest.control });
  }
  const slugs = new Set();
  for (const t of manifest.tenants) {
    if (!lib.PATRON_SLUG_SEGURO.test(String(t.slug)) || slugs.has(t.slug)) throw crearError("RESTORE_RUTA_INVALIDA", "Slug de tenant invalido o duplicado");
    slugs.add(t.slug);
    if (t.relative_path !== `tenants/${t.slug}/business.db`) throw crearError("RESTORE_RUTA_INVALIDA", `Ruta de tenant inesperada: ${t.slug}`);
    lista.push({ tipo: "tenant", ...t });
  }
  for (const a of manifest.uploads.inventario) {
    if (!lib.esRutaRelativaSegura(a.path) || !a.path.startsWith("uploads/")) throw crearError("RESTORE_RUTA_INVALIDA", "Ruta de upload invalida");
    lista.push({ tipo: "upload", relative_path: a.path, size: a.size, sha256: a.sha256 });
  }
  for (const c of lista) {
    if (!lib.esRutaRelativaSegura(c.relative_path)) throw crearError("RESTORE_RUTA_INVALIDA", "Ruta relativa insegura");
    if (!Number.isInteger(c.size) || !/^[0-9a-f]{64}$/.test(String(c.sha256))) throw crearError("RESTORE_MANIFEST_INVALIDO", "size/sha256 invalidos en manifest");
  }
  return lista;
}

function archivosEnDisco(dir, base = "") {
  const salida = [];
  for (const nombre of fs.readdirSync(dir)) {
    const rel = base ? `${base}/${nombre}` : nombre;
    const st = fs.lstatSync(path.join(dir, nombre));
    if (st.isSymbolicLink()) throw crearError("SNAPSHOT_SYMLINK_RECHAZADO", `Symlink/junction en el snapshot: ${rel}`);
    if (st.isDirectory()) salida.push(...archivosEnDisco(path.join(dir, nombre), rel));
    else salida.push(rel);
  }
  return salida;
}

function verificarComponentes(dir, lista, codigo) {
  for (const c of lista) {
    const ruta = path.join(dir, ...c.relative_path.split("/"));
    const st = lib.exigirArchivoRegular(ruta, "RESTORE_COMPONENTE_AUSENTE");
    if (st.size !== c.size || lib.sha256Archivo(ruta) !== c.sha256) throw crearError(codigo, `Hash/size no coincide: ${c.relative_path}`);
  }
}

async function verificarRestaurado(tmp, manifest) {
  const abrir = (rel) => lib.abrirSoloLectura(path.join(tmp, ...rel.split("/")));
  let empresasControl = null;
  if (manifest.control) {
    const control = await abrir(manifest.control.relative_path);
    try {
      if (await lib.integrityCheck(control) !== "ok") throw crearError("RESTORE_INTEGRIDAD", "integrity_check fallo en Control");
      empresasControl = await lib.consultar(control, "SELECT id, slug, db_path, activa FROM empresas ORDER BY id");
    } finally {
      await lib.cerrar(control);
    }
  }
  const mapa = [];
  for (const t of manifest.tenants) {
    const db = await abrir(t.relative_path);
    try {
      if (await lib.integrityCheck(db) !== "ok") throw crearError("RESTORE_INTEGRIDAD", `integrity_check fallo en ${t.slug}`);
      const identity = await lib.leerTenantIdentity(db);
      if (JSON.stringify(identity) !== JSON.stringify(t.identity)) throw crearError("RESTORE_IDENTITY_MISMATCH", `Identity restaurada distinta para ${t.slug}`);
    } finally {
      await lib.cerrar(db);
    }
    if (empresasControl && t.empresa_id !== null && t.db_path_registrado !== null) {
      const empresa = empresasControl.find((e) => e.id === t.empresa_id);
      if (!empresa || empresa.slug !== t.slug || empresa.db_path !== t.db_path_registrado) {
        throw crearError("RESTORE_CONTROL_MAPPING", `Control restaurado no mapea empresa ${t.empresa_id} -> ${t.slug}`);
      }
    }
    mapa.push({ empresa_id: t.empresa_id, slug: t.slug, db_path_registrado: t.db_path_registrado, business_db: t.relative_path });
  }
  return mapa;
}

async function restaurar(argv = process.argv.slice(2)) {
  const args = leerArgs(argv);
  if (!args.snapshot || !path.isAbsolute(args.snapshot)) throw crearError("RESTORE_ARGUMENTO_INVALIDO", "--snapshot debe ser un path absoluto");
  const snapshotDir = path.resolve(args.snapshot);
  const destino = validarDestino(snapshotDir, args.target);

  // ---- Fase 1: validacion completa del snapshot. Nada se escribe todavia. ----
  const manifest = leerManifest(snapshotDir);
  const lista = listarComponentes(manifest);
  const esperados = new Set([lib.MANIFEST, lib.MANIFEST_CHECKSUM, ...lista.map((c) => c.relative_path)]);
  const enDisco = archivosEnDisco(snapshotDir);
  const inesperados = enDisco.filter((rel) => !esperados.has(rel));
  if (inesperados.length) throw crearError("RESTORE_ARCHIVO_INESPERADO", `El snapshot contiene archivos no declarados (${inesperados.length})`);
  verificarComponentes(snapshotDir, lista, "RESTORE_HASH_MISMATCH");

  // ---- Fase 2: restauracion en temporal, re-verificacion y publicacion atomica. ----
  const tmp = path.join(path.dirname(destino), `.tmp-restore-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(tmp);
  try {
    for (const c of lista) {
      const origen = path.join(snapshotDir, ...c.relative_path.split("/"));
      const copia = path.join(tmp, ...c.relative_path.split("/"));
      fs.mkdirSync(path.dirname(copia), { recursive: true });
      fs.copyFileSync(origen, copia, fs.constants.COPYFILE_EXCL);
    }
    verificarComponentes(tmp, lista, "RESTORE_COPIA_INCONSISTENTE");
    const mapa = await verificarRestaurado(tmp, manifest);
    const reporte = {
      ok: true,
      snapshot_id: manifest.snapshot ? manifest.snapshot.id : null,
      restaurado_en: new Date().toISOString(),
      componentes: lista.length,
      control: manifest.control ? manifest.control.relative_path : null,
      tenants: mapa,
      uploads: { archivos: manifest.uploads.archivos, raiz: "uploads/" },
      nota: "Restore aislado. Integraciones cifradas requieren la MISMA ATLAS_INTEGRATION_MASTER_KEY_B64 (no incluida)."
    };
    fs.writeFileSync(path.join(tmp, "restore-report.json"), JSON.stringify(reporte, null, 2));
    fs.renameSync(tmp, destino);
    return { ...reporte, target: destino };
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}

if (require.main === module) {
  restaurar().then(
    (resultado) => { console.log(JSON.stringify(resultado)); },
    (error) => {
      console.log(JSON.stringify({ ok: false, errorCode: error.code || "RESTORE_ERROR", message: error.message }));
      process.exitCode = 1;
    }
  );
}

module.exports = { restaurar };
