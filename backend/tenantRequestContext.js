// MT-1F2: contexto asincrono de tenant. Primitivo puro que TRANSPORTA un handle de business DB ya
// verificado (backend/runtimeTenantRegistry.js, MT-1F1) a lo largo de una cadena async, para que
// backend/db.js resuelva la conexion correcta sin pasar parametros por los servicios.
//
// Limites deliberados:
// - Usa unicamente AsyncLocalStorage de Node (built-in). Sin Express, sin auth/sesion/membership, sin
//   Host, sin Control, sin sqlite3: este modulo no abre bases, no resuelve handles y no verifica nada
//   (eso es de F1). El contexto NO AUTORIZA: solo transporta estado runtime en el que el caller ya confia.
// - No existe tenant "actual" global ni por defecto. Fuera de runWithTenantHandle no hay contexto;
//   requerir este modulo (o backend/db.js, o los servicios) jamas crea uno.
// - El store es inmutable: ningun caller puede cambiar el binding empresa/path/conexion en mitad de una
//   cadena. La conexion sqlite del handle NO se congela y su ciclo de vida sigue siendo del registry.
// - Anidamiento: semantica de pila (A -> B -> vuelta a A). Es solo semantica de contexto; si el
//   cambio de tenant anidado esta permitido operativamente lo decide una fase posterior (MT-1F3+).
const { AsyncLocalStorage } = require("async_hooks");

const almacen = new AsyncLocalStorage();

const CODIGO_HANDLE_INVALIDO = "TENANT_CONTEXT_INVALID_HANDLE";

function crearErrorHandleInvalido(motivo) {
  const error = new TypeError(`runWithTenantHandle: ${motivo}`);
  error.code = CODIGO_HANDLE_INVALIDO;
  return error;
}

function esConexionUtilizable(db) {
  return db !== null
    && typeof db === "object"
    && typeof db.run === "function"
    && typeof db.get === "function"
    && typeof db.all === "function";
}

// Valida la FORMA de un handle antes de entrar al contexto. No reabre la base ni reverifica baseline:
// F1 es duena de la verificacion. Devuelve el motivo del rechazo, o null si el handle es aceptable.
function motivoDeRechazo(handle) {
  if (handle === null || typeof handle !== "object" || Array.isArray(handle)) return "el handle debe ser un objeto";
  if (!Object.isFrozen(handle)) return "el handle debe estar congelado (handle verificado e inmutable)";
  if (!Number.isInteger(handle.empresaId) || handle.empresaId <= 0) return "empresaId invalido";
  if (typeof handle.empresaSlug !== "string" || handle.empresaSlug.length === 0 || handle.empresaSlug !== handle.empresaSlug.trim()) return "empresaSlug invalido";
  if (typeof handle.canonicalPath !== "string" || handle.canonicalPath.trim().length === 0) return "canonicalPath invalido";
  if (!esConexionUtilizable(handle.db)) return "el handle no trae una conexion db utilizable";
  return null;
}

// Ejecuta `callback` con `handle` como tenant activo para TODA su cadena async. Valida ANTES de entrar:
// un handle invalido lanza de forma sincrona y `callback` nunca se invoca. Devuelve lo que devuelva
// `callback` (tipicamente una promesa). Si `callback` lanza o rechaza, el error se propaga y el
// contexto desaparece al salir; nada se cierra ni se invalida.
function runWithTenantHandle(handle, callback) {
  const motivo = motivoDeRechazo(handle);
  if (motivo) throw crearErrorHandleInvalido(motivo);
  if (typeof callback !== "function") throw crearErrorHandleInvalido("callback debe ser una funcion");

  const contexto = Object.freeze({
    tenantHandle: handle,
    empresaId: handle.empresaId,
    empresaSlug: handle.empresaSlug,
    canonicalPath: handle.canonicalPath
  });
  return almacen.run(contexto, callback);
}

// Store inmutable del contexto activo, o null si no hay ninguno.
function getTenantContext() {
  const contexto = almacen.getStore();
  return contexto === undefined ? null : contexto;
}

// Handle verificado del contexto activo, o null si no hay ninguno.
function getTenantHandle() {
  const contexto = almacen.getStore();
  return contexto === undefined ? null : contexto.tenantHandle;
}

function hasTenantContext() {
  return almacen.getStore() !== undefined;
}

module.exports = {
  runWithTenantHandle,
  getTenantContext,
  getTenantHandle,
  hasTenantContext
};
