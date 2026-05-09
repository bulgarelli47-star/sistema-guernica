const { allQuery } = require("../db");

async function getResumenReportes({ desde = null, hasta = null } = {}) {
  const ventasWhere = ["estado != 'anulado'"];
  const pagosWhere  = ["estado != 'pendiente'"];
  const ventasParams = [];
  const pagosParams  = [];

  if (desde) {
    ventasWhere.push("fecha >= ?");
    pagosWhere.push("fecha >= ?");
    ventasParams.push(desde);
    pagosParams.push(desde);
  }
  if (hasta) {
    ventasWhere.push("fecha <= ?");
    pagosWhere.push("fecha <= ?");
    ventasParams.push(hasta);
    pagosParams.push(hasta);
  }

  const [ventasRows, pagosRows] = await Promise.all([
    allQuery(
      `SELECT
         COUNT(*)                        AS total_ventas,
         COALESCE(SUM(total), 0)         AS ventas_totales,
         COALESCE(SUM(monto_efectivo), 0) AS ventas_efectivo,
         COALESCE(SUM(monto_debito), 0)  AS ventas_debito
       FROM ventas
       WHERE ${ventasWhere.join(" AND ")}`,
      ventasParams
    ),
    allQuery(
      `SELECT
         COUNT(*)                              AS total_pagos,
         COALESCE(SUM(monto_total), 0)         AS pagos_totales,
         COALESCE(SUM(monto_efectivo), 0)      AS pagos_efectivo,
         COALESCE(SUM(monto_debito), 0)        AS pagos_debito,
         COALESCE(SUM(iva_credito_fiscal), 0)  AS iva_credito_fiscal
       FROM pagos
       WHERE ${pagosWhere.join(" AND ")}`,
      pagosParams
    )
  ]);

  const v = ventasRows[0] || {};
  const p = pagosRows[0] || {};

  const ventas_totales = Number(v.ventas_totales || 0);
  const pagos_totales  = Number(p.pagos_totales  || 0);
  const total_ventas   = Number(v.total_ventas   || 0);

  return {
    ventas_totales:     Number(ventas_totales.toFixed(2)),
    pagos_totales:      Number(pagos_totales.toFixed(2)),
    balance_general:    Number((ventas_totales - pagos_totales).toFixed(2)),
    iva_credito_fiscal: Number(Number(p.iva_credito_fiscal || 0).toFixed(2)),
    ticket_promedio:    total_ventas > 0 ? Number((ventas_totales / total_ventas).toFixed(2)) : 0,
    total_ventas,
    total_pagos:        Number(p.total_pagos   || 0),
    ventas_efectivo:    Number(Number(v.ventas_efectivo || 0).toFixed(2)),
    ventas_debito:      Number(Number(v.ventas_debito  || 0).toFixed(2)),
    pagos_efectivo:     Number(Number(p.pagos_efectivo  || 0).toFixed(2)),
    pagos_debito:       Number(Number(p.pagos_debito   || 0).toFixed(2))
  };
}

async function getProductosMasVendidos({ desde = null, hasta = null, limite = 20 } = {}) {
  const where = ["v.estado != 'anulado'"];
  const params = [];

  if (desde) { where.push("v.fecha >= ?"); params.push(desde); }
  if (hasta) { where.push("v.fecha <= ?"); params.push(hasta); }

  params.push(Number(limite) || 20);

  return allQuery(
    `SELECT
       dv.producto_id,
       dv.nombre_producto              AS nombre,
       COALESCE(SUM(dv.cantidad), 0)   AS cantidad_total,
       COALESCE(SUM(dv.subtotal), 0)   AS total_vendido
     FROM detalle_ventas dv
     JOIN ventas v ON v.id = dv.venta_id
     WHERE ${where.join(" AND ")}
     GROUP BY dv.producto_id, dv.nombre_producto
     ORDER BY cantidad_total DESC
     LIMIT ?`,
    params
  );
}

async function getResumenProveedoresPagos({ desde = null, hasta = null } = {}) {
  const where = [];
  const params = [];

  if (desde) { where.push("p.fecha >= ?"); params.push(desde); }
  if (hasta) { where.push("p.fecha <= ?"); params.push(hasta); }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  return allQuery(
    `SELECT
       p.proveedor_id,
       COALESCE(pr.nombre, 'Sin proveedor')                                                    AS proveedor_nombre,
       COALESCE(pr.tipo_impacto, p.categoria_pago, 'otro_no_computable')                       AS tipo_impacto,
       COALESCE(SUM(CASE WHEN p.estado != 'pendiente' THEN p.monto_total       ELSE 0 END), 0) AS total_pagado,
       COALESCE(SUM(CASE WHEN p.estado  = 'pendiente' THEN p.monto_total       ELSE 0 END), 0) AS total_pendiente,
       COALESCE(SUM(CASE WHEN p.estado != 'pendiente' THEN p.iva_credito_fiscal ELSE 0 END), 0) AS iva_credito_fiscal,
       COUNT(*) AS cantidad_pagos
     FROM pagos p
     LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
     ${whereClause}
     GROUP BY p.proveedor_id, proveedor_nombre, tipo_impacto
     ORDER BY total_pagado DESC`,
    params
  );
}

async function getVentasPorDia({ desde = null, hasta = null } = {}) {
  const where = ["estado != 'anulado'"];
  const params = [];

  if (desde) { where.push("fecha >= ?"); params.push(desde); }
  if (hasta) { where.push("fecha <= ?"); params.push(hasta); }

  return allQuery(
    `SELECT
       fecha,
       COALESCE(SUM(total), 0) AS total,
       COUNT(*)                AS cantidad_ventas
     FROM ventas
     WHERE ${where.join(" AND ")}
     GROUP BY fecha
     ORDER BY fecha ASC`,
    params
  );
}

function round2(value) {
  return Number(Number(value || 0).toFixed(2));
}

function cuentaKey(cuentaCobroId) {
  return cuentaCobroId == null ? "sin_cuenta" : String(cuentaCobroId);
}

function upsertCuenta(map, row = {}) {
  const key = cuentaKey(row.cuenta_cobro_id);
  if (!map.has(key)) {
    map.set(key, {
      cuenta_cobro_id: row.cuenta_cobro_id == null ? null : Number(row.cuenta_cobro_id),
      cuenta_nombre: row.cuenta_nombre || "Sin cuenta",
      tipo_pago_codigo: row.tipo_pago_codigo || null,
      ingresos: 0,
      egresos: 0,
      balance: 0,
      ventas: 0,
      pagos: 0,
      conciliaciones: 0,
      diferencias: 0,
      estado_conciliacion: "pendiente",
      _conciliaciones_con_diferencia: 0
    });
  }
  const item = map.get(key);
  if (!item.cuenta_nombre || item.cuenta_nombre === "Sin cuenta") item.cuenta_nombre = row.cuenta_nombre || item.cuenta_nombre || "Sin cuenta";
  if (!item.tipo_pago_codigo && row.tipo_pago_codigo) item.tipo_pago_codigo = row.tipo_pago_codigo;
  return item;
}

async function getResumenCuentasCobro({ desde = null, hasta = null } = {}) {
  const ventasWhere = ["COALESCE(v.estado, '') != 'anulado'", "COALESCE(v.tipo, '') != 'test_modificadores'"];
  const pagosWhere = ["COALESCE(p.estado, '') != 'pendiente'"];
  const conciliacionesWhere = [];
  const ventasParams = [];
  const pagosParams = [];
  const conciliacionesParams = [];

  if (desde) {
    ventasWhere.push("v.fecha >= ?");
    pagosWhere.push("p.fecha >= ?");
    conciliacionesWhere.push("c.fecha >= ?");
    ventasParams.push(desde);
    pagosParams.push(desde);
    conciliacionesParams.push(desde);
  }
  if (hasta) {
    ventasWhere.push("v.fecha <= ?");
    pagosWhere.push("p.fecha <= ?");
    conciliacionesWhere.push("c.fecha <= ?");
    ventasParams.push(hasta);
    pagosParams.push(hasta);
    conciliacionesParams.push(hasta);
  }

  const conciliacionesClause = conciliacionesWhere.length ? `WHERE ${conciliacionesWhere.join(" AND ")}` : "";
  const [ventas, pagos, conciliaciones] = await Promise.all([
    allQuery(
      `SELECT
         v.cuenta_cobro_id,
         COALESCE(cc.nombre, 'Sin cuenta') AS cuenta_nombre,
         COALESCE(cc.tipo_pago_codigo, v.tipo_cobro) AS tipo_pago_codigo,
         COALESCE(SUM(v.total), 0) AS ingresos,
         COUNT(*) AS ventas
       FROM ventas v
       LEFT JOIN cuentas_cobro cc ON cc.id = v.cuenta_cobro_id
       WHERE ${ventasWhere.join(" AND ")}
       GROUP BY v.cuenta_cobro_id, cuenta_nombre, tipo_pago_codigo`,
      ventasParams
    ),
    allQuery(
      `SELECT
         p.cuenta_cobro_id,
         COALESCE(cc.nombre, 'Sin cuenta') AS cuenta_nombre,
         COALESCE(cc.tipo_pago_codigo, p.tipo_pago) AS tipo_pago_codigo,
         COALESCE(SUM(p.monto_total), 0) AS egresos,
         COUNT(*) AS pagos
       FROM pagos p
       LEFT JOIN cuentas_cobro cc ON cc.id = p.cuenta_cobro_id
       WHERE ${pagosWhere.join(" AND ")}
       GROUP BY p.cuenta_cobro_id, cuenta_nombre, tipo_pago_codigo`,
      pagosParams
    ),
    allQuery(
      `SELECT
         c.cuenta_cobro_id,
         COALESCE(cc.nombre, 'Sin cuenta') AS cuenta_nombre,
         cc.tipo_pago_codigo,
         COUNT(*) AS conciliaciones,
         COALESCE(SUM(ABS(c.diferencia)), 0) AS diferencias,
         COALESCE(SUM(CASE WHEN c.estado = 'diferencia' OR ABS(c.diferencia) >= 0.01 THEN 1 ELSE 0 END), 0) AS conciliaciones_con_diferencia
       FROM conciliaciones_cuentas_cobro c
       LEFT JOIN cuentas_cobro cc ON cc.id = c.cuenta_cobro_id
       ${conciliacionesClause}
       GROUP BY c.cuenta_cobro_id, cuenta_nombre, cc.tipo_pago_codigo`,
      conciliacionesParams
    )
  ]);

  const porCuenta = new Map();

  for (const row of ventas) {
    const item = upsertCuenta(porCuenta, row);
    item.ingresos = round2(row.ingresos);
    item.ventas = Number(row.ventas || 0);
  }

  for (const row of pagos) {
    const item = upsertCuenta(porCuenta, row);
    item.egresos = round2(row.egresos);
    item.pagos = Number(row.pagos || 0);
  }

  for (const row of conciliaciones) {
    const item = upsertCuenta(porCuenta, row);
    item.conciliaciones = Number(row.conciliaciones || 0);
    item.diferencias = round2(row.diferencias);
    item._conciliaciones_con_diferencia = Number(row.conciliaciones_con_diferencia || 0);
  }

  return [...porCuenta.values()]
    .map((item) => {
      const estado = item.conciliaciones <= 0
        ? "pendiente"
        : item._conciliaciones_con_diferencia > 0
          ? "diferencia"
          : "conciliado";
      const { _conciliaciones_con_diferencia, ...publicItem } = item;
      return {
        ...publicItem,
        ingresos: round2(publicItem.ingresos),
        egresos: round2(publicItem.egresos),
        balance: round2(publicItem.ingresos - publicItem.egresos),
        diferencias: round2(publicItem.diferencias),
        estado_conciliacion: estado
      };
    })
    .sort((a, b) => b.balance - a.balance);
}

module.exports = {
  getResumenReportes,
  getProductosMasVendidos,
  getResumenProveedoresPagos,
  getVentasPorDia,
  getResumenCuentasCobro
};
