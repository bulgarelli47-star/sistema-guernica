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

async function syncUsuariosShadowDesdeDbPath(controlDb, { empresaId, businessDbPath }) {
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
