// MT-1C.1A: coordinador minimo entre la DB de empresa (autoridad, en esta fase) y el control
// plane (espejo). No conoce Express, no genera bcrypt, no toca sesiones ni login -- solo sabe
// resolver una empresa + membership y escribir el espejo correspondiente en atlas_control.db.
const sqlite3 = require("sqlite3").verbose();
const {
  DEFAULT_DB_PATH,
  closeDb,
  getQuery,
  getMembershipPorEmpresaYLocal,
  actualizarPasswordUsuarioCentral
} = require("../database/init-control-db");

// No reutiliza openDb() de init-control-db.js a proposito, por dos motivos:
// 1) esa funcion abre sin callback, y si el archivo no puede abrirse (directorio inexistente,
//    control plane caido) sqlite3 emite un evento 'error' sin listener -- eso mata el proceso
//    entero en lugar de dejar que este modulo devuelva un 503 controlado. Aca se abre con
//    callback explicito para que el fallo de apertura llegue como rechazo de promesa.
// 2) esa funcion abre con el modo default (OPEN_READWRITE | OPEN_CREATE), que CREARIA
//    atlas_control.db si no existe. El acceso runtime del bridge nunca debe poder materializar
//    el control plane por accidente -- eso es responsabilidad exclusiva de
//    database/init-control-db.js ejecutado explicitamente (MT-1B.2). Por eso aca se fuerza
//    sqlite3.OPEN_READWRITE sin OPEN_CREATE: si el archivo no existe, la apertura falla en vez
//    de crear un archivo vacio.
//
// Exportada (no solo interna) porque es el primitivo de apertura segura que reutilizara
// cualquier bridge futuro (rol, estado, create) -- no se expone unicamente para satisfacer un
// test.
function abrirControlDbBridge(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (error) => {
      if (error) {
        reject(error);
        return;
      }
      db.run("PRAGMA foreign_keys = ON", (pragmaError) => {
        if (pragmaError) {
          db.close(() => reject(pragmaError));
          return;
        }
        resolve(db);
      });
    });
  });
}

function getBridgeMode() {
  return String(process.env.ATLAS_USER_BRIDGE_MODE || "off").trim().toLowerCase();
}

function resolveControlDbPath() {
  return process.env.ATLAS_CONTROL_DB_PATH || DEFAULT_DB_PATH;
}

function resolveEmpresaSlug() {
  return String(process.env.ATLAS_EMPRESA_SLUG || "").trim();
}

async function syncPasswordHash({ empresaSlug, usuarioLocalId, passwordHash, controlDbPath } = {}) {
  const slug = empresaSlug || resolveEmpresaSlug();
  if (!slug) {
    throw new Error("syncPasswordHash: falta configurar ATLAS_EMPRESA_SLUG (o pasar empresaSlug explicito)");
  }

  const dbPath = controlDbPath || resolveControlDbPath();
  const db = await abrirControlDbBridge(dbPath);
  try {
    const empresa = await getQuery(db, "SELECT id, activa FROM empresas WHERE slug = ?", [slug]);
    if (!empresa || Number(empresa.activa) !== 1) {
      throw new Error(`syncPasswordHash: empresa '${slug}' no existe o no esta activa en el control plane`);
    }

    const membership = await getMembershipPorEmpresaYLocal(db, {
      empresaId: empresa.id,
      usuarioLocalId
    });
    if (!membership) {
      throw new Error("syncPasswordHash: no existe membership para este usuario local en esta empresa");
    }

    await actualizarPasswordUsuarioCentral(db, membership.usuario_id, passwordHash);
  } finally {
    await closeDb(db);
  }
}

module.exports = {
  getBridgeMode,
  resolveControlDbPath,
  resolveEmpresaSlug,
  syncPasswordHash,
  abrirControlDbBridge
};
