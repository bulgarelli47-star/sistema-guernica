// MT-1F5C1: cifrado a nivel de aplicacion para credenciales de integraciones tenant-owned. Usa
// EXCLUSIVAMENTE el modulo crypto builtin de Node (AES-256-GCM) -- ninguna dependencia npm nueva.
//
// La master key (ATLAS_INTEGRATION_MASTER_KEY_B64) es material de INFRAESTRUCTURA (como descifrar),
// nunca la credencial de un provider (a quien pertenece un secreto ya descifrado) -- ver
// MT-1F5C-D1A Parte M / D1B Parte G. Nunca vive dentro de una tenant DB. Ausente, Base64 invalido o
// longitud decodificada != 32 bytes fallan cerrado siempre -- jamas se deriva, trunca, rellena o
// genera una key de reemplazo.
//
// secret_meta_json versiona el formato del ciphertext desde el dia uno (version/algorithm/
// key_version) para que una futura rotacion de key nunca tenga que adivinar el formato de una fila
// existente. Un secreto corrupto/alterado (JSON invalido, campos con forma incorrecta, auth tag que
// no valida) siempre falla como SECRET_DECRYPT_FAILED -- nunca hay fallback implicito a texto plano
// ni a ninguna otra fuente de credencial dentro de este modulo (esa decision de fallback, si alguna
// vez es legitima -- ej. env de un solo tenant -- es exclusiva de backend/services/integracionTenantService.js).
const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const CIPHERTEXT_VERSION = 1;
const KEY_VERSION = 1;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const MASTER_KEY_ENV_VAR = "ATLAS_INTEGRATION_MASTER_KEY_B64";
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function crearError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Base64 estricto: Buffer.from(str, "base64") de Node ignora silenciosamente caracteres fuera del
// alfabeto en vez de lanzar -- por eso se valida forma (charset + longitud multiplo de 4) Y se
// reencodea el buffer decodificado para confirmar un round-trip exacto antes de aceptar el valor.
function decodificarBase64Estricto(valorCrudo) {
  if (typeof valorCrudo !== "string") return null;
  const valor = valorCrudo.trim();
  if (!valor || valor.length % 4 !== 0 || !BASE64_PATTERN.test(valor)) return null;
  const buffer = Buffer.from(valor, "base64");
  if (buffer.toString("base64") !== valor) return null;
  return buffer;
}

function resolverMasterKey() {
  const raw = process.env[MASTER_KEY_ENV_VAR];
  if (typeof raw !== "string" || !raw.trim()) {
    throw crearError("MASTER_KEY_MISSING", `${MASTER_KEY_ENV_VAR} no esta configurada`);
  }
  const buffer = decodificarBase64Estricto(raw);
  if (!buffer) {
    throw crearError("MASTER_KEY_INVALID", `${MASTER_KEY_ENV_VAR} no es Base64 valido`);
  }
  if (buffer.length !== KEY_BYTES) {
    throw crearError("MASTER_KEY_INVALID", `${MASTER_KEY_ENV_VAR} debe decodificar a exactamente ${KEY_BYTES} bytes (recibido ${buffer.length})`);
  }
  return buffer;
}

// plaintext -> { secret_encrypted, secret_meta_json } listos para persistir. Fail closed (lanza)
// si la master key falta o es invalida -- nunca escribe texto plano como fallback.
function encriptarSecreto(plaintext) {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw crearError("PLAINTEXT_INVALID", "encriptarSecreto: plaintext debe ser un string no vacio");
  }
  const key = resolverMasterKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const secretMeta = {
    version: CIPHERTEXT_VERSION,
    algorithm: ALGORITHM,
    key_version: KEY_VERSION,
    iv_b64: iv.toString("base64"),
    auth_tag_b64: authTag.toString("base64")
  };

  return {
    secret_encrypted: encrypted.toString("base64"),
    secret_meta_json: JSON.stringify(secretMeta)
  };
}

// (secret_encrypted, secret_meta_json) -> plaintext. Fail closed en cualquier discrepancia: master
// key ausente/invalida, meta JSON malformado/con forma inesperada, version/algorithm/key_version no
// soportados, campos Base64 invalidos, o auth tag que no valida (dato corrupto o alterado). Nunca
// hay fallback a otra fuente dentro de este modulo.
function desencriptarSecreto(secretEncrypted, secretMetaJson) {
  const key = resolverMasterKey();

  let meta;
  try {
    meta = JSON.parse(secretMetaJson);
  } catch (error) {
    throw crearError("SECRET_DECRYPT_FAILED", "secret_meta_json invalido (no es JSON)");
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw crearError("SECRET_DECRYPT_FAILED", "secret_meta_json invalido (forma inesperada)");
  }
  if (meta.version !== CIPHERTEXT_VERSION) {
    throw crearError("SECRET_DECRYPT_FAILED", "secret_meta_json: version no soportada");
  }
  if (meta.algorithm !== ALGORITHM) {
    throw crearError("SECRET_DECRYPT_FAILED", "secret_meta_json: algorithm no soportado");
  }
  if (meta.key_version !== KEY_VERSION) {
    throw crearError("SECRET_DECRYPT_FAILED", "secret_meta_json: key_version no soportada");
  }

  const iv = decodificarBase64Estricto(meta.iv_b64);
  if (!iv || iv.length !== IV_BYTES) {
    throw crearError("SECRET_DECRYPT_FAILED", "secret_meta_json: iv_b64 invalido");
  }
  const authTag = decodificarBase64Estricto(meta.auth_tag_b64);
  if (!authTag) {
    throw crearError("SECRET_DECRYPT_FAILED", "secret_meta_json: auth_tag_b64 invalido");
  }
  const ciphertext = decodificarBase64Estricto(secretEncrypted);
  if (!ciphertext) {
    throw crearError("SECRET_DECRYPT_FAILED", "secret_encrypted invalido (no es Base64)");
  }

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (error) {
    throw crearError("SECRET_DECRYPT_FAILED", "No se pudo descifrar el secreto (dato corrupto o alterado)");
  }
}

module.exports = {
  ALGORITHM,
  CIPHERTEXT_VERSION,
  KEY_VERSION,
  MASTER_KEY_ENV_VAR,
  encriptarSecreto,
  desencriptarSecreto,
  resolverMasterKey
};
