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

function obtenerPuerta(db) {
  if (db === null || typeof db !== "object") {
    throw crearError(CODIGO_ARGUMENTO_INVALIDO, "coordinarSentencia: db debe ser un objeto conexion");
  }
  let puerta = puertas.get(db);
  if (!puerta) {
    puerta = { db, owner: null, modo: null, cola: [] };
    puertas.set(db, puerta);
  }
  return puerta;
}

// Otorga la puerta al siguiente waiter VALIDO (FIFO). Los waiters cancelados se descartan. La
// transicion waiting -> granted es sincronica, asi que un timer ya no puede rechazarlo despues.
function liberarPuerta(puerta) {
  puerta.owner = null;
  puerta.modo = null;
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

async function ejecutarComoDuena(puerta, clase, thunk) {
  if (clase === CLASES_SQL.COMMIT) {
    const resultado = await thunk();
    cerrarTransaccion(puerta);
    return resultado;
  }
  if (clase === CLASES_SQL.ROLLBACK) {
    try {
      return await thunk();
    } finally {
      cerrarTransaccion(puerta);
    }
  }
  // OTHER, o BEGIN anidado: SQLite decide (un BEGIN anidado falla igual que hoy). Sin cambio de estado.
  return thunk();
}

// API principal. `thunk` debe invocar la operacion ORIGINAL del driver y devolver su resultado (o
// rechazar con su error). `opciones.timeoutMs` (opcional): espera maxima en cola; sin valor, no hay
// timeout (TX-1B define el default productivo).
async function coordinarSentencia(db, sql, thunk, opciones = {}) {
  if (typeof thunk !== "function") {
    throw crearError(CODIGO_ARGUMENTO_INVALIDO, "coordinarSentencia: thunk debe ser una funcion");
  }
  const operacion = obtenerOperacionActual();
  if (!operacion) return thunk();

  const clase = clasificarSentencia(sql);
  const puerta = obtenerPuerta(db);

  if (puerta.modo === MODOS_PUERTA.TX && mismaOperacion(puerta.owner, operacion)) {
    return ejecutarComoDuena(puerta, clase, thunk);
  }

  await adquirirPuerta(puerta, operacion, opciones.timeoutMs);

  if (clase === CLASES_SQL.BEGIN) {
    let resultado;
    try {
      resultado = await thunk();
    } catch (error) {
      liberarPuerta(puerta);
      throw error;
    }
    puerta.modo = MODOS_PUERTA.TX;
    operacion.ownedGates.add(puerta);
    return resultado;
  }

  try {
    return await thunk();
  } finally {
    liberarPuerta(puerta);
  }
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

// Para cada puerta cuya TRANSACCION todavia posee `operacion`: ROLLBACK sobre esa conexion y liberacion
// incondicional (aunque el ROLLBACK falle). Idempotente: una segunda llamada encuentra ownedGates vacio.
// Nunca toca una puerta que ya no pertenece a esta operacion (no puede afectar la transaccion de otro).
async function recuperarOperacion(operacion, motivo = "sin_motivo") {
  if (!esOperacionValida(operacion)) {
    throw crearError(CODIGO_ARGUMENTO_INVALIDO, "recuperarOperacion: operacion invalida");
  }
  const resultados = [];
  for (const puerta of Array.from(operacion.ownedGates)) {
    operacion.ownedGates.delete(puerta);
    if (puerta.modo !== MODOS_PUERTA.TX || !mismaOperacion(puerta.owner, operacion)) {
      resultados.push({ recuperada: false, motivo: "puerta_ya_no_pertenece" });
      continue;
    }
    const error = await rollbackCrudo(puerta.db);
    if (puerta.modo === MODOS_PUERTA.TX && mismaOperacion(puerta.owner, operacion)) {
      liberarPuerta(puerta);
    }
    const rollbackOk = error === null;
    resultados.push({ recuperada: true, rollbackOk });
    observador({
      evento: "TX_GATE_OPERATION_RECOVERED",
      operacion: operacion.id,
      motivo: String(motivo).slice(0, 80),
      rollbackOk
    });
  }
  return resultados;
}

// ===== Observabilidad =====

// Solo identificadores y contadores: jamas SQL, parametros ni datos.
function diagnosticoPuerta(db) {
  const puerta = db && typeof db === "object" ? puertas.get(db) : undefined;
  if (!puerta) return { existe: false, owner: null, modo: null, enCola: 0 };
  return {
    existe: true,
    owner: puerta.owner ? puerta.owner.id : null,
    modo: puerta.modo,
    enCola: puerta.cola.filter((w) => w.estado === "waiting").length
  };
}

function configurarObservador(fn) {
  observador = typeof fn === "function" ? fn : () => {};
}

module.exports = {
  CODIGO_TIMEOUT,
  CODIGO_ARGUMENTO_INVALIDO,
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
