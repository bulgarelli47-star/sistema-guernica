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

function normalizarPayload(payload = {}) {
  return {
    nombre: normalizarTexto(payload.nombre),
    tipo_pago_codigo: normalizarCodigo(payload.tipo_pago_codigo),
    tipo_cuenta: normalizarTexto(payload.tipo_cuenta || "interna").toLowerCase(),
    proveedor_integracion: normalizarTexto(payload.proveedor_integracion || ""),
    activo: normalizarActivo(payload.activo, 1),
    orden: Number(payload.orden) || 0,
    alias: normalizarTexto(payload.alias),
    cbu_cvu: normalizarTexto(payload.cbu_cvu),
    external_id: normalizarTexto(payload.external_id),
    terminal_id: normalizarTexto(payload.terminal_id),
    store_id: normalizarTexto(payload.store_id),
    pos_id: normalizarTexto(payload.pos_id),
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

async function getCuentasCobro({ todos = false } = {}) {
  return allQuery(
    `SELECT id, nombre, tipo_pago_codigo, tipo_cuenta, proveedor_integracion, activo, orden,
            alias, cbu_cvu, external_id, terminal_id, store_id, pos_id, metadata_json,
            created_at, updated_at
     FROM cuentas_cobro
     ${todos ? "" : "WHERE activo = 1"}
     ORDER BY orden ASC, nombre ASC`
  );
}

async function getCuentasCobroPorTipo(codigo) {
  return allQuery(
    `SELECT id, nombre, tipo_pago_codigo, tipo_cuenta, proveedor_integracion, activo, orden,
            alias, cbu_cvu, external_id, terminal_id, store_id, pos_id, metadata_json,
            created_at, updated_at
     FROM cuentas_cobro
     WHERE activo = 1 AND tipo_pago_codigo = ?
     ORDER BY orden ASC, nombre ASC`,
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

  const result = await runQuery(
    `INSERT INTO cuentas_cobro
     (nombre, tipo_pago_codigo, tipo_cuenta, proveedor_integracion, activo, orden,
      alias, cbu_cvu, external_id, terminal_id, store_id, pos_id, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
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
      data.metadata_json
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

  await runQuery(
    `UPDATE cuentas_cobro
     SET nombre = ?, tipo_pago_codigo = ?, tipo_cuenta = ?, proveedor_integracion = ?,
         activo = ?, orden = ?, alias = ?, cbu_cvu = ?, external_id = ?, terminal_id = ?,
         store_id = ?, pos_id = ?, metadata_json = ?, updated_at = datetime('now')
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

module.exports = {
  getCuentasCobro,
  getCuentasCobroPorTipo,
  crearCuentaCobro,
  actualizarCuentaCobro,
  toggleActivoCuentaCobro,
  validarCuentaCobroParaTipo
};
