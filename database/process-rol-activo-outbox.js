// AUTH-SYNC-B2-S0b3a: consumer del outbox durable de rol/activo (CENTRAL -> TENANT). Toma un
// pendiente sync_pendiente(membership_id, 'rol_activo'), lo proyecta con la primitiva monotonica
// certificada en S0b2 (database/project-membership-rol-activo.js) y lo cierra por CAS en Control
// UNICAMENTE cuando la proyeccion de ESA generacion quedo aplicada y convergida.
//
// Semantica de sync_pendiente para rol_activo (misma forma que password, P1A):
//   - UNA fila por (membership_id, tipo_operacion) -- UNIQUE del esquema. La fila se REUTILIZA: el
//     writer central-first (fuera de este slice) reabre la misma fila con version_objetivo = nueva
//     usuario_empresas.version y estado 'pendiente', en la MISMA transaccion que cambia rol/activo.
//   - version_objetivo = la generacion de usuario_empresas.version que el writer dejo comprometida.
//   - La fila es ademas la lapida de autoridad central-first: existe para siempre, en cualquier
//     estado. Este consumer jamas la crea ni la borra; solo la transiciona pendiente -> procesado.
//
// Concurrencia y crashes: no existe transaccion distribuida entre Control y la business DB. El
// pendiente durable es el mecanismo de recuperacion -- un crash en cualquier punto deja la fila
// 'pendiente' y el reintento converge (la primitiva es idempotente y monotonica). Nunca se mantiene
// un lock de escritura en Control mientras se escribe la business DB: la lectura es una transaccion
// de solo lectura que termina antes de proyectar, y el cierre es UNA sentencia CAS autocontenida.
//
// Limites deliberados: nunca crea usuarios, memberships ni pendientes; nunca cambia rol/activo en
// Control; nunca toca password ni el consumer de password (process-central-outbox.js); nunca recibe
// rutas de business DB del caller (las resuelve la primitiva desde el registry central); sin
// scheduler ni HTTP -- invocacion explicita solamente.
const fs = require("fs");
const sqlite3 = require("sqlite3");
const { runQuery, getQuery, allQuery, closeDb, DEFAULT_DB_PATH } = require("./init-control-db");
const { abrirControlDbSoloLectura } = require("../backend/centralAuthResolver");
const { RESULTADOS_PROYECCION, proyectarRolActivoMembership } = require("./project-membership-rol-activo");

const RESULTADOS_OUTBOX_ROL_ACTIVO = Object.freeze({
  CERRADO: "CERRADO",
  YA_PROCESADO: "YA_PROCESADO",
  CERRADO_POR_OTRO_CONSUMIDOR: "CERRADO_POR_OTRO_CONSUMIDOR",
  REEMPLAZADO_POR_VERSION_POSTERIOR: "REEMPLAZADO_POR_VERSION_POSTERIOR",
  GENERACION_OBSOLETA: "GENERACION_OBSOLETA",
  ESTADO_INCONSISTENTE: "ESTADO_INCONSISTENTE",
  ERROR_TRANSITORIO: "ERROR_TRANSITORIO",
  NO_PROCESABLE: "NO_PROCESABLE"
});

// Motivos de NO_PROCESABLE de la primitiva que se resuelven reintentando, sin reparar datos: el
// recurso no estaba disponible (o el tenant requiere su migracion operativa). Cualquier otro motivo
// es terminal hasta que alguien investigue. En AMBOS casos el pendiente se conserva.
const MOTIVOS_PROYECCION_TRANSITORIOS = new Set([
  "CONTROL_DB_AUSENTE",
  "CONTROL_DB_INACCESIBLE",
  "CONTROL_DB_QUERY_ERROR",
  "BUSINESS_DB_AUSENTE",
  "BUSINESS_DB_INACCESIBLE",
  "ERROR_ESCRITURA_LOCAL",
  "ESCRITURA_NO_APLICADA",
  "ESQUEMA_TENANT_NO_CURRENT"
]);

const PROYECCIONES_CONVERGIDAS = new Set([
  RESULTADOS_PROYECCION.APLICADO,
  RESULTADOS_PROYECCION.REPARADO,
  RESULTADOS_PROYECCION.YA_CONVERGIDO
]);

function enteroPositivo(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function enteroNoNegativo(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function resultado(tipo, base, extra = {}) {
  return { resultado: tipo, cerrado: tipo === RESULTADOS_OUTBOX_ROL_ACTIVO.CERRADO, ...base, ...extra };
}

function abrirControlDbEscrituraExistente(dbPath) {
  return new Promise((resolve, reject) => {
    // OPEN_READWRITE sin OPEN_CREATE: jamas materializa un Control DB nuevo.
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (error) => {
      if (error) { reject(error); return; }
      resolve(db);
    });
  });
}

// Quinta copia deliberada del detector de esquema S0 (mismo criterio que las demas; ver
// database/reconcile-shadow-users.js). Puramente introspectivo.
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
    const columnasEsperadas = ["usuario_id", "empresa_id", "membership_id", "usuario_local_id", "tipo_operacion", "estado", "version_objetivo"];
    if (!columnasEsperadas.every((columna) => nombresSyncPendiente.has(columna))) {
      return { soportaS0: null, motivo: "SYNC_PENDIENTE_FORMA_INCOMPATIBLE" };
    }
    return { soportaS0: true };
  }
  return { soportaS0: null, motivo: "ESQUEMA_S0_PARCIAL" };
}

// Lectura coherente (una transaccion de SOLO LECTURA) del pendiente, su membership y su identidad
// central. Termina -- y libera Control -- antes de cualquier escritura en la business DB.
async function leerPendienteRolActivo({ membershipId, controlDbPath } = {}) {
  const dbPath = controlDbPath || DEFAULT_DB_PATH;
  if (!fs.existsSync(dbPath)) {
    return { ok: false, tipo: RESULTADOS_OUTBOX_ROL_ACTIVO.ERROR_TRANSITORIO, motivo: "CONTROL_DB_AUSENTE" };
  }
  let controlDb;
  try {
    controlDb = await abrirControlDbSoloLectura(dbPath);
  } catch (error) {
    return { ok: false, tipo: RESULTADOS_OUTBOX_ROL_ACTIVO.ERROR_TRANSITORIO, motivo: "CONTROL_DB_INACCESIBLE", error: error.message };
  }
  let transaccionAbierta = false;
  try {
    // Un CAS concurrente puede tomar el lock exclusivo durante su commit: el lector espera en vez de
    // fallar de inmediato.
    await runQuery(controlDb, "PRAGMA busy_timeout = 5000");
    await runQuery(controlDb, "BEGIN");
    transaccionAbierta = true;
    const deteccion = await detectarSoporteEsquemaS0(controlDb);
    if (deteccion.soportaS0 !== true) {
      return { ok: false, tipo: RESULTADOS_OUTBOX_ROL_ACTIVO.NO_PROCESABLE, motivo: "ESQUEMA_CONTROL_S0_INCOMPATIBLE", detalle: deteccion.motivo || "PRE_S0" };
    }
    const pendiente = await getQuery(
      controlDb,
      `SELECT id, usuario_id, empresa_id, membership_id, usuario_local_id, tipo_operacion, version_objetivo, estado
       FROM sync_pendiente WHERE membership_id = ? AND tipo_operacion = 'rol_activo'`,
      [membershipId]
    );
    const membership = await getQuery(
      controlDb,
      "SELECT id, usuario_id, empresa_id, usuario_local_id, version FROM usuario_empresas WHERE id = ?",
      [membershipId]
    );
    const central = membership
      ? await getQuery(controlDb, "SELECT id FROM usuarios WHERE id = ?", [membership.usuario_id])
      : null;
    await runQuery(controlDb, "COMMIT");
    transaccionAbierta = false;
    return { ok: true, pendiente: pendiente || null, membership: membership || null, centralExiste: Boolean(central) };
  } catch (error) {
    return { ok: false, tipo: RESULTADOS_OUTBOX_ROL_ACTIVO.ERROR_TRANSITORIO, motivo: "CONTROL_DB_QUERY_ERROR", error: error.message };
  } finally {
    if (transaccionAbierta) {
      try { await runQuery(controlDb, "ROLLBACK"); } catch (_) { /* conexion de solo lectura */ }
    }
    await closeDb(controlDb);
  }
}

// Validacion pura de la fila leida: forma, asociacion con la membership vigente y coherencia de
// generaciones. Devuelve null si el pendiente es procesable, o el resultado (sin escritura) si no.
function validarPendiente(lectura, { versionObjetivoEsperada, empresaIdEsperada }, base) {
  const { pendiente, membership } = lectura;
  if (!pendiente) {
    return resultado(RESULTADOS_OUTBOX_ROL_ACTIVO.NO_PROCESABLE, base, { motivo: "PENDIENTE_INEXISTENTE", clase: "TERMINAL" });
  }
  const vo = enteroNoNegativo(pendiente.version_objetivo);
  const forma = enteroPositivo(pendiente.usuario_id) && enteroPositivo(pendiente.empresa_id)
    && enteroPositivo(pendiente.usuario_local_id) && vo !== null
    && pendiente.tipo_operacion === "rol_activo"
    && (pendiente.estado === "pendiente" || pendiente.estado === "procesado");
  if (!forma) {
    return resultado(RESULTADOS_OUTBOX_ROL_ACTIVO.ESTADO_INCONSISTENTE, base, { motivo: "PENDIENTE_FORMA_INVALIDA", clase: "TERMINAL" });
  }
  const conVersion = { ...base, versionObjetivo: vo };
  if (empresaIdEsperada !== null && Number(pendiente.empresa_id) !== empresaIdEsperada) {
    return resultado(RESULTADOS_OUTBOX_ROL_ACTIVO.NO_PROCESABLE, conVersion, { motivo: "MEMBERSHIP_DE_OTRA_EMPRESA", clase: "TERMINAL" });
  }
  if (versionObjetivoEsperada !== null) {
    if (vo > versionObjetivoEsperada) {
      // Mensaje atrasado: la fila ya apunta a una generacion posterior. Nunca se procesa ni se cierra
      // la generacion vieja.
      return resultado(RESULTADOS_OUTBOX_ROL_ACTIVO.REEMPLAZADO_POR_VERSION_POSTERIOR, conVersion, { versionSolicitada: versionObjetivoEsperada, estadoPendiente: pendiente.estado });
    }
    if (vo < versionObjetivoEsperada) {
      return resultado(RESULTADOS_OUTBOX_ROL_ACTIVO.ESTADO_INCONSISTENTE, conVersion, { motivo: "VERSION_SOLICITADA_FUTURA", versionSolicitada: versionObjetivoEsperada, clase: "TERMINAL" });
    }
  }
  if (pendiente.estado === "procesado") {
    return resultado(RESULTADOS_OUTBOX_ROL_ACTIVO.YA_PROCESADO, conVersion);
  }
  if (!membership) {
    return resultado(RESULTADOS_OUTBOX_ROL_ACTIVO.ESTADO_INCONSISTENTE, conVersion, { motivo: "MEMBERSHIP_INEXISTENTE", clase: "TERMINAL" });
  }
  if (Number(membership.usuario_id) !== Number(pendiente.usuario_id)
    || Number(membership.empresa_id) !== Number(pendiente.empresa_id)
    || Number(membership.usuario_local_id) !== Number(pendiente.usuario_local_id)) {
    return resultado(RESULTADOS_OUTBOX_ROL_ACTIVO.ESTADO_INCONSISTENTE, conVersion, { motivo: "ASOCIACION_INCONSISTENTE", clase: "TERMINAL" });
  }
  if (!lectura.centralExiste) {
    return resultado(RESULTADOS_OUTBOX_ROL_ACTIVO.ESTADO_INCONSISTENTE, conVersion, { motivo: "IDENTIDAD_CENTRAL_INEXISTENTE", clase: "TERMINAL" });
  }
  const versionMembership = enteroNoNegativo(membership.version);
  if (versionMembership !== vo) {
    // El writer reabre la fila en la misma transaccion que cambia la membership: una diferencia
    // significa que una generacion de Control quedo sin pendiente (o un pendiente sin generacion).
    return resultado(RESULTADOS_OUTBOX_ROL_ACTIVO.ESTADO_INCONSISTENTE, conVersion, {
      motivo: versionMembership !== null && versionMembership > vo ? "GENERACION_CENTRAL_SIN_PENDIENTE" : "PENDIENTE_ADELANTADO_A_CONTROL",
      versionMembership,
      clase: "TERMINAL"
    });
  }
  return null;
}

// Releido fresco tras un intento sin cierre, para distinguir por que el pendiente no se cerro.
async function clasificarSinCierre({ membershipId, controlDbPath, pendienteLeido }, base) {
  const relectura = await leerPendienteRolActivo({ membershipId, controlDbPath });
  if (!relectura.ok) {
    return resultado(RESULTADOS_OUTBOX_ROL_ACTIVO.ERROR_TRANSITORIO, base, { motivo: relectura.motivo, fase: "CLASIFICACION" });
  }
  const { pendiente, membership } = relectura;
  const vo = Number(pendienteLeido.version_objetivo);
  if (!pendiente) {
    return resultado(RESULTADOS_OUTBOX_ROL_ACTIVO.ESTADO_INCONSISTENTE, base, { motivo: "LAPIDA_DESAPARECIDA", clase: "TERMINAL" });
  }
  const voActual = Number(pendiente.version_objetivo);
  if (voActual > vo) {
    return resultado(RESULTADOS_OUTBOX_ROL_ACTIVO.REEMPLAZADO_POR_VERSION_POSTERIOR, base, { versionObjetivoActual: voActual, estadoPendiente: pendiente.estado });
  }
  if (voActual === vo && pendiente.estado === "procesado") {
    return resultado(RESULTADOS_OUTBOX_ROL_ACTIVO.CERRADO_POR_OTRO_CONSUMIDOR, base);
  }
  const asociacionIgual = membership
    && Number(pendiente.usuario_id) === Number(pendienteLeido.usuario_id)
    && Number(pendiente.empresa_id) === Number(pendienteLeido.empresa_id)
    && Number(pendiente.usuario_local_id) === Number(pendienteLeido.usuario_local_id)
    && Number(membership.usuario_id) === Number(pendiente.usuario_id)
    && Number(membership.empresa_id) === Number(pendiente.empresa_id)
    && Number(membership.usuario_local_id) === Number(pendiente.usuario_local_id);
  if (!asociacionIgual) {
    return resultado(RESULTADOS_OUTBOX_ROL_ACTIVO.ESTADO_INCONSISTENTE, base, { motivo: membership ? "ASOCIACION_INCONSISTENTE" : "MEMBERSHIP_INEXISTENTE", clase: "TERMINAL" });
  }
  if (Number(membership.version) !== vo) {
    return resultado(RESULTADOS_OUTBOX_ROL_ACTIVO.ESTADO_INCONSISTENTE, base, { motivo: "GENERACION_CENTRAL_SIN_PENDIENTE", versionMembership: Number(membership.version), clase: "TERMINAL" });
  }
  return resultado(RESULTADOS_OUTBOX_ROL_ACTIVO.ESTADO_INCONSISTENTE, base, { motivo: "CIERRE_NO_CONFIRMADO", clase: "TERMINAL" });
}

// Cierre CAS: UNA sentencia condicional sobre la clave natural del contrato
// (membership_id + tipo_operacion + version_objetivo + estado='pendiente'), atada ademas a la
// identidad, la empresa y el usuario local leidos, y a que la membership siga en ESA generacion con
// esa misma asociacion. Ningun cierre cruzado ni de una generacion anterior puede cumplir el WHERE.
async function cerrarPendienteRolActivoCas({ controlDbPath, membershipId, versionObjetivo, usuarioId, empresaId, usuarioLocalId }) {
  const dbPath = controlDbPath || DEFAULT_DB_PATH;
  let controlDb;
  try {
    controlDb = await abrirControlDbEscrituraExistente(dbPath);
  } catch (error) {
    return { ok: false, transitorio: true, motivo: "CONTROL_DB_INACCESIBLE", error: error.message };
  }
  try {
    await runQuery(controlDb, "PRAGMA busy_timeout = 5000");
    const cierre = await runQuery(
      controlDb,
      `UPDATE sync_pendiente
       SET estado = 'procesado', procesado_en = datetime('now')
       WHERE membership_id = ? AND tipo_operacion = 'rol_activo' AND estado = 'pendiente' AND version_objetivo = ?
         AND usuario_id = ? AND empresa_id = ? AND usuario_local_id = ?
         AND EXISTS (
           SELECT 1 FROM usuario_empresas ue
           WHERE ue.id = sync_pendiente.membership_id AND ue.version = sync_pendiente.version_objetivo
             AND ue.usuario_id = sync_pendiente.usuario_id AND ue.empresa_id = sync_pendiente.empresa_id
             AND ue.usuario_local_id = sync_pendiente.usuario_local_id
         )`,
      [membershipId, versionObjetivo, usuarioId, empresaId, usuarioLocalId]
    );
    return { ok: true, changes: cierre.changes };
  } catch (error) {
    return { ok: false, transitorio: true, motivo: "CAS_ERROR", error: error.message };
  } finally {
    await closeDb(controlDb);
  }
}

// Operacion completa para UN pendiente. `versionObjetivo` (opcional) es la generacion que el caller
// espera procesar (p.ej. la que acaba de comprometer); `empresaIdEsperada` (opcional) ata el
// procesamiento al tenant del caller.
async function procesarPendienteRolActivo({ membershipId, versionObjetivo, empresaIdEsperada, controlDbPath } = {}) {
  const id = enteroPositivo(membershipId);
  const base = { membershipId: id };
  if (!id) {
    return resultado(RESULTADOS_OUTBOX_ROL_ACTIVO.NO_PROCESABLE, { membershipId: null }, { motivo: "MEMBERSHIP_ID_INVALIDO", clase: "TERMINAL" });
  }
  const voEsperada = versionObjetivo === undefined || versionObjetivo === null ? null : enteroNoNegativo(versionObjetivo);
  const empresaEsperada = empresaIdEsperada === undefined || empresaIdEsperada === null ? null : enteroPositivo(empresaIdEsperada);
  if ((versionObjetivo !== undefined && versionObjetivo !== null && voEsperada === null)
    || (empresaIdEsperada !== undefined && empresaIdEsperada !== null && empresaEsperada === null)) {
    return resultado(RESULTADOS_OUTBOX_ROL_ACTIVO.NO_PROCESABLE, base, { motivo: "PARAMETROS_INVALIDOS", clase: "TERMINAL" });
  }

  // 1) Lectura del pendiente (Control se libera al terminar).
  const lectura = await leerPendienteRolActivo({ membershipId: id, controlDbPath });
  if (!lectura.ok) {
    return resultado(lectura.tipo, base, { motivo: lectura.motivo, ...(lectura.detalle ? { detalle: lectura.detalle } : {}), clase: lectura.tipo === RESULTADOS_OUTBOX_ROL_ACTIVO.ERROR_TRANSITORIO ? "TRANSITORIO" : "TERMINAL" });
  }
  const rechazo = validarPendiente(lectura, { versionObjetivoEsperada: voEsperada, empresaIdEsperada: empresaEsperada }, base);
  if (rechazo) {
    return rechazo;
  }
  const { pendiente } = lectura;
  const vo = Number(pendiente.version_objetivo);
  const conVersion = { ...base, versionObjetivo: vo, empresaId: Number(pendiente.empresa_id), usuarioLocalId: Number(pendiente.usuario_local_id) };

  // 2) Proyeccion con la primitiva certificada, atada a la empresa del pendiente.
  const proyeccion = await proyectarRolActivoMembership({
    membershipId: id,
    controlDbPath,
    empresaIdEsperada: Number(pendiente.empresa_id)
  });
  if (proyeccion.resultado === RESULTADOS_PROYECCION.GENERACION_OBSOLETA) {
    return resultado(RESULTADOS_OUTBOX_ROL_ACTIVO.GENERACION_OBSOLETA, conVersion, { proyeccion, clase: "TERMINAL" });
  }
  if (proyeccion.resultado === RESULTADOS_PROYECCION.NO_PROCESABLE) {
    const transitorio = MOTIVOS_PROYECCION_TRANSITORIOS.has(proyeccion.motivo);
    return resultado(
      transitorio ? RESULTADOS_OUTBOX_ROL_ACTIVO.ERROR_TRANSITORIO : RESULTADOS_OUTBOX_ROL_ACTIVO.NO_PROCESABLE,
      conVersion,
      { motivo: proyeccion.motivo, proyeccion, clase: transitorio ? "TRANSITORIO" : "TERMINAL" }
    );
  }
  if (!PROYECCIONES_CONVERGIDAS.has(proyeccion.resultado)) {
    return resultado(RESULTADOS_OUTBOX_ROL_ACTIVO.ESTADO_INCONSISTENTE, conVersion, { motivo: "RESULTADO_PROYECCION_DESCONOCIDO", proyeccion, clase: "TERMINAL" });
  }

  // 3) Convergencia de ESTA generacion: la primitiva confirmo, dentro de su transaccion local
  // comprometida, que la fila local quedo en la generacion central leida con sus valores exactos.
  // Si Control avanzo mientras tanto (generacion leida por la primitiva != version_objetivo), esta
  // generacion ya no es la vigente: nunca se cierra con ella.
  const convergioEstaGeneracion = Number(proyeccion.versionCentral) === vo && Number(proyeccion.versionLocalDespues) === vo;
  if (!convergioEstaGeneracion) {
    const clasificado = await clasificarSinCierre({ membershipId: id, controlDbPath, pendienteLeido: pendiente }, conVersion);
    return { ...clasificado, proyeccion };
  }

  // 4) Cierre CAS.
  const cas = await cerrarPendienteRolActivoCas({
    controlDbPath,
    membershipId: id,
    versionObjetivo: vo,
    usuarioId: Number(pendiente.usuario_id),
    empresaId: Number(pendiente.empresa_id),
    usuarioLocalId: Number(pendiente.usuario_local_id)
  });
  if (!cas.ok) {
    return resultado(RESULTADOS_OUTBOX_ROL_ACTIVO.ERROR_TRANSITORIO, conVersion, { motivo: cas.motivo, error: cas.error, proyeccion, clase: "TRANSITORIO" });
  }
  if (cas.changes === 1) {
    return resultado(RESULTADOS_OUTBOX_ROL_ACTIVO.CERRADO, conVersion, { proyeccion });
  }
  // CAS sin filas: nunca se informa un cierre nuevo.
  const clasificado = await clasificarSinCierre({ membershipId: id, controlDbPath, pendienteLeido: pendiente }, conVersion);
  return { ...clasificado, proyeccion };
}

// Drenaje explicito (sin scheduler): procesa cada pendiente rol_activo 'pendiente'. Un fallo de una
// fila nunca impide procesar las demas.
async function drenarOutboxRolActivo({ controlDbPath, empresaIdEsperada } = {}) {
  const dbPath = controlDbPath || DEFAULT_DB_PATH;
  if (!fs.existsSync(dbPath)) {
    return { ok: false, errorCode: "CONTROL_DB_AUSENTE" };
  }
  let controlDb;
  try {
    controlDb = await abrirControlDbSoloLectura(dbPath);
  } catch (error) {
    return { ok: false, errorCode: "CONTROL_DB_INACCESIBLE", message: error.message };
  }
  let filas;
  try {
    await runQuery(controlDb, "PRAGMA busy_timeout = 5000");
    const deteccion = await detectarSoporteEsquemaS0(controlDb);
    if (deteccion.soportaS0 !== true) {
      return { ok: false, errorCode: "SCHEMA_S0_INCOMPATIBLE", detalle: deteccion.motivo || "PRE_S0" };
    }
    filas = await allQuery(
      controlDb,
      "SELECT membership_id, version_objetivo FROM sync_pendiente WHERE tipo_operacion = 'rol_activo' AND estado = 'pendiente' ORDER BY id ASC"
    );
  } catch (error) {
    return { ok: false, errorCode: "CONTROL_DB_QUERY_ERROR", message: error.message };
  } finally {
    await closeDb(controlDb);
  }

  const resultados = [];
  for (const fila of filas) {
    try {
      resultados.push(await procesarPendienteRolActivo({
        membershipId: Number(fila.membership_id),
        versionObjetivo: Number(fila.version_objetivo),
        empresaIdEsperada,
        controlDbPath: dbPath
      }));
    } catch (error) {
      resultados.push({ membershipId: Number(fila.membership_id), resultado: RESULTADOS_OUTBOX_ROL_ACTIVO.ERROR_TRANSITORIO, cerrado: false, motivo: "EXCEPCION", error: error.message, clase: "TRANSITORIO" });
    }
  }
  return { ok: true, total: filas.length, resultados };
}

module.exports = {
  RESULTADOS_OUTBOX_ROL_ACTIVO,
  MOTIVOS_PROYECCION_TRANSITORIOS,
  leerPendienteRolActivo,
  cerrarPendienteRolActivoCas,
  clasificarSinCierre,
  procesarPendienteRolActivo,
  drenarOutboxRolActivo
};
