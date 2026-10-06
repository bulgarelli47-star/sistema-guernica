// TX-1A: coordinador de escrituras del MISMO tenant (TX-SAME-TENANT, confirmado en TX-D0).
//
// Problema: backend/db.js usa UNA conexion sqlite por tenant (singleton legacy, o handle.db en multi,
// cacheado por canonicalPath en runtimeTenantRegistry). El estado transaccional pertenece a la
// CONEXION, no a la operacion logica: cualquier sentencia de otra request ejecutada entre el BEGIN y el
// COMMIT/ROLLBACK de una operacion queda dentro de esa transaccion ajena (absorbida o perdida).
//
// Solucion (TX-1-D0): una PUERTA por objeto conexion (WeakMap<Database, Gate>) + ownership por
// OPERACION async (AsyncLocalStorage). Reglas:
// - BEGIN exitoso: la operacion pasa a ser duena de la conexion hasta COMMIT exitoso o ROLLBACK.
// - Mientras la operacion duena tiene la transaccion abierta, SOLO ella usa la conexion; sus
//   sentencias pasan directo (reentrancia: nunca se encola detras de si misma).
// - Cualquier otra sentencia (escritura, lectura, BEGIN, o COMMIT/ROLLBACK de otra operacion) es una
//   seccion critica de UNA sentencia: espera FIFO, toma la puerta, se ejecuta, espera la resolucion
//   REAL del driver y recien entonces libera. Nunca puede ejecutarse dentro de una transaccion ajena.
// - Conexiones distintas tienen puertas distintas: tenants distintos jamas se esperan entre si.
//
// Este modulo NO ejecuta sql por su cuenta (salvo el ROLLBACK explicito de recuperarOperacion): el
// llamador entrega un thunk que invoca la operacion original del driver (run/get/all), de modo que
// lastID/changes/filas y errores llegan intactos. No conoce Express: el middleware es de TX-1B.
//
// CONTRATO SIN CONTEXTO: si no hay operacion activa (tests o scripts que usan backend/db.js
// directamente), coordinarSentencia es PASSTHROUGH puro -- ejecuta el thunk sin ninguna coordinacion,
// exactamente como hoy. No existe un owner "anonimo" compartido. TX-1B garantiza que toda request del
// servidor corra dentro de una operacion.
//
// REQUISITO PARA TX-1B (no implementado aca, documentado para congelar el contrato):
// - response 'finish' con la operacion todavia duena de una puerta = anomalia/leak: recuperar rapido.
// - response 'close' (posible abort del cliente con el handler aun procesando): gracia breve y luego
//   recuperar.
// - Regla: gracia de recuperacion < timeout normal de los waiters, para que la cola no falle entera
//   antes de que la recuperacion libere la puerta. Los valores concretos los define y prueba TX-1B.
const { AsyncLocalStorage } = require("async_hooks");

const CODIGO_TIMEOUT = "TENANT_WRITE_GATE_TIMEOUT";
const CODIGO_ARGUMENTO_INVALIDO = "TENANT_WRITE_COORDINATOR_INVALID_ARGUMENT";
// TX-1B-R1: una operacion cuya recuperacion ya fue solicitada no puede emitir ninguna sentencia nueva.
const CODIGO_OPERACION_RECUPERADA = "TENANT_WRITE_OPERATION_RECOVERED";

const CLASES_SQL = Object.freeze({
  BEGIN: "BEGIN",
  COMMIT: "COMMIT",
  ROLLBACK: "ROLLBACK",
  OTHER: "OTHER"
});

const MODOS_PUERTA = Object.freeze({
  LEASE: "lease",
  TX: "tx"
});

const almacenOperacion = new AsyncLocalStorage();
const puertas = new WeakMap();
// TX-1B-R1: operaciones revocadas (recuperacion solicitada). La operacion es inmutable, asi que la
// marca vive aca y no en el objeto.
const operacionesRevocadas = new WeakSet();
let secuenciaOperacion = 0;
let observador = () => {};

function crearError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// ===== Operacion =====

// La identidad es el `token` (comparado por referencia); `id` es solo para diagnostico. `ownedGates`
// es el unico estado mutable: las puertas cuya TRANSACCION posee hoy la operacion.
function crearOperacion(etiqueta) {
  secuenciaOperacion += 1;
  const sufijo = typeof etiqueta === "string" && etiqueta.trim() ? `:${etiqueta.trim().slice(0, 40)}` : "";
  return Object.freeze({
    token: Object.freeze({}),
    id: `op-${secuenciaOperacion}${sufijo}`,
    ownedGates: new Set()
  });
}

function esOperacionValida(operacion) {
  return operacion !== null
    && typeof operacion === "object"
    && Object.isFrozen(operacion)
    && operacion.token !== null
    && typeof operacion.token === "object"
    && typeof operacion.id === "string"
    && operacion.ownedGates instanceof Set;
}

function ejecutarEnOperacion(operacion, callback) {
  if (!esOperacionValida(operacion)) {
    throw crearError(CODIGO_ARGUMENTO_INVALIDO, "ejecutarEnOperacion: operacion invalida (usar crearOperacion)");
  }
  if (typeof callback !== "function") {
    throw crearError(CODIGO_ARGUMENTO_INVALIDO, "ejecutarEnOperacion: callback debe ser una funcion");
  }
  return almacenOperacion.run(operacion, callback);
}

function obtenerOperacionActual() {
  const operacion = almacenOperacion.getStore();
  return operacion === undefined ? null : operacion;
}

function mismaOperacion(a, b) {
  return Boolean(a && b && a.token === b.token);
}

// ===== Clasificacion SQL =====

// Contrato: se ignoran espacios/saltos de linea iniciales y comentarios SQL iniciales (`-- ...` hasta
// fin de linea y `/* ... */`). Se mira SOLO la primera palabra (y, para ROLLBACK, la segunda). No se
// parsea SQL completo.
// - BEGIN [DEFERRED|IMMEDIATE|EXCLUSIVE] [TRANSACTION] -> BEGIN
// - COMMIT [TRANSACTION] / END [TRANSACTION]           -> COMMIT
// - ROLLBACK [TRANSACTION]                             -> ROLLBACK
// - ROLLBACK [TRANSACTION] TO ...                      -> OTHER (rollback a savepoint: la tx sigue)
// - cualquier otra cosa (incl. SAVEPOINT/RELEASE)      -> OTHER
function quitarPrefijoIgnorable(sql) {
  let texto = sql;
  for (;;) {
    const sinEspacio = texto.replace(/^\s+/, "");
    if (sinEspacio.startsWith("--")) {
      const fin = sinEspacio.indexOf("\n");
      texto = fin === -1 ? "" : sinEspacio.slice(fin + 1);
      continue;
    }
    if (sinEspacio.startsWith("/*")) {
      const fin = sinEspacio.indexOf("*/", 2);
      texto = fin === -1 ? "" : sinEspacio.slice(fin + 2);
      continue;
    }
    return sinEspacio;
  }
}

function clasificarSentencia(sql) {
  if (typeof sql !== "string") {
    throw crearError(CODIGO_ARGUMENTO_INVALIDO, "clasificarSentencia: sql debe ser string");
  }
  const palabras = quitarPrefijoIgnorable(sql)
    .toUpperCase()
    .split(/[\s;]+/)
    .filter(Boolean);
  const primera = palabras[0] || "";
  if (primera === "BEGIN") return CLASES_SQL.BEGIN;
  if (primera === "COMMIT" || primera === "END") return CLASES_SQL.COMMIT;
  if (primera === "ROLLBACK") {
    const resto = palabras.slice(1).filter((p) => p !== "TRANSACTION");
    return resto[0] === "TO" ? CLASES_SQL.OTHER : CLASES_SQL.ROLLBACK;
  }
  return CLASES_SQL.OTHER;
}

// ===== Puerta =====

// TX-1B-R1 -- INVARIANTE: una puerta NUNCA cambia de owner mientras una sentencia (thunk) del owner
// actual sigue en vuelo. `enVuelo` cuenta los thunks despachados y no resueltos; `liberacionPendiente`
// difiere la transferencia hasta que aterricen; `recuperacion` es una recuperacion solicitada mientras
// habia sentencias en vuelo (se resuelve al aterrizar: si la duena ya cerro su transaccion, no hay
// ROLLBACK tardio; si sigue abierta, ROLLBACK real y recien despues transferencia).
function obtenerPuerta(db) {
  if (db === null || typeof db !== "object") {
    throw crearError(CODIGO_ARGUMENTO_INVALIDO, "coordinarSentencia: db debe ser un objeto conexion");
  }
  let puerta = puertas.get(db);
  if (!puerta) {
    puerta = { db, owner: null, modo: null, cola: [], enVuelo: 0, liberacionPendiente: false, recuperacion: null };
    puertas.set(db, puerta);
  }
  return puerta;
}

// Libera la puerta, o difiere la liberacion si hay sentencias en vuelo / una recuperacion pendiente. Al
// diferir, el modo deja de ser TX (la transaccion ya se cerro) para que ni siquiera la duena pase directo.
function liberarPuerta(puerta) {
  if (puerta.enVuelo > 0 || puerta.recuperacion) {
    puerta.liberacionPendiente = true;
    puerta.modo = MODOS_PUERTA.LEASE;
    return;
  }
  transferirPuerta(puerta);
}

// Otorga la puerta al siguiente waiter VALIDO (FIFO). Los waiters cancelados se descartan. La
// transicion waiting -> granted es sincronica, asi que un timer ya no puede rechazarlo despues.
function transferirPuerta(puerta) {
  puerta.owner = null;
  puerta.modo = null;
  puerta.liberacionPendiente = false;
  while (puerta.cola.length > 0) {
    const waiter = puerta.cola.shift();
    if (waiter.estado !== "waiting") continue;
    waiter.estado = "granted";
    if (waiter.timer) clearTimeout(waiter.timer);
    puerta.owner = waiter.operacion;
    puerta.modo = MODOS_PUERTA.LEASE;
    waiter.resolve();
    return;
  }
}

function cerrarTransaccion(puerta) {
  if (puerta.owner) puerta.owner.ownedGates.delete(puerta);
  liberarPuerta(puerta);
}

function adquirirPuerta(puerta, operacion, timeoutMs) {
  if (puerta.owner === null && puerta.cola.length === 0) {
    puerta.owner = operacion;
    puerta.modo = MODOS_PUERTA.LEASE;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = { operacion, estado: "waiting", resolve, reject, timer: null };
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      waiter.timer = setTimeout(() => {
        if (waiter.estado !== "waiting") return;
        waiter.estado = "timedout";
        const indice = puerta.cola.indexOf(waiter);
        if (indice !== -1) puerta.cola.splice(indice, 1);
        observador({
          evento: "TX_GATE_WAIT_TIMEOUT",
          waiter: operacion.id,
          owner: puerta.owner ? puerta.owner.id : null,
          modo: puerta.modo,
          timeoutMs
        });
        reject(crearError(CODIGO_TIMEOUT, `Tiempo de espera agotado para la conexion del tenant (${timeoutMs}ms)`));
      }, timeoutMs);
    }
    puerta.cola.push(waiter);
  });
}

// Ejecuta el thunk contabilizandolo como "en vuelo" y devuelve { ok, valor, error } sin lanzar. NO
// decrementa `enVuelo`: el llamador actualiza el estado transaccional y decrementa en el MISMO paso
// sincronico, de modo que ninguna recuperacion pueda intercalarse entre el aterrizaje real de la
// sentencia y la actualizacion del estado de la puerta.
async function ejecutarEnVuelo(puerta, thunk) {
  puerta.enVuelo += 1;
  try {
    return { ok: true, valor: await thunk() };
  } catch (error) {
    return { ok: false, error };
  }
}

// Al aterrizar la ultima sentencia en vuelo: primero la recuperacion pendiente (si la hay), si no la
// liberacion diferida. Nunca transfiere con sentencias en vuelo.
async function alAterrizar(puerta) {
  if (puerta.enVuelo > 0) return;
  if (puerta.recuperacion) {
    const recuperacion = puerta.recuperacion;
    await resolverRecuperacion(puerta, recuperacion);
    return;
  }
  if (puerta.liberacionPendiente) transferirPuerta(puerta);
}

function errorOperacionRecuperada(operacion) {
  return crearError(CODIGO_OPERACION_RECUPERADA, `La operacion ${operacion.id} fue recuperada: no puede emitir nuevas sentencias`);
}

async function ejecutarComoDuena(puerta, clase, thunk) {
  const r = await ejecutarEnVuelo(puerta, thunk);
  // Estado transaccional segun el resultado REAL, con la sentencia aun contabilizada en vuelo: la
  // liberacion queda diferida y la resuelve alAterrizar, que atiende primero una recuperacion pendiente.
  if (clase === CLASES_SQL.COMMIT && r.ok) cerrarTransaccion(puerta);
  else if (clase === CLASES_SQL.ROLLBACK) cerrarTransaccion(puerta);
  // OTHER, o BEGIN anidado: SQLite decide (un BEGIN anidado falla igual que hoy). Sin cambio de estado.
  puerta.enVuelo -= 1;
  await alAterrizar(puerta);
  if (r.ok) return r.valor;
  throw r.error;
}

// API principal. `thunk` debe invocar la operacion ORIGINAL del driver y devolver su resultado (o
// rechazar con su error). `opciones.timeoutMs` (opcional): espera maxima en cola; sin valor, no hay
// timeout (TX-1B define el default productivo). La operacion duena se captura AL ENTRAR, nunca dentro
// de un callback del driver.
async function coordinarSentencia(db, sql, thunk, opciones = {}) {
  if (typeof thunk !== "function") {
    throw crearError(CODIGO_ARGUMENTO_INVALIDO, "coordinarSentencia: thunk debe ser una funcion");
  }
  const operacion = obtenerOperacionActual();
  if (!operacion) return thunk();
  // TX-1B-R1: una operacion revocada jamas despacha SQL nueva (ni como duena ni encolandose).
  if (operacionesRevocadas.has(operacion)) throw errorOperacionRecuperada(operacion);

  const clase = clasificarSentencia(sql);
  const puerta = obtenerPuerta(db);

  if (puerta.modo === MODOS_PUERTA.TX && mismaOperacion(puerta.owner, operacion)) {
    return ejecutarComoDuena(puerta, clase, thunk);
  }

  await adquirirPuerta(puerta, operacion, opciones.timeoutMs);

  if (operacionesRevocadas.has(operacion)) {
    // Revocada mientras esperaba en cola: no ejecuta y cede la puerta.
    liberarPuerta(puerta);
    throw errorOperacionRecuperada(operacion);
  }

  if (clase === CLASES_SQL.BEGIN) {
    const r = await ejecutarEnVuelo(puerta, thunk);
    if (!r.ok) {
      puerta.enVuelo -= 1;
      liberarPuerta(puerta);
      throw r.error;
    }
    puerta.modo = MODOS_PUERTA.TX;
    operacion.ownedGates.add(puerta);
    puerta.enVuelo -= 1;
    if (operacionesRevocadas.has(operacion)) {
      // Revocada con su BEGIN en vuelo: la transaccion recien abierta se recupera antes de transferir.
      operacion.ownedGates.delete(puerta);
      puerta.recuperacion = { operacion, motivo: "revocada_durante_begin", diferida: true, resolvers: [] };
      await alAterrizar(puerta);
      throw errorOperacionRecuperada(operacion);
    }
    return r.valor;
  }

  const r = await ejecutarEnVuelo(puerta, thunk);
  puerta.enVuelo -= 1;
  liberarPuerta(puerta);
  if (r.ok) return r.valor;
  throw r.error;
}

// ===== Recuperacion =====

function rollbackCrudo(db) {
  return new Promise((resolve) => {
    try {
      db.run("ROLLBACK", [], (error) => resolve(error || null));
    } catch (error) {
      resolve(error);
    }
  });
}

// Resuelve una recuperacion cuando ya no hay sentencias en vuelo. Si la duena sigue con la transaccion
// abierta: ROLLBACK real (contabilizado en vuelo: nadie entra mientras tanto) y transferencia, aunque el
// ROLLBACK falle. Si la duena ya la cerro (COMMIT exitoso o ROLLBACK propio en vuelo), no hay ROLLBACK
// tardio: solo se completa la liberacion diferida.
async function resolverRecuperacion(puerta, recuperacion) {
  const { operacion } = recuperacion;
  const motivo = String(recuperacion.motivo).slice(0, 80);
  let resultado;
  if (puerta.modo === MODOS_PUERTA.TX && mismaOperacion(puerta.owner, operacion)) {
    puerta.enVuelo += 1;
    const error = await rollbackCrudo(puerta.db);
    puerta.enVuelo -= 1;
    operacion.ownedGates.delete(puerta);
    puerta.recuperacion = null;
    transferirPuerta(puerta);
    resultado = { recuperada: true, rollbackOk: error === null };
    observador({ evento: "TX_GATE_OPERATION_RECOVERED", operacion: operacion.id, motivo, rollbackOk: resultado.rollbackOk, diferida: recuperacion.diferida });
  } else {
    puerta.recuperacion = null;
    if (puerta.liberacionPendiente) transferirPuerta(puerta);
    resultado = { recuperada: false, motivo: "transaccion_cerrada_por_la_duena" };
    observador({ evento: "TX_GATE_OPERATION_RECOVERY_NOT_NEEDED", operacion: operacion.id, motivo });
  }
  recuperacion.resolvers.forEach((resolver) => resolver(resultado));
  return resultado;
}

// Revoca la operacion (no podra emitir SQL nueva) y, para cada puerta cuya TRANSACCION todavia posee:
// - sin sentencias en vuelo: ROLLBACK inmediato y liberacion (aunque el ROLLBACK falle);
// - con sentencias en vuelo: recuperacion PENDIENTE; la puerta sigue siendo de la operacion (la cola
//   espera) hasta que esas sentencias aterricen, y recien ahi se resuelve (ver resolverRecuperacion).
// Idempotente: una segunda llamada encuentra ownedGates vacio. Nunca toca una puerta que ya no pertenece
// a esta operacion (no puede afectar la transaccion de otro).
async function recuperarOperacion(operacion, motivo = "sin_motivo") {
  if (!esOperacionValida(operacion)) {
    throw crearError(CODIGO_ARGUMENTO_INVALIDO, "recuperarOperacion: operacion invalida");
  }
  operacionesRevocadas.add(operacion);
  const resultados = [];
  for (const puerta of Array.from(operacion.ownedGates)) {
    operacion.ownedGates.delete(puerta);
    if (puerta.modo !== MODOS_PUERTA.TX || !mismaOperacion(puerta.owner, operacion)) {
      resultados.push({ recuperada: false, motivo: "puerta_ya_no_pertenece" });
      continue;
    }
    const diferida = puerta.enVuelo > 0;
    if (!puerta.recuperacion) puerta.recuperacion = { operacion, motivo, diferida, resolvers: [] };
    const pendiente = new Promise((resolve) => puerta.recuperacion.resolvers.push(resolve));
    if (diferida) {
      observador({ evento: "TX_GATE_OPERATION_RECOVERY_DEFERRED", operacion: operacion.id, motivo: String(motivo).slice(0, 80), enVuelo: puerta.enVuelo });
    } else {
      alAterrizar(puerta);
    }
    const resultado = await pendiente;
    resultados.push(resultado.recuperada ? { recuperada: true, rollbackOk: resultado.rollbackOk } : resultado);
  }
  return resultados;
}

// ===== Observabilidad =====

// Solo identificadores y contadores: jamas SQL, parametros ni datos.
function diagnosticoPuerta(db) {
  const puerta = db && typeof db === "object" ? puertas.get(db) : undefined;
  if (!puerta) return { existe: false, owner: null, modo: null, enCola: 0, enVuelo: 0, recuperacionPendiente: false };
  return {
    existe: true,
    owner: puerta.owner ? puerta.owner.id : null,
    modo: puerta.modo,
    enCola: puerta.cola.filter((w) => w.estado === "waiting").length,
    enVuelo: puerta.enVuelo,
    recuperacionPendiente: Boolean(puerta.recuperacion)
  };
}

function configurarObservador(fn) {
  observador = typeof fn === "function" ? fn : () => {};
}

module.exports = {
  CODIGO_TIMEOUT,
  CODIGO_ARGUMENTO_INVALIDO,
  CODIGO_OPERACION_RECUPERADA,
  CLASES_SQL,
  MODOS_PUERTA,
  crearOperacion,
  ejecutarEnOperacion,
  obtenerOperacionActual,
  clasificarSentencia,
  coordinarSentencia,
  recuperarOperacion,
  diagnosticoPuerta,
  configurarObservador
};
