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

async function listarTerminalesPoint(accessToken, { store_id, pos_id } = {}) {
  const params = new URLSearchParams({ limit: "50", offset: "0" });
  if (store_id) params.set("store_id", String(store_id));
  if (pos_id) params.set("pos_id", String(pos_id));
  const url = `https://api.mercadopago.com/terminals/v1/list?${params.toString()}`;

  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
  } catch (netErr) {
    const err = new Error("No se pudo conectar con Mercado Pago: " + netErr.message);
    err.statusCode = 502;
    throw err;
  }

  let data;
  try {
    data = await res.json();
  } catch {
    const err = new Error("Respuesta inesperada de Mercado Pago (no es JSON)");
    err.statusCode = 502;
    throw err;
  }

  if (!res.ok) {
    const mpMsg = data?.message || data?.error || "";
    let msg;
    let statusCode;
    if (res.status === 401 || res.status === 403) {
      msg = "Access token inválido o sin permisos Mercado Pago Point";
      statusCode = 401;
    } else if (res.status === 404) {
      msg = "Cuenta sin Mercado Pago Point habilitado";
      statusCode = 404;
    } else if (res.status === 429) {
      msg = "Rate limit de Mercado Pago alcanzado, esperá un momento";
      statusCode = 429;
    } else {
      msg = mpMsg || `Error Mercado Pago (HTTP ${res.status})`;
      statusCode = 502;
    }
    const err = new Error(msg);
    err.statusCode = statusCode;
    throw err;
  }

  const terminals = Array.isArray(data.terminals) ? data.terminals : [];
  const paging = data.paging || {};
  return {
    total: paging.total != null ? paging.total : terminals.length,
    terminales: terminals.map((t) => ({
      terminal_id: t.id || null,
      store_id: t.store_id || null,
      pos_id: t.pos_id != null ? t.pos_id : null,
      operating_mode: t.operating_mode || null,
      estado: (t.status && typeof t.status === "object" ? t.status.state : t.status) || null,
      nombre: t.name || null
    })),
    mensaje: terminals.length === 0 ? "No hay terminales Point registradas en esta cuenta" : null
  };
}

async function llamarMpDebug(url, options) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (netErr) {
    return { error_red: netErr.message, http_status: null, content_type: null, raw: null, raw_text: null };
  }

  const content_type = res.headers.get("content-type") || "";
  let raw_text = null;
  try {
    raw_text = await res.text();
  } catch (textErr) {
    raw_text = `[no se pudo leer body: ${textErr.message}]`;
  }

  let raw = null;
  if (raw_text) {
    try {
      raw = JSON.parse(raw_text);
    } catch {
      // body no es JSON, raw_text lo conserva
    }
  }

  console.log(
    `[MP Debug] ${options.method || "GET"} ${url} → HTTP ${res.status} | content-type: ${content_type} | body(120): ${String(raw_text || "").slice(0, 120)}`
  );

  return {
    http_status: res.status,
    content_type,
    raw: raw || null,
    raw_text: raw ? undefined : String(raw_text || "").slice(0, 2000)
  };
}

async function crearOrdenPointDiagnostico(accessToken, { terminal_id, monto, store_id, pos_id } = {}) {
  const external_reference = generarExternalReference();
  const idempotency_key = generarIdempotencyKey();
  const amount = normalizarMonto(monto);
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "X-Idempotency-Key": idempotency_key
  };

  // Intento 1: payment-intents — body mínimo sin description/payment (rechazados por MP)
  const urlPaymentIntents = `https://api.mercadopago.com/point/integration-api/devices/${encodeURIComponent(terminal_id)}/payment-intents`;
  const bodyPaymentIntents = {
    amount,
    additional_info: { external_reference }
  };
  const resultPaymentIntents = await llamarMpDebug(urlPaymentIntents, {
    method: "POST",
    headers,
    body: JSON.stringify(bodyPaymentIntents)
  });

  // Intento 2: /v1/orders con type "point" — schema corregido según errores MP
  // transactions debe ser objeto (no array); config.point lleva terminal_id; sin total_amount
  const urlOrders = "https://api.mercadopago.com/v1/orders";
  // config.point solo acepta terminal_id — store_id/pos_id NO van aquí según error MP
  const bodyOrders = {
    type: "point",
    external_reference,
    transactions: {
      payments: [{ amount: String(amount.toFixed(2)) }]
    },
    config: { point: { terminal_id } }
  };
  const resultOrders = await llamarMpDebug(urlOrders, {
    method: "POST",
    headers: { ...headers, "X-Idempotency-Key": generarIdempotencyKey() },
    body: JSON.stringify(bodyOrders)
  });

  return {
    external_reference,
    idempotency_key,
    terminal_id,
    monto: amount,
    payment_intents: { url: urlPaymentIntents, body: bodyPaymentIntents, ...resultPaymentIntents },
    v1_orders: { url: urlOrders, body: bodyOrders, ...resultOrders }
  };
}

module.exports = {
  ensureMercadoPagoPointSchema,
  crearIntentoPoint,
  obtenerIntentoPoint,
  listarIntentosPoint,
  actualizarIntentoPointEstado,
  listarTerminalesPoint,
  crearOrdenPointDiagnostico,
  ESTADOS_INTENTO_POINT
};
