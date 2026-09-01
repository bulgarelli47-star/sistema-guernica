// MT-1C.2B.2A: servicio de credenciales centrales, aislado de HTTP/sesiones/business DB. No
// conoce Express, no genera tokens, no toca la tabla `sesiones` -- solo decide si una password
// es valida para una identidad central ya resuelta, y administra la politica de seguridad
// (intentos_fallidos/bloqueado_hasta/ultimo_acceso) que hoy vive en /login legacy, replicada aca
// exactamente para la identidad CENTRAL en vez de la local.
//
// Consume resolverIdentidadCentralPorLocal (MT-1C.2A) para la resolucion empresa -> membership
// exacta -> identidad central; nunca busca por username/email/nombre. Reimplementa su propia
// apertura de escritura del control plane (igual criterio que centralAuthResolver.js: no
// acoplarse a backend/userControlBridge.js, que es la autoridad de shadow sync, una
// responsabilidad distinta de la autoridad de seguridad de login).
const fs = require("fs");
const bcrypt = require("bcrypt");
const sqlite3 = require("sqlite3").verbose();
const { DEFAULT_DB_PATH, closeDb, getQuery, runQuery } = require("../database/init-control-db");
const { resolverIdentidadCentralPorLocal } = require("./centralAuthResolver");

// Politica de seguridad replicada EXACTAMENTE de /login legacy (backend/server.js). Si esa
// politica cambia alguna vez, este servicio debe actualizarse en el mismo commit -- son las
// mismas reglas de negocio, aplicadas a la identidad central en vez de a la local.
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCK_MS = 10 * 60 * 1000;

function resultadoError(errorCode, message, parcial = {}) {
  return { ok: false, errorCode, message, ...parcial };
}

// READWRITE sin OPEN_CREATE: este servicio administra seguridad de identidades YA existentes,
// nunca tiene autoridad para materializar el control plane. Callback explicito por el mismo
// motivo ya documentado en centralAuthResolver.js/userControlBridge.js: sin callback, un fallo de
// apertura emite un evento 'error' sin listener y tumba el proceso en vez de rechazar la promesa.
function abrirControlDbEscritura(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (error) => {
      if (error) { reject(error); return; }
      db.run("PRAGMA foreign_keys = ON", (pragmaError) => {
        if (pragmaError) { db.close(() => reject(pragmaError)); return; }
        resolve(db);
      });
    });
  });
}

// Punto de entrada unico. empresaSlug/usuarioLocalId siguen siendo las unicas claves de negocio
// aceptadas (nunca username/email) -- el caller HTTP futuro (MT-1C.2B.2B) es quien resuelve
// "que usuario local esta intentando loguearse" antes de llegar aca. `now` es inyectable
// solamente para que los tests temporales sean deterministas; en runtime real siempre es la hora
// actual.
async function autenticarCredencialCentral({ empresaSlug, usuarioLocalId, password, controlDbPath, now } = {}) {
  const passwordIngresada = String(password || "");
  if (!passwordIngresada) {
    return resultadoError("PASSWORD_REQUERIDO", "autenticarCredencialCentral: falta password");
  }
  const momento = now instanceof Date ? now : new Date();

  const resuelto = await resolverIdentidadCentralPorLocal({ empresaSlug, usuarioLocalId, controlDbPath });
  if (!resuelto.ok) {
    // Los codigos del resolver (EMPRESA_NO_EXISTE, EMPRESA_INACTIVA, MEMBERSHIP_NO_EXISTE,
    // MEMBERSHIP_INACTIVA, BROKEN_CENTRAL_REF, CENTRAL_INACTIVA, CONTROL_DB_*, etc.) se propagan
    // tal cual -- nunca se envuelven como "credencial invalida". El mapeo a HTTP es
    // responsabilidad de MT-1C.2B.2B, no de este servicio.
    return resuelto;
  }
  const { empresa, membership, central } = resuelto;

  const resolvedControlDbPath = controlDbPath || DEFAULT_DB_PATH;
  if (!fs.existsSync(resolvedControlDbPath)) {
    return resultadoError("CONTROL_DB_AUSENTE", `Control plane no encontrado: ${resolvedControlDbPath}`);
  }

  let controlDb;
  try {
    controlDb = await abrirControlDbEscritura(resolvedControlDbPath);
  } catch (error) {
    return resultadoError("CONTROL_DB_INACCESIBLE", error.message);
  }

  let transactionStarted = false;
  try {
    await runQuery(controlDb, "BEGIN IMMEDIATE");
    transactionStarted = true;

    // Releer TODO por los IDs ya resueltos, dentro de la transaccion: resolverIdentidadCentralPorLocal
    // abrio READONLY y ya cerro esa conexion -- entre esa lectura y este punto pudo haber pasado
    // cualquier cosa (otro proceso, otro intento concurrente). Nunca confiar en la copia stale
    // para decidir password/lockout.
    const empresaActual = await getQuery(controlDb, "SELECT id, activa FROM empresas WHERE id = ?", [empresa.id]);
    if (!empresaActual) {
      await runQuery(controlDb, "ROLLBACK");
      transactionStarted = false;
      return resultadoError("CENTRAL_AUTH_STATE_CHANGED", "La empresa resuelta ya no existe en el control plane");
    }
    if (Number(empresaActual.activa) !== 1) {
      await runQuery(controlDb, "ROLLBACK");
      transactionStarted = false;
      return resultadoError("EMPRESA_INACTIVA", `Empresa '${empresa.slug}' esta inactiva en el control plane`, { empresa: { id: empresa.id, slug: empresa.slug, activa: false } });
    }

    const membershipActual = await getQuery(controlDb, "SELECT * FROM usuario_empresas WHERE id = ?", [membership.id]);
    if (!membershipActual) {
      await runQuery(controlDb, "ROLLBACK");
      transactionStarted = false;
      return resultadoError("CENTRAL_AUTH_STATE_CHANGED", "La membership resuelta ya no existe en el control plane");
    }
    const membershipCambioVinculo =
      Number(membershipActual.empresa_id) !== Number(empresa.id) ||
      Number(membershipActual.usuario_local_id) !== Number(membership.usuario_local_id) ||
      Number(membershipActual.usuario_id) !== Number(central.id);
    if (membershipCambioVinculo) {
      await runQuery(controlDb, "ROLLBACK");
      transactionStarted = false;
      return resultadoError("CENTRAL_AUTH_STATE_CHANGED", "La membership resuelta ya no vincula la misma empresa/usuario local/identidad central");
    }
    if (Number(membershipActual.activo) !== 1) {
      await runQuery(controlDb, "ROLLBACK");
      transactionStarted = false;
      return resultadoError("MEMBERSHIP_INACTIVA", "La membership de este usuario local en esta empresa esta inactiva", {
        empresa: { id: empresa.id, slug: empresa.slug, activa: true },
        membership: { id: membershipActual.id, usuario_local_id: Number(membershipActual.usuario_local_id), rol: membershipActual.rol, activo: false }
      });
    }

    const centralActual = await getQuery(
      controlDb,
      "SELECT id, activo, password_hash, intentos_fallidos, bloqueado_hasta, ultimo_acceso FROM usuarios WHERE id = ?",
      [membership.usuario_id]
    );
    if (!centralActual) {
      // Distinto del BROKEN_CENTRAL_REF del resolver (referencia rota desde siempre, detectable en
      // la primera lectura read-only): aca el resolver YA encontro un `central` valido momentos
      // antes -- que ahora no exista es un cambio de estado ocurrido entre esa lectura y esta
      // relectura dentro de la transaccion, no un dato estructuralmente roto.
      await runQuery(controlDb, "ROLLBACK");
      transactionStarted = false;
      return resultadoError("CENTRAL_AUTH_STATE_CHANGED", "La identidad central resuelta ya no existe en el control plane");
    }
    if (Number(centralActual.activo) !== 1) {
      await runQuery(controlDb, "ROLLBACK");
      transactionStarted = false;
      return resultadoError("CENTRAL_INACTIVA", "La identidad central esta deshabilitada globalmente", {
        empresa: { id: empresa.id, slug: empresa.slug, activa: true },
        membership: { id: membershipActual.id, usuario_local_id: Number(membershipActual.usuario_local_id), rol: membershipActual.rol, activo: true },
        central: { id: centralActual.id, activo: false }
      });
    }

    // A partir de aca, la unica fuente de verdad para password/intentos/bloqueo es esta fila
    // releida dentro de la transaccion -- nunca el objeto `central` obtenido antes del BEGIN.
    let intentosActuales = Number(centralActual.intentos_fallidos || 0);
    const bloqueadoHastaActual = centralActual.bloqueado_hasta || null;
    const bloqueoPodriaEstarActivo = intentosActuales >= MAX_LOGIN_ATTEMPTS && bloqueadoHastaActual;

    if (bloqueoPodriaEstarActivo) {
      const bloqueadoHastaMs = new Date(bloqueadoHastaActual).getTime();
      if (bloqueadoHastaMs > momento.getTime()) {
        // Bloqueo vigente: replica exacta del short-circuit legacy -- ni siquiera se compara la
        // password, ni se toca ultimo_acceso, ni se incrementa nada.
        await runQuery(controlDb, "ROLLBACK");
        transactionStarted = false;
        return resultadoError("CENTRAL_BLOQUEADA", "La identidad central esta bloqueada temporalmente por intentos fallidos", {
          bloqueado_hasta: bloqueadoHastaActual
        });
      }
      // Bloqueo expirado: reset silencioso ANTES de evaluar la password, misma politica legacy.
      intentosActuales = 0;
    }

    const passwordValida = await bcrypt.compare(passwordIngresada, centralActual.password_hash);

    if (!passwordValida) {
      const nuevosIntentos = (intentosActuales >= MAX_LOGIN_ATTEMPTS ? 0 : intentosActuales) + 1;
      const bloqueadoHastaNuevo = nuevosIntentos >= MAX_LOGIN_ATTEMPTS
        ? new Date(momento.getTime() + LOGIN_LOCK_MS).toISOString()
        : null;
      await runQuery(
        controlDb,
        "UPDATE usuarios SET intentos_fallidos = ?, bloqueado_hasta = ?, actualizado_en = datetime('now') WHERE id = ?",
        [nuevosIntentos, bloqueadoHastaNuevo, centralActual.id]
      );
      await runQuery(controlDb, "COMMIT");
      transactionStarted = false;
      return resultadoError(
        "CREDENCIAL_INVALIDA",
        "Password invalida para la identidad central",
        bloqueadoHastaNuevo ? { bloqueado_hasta: bloqueadoHastaNuevo } : {}
      );
    }

    const ultimoAccesoNuevo = momento.toISOString();
    await runQuery(
      controlDb,
      "UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL, ultimo_acceso = ?, actualizado_en = datetime('now') WHERE id = ?",
      [ultimoAccesoNuevo, centralActual.id]
    );
    await runQuery(controlDb, "COMMIT");
    transactionStarted = false;

    return {
      ok: true,
      empresa: { id: empresa.id, slug: empresa.slug, activa: true },
      membership: { id: membershipActual.id, usuario_local_id: Number(membershipActual.usuario_local_id), rol: membershipActual.rol, activo: true },
      central: { id: centralActual.id, activo: true, ultimo_acceso: ultimoAccesoNuevo }
    };
  } catch (error) {
    if (transactionStarted) {
      try { await runQuery(controlDb, "ROLLBACK"); } catch (rollbackError) { error.rollbackError = rollbackError; }
    }
    return resultadoError("CONTROL_DB_WRITE_ERROR", error.message);
  } finally {
    await closeDb(controlDb);
  }
}

module.exports = {
  autenticarCredencialCentral,
  MAX_LOGIN_ATTEMPTS,
  LOGIN_LOCK_MS
};
