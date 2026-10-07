// WORKER-OPS-1: runner operacional del outbox de PASSWORD (CENTRAL -> LOCAL). No contiene logica de
// password: cada ciclo invoca EXACTAMENTE drenarOutboxPassword() de database/process-central-outbox.js
// (backfill + procesamiento por fila + cierre CAS por version_objetivo), sin copia ni cambio de contrato.
// Solo procesa tipo_operacion='password'; el outbox rol_activo pertenece a database/run-rol-activo-worker.js.
//
// Configuracion: MISMA validacion estricta que el worker rol_activo (validarConfiguracionWorker): central
// + multi + shadow + ATLAS_CONTROL_DB_PATH absoluto y existente. Nunca cae a un default, nunca crea la
// Control DB, nunca acepta rutas de business DB (se resuelven desde Control dentro del consumer).
//
// WATCH: un ciclo, y el siguiente se programa recien cuando el anterior termino (setTimeout, nunca
// setInterval): no hay superposicion posible dentro de la instancia. Un error global (Control ausente o
// inaccesible, esquema S0 incompatible, excepcion del drenaje -- p.ej. SQLITE_BUSY del backfill frente a
// otro proceso) aplica backoff exponencial acotado; los resultados por fila (SKIP_*, ERROR,
// PENDING_GENERACION_MAS_NUEVA) dejan la fila pendiente en Control y se reintentan en el ciclo normal
// siguiente. SIGINT/SIGTERM: no se toma ciclo nuevo, el ciclo en curso termina completo y el proceso sale.
// Un reinicio no pierde nada: los pendientes son durables en Control.
//
// Logs: solo resumen operacional (contadores por resultado y codigos de error). Jamas hashes,
// mensajes de error del consumer, rutas, tokens ni secretos.
//
// CLI: node database/run-password-worker.js --once | --watch [--max-ciclos=N]
//   --once  : exit 0 = ciclo ejecutado (aunque haya filas que sigan pendientes); 1 = error operacional
//             global del drenaje; 2 = configuracion invalida (no se abre ninguna base).
//   --watch : vive hasta SIGINT/SIGTERM (exit 0) o falla de configuracion inicial (exit 2).
const { EventEmitter } = require("events");
const { drenarOutboxPassword } = require("./process-central-outbox");
const { validarConfiguracionWorker } = require("./run-rol-activo-worker");

const LIMITES = Object.freeze({
  intervaloMs: { min: 1000, max: 3600000, defecto: 30000 },
  backoffMaxMs: { min: 1000, max: 3600000, defecto: 300000 },
  maxCiclos: { min: 1, max: 1000000, defecto: null }
});

const SENALES = Object.freeze(["SIGINT", "SIGTERM"]);

function enteroEnRango(valor, { min, max, defecto }, nombre) {
  if (valor === undefined || valor === null || valor === "") return { ok: true, valor: defecto };
  const n = Number(valor);
  if (!Number.isInteger(n) || n < min || n > max) return { ok: false, motivo: `${nombre} fuera de rango [${min}, ${max}]` };
  return { ok: true, valor: n };
}

function validarConfiguracionPasswordWorker(entrada = {}) {
  const base = validarConfiguracionWorker({
    authMode: entrada.authMode,
    tenancyMode: entrada.tenancyMode,
    bridgeMode: entrada.bridgeMode,
    controlDbPath: entrada.controlDbPath,
    ...Object.fromEntries(["businessDbPath", "dbPath", "tenantDbPath", "rutaBusinessDb"].filter((k) => entrada[k] !== undefined).map((k) => [k, entrada[k]]))
  });
  if (!base.ok) return base;
  const config = {
    authMode: base.config.authMode,
    tenancyMode: base.config.tenancyMode,
    bridgeMode: base.config.bridgeMode,
    controlDbPath: base.config.controlDbPath
  };
  for (const clave of Object.keys(LIMITES)) {
    const r = enteroEnRango(entrada[clave], LIMITES[clave], clave);
    if (!r.ok) return { ok: false, errorCode: "CONFIG_FUERA_DE_RANGO", motivo: r.motivo };
    config[clave] = r.valor;
  }
  if (config.backoffMaxMs < config.intervaloMs) {
    return { ok: false, errorCode: "CONFIG_FUERA_DE_RANGO", motivo: "backoffMaxMs debe ser >= intervaloMs" };
  }
  return { ok: true, config };
}

function configuracionDesdeEntorno(env = process.env, extra = {}) {
  return {
    authMode: env.ATLAS_AUTH_MODE,
    tenancyMode: env.ATLAS_TENANCY_MODE,
    bridgeMode: env.ATLAS_USER_BRIDGE_MODE,
    controlDbPath: env.ATLAS_CONTROL_DB_PATH,
    intervaloMs: env.ATLAS_PASSWORD_WORKER_INTERVALO_MS,
    backoffMaxMs: env.ATLAS_PASSWORD_WORKER_BACKOFF_MAX_MS,
    ...extra
  };
}

// Resumen seguro de un drenaje: solo contadores por codigo de resultado (nunca mensajes ni datos).
function resumirDrenaje(ciclo, r, duracionMs) {
  if (!r || r.ok !== true) {
    return { ciclo, ok: false, errorCode: (r && r.errorCode) || "DRENAJE_SIN_RESULTADO", duracionMs };
  }
  const porResultado = {};
  for (const fila of r.resultados || []) {
    const codigo = typeof fila.resultado === "string" ? fila.resultado : "DESCONOCIDO";
    porResultado[codigo] = (porResultado[codigo] || 0) + 1;
  }
  return {
    ciclo,
    ok: true,
    evaluados: Number(r.total) || 0,
    procesados: porResultado.PROCESADO || 0,
    generacionMasNueva: porResultado.PENDING_GENERACION_MAS_NUEVA || 0,
    errores: porResultado.ERROR || 0,
    omitidos: Object.entries(porResultado).filter(([c]) => c.startsWith("SKIP_")).reduce((t, [, n]) => t + n, 0),
    porResultado,
    duracionMs
  };
}

function crearWorkerPassword(entrada = {}, dependencias = {}) {
  const validacion = validarConfiguracionPasswordWorker(entrada);
  if (!validacion.ok) return validacion;
  const config = validacion.config;
  const reloj = dependencias.reloj || (() => Date.now());
  const programar = dependencias.programar || ((fn, ms) => setTimeout(fn, ms));
  const cancelar = dependencias.cancelar || ((t) => clearTimeout(t));
  const drenar = dependencias.drenar || drenarOutboxPassword;
  const eventos = new EventEmitter();

  let numeroCiclo = 0;
  let cicloEnCurso = null;
  let detenido = false;
  let watchActivo = false;
  let temporizador = null;
  let fallasConsecutivas = 0;
  let resolverWatch = null;
  let senalesInstaladas = null;

  async function ejecutarCicloInterno() {
    numeroCiclo += 1;
    const ciclo = numeroCiclo;
    const inicio = reloj();
    let r;
    try {
      r = await drenar({ controlDbPath: config.controlDbPath });
    } catch (error) {
      return { ciclo, ok: false, excepcion: true, errorCode: (error && error.code) || "EXCEPCION_DRENAJE", duracionMs: reloj() - inicio };
    }
    return resumirDrenaje(ciclo, r, reloj() - inicio);
  }

  // Nunca dos ciclos superpuestos dentro de la instancia: un pedido concurrente se informa como omitido.
  async function ejecutarCiclo() {
    if (cicloEnCurso) return { omitido: true, motivo: "CICLO_EN_CURSO" };
    if (detenido) return { omitido: true, motivo: "WORKER_DETENIDO" };
    cicloEnCurso = ejecutarCicloInterno();
    try {
      const resumen = await cicloEnCurso;
      eventos.emit("ciclo", resumen);
      return resumen;
    } finally {
      cicloEnCurso = null;
    }
  }

  // Backoff solo ante falla GLOBAL; nunca por debajo del intervalo normal (>= 1s): sin busy-loop.
  function demoraSiguiente(resumen) {
    if (resumen && resumen.ok === true) {
      fallasConsecutivas = 0;
      return config.intervaloMs;
    }
    fallasConsecutivas += 1;
    return Math.min(config.intervaloMs * 2 ** fallasConsecutivas, config.backoffMaxMs);
  }

  function desinstalarSenales() {
    if (!senalesInstaladas) return;
    for (const [senal, manejador] of senalesInstaladas.manejadores) senalesInstaladas.emisor.removeListener(senal, manejador);
    senalesInstaladas = null;
  }

  function instalarSenales(emisor) {
    const manejadores = SENALES.map((senal) => {
      const manejador = () => { detener({ senal }); };
      emisor.once(senal, manejador);
      return [senal, manejador];
    });
    senalesInstaladas = { emisor, manejadores };
  }

  function iniciarWatch({ senales = process, instalarManejadores = true } = {}) {
    if (watchActivo) return Promise.reject(new Error("WATCH ya iniciado en esta instancia"));
    if (detenido) return Promise.reject(new Error("worker detenido"));
    watchActivo = true;
    if (instalarManejadores && senales) instalarSenales(senales);
    const terminado = new Promise((resolve) => { resolverWatch = resolve; });
    const vuelta = async () => {
      temporizador = null;
      if (detenido) return;
      let resumen;
      try {
        resumen = await ejecutarCiclo();
      } catch (error) {
        resumen = { ok: false, excepcion: true, errorCode: (error && error.code) || "EXCEPCION_CICLO" };
        eventos.emit("error-ciclo", resumen);
      }
      if (detenido) return;
      const demora = demoraSiguiente(resumen);
      eventos.emit("programado", { demoraMs: demora, fallasConsecutivas });
      temporizador = programar(vuelta, demora);
    };
    temporizador = programar(vuelta, 0);
    return terminado;
  }

  // Detencion ordenada: cancela el proximo ciclo, no toma ciclos nuevos y espera el ciclo en curso.
  async function detener({ senal = null } = {}) {
    detenido = true;
    if (temporizador !== null) {
      cancelar(temporizador);
      temporizador = null;
    }
    desinstalarSenales();
    if (cicloEnCurso) {
      try { await cicloEnCurso; } catch (_) { /* el ciclo ya informo su resultado */ }
    }
    const estado = { detenido: true, senal, ciclos: numeroCiclo };
    if (resolverWatch) {
      const resolver = resolverWatch;
      resolverWatch = null;
      watchActivo = false;
      resolver(estado);
    }
    eventos.emit("detenido", estado);
    return estado;
  }

  function estado() {
    return { detenido, watchActivo, cicloEnCurso: Boolean(cicloEnCurso), ciclos: numeroCiclo, fallasConsecutivas, senalesInstaladas: Boolean(senalesInstaladas) };
  }

  return { ok: true, config, eventos, ejecutarCiclo, iniciarWatch, detener, estado };
}

async function ejecutarWorkerPasswordOnce(entrada = {}, dependencias = {}) {
  const worker = crearWorkerPassword(entrada, dependencias);
  if (!worker.ok) return worker;
  try {
    const resumen = await worker.ejecutarCiclo();
    return { ok: true, modo: "ONCE", resumen };
  } finally {
    await worker.detener();
  }
}

function resumenLinea(r) {
  if (!r.ok) return `ciclo=${r.ciclo} ok=false errorCode=${r.errorCode} duracionMs=${r.duracionMs}`;
  return `ciclo=${r.ciclo} ok=true evaluados=${r.evaluados} procesados=${r.procesados} generacionMasNueva=${r.generacionMasNueva} omitidos=${r.omitidos} errores=${r.errores} duracionMs=${r.duracionMs}`;
}

async function runCli(argv = process.argv.slice(2), env = process.env) {
  const once = argv.includes("--once");
  const watch = argv.includes("--watch");
  if (once === watch) {
    console.error("ERROR: indicar exactamente uno de --once | --watch");
    return 2;
  }
  const maxArg = argv.find((a) => a.startsWith("--max-ciclos="));
  const entrada = configuracionDesdeEntorno(env, maxArg ? { maxCiclos: maxArg.split("=")[1] } : {});
  if (once) {
    const r = await ejecutarWorkerPasswordOnce(entrada);
    if (!r.ok) {
      console.error(`ERROR: [${r.errorCode}] ${r.motivo}`);
      return 2;
    }
    console.log(`password worker ONCE: ${resumenLinea(r.resumen)}`);
    return r.resumen.ok ? 0 : 1;
  }
  const worker = crearWorkerPassword(entrada);
  if (!worker.ok) {
    console.error(`ERROR: [${worker.errorCode}] ${worker.motivo}`);
    return 2;
  }
  console.log(`password worker WATCH iniciado: intervaloMs=${worker.config.intervaloMs} backoffMaxMs=${worker.config.backoffMaxMs}`);
  worker.eventos.on("ciclo", (r) => {
    (r.ok ? console.log : console.error)(`password worker WATCH: ${resumenLinea(r)}`);
    if (worker.config.maxCiclos !== null && r.ciclo >= worker.config.maxCiclos) worker.detener({ senal: "MAX_CICLOS" });
  });
  worker.eventos.on("programado", (p) => {
    if (p.fallasConsecutivas > 0) console.error(`password worker WATCH: backoff fallasConsecutivas=${p.fallasConsecutivas} proximoEnMs=${p.demoraMs}`);
  });
  worker.eventos.on("error-ciclo", (e) => console.error(`password worker WATCH: error de ciclo ${e.errorCode}`));
  const fin = await worker.iniciarWatch();
  console.log(`password worker WATCH detenido (${fin.senal || "sin senal"}) tras ${fin.ciclos} ciclos`);
  return 0;
}

module.exports = {
  LIMITES,
  validarConfiguracionPasswordWorker,
  configuracionDesdeEntorno,
  resumirDrenaje,
  crearWorkerPassword,
  ejecutarWorkerPasswordOnce,
  runCli
};

if (require.main === module) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}
