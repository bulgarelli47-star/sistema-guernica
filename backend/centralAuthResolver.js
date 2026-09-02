// MT-1C.2A: resolver central READ-ONLY para el futuro auth central. No implementa login, no
// compara password, no toca sesiones -- solo resuelve la cadena empresa -> membership exacta ->
// identidad central, usando exclusivamente el vinculo seguro ya establecido en MT-1C.1D:
// empresa.slug + usuario_empresas(empresa_id, usuario_local_id). NUNCA busca identidad central
// por username/email/nombre (ver MT-1C.1C/MT-1C.1D: esa fusion seria arquitectonicamente
// incorrecta -- no hay ninguna senal segura para vincular dos identidades por coincidencia de
// texto).
//
// Deliberadamente NO depende de backend/server.js ni de backend/db.js (esto es orquestacion de
// auth central, no bootstrap de business DB) y reimplementa su propia apertura segura en vez de
// reutilizar backend/userControlBridge.js, para no acoplar este resolver al runtime del bridge
// shadow (mismo criterio ya aplicado en database/reconcile-shadow-users.js).
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();
const { DEFAULT_DB_PATH, closeDb, getQuery, getMembershipPorEmpresaYLocal } = require("../database/init-control-db");

// READONLY, con callback explicito: si el archivo no existe o la apertura falla, sqlite3 emitiria
// un evento 'error' sin listener y tumbaria el proceso entero en vez de rechazar la promesa (mismo
// riesgo ya documentado y resuelto en userControlBridge.js/reconcile-shadow-users.js). Nunca
// OPEN_CREATE: este resolver no tiene autoridad para materializar el control plane.
function abrirControlDbSoloLectura(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (error) => {
      if (error) { reject(error); return; }
      resolve(db);
    });
  });
}

function resultadoError(errorCode, message, parcial = {}) {
  return { ok: false, errorCode, message, ...parcial };
}

function normalizarIdSesion(valor) {
  const numero = Number(valor);
  return Number.isInteger(numero) && numero > 0 ? numero : null;
}

// Punto de entrada unico del resolver. No compara password, no incrementa lockout, no toca
// sesiones -- eso es responsabilidad de una fase posterior (MT-1C.2B) que consumira el
// password_hash/intentos_fallidos/bloqueado_hasta ya expuestos aca. usuarioLocalId es la unica
// clave de negocio local que este resolver acepta: nunca un username, nunca un email.
async function resolverIdentidadCentralPorLocal({ empresaSlug, usuarioLocalId, controlDbPath } = {}) {
  const slug = String(empresaSlug || "").trim();
  if (!slug) {
    return resultadoError("EMPRESA_SLUG_REQUERIDO", "resolverIdentidadCentralPorLocal: falta empresaSlug");
  }
  const localId = Number(usuarioLocalId);
  if (!Number.isInteger(localId) || localId <= 0) {
    return resultadoError("USUARIO_LOCAL_ID_INVALIDO", "resolverIdentidadCentralPorLocal: usuarioLocalId invalido");
  }

  const resolvedControlDbPath = controlDbPath || DEFAULT_DB_PATH;
  if (!fs.existsSync(resolvedControlDbPath)) {
    return resultadoError("CONTROL_DB_AUSENTE", `Control plane no encontrado: ${resolvedControlDbPath}`);
  }

  let controlDb;
  try {
    controlDb = await abrirControlDbSoloLectura(resolvedControlDbPath);
  } catch (error) {
    return resultadoError("CONTROL_DB_INACCESIBLE", error.message);
  }

  try {
    const empresaRow = await getQuery(controlDb, "SELECT id, slug, activa FROM empresas WHERE slug = ?", [slug]);
    if (!empresaRow) {
      return resultadoError("EMPRESA_NO_EXISTE", `Empresa '${slug}' no existe en el control plane`);
    }
    const empresa = { id: empresaRow.id, slug: empresaRow.slug, activa: Number(empresaRow.activa) === 1 };
    if (!empresa.activa) {
      return resultadoError("EMPRESA_INACTIVA", `Empresa '${slug}' esta inactiva en el control plane`, { empresa });
    }

    const membershipRow = await getMembershipPorEmpresaYLocal(controlDb, { empresaId: empresa.id, usuarioLocalId: localId });
    if (!membershipRow) {
      return resultadoError("MEMBERSHIP_NO_EXISTE", "No existe membership para este usuario local en esta empresa", { empresa });
    }
    const membership = {
      id: membershipRow.id,
      usuario_id: membershipRow.usuario_id,
      empresa_id: membershipRow.empresa_id,
      usuario_local_id: Number(membershipRow.usuario_local_id),
      rol: membershipRow.rol,
      activo: Number(membershipRow.activo) === 1
    };
    if (!membership.activo) {
      return resultadoError("MEMBERSHIP_INACTIVA", "La membership de este usuario local en esta empresa esta inactiva", { empresa, membership });
    }

    const centralRow = await getQuery(
      controlDb,
      "SELECT id, activo, password_hash, intentos_fallidos, bloqueado_hasta, ultimo_acceso FROM usuarios WHERE id = ?",
      [membership.usuario_id]
    );
    if (!centralRow) {
      return resultadoError("BROKEN_CENTRAL_REF", "La membership referencia una identidad central inexistente", { empresa, membership });
    }
    const central = {
      id: centralRow.id,
      activo: Number(centralRow.activo) === 1,
      password_hash: centralRow.password_hash,
      intentos_fallidos: Number(centralRow.intentos_fallidos || 0),
      bloqueado_hasta: centralRow.bloqueado_hasta || null,
      ultimo_acceso: centralRow.ultimo_acceso || null
    };
    if (!central.activo) {
      // Nunca reutilizar el objeto `central` completo aca: password_hash/intentos_fallidos/
      // bloqueado_hasta son datos de autenticacion que solo tienen sentido en el camino SUCCESS
      // (consumidos por MT-1C.2B). Un resultado NO-OK jamas debe filtrar secretos, ni siquiera
      // parcialmente -- este resumen angosto es deliberado, no un descuido a "completar despues".
      return resultadoError("CENTRAL_INACTIVA", "La identidad central esta deshabilitada globalmente", {
        empresa, membership, central: { id: central.id, activo: central.activo }
      });
    }

    return { ok: true, empresa, membership, central };
  } catch (error) {
    // Distinto de CONTROL_DB_INACCESIBLE a proposito: acá el archivo SI abrio (es un SQLite
    // valido), pero su estructura no sirve como control plane (por ejemplo, falta la tabla
    // `empresas`). Nunca debe llegar como excepcion sin clasificar al caller.
    return resultadoError("CONTROL_DB_QUERY_ERROR", error.message);
  } finally {
    await closeDb(controlDb);
  }
}

// MT-1C.2B.3: revalidador angosto para sesiones ya emitidas. No autentica, no lee secretos, no
// toca lockout ni ultimo_acceso, y no conoce Express ni la tabla local `sesiones`; solo comprueba
// que las anclas guardadas en la sesion siguen representando exactamente la autoridad central
// vigente de este proceso.
async function revalidarSesionCentral({
  empresaSlug,
  empresaId,
  membershipId,
  centralId,
  usuarioLocalId,
  controlDbPath
} = {}) {
  const slug = String(empresaSlug || "").trim();
  const empresaIdNormalizado = normalizarIdSesion(empresaId);
  const membershipIdNormalizado = normalizarIdSesion(membershipId);
  const centralIdNormalizado = normalizarIdSesion(centralId);
  const usuarioLocalIdNormalizado = normalizarIdSesion(usuarioLocalId);
  if (!slug || !empresaIdNormalizado || !membershipIdNormalizado || !centralIdNormalizado || !usuarioLocalIdNormalizado) {
    return resultadoError("CENTRAL_SESSION_BINDING_INVALID", "revalidarSesionCentral: anclas de sesion invalidas");
  }

  const resolvedControlDbPath = controlDbPath || DEFAULT_DB_PATH;
  if (!fs.existsSync(resolvedControlDbPath)) {
    return resultadoError("CONTROL_DB_AUSENTE", `Control plane no encontrado: ${resolvedControlDbPath}`);
  }

  let controlDb;
  try {
    controlDb = await abrirControlDbSoloLectura(resolvedControlDbPath);
  } catch (error) {
    return resultadoError("CONTROL_DB_INACCESIBLE", error.message);
  }

  try {
    const row = await getQuery(
      controlDb,
      `SELECT
         e.id AS empresa_id,
         e.slug AS empresa_slug,
         e.activa AS empresa_activa,
         ue.id AS membership_id,
         ue.empresa_id AS membership_empresa_id,
         ue.usuario_id AS membership_usuario_id,
         ue.usuario_local_id AS membership_usuario_local_id,
         ue.rol AS membership_rol,
         ue.activo AS membership_activo,
         u.id AS central_id,
         u.activo AS central_activo
       FROM empresas e
       JOIN usuario_empresas ue ON ue.empresa_id = e.id
       JOIN usuarios u ON u.id = ue.usuario_id
       WHERE e.id = ?
         AND e.slug = ?
         AND ue.id = ?
         AND ue.empresa_id = e.id
         AND ue.usuario_local_id = ?
         AND ue.usuario_id = ?
         AND u.id = ?`,
      [
        empresaIdNormalizado,
        slug,
        membershipIdNormalizado,
        usuarioLocalIdNormalizado,
        centralIdNormalizado,
        centralIdNormalizado
      ]
    );

    if (!row) {
      return resultadoError("CENTRAL_SESSION_BINDING_INVALID", "La sesion central ya no coincide con la autoridad vigente");
    }

    const empresa = {
      id: row.empresa_id,
      slug: row.empresa_slug,
      activa: Number(row.empresa_activa) === 1
    };
    const membership = {
      id: row.membership_id,
      empresa_id: row.membership_empresa_id,
      usuario_id: row.membership_usuario_id,
      usuario_local_id: Number(row.membership_usuario_local_id),
      rol: row.membership_rol,
      activo: Number(row.membership_activo) === 1
    };
    const central = {
      id: row.central_id,
      activo: Number(row.central_activo) === 1
    };

    if (!empresa.activa) {
      return resultadoError("EMPRESA_INACTIVA", "La empresa de la sesion central esta inactiva", { empresa, membership, central });
    }
    if (!membership.activo) {
      return resultadoError("MEMBERSHIP_INACTIVA", "La membership de la sesion central esta inactiva", { empresa, membership, central });
    }
    if (!central.activo) {
      return resultadoError("CENTRAL_INACTIVA", "La identidad central de la sesion esta inactiva", { empresa, membership, central });
    }

    return { ok: true, empresa, membership, central };
  } catch (error) {
    return resultadoError("CONTROL_DB_QUERY_ERROR", error.message);
  } finally {
    await closeDb(controlDb);
  }
}

module.exports = {
  resolverIdentidadCentralPorLocal,
  abrirControlDbSoloLectura,
  revalidarSesionCentral
};
