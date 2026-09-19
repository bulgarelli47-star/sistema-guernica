// MT-1F1: registry runtime de HANDLES de business DB. Primitivo puro: resuelve una empresa registrada
// en el Control plane y devuelve un handle VERIFICADO, CACHEADO e INMUTABLE de su business DB. NO esta
// conectado a requests, a backend/db.js ni a backend/server.js, no usa AsyncLocalStorage y no conoce
// Host, sesiones, membership ni HTTP -- el consumo posterior (MT-1F2/MT-1F3) decide como se usa.
//
// Cadena que implementa: CONTROL registry -> empresa activa -> path canonico -> business DB abierta ->
// identity + baseline + schema CURRENT verificados SOBRE ESA MISMA CONEXION -> handle publicado.
//
// Contratos:
// - Autoridad de registry: backend/tenantDbRegistry.js (resolverTenantDbRegistradoPorSlug). Este modulo
//   no reimplementa empresa activa ni normalizacion de path; solo consume su resultado.
// - Apertura: sqlite3.OPEN_READWRITE explicito, SIN OPEN_CREATE. Un archivo ausente o un directorio
//   fallan; jamas se materializa un archivo vacio. No se emite ningun PRAGMA: el handle replica el
//   estado por defecto de la conexion singleton de backend/db.js (foreign_keys y busy_timeout
//   incluidos), asi que este modulo no cambia estado persistente ni de conexion.
// - Verificacion: identity, baseline y schema corren sobre la MISMA conexion que se publica, con los
//   verificadores *EnConexion (solo SELECT/PRAGMA de lectura). Nunca verificar por path y reabrir.
// - Cache positivo unicamente. Un fallo NO se cachea: la resolucion en vuelo se elimina y la proxima
//   llamada reintenta limpiamente (una tenant recuperada no necesita reiniciar el proceso).
// - Single-flight por path canonico: llamadas concurrentes a la misma tenant comparten UNA sola
//   verificacion (un open, una verificacion de identity/baseline/schema).
// - Aislamiento: un fallo de una tenant rechaza SOLO esa resolucion. No hay estado global "unhealthy",
//   no hay process.exit, no hay fallback a otra DB, no se crea, repara ni migra nada.
// - Binding: cada llamada arranca desde el resultado ACTUAL del registry. Un handle cacheado nunca
//   sobrevive silenciosamente a un cambio de path/id/slug en Control: falla cerrado, sin hot swap.
// - Colision: dos empresas ACTIVAS que resuelven al mismo path canonico fallan cerrado (deteccion
//   solo en runtime; el schema de Control no se altera).
//
// Errores: resultados { ok:false, errorCode, message, ... } con codigos estables. Los mensajes son
// genericos y no incluyen paths ni detalles del filesystem; `cause`/`details` solo llevan codigos.
const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3");
const {
  DEFAULT_DB_PATH,
  closeDb: cerrarControlDb,
  allQuery: allQueryControl,
  resolveEmpresaDbPath
} = require("../database/init-control-db");
const { resolverTenantDbRegistradoPorSlug } = require("./tenantDbRegistry");
const { abrirControlDbSoloLectura } = require("./centralAuthResolver");
const { verificarTenantDbIdentityEnConexion } = require("./tenantDbIdentity");
const { LEGACY_BASELINE_INVARIANTS, verificarLegacyBaselineEnConexion } = require("./legacyBaselineVerifier");
const { verificarBusinessSchemaVersionEnConexion } = require("./businessSchemaVersion");

const TENANT_RUNTIME_ERROR_CODES = Object.freeze({
  REGISTRY_BINDING_INVALID: "REGISTRY_BINDING_INVALID",
  REGISTRY_COMPANY_INACTIVE: "REGISTRY_COMPANY_INACTIVE",
  REGISTRY_UNAVAILABLE: "REGISTRY_UNAVAILABLE",
  TENANT_DB_OPEN_FAILED: "TENANT_DB_OPEN_FAILED",
  TENANT_PATH_COLLISION: "TENANT_PATH_COLLISION",
  TENANT_BINDING_CONFLICT: "TENANT_BINDING_CONFLICT",
  TENANT_IDENTITY_INVALID: "TENANT_IDENTITY_INVALID",
  TENANT_BASELINE_INVALID: "TENANT_BASELINE_INVALID",
  TENANT_SCHEMA_NOT_CURRENT: "TENANT_SCHEMA_NOT_CURRENT",
  TENANT_HANDLE_INVALID: "TENANT_HANDLE_INVALID",
  TENANT_DB_CLOSE_FAILED: "TENANT_DB_CLOSE_FAILED",
  TENANT_RUNTIME_ERROR: "TENANT_RUNTIME_ERROR"
});
const CODES = TENANT_RUNTIME_ERROR_CODES;

// Estado interno del modulo. Ninguno de estos Maps se exporta ni se expone por referencia.
const handlesPorRuta = new Map(); // clave canonica -> handle publicado
const rutaPorEmpresaId = new Map(); // empresaId -> clave canonica
const rutaPorSlug = new Map(); // empresaSlug -> clave canonica
const verificacionesEnVuelo = new Map(); // clave canonica -> { empresaId, empresaSlug, promise }

function resultadoError(errorCode, message, extra = {}) {
  return Object.freeze({ ok: false, errorCode, message, ...extra });
}

// Clave de cache: path.resolve (misma autoridad que resolveEmpresaDbPath del Control registry) y, en
// Windows, sin distinguir mayusculas (el filesystem tampoco las distingue). El campo publico
// canonicalPath conserva el string exacto que devolvio el registry.
function claveCanonica(rutaResuelta) {
  const resuelta = path.resolve(rutaResuelta);
  return process.platform === "win32" ? resuelta.toLowerCase() : resuelta;
}

function mapearErrorRegistry(registry) {
  switch (registry.errorCode) {
    case "TENANT_REGISTRY_BINDING_INVALID":
    case "TENANT_DB_PATH_INVALID":
      return resultadoError(CODES.REGISTRY_BINDING_INVALID, "La empresa no coincide con el registry central", { cause: registry.errorCode });
    case "EMPRESA_INACTIVA":
      return resultadoError(CODES.REGISTRY_COMPANY_INACTIVE, "La empresa registrada esta inactiva", { cause: registry.errorCode });
    default:
      return resultadoError(CODES.REGISTRY_UNAVAILABLE, "El registry central no esta disponible", { cause: registry.errorCode || "UNKNOWN" });
  }
}

// Deteccion runtime de path duplicado: lee (READONLY) todas las empresas ACTIVAS y compara su path
// canonico con el de la empresa solicitada. Cualquier OTRA empresa activa en el mismo path hace que la
// resolucion falle cerrado -- para AMBAS empresas, sin depender del orden de llegada.
async function detectarColisionDePath({ controlDbPath, empresa, clave }) {
  let controlDb;
  try {
    controlDb = await abrirControlDbSoloLectura(controlDbPath || DEFAULT_DB_PATH);
  } catch (error) {
    return resultadoError(CODES.REGISTRY_UNAVAILABLE, "El registry central no esta disponible", { cause: "CONTROL_DB_INACCESIBLE" });
  }

  try {
    const filas = await allQueryControl(controlDb, "SELECT id, db_path FROM empresas WHERE activa = 1");
    for (const fila of filas) {
      if (Number(fila.id) === Number(empresa.id)) continue;
      let otraClave;
      try {
        otraClave = claveCanonica(resolveEmpresaDbPath(fila.db_path));
      } catch (error) {
        // Una empresa con db_path invalido no puede publicar handle; no participa de la colision.
        continue;
      }
      if (otraClave === clave) {
        return resultadoError(CODES.TENANT_PATH_COLLISION, "Mas de una empresa activa resuelve a la misma base de datos");
      }
    }
    return { ok: true };
  } catch (error) {
    return resultadoError(CODES.REGISTRY_UNAVAILABLE, "El registry central no esta disponible", { cause: "CONTROL_DB_QUERY_ERROR" });
  } finally {
    try { await cerrarControlDb(controlDb); } catch (error) { /* cierre de una conexion READONLY de Control: sin efecto sobre el resultado */ }
  }
}

// Compara el binding ACTUAL del registry contra todo el estado runtime (handles publicados y
// verificaciones en vuelo). Seccion sincrona: no hay await entre esta evaluacion y la decision de
// abrir/cachear, por lo que no existe ventana entre check y set.
function evaluarBinding(empresa, clave) {
  const publicado = handlesPorRuta.get(clave);
  if (publicado) {
    if (publicado.empresaId !== empresa.id) {
      return resultadoError(CODES.TENANT_PATH_COLLISION, "La base de datos ya esta publicada para otra empresa");
    }
    if (publicado.empresaSlug !== empresa.slug) {
      return resultadoError(CODES.TENANT_BINDING_CONFLICT, "El registry ya no coincide con el handle publicado");
    }
  }

  const enVuelo = verificacionesEnVuelo.get(clave);
  if (enVuelo) {
    if (enVuelo.empresaId !== empresa.id) {
      return resultadoError(CODES.TENANT_PATH_COLLISION, "La base de datos ya esta en verificacion para otra empresa");
    }
    if (enVuelo.empresaSlug !== empresa.slug) {
      return resultadoError(CODES.TENANT_BINDING_CONFLICT, "El registry ya no coincide con la verificacion en curso");
    }
  }

  const rutaDelId = rutaPorEmpresaId.get(empresa.id);
  if (rutaDelId !== undefined && rutaDelId !== clave) {
    return resultadoError(CODES.TENANT_BINDING_CONFLICT, "El registry ahora mapea la empresa a otra base de datos");
  }
  const rutaDelSlug = rutaPorSlug.get(empresa.slug);
  if (rutaDelSlug !== undefined && rutaDelSlug !== clave) {
    return resultadoError(CODES.TENANT_BINDING_CONFLICT, "El registry ahora mapea el slug a otra base de datos");
  }
  return null;
}

// Nunca OPEN_CREATE. sqlite3 exige el callback explicito: sin el, un fallo de apertura emitiria un
// evento 'error' sin listener y tumbaria el proceso en vez de rechazar la promesa.
function abrirBusinessDbSinCrear(canonicalPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(canonicalPath, sqlite3.OPEN_READWRITE, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(db);
    });
  });
}

function cerrarBusinessDb(db) {
  return new Promise((resolve, reject) => {
    db.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function cerrarSilencioso(db) {
  return cerrarBusinessDb(db).catch(() => {});
}

function leerSchemaVersion(db) {
  return new Promise((resolve, reject) => {
    db.all("PRAGMA schema_version", (error, filas) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(filas);
    });
  });
}

function codigosUnicos(failures) {
  return Array.from(new Set((failures || []).map((failure) => failure.code)));
}

// Verifica sobre la conexion `db` ya abierta (la misma que se publicara). Orden: identity -> baseline
// -> schema. Devuelve null si todo es exacto, o el resultado de error correspondiente.
async function verificarEnConexion(db, empresa) {
  try {
    // Un archivo que existe pero no es SQLite abre en modo lazy: el error aparece en la primera
    // lectura. Es el mismo sanity check READ-ONLY que usa el verificador path-based del baseline.
    await leerSchemaVersion(db);
  } catch (error) {
    return resultadoError(CODES.TENANT_DB_OPEN_FAILED, "No se pudo abrir la base de datos de la empresa", { cause: "DB_NOT_SQLITE" });
  }

  const identity = await verificarTenantDbIdentityEnConexion(db, { empresaId: empresa.id, empresaSlug: empresa.slug });
  if (!identity.ok) {
    return resultadoError(CODES.TENANT_IDENTITY_INVALID, "La base de datos no pertenece a la empresa registrada", { cause: identity.errorCode });
  }

  let baseline;
  try {
    baseline = await verificarLegacyBaselineEnConexion(db);
  } catch (error) {
    return resultadoError(CODES.TENANT_BASELINE_INVALID, "La base de datos no cumple el baseline requerido", { cause: "BASELINE_VERIFY_ERROR", details: Object.freeze({ failureCodes: Object.freeze([]) }) });
  }
  // Un catalogo vacio haria ready=true de forma vacua: nunca es aceptable como certificacion.
  const catalogoVacio = !Array.isArray(LEGACY_BASELINE_INVARIANTS) || LEGACY_BASELINE_INVARIANTS.length === 0;
  if (catalogoVacio || !baseline || baseline.ready !== true) {
    return resultadoError(CODES.TENANT_BASELINE_INVALID, "La base de datos no cumple el baseline requerido", {
      cause: catalogoVacio ? "BASELINE_CATALOG_EMPTY" : "BASELINE_NOT_READY",
      details: Object.freeze({ failureCodes: Object.freeze(codigosUnicos(baseline && baseline.failures)) })
    });
  }

  let schema;
  try {
    schema = await verificarBusinessSchemaVersionEnConexion(db);
  } catch (error) {
    return resultadoError(CODES.TENANT_SCHEMA_NOT_CURRENT, "La base de datos no esta en estado CURRENT", { cause: "SCHEMA_VERIFY_ERROR", details: Object.freeze({ state: "DB_ERROR" }) });
  }
  const actual = schema && schema.currentMigrationId;
  if (!schema || schema.state !== "CURRENT" || !actual || actual !== schema.expectedMigrationId) {
    return resultadoError(CODES.TENANT_SCHEMA_NOT_CURRENT, "La base de datos no esta en estado CURRENT", {
      cause: "SCHEMA_STATE_" + String(schema && schema.state),
      details: Object.freeze({
        state: schema ? schema.state : null,
        currentMigrationId: schema ? schema.currentMigrationId : null,
        expectedMigrationId: schema ? schema.expectedMigrationId : null
      })
    });
  }
  return null;
}

function publicarHandle(handle, clave) {
  handlesPorRuta.set(clave, handle);
  rutaPorEmpresaId.set(handle.empresaId, clave);
  rutaPorSlug.set(handle.empresaSlug, clave);
}

function retirarPublicacion(handle, clave) {
  handlesPorRuta.delete(clave);
  if (rutaPorEmpresaId.get(handle.empresaId) === clave) rutaPorEmpresaId.delete(handle.empresaId);
  if (rutaPorSlug.get(handle.empresaSlug) === clave) rutaPorSlug.delete(handle.empresaSlug);
}

// Abre + verifica + publica. Toda salida es un resultado (nunca lanza). Ante cualquier fallo la
// conexion abierta se cierra y NADA queda cacheado.
async function abrirVerificarYPublicar({ empresa, registeredPath, canonicalPath, clave }) {
  let stat;
  try {
    stat = fs.statSync(canonicalPath);
  } catch (error) {
    return resultadoError(CODES.TENANT_DB_OPEN_FAILED, "No se pudo abrir la base de datos de la empresa", { cause: "DB_NOT_FOUND" });
  }
  if (!stat.isFile()) {
    return resultadoError(CODES.TENANT_DB_OPEN_FAILED, "No se pudo abrir la base de datos de la empresa", { cause: "DB_NOT_A_FILE" });
  }

  let db;
  try {
    db = await abrirBusinessDbSinCrear(canonicalPath);
  } catch (error) {
    return resultadoError(CODES.TENANT_DB_OPEN_FAILED, "No se pudo abrir la base de datos de la empresa", { cause: "DB_OPEN_ERROR" });
  }

  let fallo;
  try {
    fallo = await verificarEnConexion(db, empresa);
  } catch (error) {
    fallo = resultadoError(CODES.TENANT_RUNTIME_ERROR, "Error inesperado verificando la base de datos de la empresa", { cause: "VERIFY_UNEXPECTED" });
  }
  if (fallo) {
    await cerrarSilencioso(db);
    return fallo;
  }

  const handle = Object.freeze({
    empresaId: empresa.id,
    empresaSlug: empresa.slug,
    registeredPath,
    canonicalPath,
    db,
    verifiedAt: new Date().toISOString()
  });
  publicarHandle(handle, clave);
  return Object.freeze({ ok: true, handle });
}

// API principal. Siempre arranca desde el registry ACTUAL de Control (empresa activa, binding
// id+slug, path canonico), detecta colision de paths, compara contra el estado runtime y recien
// entonces devuelve el handle cacheado o dispara UNA verificacion single-flight.
async function resolveTenantHandle({ empresaSlug, controlDbPath } = {}) {
  try {
    const registry = await resolverTenantDbRegistradoPorSlug({ empresaSlug, controlDbPath });
    if (!registry.ok) return mapearErrorRegistry(registry);

    const empresa = { id: registry.empresa.id, slug: registry.empresa.slug };
    const registeredPath = registry.db.registeredPath;
    const canonicalPath = registry.db.resolvedPath;
    const clave = claveCanonica(canonicalPath);

    const colision = await detectarColisionDePath({ controlDbPath, empresa, clave });
    if (!colision.ok) return colision;

    // --- Seccion sincrona: evaluacion de binding, hit de cache y alta de la verificacion en vuelo ---
    const conflicto = evaluarBinding(empresa, clave);
    if (conflicto) return conflicto;

    const publicado = handlesPorRuta.get(clave);
    if (publicado) return Object.freeze({ ok: true, handle: publicado });

    let enVuelo = verificacionesEnVuelo.get(clave);
    if (!enVuelo) {
      const promise = abrirVerificarYPublicar({ empresa, registeredPath, canonicalPath, clave });
      enVuelo = { empresaId: empresa.id, empresaSlug: empresa.slug, promise };
      verificacionesEnVuelo.set(clave, enVuelo);
      const limpiar = () => {
        if (verificacionesEnVuelo.get(clave) === enVuelo) verificacionesEnVuelo.delete(clave);
      };
      promise.then(limpiar, limpiar);
    }
    // --- Fin seccion sincrona ---

    return await enVuelo.promise;
  } catch (error) {
    return resultadoError(CODES.TENANT_RUNTIME_ERROR, "Error inesperado resolviendo la empresa", { cause: "RESOLVE_UNEXPECTED" });
  }
}

// Cierra UN handle publicado, sin tocar ningun otro. La publicacion se retira ANTES de esperar el
// close: nadie puede recibir un handle cuya conexion se esta cerrando. Un handle no publicado (ya
// cerrado, o de otra generacion) es un no-op idempotente.
async function closeTenantHandle(handle) {
  if (!handle || typeof handle !== "object" || typeof handle.canonicalPath !== "string" || !handle.db) {
    return resultadoError(CODES.TENANT_HANDLE_INVALID, "Handle de tenant invalido");
  }
  const clave = claveCanonica(handle.canonicalPath);
  const publicado = handlesPorRuta.get(clave);
  if (publicado !== handle) return Object.freeze({ ok: true, closed: false });

  retirarPublicacion(publicado, clave);
  try {
    await cerrarBusinessDb(publicado.db);
  } catch (error) {
    return resultadoError(CODES.TENANT_DB_CLOSE_FAILED, "No se pudo cerrar la conexion de la empresa");
  }
  return Object.freeze({ ok: true, closed: true });
}

// Cierra TODOS los handles publicados. Primero espera a que terminen las verificaciones en vuelo
// (una en curso podria publicar un handle nuevo), luego retira y cierra cada conexion.
async function closeAllTenantHandles() {
  for (let intentos = 0; intentos < 100 && verificacionesEnVuelo.size > 0; intentos += 1) {
    await Promise.allSettled(Array.from(verificacionesEnVuelo.values(), (entrada) => entrada.promise));
  }

  const publicados = Array.from(handlesPorRuta.entries());
  for (const [clave, handle] of publicados) retirarPublicacion(handle, clave);

  const resultados = await Promise.allSettled(publicados.map(([, handle]) => cerrarBusinessDb(handle.db)));
  const fallidos = resultados.filter((resultado) => resultado.status === "rejected").length;
  return Object.freeze({ ok: fallidos === 0, closed: publicados.length - fallidos, failed: fallidos });
}

module.exports = {
  TENANT_RUNTIME_ERROR_CODES,
  resolveTenantHandle,
  closeTenantHandle,
  closeAllTenantHandles
};
