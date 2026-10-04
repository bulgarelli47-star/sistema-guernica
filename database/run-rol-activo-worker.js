// AUTH-SYNC-B2-S0b3b: worker de recuperacion de pendientes rol_activo. Invoca el consumer certificado
// en S0b3a (database/process-rol-activo-outbox.js) en ciclos acotados -- ONCE (un ciclo y termina) o
// WATCH (ciclos periodicos nunca superpuestos, detencion ordenada por SIGINT/SIGTERM).
//
// Autoridad: el worker NUNCA escribe. Su unica I/O propia es una lectura de seleccion sobre Control
// (sync_pendiente tipo 'rol_activo' + estado 'pendiente'); la proyeccion, la verificacion y el cierre
// CAS pertenecen exclusivamente al consumer de S0b3a, que resuelve cada business DB desde el registry
// central. Por eso dos workers independientes nunca cierran dos veces la misma generacion (el CAS de
// S0b3a lo impide) y un reinicio no pierde nada: los pendientes viven en Control, y el estado en
// memoria del worker (cursor, backoff, cuarentena) solo administra equidad y ritmo, nunca seguridad.
//
// Politica por resultado del consumer:
//   CERRADO                                   -> cierre efectivo (contabilizado como tal).
//   YA_PROCESADO / CERRADO_POR_OTRO_CONSUMIDOR -> convergencia reconocida, sin adjudicarse el cierre.
//   REEMPLAZADO_POR_VERSION_POSTERIOR          -> se olvida la generacion vieja; la vigente se toma
//                                                en la siguiente pasada del cursor.
//   ERROR_TRANSITORIO (o clase TRANSITORIO)    -> pendiente intacto, backoff exponencial acotado por
//                                                (membership, version_objetivo).
//   ESTADO_INCONSISTENTE / NO_PROCESABLE terminal / GENERACION_OBSOLETA
//                                             -> pendiente intacto, cuarentena larga por
//                                                (membership, version_objetivo) -- sin tormenta de
//                                                reintentos; una generacion nueva sale de cuarentena.
//
// Deuda tecnica independiente (NO resuelta aca, S0b2 no se modifica): la lectura de Control de la
// primitiva S0b2 (leerSnapshotCentral) no fija busy_timeout; bajo contencion de escritura en Control
// puede devolver CONTROL_DB_QUERY_ERROR, que este worker trata como transitorio.
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { runQuery, allQuery, closeDb } = require("./init-control-db");
const { abrirControlDbSoloLectura } = require("../backend/centralAuthResolver");
const {
  RESULTADOS_OUTBOX_ROL_ACTIVO: R,
  procesarPendienteRolActivo
} = require("./process-rol-activo-outbox");

const LIMITES = Object.freeze({
  intervaloMs: { min: 1000, max: 3600000, defecto: 30000 },
  maxOperacionesPorCiclo: { min: 1, max: 500, defecto: 50 },
  backoffBaseMs: { min: 1000, max: 600000, defecto: 5000 },
  backoffMaxMs: { min: 1000, max: 3600000, defecto: 300000 },
  cuarentenaTerminalMs: { min: 60000, max: 86400000, defecto: 3600000 },
  maxCiclos: { min: 1, max: 1000000, defecto: null }
});

const SENALES = Object.freeze(["SIGINT", "SIGTERM"]);

function enteroEnRango(valor, { min, max, defecto }, nombre) {
  if (valor === undefined || valor === null || valor === "") {
    return { ok: true, valor: defecto };
  }
  const n = Number(valor);
  if (!Number.isInteger(n) || n < min || n > max) {
    return { ok: false, motivo: `${nombre} fuera de rango [${min}, ${max}]` };
  }
  return { ok: true, valor: n };
}

function normalizarModo(valor) {
  return String(valor === undefined || valor === null ? "" : valor).trim().toLowerCase();
}

// Configuracion EXPLICITA obligatoria: el worker solo opera con autoridad central + multi-tenant +
// bridge shadow (mismas combinaciones validas que backend/server.js) y con un Control DB indicado
// explicitamente y ya existente -- nunca cae a un default, nunca crea archivos, nunca acepta rutas de
// business DB. Cualquier otra cosa falla cerrado sin abrir ninguna base.
function validarConfiguracionWorker(entrada = {}) {
  const falla = (errorCode, motivo) => ({ ok: false, errorCode, motivo });
  const authMode = normalizarModo(entrada.authMode);
  const tenancyMode = normalizarModo(entrada.tenancyMode);
  const bridgeMode = normalizarModo(entrada.bridgeMode);
  if (authMode !== "central") {
    return falla("MODO_NO_CENTRAL", `authMode="${authMode || "(vacio)"}": el worker exige central (legacy no se procesa)`);
  }
  if (tenancyMode !== "multi") {
    return falla("MODO_NO_MULTI", `tenancyMode="${tenancyMode || "(vacio)"}": el worker exige multi (single no se procesa)`);
  }
  if (bridgeMode !== "shadow") {
    return falla("BRIDGE_NO_SHADOW", `bridgeMode="${bridgeMode || "(vacio)"}": central exige shadow`);
  }
  for (const clave of ["businessDbPath", "dbPath", "tenantDbPath", "rutaBusinessDb"]) {
    if (entrada[clave] !== undefined) {
      return falla("RUTA_BUSINESS_NO_ADMITIDA", `${clave}: las business DB se resuelven solo desde Control`);
    }
  }
  const controlDbPath = typeof entrada.controlDbPath === "string" ? entrada.controlDbPath.trim() : "";
  if (!controlDbPath) {
    return falla("CONTROL_DB_NO_CONFIGURADO", "controlDbPath explicito obligatorio");
  }
  if (!path.isAbsolute(controlDbPath)) {
    return falla("CONTROL_DB_RUTA_RELATIVA", "controlDbPath debe ser absoluto");
  }
  if (!fs.existsSync(controlDbPath) || !fs.statSync(controlDbPath).isFile()) {
    return falla("CONTROL_DB_AUSENTE", "controlDbPath no existe");
  }
  const config = { authMode, tenancyMode, bridgeMode, controlDbPath };
  for (const clave of Object.keys(LIMITES)) {
    const r = enteroEnRango(entrada[clave], LIMITES[clave], clave);
    if (!r.ok) {
      return falla("CONFIG_FUERA_DE_RANGO", r.motivo);
    }
    config[clave] = r.valor;
  }
  if (config.backoffMaxMs < config.backoffBaseMs) {
    return falla("CONFIG_FUERA_DE_RANGO", "backoffMaxMs debe ser >= backoffBaseMs");
  }
  return { ok: true, config };
}

function configuracionDesdeEntorno(env = process.env, extra = {}) {
  return {
    authMode: env.ATLAS_AUTH_MODE,
    tenancyMode: env.ATLAS_TENANCY_MODE,
    bridgeMode: env.ATLAS_USER_BRIDGE_MODE,
    controlDbPath: env.ATLAS_CONTROL_DB_PATH,
    intervaloMs: env.ATLAS_ROL_ACTIVO_WORKER_INTERVALO_MS,
    maxOperacionesPorCiclo: env.ATLAS_ROL_ACTIVO_WORKER_MAX_OPERACIONES,
    ...extra
  };
}

// Lectura de seleccion de UNA pagina con cursor keyset (id > cursor), solo rol_activo pendiente.
async function leerPaginaPendientes(controlDbPath, { despuesDeId, hastaId, limite }) {
  const controlDb = await abrirControlDbSoloLectura(controlDbPath);
  try {
    await runQuery(controlDb, "PRAGMA busy_timeout = 5000");
    const params = [despuesDeId];
    let filtroHasta = "";
    if (hastaId !== null) {
      filtroHasta = " AND id <= ?";
      params.push(hastaId);
    }
    params.push(limite);
    return await allQuery(
      controlDb,
      `SELECT id, membership_id, version_objetivo FROM sync_pendiente
       WHERE tipo_operacion = 'rol_activo' AND estado = 'pendiente' AND id > ?${filtroHasta}
       ORDER BY id ASC LIMIT ?`,
      params
    );
  } finally {
    await closeDb(controlDb);
  }
}

function claveGeneracion(membershipId, versionObjetivo) {
  return `${membershipId}:${versionObjetivo}`;
}

// Solo campos de diagnostico no sensibles -- nunca el objeto crudo del consumer (que puede traer
// mensajes de error de bajo nivel).
function resumirResultado(fila, r) {
  return {
    pendienteId: Number(fila.id),
    membershipId: Number(fila.membership_id),
    versionObjetivo: Number(fila.version_objetivo),
    resultado: r.resultado,
    motivo: r.motivo || null,
    clase: r.clase || null,
    proyeccion: r.proyeccion && r.proyeccion.resultado ? r.proyeccion.resultado : null
  };
}

function clasificar(r) {
  switch (r.resultado) {
    case R.CERRADO: return "CERRADO";
    case R.YA_PROCESADO:
    case R.CERRADO_POR_OTRO_CONSUMIDOR: return "CONVERGIDO";
    case R.REEMPLAZADO_POR_VERSION_POSTERIOR: return "REEMPLAZADO";
    case R.GENERACION_OBSOLETA: return "OBSOLETO";
    case R.ERROR_TRANSITORIO: return "TRANSITORIO";
    default:
      return r.clase === "TRANSITORIO" ? "TRANSITORIO" : "TERMINAL";
  }
}

function crearWorkerRolActivo(entrada = {}, dependencias = {}) {
  const validacion = validarConfiguracionWorker(entrada);
  if (!validacion.ok) {
    return validacion;
  }
  const config = validacion.config;
  const reloj = dependencias.reloj || (() => Date.now());
  const programar = dependencias.programar || ((fn, ms) => setTimeout(fn, ms));
  const cancelar = dependencias.cancelar || ((t) => clearTimeout(t));
  const procesar = dependencias.procesarPendiente || procesarPendienteRolActivo;
  const eventos = new EventEmitter();

  let cursor = 0;
  let numeroCiclo = 0;
  let cicloEnCurso = null;
  let detenido = false;
  let watchActivo = false;
  let temporizador = null;
  let fallasConsecutivas = 0;
  let resolverWatch = null;
  let senalesInstaladas = null;
  // (membership:version) -> { intentos, siguienteIntento } para transitorios; cuarentena para terminales.
  const backoff = new Map();
  const cuarentena = new Map();

  function elegible(fila, ahora, ciclo) {
    const clave = claveGeneracion(fila.membership_id, fila.version_objetivo);
    const q = cuarentena.get(clave);
    if (q && ahora < q.hasta) {
      ciclo.omitidosPorCuarentena += 1;
      return false;
    }
    const b = backoff.get(clave);
    if (b && ahora < b.siguienteIntento) {
      ciclo.omitidosPorBackoff += 1;
      return false;
    }
    return true;
  }

  function registrar(fila, r, ahora) {
    const clave = claveGeneracion(fila.membership_id, fila.version_objetivo);
    const tipo = clasificar(r);
    if (tipo === "TRANSITORIO") {
      const previo = backoff.get(clave);
      const intentos = previo ? previo.intentos + 1 : 1;
      const espera = Math.min(config.backoffBaseMs * 2 ** (intentos - 1), config.backoffMaxMs);
      backoff.set(clave, { intentos, siguienteIntento: ahora + espera });
    } else if (tipo === "TERMINAL" || tipo === "OBSOLETO") {
      backoff.delete(clave);
      cuarentena.set(clave, { hasta: ahora + config.cuarentenaTerminalMs, resultado: r.resultado, motivo: r.motivo || null });
    } else {
      backoff.delete(clave);
      cuarentena.delete(clave);
    }
    return tipo;
  }

  // Un ciclo: recorre a lo sumo UNA vuelta completa de pendientes desde el cursor (con wrap) e
  // invoca el consumer como maximo maxOperacionesPorCiclo veces. El cursor persiste entre ciclos, asi
  // que el siguiente continua donde termino el anterior: ningun pendiente queda inanido por los que
  // estan primero ni por los que fallan.
  async function ejecutarCicloInterno() {
    numeroCiclo += 1;
    const inicio = reloj();
    const ciclo = {
      ciclo: numeroCiclo,
      inicio,
      seleccionados: 0,
      procesados: 0,
      cerrados: 0,
      convergidos: 0,
      reemplazados: 0,
      transitorios: 0,
      terminales: 0,
      obsoletos: 0,
      omitidosPorBackoff: 0,
      omitidosPorCuarentena: 0,
      errorLectura: null,
      interrumpidoPorDetencion: false,
      limiteAlcanzado: false,
      detalle: []
    };
    const cursorInicial = cursor;
    // Dos tramos: (cursorInicial, +inf) y luego (0, cursorInicial] -- una vuelta exacta.
    const tramos = [{ desde: cursorInicial, hasta: null }];
    if (cursorInicial > 0) tramos.push({ desde: 0, hasta: cursorInicial });
    const tamPagina = config.maxOperacionesPorCiclo;

    recorrido:
    for (const tramo of tramos) {
      let despuesDeId = tramo.desde;
      for (;;) {
        let pagina;
        try {
          pagina = await leerPaginaPendientes(config.controlDbPath, { despuesDeId, hastaId: tramo.hasta, limite: tamPagina });
        } catch (error) {
          // Nunca se omite en silencio: el ciclo se declara fallido por lectura y el cursor queda
          // donde estaba para reintentar el mismo tramo.
          ciclo.errorLectura = { codigo: error.code || "CONTROL_DB_READ_ERROR" };
          break recorrido;
        }
        if (pagina.length === 0) break;
        for (const fila of pagina) {
          if (detenido) {
            ciclo.interrumpidoPorDetencion = true;
            break recorrido;
          }
          if (ciclo.procesados >= config.maxOperacionesPorCiclo) {
            ciclo.limiteAlcanzado = true;
            break recorrido;
          }
          ciclo.seleccionados += 1;
          despuesDeId = Number(fila.id);
          cursor = Number(fila.id);
          if (!elegible(fila, reloj(), ciclo)) continue;
          let r;
          try {
            r = await procesar({
              membershipId: Number(fila.membership_id),
              versionObjetivo: Number(fila.version_objetivo),
              controlDbPath: config.controlDbPath
            });
          } catch (error) {
            r = { resultado: R.ERROR_TRANSITORIO, cerrado: false, motivo: "EXCEPCION_CONSUMER", clase: "TRANSITORIO" };
          }
          ciclo.procesados += 1;
          const tipo = registrar(fila, r, reloj());
          if (tipo === "CERRADO") ciclo.cerrados += 1;
          else if (tipo === "CONVERGIDO") ciclo.convergidos += 1;
          else if (tipo === "REEMPLAZADO") ciclo.reemplazados += 1;
          else if (tipo === "TRANSITORIO") ciclo.transitorios += 1;
          else if (tipo === "OBSOLETO") ciclo.obsoletos += 1;
          else ciclo.terminales += 1;
          ciclo.detalle.push(resumirResultado(fila, r));
        }
        if (pagina.length < tamPagina) break;
      }
    }
    // Vuelta completa sin limite: el proximo ciclo arranca desde el principio.
    if (!ciclo.limiteAlcanzado && !ciclo.interrumpidoPorDetencion && !ciclo.errorLectura) {
      cursor = 0;
    }
    ciclo.fin = reloj();
    ciclo.cursorSiguiente = cursor;
    return ciclo;
  }

  // Nunca dos ciclos superpuestos dentro de la instancia: un pedido concurrente se informa como
  // omitido (no se encola ni se ejecuta en paralelo).
  async function ejecutarCiclo() {
    if (cicloEnCurso) {
      return { omitido: true, motivo: "CICLO_EN_CURSO" };
    }
    if (detenido) {
      return { omitido: true, motivo: "WORKER_DETENIDO" };
    }
    cicloEnCurso = ejecutarCicloInterno();
    try {
      const resumen = await cicloEnCurso;
      eventos.emit("ciclo", resumen);
      return resumen;
    } finally {
      cicloEnCurso = null;
    }
  }

  function demoraSiguiente(resumen) {
    const fallido = Boolean(resumen && (resumen.errorLectura || resumen.excepcion))
      || Boolean(resumen && resumen.procesados > 0 && resumen.transitorios === resumen.procesados);
    if (!fallido) {
      fallasConsecutivas = 0;
      return config.intervaloMs;
    }
    fallasConsecutivas += 1;
    return Math.min(config.intervaloMs * 2 ** fallasConsecutivas, Math.max(config.backoffMaxMs, config.intervaloMs));
  }

  function desinstalarSenales() {
    if (!senalesInstaladas) return;
    for (const [senal, manejador] of senalesInstaladas.manejadores) {
      senalesInstaladas.emisor.removeListener(senal, manejador);
    }
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

  // WATCH: un ciclo, y el siguiente se programa recien cuando el anterior termino (setTimeout, nunca
  // setInterval) -- no hay superposicion posible. Resuelve cuando el worker se detiene.
  function iniciarWatch({ senales = process, instalarManejadores = true } = {}) {
    if (watchActivo) {
      return Promise.reject(new Error("WATCH ya iniciado en esta instancia"));
    }
    if (detenido) {
      return Promise.reject(new Error("worker detenido"));
    }
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
        // Un error inesperado nunca termina el WATCH en silencio: se informa y se reintenta con backoff.
        resumen = { excepcion: true, codigo: error.code || "EXCEPCION_CICLO" };
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

  // Detencion ordenada: no se toman filas nuevas, la operacion en curso (si existe) termina completa
  // -- el consumer nunca se interrumpe a mitad de su proyeccion/CAS -- y se cancela el proximo ciclo.
  async function detener({ senal = null } = {}) {
    detenido = true;
    if (temporizador !== null) {
      cancelar(temporizador);
      temporizador = null;
    }
    desinstalarSenales();
    if (cicloEnCurso) {
      try { await cicloEnCurso; } catch (_) { /* el ciclo ya informo su propio resultado */ }
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
    return {
      detenido,
      watchActivo,
      cicloEnCurso: Boolean(cicloEnCurso),
      ciclos: numeroCiclo,
      cursor,
      enBackoff: backoff.size,
      enCuarentena: cuarentena.size,
      senalesInstaladas: Boolean(senalesInstaladas)
    };
  }

  return { ok: true, config, eventos, ejecutarCiclo, iniciarWatch, detener, estado };
}

// ONCE: un ciclo acotado y termina.
async function ejecutarWorkerOnce(entrada = {}, dependencias = {}) {
  const worker = crearWorkerRolActivo(entrada, dependencias);
  if (!worker.ok) return worker;
  try {
    const resumen = await worker.ejecutarCiclo();
    return { ok: true, modo: "ONCE", resumen };
  } finally {
    await worker.detener();
  }
}

function resumenLinea(r) {
  return `ciclo=${r.ciclo} seleccionados=${r.seleccionados} procesados=${r.procesados} cerrados=${r.cerrados} convergidos=${r.convergidos} reemplazados=${r.reemplazados} transitorios=${r.transitorios} terminales=${r.terminales} obsoletos=${r.obsoletos} backoff=${r.omitidosPorBackoff} cuarentena=${r.omitidosPorCuarentena}${r.errorLectura ? ` errorLectura=${r.errorLectura.codigo}` : ""}`;
}

// CLI: node database/run-rol-activo-worker.js --once | --watch [--max-ciclos=N]
// Configuracion solo por entorno explicito (ATLAS_AUTH_MODE, ATLAS_TENANCY_MODE,
// ATLAS_USER_BRIDGE_MODE, ATLAS_CONTROL_DB_PATH). Sin PM2, cron ni tareas programadas: quien lo
// supervise queda fuera de este slice.
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
    const r = await ejecutarWorkerOnce(entrada);
    if (!r.ok) {
      console.error(`ERROR: [${r.errorCode}] ${r.motivo}`);
      return 2;
    }
    console.log(`rol_activo worker ONCE: ${resumenLinea(r.resumen)}`);
    return r.resumen.errorLectura ? 1 : 0;
  }
  const worker = crearWorkerRolActivo(entrada);
  if (!worker.ok) {
    console.error(`ERROR: [${worker.errorCode}] ${worker.motivo}`);
    return 2;
  }
  worker.eventos.on("ciclo", (r) => {
    console.log(`rol_activo worker WATCH: ${resumenLinea(r)}`);
    if (worker.config.maxCiclos !== null && r.ciclo >= worker.config.maxCiclos) {
      worker.detener({ senal: "MAX_CICLOS" });
    }
  });
  worker.eventos.on("error-ciclo", (e) => console.error(`rol_activo worker WATCH: error de ciclo ${e.codigo}`));
  const fin = await worker.iniciarWatch();
  console.log(`rol_activo worker WATCH detenido (${fin.senal || "sin senal"}) tras ${fin.ciclos} ciclos`);
  return 0;
}

module.exports = {
  LIMITES,
  validarConfiguracionWorker,
  configuracionDesdeEntorno,
  crearWorkerRolActivo,
  ejecutarWorkerOnce,
  runCli
};

if (require.main === module) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}
