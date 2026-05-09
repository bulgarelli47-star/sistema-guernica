const { allQuery, getQuery, runQuery } = require("../db");

function resolveCobroData(total, tipoCobro, montoEfectivo, montoDebito) {
  const tipo = String(tipoCobro || "").trim().toLowerCase();
  const totalRounded = Number(total.toFixed(2));

  if (tipo === "efectivo") {
    return {
      tipo_cobro: "efectivo",
      monto_efectivo: totalRounded,
      monto_debito: 0
    };
  }

  if (tipo === "debito") {
    return {
      tipo_cobro: "debito",
      monto_efectivo: 0,
      monto_debito: totalRounded
    };
  }

  if (tipo === "transferencia") {
    return {
      tipo_cobro: "transferencia",
      monto_efectivo: 0,
      monto_debito: totalRounded
    };
  }

  if (tipo === "mixto") {
    const efectivo = Number(montoEfectivo) || 0;
    const debito = Number(montoDebito) || 0;

    if (efectivo < 0 || debito < 0) return null;

    const suma = Number((efectivo + debito).toFixed(2));

    if (Math.abs(suma - totalRounded) > 0.01) {
      return null;
    }

    return {
      tipo_cobro: "mixto",
      monto_efectivo: Number(efectivo.toFixed(2)),
      monto_debito: Number(debito.toFixed(2))
    };
  }

  return null;
}

async function getPagoCuentaCorrienteTotal(ventaId) {
  const row = await getQuery(
    `SELECT COALESCE(SUM(monto_pagado), 0) AS total_pagado
     FROM pagos_cuenta_corriente
     WHERE venta_id = ?`,
    [ventaId]
  );

  return Number(row?.total_pagado || 0);
}

async function getVentaCuentaCorrienteSnapshot(ventaId) {
  const venta = await getQuery(
    `SELECT v.*, cc.nombre AS cuenta_cobro_nombre
     FROM ventas v
     LEFT JOIN cuentas_cobro cc ON cc.id = v.cuenta_cobro_id
     WHERE v.id = ?`,
    [ventaId]
  );

  if (!venta) {
    return null;
  }

  const items = await allQuery(
    `SELECT dv.producto_id, dv.nombre_producto, dv.cantidad, dv.precio_unitario,
            p.id AS producto_actual_id, p.nombre AS producto_actual_nombre, p.precio_venta AS precio_actual, p.activo AS producto_activo
     FROM detalle_ventas dv
     LEFT JOIN productos p ON p.id = dv.producto_id
     WHERE dv.venta_id = ?
     ORDER BY dv.id ASC`,
    [ventaId]
  );

  const itemsCalculados = items.map((item) => {
    const cantidad = Number(item.cantidad || 0);
    const precioHistorico = Number(item.precio_unitario || 0);
    const productoSigueVigente = item.producto_actual_id && Number(item.producto_activo) === 1;
    const precioAplicado = productoSigueVigente
      ? Number(item.precio_actual || 0)
      : precioHistorico;

    return {
      producto_id: item.producto_id,
      nombre_producto: item.nombre_producto,
      cantidad,
      precio_historico: precioHistorico,
      precio_actual: item.producto_actual_id ? Number(item.precio_actual || 0) : null,
      usa_precio_actual: Boolean(productoSigueVigente),
      subtotal_actual: Number((cantidad * precioAplicado).toFixed(2))
    };
  });

  const totalActual = Number(
    itemsCalculados.reduce((acc, item) => acc + item.subtotal_actual, 0).toFixed(2)
  );
  const totalPagado = Number((await getPagoCuentaCorrienteTotal(ventaId)).toFixed(2));
  const saldoActual = Number(Math.max(0, totalActual - totalPagado).toFixed(2));

  return {
    venta,
    items: itemsCalculados,
    total_actual: totalActual,
    total_pagado: totalPagado,
    saldo_actual: saldoActual
  };
}

async function refreshCuentaCorrienteSaldo(ventaId) {
  const snapshot = await getVentaCuentaCorrienteSnapshot(ventaId);

  if (!snapshot) {
    return null;
  }

  await runQuery(
    `UPDATE ventas
     SET saldo_pendiente = ?, total = ?, estado = ?
     WHERE id = ?`,
    [
      snapshot.saldo_actual,
      snapshot.total_actual,
      snapshot.saldo_actual === 0 ? "cobrada" : "cuenta_corriente_pendiente",
      ventaId
    ]
  );

  return snapshot;
}

async function replaceVentaDetalle(ventaId, items) {
  await runQuery("DELETE FROM detalle_ventas WHERE venta_id = ?", [ventaId]);

  const detalles = [];
  for (const item of items) {
    const subtotal = item.cantidad * item.precio_unitario;

    const result = await runQuery(
      `INSERT INTO detalle_ventas
      (venta_id, producto_id, nombre_producto, cantidad, precio_unitario, subtotal)
      VALUES (?, ?, ?, ?, ?, ?)`,
      [
        ventaId,
        item.producto_id,
        item.nombre_producto,
        item.cantidad,
        item.precio_unitario,
        subtotal
      ]
    );

    detalles.push({
      ...item,
      id: result.lastID,
      detalle_venta_id: result.lastID,
      subtotal
    });
  }

  return detalles;
}

async function getVentaDetalleRows(ventaId) {
  return allQuery(
    `SELECT id, venta_id, producto_id, nombre_producto, cantidad, precio_unitario, subtotal
     FROM detalle_ventas
     WHERE venta_id = ?
     ORDER BY id ASC`,
    [ventaId]
  );
}

async function getVentaConDetalle(ventaId) {
  const venta = await getQuery("SELECT * FROM ventas WHERE id = ?", [ventaId]);

  if (!venta) {
    return null;
  }

  const items = await getVentaDetalleRows(ventaId);
  for (const item of items) {
    item.modificadores = await allQuery(
      `SELECT modificador_id, nombre, tipo, precio_extra, cantidad, metadata_json
       FROM detalle_venta_modificadores
       WHERE detalle_venta_id = ?
       ORDER BY id ASC`,
      [item.id]
    );
  }
  return { venta, items };
}

module.exports = {
  getPagoCuentaCorrienteTotal,
  getVentaConDetalle,
  getVentaCuentaCorrienteSnapshot,
  getVentaDetalleRows,
  refreshCuentaCorrienteSaldo,
  replaceVentaDetalle,
  resolveCobroData
};
