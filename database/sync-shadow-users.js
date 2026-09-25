const sqlite3 = require("sqlite3").verbose();
const {
  getQuery,
  allQuery,
  resolveEmpresaDbPath,
  crearUsuarioCentral,
  actualizarUsuarioCentral,
  crearMembership,
  actualizarMembership,
  getMembershipPorEmpresaYLocal
} = require("./init-control-db");

// MT-1B.1: copia SHADOW de usuarios locales hacia el control plane. NO gobierna login,
// requireAuth, sesiones ni /usuarios -- la DB de la empresa sigue siendo la autoridad; esto
// solo mantiene una copia (usuarios + usuario_empresas) al dia para uso futuro.
//
// Dos capas deliberadamente separadas:
// - syncUsuariosShadowEmpresa: API publica/reproducible. Resuelve el path de la empresa
//   EXCLUSIVAMENTE desde su fila registrada en `empresas` (via resolveEmpresaDbPath) -- nunca
//   acepta un path arbitrario.
// - syncUsuariosShadowDesdeDbPath: funcion interna de bajo nivel que recibe un businessDbPath
//   explicito. Existe para que los tests puedan apuntar a una DB temporal en os.tmpdir()
//   (fuera del directorio permitido de empresas registradas). No debe usarse con un path que
//   provenga de un request HTTP.
//
// Frontera de usuarios.activo (identidad global) ante multiempresa (MT-1B.1-CLOSE):
// mientras una identidad central tenga UNA sola membership, esa unica empresa es su unica
// fuente de verdad razonable, asi que local.activo puede seguir alimentando tanto
// usuario_empresas.activo (la membership) como usuarios.activo (el kill-switch global) --
// es el comportamiento shadow original. Pero en cuanto una identidad acumula MAS DE UNA
// membership, el sync de UNA empresa individual ya no tiene autoridad para decidir si la
// persona sigue existiendo en Atlas entero: una desactivacion en Comercio B no debe apagar
// a alguien que sigue activo en Guernica. Por eso, con >1 membership, esta rutina deja
// usuarios.activo intacto y solo actualiza usuario_empresas.activo de la membership que
// corresponde a esta empresa.
//
// El resto de los campos "globales" (nombre, password_hash, email, telefono, foto_url,
// ultimo_acceso, intentos_fallidos, bloqueado_hasta) TODAVIA no tiene esta guarda: siguen
// sincronizandose sin condicion, sea cual sea la cantidad de memberships. Que empresa es
// autoridad de esos campos ante una identidad explicitamente multiempresa es una decision
// pendiente, a resolver antes del cutover de auth central (no en MT-1B.1). Esta fase solo
// endurece `activo`, porque su semantica de kill-switch ya quedo definida sin ambiguedad.

function abrirDbEmpresaSoloLectura(businessDbPath) {
  return new sqlite3.Database(businessDbPath, sqlite3.OPEN_READONLY);
}

function cerrarDbEmpresa(db) {
  return new Promise((resolve, reject) => {
    db.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

// AUTH-SYNC-B2-S1A2D-PARTIAL-SCHEMA-FIX: deteccion de esquema por introspeccion pura
// (PRAGMA/sqlite_master). A diferencia de detectarSoporteEsquemaS0 en
// database/reconcile-shadow-users.js (que solo verifica usuario_empresas.version +
// sync_pendiente), esta version verifica los TRES elementos de S0 por separado --
// usuarios.version, usuario_empresas.version y la tabla sync_pendiente -- porque
// initControlSchema agrega version a AMBAS tablas (usuarios Y usuario_empresas). Verificar
// solo una de las dos dejaba un esquema con unicamente usuarios.version mal clasificado como
// CASO A (pre-S0), permitiendo que el importador corriera sin proteccion sobre un esquema que
// ya no es limpio. Esto NO se atribuye a que la migracion transaccional actual (initControlSchema,
// envuelta en un unico BEGIN IMMEDIATE/COMMIT desde S0-TX-FIX1) pueda interrumpirse a mitad de
// camino -- esa migracion especifica es atomica y no deja este tipo de estado intermedio por si
// sola. El detector protege de forma generica contra CUALQUIER origen de un esquema parcial o
// incompatible -- una edicion manual de la Control DB, una migracion distinta no transaccional,
// o cualquier estado que no se corresponda ni con pre-S0 limpio ni con S0 completo -- sin asumir
// una causa especifica. Pre-S0 valido exige que LOS TRES esten ausentes; S0 completo exige que
// LOS TRES esten presentes (mas la forma correcta de sync_pendiente); cualquier otra combinacion
// (incluida version en una sola de las dos tablas) es esquema parcial -- FAIL CLOSED. Sigue
// deliberadamente DUPLICADA, no importada desde reconcile-shadow-users.js, por el mismo motivo
// ya documentado en ese modulo: este importador legacy no debe acoplarse al reconciliador
// S1A1. soportaS0=true (CASO B) o soportaS0=null (CASO C) bloquean igual la importacion --
// ver guardarComportamientoLegacyOFallarCerrado.
async function detectarSoporteEsquemaS0(controlDb) {
  const columnasUsuarios = await allQuery(controlDb, "PRAGMA table_info(usuarios)");
  const tieneVersionUsuarios = columnasUsuarios.some((columna) => columna.name === "version");

  const columnasMembership = await allQuery(controlDb, "PRAGMA table_info(usuario_empresas)");
  const tieneVersionMembership = columnasMembership.some((columna) => columna.name === "version");

  const tablasSyncPendiente = await allQuery(
    controlDb,
    "SELECT name FROM sqlite_master WHERE type='table' AND name='sync_pendiente'"
  );
  const tieneSyncPendiente = tablasSyncPendiente.length > 0;

  if (!tieneVersionUsuarios && !tieneVersionMembership && !tieneSyncPendiente) {
    return { soportaS0: false };
  }

  if (tieneVersionUsuarios && tieneVersionMembership && tieneSyncPendiente) {
    const columnasSyncPendiente = await allQuery(controlDb, "PRAGMA table_info(sync_pendiente)");
    const nombresSyncPendiente = new Set(columnasSyncPendiente.map((columna) => columna.name));
    const columnasEsperadas = ["membership_id", "tipo_operacion", "estado", "version_objetivo"];
    const formaCorrecta = columnasEsperadas.every((columna) => nombresSyncPendiente.has(columna));
    if (!formaCorrecta) {
      return { soportaS0: null, motivo: "SYNC_PENDIENTE_FORMA_INCOMPATIBLE" };
    }
    return { soportaS0: true };
  }

  return { soportaS0: null, motivo: "ESQUEMA_S0_PARCIAL" };
}

// Guard incondicional: no importa si existen o no filas en sync_pendiente, ni si alguna membership
// especifica tiene o no lapida -- la mera presencia (completa o parcial) del esquema S0 en la
// Control DB basta para bloquear la importacion total de este modulo. Corre como la PRIMERA
// operacion de la funcion, antes de abrir siquiera la conexion de solo lectura a la Business DB,
// para que la deteccion de esquema ocurra estrictamente antes de cualquier lectura o escritura.
async function guardarComportamientoLegacyOFallarCerrado(controlDb) {
  const deteccion = await detectarSoporteEsquemaS0(controlDb);
  if (deteccion.soportaS0 === false) {
    return;
  }
  const motivo = deteccion.soportaS0 === true ? "ESQUEMA_S0_COMPLETO" : deteccion.motivo;
  throw new Error(
    `sync-shadow-users: importacion legacy bloqueada -- la Control DB ya tiene esquema S0 (completo o parcial: ${motivo}). ` +
    "Este importador de mirror total no es seguro sobre un esquema S0: use el reconciliador S1A1 (database/reconcile-shadow-users.js) en su lugar."
  );
}

async function syncUsuariosShadowDesdeDbPath(controlDb, { empresaId, businessDbPath }) {
  await guardarComportamientoLegacyOFallarCerrado(controlDb);

  const businessDb = abrirDbEmpresaSoloLectura(businessDbPath);
  try {
    const usuariosLocales = await allQuery(businessDb, "SELECT * FROM usuarios");
    const resultado = [];

    for (const local of usuariosLocales) {
      const activoLocal = Number(local.activo) === 1 ? 1 : 0;
      const membershipExistente = await getMembershipPorEmpresaYLocal(controlDb, {
        empresaId,
        usuarioLocalId: local.id
      });

      if (!membershipExistente) {
        const usuarioCentral = await crearUsuarioCentral(controlDb, {
          nombre: local.nombre,
          usuarioReferencia: local.usuario,
          passwordHash: local.password,
          email: local.email,
          telefono: local.telefono,
          fotoUrl: local.foto_url,
          activo: activoLocal,
          ultimoAcceso: local.ultimo_acceso,
          intentosFallidos: local.intentos_fallidos,
          bloqueadoHasta: local.bloqueado_hasta,
          creadoEn: local.creado_en
        });
        const membership = await crearMembership(controlDb, {
          usuarioId: usuarioCentral.id,
          empresaId,
          usuarioLocalId: local.id,
          rol: local.rol,
          activo: activoLocal
        });
        resultado.push({ accion: "creado", usuarioId: usuarioCentral.id, membershipId: membership.id, usuarioLocalId: local.id });
      } else {
        const conteoMemberships = await getQuery(
          controlDb,
          "SELECT COUNT(*) AS total FROM usuario_empresas WHERE usuario_id = ?",
          [membershipExistente.usuario_id]
        );
        const esMultiempresa = Number(conteoMemberships.total) > 1;

        let activoGlobalAAplicar = activoLocal;
        if (esMultiempresa) {
          const identidadActual = await getQuery(controlDb, "SELECT activo FROM usuarios WHERE id = ?", [membershipExistente.usuario_id]);
          activoGlobalAAplicar = Number(identidadActual.activo);
        }

        await actualizarUsuarioCentral(controlDb, membershipExistente.usuario_id, {
          nombre: local.nombre,
          usuarioReferencia: local.usuario,
          passwordHash: local.password,
          email: local.email,
          telefono: local.telefono,
          fotoUrl: local.foto_url,
          activo: activoGlobalAAplicar,
          ultimoAcceso: local.ultimo_acceso,
          intentosFallidos: local.intentos_fallidos,
          bloqueadoHasta: local.bloqueado_hasta
        });
        await actualizarMembership(controlDb, membershipExistente.id, {
          rol: local.rol,
          activo: activoLocal
        });
        resultado.push({ accion: "actualizado", usuarioId: membershipExistente.usuario_id, membershipId: membershipExistente.id, usuarioLocalId: local.id });
      }
    }

    return resultado;
  } finally {
    await cerrarDbEmpresa(businessDb);
  }
}

async function syncUsuariosShadowEmpresa(controlDb, { empresaSlug }) {
  const empresa = await getQuery(controlDb, "SELECT * FROM empresas WHERE slug = ?", [empresaSlug]);
  if (!empresa) {
    throw new Error(`syncUsuariosShadowEmpresa: no existe una empresa registrada con slug '${empresaSlug}'`);
  }
  const businessDbPath = resolveEmpresaDbPath(empresa.db_path);
  return syncUsuariosShadowDesdeDbPath(controlDb, { empresaId: empresa.id, businessDbPath });
}

module.exports = {
  syncUsuariosShadowEmpresa,
  syncUsuariosShadowDesdeDbPath
};
