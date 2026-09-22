// MT-1F5C1: repositorio + maquina de estados de resolucion de credenciales de integraciones
// tenant-owned. Ver MT-1F5C-D1/D1A/D1B/D1C para la autoridad de diseno completa -- este modulo
// implementa exactamente esas maquinas de estado, sin desviacion.
//
// CRITICO (D1B Parte L / checkpoint de implementacion): backend/db.js cae a su singleton legacy
// cuando NO hay contexto de tenant activo -- comportamiento legitimo en modo single, pero en modo
// multi NUNCA debe alcanzarse silenciosamente. Por eso este modulo exige un getTenantContext()
// valido ANTES de tocar runQuery/getQuery en modo multi, nunca delega esa distincion a db.js.
//
// El fallback a MERCADOPAGO_ACCESS_TOKEN es una afinidad EXPLICITA y unica de mercadopago_point en
// modo single/legacy-single -- no es un mecanismo generico para cualquier provider futuro. En modo
// multi jamas se consulta, sin excepcion, en ningun estado.
const { runQuery, getQuery } = require("../db");
const { encriptarSecreto, desencriptarSecreto } = require("../integrationSecretCrypto");

const TENANCY_MODES = Object.freeze({ SINGLE: "single", MULTI: "multi" });

const PROVIDER_MERCADOPAGO_POINT = "mercadopago_point";
const LEGACY_ENV_VAR = "MERCADOPAGO_ACCESS_TOKEN";
const LEGACY_ENV_PROVIDERS = new Set([PROVIDER_MERCADOPAGO_POINT]);

const RESOLUTION_STATES = Object.freeze({
  LEGACY_UNMANAGED: "LEGACY_UNMANAGED",
  NOT_CONFIGURED: "NOT_CONFIGURED",
  DISABLED: "DISABLED",
  OPERATIONAL_SECRET_FAILURE: "OPERATIONAL_SECRET_FAILURE",
  OK: "OK"
});

function crearError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function crearIntegracionTenantService({ tenancyMode, getTenantContext } = {}) {
  if (tenancyMode !== TENANCY_MODES.SINGLE && tenancyMode !== TENANCY_MODES.MULTI) {
    throw new TypeError("crearIntegracionTenantService: tenancyMode invalido");
  }
  if (typeof getTenantContext !== "function") {
    throw new TypeError("crearIntegracionTenantService: getTenantContext debe ser funcion");
  }

  function exigirContextoSiMulti() {
    if (tenancyMode !== TENANCY_MODES.MULTI) return;
    const contexto = getTenantContext();
    if (!contexto || !Number.isInteger(contexto.empresaId) || contexto.empresaId <= 0) {
      throw crearError("TENANT_CONTEXT_REQUIRED", "Operacion de integracion requiere contexto de tenant valido en modo multi");
    }
  }

  function envCredencialDisponible(provider) {
    if (tenancyMode !== TENANCY_MODES.SINGLE) return false;
    if (!LEGACY_ENV_PROVIDERS.has(provider)) return false;
    const valor = process.env[LEGACY_ENV_VAR];
    return typeof valor === "string" && valor.trim().length > 0;
  }

  function leerEnvCredencial(provider) {
    return envCredencialDisponible(provider) ? process.env[LEGACY_ENV_VAR].trim() : null;
  }

  async function leerIntegracion(provider) {
    return getQuery("SELECT * FROM integraciones_tenant WHERE provider = ?", [provider]);
  }

  async function leerSecreto(integracionId) {
    return getQuery("SELECT * FROM integraciones_tenant_secretos WHERE integracion_id = ?", [integracionId]);
  }

  // Estado seguro para exponer eventualmente via API (F5C2): jamas incluye secreto, ciphertext,
  // secret_meta_json ni ningun detalle de la master key.
  async function leerEstadoSeguro(provider) {
    exigirContextoSiMulti();
    const fila = await leerIntegracion(provider);
    if (!fila) {
      return {
        managed: false,
        enabled: false,
        credential_configured: false,
        legacy_env_fallback_active: envCredencialDisponible(provider)
      };
    }
    const secretoFila = await leerSecreto(fila.id);
    return {
      managed: true,
      enabled: Number(fila.enabled) === 1,
      credential_configured: Boolean(secretoFila),
      legacy_env_fallback_active: false
    };
  }

  // Maquina de estados de resolucion de credencial para uso interno de una llamada externa al
  // provider. Ver MT-1F5C-D1B Partes F/G -- implementadas exactamente aqui, ambos modos.
  async function resolverCredencial(provider) {
    exigirContextoSiMulti();

    const fila = await leerIntegracion(provider);

    if (!fila) {
      if (envCredencialDisponible(provider)) {
        return { state: RESOLUTION_STATES.LEGACY_UNMANAGED, credential: leerEnvCredencial(provider), source: "env" };
      }
      return { state: RESOLUTION_STATES.NOT_CONFIGURED, credential: null, source: null };
    }

    // Fila existe: DB_MANAGED, uno-solo-direccion. Env jamas se consulta de aca en adelante.
    if (Number(fila.enabled) !== 1) {
      return { state: RESOLUTION_STATES.DISABLED, credential: null, source: null };
    }

    const secretoFila = await leerSecreto(fila.id);
    if (!secretoFila) {
      return { state: RESOLUTION_STATES.NOT_CONFIGURED, credential: null, source: null };
    }

    let plaintext;
    try {
      plaintext = desencriptarSecreto(secretoFila.secret_encrypted, secretoFila.secret_meta_json);
    } catch (error) {
      return { state: RESOLUTION_STATES.OPERATIONAL_SECRET_FAILURE, credential: null, source: null };
    }

    return { state: RESOLUTION_STATES.OK, credential: plaintext, source: "db" };
  }

  // SET/REPLACE. Sobre un provider ausente, crea la fila de metadata (enabled=0 por defecto de
  // schema) y transiciona LEGACY_UNMANAGED -> DB_MANAGED de forma permanente dentro del alcance de
  // F5C. admin-only es responsabilidad del caller HTTP (F5C2); este modulo no conoce permisos.
  async function establecerCredencial(provider, plaintextSecret, { configJson } = {}) {
    exigirContextoSiMulti();
    if (typeof plaintextSecret !== "string" || plaintextSecret.length === 0) {
      throw crearError("SECRET_REQUIRED", "establecerCredencial: se requiere un secreto no vacio explicito");
    }
    const ahora = new Date().toISOString();

    let fila = await leerIntegracion(provider);
    if (!fila) {
      await runQuery(
        "INSERT INTO integraciones_tenant (provider, enabled, config_json, created_at, updated_at) VALUES (?, 0, ?, ?, ?)",
        [provider, configJson === undefined ? "{}" : JSON.stringify(configJson), ahora, ahora]
      );
      fila = await leerIntegracion(provider);
    }

    const { secret_encrypted, secret_meta_json } = encriptarSecreto(plaintextSecret);
    const existente = await leerSecreto(fila.id);
    if (existente) {
      await runQuery(
        "UPDATE integraciones_tenant_secretos SET secret_encrypted = ?, secret_meta_json = ?, updated_at = ? WHERE integracion_id = ?",
        [secret_encrypted, secret_meta_json, ahora, fila.id]
      );
    } else {
      await runQuery(
        "INSERT INTO integraciones_tenant_secretos (integracion_id, secret_encrypted, secret_meta_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        [fila.id, secret_encrypted, secret_meta_json, ahora, ahora]
      );
    }
    return { managed: true };
  }

  // REMOVE: borra UNICAMENTE la fila de secreto. Nunca la fila de metadata, nunca deshabilita.
  async function quitarCredencial(provider) {
    exigirContextoSiMulti();
    const fila = await leerIntegracion(provider);
    if (!fila) return { removed: false };
    await runQuery("DELETE FROM integraciones_tenant_secretos WHERE integracion_id = ?", [fila.id]);
    return { removed: true };
  }

  // ENABLE/DISABLE: requiere que la integracion ya este DB_MANAGED (creada via establecerCredencial).
  // Nunca lee ni reescribe el secreto.
  async function establecerHabilitado(provider, enabled) {
    exigirContextoSiMulti();
    const fila = await leerIntegracion(provider);
    if (!fila) {
      throw crearError("INTEGRATION_NOT_MANAGED", "No existe integracion para este provider: configura una credencial primero");
    }
    await runQuery(
      "UPDATE integraciones_tenant SET enabled = ?, updated_at = ? WHERE id = ?",
      [enabled ? 1 : 0, new Date().toISOString(), fila.id]
    );
    return { managed: true, enabled: Boolean(enabled) };
  }

  return Object.freeze({
    leerEstadoSeguro,
    resolverCredencial,
    establecerCredencial,
    quitarCredencial,
    establecerHabilitado
  });
}

module.exports = {
  TENANCY_MODES,
  PROVIDER_MERCADOPAGO_POINT,
  LEGACY_ENV_VAR,
  RESOLUTION_STATES,
  crearIntegracionTenantService
};
