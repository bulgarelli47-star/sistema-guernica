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

function buildVentasReporteWhere({ desde = null, hasta = null, estado = null, incluirAnuladas = false } = {}) {
  const where = ["COALESCE(v.tipo, '') != 'test_modificadores'"];
  const params = [];
  const estadoNormalizado = String(estado || "").trim().toLowerCase();

  if (!incluirAnuladas) {
    where.push("COALESCE(v.estado, '') != 'anulado'");
  }

  if (estadoNormalizado && !["todos", "productivas"].includes(estadoNormalizado)) {
    where.push("COALESCE(v.estado, '') = ?");
    params.push(estadoNormalizado);
  }

  if (desde) {
    where.push("v.fecha >= ?");
    params.push(desde);
  }

  if (hasta) {
    where.push("v.fecha <= ?");
    params.push(hasta);
  }

  return { where, params, estado: estadoNormalizado || "productivas" };
}

async function getReporteVentas({ desde = null, hasta = null, estado = null } = {}) {
  const productivas = buildVentasReporteWhere({ desde, hasta, estado });
  const anuladas = buildVentasReporteWhere({ desde, hasta, estado: "anulado", incluirAnuladas: true });
  const todas = buildVentasReporteWhere({ desde, hasta, estado: null, incluirAnuladas: true });

  const productivasSql = productivas.where.join(" AND ");
  const anuladasSql = anuladas.where.join(" AND ");
  const todasSql = todas.where.join(" AND ");

  const [
    resumenRows,
    anuladasRows,
    detalleResumenRows,
    porDia,
    porTipoCobroRows,
    productosMasVendidos,
    estadosRows
  ] = await Promise.all([
    allQuery(
      `SELECT
         COUNT(*) AS operaciones,
         COALESCE(SUM(v.total), 0) AS total_vendido,
         COALESCE(SUM(CASE WHEN COALESCE(v.estado, '') = 'cobrada' THEN v.total ELSE 0 END), 0) AS total_cobrado,
         COALESCE(SUM(CASE WHEN COALESCE(v.estado, '') = 'pendiente' THEN v.total ELSE 0 END), 0) AS total_pendiente,
         COALESCE(SUM(CASE WHEN COALESCE(v.es_cuenta_corriente, 0) = 1 OR COALESCE(v.estado, '') = 'cuenta_corriente_pendiente' THEN v.total ELSE 0 END), 0) AS total_cuenta_corriente,
         COALESCE(SUM(CASE WHEN COALESCE(v.es_cuenta_corriente, 0) = 1 OR COALESCE(v.estado, '') = 'cuenta_corriente_pendiente' THEN v.saldo_pendiente ELSE 0 END), 0) AS saldo_cuenta_corriente,
         COALESCE(SUM(v.monto_efectivo), 0) AS monto_efectivo,
         COALESCE(SUM(v.monto_debito), 0) AS monto_debito,
         COALESCE(SUM(CASE WHEN COALESCE(v.tipo_cobro, v.metodo_pago, '') = 'efectivo' THEN v.total ELSE 0 END), 0) AS ventas_efectivo,
         COALESCE(SUM(CASE WHEN COALESCE(v.tipo_cobro, v.metodo_pago, '') = 'debito' THEN v.total ELSE 0 END), 0) AS ventas_debito,
         COALESCE(SUM(CASE WHEN COALESCE(v.tipo_cobro, v.metodo_pago, '') = 'transferencia' THEN v.total ELSE 0 END), 0) AS ventas_transferencia,
         COALESCE(SUM(CASE WHEN COALESCE(v.tipo_cobro, v.metodo_pago, '') = 'mixto' THEN v.total ELSE 0 END), 0) AS ventas_mixto,
         COALESCE(SUM(CASE WHEN COALESCE(v.estado, '') = 'pendiente' THEN 1 ELSE 0 END), 0) AS ventas_pendientes,
         COALESCE(SUM(CASE WHEN COALESCE(v.estado, '') = 'cobrada' THEN 1 ELSE 0 END), 0) AS ventas_cobradas,
         COALESCE(SUM(CASE WHEN COALESCE(v.es_cuenta_corriente, 0) = 1 OR COALESCE(v.estado, '') = 'cuenta_corriente_pendiente' THEN 1 ELSE 0 END), 0) AS ventas_cuenta_corriente
       FROM ventas v
       WHERE ${productivasSql}`,
      productivas.params
    ),
    allQuery(
      `SELECT
         COUNT(*) AS ventas_anuladas,
         COALESCE(SUM(v.total), 0) AS monto_anulado
       FROM ventas v
       WHERE ${anuladasSql}`,
      anuladas.params
    ),
    allQuery(
      `SELECT
         COALESCE(SUM(dv.cantidad), 0) AS productos_vendidos
       FROM detalle_ventas dv
       INNER JOIN ventas v ON v.id = dv.venta_id
       WHERE ${productivasSql}`,
      productivas.params
    ),
    allQuery(
      `SELECT
         v.fecha,
         COALESCE(SUM(v.total), 0) AS total,
         COUNT(*) AS cantidad_ventas,
         COALESCE(SUM(v.total) / NULLIF(COUNT(*), 0), 0) AS ticket_promedio
       FROM ventas v
       WHERE ${productivasSql}
       GROUP BY v.fecha
       ORDER BY v.fecha ASC`,
      productivas.params
    ),
    allQuery(
      `SELECT
         COALESCE(v.tipo_cobro, v.metodo_pago, 'Sin método') AS tipo_cobro,
         COALESCE(SUM(v.total), 0) AS total,
         COUNT(*) AS cantidad_ventas
       FROM ventas v
       WHERE ${productivasSql}
       GROUP BY tipo_cobro
       ORDER BY total DESC`,
      productivas.params
    ),
    allQuery(
      `SELECT
         dv.producto_id,
         dv.nombre_producto AS nombre,
         COALESCE(SUM(dv.cantidad), 0) AS cantidad_total,
         COALESCE(SUM(dv.subtotal), 0) AS total_vendido,
         COUNT(DISTINCT dv.venta_id) AS ventas
       FROM detalle_ventas dv
       INNER JOIN ventas v ON v.id = dv.venta_id
       WHERE ${productivasSql}
       GROUP BY dv.producto_id, dv.nombre_producto
       ORDER BY cantidad_total DESC, total_vendido DESC
       LIMIT 20`,
      productivas.params
    ),
    allQuery(
      `SELECT
         COALESCE(v.estado, 'sin_estado') AS estado,
         COUNT(*) AS cantidad,
         COALESCE(SUM(v.total), 0) AS total
       FROM ventas v
       WHERE ${todasSql}
       GROUP BY estado
       ORDER BY cantidad DESC`,
      todas.params
    )
  ]);

  const resumen = resumenRows[0] || {};
  const anuladasResumen = anuladasRows[0] || {};
  const detalleResumen = detalleResumenRows[0] || {};
  const totalVendido = round2(resumen.total_vendido);
  const operaciones = Number(resumen.operaciones || 0);
  const totalPorTipo = porTipoCobroRows.reduce((acc, row) => acc + Number(row.total || 0), 0);

  return {
    filtros: {
      desde,
      hasta,
      estado: productivas.estado,
      incluye_pendientes: true,
      incluye_anuladas_en_totales: false
    },
    resumen: {
      total_vendido: totalVendido,
      total_cobrado: round2(resumen.total_cobrado),
      total_pendiente: round2(resumen.total_pendiente),
      total_cuenta_corriente: round2(resumen.total_cuenta_corriente),
      saldo_cuenta_corriente: round2(resumen.saldo_cuenta_corriente),
      operaciones,
      ventas_cobradas: Number(resumen.ventas_cobradas || 0),
      ventas_pendientes: Number(resumen.ventas_pendientes || 0),
      ventas_cuenta_corriente: Number(resumen.ventas_cuenta_corriente || 0),
      ventas_anuladas: Number(anuladasResumen.ventas_anuladas || 0),
      monto_anulado: round2(anuladasResumen.monto_anulado),
      ticket_promedio: operaciones > 0 ? round2(totalVendido / operaciones) : 0,
      productos_vendidos: round2(detalleResumen.productos_vendidos)
    },
    cobros: {
      ventas_efectivo: round2(resumen.ventas_efectivo),
      ventas_debito: round2(resumen.ventas_debito),
      ventas_transferencia: round2(resumen.ventas_transferencia),
      ventas_mixto: round2(resumen.ventas_mixto),
      monto_efectivo: round2(resumen.monto_efectivo),
      monto_debito: round2(resumen.monto_debito)
    },
    por_dia: porDia.map((row) => ({
      fecha: row.fecha,
      total: round2(row.total),
      cantidad_ventas: Number(row.cantidad_ventas || 0),
      ticket_promedio: round2(row.ticket_promedio)
    })),
    por_tipo_cobro: porTipoCobroRows.map((row) => ({
      tipo_cobro: row.tipo_cobro || "Sin método",
      total: round2(row.total),
      cantidad_ventas: Number(row.cantidad_ventas || 0),
      porcentaje: totalPorTipo > 0 ? round2(Number(row.total || 0) / totalPorTipo * 100) : 0
    })),
    productos_mas_vendidos: productosMasVendidos.map((row) => ({
      producto_id: row.producto_id == null ? null : Number(row.producto_id),
      nombre: row.nombre,
      cantidad_total: round2(row.cantidad_total),
      total_vendido: round2(row.total_vendido),
      ventas: Number(row.ventas || 0)
    })),
    estados: estadosRows.map((row) => ({
      estado: row.estado,
      cantidad: Number(row.cantidad || 0),
      total: round2(row.total)
    }))
  };
}

function normalizarIdOpcional(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function addFiltroFecha(where, params, alias, desde, hasta) {
  if (desde) {
    where.push(`${alias}.fecha >= ?`);
    params.push(desde);
  }
  if (hasta) {
    where.push(`${alias}.fecha <= ?`);
    params.push(hasta);
  }
}

function addFiltroCajaReporte(where, params, alias, cajaId) {
  if (cajaId) {
    where.push(`${alias}.caja_id = ?`);
    params.push(cajaId);
  }
}

function addFiltroEstadoCaja(where, params, estado) {
  const estadoNormalizado = String(estado || "").trim().toLowerCase();
  if (estadoNormalizado && estadoNormalizado !== "todas") {
    where.push("ca.estado = ?");
    params.push(estadoNormalizado);
  }
}

function addMetodoResumen(map, metodo, total) {
  const amount = round2(total);
  if (!amount) return;
  const key = String(metodo || "Sin metodo").trim() || "Sin metodo";
  if (!map.has(key)) {
    map.set(key, { metodo: key, total: 0, cantidad: 0 });
  }
  const item = map.get(key);
  item.total = round2(item.total + amount);
  item.cantidad += 1;
}

function sumarMetodoMovimiento(map, movimiento, tipo) {
  const total = tipo === "ingreso" ? Number(movimiento.ingreso || 0) : Number(movimiento.egreso || 0);
  if (!total) return;

  const metodo = String(movimiento.metodo || "Sin metodo").toLowerCase();
  if (metodo === "mixto") {
    addMetodoResumen(map, "efectivo", movimiento.monto_efectivo);
    addMetodoResumen(map, "debito", movimiento.monto_debito);
    return;
  }

  addMetodoResumen(map, movimiento.metodo || "Sin metodo", total);
}

function mapMovimientoCaja(row) {
  return {
    id: Number(row.id),
    fecha: row.fecha,
    hora: row.hora,
    caja_id: row.caja_id == null ? null : Number(row.caja_id),
    tipo_operacion: row.tipo_operacion,
    concepto: row.concepto,
    metodo: row.metodo || "Sin metodo",
    ingreso: round2(row.ingreso),
    egreso: round2(row.egreso),
    monto_efectivo: round2(row.monto_efectivo),
    monto_debito: round2(row.monto_debito),
    iva_credito_fiscal: round2(row.iva_credito_fiscal),
    cuenta_cobro_id: row.cuenta_cobro_id == null ? null : Number(row.cuenta_cobro_id),
    cuenta_nombre: row.cuenta_nombre || null
  };
}

async function getReporteCaja({ desde = null, hasta = null, cajaId = null, cuentaCobroId = null, estado = null } = {}) {
  const caja = normalizarIdOpcional(cajaId);
  const cuenta = normalizarIdOpcional(cuentaCobroId);
  const estadoNormalizado = String(estado || "todas").trim().toLowerCase() || "todas";

  const ventasWhere = [
    "v.caja_id IS NOT NULL",
    "COALESCE(v.estado, '') = 'cobrada'",
    "COALESCE(v.tipo, '') != 'test_modificadores'",
    "COALESCE(v.es_cuenta_corriente, 0) != 1"
  ];
  const ventasParams = [];
  addFiltroFecha(ventasWhere, ventasParams, "v", desde, hasta);
  addFiltroCajaReporte(ventasWhere, ventasParams, "v", caja);
  addFiltroEstadoCaja(ventasWhere, ventasParams, estadoNormalizado);
  if (cuenta) {
    ventasWhere.push("v.cuenta_cobro_id = ?");
    ventasParams.push(cuenta);
  }

  const cobrosCuentaWhere = ["pcc.caja_id IS NOT NULL"];
  const cobrosCuentaParams = [];
  addFiltroFecha(cobrosCuentaWhere, cobrosCuentaParams, "pcc", desde, hasta);
  addFiltroCajaReporte(cobrosCuentaWhere, cobrosCuentaParams, "pcc", caja);
  addFiltroEstadoCaja(cobrosCuentaWhere, cobrosCuentaParams, estadoNormalizado);
  if (cuenta) cobrosCuentaWhere.push("1 = 0");

  const pagosWhere = [
    "p.caja_id IS NOT NULL",
    "COALESCE(p.estado, '') != 'pendiente'"
  ];
  const pagosParams = [];
  addFiltroFecha(pagosWhere, pagosParams, "p", desde, hasta);
  addFiltroCajaReporte(pagosWhere, pagosParams, "p", caja);
  addFiltroEstadoCaja(pagosWhere, pagosParams, estadoNormalizado);
  if (cuenta) {
    pagosWhere.push("p.cuenta_cobro_id = ?");
    pagosParams.push(cuenta);
  }

  const manualWhere = ["cm.caja_id IS NOT NULL"];
  const manualParams = [];
  addFiltroFecha(manualWhere, manualParams, "cm", desde, hasta);
  addFiltroCajaReporte(manualWhere, manualParams, "cm", caja);
  addFiltroEstadoCaja(manualWhere, manualParams, estadoNormalizado);
  if (cuenta) manualWhere.push("1 = 0");

  const cajasWhere = ["1 = 1"];
  const cajasParams = [];
  if (desde) { cajasWhere.push("fecha >= ?"); cajasParams.push(desde); }
  if (hasta) { cajasWhere.push("fecha <= ?"); cajasParams.push(hasta); }
  if (caja) { cajasWhere.push("id = ?"); cajasParams.push(caja); }
  if (estadoNormalizado && estadoNormalizado !== "todas") {
    cajasWhere.push("estado = ?");
    cajasParams.push(estadoNormalizado);
  }

  const conciliacionesWhere = ["1 = 1"];
  const conciliacionesParams = [];
  if (desde) { conciliacionesWhere.push("c.fecha >= ?"); conciliacionesParams.push(desde); }
  if (hasta) { conciliacionesWhere.push("c.fecha <= ?"); conciliacionesParams.push(hasta); }
  if (caja) { conciliacionesWhere.push("c.caja_id = ?"); conciliacionesParams.push(caja); }
  if (cuenta) { conciliacionesWhere.push("c.cuenta_cobro_id = ?"); conciliacionesParams.push(cuenta); }
  if (estadoNormalizado && estadoNormalizado !== "todas") {
    conciliacionesWhere.push("ca.estado = ?");
    conciliacionesParams.push(estadoNormalizado);
  }

  const [ventas, cobrosCuenta, pagos, manuales, cajas, conciliaciones] = await Promise.all([
    allQuery(
      `SELECT
         v.id,
         v.fecha,
         v.hora,
         v.caja_id,
         v.cuenta_cobro_id,
         COALESCE(cc.nombre, 'Sin cuenta') AS cuenta_nombre,
         'venta_cobrada' AS tipo_operacion,
         'Venta #' || v.id AS concepto,
         COALESCE(v.tipo_cobro, v.metodo_pago, 'Sin metodo') AS metodo,
         COALESCE(v.total, 0) AS ingreso,
         0 AS egreso,
         COALESCE(v.monto_efectivo, 0) AS monto_efectivo,
         COALESCE(v.monto_debito, 0) AS monto_debito,
         0 AS iva_credito_fiscal
       FROM ventas v
       INNER JOIN caja_aperturas ca ON ca.id = v.caja_id
       LEFT JOIN cuentas_cobro cc ON cc.id = v.cuenta_cobro_id
       WHERE ${ventasWhere.join(" AND ")}`,
      ventasParams
    ),
    allQuery(
      `SELECT
         pcc.id,
         pcc.fecha,
         pcc.hora,
         pcc.caja_id,
         NULL AS cuenta_cobro_id,
         NULL AS cuenta_nombre,
         'cobro_cuenta_corriente' AS tipo_operacion,
         'Cobro cuenta corriente #' || pcc.id AS concepto,
         COALESCE(pcc.tipo_cobro, 'Sin metodo') AS metodo,
         COALESCE(pcc.monto_pagado, 0) AS ingreso,
         0 AS egreso,
         COALESCE(pcc.monto_efectivo, 0) AS monto_efectivo,
         COALESCE(pcc.monto_debito, 0) AS monto_debito,
         0 AS iva_credito_fiscal
       FROM pagos_cuenta_corriente pcc
       INNER JOIN caja_aperturas ca ON ca.id = pcc.caja_id
       WHERE ${cobrosCuentaWhere.join(" AND ")}`,
      cobrosCuentaParams
    ),
    allQuery(
      `SELECT
         p.id,
         p.fecha,
         p.hora,
         p.caja_id,
         p.cuenta_cobro_id,
         COALESCE(cc.nombre, 'Sin cuenta') AS cuenta_nombre,
         'pago_proveedor' AS tipo_operacion,
         COALESCE(p.concepto, 'Pago #' || p.id) AS concepto,
         COALESCE(p.tipo_pago, 'Sin metodo') AS metodo,
         0 AS ingreso,
         COALESCE(p.monto_total, 0) AS egreso,
         COALESCE(p.monto_efectivo, 0) AS monto_efectivo,
         COALESCE(p.monto_debito, 0) AS monto_debito,
         COALESCE(p.iva_credito_fiscal, 0) AS iva_credito_fiscal
       FROM pagos p
       INNER JOIN caja_aperturas ca ON ca.id = p.caja_id
       LEFT JOIN cuentas_cobro cc ON cc.id = p.cuenta_cobro_id
       WHERE ${pagosWhere.join(" AND ")}`,
      pagosParams
    ),
    allQuery(
      `SELECT
         cm.id,
         cm.fecha,
         cm.hora,
         cm.caja_id,
         NULL AS cuenta_cobro_id,
         NULL AS cuenta_nombre,
         CASE WHEN cm.tipo = 'ingreso' THEN 'caja_movimiento_ingreso' ELSE 'caja_movimiento_egreso' END AS tipo_operacion,
         cm.concepto,
         'efectivo' AS metodo,
         CASE WHEN cm.tipo = 'ingreso' THEN COALESCE(cm.monto, 0) ELSE 0 END AS ingreso,
         CASE WHEN cm.tipo = 'egreso' THEN COALESCE(cm.monto, 0) ELSE 0 END AS egreso,
         COALESCE(cm.monto, 0) AS monto_efectivo,
         0 AS monto_debito,
         0 AS iva_credito_fiscal
       FROM caja_movimientos cm
       INNER JOIN caja_aperturas ca ON ca.id = cm.caja_id
       WHERE ${manualWhere.join(" AND ")}`,
      manualParams
    ),
    allQuery(
      `SELECT id, fecha, hora, hora_cierre, monto_apertura, usuario, estado,
              efectivo_esperado, efectivo_contado, diferencia, monto_caja_apertura, monto_caja_fondo
       FROM caja_aperturas
       WHERE ${cajasWhere.join(" AND ")}
       ORDER BY fecha DESC, COALESCE(hora_cierre, hora) DESC, id DESC`,
      cajasParams
    ),
    allQuery(
      `SELECT c.*, COALESCE(cc.nombre, 'Sin cuenta') AS cuenta_nombre
       FROM conciliaciones_cuentas_cobro c
       LEFT JOIN cuentas_cobro cc ON cc.id = c.cuenta_cobro_id
       LEFT JOIN caja_aperturas ca ON ca.id = c.caja_id
       WHERE ${conciliacionesWhere.join(" AND ")}
       ORDER BY c.fecha DESC, c.hora DESC, c.id DESC`,
      conciliacionesParams
    )
  ]);

  const movimientos = [...ventas, ...cobrosCuenta, ...pagos, ...manuales]
    .map(mapMovimientoCaja)
    .sort((a, b) => `${b.fecha || ""} ${b.hora || ""} ${String(b.id).padStart(8, "0")}`.localeCompare(`${a.fecha || ""} ${a.hora || ""} ${String(a.id).padStart(8, "0")}`));

  const ingresosPorMetodo = new Map();
  const egresosPorMetodo = new Map();
  const cuentas = new Map();

  const resumen = movimientos.reduce((acc, movimiento) => {
    const ingreso = Number(movimiento.ingreso || 0);
    const egreso = Number(movimiento.egreso || 0);
    acc.ingresos += ingreso;
    acc.egresos += egreso;
    acc.iva_credito_fiscal += Number(movimiento.iva_credito_fiscal || 0);

    if (ingreso > 0) sumarMetodoMovimiento(ingresosPorMetodo, movimiento, "ingreso");
    if (egreso > 0) sumarMetodoMovimiento(egresosPorMetodo, movimiento, "egreso");

    if (movimiento.tipo_operacion === "venta_cobrada") acc.ventas_cobradas += ingreso;
    if (movimiento.tipo_operacion === "cobro_cuenta_corriente") acc.cobros_cuenta_corriente += ingreso;
    if (movimiento.tipo_operacion === "caja_movimiento_ingreso") acc.ingresos_manuales += ingreso;
    if (movimiento.tipo_operacion === "pago_proveedor") {
      acc.pagos_proveedores += egreso;
      acc.pagos_registrados += 1;
    }
    if (movimiento.tipo_operacion === "caja_movimiento_egreso") acc.egresos_manuales += egreso;
    if (movimiento.tipo_operacion === "caja_movimiento_ingreso" || movimiento.tipo_operacion === "caja_movimiento_egreso") {
      acc.movimientos_manuales += 1;
    }

    if (movimiento.cuenta_cobro_id != null || movimiento.cuenta_nombre) {
      const key = cuentaKey(movimiento.cuenta_cobro_id);
      if (!cuentas.has(key)) {
        cuentas.set(key, {
          cuenta_cobro_id: movimiento.cuenta_cobro_id,
          cuenta_nombre: movimiento.cuenta_nombre || "Sin cuenta",
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
      const cuentaItem = cuentas.get(key);
      cuentaItem.ingresos += ingreso;
      cuentaItem.egresos += egreso;
      if (movimiento.tipo_operacion === "venta_cobrada") cuentaItem.ventas += 1;
      if (movimiento.tipo_operacion === "pago_proveedor") cuentaItem.pagos += 1;
    }

    return acc;
  }, {
    ingresos: 0,
    egresos: 0,
    balance: 0,
    ventas_cobradas: 0,
    cobros_cuenta_corriente: 0,
    ingresos_manuales: 0,
    pagos_proveedores: 0,
    egresos_manuales: 0,
    iva_credito_fiscal: 0,
    operaciones: movimientos.length,
    pagos_registrados: 0,
    movimientos_manuales: 0,
    arqueos: 0,
    cierres: 0
  });

  for (const conciliacion of conciliaciones) {
    const key = cuentaKey(conciliacion.cuenta_cobro_id);
    if (!cuentas.has(key)) {
      cuentas.set(key, {
        cuenta_cobro_id: conciliacion.cuenta_cobro_id == null ? null : Number(conciliacion.cuenta_cobro_id),
        cuenta_nombre: conciliacion.cuenta_nombre || "Sin cuenta",
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
    const item = cuentas.get(key);
    item.conciliaciones += 1;
    item.diferencias += Math.abs(Number(conciliacion.diferencia || 0));
    if (String(conciliacion.estado || "").toLowerCase() === "diferencia" || Math.abs(Number(conciliacion.diferencia || 0)) >= 0.01) {
      item._conciliaciones_con_diferencia += 1;
    }
  }

  const conciliacionesResumen = conciliaciones.reduce((acc, item) => {
    const diferencia = Math.abs(Number(item.diferencia || 0));
    acc.total += 1;
    acc.diferencia_total += diferencia;
    if (String(item.estado || "").toLowerCase() === "conciliado" && diferencia < 0.01) acc.conciliadas += 1;
    if (String(item.estado || "").toLowerCase() === "diferencia" || diferencia >= 0.01) acc.con_diferencia += 1;
    return acc;
  }, { total: 0, conciliadas: 0, con_diferencia: 0, diferencia_total: 0 });

  resumen.ingresos = round2(resumen.ingresos);
  resumen.egresos = round2(resumen.egresos);
  resumen.balance = round2(resumen.ingresos - resumen.egresos);
  resumen.ventas_cobradas = round2(resumen.ventas_cobradas);
  resumen.cobros_cuenta_corriente = round2(resumen.cobros_cuenta_corriente);
  resumen.ingresos_manuales = round2(resumen.ingresos_manuales);
  resumen.pagos_proveedores = round2(resumen.pagos_proveedores);
  resumen.egresos_manuales = round2(resumen.egresos_manuales);
  resumen.iva_credito_fiscal = round2(resumen.iva_credito_fiscal);
  resumen.arqueos = 0;
  resumen.cierres = cajas.filter((item) => item.estado === "cerrada").length;

  const cajaIds = cajas.map((item) => Number(item.id)).filter(Boolean);
  if (cajaIds.length) {
    const arqueosWhere = [`caja_id IN (${cajaIds.map(() => "?").join(",")})`];
    const arqueosRows = await allQuery(
      `SELECT COUNT(*) AS total FROM caja_arqueos WHERE ${arqueosWhere.join(" AND ")}`,
      cajaIds
    );
    resumen.arqueos = Number(arqueosRows[0]?.total || 0);
  }

  return {
    filtros: {
      desde,
      hasta,
      caja_id: caja,
      cuenta_cobro_id: cuenta,
      estado: estadoNormalizado
    },
    resumen,
    ingresos_por_metodo: [...ingresosPorMetodo.values()].map((item) => ({
      metodo: item.metodo,
      total: round2(item.total),
      cantidad: item.cantidad
    })).sort((a, b) => b.total - a.total),
    egresos_por_metodo: [...egresosPorMetodo.values()].map((item) => ({
      metodo: item.metodo,
      total: round2(item.total),
      cantidad: item.cantidad
    })).sort((a, b) => b.total - a.total),
    cuentas_cobro: [...cuentas.values()].map((item) => {
      const estadoConciliacion = item.conciliaciones <= 0
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
        estado_conciliacion: estadoConciliacion
      };
    }).sort((a, b) => b.balance - a.balance),
    conciliaciones: {
      total: conciliacionesResumen.total,
      conciliadas: conciliacionesResumen.conciliadas,
      con_diferencia: conciliacionesResumen.con_diferencia,
      diferencia_total: round2(conciliacionesResumen.diferencia_total)
    },
    movimientos: movimientos.slice(0, 200),
    cajas: cajas.map((item) => ({
      id: Number(item.id),
      fecha: item.fecha,
      hora: item.hora,
      hora_cierre: item.hora_cierre,
      estado: item.estado,
      usuario: item.usuario,
      monto_apertura: round2(item.monto_apertura),
      efectivo_esperado: round2(item.efectivo_esperado),
      efectivo_contado: round2(item.efectivo_contado),
      diferencia: round2(item.diferencia),
      monto_caja_apertura: round2(item.monto_caja_apertura),
      monto_caja_fondo: round2(item.monto_caja_fondo)
    }))
  };
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

function normalizarBooleanFiltro(value) {
  const normalizado = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "si", "sí", "yes"].includes(normalizado);
}

function normalizarFiltroTexto(value) {
  const normalizado = String(value ?? "").trim();
  return normalizado || null;
}

function estadoStockProducto(producto) {
  if (Number(producto.maneja_stock || 0) !== 1) return "sin_control";
  const stock = Number(producto.stock_fisico || 0);
  const minimo = Number(producto.stock_minimo || 0);
  if (stock < 0) return "stock_negativo";
  if (stock <= 0) return "sin_stock";
  if (stock <= minimo) return "bajo_stock";
  return "ok";
}

function mapReporteStockProducto(row) {
  const tipo = String(row.tipo || "simple").toLowerCase();
  const manejaStock = Number(row.maneja_stock || 0) === 1 ? 1 : 0;
  const stockFisico = round2(row.stock);
  const consumoUnidad = Number(row.consumo_unidad || 0);
  const esFraccionado = Number(row.usa_costos_varios || 0) === 1 && manejaStock === 1;
  const esCompuestoSinStock = tipo === "compuesto" && manejaStock !== 1;
  const esCombo = Number(row.es_combo || 0) === 1;
  let stockVendible = stockFisico;

  if (esCompuestoSinStock || esCombo) {
    // Reporte minimo: no recalcula recetas/combos para no prometer precision de stock disponible.
    stockVendible = null;
  } else if (esFraccionado && consumoUnidad > 0) {
    stockVendible = Math.max(0, Math.floor(stockFisico / consumoUnidad));
  }

  const costoBase = Number(row.costo_final || row.precio_compra || 0);
  const stockValorizado = manejaStock === 1 && costoBase > 0
    ? round2(stockFisico * costoBase)
    : 0;
  const producto = {
    producto_id: Number(row.id),
    codigo: row.codigo || null,
    nombre: row.nombre,
    categoria: row.categoria_nombre || row.categoria || "Sin categoria",
    categoria_id: row.categoria_id == null ? null : Number(row.categoria_id),
    tipo,
    es_combo: Number(row.es_combo || 0),
    maneja_stock: manejaStock,
    activo: Number(row.activo || 0),
    unidad_medida: row.unidad_medida || "unidad",
    stock_fisico: stockFisico,
    stock_vendible: stockVendible,
    stock_minimo: round2(row.stock_minimo),
    costo_base_estimado: round2(costoBase),
    costo_fuente: Number(row.costo_final || 0) > 0 ? "costo_final" : Number(row.precio_compra || 0) > 0 ? "precio_compra" : "sin_costo",
    stock_valorizado_estimado: stockValorizado,
    items_vendidos: round2(row.items_vendidos),
    movimientos: Number(row.movimientos || 0)
  };
  producto.estado_stock = estadoStockProducto(producto);
  return producto;
}

async function getReporteStock({
  categoria = null,
  bajoStock = null,
  sinStock = null,
  activo = null,
  tipo = null,
  manejaStock = null,
  desde = null,
  hasta = null
} = {}) {
  const productoWhere = ["COALESCE(p.eliminado, 0) = 0"];
  const productoParams = [];
  const categoriaFiltro = normalizarFiltroTexto(categoria);
  const tipoFiltro = normalizarFiltroTexto(tipo)?.toLowerCase();
  const activoFiltro = normalizarFiltroTexto(activo)?.toLowerCase();
  const manejaStockFiltro = normalizarFiltroTexto(manejaStock)?.toLowerCase();
  const soloBajoStock = normalizarBooleanFiltro(bajoStock);
  const soloSinStock = normalizarBooleanFiltro(sinStock);

  if (categoriaFiltro) {
    if (/^\d+$/.test(categoriaFiltro)) {
      productoWhere.push("p.categoria_id = ?");
      productoParams.push(Number(categoriaFiltro));
    } else {
      productoWhere.push("(LOWER(COALESCE(c.nombre, '')) = LOWER(?) OR LOWER(COALESCE(p.categoria, '')) = LOWER(?))");
      productoParams.push(categoriaFiltro, categoriaFiltro);
    }
  }

  if (tipoFiltro && tipoFiltro !== "todos") {
    productoWhere.push("LOWER(COALESCE(p.tipo, 'simple')) = ?");
    productoParams.push(tipoFiltro);
  }

  if (activoFiltro && activoFiltro !== "todos") {
    const activoValor = ["0", "false", "inactivo", "inactivos"].includes(activoFiltro) ? 0 : 1;
    productoWhere.push("COALESCE(p.activo, 0) = ?");
    productoParams.push(activoValor);
  }

  if (manejaStockFiltro && manejaStockFiltro !== "todos") {
    const manejaValor = ["0", "false", "no"].includes(manejaStockFiltro) ? 0 : 1;
    productoWhere.push("COALESCE(p.maneja_stock, 0) = ?");
    productoParams.push(manejaValor);
  }

  const vendidosWhere = ["COALESCE(v.estado, '') != 'anulado'", "COALESCE(v.tipo, '') != 'test_modificadores'"];
  const vendidosParams = [];
  if (desde) {
    vendidosWhere.push("v.fecha >= ?");
    vendidosParams.push(desde);
  }
  if (hasta) {
    vendidosWhere.push("v.fecha <= ?");
    vendidosParams.push(hasta);
  }

  const movimientosWhere = ["1 = 1"];
  const movimientosParams = [];
  if (desde) {
    movimientosWhere.push("ms.fecha >= ?");
    movimientosParams.push(desde);
  }
  if (hasta) {
    movimientosWhere.push("ms.fecha <= ?");
    movimientosParams.push(hasta);
  }

  const productosRows = await allQuery(
    `SELECT
       p.id,
       p.codigo,
       p.nombre,
       p.categoria,
       p.categoria_id,
       c.nombre AS categoria_nombre,
       p.tipo,
       p.es_combo,
       p.maneja_stock,
       p.activo,
       p.unidad_medida,
       p.stock,
       p.stock_minimo,
       p.usa_costos_varios,
       p.precio_compra,
       p.costo_final,
       COALESCE(ci.consumo_unidad, 0) AS consumo_unidad,
       COALESCE(vendidos.items_vendidos, 0) AS items_vendidos,
       COALESCE(movs.movimientos, 0) AS movimientos
     FROM productos p
     LEFT JOIN categorias c ON c.id = p.categoria_id
     LEFT JOIN (
       SELECT producto_id, COALESCE(SUM(cantidad_usada), 0) AS consumo_unidad
       FROM producto_costos_insumos
       GROUP BY producto_id
     ) ci ON ci.producto_id = p.id
     LEFT JOIN (
       SELECT dv.producto_id, COALESCE(SUM(dv.cantidad), 0) AS items_vendidos
       FROM detalle_ventas dv
       INNER JOIN ventas v ON v.id = dv.venta_id
       WHERE ${vendidosWhere.join(" AND ")}
       GROUP BY dv.producto_id
     ) vendidos ON vendidos.producto_id = p.id
     LEFT JOIN (
       SELECT producto_id, COUNT(*) AS movimientos
       FROM movimientos_stock ms
       WHERE ${movimientosWhere.join(" AND ")}
       GROUP BY producto_id
     ) movs ON movs.producto_id = p.id
     WHERE ${productoWhere.join(" AND ")}
     ORDER BY p.nombre ASC`,
    [...vendidosParams, ...movimientosParams, ...productoParams]
  );

  let productos = productosRows.map(mapReporteStockProducto);
  if (soloBajoStock) {
    productos = productos.filter((producto) => producto.estado_stock === "bajo_stock" || producto.estado_stock === "stock_negativo");
  }
  if (soloSinStock) {
    productos = productos.filter((producto) => producto.estado_stock === "sin_stock" || producto.estado_stock === "stock_negativo");
  }

  const alertas = productos
    .filter((producto) => ["bajo_stock", "sin_stock", "stock_negativo"].includes(producto.estado_stock))
    .sort((a, b) => {
      const prioridad = { stock_negativo: 0, sin_stock: 1, bajo_stock: 2 };
      return prioridad[a.estado_stock] - prioridad[b.estado_stock] || a.nombre.localeCompare(b.nombre);
    });

  const porCategoriaMap = new Map();
  for (const producto of productos) {
    const categoriaNombre = producto.categoria || "Sin categoria";
    if (!porCategoriaMap.has(categoriaNombre)) {
      porCategoriaMap.set(categoriaNombre, {
        categoria: categoriaNombre,
        productos: 0,
        bajo_stock: 0,
        sin_stock: 0,
        stock_negativo: 0,
        stock_valorizado_estimado: 0,
        items_vendidos: 0
      });
    }
    const categoriaItem = porCategoriaMap.get(categoriaNombre);
    categoriaItem.productos += 1;
    if (producto.estado_stock === "bajo_stock") categoriaItem.bajo_stock += 1;
    if (producto.estado_stock === "sin_stock") categoriaItem.sin_stock += 1;
    if (producto.estado_stock === "stock_negativo") categoriaItem.stock_negativo += 1;
    categoriaItem.stock_valorizado_estimado = round2(categoriaItem.stock_valorizado_estimado + producto.stock_valorizado_estimado);
    categoriaItem.items_vendidos = round2(categoriaItem.items_vendidos + producto.items_vendidos);
  }

  const movimientos = await allQuery(
    `SELECT
       ms.id,
       ms.fecha,
       ms.hora,
       ms.producto_id,
       p.nombre AS producto_nombre,
       ms.tipo_movimiento,
       ms.cantidad,
       ms.stock_anterior,
       ms.stock_nuevo,
       ms.motivo,
       ms.usuario
     FROM movimientos_stock ms
     LEFT JOIN productos p ON p.id = ms.producto_id
     WHERE ${movimientosWhere.join(" AND ")}
     ORDER BY ms.fecha DESC, ms.hora DESC, ms.id DESC
     LIMIT 150`,
    movimientosParams
  );

  return {
    filtros: {
      categoria: categoriaFiltro,
      bajo_stock: soloBajoStock,
      sin_stock: soloSinStock,
      activo: activoFiltro || "todos",
      tipo: tipoFiltro || "todos",
      maneja_stock: manejaStockFiltro || "todos",
      desde,
      hasta
    },
    resumen: {
      productos_total: productos.length,
      productos_activos: productos.filter((producto) => producto.activo !== 0).length,
      productos_inactivos: productos.filter((producto) => producto.activo === 0).length,
      bajo_stock: productos.filter((producto) => producto.estado_stock === "bajo_stock").length,
      sin_stock: productos.filter((producto) => producto.estado_stock === "sin_stock").length,
      stock_negativo: productos.filter((producto) => producto.estado_stock === "stock_negativo").length,
      categorias: porCategoriaMap.size,
      stock_valorizado_estimado: round2(productos.reduce((acc, producto) => acc + producto.stock_valorizado_estimado, 0)),
      items_vendidos: round2(productos.reduce((acc, producto) => acc + producto.items_vendidos, 0))
    },
    alertas,
    por_categoria: [...porCategoriaMap.values()]
      .map((item) => ({
        ...item,
        stock_valorizado_estimado: round2(item.stock_valorizado_estimado),
        items_vendidos: round2(item.items_vendidos)
      }))
      .sort((a, b) => b.stock_valorizado_estimado - a.stock_valorizado_estimado),
    productos,
    movimientos: movimientos.map((row) => ({
      id: Number(row.id),
      fecha: row.fecha,
      hora: row.hora,
      producto_id: row.producto_id == null ? null : Number(row.producto_id),
      producto_nombre: row.producto_nombre || null,
      tipo_movimiento: row.tipo_movimiento,
      cantidad: round2(row.cantidad),
      stock_anterior: round2(row.stock_anterior),
      stock_nuevo: round2(row.stock_nuevo),
      motivo: row.motivo || null,
      usuario: row.usuario || null
    }))
  };
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
  getReporteVentas,
  getReporteCaja,
  getReporteStock,
  getProductosMasVendidos,
  getResumenProveedoresPagos,
  getVentasPorDia,
  getResumenCuentasCobro
};
