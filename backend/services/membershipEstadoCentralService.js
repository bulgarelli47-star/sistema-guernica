// AUTH-SYNC-B2-S1a: writer CENTRAL-FIRST de estado (activo) de UNA membership. Una sola transaccion
// de Control DB (BEGIN IMMEDIATE) que valida autoridad ADMIN efectiva del actor, aplica CAS por
// usuario_empresas.version y crea/reabre la lapida sync_pendiente(membership, 'rol_activo') con
// version_objetivo = la generacion confirmada -- ambas escrituras en el MISMO COMMIT. Nunca toca la
// business DB: la proyeccion pertenece al consumer (database/process-rol-activo-outbox.js, S0b3a) y
// al worker de recuperacion (database/run-rol-activo-worker.js, S0b3b).
//
// Autoridad: todo se lee de Control DB DENTRO de la transaccion. El caller solo aporta
// identificadores (actor central, empresa, membership destino) y la intencion (activo,
// expected_version); nunca roles, nombres ni permisos declarados.
//
// Acceso efectivo (mismo criterio que backend/centralAuthResolver.js / centralAuthSecurity.js):
// empresas.activa = 1 AND usuario_empresas.activo = 1 AND usuarios.activo = 1. bloqueado_hasta es un
// bloqueo TEMPORAL por intentos fallidos, no una inhabilitacion -- no se usa para decidir autoridad.
//
// Limites: solo escribe usuario_empresas.activo/version/actualizado_en de la membership destino y la
// fila rol_activo de sync_pendiente. Nunca usuarios (activo global, password, version de identidad),
// nunca rol, nunca sesiones, nunca filas 'password' de sync_pendiente, nunca otras empresas.
//
// Idempotencia: expected_version (CAS) impide escrituras duplicadas o basadas en una generacion
// vieja, pero NO es un replay HTTP idempotente. El replay durable (respuesta perdida tras commit,
// reutilizacion de una Idempotency-Key con otro contenido) lo provee la variante
// cambiarEstadoMembershipCentralIdempotente (AUTH-SYNC-B2-S1b1), sobre el MISMO nucleo de reglas.
const crypto = require("crypto");
const fs = require("fs");
const sqlite3 = require("sqlite3");
const { DEFAULT_DB_PATH, closeDb, runQuery, getQuery, allQuery } = require("../../database/init-control-db");

const RESULTADOS_ESTADO_MEMBERSHIP = Object.freeze({
  CONFIRMADO: "CONFIRMADO",
  SIN_CAMBIOS: "SIN_CAMBIOS",
  NO_AUTORIZADO: "NO_AUTORIZADO",
  AUTOMODIFICACION: "AUTOMODIFICACION",
  ULTIMO_ADMIN_PROTEGIDO: "ULTIMO_ADMIN_PROTEGIDO",
  MEMBERSHIP_NO_ENCONTRADA: "MEMBERSHIP_NO_ENCONTRADA",
  EMPRESA_NO_DISPONIBLE: "EMPRESA_NO_DISPONIBLE",
  VERSION_CONFLICT: "VERSION_CONFLICT",
  ESQUEMA_INCOMPATIBLE: "ESQUEMA_INCOMPATIBLE",
  PARAMETROS_INVALIDOS: "PARAMETROS_INVALIDOS",
  ESTADO_INCONSISTENTE: "ESTADO_INCONSISTENTE",
  ERROR_TRANSITORIO: "ERROR_TRANSITORIO",
  FALLO_TRANSACCIONAL: "FALLO_TRANSACCIONAL"
});
const R = RESULTADOS_ESTADO_MEMBERSHIP;

const ROL_ADMIN = "admin";
const CODIGOS_SQLITE_TRANSITORIOS = new Set(["SQLITE_BUSY", "SQLITE_LOCKED"]);

function enteroPositivo(valor) {
  const n = typeof valor === "string" && valor.trim() !== "" ? Number(valor) : valor;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function enteroNoNegativo(valor) {
  const n = typeof valor === "string" && valor.trim() !== "" ? Number(valor) : valor;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function normalizarActivo(valor) {
  if (valor === true || valor === 1 || valor === "1") return 1;
  if (valor === false || valor === 0 || valor === "0") return 0;
  return null;
}

function rechazo(resultado, motivo, extra = {}) {
  return { ok: false, resultado, motivo, ...extra };
}

function esErrorTransitorio(error) {
  return Boolean(error && CODIGOS_SQLITE_TRANSITORIOS.has(error.code));
}

// OPEN_READWRITE sin OPEN_CREATE (nunca materializa un Control DB), foreign_keys activas y
// busy_timeout para que dos writers concurrentes se serialicen en BEGIN IMMEDIATE en vez de fallar.
function abrirControlDbEscritura(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (error) => {
      if (error) { reject(error); return; }
      db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;", (pragmaError) => {
        if (pragmaError) { db.close(() => reject(pragmaError)); return; }
        resolve(db);
      });
    });
  });
}

// Esquema minimo que este writer necesita: version en usuarios y usuario_empresas (S0) y
// sync_pendiente con las columnas de la lapida. Introspeccion pura, nunca migra.
async function verificarEsquema(db) {
  const columnas = async (tabla) => new Set((await allQuery(db, `PRAGMA table_info(${tabla})`)).map((c) => c.name));
  const usuarios = await columnas("usuarios");
  const memberships = await columnas("usuario_empresas");
  const empresas = await columnas("empresas");
  const pendientes = await columnas("sync_pendiente");
  const requeridas = [
    [usuarios, ["id", "activo", "version"]],
    [memberships, ["id", "usuario_id", "empresa_id", "usuario_local_id", "rol", "activo", "version", "actualizado_en"]],
    [empresas, ["id", "activa"]],
    [pendientes, ["usuario_id", "empresa_id", "membership_id", "usuario_local_id", "tipo_operacion", "version_objetivo", "estado", "procesado_en"]]
  ];
  return requeridas.every(([presentes, nombres]) => nombres.every((n) => presentes.has(n)));
}

// Administradores con acceso EFECTIVO en la empresa: membership admin activa + identidad global
// activa (la empresa ya se verifico activa). Se cuenta dentro de la transaccion del writer.
async function contarAdminsEfectivos(db, empresaId, { excluirMembershipId = null } = {}) {
  const fila = await getQuery(
    db,
    `SELECT COUNT(*) AS n
     FROM usuario_empresas ue
     JOIN usuarios u ON u.id = ue.usuario_id
     WHERE ue.empresa_id = ? AND ue.rol = ? AND ue.activo = 1 AND u.activo = 1
       AND (? IS NULL OR ue.id <> ?)`,
    [empresaId, ROL_ADMIN, excluirMembershipId, excluirMembershipId]
  );
  return Number(fila.n);
}

// Crea o reabre la lapida rol_activo de la membership con la generacion confirmada. Una fila
// existente con otra asociacion (identidad/empresa/usuario local) es una inconsistencia: se aborta.
async function registrarPendienteRolActivo(db, membership, versionObjetivo) {
  const reapertura = await runQuery(
    db,
    `UPDATE sync_pendiente
     SET version_objetivo = ?, estado = 'pendiente', procesado_en = NULL
     WHERE membership_id = ? AND tipo_operacion = 'rol_activo'
       AND usuario_id = ? AND empresa_id = ? AND usuario_local_id = ?`,
    [versionObjetivo, membership.id, membership.usuario_id, membership.empresa_id, membership.usuario_local_id]
  );
  if (reapertura.changes === 1) {
    return { accion: "REABIERTA" };
  }
  const existente = await getQuery(
    db,
    "SELECT id FROM sync_pendiente WHERE membership_id = ? AND tipo_operacion = 'rol_activo'",
    [membership.id]
  );
  if (existente) {
    return { accion: "INCONSISTENTE" };
  }
  await runQuery(
    db,
    `INSERT INTO sync_pendiente (usuario_id, empresa_id, membership_id, usuario_local_id, tipo_operacion, version_objetivo, estado)
     VALUES (?, ?, ?, ?, 'rol_activo', ?, 'pendiente')`,
    [membership.usuario_id, membership.empresa_id, membership.id, membership.usuario_local_id, versionObjetivo]
  );
  return { accion: "CREADA" };
}

// Reglas de autoridad y destino (esquema, R2, R1, R3, R4, R5) compartidas por los writers de estado
// (S1a/S1b1) y por el writer de rol (backend/services/membershipRolCentralService.js, S2a). Corre
// sobre una conexion YA dentro de una transaccion BEGIN IMMEDIATE abierta por el caller; solo lee.
// `actorMembershipIdEsperada` (opcional) exige que la membership del actor resuelta en Control sea
// exactamente la de su sesion. `alAutorizar` (opcional) corre una sola vez, dentro de la misma
// transaccion, cuando actor, empresa y destino ya fueron validados -- las variantes idempotentes
// reservan ahi su clave. Devuelve { ok: true, destino, actorMembership } o { ok: false, resultado }.
async function validarAutoridadYDestino(db, {
  actorId, empresa, destinoId, actorMembershipIdEsperada = null, alAutorizar = null
}) {
  const base = { membershipId: destinoId, empresaId: empresa };

  if (!(await verificarEsquema(db))) {
    return { ok: false, resultado: rechazo(R.ESQUEMA_INCOMPATIBLE, "ESQUEMA_CONTROL_INCOMPATIBLE", base) };
  }

  // R2: empresa existente y activa.
  const empresaRow = await getQuery(db, "SELECT id, activa FROM empresas WHERE id = ?", [empresa]);
  if (!empresaRow || Number(empresaRow.activa) !== 1) {
    return { ok: false, resultado: rechazo(R.EMPRESA_NO_DISPONIBLE, empresaRow ? "EMPRESA_INACTIVA" : "EMPRESA_INEXISTENTE", base) };
  }

  // R1: actor existente y globalmente activo.
  const actor = await getQuery(db, "SELECT id, activo FROM usuarios WHERE id = ?", [actorId]);
  if (!actor) {
    return { ok: false, resultado: rechazo(R.NO_AUTORIZADO, "ACTOR_INEXISTENTE", base) };
  }
  if (Number(actor.activo) !== 1) {
    return { ok: false, resultado: rechazo(R.NO_AUTORIZADO, "ACTOR_INACTIVO", base) };
  }

  // R3: membership del actor en ESTA empresa, activa y con rol admin.
  const actorMembership = await getQuery(
    db,
    "SELECT id, rol, activo FROM usuario_empresas WHERE usuario_id = ? AND empresa_id = ?",
    [actorId, empresa]
  );
  if (!actorMembership) {
    return { ok: false, resultado: rechazo(R.NO_AUTORIZADO, "ACTOR_SIN_MEMBERSHIP", base) };
  }
  if (actorMembershipIdEsperada !== null && Number(actorMembership.id) !== actorMembershipIdEsperada) {
    return { ok: false, resultado: rechazo(R.NO_AUTORIZADO, "ACTOR_MEMBERSHIP_NO_CORRESPONDE", base) };
  }
  if (Number(actorMembership.activo) !== 1) {
    return { ok: false, resultado: rechazo(R.NO_AUTORIZADO, "ACTOR_MEMBERSHIP_INACTIVA", base) };
  }
  if (actorMembership.rol !== ROL_ADMIN) {
    return { ok: false, resultado: rechazo(R.NO_AUTORIZADO, "ACTOR_NO_ADMIN", base) };
  }

  // R4: destino de ESTA empresa. Inexistente y ajena se informan igual (sin enumerar otras empresas).
  const destino = destinoId === null ? null : await getQuery(
    db,
    "SELECT id, usuario_id, empresa_id, usuario_local_id, rol, activo, version FROM usuario_empresas WHERE id = ?",
    [destinoId]
  );
  if (!destino || Number(destino.empresa_id) !== empresa) {
    return { ok: false, resultado: rechazo(R.MEMBERSHIP_NO_ENCONTRADA, "MEMBERSHIP_NO_ENCONTRADA", base) };
  }

  // R5: nunca sobre la propia identidad (ni la propia membership).
  if (Number(destino.usuario_id) === actorId || Number(destino.id) === Number(actorMembership.id)) {
    return { ok: false, resultado: rechazo(R.AUTOMODIFICACION, "AUTOMODIFICACION", base) };
  }

  if (alAutorizar) {
    await alAutorizar();
  }
  return { ok: true, destino, actorMembership };
}

// Nucleo compartido por el writer S1a y su variante idempotente S1b1: TODAS las reglas (R1-R7, R10 y
// la precondicion de version de S1a-R1) sobre una conexion YA dentro de una transaccion BEGIN
// IMMEDIATE abierta por el caller. Nunca ejecuta BEGIN/COMMIT/ROLLBACK: devuelve el resultado y si
// escribio, y el caller decide. R1-R5 (y `actorMembershipIdEsperada` / `alAutorizar`) se delegan en
// validarAutoridadYDestino, en el mismo orden y en el mismo punto que antes.
async function evaluarYAplicarCambioEstado(db, {
  actorId, empresa, destinoId, activoNuevo, versionEsperada, actorMembershipIdEsperada = null, alAutorizar = null
}) {
  const base = { membershipId: destinoId, empresaId: empresa };
  const sinEscritura = (resultado) => ({ escribio: false, resultado });

  const autoridad = await validarAutoridadYDestino(db, { actorId, empresa, destinoId, actorMembershipIdEsperada, alAutorizar });
  if (!autoridad.ok) {
    return sinEscritura(autoridad.resultado);
  }
  const { destino } = autoridad;

  // Precondicion de version ANTES de evaluar el no-op: un pedido basado en una generacion distinta
  // de la vigente es siempre conflicto, aunque el estado pedido ya coincida.
  const versionActual = Number(destino.version);
  const usuarioLocalId = Number(destino.usuario_local_id);
  if (versionActual !== versionEsperada) {
    return sinEscritura(rechazo(R.VERSION_CONFLICT, "VERSION_CONFLICT", { ...base, usuarioLocalId, versionActual }));
  }
  const activoActual = Number(destino.activo) === 1 ? 1 : 0;
  if (activoActual === activoNuevo) {
    return sinEscritura({ ok: true, resultado: R.SIN_CAMBIOS, ...base, usuarioLocalId, activo: activoActual, versionActual });
  }

  // R6: nunca dejar a la empresa sin administradores con acceso efectivo. Se cuenta DENTRO de la
  // transaccion, excluyendo al destino, despues de las validaciones de autoridad.
  if (activoNuevo === 0 && destino.rol === ROL_ADMIN) {
    const restantes = await contarAdminsEfectivos(db, empresa, { excluirMembershipId: destinoId });
    if (restantes < 1) {
      return sinEscritura(rechazo(R.ULTIMO_ADMIN_PROTEGIDO, "ULTIMO_ADMIN_PROTEGIDO", base));
    }
  }

  // R7 + CAS: unica escritura sobre la membership destino.
  const cas = await runQuery(
    db,
    `UPDATE usuario_empresas
     SET activo = ?, version = version + 1, actualizado_en = datetime('now')
     WHERE id = ? AND empresa_id = ? AND version = ?`,
    [activoNuevo, destinoId, empresa, versionEsperada]
  );
  if (cas.changes !== 1) {
    return sinEscritura(rechazo(R.VERSION_CONFLICT, "VERSION_CONFLICT", { ...base, usuarioLocalId, versionActual }));
  }
  const versionNueva = versionEsperada + 1;

  // R10: pendiente durable en la MISMA transaccion. Si algo falla de aca en adelante, el caller hace
  // ROLLBACK (escribio=false): el UPDATE de arriba nunca se confirma sin su lapida.
  const pendiente = await registrarPendienteRolActivo(db, destino, versionNueva);
  if (pendiente.accion === "INCONSISTENTE") {
    return sinEscritura(rechazo(R.ESTADO_INCONSISTENTE, "LAPIDA_ASOCIACION_INCONSISTENTE", base));
  }
  const verificacion = await getQuery(
    db,
    "SELECT version_objetivo, estado FROM sync_pendiente WHERE membership_id = ? AND tipo_operacion = 'rol_activo'",
    [destinoId]
  );
  if (!verificacion || Number(verificacion.version_objetivo) !== versionNueva || verificacion.estado !== "pendiente") {
    return sinEscritura(rechazo(R.FALLO_TRANSACCIONAL, "PENDIENTE_NO_VERIFICADO", base));
  }

  return {
    escribio: true,
    resultado: {
      ok: true,
      resultado: R.CONFIRMADO,
      ...base,
      usuarioLocalId,
      activo: activoNuevo,
      versionAnterior: versionEsperada,
      versionNueva,
      pendiente: { tipo: "rol_activo", versionObjetivo: versionNueva, estado: "pendiente", accion: pendiente.accion }
    }
  };
}

// Abre Control (sin crearlo), corre `cuerpo` dentro de UN BEGIN IMMEDIATE y hace COMMIT solo si el
// cuerpo lo pide; cualquier otro desenlace o excepcion es ROLLBACK integral.
async function ejecutarEnTransaccionControl(controlDbPath, base, cuerpo) {
  const dbPath = controlDbPath || DEFAULT_DB_PATH;
  if (!fs.existsSync(dbPath)) {
    return rechazo(R.ERROR_TRANSITORIO, "CONTROL_DB_AUSENTE", base);
  }
  let db;
  try {
    db = await abrirControlDbEscritura(dbPath);
  } catch (error) {
    return rechazo(R.ERROR_TRANSITORIO, "CONTROL_DB_INACCESIBLE", { ...base, codigo: error.code || null });
  }
  let transaccionAbierta = false;
  try {
    await runQuery(db, "BEGIN IMMEDIATE");
    transaccionAbierta = true;
    const { commit, resultado } = await cuerpo(db);
    await runQuery(db, commit ? "COMMIT" : "ROLLBACK");
    transaccionAbierta = false;
    return resultado;
  } catch (error) {
    let rollbackFallido = false;
    if (transaccionAbierta) {
      try { await runQuery(db, "ROLLBACK"); } catch (_) { rollbackFallido = true; }
      transaccionAbierta = false;
    }
    const transitorio = esErrorTransitorio(error);
    return rechazo(
      transitorio ? R.ERROR_TRANSITORIO : R.FALLO_TRANSACCIONAL,
      transitorio ? "CONTROL_DB_OCUPADA" : "FALLO_TRANSACCIONAL",
      { ...base, codigo: error.code || null, ...(rollbackFallido ? { rollbackFallido: true } : {}) }
    );
  } finally {
    await closeDb(db);
  }
}

async function cambiarEstadoMembershipCentral({
  actorUsuarioId, empresaId, membershipId, activo, expectedVersion, controlDbPath
} = {}) {
  const actorId = enteroPositivo(actorUsuarioId);
  const empresa = enteroPositivo(empresaId);
  const destinoId = enteroPositivo(membershipId);
  const activoNuevo = normalizarActivo(activo);
  const versionEsperada = enteroNoNegativo(expectedVersion);
  if (!actorId || !empresa || !destinoId || activoNuevo === null || versionEsperada === null) {
    return rechazo(R.PARAMETROS_INVALIDOS, "PARAMETROS_INVALIDOS");
  }
  const base = { membershipId: destinoId, empresaId: empresa };
  return ejecutarEnTransaccionControl(controlDbPath, base, async (db) => {
    const { escribio, resultado } = await evaluarYAplicarCambioEstado(db, { actorId, empresa, destinoId, activoNuevo, versionEsperada });
    return { commit: escribio, resultado };
  });
}

// ---------------------------------------------------------------------------------------------
// AUTH-SYNC-B2-S1b1: variante con Idempotency-Key DURABLE (operacion_idempotencia), para el futuro
// handler HTTP de PATCH /usuarios/:id/estado. Reserva de clave, cambio de membership, lapida
// rol_activo y respuesta HTTP definitiva se confirman en UN solo COMMIT de Control. La respuesta
// almacenada es INMUTABLE: nunca se reescribe despues del COMMIT (p.ej. con el resultado de una
// proyeccion) -- sincronizacion_tenant describe el estado conocido AL COMMIT.
const ENDPOINT_LOGICO_ESTADO = "/usuarios/:id/estado";
const IDEMPOTENCY_KEY_MAX = 128;

const RESULTADOS_IDEMPOTENCIA = Object.freeze({
  IDEMPOTENCY_KEY_REUSED: "IDEMPOTENCY_KEY_REUSED",
  IDEMPOTENCY_OPERATION_IN_PROGRESS: "IDEMPOTENCY_OPERATION_IN_PROGRESS"
});

// Status HTTP sugerido para resultados NO durables (rechazos que nunca consumen la clave); el
// handler de S1b2 decide el mapeo final.
const HTTP_NO_DURABLE = Object.freeze({
  [R.PARAMETROS_INVALIDOS]: 400,
  [R.NO_AUTORIZADO]: 403,
  [R.AUTOMODIFICACION]: 403,
  [R.EMPRESA_NO_DISPONIBLE]: 403,
  [R.MEMBERSHIP_NO_ENCONTRADA]: 404,
  [R.ULTIMO_ADMIN_PROTEGIDO]: 409,
  [RESULTADOS_IDEMPOTENCIA.IDEMPOTENCY_KEY_REUSED]: 409,
  [RESULTADOS_IDEMPOTENCIA.IDEMPOTENCY_OPERATION_IN_PROGRESS]: 409,
  [R.ESQUEMA_INCOMPATIBLE]: 503,
  [R.ERROR_TRANSITORIO]: 503,
  [R.FALLO_TRANSACCIONAL]: 503,
  [R.ESTADO_INCONSISTENTE]: 500
});

const RESULTADO_POR_CODIGO_DURABLE = Object.freeze({
  ESTADO_ACTUALIZADO: R.CONFIRMADO,
  SIN_CAMBIOS: R.SIN_CAMBIOS,
  VERSION_CONFLICT: R.VERSION_CONFLICT
});

// Mismo criterio de formato que P1B (server.js:validarIdempotencyKeyHeader): string no vacia tras
// trim, <= 128 caracteres, sin CR/LF.
function normalizarIdempotencyKey(valor) {
  if (typeof valor !== "string" || /[\r\n]/.test(valor)) return null;
  const clave = valor.trim();
  return clave && clave.length <= IDEMPOTENCY_KEY_MAX ? clave : null;
}

// Representacion canonica (orden de claves fijo) de la OPERACION, sin secretos. A diferencia de
// P1B, expected_version SI integra la huella: la envia el cliente y un reintento legitimo reenvia la
// misma; otra version con la misma clave es otro contenido.
function calcularHuellaEstado({ empresaId, actorCentralId, actorMembershipId, targetUsuarioLocalId, targetMembershipId, activo, expectedVersion }) {
  const payload = JSON.stringify({
    metodo: "PATCH",
    endpoint: ENDPOINT_LOGICO_ESTADO,
    empresaId: Number(empresaId),
    actorCentralId: Number(actorCentralId),
    actorMembershipId: Number(actorMembershipId),
    targetUsuarioLocalId: Number(targetUsuarioLocalId),
    targetMembershipId: targetMembershipId === null ? null : Number(targetMembershipId),
    activo: Number(activo),
    expectedVersion: Number(expectedVersion)
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

async function verificarEsquemaIdempotencia(db) {
  const columnas = new Set((await allQuery(db, "PRAGMA table_info(operacion_idempotencia)")).map((c) => c.name));
  return ["clave", "endpoint", "usuario_id", "membership_id", "solicitud_huella", "estado", "resultado_http", "resultado_json", "creado_en", "confirmada_en"]
    .every((n) => columnas.has(n));
}

// Respuesta HTTP definitiva de un resultado durable (CONFIRMADO / SIN_CAMBIOS / VERSION_CONFLICT),
// o null si el resultado no se almacena. Nunca incluye datos de identidad central ni secretos.
function respuestaDurable(r) {
  if (r.resultado === R.CONFIRMADO) {
    return {
      http: 200,
      json: {
        code: "ESTADO_ACTUALIZADO",
        message: r.activo === 1
          ? "Usuario activado en el control central. La sincronizacion con la sucursal quedo pendiente al confirmar."
          : "Usuario desactivado en el control central. La sincronizacion con la sucursal quedo pendiente al confirmar.",
        usuario_id: r.usuarioLocalId,
        activo: r.activo === 1,
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
        message: "El usuario ya tenia ese estado.",
        usuario_id: r.usuarioLocalId,
        activo: r.activo === 1,
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

async function cambiarEstadoMembershipCentralIdempotente({
  actorUsuarioId, actorMembershipId, empresaId, usuarioLocalId, activo, expectedVersion, idempotencyKey, controlDbPath
} = {}) {
  const actorId = enteroPositivo(actorUsuarioId);
  const actorMembership = enteroPositivo(actorMembershipId);
  const empresa = enteroPositivo(empresaId);
  const localId = enteroPositivo(usuarioLocalId);
  const activoNuevo = normalizarActivo(activo);
  const versionEsperada = enteroNoNegativo(expectedVersion);
  const clave = normalizarIdempotencyKey(idempotencyKey);
  const conHttp = (resultado) => ({ ...resultado, durable: false, replay: false, resultadoHttp: HTTP_NO_DURABLE[resultado.resultado] || 500 });
  if (!actorId || !actorMembership || !empresa || !localId || activoNuevo === null || versionEsperada === null) {
    return conHttp(rechazo(R.PARAMETROS_INVALIDOS, "PARAMETROS_INVALIDOS"));
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
    const huella = calcularHuellaEstado({
      empresaId: empresa,
      actorCentralId: actorId,
      actorMembershipId: actorMembership,
      targetUsuarioLocalId: localId,
      targetMembershipId: destinoId,
      activo: activoNuevo,
      expectedVersion: versionEsperada
    });

    // Clave existente: replay SOLO ante coincidencia estricta de endpoint, actor, membership del
    // actor y huella. Cualquier otra fila (otro actor, otra empresa, password P1, otro contenido)
    // jamas expone su resultado.
    const existente = await getQuery(db, "SELECT * FROM operacion_idempotencia WHERE clave = ?", [clave]);
    if (existente) {
      if (existente.estado === "confirmada") {
        const coincide = existente.endpoint === ENDPOINT_LOGICO_ESTADO
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
      // 'en_progreso' persistido es anomalo bajo este contrato (la reserva nunca sobrevive a su
      // transaccion): fail-closed, nunca se reejecuta ni se adjudica la operacion.
      return { commit: false, resultado: rechazo(RESULTADOS_IDEMPOTENCIA.IDEMPOTENCY_OPERATION_IN_PROGRESS, "IDEMPOTENCY_OPERATION_IN_PROGRESS", base) };
    }

    // Operacion nueva: mismo nucleo que S1a; la clave se reserva recien cuando actor, empresa y
    // destino quedaron validados (400/403/404 nunca consumen la clave).
    const { resultado: r } = await evaluarYAplicarCambioEstado(db, {
      actorId,
      empresa,
      destinoId,
      activoNuevo,
      versionEsperada,
      actorMembershipIdEsperada: actorMembership,
      alAutorizar: () => runQuery(
        db,
        `INSERT INTO operacion_idempotencia (clave, endpoint, usuario_id, membership_id, solicitud_huella, estado)
         VALUES (?, ?, ?, ?, ?, 'en_progreso')`,
        [clave, ENDPOINT_LOGICO_ESTADO, actorId, actorMembership, huella]
      )
    });
    const durable = respuestaDurable(r);
    if (!durable) {
      // Rechazo no durable: ROLLBACK de la reserva (si la hubo) y de cualquier escritura parcial.
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
  RESULTADOS_ESTADO_MEMBERSHIP,
  RESULTADOS_IDEMPOTENCIA,
  ENDPOINT_LOGICO_ESTADO,
  contarAdminsEfectivos,
  calcularHuellaEstado,
  cambiarEstadoMembershipCentral,
  cambiarEstadoMembershipCentralIdempotente,
  // AUTH-SYNC-B2-S2a: helpers internos compartidos EXCLUSIVAMENTE con el writer de rol
  // (backend/services/membershipRolCentralService.js). No son API publica de negocio.
  internosCompartidos: Object.freeze({
    ROL_ADMIN,
    HTTP_NO_DURABLE,
    validarAutoridadYDestino,
    ejecutarEnTransaccionControl,
    verificarEsquema,
    verificarEsquemaIdempotencia,
    normalizarIdempotencyKey,
    registrarPendienteRolActivo
  })
};
