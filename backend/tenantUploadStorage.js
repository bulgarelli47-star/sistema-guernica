// MT-1F5B: politica de rutas de upload tenant-aware, reutilizable y neutral respecto al
// filesystem real. Este modulo NO parsea Host, NO consulta Control, NO autentica usuarios, NO lee
// tenencia desde body/query y NO posee estado global de Express -- solo decide, a partir del
// contexto de tenant YA VERIFICADO (inyectado via getTenantContext), que ruta fisica absoluta
// corresponde a una categoria+filename dados. El server sigue siendo dueno de status HTTP,
// sendFile/streaming, cache headers, creacion de directorios y escritura de bytes.
//
// Regla legacy (SOLO Guernica, SOLO lectura): en central + multi, si el tenant resuelto es
// exactamente `legacyTenantSlug` (comparado contra el empresaSlug YA VERIFICADO del contexto,
// nunca reparseando Host ni consultando Control de nuevo), la lectura intenta primero la raiz
// tenant-especifica y, si no esta ahi, cae a la raiz legacy compartida. Para cualquier otro
// tenant NO existe ese fallback: solo su propia raiz.
const path = require("path");

const CATEGORIAS_VALIDAS = Object.freeze(["usuarios", "productos", "clientes", "configuracion"]);
const TENANCY_MODES = Object.freeze({ SINGLE: "single", MULTI: "multi" });

function esCategoriaValida(categoria) {
  return CATEGORIAS_VALIDAS.includes(categoria);
}

// Filename debe ser un basename puro: sin separadores (ni "/" ni "\"), sin byte nulo, sin "." ni
// ".." como nombre completo, no absoluto, y path.basename(filename) debe devolver EXACTAMENTE el
// mismo string -- asi se detecta cualquier variante que un decode previo (p.ej. %2e%2e, %2f) haya
// podido dejar en el string, sin depender solo del matching de rutas de Express.
function esFilenameValido(filename) {
  if (typeof filename !== "string" || filename.length === 0) return false;
  if (filename.includes("\0")) return false;
  if (filename.includes("/") || filename.includes("\\")) return false;
  if (filename === "." || filename === "..") return false;
  if (path.isAbsolute(filename)) return false;
  if (path.basename(filename) !== filename) return false;
  return true;
}

function crearTenantUploadStorage({ tenancyMode, getTenantContext, uploadsRoot, legacyTenantSlug = "guernica" } = {}) {
  if (tenancyMode !== TENANCY_MODES.SINGLE && tenancyMode !== TENANCY_MODES.MULTI) {
    throw new TypeError("crearTenantUploadStorage: tenancyMode invalido");
  }
  if (typeof getTenantContext !== "function") {
    throw new TypeError("crearTenantUploadStorage: getTenantContext debe ser funcion");
  }
  if (typeof uploadsRoot !== "string" || !uploadsRoot.trim()) {
    throw new TypeError("crearTenantUploadStorage: uploadsRoot requerido");
  }
  if (typeof legacyTenantSlug !== "string" || !legacyTenantSlug.trim()) {
    throw new TypeError("crearTenantUploadStorage: legacyTenantSlug requerido");
  }

  const legacyRoot = path.resolve(uploadsRoot);
  const tenantsRoot = path.resolve(uploadsRoot, "tenants");

  function resolverEmpresaId() {
    const contexto = getTenantContext();
    if (!contexto || !Number.isInteger(contexto.empresaId) || contexto.empresaId <= 0) return null;
    return contexto.empresaId;
  }

  function resolverEmpresaSlug() {
    const contexto = getTenantContext();
    if (!contexto || typeof contexto.empresaSlug !== "string") return null;
    const slug = contexto.empresaSlug.trim();
    return slug || null;
  }

  function raizTenant(empresaId) {
    return path.join(tenantsRoot, String(empresaId));
  }

  // Defensa adicional (no la unica): confirma que rutaAbsoluta quede estrictamente dentro de raiz
  // luego de resolver ambos paths, independiente de que el server luego tambien contenga via
  // res.sendFile({root}).
  function dentroDeRaiz(raiz, rutaAbsoluta) {
    const raizResuelta = path.resolve(raiz);
    const rutaResuelta = path.resolve(rutaAbsoluta);
    return rutaResuelta === raizResuelta || rutaResuelta.startsWith(raizResuelta + path.sep);
  }

  function construirRuta(raiz, categoria, filename) {
    const raizCategoria = path.join(raiz, categoria);
    const rutaAbsoluta = path.join(raizCategoria, filename);
    if (!dentroDeRaiz(raizCategoria, rutaAbsoluta)) return null;
    return rutaAbsoluta;
  }

  // Destino de escritura para el request actual. Fail-closed: null si categoria/filename no
  // validan, o si en multi el contexto de tenant es invalido/ausente -- nunca se cae a una raiz
  // compartida ni al singleton legacy.
  function resolverDestinoEscritura({ categoria, filename }) {
    if (!esCategoriaValida(categoria) || !esFilenameValido(filename)) return null;

    if (tenancyMode === TENANCY_MODES.SINGLE) {
      const ruta = construirRuta(legacyRoot, categoria, filename);
      if (!ruta) return null;
      return { directorio: path.join(legacyRoot, categoria), ruta };
    }

    const empresaId = resolverEmpresaId();
    if (empresaId === null) return null;
    const raiz = raizTenant(empresaId);
    const ruta = construirRuta(raiz, categoria, filename);
    if (!ruta) return null;
    return { directorio: path.join(raiz, categoria), ruta };
  }

  // Candidatos de lectura EN ORDEN para el request actual. Fail-closed: array vacio si categoria/
  // filename no validan, o si en multi el contexto de tenant es invalido/ausente -- jamas cae a la
  // raiz legacy compartida para un tenant sin contexto resuelto.
  function resolverCandidatosLectura({ categoria, filename }) {
    if (!esCategoriaValida(categoria) || !esFilenameValido(filename)) return [];

    if (tenancyMode === TENANCY_MODES.SINGLE) {
      const ruta = construirRuta(legacyRoot, categoria, filename);
      return ruta ? [ruta] : [];
    }

    const empresaId = resolverEmpresaId();
    if (empresaId === null) return [];
    const rutaTenant = construirRuta(raizTenant(empresaId), categoria, filename);
    if (!rutaTenant) return [];

    const candidatos = [rutaTenant];
    if (resolverEmpresaSlug() === legacyTenantSlug) {
      const rutaLegacy = construirRuta(legacyRoot, categoria, filename);
      if (rutaLegacy) candidatos.push(rutaLegacy);
    }
    return candidatos;
  }

  return Object.freeze({
    resolverDestinoEscritura,
    resolverCandidatosLectura
  });
}

module.exports = {
  TENANCY_MODES,
  CATEGORIAS_VALIDAS,
  esCategoriaValida,
  esFilenameValido,
  crearTenantUploadStorage
};
