// TX-1B: instrumentacion EXCLUSIVA DE TESTS para retener de forma determinista una transaccion del
// servidor (mecanismo validado en TX-D0). Se carga solo via `NODE_OPTIONS=--require <este archivo>`
// desde scripts/test-stock-flows.js en el proceso hijo de backend/server.js; jamas forma parte del
// runtime normal. Falla cerrado (throw al cargar) si:
// - TX_TEST_BARRIER_ENABLE !== "1" o TX_TEST_BARRIER_PORT no es un puerto valido;
// - GUERNICA_DB_PATH falta o apunta a database/guernica.db / database/atlas_control.db del repo;
// - ATLAS_CONTROL_DB_PATH apunta a database/atlas_control.db del repo.
// Capacidades (servidor de control solo en 127.0.0.1):
// - barrera de COMMIT: el primer COMMIT emitido tras /arm-commit-barrier queda retenido (la transaccion
//   de su operacion sigue abierta) hasta /release?mode=commit (COMMIT real) o mode=fail (error
//   inyectado sin ejecutar el COMMIT: decide el catch del handler de producto);
// - fuga simulada: tras /arm-leak, el primer COMMIT que una operacion duena entrega al coordinador queda
//   retenido y, con /release?mode=leak, se responde exito SIN ejecutarlo ni avisar al coordinador (la
//   puerta sigue tomada y la transaccion sqlite abierta);
// - registro de sentencias relevantes (sin parametros), de entradas/salidas al coordinador por operacion,
//   de eventos [TX_GATE] del observador del servidor y de 'finish'/'close' de las respuestas;
// - /wait?for=... long-poll sobre esas condiciones (sin sleeps en el test).
const http = require("http");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PROTEGIDAS = [
  path.resolve(ROOT, "database", "guernica.db"),
  path.resolve(ROOT, "database", "atlas_control.db")
].map((p) => p.toLowerCase());

function fallar(motivo) {
  throw new Error(`[TX_TEST_BARRIER] configuracion invalida: ${motivo}`);
}

if (process.env.TX_TEST_BARRIER_ENABLE !== "1") fallar("TX_TEST_BARRIER_ENABLE debe ser \"1\"");
const PUERTO = Number(process.env.TX_TEST_BARRIER_PORT);
if (!Number.isInteger(PUERTO) || PUERTO < 1024 || PUERTO > 65535) fallar("TX_TEST_BARRIER_PORT invalido");
const dbEnv = String(process.env.GUERNICA_DB_PATH || "").trim();
if (!dbEnv) fallar("GUERNICA_DB_PATH requerido");
if (PROTEGIDAS.includes(path.resolve(dbEnv).toLowerCase())) fallar("GUERNICA_DB_PATH apunta a una base protegida");
const controlEnv = String(process.env.ATLAS_CONTROL_DB_PATH || "").trim();
if (controlEnv && PROTEGIDAS.includes(path.resolve(controlEnv).toLowerCase())) fallar("ATLAS_CONTROL_DB_PATH apunta a una base protegida");

const sqlite3 = require(path.join(ROOT, "node_modules", "sqlite3"));
const coordinador = require(path.join(ROOT, "backend", "tenantWriteCoordinator.js"));

const estado = {
  sentencias: [],
  coordinador: [],
  eventos: [],
  respuestas: [],
  consola: [],
  barrera: { armada: false, retenido: null, opRetenida: null },
  fuga: { armada: false, retenido: null, opRetenida: null },
  enVuelo: new Map(),
  operaciones: new Map(),
  ultimaConexion: null
};
let secuencia = 0;
const esperas = [];

function opActualId() {
  const op = coordinador.obtenerOperacionActual();
  if (op) estado.operaciones.set(op.id, op);
  return op ? op.id : null;
}

function revisarEsperas() {
  for (let i = esperas.length - 1; i >= 0; i--) {
    if (esperas[i].condicion()) {
      const espera = esperas.splice(i, 1)[0];
      clearTimeout(espera.timer);
      espera.responder(true);
    }
  }
}

function etiqueta(sql) {
  const s = String(sql || "").replace(/\s+/g, " ").trim();
  const m = s.match(/^(BEGIN|COMMIT|ROLLBACK)\b/i);
  if (m) return m[1].toUpperCase();
  const insert = s.match(/^INSERT INTO (\w+)/i);
  if (insert) return `INSERT ${insert[1]}`;
  const update = s.match(/^UPDATE (\w+)/i);
  if (update) return `UPDATE ${update[1]}`;
  return null;
}

// --- driver: barrera de COMMIT + registro de sentencias (sin parametros) ---
const runOriginal = sqlite3.Database.prototype.run;
sqlite3.Database.prototype.run = function (sql, ...resto) {
  estado.ultimaConexion = this;
  const indiceCb = resto.findIndex((a) => typeof a === "function");
  const cb = indiceCb >= 0 ? resto[indiceCb] : null;
  const nombre = etiqueta(sql);
  const op = opActualId();
  if (estado.barrera.armada && nombre === "COMMIT" && cb) {
    estado.barrera.armada = false;
    estado.barrera.retenido = { self: this, sql, resto, cb, indiceCb, op };
    estado.barrera.opRetenida = op;
    estado.sentencias.push({ n: ++secuencia, op, sentencia: "COMMIT", resultado: "RETENIDO" });
    revisarEsperas();
    return this;
  }
  if (!nombre || !cb) return runOriginal.call(this, sql, ...resto);
  const nuevos = resto.slice();
  nuevos[indiceCb] = function (error) {
    estado.sentencias.push({ n: ++secuencia, op, sentencia: nombre, resultado: error ? `ERROR ${error.code}: ${error.message}` : "OK" });
    revisarEsperas();
    return cb.apply(this, arguments);
  };
  return runOriginal.call(this, sql, ...nuevos);
};

function liberarBarrera(modo) {
  const r = estado.barrera.retenido;
  estado.barrera.retenido = null;
  if (!r) return false;
  if (modo === "commit") {
    const nuevos = r.resto.slice();
    nuevos[r.indiceCb] = function (error) {
      estado.sentencias.push({ n: ++secuencia, op: r.op, sentencia: "COMMIT", resultado: error ? `ERROR ${error.code}: ${error.message}` : "OK" });
      revisarEsperas();
      return r.cb.apply(this, arguments);
    };
    runOriginal.call(r.self, r.sql, ...nuevos);
  } else {
    estado.sentencias.push({ n: ++secuencia, op: r.op, sentencia: "COMMIT", resultado: "FALLA_INYECTADA" });
    const error = new Error("TX_TEST_BARRIER_FALLA_INYECTADA");
    error.code = "TX_TEST_BARRIER_INJECTED";
    setImmediate(() => r.cb.call(r.self, error));
  }
  return true;
}

// --- coordinador: seguimiento por operacion + fuga simulada ---
const coordinarOriginal = coordinador.coordinarSentencia;
coordinador.coordinarSentencia = function (db, sql, thunk, opciones) {
  const op = coordinador.obtenerOperacionActual();
  const opId = op ? op.id : null;
  if (op) estado.operaciones.set(op.id, op);
  if (estado.fuga.armada && op && op.ownedGates.size > 0 && coordinador.clasificarSentencia(sql) === "COMMIT") {
    estado.fuga.armada = false;
    estado.fuga.opRetenida = opId;
    estado.coordinador.push({ n: ++secuencia, op: opId, evento: "FUGA_RETENIDA" });
    return new Promise((resolve) => {
      estado.fuga.retenido = () => {
        estado.coordinador.push({ n: ++secuencia, op: opId, evento: "FUGA_SIMULADA_COMMIT_NO_EJECUTADO" });
        resolve({ lastID: 0, changes: 0 });
      };
      revisarEsperas();
    });
  }
  if (opId) estado.enVuelo.set(opId, (estado.enVuelo.get(opId) || 0) + 1);
  revisarEsperas();
  const salir = () => {
    if (opId) {
      const n = (estado.enVuelo.get(opId) || 1) - 1;
      if (n <= 0) estado.enVuelo.delete(opId); else estado.enVuelo.set(opId, n);
    }
    revisarEsperas();
  };
  const resultado = coordinarOriginal.call(this, db, sql, thunk, opciones);
  resultado.then(salir, salir);
  return resultado;
};

// --- eventos del observador del servidor ([TX_GATE] por console.warn/error) ---
for (const nivel of ["warn", "error"]) {
  const original = console[nivel].bind(console);
  console[nivel] = (...args) => {
    const linea = args.map(String).join(" ");
    if (linea.includes("[TX_GATE]")) {
      const json = linea.slice(linea.indexOf("{"));
      let evento = null;
      try { evento = JSON.parse(json); } catch { evento = { evento: "TX_GATE_TEXTO", texto: linea.slice(0, 120) }; }
      estado.eventos.push({ ...evento, t: Date.now() });
      revisarEsperas();
    }
    if (/ERR_HTTP_HEADERS_SENT|Cannot set headers after they are sent/.test(linea)) {
      estado.consola.push({ t: Date.now(), tipo: "HEADERS_SENT" });
      revisarEsperas();
    }
    return original(...args);
  };
}

// --- ciclo de respuesta: 'finish' / 'close' por ruta ---
const emitOriginal = http.ServerResponse.prototype.emit;
http.ServerResponse.prototype.emit = function (nombre, ...resto) {
  if ((nombre === "finish" || nombre === "close") && this.req && this.req.socket && this.req.socket.localPort !== PUERTO) {
    estado.respuestas.push({ t: Date.now(), evento: nombre, metodo: this.req.method, ruta: String(this.req.originalUrl || this.req.url || "").split("?")[0] });
    revisarEsperas();
  }
  return emitOriginal.call(this, nombre, ...resto);
};

function condicionPara(para, params) {
  if (para === "held") return () => Boolean(estado.barrera.retenido);
  if (para === "leak-held") return () => Boolean(estado.fuga.retenido);
  if (para === "foreign-waiter") {
    const duena = () => estado.barrera.opRetenida || estado.fuga.opRetenida;
    return () => Array.from(estado.enVuelo.keys()).some((id) => id !== duena());
  }
  if (para === "event") return () => estado.eventos.some((e) => e.evento === params.get("name"));
  if (para === "response") {
    return () => estado.respuestas.some((r) => r.evento === params.get("name") && r.ruta === params.get("path") && (!params.get("method") || r.metodo === params.get("method")));
  }
  if (para === "statement") {
    return () => estado.sentencias.some((s) => s.sentencia === params.get("name") && (!params.get("result") || s.resultado === params.get("result")));
  }
  return null;
}

function resumenEstado() {
  const op = (id) => estado.operaciones.get(id);
  return {
    sentencias: estado.sentencias,
    coordinador: estado.coordinador,
    eventos: estado.eventos,
    respuestas: estado.respuestas,
    consola: estado.consola,
    opRetenida: estado.barrera.opRetenida,
    opFuga: estado.fuga.opRetenida,
    retenido: Boolean(estado.barrera.retenido),
    enVuelo: Object.fromEntries(estado.enVuelo),
    ownedGates: Object.fromEntries(Array.from(estado.operaciones.keys()).map((id) => [id, op(id).ownedGates.size])),
    puerta: estado.ultimaConexion ? coordinador.diagnosticoPuerta(estado.ultimaConexion) : null
  };
}

const control = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const responder = (cuerpo) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(cuerpo));
  };
  const accion = url.pathname;
  if (accion === "/arm-commit-barrier") { estado.barrera.armada = true; return responder({ ok: true }); }
  if (accion === "/arm-leak") { estado.fuga.armada = true; return responder({ ok: true }); }
  if (accion === "/release") {
    const modo = url.searchParams.get("mode");
    if (modo === "leak") {
      const r = estado.fuga.retenido;
      estado.fuga.retenido = null;
      if (r) r();
      return responder({ ok: Boolean(r) });
    }
    return responder({ ok: liberarBarrera(modo) });
  }
  if (accion === "/state") return responder(resumenEstado());
  if (accion === "/wait") {
    const condicion = condicionPara(url.searchParams.get("for"), url.searchParams);
    if (!condicion) return responder({ ok: false, error: "condicion desconocida" });
    if (condicion()) return responder({ ok: true });
    const espera = { condicion, responder: (ok) => responder({ ok }) };
    espera.timer = setTimeout(() => {
      const i = esperas.indexOf(espera);
      if (i !== -1) esperas.splice(i, 1);
      responder({ ok: false, error: "timeout de espera de control" });
    }, Number(url.searchParams.get("timeoutMs")) || 20000);
    esperas.push(espera);
    return undefined;
  }
  res.statusCode = 404;
  return res.end();
});
control.on("error", (error) => {
  console.error(`[TX_TEST_BARRIER] control no disponible: ${error.code}`);
  process.exit(96);
});
control.listen(PUERTO, "127.0.0.1");
control.unref();
