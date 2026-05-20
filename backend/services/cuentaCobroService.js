const { allQuery, getQuery, runQuery } = require("../db");

function normalizarTexto(valor) {
  return String(valor || "").trim();
}

function normalizarCodigo(valor) {
  return normalizarTexto(valor).toLowerCase();
}

function normalizarActivo(valor, fallback = 1) {
  if (valor === undefined || valor === null || valor === "") return fallback;
  return valor === false || valor === 0 || valor === "0" ? 0 : 1;
}

function normalizarCampoIntegracion(valor) {
  const texto = normalizarTexto(valor);
  return texto === "0" ? "" : texto;
}

function normalizarPayload(payload = {}) {
  const cuentaDestinoId = payload.cuenta_destino_id === undefined || payload.cuenta_destino_id === null || payload.cuenta_destino_id === ""
    ? null
    : Number(payload.cuenta_destino_id) || null;
  return {
    nombre: normalizarTexto(payload.nombre),
    tipo_pago_codigo: normalizarCodigo(payload.tipo_pago_codigo),
    tipo_cuenta: normalizarTexto(payload.tipo_cuenta || "interna").toLowerCase(),
    proveedor_integracion: normalizarCodigo(payload.proveedor_integracion || ""),
    activo: normalizarActivo(payload.activo, 1),
    orden: Number(payload.orden) || 0,
    alias: normalizarTexto(payload.alias),
    cbu_cvu: normalizarTexto(payload.cbu_cvu),
    external_id: normalizarCampoIntegracion(payload.external_id),
    terminal_id: normalizarCampoIntegracion(payload.terminal_id),
    store_id: normalizarCampoIntegracion(payload.store_id),
    pos_id: normalizarCampoIntegracion(payload.pos_id),
    cuenta_destino_id: cuentaDestinoId,
    metadata_json: payload.metadata_json == null
      ? null
      : typeof payload.metadata_json === "string"
        ? payload.metadata_json
        : JSON.stringify(payload.metadata_json)
  };
}

function validarPayloadCuenta(data) {
  if (!data.nombre) return "El nombre es obligatorio";
  if (!data.tipo_pago_codigo) return "El tipo de pago es obligatorio";
  if (!/^[a-z0-9_]+$/.test(data.tipo_pago_codigo)) {
    return "El tipo de pago solo puede tener letras, numeros y guiones bajos";
  }
  return null;
}

const TIPOS_DIGITALES_EXPLICITOS = new Set([
  "debito",
  "credito",
  "transferencia",
  "qr",
  "billetera",
  "mercado_pago"
]);

async function tipoPagoImpactaDigital(tipoPagoCodigo) {
  const tipo = normalizarCodigo(tipoPagoCodigo);
  if (!tipo || tipo === "efectivo" || tipo === "cuenta_corriente") return false;
  if (TIPOS_DIGITALES_EXPLICITOS.has(tipo)) return true;

  const row = await getQuery(
    "SELECT impacta_digital FROM tipos_pago WHERE codigo = ? LIMIT 1",
    [tipo]
  );
  return Number(row?.impacta_digital || 0) === 1;
}

async function validarConfiguracionCuentaCobro(data) {
  if (Number(data.activo) !== 1) return null;

  const impactaDigital = await tipoPagoImpactaDigital(data.tipo_pago_codigo);
  const proveedorExigeDestino = data.proveedor_integracion === "mercadopago_point" || data.proveedor_integracion === "mercadopago";
  if (impactaDigital || proveedorExigeDestino) {
    if (!data.cuenta_destino_id) {
      return "Este canal impacta dinero digital; requiere cuenta destino activa.";
    }

    const cuentaDestino = await getQuery(
      "SELECT id, activo FROM cuentas_destino WHERE id = ?",
      [data.cuenta_destino_id]
    );
    if (!cuentaDestino || Number(cuentaDestino.activo) !== 1) {
      return "La cuenta destino del canal debe existir y estar activa.";
    }
  }

  if (data.proveedor_integracion === "mercadopago_point" && !data.terminal_id) {
    return "Mercado Pago Point requiere Terminal ID.";
  }

  return null;
}

async function getCuentasCobro({ todos = false } = {}) {
  return allQuery(
    `SELECT cc.id, cc.nombre, cc.tipo_pago_codigo, cc.tipo_cuenta, cc.proveedor_integracion, cc.activo, cc.orden,
            cc.alias, cc.cbu_cvu, cc.external_id, cc.terminal_id, cc.store_id, cc.pos_id, cc.metadata_json,
            cc.cuenta_destino_id, cd.nombre AS cuenta_destino_nombre, cd.tipo_destino AS cuenta_destino_tipo,
            cc.created_at, cc.updated_at
     FROM cuentas_cobro cc
     LEFT JOIN cuentas_destino cd ON cd.id = cc.cuenta_destino_id
     ${todos ? "" : "WHERE cc.activo = 1"}
     ORDER BY cc.orden ASC, cc.nombre ASC`
  );
}

async function getCuentasCobroPorTipo(codigo) {
  return allQuery(
    `SELECT cc.id, cc.nombre, cc.tipo_pago_codigo, cc.tipo_cuenta, cc.proveedor_integracion, cc.activo, cc.orden,
            cc.alias, cc.cbu_cvu, cc.external_id, cc.terminal_id, cc.store_id, cc.pos_id, cc.metadata_json,
            cc.cuenta_destino_id, cd.nombre AS cuenta_destino_nombre, cd.tipo_destino AS cuenta_destino_tipo,
            cc.created_at, cc.updated_at
     FROM cuentas_cobro cc
     LEFT JOIN cuentas_destino cd ON cd.id = cc.cuenta_destino_id
     WHERE cc.activo = 1 AND cc.tipo_pago_codigo = ?
     ORDER BY cc.orden ASC, cc.nombre ASC`,
    [normalizarCodigo(codigo)]
  );
}

async function crearCuentaCobro(payload) {
  const data = normalizarPayload(payload);
  const error = validarPayloadCuenta(data);
  if (error) {
    const err = new Error(error);
    err.statusCode = 400;
    throw err;
  }
  const errorConfig = await validarConfiguracionCuentaCobro(data);
  if (errorConfig) {
    const err = new Error(errorConfig);
    err.statusCode = 400;
    throw err;
  }

  const result = await runQuery(
    `INSERT INTO cuentas_cobro
     (nombre, tipo_pago_codigo, tipo_cuenta, proveedor_integracion, activo, orden,
      alias, cbu_cvu, external_id, terminal_id, store_id, pos_id, metadata_json, cuenta_destino_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      data.nombre,
      data.tipo_pago_codigo,
      data.tipo_cuenta,
      data.proveedor_integracion,
      data.activo,
      data.orden,
      data.alias,
      data.cbu_cvu,
      data.external_id,
      data.terminal_id,
      data.store_id,
      data.pos_id,
      data.metadata_json,
      data.cuenta_destino_id
    ]
  );

  return getQuery("SELECT * FROM cuentas_cobro WHERE id = ?", [result.lastID]);
}

async function actualizarCuentaCobro(id, payload) {
  const data = normalizarPayload(payload);
  const error = validarPayloadCuenta(data);
  if (error) {
    const err = new Error(error);
    err.statusCode = 400;
    throw err;
  }
  const errorConfig = await validarConfiguracionCuentaCobro(data);
  if (errorConfig) {
    const err = new Error(errorConfig);
    err.statusCode = 400;
    throw err;
  }

  await runQuery(
    `UPDATE cuentas_cobro
     SET nombre = ?, tipo_pago_codigo = ?, tipo_cuenta = ?, proveedor_integracion = ?,
         activo = ?, orden = ?, alias = ?, cbu_cvu = ?, external_id = ?, terminal_id = ?,
         store_id = ?, pos_id = ?, metadata_json = ?, cuenta_destino_id = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [
      data.nombre,
      data.tipo_pago_codigo,
      data.tipo_cuenta,
      data.proveedor_integracion,
      data.activo,
      data.orden,
      data.alias,
      data.cbu_cvu,
      data.external_id,
      data.terminal_id,
      data.store_id,
      data.pos_id,
      data.metadata_json,
      data.cuenta_destino_id,
      Number(id)
    ]
  );

  return getQuery("SELECT * FROM cuentas_cobro WHERE id = ?", [Number(id)]);
}

async function toggleActivoCuentaCobro(id, activo) {
  await runQuery(
    "UPDATE cuentas_cobro SET activo = ?, updated_at = datetime('now') WHERE id = ?",
    [normalizarActivo(activo, 1), Number(id)]
  );
  return getQuery("SELECT * FROM cuentas_cobro WHERE id = ?", [Number(id)]);
}

async function validarCuentaCobroParaTipo(cuentaCobroId, tipoPagoCodigo) {
  if (cuentaCobroId === undefined || cuentaCobroId === null || cuentaCobroId === "") {
    return { ok: true, cuenta_cobro_id: null, cuenta: null };
  }

  const id = Number(cuentaCobroId);
  if (!id) {
    return { ok: false, statusCode: 400, message: "Cuenta de cobro invalida" };
  }

  const cuenta = await getQuery("SELECT * FROM cuentas_cobro WHERE id = ?", [id]);
  if (!cuenta || Number(cuenta.activo) !== 1) {
    return { ok: false, statusCode: 400, message: "Cuenta de cobro inexistente o inactiva" };
  }

  const tipo = normalizarCodigo(tipoPagoCodigo);
  if (tipo && normalizarCodigo(cuenta.tipo_pago_codigo) !== tipo) {
    return { ok: false, statusCode: 400, message: "La cuenta de cobro no corresponde al tipo de pago" };
  }

  return { ok: true, cuenta_cobro_id: id, cuenta };
}

function requiereCuentaCobroDigital(tipoPagoCodigo, cobro = {}) {
  const tipo = normalizarCodigo(tipoPagoCodigo);
  if (!tipo || tipo === "efectivo" || tipo === "cuenta_corriente") return false;
  if (tipo === "mixto") return Number(cobro.monto_debito || 0) > 0;
  return true;
}

function tipoCuentaCobroCompatible(tipoPagoCodigo) {
  const tipo = normalizarCodigo(tipoPagoCodigo);
  return tipo === "mixto" ? "debito" : tipo;
}

async function validarCuentaCobroVenta(cuentaCobroId, cobro = {}) {
  const tipo = normalizarCodigo(cobro.tipo_cobro);
  const requiereCuenta = requiereCuentaCobroDigital(tipo, cobro);

  if (requiereCuenta && (cuentaCobroId === undefined || cuentaCobroId === null || cuentaCobroId === "")) {
    return {
      ok: false,
      statusCode: 400,
      message: "Selecciona cuenta/terminal para cobros digitales"
    };
  }

  return validarCuentaCobroParaTipo(cuentaCobroId, tipoCuentaCobroCompatible(tipo));
}

async function validarCuentaCobroPago(cuentaCobroId, cobro = {}, { estado = "registrado" } = {}) {
  const tipo = normalizarCodigo(cobro.tipo_cobro || cobro.tipo_pago);
  const estaPendiente = normalizarCodigo(estado) === "pendiente";
  const tieneParteDigital = tipo === "mixto"
    ? Number(cobro.monto_debito || 0) > 0
    : await tipoPagoImpactaDigital(tipo);

  if (!estaPendiente && tieneParteDigital && (cuentaCobroId === undefined || cuentaCobroId === null || cuentaCobroId === "")) {
    return {
      ok: false,
      statusCode: 400,
      message: "Selecciona cuenta/terminal para registrar pagos digitales."
    };
  }

  return validarCuentaCobroParaTipo(cuentaCobroId, tipoCuentaCobroCompatible(tipo));
}

module.exports = {
  getCuentasCobro,
  getCuentasCobroPorTipo,
  crearCuentaCobro,
  actualizarCuentaCobro,
  toggleActivoCuentaCobro,
  validarCuentaCobroParaTipo,
  validarCuentaCobroPago,
  validarCuentaCobroVenta,
  requiereCuentaCobroDigital,
  tipoCuentaCobroCompatible
};
