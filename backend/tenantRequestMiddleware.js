// MT-1F3: middleware de contexto de tenant por request. Conecta una request HTTP real con las primitivas
// ya publicadas:
//
//   req.tenantHostContext (parser de Host existente, backend/tenantHostContext.js)
//     -> registry runtime de handles (backend/runtimeTenantRegistry.js, MT-1F1)
//     -> handle de business DB verificado
//     -> runWithTenantHandle (backend/tenantRequestContext.js, MT-1F2)
//     -> helpers existentes de backend/db.js.
//
// Este modulo resuelve CONTEXTO, no AUTORIZA. El Host es un candidato, no una autorizacion: que la
// resolucion Host -> empresa -> handle tenga exito NO significa que el usuario de la request
// pertenezca a esa empresa. La autorizacion (sesion, usuario central, membership, empresa, slug y
// usuario local ligados a la MISMA empresa de la request) es de MT-1F4. Hasta entonces el modo
// central + multi NO esta completo para operacion autenticada.
//
// Reglas de activacion (ATLAS_TENANCY_MODE, independiente de ATLAS_AUTH_MODE):
// - legacy + single  -> sin routing (comportamiento actual).
// - central + single -> sin routing (empresa fija por proceso, gate E7B actual).
// - central + multi  -> routing por request (unico modo que usa este middleware).
// - legacy + multi   -> configuracion invalida: backend/server.js la rechaza al arrancar.
//
// Reglas de seguridad del modo multi:
// - Nunca hay fallback a ATLAS_EMPRESA_SLUG, GUERNICA_DB_PATH, el singleton legacy, un "ultimo tenant"
//   ni una empresa por defecto. Este modulo no lee process.env: recibe todo por parametros.
// - Sin candidato de tenant (LOCAL, RESERVED, INVALID, apex, sin Host) => falla cerrado en rutas
//   ligadas a tenant.
// - Los fallos de tenant son indistinguibles hacia afuera: tenant inexistente, inactivo, path
//   invalido, DB ausente, identity distinta, baseline no READY y schema no CURRENT producen la MISMA
//   respuesta externa. El motivo exacto solo viaja al callback interno `alFallar` (diagnostico),
//   nunca a la respuesta.
// - No enumeracion en rutas PROTEGIDAS (MT-1F3-C1): antes de que exista autenticacion, un llamador no
//   puede saber si un tenant existe, esta activo o tiene DB sana. Por eso, en una ruta protegida
//   (`esRutaProtegida`, clasificacion que es autoridad de backend/server.js: este modulo NO tiene una
//   copia de la tabla de rutas publicas) TODO fallo de resolucion de tenant responde el MISMO 401
//   generico que backend/server.js (requireAuth) responde a cualquier peticion no autenticada en
//   central + multi. Como el Authorization lo controla el atacante, requireAuth tambien unifica en ese
//   modo "sin token", "token basura", "token expirado/inexistente" y "sesion incompatible" en esa misma
//   respuesta. En rutas publicas de tenant (tienda publica, login, logout) los fallos siguen siendo un
//   404 generico, igual que una ruta inexistente.
// - Unica excepcion de status: si el Control plane mismo no esta disponible se responde 503 generico.
//   Ese error proviene solo de leer el Control (nunca de la empresa pedida), asi que no es especifico
//   de ningun tenant y no revela si una empresa existe.
// - No hay cache negativo: un fallo no se recuerda; la proxima request reintenta limpiamente.
//
// No abre SQLite, no contiene SQL de Control y no duplica verificacion: toda la verificacion de
// empresa/identity/baseline/schema es del registry de F1.
const { resolveTenantHandle } = require("./runtimeTenantRegistry");
const { runWithTenantHandle } = require("./tenantRequestContext");

const TENANCY_MODES = Object.freeze({ SINGLE: "single", MULTI: "multi" });

// Slug de sonda para verificar solo la DISPONIBILIDAD del Control plane al arrancar en modo multi.
const SLUG_SONDA_CONTROL = "__atlas_control_probe__";

// Unica respuesta externa para toda peticion protegida sin autenticacion establecida en central + multi.
// Es el mensaje historico de requireAuth para "sin token"; requireAuth lo reutiliza desde aqui.
const MENSAJE_NO_AUTENTICADO = "No autenticado. Iniciá sesión.";

// Resuelve ATLAS_TENANCY_MODE desde el valor crudo del entorno. Pura: sin process.env, sin efectos.
function parsearTenancyMode(valorCrudo) {
  const normalizado = String(valorCrudo === undefined || valorCrudo === null ? "" : valorCrudo).trim().toLowerCase();
  const modo = normalizado || TENANCY_MODES.SINGLE;
  if (modo !== TENANCY_MODES.SINGLE && modo !== TENANCY_MODES.MULTI) {
    return Object.freeze({ ok: false, mode: null });
  }
  return Object.freeze({ ok: true, mode: modo });
}

// Verificacion de arranque del modo multi: SOLO disponibilidad del Control plane. Reutiliza el registry
// (sin SQL propio) resolviendo una empresa sonda inexistente: si el Control es legible el registry
// responde "binding invalido"; cualquier otro resultado significa que el Control no sirve. NO
// verifica ninguna business DB: un tenant malo jamas debe impedir arrancar a los sanos.
async function verificarControlDisponible({ controlDbPath, resolverHandle = resolveTenantHandle } = {}) {
  const resultado = await resolverHandle({ empresaSlug: SLUG_SONDA_CONTROL, controlDbPath });
  if (resultado && resultado.ok === true) return;
  const codigo = resultado && resultado.errorCode;
  if (codigo === "REGISTRY_BINDING_INVALID" || codigo === "REGISTRY_COMPANY_INACTIVE") return;
  throw new Error(`Control plane no disponible para ATLAS_TENANCY_MODE=multi: ${codigo || "sin resultado"}`);
}

function responderRutaInexistente(req, res) {
  if (res.headersSent) return;
  // Misma forma y status que el handler 404 de backend/server.js para una ruta inexistente.
  res.status(404).json({ ok: false, message: `Ruta no encontrada: ${req.method} ${req.path}` });
}

function responderNoDisponible(res) {
  if (res.headersSent) return;
  res.status(503).json({ message: "Servicio no disponible" });
}

// 401 generico de "autenticacion no establecida". Lo usan este middleware (fallo de tenant en ruta
// protegida) y requireAuth de backend/server.js (central + multi): misma forma, mismo mensaje.
function responderNoAutenticado(res) {
  if (res.headersSent) return;
  res.status(401).json({ message: MENSAJE_NO_AUTENTICADO });
}

// Crea el middleware. Fuera de central + multi devuelve un passthrough que jamas invoca al resolver.
//   authMode / tenancyMode : modos ya validados por el proceso.
//   controlDbPath          : path del Control plane (undefined => default del registry).
//   resolverHandle         : inyectable para tests; por defecto el registry de F1.
//   eximirRuta(req)        : rutas de Clase 0 que no necesitan tenant (p. ej. el HTML de login).
//   esRutaProtegida(req)   : clasificacion publica/protegida, propiedad de backend/server.js. Si es true
//                            y el tenant no resuelve, se responde el 401 generico. Si el parametro falta,
//                            ninguna ruta se considera protegida (404 generico). Si el callback lanza, la
//                            ruta se trata como protegida: falla hacia el 401 uniforme, nunca hacia una
//                            respuesta distinta.
//   alFallar(diagnostico)  : callback INTERNO con el motivo exacto; nunca llega a la respuesta.
function crearTenantRequestMiddleware({
  authMode,
  tenancyMode,
  controlDbPath,
  resolverHandle = resolveTenantHandle,
  eximirRuta = () => false,
  esRutaProtegida = () => false,
  alFallar = () => {}
} = {}) {
  if (!(authMode === "central" && tenancyMode === TENANCY_MODES.MULTI)) {
    return function tenantRequestMiddlewareInactivo(req, res, next) {
      next();
    };
  }

  const diagnosticar = (diagnostico) => {
    try { alFallar(Object.freeze(diagnostico)); } catch (error) { /* el diagnostico jamas debe romper la request */ }
  };

  const esProtegida = (req) => {
    try { return esRutaProtegida(req) === true; } catch (error) { return true; }
  };

  // Respuesta externa ante CUALQUIER fallo de contexto de tenant. Una unica decision, un unico lugar.
  const rechazarSinContexto = (req, res) => {
    if (esProtegida(req)) responderNoAutenticado(res);
    else responderRutaInexistente(req, res);
  };

  return async function tenantRequestMiddleware(req, res, next) {
    if (eximirRuta(req)) {
      next();
      return;
    }

    const host = req.tenantHostContext;
    if (!host || host.kind !== "TENANT" || typeof host.tenantSlug !== "string" || host.tenantSlug.length === 0) {
      diagnosticar({ reason: "SIN_CANDIDATO_DE_TENANT", hostKind: host ? host.kind : "SIN_CONTEXTO_DE_HOST", tenantSlug: null, errorCode: null, cause: null });
      rechazarSinContexto(req, res);
      return;
    }

    let resultado;
    try {
      resultado = await resolverHandle({ empresaSlug: host.tenantSlug, controlDbPath });
    } catch (error) {
      diagnosticar({ reason: "ERROR_INESPERADO_DEL_RESOLVER", hostKind: host.kind, tenantSlug: host.tenantSlug, errorCode: null, cause: error && error.code ? error.code : "EXCEPCION" });
      rechazarSinContexto(req, res);
      return;
    }

    if (!resultado || resultado.ok !== true) {
      const errorCode = resultado ? resultado.errorCode : null;
      diagnosticar({ reason: "TENANT_NO_RESUELVE", hostKind: host.kind, tenantSlug: host.tenantSlug, errorCode, cause: resultado ? resultado.cause || null : null });
      if (errorCode === "REGISTRY_UNAVAILABLE") responderNoDisponible(res);
      else rechazarSinContexto(req, res);
      return;
    }

    // El resto de la cadena (middlewares y rutas siguientes, awaits, servicios y helpers de db.js) corre
    // dentro del contexto. runWithTenantHandle valida el handle ANTES de invocar next: si lo rechaza no hay
    // tenant parcial y se responde generico. Cualquier otra excepcion viene de la cadena downstream y NO se
    // enmascara como "ruta inexistente": se propaga a Express.
    try {
      runWithTenantHandle(resultado.handle, () => next());
    } catch (error) {
      if (error && error.code === "TENANT_CONTEXT_INVALID_HANDLE") {
        diagnosticar({ reason: "HANDLE_RECHAZADO_POR_CONTEXTO", hostKind: host.kind, tenantSlug: host.tenantSlug, errorCode: null, cause: error.code });
        rechazarSinContexto(req, res);
        return;
      }
      throw error;
    }
  };
}

module.exports = {
  TENANCY_MODES,
  MENSAJE_NO_AUTENTICADO,
  parsearTenancyMode,
  verificarControlDisponible,
  responderNoAutenticado,
  crearTenantRequestMiddleware
};
