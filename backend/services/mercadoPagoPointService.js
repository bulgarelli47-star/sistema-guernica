const crypto = require("crypto");
const { allQuery, getQuery, runQuery } = require("../db");

const ESTADOS_INTENTO_POINT = new Set([
  "pendiente_mp",
  "at_terminal",
  "aprobado",
  "rechazado",
  "cancelado",
  "expirado",
  "error"
]);

function normalizarMonto(valor) {
  return Number(Number(valor || 0).toFixed(2));
}

function generarExternalReference() {
  return `MPPOINT-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function generarIdempotencyKey() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

async function ensureMercadoPagoPointSchema() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS mercado_pago_intentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venta_id INTEGER,
      cuenta_cobro_id INTEGER NOT NULL,
      cuenta_destino_id INTEGER,
      mp_order_id TEXT,
      mp_payment_id TEXT,
      external_reference TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      terminal_id TEXT NOT NULL,
      store_id TEXT,
      pos_id TEXT,
      monto_total REAL NOT NULL,
      estado TEXT NOT NULL,
      status_detail TEXT,
      request_json TEXT,
      response_json TEXT,
      webhook_json TEXT,
      error_message TEXT,
      created_at TEXT,
      updated_at TEXT,
      aprobado_at TEXT,
      cancelado_at TEXT
    )
  `);
  await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS idx_mp_intentos_external_reference ON mercado_pago_intentos(external_reference)");
  await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS idx_mp_intentos_idempotency_key ON mercado_pago_intentos(idempotency_key)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_mp_intentos_estado ON mercado_pago_intentos(estado)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_mp_intentos_venta ON mercado_pago_intentos(venta_id)");
}

function mapIntento(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    venta_id: row.venta_id == null ? null : Number(row.venta_id),
    cuenta_cobro_id: Number(row.cuenta_cobro_id),
    cuenta_destino_id: row.cuenta_destino_id == null ? null : Number(row.cuenta_destino_id),
    monto_total: normalizarMonto(row.monto_total)
  };
}

async function validarCuentaPoint(cuentaCobroId) {
  const cuentaId = Number(cuentaCobroId);
  if (!cuentaId) {
    const error = new Error("Cuenta de cobro invalida");
    error.statusCode = 400;
    throw error;
  }

  const cuenta = await getQuery("SELECT * FROM cuentas_cobro WHERE id = ?", [cuentaId]);
  if (!cuenta || Number(cuenta.activo) !== 1) {
    const error = new Error("Cuenta de cobro inexistente o inactiva");
    error.statusCode = 400;
    throw error;
  }

  if (String(cuenta.proveedor_integracion || "").trim().toLowerCase() !== "mercadopago_point") {
    const error = new Error("La cuenta de cobro no es Mercado Pago Point");
    error.statusCode = 400;
    throw error;
  }

  if (!String(cuenta.terminal_id || "").trim()) {
    const error = new Error("La cuenta Mercado Pago Point no tiene terminal_id configurado");
    error.statusCode = 400;
    throw error;
  }

  return cuenta;
}

async function crearIntentoPoint({ cuenta_cobro_id, monto_total, venta_id = null }) {
  const monto = normalizarMonto(monto_total);
  if (monto <= 0) {
    const error = new Error("El monto del intento debe ser mayor a cero");
    error.statusCode = 400;
    throw error;
  }

  const cuenta = await validarCuentaPoint(cuenta_cobro_id);
  const externalReference = generarExternalReference();
  const idempotencyKey = generarIdempotencyKey();
  const now = new Date().toISOString();

  const request = {
    type: "point",
    external_reference: externalReference,
    cuenta_cobro_id: Number(cuenta.id),
    terminal_id: cuenta.terminal_id,
    store_id: cuenta.store_id || null,
    pos_id: cuenta.pos_id || null,
    monto_total: monto
  };

  const result = await runQuery(
    `INSERT INTO mercado_pago_intentos
     (venta_id, cuenta_cobro_id, cuenta_destino_id, external_reference, idempotency_key,
      terminal_id, store_id, pos_id, monto_total, estado, request_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente_mp', ?, ?, ?)`,
    [
      venta_id == null || venta_id === "" ? null : Number(venta_id),
      Number(cuenta.id),
      cuenta.cuenta_destino_id == null ? null : Number(cuenta.cuenta_destino_id),
      externalReference,
      idempotencyKey,
      String(cuenta.terminal_id),
      cuenta.store_id || null,
      cuenta.pos_id || null,
      monto,
      JSON.stringify(request),
      now,
      now
    ]
  );

  return obtenerIntentoPoint(result.lastID);
}

async function obtenerIntentoPoint(id) {
  return mapIntento(await getQuery("SELECT * FROM mercado_pago_intentos WHERE id = ?", [Number(id)]));
}

async function listarIntentosPoint({ estado } = {}) {
  const estadoNormalizado = String(estado || "").trim().toLowerCase();
  if (estadoNormalizado) {
    return (await allQuery(
      "SELECT * FROM mercado_pago_intentos WHERE estado = ? ORDER BY id DESC",
      [estadoNormalizado]
    )).map(mapIntento);
  }
  return (await allQuery("SELECT * FROM mercado_pago_intentos ORDER BY id DESC")).map(mapIntento);
}

async function actualizarIntentoPointEstado(id, { estado, status_detail = "", mp_order_id = null, mp_payment_id = null, response_json = null, webhook_json = null, error_message = "" } = {}) {
  const estadoNormalizado = String(estado || "").trim().toLowerCase();
  if (!ESTADOS_INTENTO_POINT.has(estadoNormalizado)) {
    const error = new Error("Estado de intento Mercado Pago Point invalido");
    error.statusCode = 400;
    throw error;
  }

  const now = new Date().toISOString();
  await runQuery(
    `UPDATE mercado_pago_intentos
     SET estado = ?, status_detail = ?, mp_order_id = COALESCE(?, mp_order_id),
         mp_payment_id = COALESCE(?, mp_payment_id), response_json = COALESCE(?, response_json),
         webhook_json = COALESCE(?, webhook_json), error_message = ?,
         updated_at = ?, aprobado_at = CASE WHEN ? = 'aprobado' THEN ? ELSE aprobado_at END,
         cancelado_at = CASE WHEN ? = 'cancelado' THEN ? ELSE cancelado_at END
     WHERE id = ?`,
    [
      estadoNormalizado,
      status_detail,
      mp_order_id,
      mp_payment_id,
      response_json == null ? null : JSON.stringify(response_json),
      webhook_json == null ? null : JSON.stringify(webhook_json),
      error_message,
      now,
      estadoNormalizado,
      now,
      estadoNormalizado,
      now,
      Number(id)
    ]
  );
  return obtenerIntentoPoint(id);
}

module.exports = {
  ensureMercadoPagoPointSchema,
  crearIntentoPoint,
  obtenerIntentoPoint,
  listarIntentosPoint,
  actualizarIntentoPointEstado,
  ESTADOS_INTENTO_POINT
};
