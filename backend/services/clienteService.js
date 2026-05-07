const { getQuery } = require("../db");

function parseClientePayload(body) {
  return {
    nombre: String(body.nombre || "").trim(),
    dni_cuit: String(body.dni_cuit || body.cuit || "").trim(),
    tipo_persona: String(body.tipo_persona || "fisica").trim().toLowerCase(),
    telefono: String(body.telefono || "").trim(),
    email: String(body.email || "").trim(),
    contacto: String(body.contacto || "").trim(),
    direccion: String(body.direccion || "").trim(),
    localidad: String(body.localidad || "").trim(),
    codigo_postal: String(body.codigo_postal || "").trim(),
    alias: String(body.alias || "").trim(),
    observaciones: String(body.observaciones || "").trim(),
    notas: String(body.notas || "").trim(),
    foto_url: String(body.foto_url || "").trim(),
    limite_fiado: Math.max(0, Number(body.limite_fiado) || 0),
    dias_vencimiento: Math.max(0, Number(body.dias_vencimiento) || 30),
    dia_vencimiento_fijo: body.dia_vencimiento_fijo ? Number(body.dia_vencimiento_fijo) : null,
    moneda: String(body.moneda || "ARS").trim().toUpperCase(),
    habilita_cuenta_corriente: body.habilita_cuenta_corriente === false || Number(body.habilita_cuenta_corriente) === 0 ? 0 : 1,
    activo: body.activo === false || Number(body.activo) === 0 ? 0 : 1
  };
}

async function buildClienteCuentaResumen(clienteId) {
  const cuenta = await getQuery(
    `SELECT COALESCE(SUM(saldo_pendiente), 0) AS deuda_actual,
            MIN(CASE WHEN saldo_pendiente > 0 THEN fecha ELSE NULL END) AS primera_deuda,
            MAX(CASE WHEN es_cuenta_corriente = 1 THEN fecha ELSE NULL END) AS ultima_venta
     FROM ventas
     WHERE cliente_id = ? AND es_cuenta_corriente = 1`,
    [clienteId]
  );
  const pago = await getQuery(
    `SELECT COALESCE(SUM(CASE WHEN fecha = date('now', 'localtime') THEN monto_pagado ELSE 0 END), 0) AS cobrado_hoy,
            MAX(fecha) AS ultimo_pago
     FROM pagos_cuenta_corriente
     WHERE cliente_id = ?`,
    [clienteId]
  );
  return {
    deuda_actual: Number(cuenta?.deuda_actual || 0),
    primera_deuda: cuenta?.primera_deuda || null,
    ultima_venta: cuenta?.ultima_venta || null,
    cobrado_hoy: Number(pago?.cobrado_hoy || 0),
    ultimo_pago: pago?.ultimo_pago || null
  };
}

async function getClienteConMetricas(clienteId) {
  const cliente = await getQuery("SELECT * FROM clientes WHERE id = ?", [clienteId]);
  if (!cliente) return null;
  return { ...cliente, ...(await buildClienteCuentaResumen(clienteId)) };
}

module.exports = { parseClientePayload, buildClienteCuentaResumen, getClienteConMetricas };
