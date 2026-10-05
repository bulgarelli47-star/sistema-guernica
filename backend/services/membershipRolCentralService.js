// AUTH-SYNC-B2-S2a: writer CENTRAL-FIRST e idempotente del ROL de UNA membership
// (usuario_empresas.rol). Una sola transaccion de Control (BEGIN IMMEDIATE) que, con las MISMAS
// reglas de autoridad que los writers de estado (validarAutoridadYDestino, compartido), aplica CAS por
// usuario_empresas.version -- la UNICA generacion de rol y estado --, reabre la lapida compartida
// sync_pendiente(membership, 'rol_activo') con version_objetivo = la generacion confirmada y deja
// confirmada la respuesta HTTP durable de su Idempotency-Key, todo en el MISMO COMMIT.
//
// Limites: solo escribe usuario_empresas.rol/version/actualizado_en de la membership destino, la
// lapida rol_activo (via el helper compartido) y su fila de operacion_idempotencia. Nunca
// usuario_empresas.activo (eso es exclusivo del writer de estado), nunca usuarios (identidad global,
// credenciales), nunca sesiones, nunca la business DB: la proyeccion pertenece al consumer S0b3a y al
// worker S0b3b. La respuesta almacenada es inmutable despues del COMMIT.
const crypto = require("crypto");
const { getQuery, runQuery } = require("../../database/init-control-db");
const {
  RESULTADOS_ESTADO_MEMBERSHIP: R,
  RESULTADOS_IDEMPOTENCIA,
  contarAdminsEfectivos,
  internosCompartidos
} = require("./membershipEstadoCentralService");

const {
  ROL_ADMIN,
  HTTP_NO_DURABLE,
  validarAutoridadYDestino,
  ejecutarEnTransaccionControl,
  verificarEsquema,
  verificarEsquemaIdempotencia,
  normalizarIdempotencyKey,
  registrarPendienteRolActivo
} = internosCompartidos;

const ENDPOINT_LOGICO_ROL = "/usuarios/:id/rol";
// Roles canonicos aceptados como ENTRADA. Los alias legacy (operador/caja/cajero) nunca se aceptan ni
// se normalizan aca: si Control todavia contiene uno, un pedido canonico lo reemplaza.
const ROLES_CANONICOS = Object.freeze(["admin", "encargado", "colaborador"]);

const RESULTADO_POR_CODIGO_DURABLE = Object.freeze({
  ROL_ACTUALIZADO: R.CONFIRMADO,
  SIN_CAMBIOS: R.SIN_CAMBIOS,
  VERSION_CONFLICT: R.VERSION_CONFLICT
});

function enteroPositivo(valor) {
  const n = typeof valor === "string" && valor.trim() !== "" ? Number(valor) : valor;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function enteroNoNegativo(valor) {
  const n = typeof valor === "string" && valor.trim() !== "" ? Number(valor) : valor;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function rolCanonico(valor) {
  return typeof valor === "string" && ROLES_CANONICOS.includes(valor) ? valor : null;
}

function rechazo(resultado, motivo, extra = {}) {
  return { ok: false, resultado, motivo, ...extra };
}

// Representacion canonica (orden fijo) de la OPERACION de rol, sin secretos. Endpoint logico propio:
// una clave de /estado o de credenciales nunca coincide con una de /rol.
function calcularHuellaRol({ empresaId, actorCentralId, actorMembershipId, targetUsuarioLocalId, targetMembershipId, rol, expectedVersion }) {
  const payload = JSON.stringify({
    metodo: "PATCH",
    endpoint: ENDPOINT_LOGICO_ROL,
    empresaId: Number(empresaId),
    actorCentralId: Number(actorCentralId),
    actorMembershipId: Number(actorMembershipId),
    targetUsuarioLocalId: Number(targetUsuarioLocalId),
    targetMembershipId: targetMembershipId === null ? null : Number(targetMembershipId),
    rol: String(rol),
    expectedVersion: Number(expectedVersion)
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function respuestaDurableRol(r) {
  if (r.resultado === R.CONFIRMADO) {
    return {
      http: 200,
      json: {
        code: "ROL_ACTUALIZADO",
        message: "Rol actualizado en el control central. La sincronizacion con la sucursal quedo pendiente al confirmar.",
        usuario_id: r.usuarioLocalId,
        rol: r.rol,
        version: r.versionNueva,
        operacion: { tipo: "rol_activo", version_objetivo: r.pendiente.versionObjetivo },
        sincronizacion_tenant: "pendiente_al_commit"
      }
    };
  }
  if (r.resultado === R.SIN_CAMBIOS) {
    return {
      http: 200,
      json: {
        code: "SIN_CAMBIOS",
        message: "El usuario ya tenia ese rol.",
        usuario_id: r.usuarioLocalId,
        rol: r.rol,
        version: r.versionActual
      }
    };
  }
  if (r.resultado === R.VERSION_CONFLICT) {
    return {
      http: 409,
      json: {
        code: "VERSION_CONFLICT",
        message: "El usuario fue modificado por otra operacion. Actualiza los datos y volve a intentar.",
        version_actual: r.versionActual
      }
    };
  }
  return null;
}

// Cambio de rol sobre el destino YA autorizado (R1-R5 validadas en esta misma transaccion). Devuelve
// el resultado; solo CONFIRMADO implica escrituras (CAS de rol + lapida), y siempre deja la decision de
// COMMIT/ROLLBACK al caller.
async function aplicarCambioRol(db, { empresa, destino, rolNuevo, versionEsperada }) {
  const base = { membershipId: Number(destino.id), empresaId: empresa };
  const usuarioLocalId = Number(destino.usuario_local_id);
  const versionActual = Number(destino.version);

  // Precondicion de version ANTES del no-op (mismo contrato que S1a-R1).
  if (versionActual !== versionEsperada) {
    return rechazo(R.VERSION_CONFLICT, "VERSION_CONFLICT", { ...base, usuarioLocalId, versionActual });
  }
  if (destino.rol === rolNuevo) {
    return { ok: true, resultado: R.SIN_CAMBIOS, ...base, usuarioLocalId, rol: destino.rol, versionActual };
  }

  // Ultimo ADMIN efectivo: degradar un admin nunca puede dejar a la empresa sin administradores con
  // acceso efectivo (se cuenta dentro de la transaccion, excluyendo al destino).
  if (destino.rol === ROL_ADMIN && rolNuevo !== ROL_ADMIN) {
    const restantes = await contarAdminsEfectivos(db, empresa, { excluirMembershipId: Number(destino.id) });
    if (restantes < 1) {
      return rechazo(R.ULTIMO_ADMIN_PROTEGIDO, "ULTIMO_ADMIN_PROTEGIDO", base);
    }
  }

  // CAS: unica escritura sobre la membership destino. Nunca toca activo.
  const cas = await runQuery(
    db,
    `UPDATE usuario_empresas
     SET rol = ?, version = version + 1, actualizado_en = datetime('now')
     WHERE id = ? AND empresa_id = ? AND version = ?`,
    [rolNuevo, Number(destino.id), empresa, versionEsperada]
  );
  if (cas.changes !== 1) {
    return rechazo(R.VERSION_CONFLICT, "VERSION_CONFLICT", { ...base, usuarioLocalId, versionActual });
  }
  const versionNueva = versionEsperada + 1;

  // Lapida compartida rol_activo en la MISMA transaccion.
  const pendiente = await registrarPendienteRolActivo(db, destino, versionNueva);
  if (pendiente.accion === "INCONSISTENTE") {
    return rechazo(R.ESTADO_INCONSISTENTE, "LAPIDA_ASOCIACION_INCONSISTENTE", base);
  }
  const verificacion = await getQuery(
    db,
    "SELECT version_objetivo, estado FROM sync_pendiente WHERE membership_id = ? AND tipo_operacion = 'rol_activo'",
    [Number(destino.id)]
  );
  if (!verificacion || Number(verificacion.version_objetivo) !== versionNueva || verificacion.estado !== "pendiente") {
    return rechazo(R.FALLO_TRANSACCIONAL, "PENDIENTE_NO_VERIFICADO", base);
  }
  return {
    ok: true,
    resultado: R.CONFIRMADO,
    ...base,
    usuarioLocalId,
    rol: rolNuevo,
    rolAnterior: destino.rol,
    versionAnterior: versionEsperada,
    versionNueva,
    pendiente: { tipo: "rol_activo", versionObjetivo: versionNueva, estado: "pendiente", accion: pendiente.accion }
  };
}

async function cambiarRolMembershipCentralIdempotente({
  actorUsuarioId, actorMembershipId, empresaId, usuarioLocalId, rol, expectedVersion, idempotencyKey, controlDbPath
} = {}) {
  const actorId = enteroPositivo(actorUsuarioId);
  const actorMembership = enteroPositivo(actorMembershipId);
  const empresa = enteroPositivo(empresaId);
  const localId = enteroPositivo(usuarioLocalId);
  const versionEsperada = enteroNoNegativo(expectedVersion);
  const rolNuevo = rolCanonico(rol);
  const clave = normalizarIdempotencyKey(idempotencyKey);
  const conHttp = (resultado) => ({ ...resultado, durable: false, replay: false, resultadoHttp: HTTP_NO_DURABLE[resultado.resultado] || 500 });
  if (!actorId || !actorMembership || !empresa || !localId || versionEsperada === null) {
    return conHttp(rechazo(R.PARAMETROS_INVALIDOS, "PARAMETROS_INVALIDOS"));
  }
  if (!rolNuevo) {
    return conHttp(rechazo(R.PARAMETROS_INVALIDOS, "ROL_INVALIDO"));
  }
  if (!clave) {
    return conHttp(rechazo(R.PARAMETROS_INVALIDOS, "IDEMPOTENCY_KEY_INVALIDA"));
  }
  const base = { empresaId: empresa, usuarioLocalId: localId };

  const resultado = await ejecutarEnTransaccionControl(controlDbPath, base, async (db) => {
    if (!(await verificarEsquema(db)) || !(await verificarEsquemaIdempotencia(db))) {
      return { commit: false, resultado: rechazo(R.ESQUEMA_INCOMPATIBLE, "ESQUEMA_CONTROL_INCOMPATIBLE", base) };
    }

    // Destino resuelto en Control por (empresa, usuario_local_id) -- nunca un membership id del cliente.
    const destinoRow = await getQuery(
      db,
      "SELECT id FROM usuario_empresas WHERE empresa_id = ? AND usuario_local_id = ?",
      [empresa, localId]
    );
    const destinoId = destinoRow ? Number(destinoRow.id) : null;
    const huella = calcularHuellaRol({
      empresaId: empresa,
      actorCentralId: actorId,
      actorMembershipId: actorMembership,
      targetUsuarioLocalId: localId,
      targetMembershipId: destinoId,
      rol: rolNuevo,
      expectedVersion: versionEsperada
    });

    // Clave existente: replay SOLO ante coincidencia estricta de endpoint, actor, membership del actor
    // y huella; cualquier otra fila (estado, credenciales, otro actor/empresa/contenido) es REUSED.
    const existente = await getQuery(db, "SELECT * FROM operacion_idempotencia WHERE clave = ?", [clave]);
    if (existente) {
      if (existente.estado === "confirmada") {
        const coincide = existente.endpoint === ENDPOINT_LOGICO_ROL
          && Number(existente.usuario_id) === actorId
          && Number(existente.membership_id) === actorMembership
          && existente.solicitud_huella === huella;
        if (!coincide) {
          return { commit: false, resultado: rechazo(RESULTADOS_IDEMPOTENCIA.IDEMPOTENCY_KEY_REUSED, "IDEMPOTENCY_KEY_REUSED", base) };
        }
        const resultadoJson = JSON.parse(existente.resultado_json);
        const resultadoHttp = Number(existente.resultado_http);
        return {
          commit: false,
          resultado: {
            ok: resultadoHttp < 400,
            resultado: RESULTADO_POR_CODIGO_DURABLE[resultadoJson.code] || null,
            replay: true,
            durable: true,
            resultadoHttp,
            resultadoJson
          }
        };
      }
      return { commit: false, resultado: rechazo(RESULTADOS_IDEMPOTENCIA.IDEMPOTENCY_OPERATION_IN_PROGRESS, "IDEMPOTENCY_OPERATION_IN_PROGRESS", base) };
    }

    // R1-R5 compartidas; la clave se reserva recien cuando pasaron (400/403/404 nunca la consumen).
    const autoridad = await validarAutoridadYDestino(db, {
      actorId,
      empresa,
      destinoId,
      actorMembershipIdEsperada: actorMembership,
      alAutorizar: () => runQuery(
        db,
        `INSERT INTO operacion_idempotencia (clave, endpoint, usuario_id, membership_id, solicitud_huella, estado)
         VALUES (?, ?, ?, ?, ?, 'en_progreso')`,
        [clave, ENDPOINT_LOGICO_ROL, actorId, actorMembership, huella]
      )
    });
    if (!autoridad.ok) {
      return { commit: false, resultado: autoridad.resultado };
    }

    const r = await aplicarCambioRol(db, { empresa, destino: autoridad.destino, rolNuevo, versionEsperada });
    const durable = respuestaDurableRol(r);
    if (!durable) {
      // Rechazo no durable: ROLLBACK de la reserva y de cualquier escritura parcial.
      return { commit: false, resultado: r };
    }
    const confirmacion = await runQuery(
      db,
      `UPDATE operacion_idempotencia
       SET estado = 'confirmada', resultado_http = ?, resultado_json = ?, confirmada_en = datetime('now')
       WHERE clave = ? AND estado = 'en_progreso'`,
      [durable.http, JSON.stringify(durable.json), clave]
    );
    if (confirmacion.changes !== 1) {
      return { commit: false, resultado: rechazo(R.FALLO_TRANSACCIONAL, "IDEMPOTENCIA_NO_CONFIRMADA", base) };
    }
    return {
      commit: true,
      resultado: { ...r, replay: false, durable: true, resultadoHttp: durable.http, resultadoJson: durable.json }
    };
  });

  if (resultado.durable) {
    return resultado;
  }
  return conHttp(resultado);
}

module.exports = {
  ENDPOINT_LOGICO_ROL,
  ROLES_CANONICOS,
  calcularHuellaRol,
  cambiarRolMembershipCentralIdempotente
};
