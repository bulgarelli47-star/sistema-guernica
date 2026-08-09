const { allQuery, getQuery, runQuery } = require("../db");
const TIPOS_CUENTA_CORRIENTE_PERMITIDOS = new Set(["normal", "empleado", "empresa"]);
const PERFILES_CLIENTE_PERMITIDOS = new Set(["normal", "empleado", "empresa"]);

const TIPOS_CLIENTE_PERMITIDOS = new Set(["cliente", "colaborador", "dueño", "negocio"]);

function normalizarTipoCliente(valor) {
  const tipo = String(valor || "").trim().toLowerCase();
  return TIPOS_CLIENTE_PERMITIDOS.has(tipo) ? tipo : "cliente";
}

function normalizarPerfilCliente(valor) {
  const perfil = String(valor || "").trim().toLowerCase();
  return PERFILES_CLIENTE_PERMITIDOS.has(perfil) ? perfil : "normal";
}

function normalizarTipoCuentaCorriente(valor) {
  const tipo = String(valor || "").trim().toLowerCase();
  const legacy = { cliente: "normal", personal: "empleado", produccion: "empresa", interna: "empresa", cortesia: "empresa" };
  return TIPOS_CUENTA_CORRIENTE_PERMITIDOS.has(tipo) ? tipo : legacy[tipo] || "normal";
}

function parseClientePayload(body) {
  return {
    nombre: String(body.nombre || "").trim(),
    dni_cuit: String(body.dni_cuit || body.cuit || "").trim(),
    tipo_persona: String(body.tipo_persona || "fisica").trim().toLowerCase(),
    tipo_cliente: normalizarTipoCliente(body.tipo_cliente),
    tipo_cuenta_corriente: normalizarTipoCuentaCorriente(body.tipo_cuenta_corriente),
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
    activo: body.activo === false || Number(body.activo) === 0 ? 0 : 1,
    suspendido: body.suspendido === true || body.suspendido === 1 || body.suspendido === "1" ? 1 : 0,
    perfil_cliente: normalizarPerfilCliente(body.perfil_cliente),
    permite_excedente: body.permite_excedente === true || body.permite_excedente === 1 || body.permite_excedente === "1" ? 1 : 0,
    requiere_autorizacion: body.requiere_autorizacion === true || body.requiere_autorizacion === 1 || body.requiere_autorizacion === "1" ? 1 : 0,
    usa_reglas_personalizadas: body.usa_reglas_personalizadas === true || body.usa_reglas_personalizadas === 1 || body.usa_reglas_personalizadas === "1" ? 1 : 0
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

async function getHistorialProductosCliente(clienteId, { limite } = {}) {
  const limit = Math.min(Math.max(Number(limite) || 20, 1), 200);
  return allQuery(
    `SELECT dv.producto_id,
            COALESCE(dv.nombre_producto, p.nombre, 'Producto sin nombre') AS nombre_producto,
            COALESCE(SUM(dv.cantidad), 0) AS cantidad_total,
            COALESCE(SUM(dv.subtotal), 0) AS total_comprado,
            MAX(v.fecha) AS ultima_compra,
            COUNT(DISTINCT v.id) AS veces_comprado
     FROM detalle_ventas dv
     INNER JOIN ventas v ON v.id = dv.venta_id
     LEFT JOIN productos p ON p.id = dv.producto_id
     WHERE v.cliente_id = ?
       AND COALESCE(v.estado, '') != 'anulado'
       AND COALESCE(v.tipo, '') != 'test_modificadores'
     GROUP BY dv.producto_id, COALESCE(dv.nombre_producto, p.nombre, 'Producto sin nombre')
     ORDER BY ultima_compra DESC, veces_comprado DESC
     LIMIT ?`,
    [clienteId, limit]
  );
}

async function ensureRecalculosCuentaCorrienteTable() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS recalculos_cuenta_corriente (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_id INTEGER NOT NULL,
      deuda_historica REAL NOT NULL DEFAULT 0,
      deuda_actualizada REAL NOT NULL DEFAULT 0,
      diferencia REAL NOT NULL DEFAULT 0,
      usuario TEXT,
      motivo TEXT,
      fecha TEXT NOT NULL,
      hora TEXT NOT NULL,
      detalle_json TEXT,
      FOREIGN KEY (cliente_id) REFERENCES clientes(id)
    )
  `);
}

function roundMoney(value) {
  return Number((Number(value) || 0).toFixed(2));
}

async function calcularDeudaActualizadaCliente(clienteId) {
  const rows = await allQuery(
    `SELECT v.id AS venta_id,
            v.total AS venta_total,
            v.saldo_pendiente,
            v.estado AS venta_estado,
            dv.producto_id,
            COALESCE(dv.nombre_producto, p.nombre, 'Producto sin nombre') AS nombre_producto,
            dv.cantidad,
            dv.precio_unitario,
            dv.subtotal,
            p.precio_venta AS precio_actual,
            p.activo AS producto_activo
     FROM ventas v
     INNER JOIN detalle_ventas dv ON dv.venta_id = v.id
     LEFT JOIN productos p ON p.id = dv.producto_id
     WHERE v.cliente_id = ?
       AND v.es_cuenta_corriente = 1
       AND COALESCE(v.saldo_pendiente, 0) > 0
       AND COALESCE(v.estado, '') != 'anulado'
       AND COALESCE(v.tipo, '') != 'test_modificadores'`,
    [clienteId]
  );

  const productosMap = new Map();
  const ventasMap = new Map();
  let deudaHistorica = 0;
  let deudaActualizada = 0;

  rows.forEach((row) => {
    const ventaTotal = Number(row.venta_total) || 0;
    const saldoPendiente = Number(row.saldo_pendiente) || 0;
    const proporcionPendiente = ventaTotal > 0 ? Math.min(1, Math.max(0, saldoPendiente / ventaTotal)) : 1;
    const cantidad = Number(row.cantidad) || 0;
    const subtotalHistorico = Number(row.subtotal) || (cantidad * (Number(row.precio_unitario) || 0));
    const precioParaRecalculo = Number(row.producto_activo) === 1
      ? Number(row.precio_actual) || Number(row.precio_unitario) || 0
      : Number(row.precio_unitario) || 0;
    const historicoPendiente = subtotalHistorico * proporcionPendiente;
    const actualizadoPendiente = cantidad * precioParaRecalculo * proporcionPendiente;
    const key = row.producto_id == null ? `sin_producto:${row.nombre_producto}` : String(row.producto_id);

    deudaHistorica += historicoPendiente;
    deudaActualizada += actualizadoPendiente;

    if (!ventasMap.has(row.venta_id)) {
      ventasMap.set(row.venta_id, {
        venta_id: row.venta_id,
        total_historico: ventaTotal,
        saldo_anterior: saldoPendiente,
        saldo_actualizado: 0,
        diferencia: 0,
        estado_anterior: row.venta_estado,
        items: []
      });
    }
    const venta = ventasMap.get(row.venta_id);
    venta.saldo_actualizado += actualizadoPendiente;
    venta.items.push({
      producto_id: row.producto_id,
      nombre_producto: row.nombre_producto,
      cantidad,
      precio_historico: Number(row.precio_unitario) || 0,
      precio_actual: Number(row.precio_actual) || 0,
      producto_activo: Number(row.producto_activo) === 1,
      subtotal_historico: roundMoney(subtotalHistorico),
      subtotal_actualizado: roundMoney(cantidad * precioParaRecalculo),
      saldo_historico_proporcional: roundMoney(historicoPendiente),
      saldo_actualizado_proporcional: roundMoney(actualizadoPendiente)
    });

    if (!productosMap.has(key)) {
      productosMap.set(key, {
        producto_id: row.producto_id,
        nombre_producto: row.nombre_producto,
        deuda_historica: 0,
        deuda_actualizada: 0,
        diferencia: 0,
        producto_activo: Number(row.producto_activo) === 1
      });
    }
    const producto = productosMap.get(key);
    producto.deuda_historica += historicoPendiente;
    producto.deuda_actualizada += actualizadoPendiente;
    producto.diferencia = producto.deuda_actualizada - producto.deuda_historica;
  });

  const productosAfectados = [...productosMap.values()]
    .map((producto) => ({
      ...producto,
      deuda_historica: roundMoney(producto.deuda_historica),
      deuda_actualizada: roundMoney(producto.deuda_actualizada),
      diferencia: roundMoney(producto.diferencia)
    }))
    .filter((producto) => Math.abs(producto.diferencia) > 0.009)
    .sort((a, b) => Math.abs(b.diferencia) - Math.abs(a.diferencia));

  const ventas = [...ventasMap.values()].map((venta) => ({
    ...venta,
    total_historico: roundMoney(venta.total_historico),
    saldo_anterior: roundMoney(venta.saldo_anterior),
    saldo_actualizado: roundMoney(Math.max(0, venta.saldo_actualizado)),
    diferencia: roundMoney(Math.max(0, venta.saldo_actualizado) - venta.saldo_anterior),
    items: venta.items
  }));

  return {
    deuda_historica: roundMoney(deudaHistorica),
    deuda_actualizada: roundMoney(deudaActualizada),
    diferencia: roundMoney(deudaActualizada - deudaHistorica),
    productos_afectados: productosAfectados,
    ventas
  };
}

async function getDeudaActualizadaCliente(clienteId) {
  const calculo = await calcularDeudaActualizadaCliente(clienteId);
  const { ventas, ...publico } = calculo;
  return publico;
}

async function aplicarRecalculoDeudaCliente(clienteId, { usuario, motivo } = {}) {
  await ensureRecalculosCuentaCorrienteTable();
  const calculo = await calcularDeudaActualizadaCliente(clienteId);

  if (Math.abs(Number(calculo.diferencia || 0)) <= 0.009) {
    return {
      aplicado: false,
      message: "La deuda no tiene diferencias para recalcular",
      deuda_historica: calculo.deuda_historica,
      deuda_actualizada: calculo.deuda_actualizada,
      diferencia: calculo.diferencia,
      ventas_actualizadas: 0,
      productos_afectados: calculo.productos_afectados
    };
  }

  const ventasActualizar = calculo.ventas.filter((venta) => Math.abs(Number(venta.diferencia || 0)) > 0.009);
  const fechaHora = await getQuery("SELECT date('now', 'localtime') AS fecha, time('now', 'localtime') AS hora");
  const detalle = {
    productos_afectados: calculo.productos_afectados,
    ventas: ventasActualizar
  };

  await runQuery("BEGIN TRANSACTION");
  try {
    for (const venta of ventasActualizar) {
      await runQuery(
        `UPDATE ventas
         SET saldo_pendiente = ?,
             estado = ?
         WHERE id = ?
           AND es_cuenta_corriente = 1
           AND COALESCE(saldo_pendiente, 0) > 0
           AND COALESCE(estado, '') != 'anulado'
           AND COALESCE(tipo, '') != 'test_modificadores'`,
        [
          venta.saldo_actualizado,
          venta.saldo_actualizado === 0 ? "cobrada" : "cuenta_corriente_pendiente",
          venta.venta_id
        ]
      );
    }

    const auditoria = await runQuery(
      `INSERT INTO recalculos_cuenta_corriente
       (cliente_id, deuda_historica, deuda_actualizada, diferencia, usuario, motivo, fecha, hora, detalle_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        clienteId,
        calculo.deuda_historica,
        calculo.deuda_actualizada,
        calculo.diferencia,
        String(usuario || "admin").trim() || "admin",
        String(motivo || "Actualizacion por precio vigente").trim() || "Actualizacion por precio vigente",
        fechaHora?.fecha,
        fechaHora?.hora,
        JSON.stringify(detalle)
      ]
    );

    await runQuery("COMMIT");

    return {
      aplicado: true,
      message: "Deuda recalculada correctamente",
      auditoria_id: auditoria.lastID,
      deuda_historica: calculo.deuda_historica,
      deuda_actualizada: calculo.deuda_actualizada,
      diferencia: calculo.diferencia,
      ventas_actualizadas: ventasActualizar.length,
      productos_afectados: calculo.productos_afectados
    };
  } catch (error) {
    try {
      await runQuery("ROLLBACK");
    } catch {}
    throw error;
  }
}

module.exports = {
  parseClientePayload,
  normalizarTipoCuentaCorriente,
  buildClienteCuentaResumen,
  getClienteConMetricas,
  getHistorialProductosCliente,
  getDeudaActualizadaCliente,
  aplicarRecalculoDeudaCliente,
  ensureRecalculosCuentaCorrienteTable
};
