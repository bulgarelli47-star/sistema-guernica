// MT-1C.1A: coordinador minimo entre la DB de empresa (autoridad, en esta fase) y el control
// plane (espejo). No conoce Express, no genera bcrypt, no toca sesiones ni login -- solo sabe
// resolver una empresa + membership y escribir el espejo correspondiente en atlas_control.db.
const sqlite3 = require("sqlite3").verbose();
const {
  DEFAULT_DB_PATH,
  closeDb,
  runQuery,
  getQuery,
  allQuery,
  getMembershipPorEmpresaYLocal,
  crearUsuarioCentral,
  crearMembership,
  actualizarPasswordUsuarioCentral,
  actualizarAccesoMembership,
  actualizarActivoMembership
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

// Resolucion de empresa compartida por password/rol/activo/create por igual: la empresa debe
// existir y estar activa. Extraida aparte porque Create la necesita SIN membership (todavia no
// existe ninguna para ese usuario_local_id en el momento de crearla).
async function resolverEmpresaActiva(db, slug) {
  const empresa = await getQuery(db, "SELECT id, activa FROM empresas WHERE slug = ?", [slug]);
  if (!empresa || Number(empresa.activa) !== 1) {
    throw new Error(`resolverEmpresaActiva: empresa '${slug}' no existe o no esta activa en el control plane`);
  }
  return empresa;
}

// Resolucion compartida empresa+membership: usada por password, rol y activo por igual. La
// empresa debe existir y estar activa, y debe existir una membership real para ese
// usuario_local_id -- el bridge nunca auto-crea ninguna de las dos cosas.
async function resolverMembershipActiva(db, slug, usuarioLocalId) {
  const empresa = await resolverEmpresaActiva(db, slug);

  const membership = await getMembershipPorEmpresaYLocal(db, {
    empresaId: empresa.id,
    usuarioLocalId
  });
  if (!membership) {
    throw new Error("resolverMembershipActiva: no existe membership para este usuario local en esta empresa");
  }

  return membership;
}

// Usada EXCLUSIVAMENTE en modos no-central (legacy/off) -- LOCAL-FIRST, sin cambios respecto de su
// contrato historico. En central+shadow, PATCH /usuarios/:id/password ya no llama a esta funcion:
// usa resolverIdentidadCentralParaPassword + actualizarPasswordCentralFirst (AUTH-SYNC-B2-P1A,
// mas abajo).
async function syncPasswordHash({ empresaSlug, usuarioLocalId, passwordHash, controlDbPath } = {}) {
  const slug = empresaSlug || resolveEmpresaSlug();
  if (!slug) {
    throw new Error("syncPasswordHash: falta configurar ATLAS_EMPRESA_SLUG (o pasar empresaSlug explicito)");
  }

  const dbPath = controlDbPath || resolveControlDbPath();
  const db = await abrirControlDbBridge(dbPath);
  try {
    const membership = await resolverMembershipActiva(db, slug, usuarioLocalId);
    await actualizarPasswordUsuarioCentral(db, membership.usuario_id, passwordHash);
  } finally {
    await closeDb(db);
  }
}

// AUTH-SYNC-B2-P1A: resolucion de SOLO LECTURA, ANTES de calcular bcrypt y ANTES de cualquier
// transaccion de escritura -- captura la identidad central vigente y su `version` actual
// (expectedVersion) para que el caller pueda hacer CAS en actualizarPasswordCentralFirst. No
// decide nada por si sola: entre esta lectura y la transaccion real puede pasar cualquier cosa
// (otro request concurrente), por eso la escritura vuelve a verificar todo dentro de su propio
// BEGIN IMMEDIATE -- esta funcion solo resuelve QUIEN es el target, nunca autoriza la escritura.
async function resolverIdentidadCentralParaPassword({ empresaSlug, usuarioLocalId, controlDbPath } = {}) {
  const slug = empresaSlug || resolveEmpresaSlug();
  if (!slug) {
    throw new Error("resolverIdentidadCentralParaPassword: falta configurar ATLAS_EMPRESA_SLUG (o pasar empresaSlug explicito)");
  }

  const dbPath = controlDbPath || resolveControlDbPath();
  const db = await abrirControlDbBridge(dbPath);
  try {
    const membership = await resolverMembershipActiva(db, slug, usuarioLocalId);
    const central = await getQuery(db, "SELECT id, version FROM usuarios WHERE id = ?", [membership.usuario_id]);
    if (!central) {
      throw new Error("resolverIdentidadCentralParaPassword: la identidad central de esta membership ya no existe");
    }
    return {
      usuarioCentralId: central.id,
      expectedVersion: Number(central.version),
      membershipId: membership.id,
      empresaId: membership.empresa_id
    };
  } finally {
    await closeDb(db);
  }
}

// AUTH-SYNC-B2-P1A: transaccion central-first real -- CAS por `usuarios.version` + fan-out
// INCONDICIONAL (sin filtrar por membership.activo ni empresa.activa: password pertenece a GLOBAL
// USER, no a una membership puntual -- contrato P1A) hacia TODAS las memberships existentes de la
// identidad. Nunca escribe en ninguna Business DB -- esa responsabilidad es exclusiva de
// database/process-central-outbox.js (intento inmediato del handler HTTP, o drenaje diferido). Una
// password nueva REABRE a 'pendiente' cualquier fila previa (incluida una ya 'procesado') -- el
// UPDATE de upsert no filtra por estado a proposito. sync_pendiente nunca recibe el hash: solo la
// referencia (membership, tipo, version_objetivo) que el consumer debe releer al procesar.
async function actualizarPasswordCentralFirst({ usuarioCentralId, expectedVersion, passwordHash, controlDbPath } = {}) {
  const dbPath = controlDbPath || resolveControlDbPath();
  const db = await abrirControlDbBridge(dbPath);
  let transactionStarted = false;
  try {
    await runQuery(db, "BEGIN IMMEDIATE");
    transactionStarted = true;

    const casResult = await runQuery(
      db,
      "UPDATE usuarios SET password_hash = ?, version = version + 1, actualizado_en = datetime('now') WHERE id = ? AND version = ?",
      [passwordHash, usuarioCentralId, expectedVersion]
    );

    if (casResult.changes !== 1) {
      const actual = await getQuery(db, "SELECT version FROM usuarios WHERE id = ?", [usuarioCentralId]);
      await runQuery(db, "ROLLBACK");
      transactionStarted = false;
      return {
        ok: false,
        errorCode: "VERSION_CONFLICT",
        versionActual: actual ? Number(actual.version) : null
      };
    }

    const newVersion = expectedVersion + 1;

    // Sin filtro alguno -- TODAS las memberships, activas o no, de empresas activas o no.
    const memberships = await allQuery(
      db,
      "SELECT id, empresa_id, usuario_local_id FROM usuario_empresas WHERE usuario_id = ?",
      [usuarioCentralId]
    );

    for (const membership of memberships) {
      const upsert = await runQuery(
        db,
        `UPDATE sync_pendiente
         SET version_objetivo = ?, estado = 'pendiente', procesado_en = NULL
         WHERE membership_id = ? AND tipo_operacion = 'password'`,
        [newVersion, membership.id]
      );
      if (upsert.changes === 0) {
        await runQuery(
          db,
          `INSERT INTO sync_pendiente
             (usuario_id, empresa_id, membership_id, usuario_local_id, tipo_operacion, version_objetivo, estado)
           VALUES (?, ?, ?, ?, 'password', ?, 'pendiente')`,
          [usuarioCentralId, membership.empresa_id, membership.id, membership.usuario_local_id, newVersion]
        );
      }
    }

    await runQuery(db, "COMMIT");
    transactionStarted = false;

    return {
      ok: true,
      usuarioCentralId,
      newVersion,
      memberships: memberships.map((m) => ({
        membershipId: m.id,
        empresaId: m.empresa_id,
        usuarioLocalId: m.usuario_local_id
      }))
    };
  } catch (error) {
    if (transactionStarted) {
      try { await runQuery(db, "ROLLBACK"); } catch (rollbackError) { error.rollbackError = rollbackError; }
    }
    throw error;
  } finally {
    await closeDb(db);
  }
}

// MT-1C.1B: rol y activo por empresa. Autoridad sigue siendo LOCAL en esta fase -- estas
// funciones solo escriben el espejo en usuario_empresas, nunca en usuarios (central), y nunca
// en ningun otro campo de la membership (por eso usan los updates angostos de un solo campo).
async function syncMembershipActivo({ empresaSlug, usuarioLocalId, activo, controlDbPath } = {}) {
  const slug = empresaSlug || resolveEmpresaSlug();
  if (!slug) {
    throw new Error("syncMembershipActivo: falta configurar ATLAS_EMPRESA_SLUG (o pasar empresaSlug explicito)");
  }

  const dbPath = controlDbPath || resolveControlDbPath();
  const db = await abrirControlDbBridge(dbPath);
  try {
    const membership = await resolverMembershipActiva(db, slug, usuarioLocalId);
    await actualizarActivoMembership(db, membership.id, activo);
  } finally {
    await closeDb(db);
  }
}

// PUT /usuarios/:id puede cambiar rol Y activo en la misma request -- rol y activo se
// sincronizan en UNA sola sentencia UPDATE (actualizarAccesoMembership), para que la membership
// nunca pueda quedar en un estado intermedio (rol nuevo con activo viejo) entre dos escrituras
// separadas.
async function syncMembershipAccess({ empresaSlug, usuarioLocalId, rol, activo, controlDbPath } = {}) {
  const slug = empresaSlug || resolveEmpresaSlug();
  if (!slug) {
    throw new Error("syncMembershipAccess: falta configurar ATLAS_EMPRESA_SLUG (o pasar empresaSlug explicito)");
  }

  const dbPath = controlDbPath || resolveControlDbPath();
  const db = await abrirControlDbBridge(dbPath);
  try {
    const membership = await resolverMembershipActiva(db, slug, usuarioLocalId);
    await actualizarAccesoMembership(db, membership.id, { rol, activo });
  } finally {
    await closeDb(db);
  }
}

// MT-1C.1C: crea identidad central NUEVA + membership para un usuario local recien insertado.
// NUNCA reutiliza una identidad central preexistente (no auto-link por usuario/email/nombre --
// no hay ninguna senal segura para eso, y fusionar por coincidencia seria arquitectonicamente
// incorrecto). central.activo nace SIEMPRE en 1 (habilitacion global de la identidad Atlas);
// unicamente membership.activo refleja el activo local de ESA empresa.
//
// crearUsuarioCentral + crearMembership se envuelven en una unica transaccion (BEGIN IMMEDIATE /
// COMMIT / ROLLBACK) para que la identidad central nunca quede huerfana si la membership falla
// (por ejemplo, por la constraint UNIQUE(empresa_id, usuario_local_id)).
async function syncUserCreate({ empresaSlug, usuarioLocal, passwordHash, controlDbPath } = {}) {
  const slug = empresaSlug || resolveEmpresaSlug();
  if (!slug) {
    throw new Error("syncUserCreate: falta configurar ATLAS_EMPRESA_SLUG (o pasar empresaSlug explicito)");
  }

  const dbPath = controlDbPath || resolveControlDbPath();
  const db = await abrirControlDbBridge(dbPath);
  let transactionStarted = false;
  try {
    await runQuery(db, "BEGIN IMMEDIATE");
    transactionStarted = true;

    const empresa = await resolverEmpresaActiva(db, slug);

    const usuarioCentral = await crearUsuarioCentral(db, {
      nombre: usuarioLocal.nombre,
      usuarioReferencia: usuarioLocal.usuario,
      passwordHash,
      email: usuarioLocal.email,
      telefono: usuarioLocal.telefono,
      fotoUrl: null,
      activo: 1
    });

    await crearMembership(db, {
      usuarioId: usuarioCentral.id,
      empresaId: empresa.id,
      usuarioLocalId: usuarioLocal.id,
      rol: usuarioLocal.rol,
      activo: usuarioLocal.activo
    });

    await runQuery(db, "COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        await runQuery(db, "ROLLBACK");
      } catch (rollbackError) {
        // No reemplazar el error original: se adjunta como contexto adicional, nunca se relanza
        // en su lugar. Perder por que fallo la creacion original seria peor que un rollback
        // fallido silencioso.
        error.rollbackError = rollbackError;
      }
    }
    throw error;
  } finally {
    await closeDb(db);
  }
}

module.exports = {
  getBridgeMode,
  resolveControlDbPath,
  resolveEmpresaSlug,
  syncPasswordHash,
  syncMembershipActivo,
  syncMembershipAccess,
  syncUserCreate,
  abrirControlDbBridge,
  resolverIdentidadCentralParaPassword,
  actualizarPasswordCentralFirst
};
