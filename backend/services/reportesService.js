const { allQuery } = require("../db");

async function getResumenReportes({ desde = null, hasta = null } = {}) {
  const ventasWhere  = ["estado != 'anulado'"];
  const ventasWhereV = ["COALESCE(v.estado, '') != 'anulado'"];
  const pagosWhere   = ["estado != 'pendiente'"];
  const ventasParams = [];
  const pagosParams  = [];

  if (desde) {
    ventasWhere.push("fecha >= ?");
    ventasWhereV.push("v.fecha >= ?");
    pagosWhere.push("fecha >= ?");
    ventasParams.push(desde);
    pagosParams.push(desde);
  }
  if (hasta) {
    ventasWhere.push("fecha <= ?");
    ventasWhereV.push("v.fecha <= ?");
    pagosWhere.push("fecha <= ?");
    ventasParams.push(hasta);
    pagosParams.push(hasta);
  }

  const ventasWhereVSQL = ventasWhereV.join(" AND ");

  // cobros_cuenta_corriente: V2 (pagos_cc_cobros) + fallback legacy (group_id IS NULL)
  const ccV2Where = [];
  const ccV2Params = [];
  if (desde) { ccV2Where.push("pcc.fecha >= ?"); ccV2Params.push(desde); }
  if (hasta) { ccV2Where.push("pcc.fecha <= ?"); ccV2Params.push(hasta); }
  const ccV2SQL = ccV2Where.length ? `WHERE ${ccV2Where.join(" AND ")}` : "";

  const ccLegacyWhere = ["pcc.group_id IS NULL"];
  const ccLegacyParams = [];
  if (desde) { ccLegacyWhere.push("pcc.fecha >= ?"); ccLegacyParams.push(desde); }
  if (hasta) { ccLegacyWhere.push("pcc.fecha <= ?"); ccLegacyParams.push(hasta); }

  const [ventasRows, pagosRows, cobrosRows, cobrosCanalRows] = await Promise.all([
    allQuery(
      `SELECT
         COUNT(*) AS total_ventas,
         COALESCE(SUM(COALESCE(total_venta_original, total)), 0) AS valor_comercial_total,
         COALESCE(SUM(CASE WHEN COALESCE(estado, '') = 'cobrada'   AND COALESCE(es_cuenta_corriente, 0) = 0 THEN COALESCE(total_venta_original, total) ELSE 0 END), 0) AS ventas_cobradas,
         COALESCE(SUM(CASE WHEN COALESCE(estado, '') = 'pendiente' AND COALESCE(es_cuenta_corriente, 0) = 0 THEN COALESCE(total_venta_original, total) ELSE 0 END), 0) AS ventas_pendientes,
         COALESCE(SUM(CASE WHEN COALESCE(es_cuenta_corriente, 0) = 1 THEN COALESCE(total_venta_original, total) ELSE 0 END), 0) AS ventas_cuenta_corriente
       FROM ventas
       WHERE ${ventasWhere.join(" AND ")}`,
      ventasParams
    ),
    allQuery(
      `SELECT
         COUNT(*) AS total_pagos,
         COALESCE(SUM(monto_total), 0)        AS pagos_totales,
         COALESCE(SUM(monto_efectivo), 0)     AS pagos_efectivo,
         COALESCE(SUM(monto_debito), 0)       AS pagos_debito,
         COALESCE(SUM(iva_credito_fiscal), 0) AS iva_credito_fiscal
       FROM pagos
       WHERE ${pagosWhere.join(" AND ")}`,
      pagosParams
    ),
    allQuery(
      `SELECT COALESCE(SUM(total_cobro), 0) AS cobros_cc
       FROM (
         SELECT pcc.monto AS total_cobro
           FROM pagos_cc_cobros pcc
           ${ccV2SQL}
         UNION ALL
         SELECT pcc.monto_pagado AS total_cobro
           FROM pagos_cuenta_corriente pcc
           WHERE ${ccLegacyWhere.join(" AND ")}
       )`,
      [...ccV2Params, ...ccLegacyParams]
    ),
    allQuery(
      `SELECT
         COALESCE(SUM(CASE WHEN tipo_cobro = 'efectivo' THEN monto ELSE 0 END), 0) AS efectivo,
         COALESCE(SUM(CASE WHEN tipo_cobro = 'debito'   THEN monto ELSE 0 END), 0) AS debito
       FROM (
         SELECT vc.tipo_cobro, vc.monto
           FROM venta_cobros vc
           JOIN ventas v ON v.id = vc.venta_id
           WHERE vc.estado = 'confirmado'
             AND vc.tipo_cobro IN ('efectivo', 'debito')
             AND ${ventasWhereVSQL}
         UNION ALL
         SELECT 'efectivo', v.monto_efectivo
           FROM ventas v
           WHERE NOT EXISTS (SELECT 1 FROM venta_cobros vc WHERE vc.venta_id = v.id)
             AND ${ventasWhereVSQL}
             AND v.monto_efectivo > 0
         UNION ALL
         SELECT 'debito', v.monto_debito
           FROM ventas v
           WHERE NOT EXISTS (SELECT 1 FROM venta_cobros vc WHERE vc.venta_id = v.id)
             AND ${ventasWhereVSQL}
             AND v.monto_debito > 0
       )`,
      [...ventasParams, ...ventasParams, ...ventasParams]
    )
  ]);

  const v  = ventasRows[0]      || {};
  const p  = pagosRows[0]       || {};
  const cc = cobrosRows[0]      || {};
  const ch = cobrosCanalRows[0] || {};

  const r2 = (x) => Number(Number(x || 0).toFixed(2));

  const valor_comercial_total   = r2(v.valor_comercial_total);
  const ventas_cobradas         = r2(v.ventas_cobradas);
  const ventas_pendientes       = r2(v.ventas_pendientes);
  const ventas_cuenta_corriente = r2(v.ventas_cuenta_corriente);
  const cobros_cuenta_corriente = r2(cc.cobros_cc);
  const ingresos_reales         = r2(ventas_cobradas + cobros_cuenta_corriente);
  const pagos_totales           = r2(p.pagos_totales);
  const total_ventas            = Number(v.total_ventas || 0);
  const ventas_efectivo         = r2(ch.efectivo);
  const ventas_debito           = r2(ch.debito);

  return {
    // backward-compatible fields
    ventas_totales:     valor_comercial_total,
    pagos_totales,
    balance_general:    r2(ingresos_reales - pagos_totales),
    iva_credito_fiscal: r2(p.iva_credito_fiscal),
    ticket_promedio:    total_ventas > 0 ? r2(valor_comercial_total / total_ventas) : 0,
    total_ventas,
    total_pagos:        Number(p.total_pagos || 0),
    ventas_efectivo,
    ventas_debito,
    pagos_efectivo:     r2(p.pagos_efectivo),
    pagos_debito:       r2(p.pagos_debito),
    // new semantic fields
    valor_comercial_total,
    ventas_cobradas,
    ventas_pendientes,
    ventas_cuenta_corriente,
    cobros_cuenta_corriente,
    ingresos_reales
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
    estadosRows,
    porFranjaRows,
    porUsuarioRows
  ] = await Promise.all([
    allQuery(
      `SELECT
         COUNT(*) AS operaciones,
         COALESCE(SUM(COALESCE(v.total_venta_original, v.total)), 0) AS total_vendido,
         COALESCE(SUM(CASE WHEN COALESCE(v.estado, '') = 'cobrada' THEN COALESCE(v.total_venta_original, v.total) ELSE 0 END), 0) AS total_cobrado,
         COALESCE(SUM(CASE WHEN COALESCE(v.estado, '') = 'pendiente' THEN COALESCE(v.total_venta_original, v.total) ELSE 0 END), 0) AS total_pendiente,
         COALESCE(SUM(CASE WHEN COALESCE(v.es_cuenta_corriente, 0) = 1 OR COALESCE(v.estado, '') = 'cuenta_corriente_pendiente' THEN COALESCE(v.total_venta_original, v.total) ELSE 0 END), 0) AS total_cuenta_corriente,
         COALESCE(SUM(CASE WHEN COALESCE(v.es_cuenta_corriente, 0) = 1 OR COALESCE(v.estado, '') = 'cuenta_corriente_pendiente' THEN v.saldo_pendiente ELSE 0 END), 0) AS saldo_cuenta_corriente,
         COALESCE(SUM(v.monto_efectivo), 0) AS monto_efectivo,
         COALESCE(SUM(v.monto_debito), 0) AS monto_debito,
         COALESCE(SUM(CASE WHEN COALESCE(v.tipo_cobro, v.metodo_pago, '') = 'efectivo' THEN COALESCE(v.total_venta_original, v.total) ELSE 0 END), 0) AS ventas_efectivo,
         COALESCE(SUM(CASE WHEN COALESCE(v.tipo_cobro, v.metodo_pago, '') = 'debito' THEN COALESCE(v.total_venta_original, v.total) ELSE 0 END), 0) AS ventas_debito,
         COALESCE(SUM(CASE WHEN COALESCE(v.tipo_cobro, v.metodo_pago, '') = 'transferencia' THEN COALESCE(v.total_venta_original, v.total) ELSE 0 END), 0) AS ventas_transferencia,
         COALESCE(SUM(CASE WHEN COALESCE(v.tipo_cobro, v.metodo_pago, '') = 'mixto' THEN COALESCE(v.total_venta_original, v.total) ELSE 0 END), 0) AS ventas_mixto,
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
         COALESCE(SUM(COALESCE(v.total_venta_original, v.total)), 0) AS monto_anulado
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
         COALESCE(SUM(COALESCE(v.total_venta_original, v.total)), 0) AS total,
         COUNT(*) AS cantidad_ventas,
         COALESCE(SUM(COALESCE(v.total_venta_original, v.total)) / NULLIF(COUNT(*), 0), 0) AS ticket_promedio
       FROM ventas v
       WHERE ${productivasSql}
       GROUP BY v.fecha
       ORDER BY v.fecha ASC`,
      productivas.params
    ),
    allQuery(
      `WITH vp AS (SELECT * FROM ventas v WHERE ${productivasSql})
       SELECT
         tc.tipo_cobro,
         COALESCE(SUM(tc.monto), 0) AS total,
         COUNT(DISTINCT tc.venta_id) AS cantidad_ventas
       FROM (
         SELECT vc.tipo_cobro, vc.monto, vc.venta_id
           FROM venta_cobros vc JOIN vp v ON v.id = vc.venta_id
           WHERE vc.estado = 'confirmado'
         UNION ALL
         SELECT LOWER(COALESCE(v.tipo_cobro, v.metodo_pago, 'sin_método')),
           CASE WHEN LOWER(COALESCE(v.tipo_cobro,'')) = 'efectivo' THEN v.monto_efectivo ELSE v.monto_debito END,
           v.id
           FROM vp v
           WHERE NOT EXISTS (SELECT 1 FROM venta_cobros vc WHERE vc.venta_id = v.id)
             AND v.tipo_cobro NOT IN ('mixto') AND v.tipo_cobro IS NOT NULL
         UNION ALL
         SELECT 'efectivo', v.monto_efectivo, v.id FROM vp v
           WHERE NOT EXISTS (SELECT 1 FROM venta_cobros vc WHERE vc.venta_id = v.id)
             AND LOWER(COALESCE(v.tipo_cobro,'')) = 'mixto' AND v.monto_efectivo > 0
         UNION ALL
         SELECT 'debito', v.monto_debito, v.id FROM vp v
           WHERE NOT EXISTS (SELECT 1 FROM venta_cobros vc WHERE vc.venta_id = v.id)
             AND LOWER(COALESCE(v.tipo_cobro,'')) = 'mixto' AND v.monto_debito > 0
       ) tc
       GROUP BY tc.tipo_cobro
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
         COALESCE(SUM(COALESCE(v.total_venta_original, v.total)), 0) AS total
       FROM ventas v
       WHERE ${todasSql}
       GROUP BY estado
       ORDER BY cantidad DESC`,
      todas.params
    ),
    allQuery(
      `SELECT
         CAST(SUBSTR(v.hora, 1, 2) AS INTEGER) AS hora_num,
         PRINTF('%02d:00 - %02d:00',
           CAST(SUBSTR(v.hora, 1, 2) AS INTEGER),
           CAST(SUBSTR(v.hora, 1, 2) AS INTEGER) + 1
         ) AS franja,
         COUNT(*) AS cantidad_ventas,
         COALESCE(SUM(COALESCE(v.total_venta_original, v.total)), 0) AS total_vendido,
         COALESCE(SUM(COALESCE(v.total_venta_original, v.total)) / NULLIF(COUNT(*), 0), 0) AS ticket_promedio
       FROM ventas v
       WHERE ${productivasSql}
       GROUP BY hora_num
       ORDER BY hora_num ASC`,
      productivas.params
    ),
    allQuery(
      `SELECT
         COALESCE(v.usuario, 'Sin usuario') AS usuario_nombre,
         COUNT(*) AS cantidad_ventas,
         COALESCE(SUM(COALESCE(v.total_venta_original, v.total)), 0) AS total_vendido,
         COALESCE(SUM(COALESCE(v.total_venta_original, v.total)) / NULLIF(COUNT(*), 0), 0) AS ticket_promedio
       FROM ventas v
       WHERE ${productivasSql}
       GROUP BY usuario_nombre
       ORDER BY total_vendido DESC`,
      productivas.params
    )
  ]);

  const resumen = resumenRows[0] || {};
  const anuladasResumen = anuladasRows[0] || {};
  const detalleResumen = detalleResumenRows[0] || {};
  const totalVendido = round2(resumen.total_vendido);
  const operaciones = Number(resumen.operaciones || 0);
  const totalPorTipo = porTipoCobroRows.reduce((acc, row) => acc + Number(row.total || 0), 0);
  // Derive cobros breakdown from unified por_tipo_cobro (v2, no "mixto")
  const cobrosMap = new Map(porTipoCobroRows.map((r) => [String(r.tipo_cobro || "").toLowerCase(), round2(r.total)]));
  const cobros_efectivo = cobrosMap.get("efectivo") || 0;
  const cobros_debito = cobrosMap.get("debito") || 0;
  const cobros_transferencia = cobrosMap.get("transferencia") || 0;

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
      ventas_efectivo: cobros_efectivo,
      ventas_debito: cobros_debito,
      ventas_transferencia: cobros_transferencia,
      ventas_mixto: 0,
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
    })),
    por_franja_horaria: porFranjaRows.map((row) => ({
      franja: row.franja,
      hora: Number(row.hora_num),
      cantidad_ventas: Number(row.cantidad_ventas || 0),
      total_vendido: round2(row.total_vendido),
      ticket_promedio: round2(row.ticket_promedio)
    })),
    por_usuario: porUsuarioRows.map((row) => ({
      usuario_nombre: row.usuario_nombre,
      cantidad_ventas: Number(row.cantidad_ventas || 0),
      total_vendido: round2(row.total_vendido),
      ticket_promedio: round2(row.ticket_promedio)
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
      `-- CC 3.0A: un registro por group_id, canales reales de pagos_cc_cobros
       SELECT
         MIN(pcc.id)           AS id,
         pcc.fecha,
         pcc.hora,
         pcc.caja_id,
         NULL                  AS cuenta_cobro_id,
         NULL                  AS cuenta_nombre,
         'cobro_cuenta_corriente' AS tipo_operacion,
         'Cobro cuenta corriente #' || MIN(pcc.id) AS concepto,
         COALESCE(
           (SELECT CASE WHEN COUNT(DISTINCT pccx.tipo_cobro) > 1 THEN 'mixto'
                        ELSE MIN(pccx.tipo_cobro) END
            FROM pagos_cc_cobros pccx WHERE pccx.group_id = pcc.group_id),
           MIN(pcc.tipo_cobro)
         )                     AS metodo,
         SUM(pcc.monto_pagado) AS ingreso,
         0                     AS egreso,
         COALESCE(
           (SELECT SUM(pccx.monto) FROM pagos_cc_cobros pccx
            WHERE pccx.group_id = pcc.group_id AND pccx.tipo_cobro = 'efectivo'), 0
         )                     AS monto_efectivo,
         COALESCE(
           (SELECT SUM(pccx.monto) FROM pagos_cc_cobros pccx
            WHERE pccx.group_id = pcc.group_id AND pccx.tipo_cobro != 'efectivo'), 0
         )                     AS monto_debito,
         0                     AS iva_credito_fiscal
       FROM pagos_cuenta_corriente pcc
       INNER JOIN caja_aperturas ca ON ca.id = pcc.caja_id
       WHERE ${cobrosCuentaWhere.join(" AND ")}
         AND pcc.group_id IS NOT NULL
       GROUP BY pcc.group_id, pcc.fecha, pcc.hora, pcc.caja_id

       UNION ALL

       SELECT
         pcc.id,
         pcc.fecha,
         pcc.hora,
         pcc.caja_id,
         NULL AS cuenta_cobro_id,
         NULL AS cuenta_nombre,
         'cobro_cuenta_corriente'             AS tipo_operacion,
         'Cobro cuenta corriente #' || pcc.id AS concepto,
         COALESCE(pcc.tipo_cobro, 'Sin metodo') AS metodo,
         COALESCE(pcc.monto_pagado, 0)        AS ingreso,
         0                                    AS egreso,
         COALESCE(pcc.monto_efectivo, 0)      AS monto_efectivo,
         COALESCE(pcc.monto_debito, 0)        AS monto_debito,
         0                                    AS iva_credito_fiscal
       FROM pagos_cuenta_corriente pcc
       INNER JOIN caja_aperturas ca ON ca.id = pcc.caja_id
       WHERE ${cobrosCuentaWhere.join(" AND ")}
         AND pcc.group_id IS NULL`,
      [...cobrosCuentaParams, ...cobrosCuentaParams]
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

async function getResumenProveedoresPagos({
  desde = null,
  hasta = null,
  proveedor_id = null,
  estado = null,
  activo = null,
} = {}) {
  const activoStr = normalizarFiltroTexto(activo);
  const activoVal = activoStr !== null ? (normalizarBooleanFiltro(activoStr) ? 1 : 0) : null;

  // Condiciones JOIN para la query de proveedores (filtran pagos sin excluir proveedores sin pagos)
  const joinConds = ["p.proveedor_id = pr.id"];
  const joinParams = [];
  if (desde) { joinConds.push("p.fecha >= ?"); joinParams.push(desde); }
  if (hasta) { joinConds.push("p.fecha <= ?"); joinParams.push(hasta); }
  if (estado) { joinConds.push("p.estado = ?"); joinParams.push(estado); }

  // WHERE para proveedores
  const prvWhere = [];
  const prvParams = [];
  if (activoVal !== null) { prvWhere.push("pr.activo = ?"); prvParams.push(activoVal); }
  if (proveedor_id) { prvWhere.push("pr.id = ?"); prvParams.push(Number(proveedor_id)); }
  const prvWhereSQL = prvWhere.length ? `WHERE ${prvWhere.join(" AND ")}` : "";

  // WHERE para pagos
  const pagosWhere = [];
  const pagosParams = [];
  if (desde) { pagosWhere.push("p.fecha >= ?"); pagosParams.push(desde); }
  if (hasta) { pagosWhere.push("p.fecha <= ?"); pagosParams.push(hasta); }
  if (estado) { pagosWhere.push("p.estado = ?"); pagosParams.push(estado); }
  if (proveedor_id) { pagosWhere.push("p.proveedor_id = ?"); pagosParams.push(Number(proveedor_id)); }
  const pagosWhereSQL = pagosWhere.length ? `WHERE ${pagosWhere.join(" AND ")}` : "";

  const [proveedores, pagos, prvCountRows, porImpacto] = await Promise.all([
    // Proveedores con agregados del período
    allQuery(
      `SELECT
         pr.id                                                                     AS proveedor_id,
         COALESCE(pr.nombre, 'Sin proveedor')                                     AS proveedor_nombre,
         pr.cuit,
         pr.activo,
         COALESCE(pr.tipo_impacto, 'otro_no_computable')                          AS tipo_impacto,
         COALESCE(SUM(CASE WHEN p.estado != 'pendiente' THEN p.monto_total        ELSE 0 END), 0) AS total_pagado,
         COALESCE(SUM(CASE WHEN p.estado  = 'pendiente' THEN p.monto_total        ELSE 0 END), 0) AS total_pendiente,
         COALESCE(SUM(CASE WHEN p.estado != 'pendiente' THEN p.iva_credito_fiscal  ELSE 0 END), 0) AS iva_credito_fiscal,
         COUNT(p.id)                                                               AS cantidad_pagos,
         MAX(p.fecha)                                                              AS ultima_compra
       FROM proveedores pr
       LEFT JOIN pagos p ON ${joinConds.join(" AND ")}
       ${prvWhereSQL}
       GROUP BY pr.id, pr.nombre, pr.cuit, pr.activo, pr.tipo_impacto
       ORDER BY total_pagado DESC`,
      [...joinParams, ...prvParams]
    ),

    // Listado individual de pagos del período
    allQuery(
      `SELECT
         p.id,
         p.fecha,
         p.proveedor_id,
         COALESCE(pr.nombre, 'Sin proveedor') AS proveedor_nombre,
         p.estado,
         p.tipo_pago,
         p.monto_total,
         p.iva_credito_fiscal
       FROM pagos p
       LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
       ${pagosWhereSQL}
       ORDER BY p.fecha DESC, p.id DESC`,
      pagosParams
    ),

    // Totales globales de proveedores (sin filtro de período)
    allQuery(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN activo = 1  THEN 1 ELSE 0 END), 0) AS activos,
         COALESCE(SUM(CASE WHEN activo != 1 THEN 1 ELSE 0 END), 0) AS inactivos
       FROM proveedores`,
      []
    ),

    // Agrupación por tipo de impacto
    allQuery(
      `SELECT
         COALESCE(pr.tipo_impacto, p.categoria_pago, 'otro_no_computable')        AS tipo_impacto,
         COALESCE(SUM(CASE WHEN p.estado != 'pendiente' THEN p.monto_total        ELSE 0 END), 0) AS total_pagado,
         COALESCE(SUM(CASE WHEN p.estado  = 'pendiente' THEN p.monto_total        ELSE 0 END), 0) AS total_pendiente,
         COALESCE(SUM(CASE WHEN p.estado != 'pendiente' THEN p.iva_credito_fiscal  ELSE 0 END), 0) AS iva_credito_fiscal
       FROM pagos p
       LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
       ${pagosWhereSQL}
       GROUP BY tipo_impacto
       ORDER BY total_pagado DESC`,
      pagosParams
    ),
  ]);

  const prvTotales     = prvCountRows[0] || { total: 0, activos: 0, inactivos: 0 };
  const totalPagado    = round2(proveedores.reduce((a, x) => a + Number(x.total_pagado       || 0), 0));
  const totalPendiente = round2(proveedores.reduce((a, x) => a + Number(x.total_pendiente    || 0), 0));
  const ivaCredFiscal  = round2(proveedores.reduce((a, x) => a + Number(x.iva_credito_fiscal || 0), 0));

  return {
    filtros: {
      desde,
      hasta,
      proveedor_id: proveedor_id ? Number(proveedor_id) : null,
      estado,
      activo: activoVal,
    },
    resumen: {
      proveedores_total:     Number(prvTotales.total     || 0),
      proveedores_activos:   Number(prvTotales.activos   || 0),
      proveedores_inactivos: Number(prvTotales.inactivos || 0),
      pagos_periodo:         pagos.length,
      total_pagado:          totalPagado,
      total_pendiente:       totalPendiente,
      iva_credito_fiscal:    ivaCredFiscal,
      compras_periodo:       round2(totalPagado + totalPendiente),
    },
    proveedores,
    pagos,
    por_impacto: porImpacto,
  };
}

async function getVentasPorDia({ desde = null, hasta = null } = {}) {
  const where = ["estado != 'anulado'"];
  const params = [];

  if (desde) { where.push("fecha >= ?"); params.push(desde); }
  if (hasta) { where.push("fecha <= ?"); params.push(hasta); }

  return allQuery(
    `SELECT
       fecha,
       COALESCE(SUM(COALESCE(total_venta_original, total)), 0) AS total,
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

function obtenerCostoValorizacionFisica(row) {
  const costoUnitario = Number(row.costo_unitario_fisico || 0);
  if (costoUnitario > 0) {
    return {
      costo: costoUnitario,
      fuente: "costo_unitario",
      descripcion: "Valorizado por unidad física"
    };
  }

  const costoFinal = Number(row.costo_final || 0);
  if (costoFinal > 0) {
    return {
      costo: costoFinal,
      fuente: "costo_final",
      descripcion: "Valorizado por costo del producto"
    };
  }

  const precioCompra = Number(row.precio_compra || 0);
  if (precioCompra > 0) {
    return {
      costo: precioCompra,
      fuente: "precio_compra",
      descripcion: "Valorizado por costo del producto"
    };
  }

  return {
    costo: 0,
    fuente: "sin_costo",
    descripcion: "Sin costo para valorizar"
  };
}

function mapReporteStockProducto(row) {
  const tipo = String(row.tipo || "simple").toLowerCase();
  const manejaStock = Number(row.maneja_stock || 0) === 1 ? 1 : 0;
  const rendimientoReceta = Math.max(1, Number(row.rendimiento_receta || 1));
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

  const costoValorizacion = obtenerCostoValorizacionFisica(row);
  const costoBase = costoValorizacion.costo;
  const costoEstimado = Number(row.costo_final || row.precio_compra || 0);
  const stockValorizadoFisico = manejaStock === 1 && costoBase > 0
    ? round2(stockFisico * costoBase)
    : 0;
  const valorRendimientoEstimado = manejaStock !== 1 && costoEstimado > 0
    ? round2(Math.max(0, stockFisico) * costoEstimado)
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
    rendimiento_receta: rendimientoReceta,
    activo: Number(row.activo || 0),
    unidad_medida: row.unidad_medida || "unidad",
    stock_fisico: stockFisico,
    stock_vendible: stockVendible,
    stock_minimo: round2(row.stock_minimo),
    costo_base_estimado: round2(costoBase),
    costo_fuente: costoValorizacion.fuente,
    costo_valorizacion_fisica: round2(costoBase),
    fuente_valorizacion_fisica: costoValorizacion.fuente,
    descripcion_valorizacion_fisica: costoValorizacion.descripcion,
    stock_valorizado_fisico: stockValorizadoFisico,
    stock_valorizado_estimado: stockValorizadoFisico,
    valor_rendimiento_estimado: valorRendimientoEstimado,
    valorizacion_excluida_motivo: manejaStock === 1 ? null : "sin_stock_fisico",
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
       p.rendimiento_receta,
       p.activo,
       p.unidad_medida,
       p.stock,
       p.stock_minimo,
       p.usa_costos_varios,
       p.precio_compra,
       p.costo_final,
       COALESCE(ci.consumo_unidad, 0) AS consumo_unidad,
       COALESCE(ci.costo_unitario_fisico, 0) AS costo_unitario_fisico,
       COALESCE(vendidos.items_vendidos, 0) AS items_vendidos,
       COALESCE(movs.movimientos, 0) AS movimientos
     FROM productos p
     LEFT JOIN categorias c ON c.id = p.categoria_id
     LEFT JOIN (
       SELECT ci_base.producto_id,
              COALESCE(SUM(ci_base.cantidad_usada), 0) AS consumo_unidad,
              (
                SELECT ci_unit.costo_unitario
                FROM producto_costos_insumos ci_unit
                WHERE ci_unit.producto_id = ci_base.producto_id
                  AND COALESCE(ci_unit.costo_unitario, 0) > 0
                ORDER BY ci_unit.id ASC
                LIMIT 1
              ) AS costo_unitario_fisico
       FROM producto_costos_insumos ci_base
       GROUP BY ci_base.producto_id
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
        stock_valorizado_fisico: 0,
        valor_rendimiento_estimado: 0,
        items_vendidos: 0
      });
    }
    const categoriaItem = porCategoriaMap.get(categoriaNombre);
    categoriaItem.productos += 1;
    if (producto.estado_stock === "bajo_stock") categoriaItem.bajo_stock += 1;
    if (producto.estado_stock === "sin_stock") categoriaItem.sin_stock += 1;
    if (producto.estado_stock === "stock_negativo") categoriaItem.stock_negativo += 1;
    categoriaItem.stock_valorizado_estimado = round2(categoriaItem.stock_valorizado_estimado + producto.stock_valorizado_fisico);
    categoriaItem.stock_valorizado_fisico = round2((categoriaItem.stock_valorizado_fisico || 0) + producto.stock_valorizado_fisico);
    categoriaItem.valor_rendimiento_estimado = round2((categoriaItem.valor_rendimiento_estimado || 0) + producto.valor_rendimiento_estimado);
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
      stock_valorizado_fisico: round2(productos.reduce((acc, producto) => acc + producto.stock_valorizado_fisico, 0)),
      stock_valorizado_estimado: round2(productos.reduce((acc, producto) => acc + producto.stock_valorizado_fisico, 0)),
      valor_rendimiento_estimado: round2(productos.reduce((acc, producto) => acc + producto.valor_rendimiento_estimado, 0)),
      items_vendidos: round2(productos.reduce((acc, producto) => acc + producto.items_vendidos, 0))
    },
    alertas,
    por_categoria: [...porCategoriaMap.values()]
      .map((item) => ({
        ...item,
        stock_valorizado_estimado: round2(item.stock_valorizado_estimado),
        stock_valorizado_fisico: round2(item.stock_valorizado_fisico || item.stock_valorizado_estimado),
        valor_rendimiento_estimado: round2(item.valor_rendimiento_estimado || 0),
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

function normalizarEstadoCuentaCorriente(value) {
  const estado = String(value || "todos").trim().toLowerCase();
  return ["con_deuda", "sin_deuda", "excedidos"].includes(estado) ? estado : "todos";
}

function mapReporteCuentaCorrienteCliente(row) {
  const deudaActual = round2(row.deuda_actual);
  const limiteCredito = round2(row.limite_fiado);
  const deudaVencida = round2(row.deuda_vencida);
  return {
    cliente_id: Number(row.id),
    nombre: row.nombre,
    dni_cuit: row.dni_cuit || null,
    tipo_cliente: row.tipo_cliente || "cliente",
    activo: Number(row.activo || 0),
    habilita_cuenta_corriente: Boolean(Number(row.habilita_cuenta_corriente || 0)),
    suspendido: Boolean(Number(row.suspendido || 0)),
    requiere_autorizacion: Boolean(Number(row.requiere_autorizacion || 0)),
    dias_vencimiento: Number(row.dias_vencimiento || 30),
    deuda_actual: deudaActual,
    deuda_vencida: deudaVencida,
    deuda_no_vencida: round2(deudaActual - deudaVencida),
    dias_max_en_deuda: Number(row.dias_max_en_deuda || 0),
    ventas_vencidas: Number(row.ventas_vencidas || 0),
    limite_credito: limiteCredito,
    excedido: limiteCredito > 0 && deudaActual > limiteCredito,
    primera_deuda: row.primera_deuda || null,
    ultima_venta: row.ultima_venta || null,
    ultimo_pago: row.ultimo_pago || null,
    cobrado_periodo: round2(row.cobrado_periodo),
    ventas_periodo: Number(row.ventas_periodo || 0),
    monto_ventas_periodo: round2(row.monto_ventas_periodo)
  };
}

async function getReporteCuentasCorrientes({
  desde = null,
  hasta = null,
  clienteId = null,
  estado = null,
  activo = null
} = {}) {
  const cliente = normalizarIdOpcional(clienteId);
  const estadoFiltro = normalizarEstadoCuentaCorriente(estado);
  const activoFiltro = normalizarFiltroTexto(activo)?.toLowerCase() || "todos";
  const clientesWhere = ["1 = 1"];
  const clientesParams = [];

  if (cliente) {
    clientesWhere.push("c.id = ?");
    clientesParams.push(cliente);
  }

  if (activoFiltro !== "todos") {
    const activoValor = ["0", "false", "inactivo", "inactivos"].includes(activoFiltro) ? 0 : 1;
    clientesWhere.push("COALESCE(c.activo, 0) = ?");
    clientesParams.push(activoValor);
  }

  const ventasBaseWhere = [
    "COALESCE(v.es_cuenta_corriente, 0) = 1",
    "v.cliente_id IS NOT NULL",
    "COALESCE(v.estado, '') != 'anulado'",
    "COALESCE(v.tipo, '') != 'test_modificadores'"
  ];

  const ventasPeriodoWhere = [...ventasBaseWhere];
  const ventasPeriodoParams = [];
  if (desde) {
    ventasPeriodoWhere.push("v.fecha >= ?");
    ventasPeriodoParams.push(desde);
  }
  if (hasta) {
    ventasPeriodoWhere.push("v.fecha <= ?");
    ventasPeriodoParams.push(hasta);
  }

  const cobrosPeriodoWhere = [
    "pcc.cliente_id IS NOT NULL",
    "(v.id IS NULL OR (COALESCE(v.estado, '') != 'anulado' AND COALESCE(v.tipo, '') != 'test_modificadores'))"
  ];
  const cobrosPeriodoParams = [];
  if (desde) {
    cobrosPeriodoWhere.push("pcc.fecha >= ?");
    cobrosPeriodoParams.push(desde);
  }
  if (hasta) {
    cobrosPeriodoWhere.push("pcc.fecha <= ?");
    cobrosPeriodoParams.push(hasta);
  }

  const clientesRows = await allQuery(
    `SELECT
       c.id,
       c.nombre,
       c.dni_cuit,
       c.tipo_cliente,
       c.activo,
       c.limite_fiado,
       c.dias_vencimiento,
       c.suspendido,
       c.requiere_autorizacion,
       c.habilita_cuenta_corriente,
       COALESCE(deuda.deuda_actual, 0) AS deuda_actual,
       COALESCE(deuda.deuda_vencida, 0) AS deuda_vencida,
       COALESCE(deuda.deuda_no_vencida, 0) AS deuda_no_vencida,
       COALESCE(deuda.dias_max_en_deuda, 0) AS dias_max_en_deuda,
       COALESCE(deuda.ventas_vencidas, 0) AS ventas_vencidas,
       deuda.primera_deuda,
       deuda.ultima_venta,
       cobros.ultimo_pago,
       COALESCE(cobros.cobrado_periodo, 0) AS cobrado_periodo,
       COALESCE(ventas_periodo.ventas_periodo, 0) AS ventas_periodo,
       COALESCE(ventas_periodo.monto_ventas_periodo, 0) AS monto_ventas_periodo
     FROM clientes c
     LEFT JOIN (
       SELECT
         v.cliente_id,
         COALESCE(SUM(v.saldo_pendiente), 0) AS deuda_actual,
         COALESCE(SUM(CASE WHEN COALESCE(v.saldo_pendiente, 0) > 0
           AND (julianday('now') - julianday(v.fecha)) > cl.dias_vencimiento
           THEN v.saldo_pendiente ELSE 0 END), 0) AS deuda_vencida,
         COALESCE(SUM(CASE WHEN COALESCE(v.saldo_pendiente, 0) > 0
           AND (julianday('now') - julianday(v.fecha)) <= cl.dias_vencimiento
           THEN v.saldo_pendiente ELSE 0 END), 0) AS deuda_no_vencida,
         CAST(COALESCE(MAX(CASE WHEN COALESCE(v.saldo_pendiente, 0) > 0
           THEN julianday('now') - julianday(v.fecha) ELSE NULL END), 0) AS INTEGER) AS dias_max_en_deuda,
         COALESCE(SUM(CASE WHEN COALESCE(v.saldo_pendiente, 0) > 0
           AND (julianday('now') - julianday(v.fecha)) > cl.dias_vencimiento
           THEN 1 ELSE 0 END), 0) AS ventas_vencidas,
         MIN(CASE WHEN COALESCE(v.saldo_pendiente, 0) > 0 THEN v.fecha ELSE NULL END) AS primera_deuda,
         MAX(v.fecha) AS ultima_venta
       FROM ventas v
       JOIN clientes cl ON cl.id = v.cliente_id
       WHERE ${ventasBaseWhere.join(" AND ")}
       GROUP BY v.cliente_id
     ) deuda ON deuda.cliente_id = c.id
     LEFT JOIN (
       SELECT
         v.cliente_id,
         COUNT(*) AS ventas_periodo,
         COALESCE(SUM(COALESCE(v.total_venta_original, v.total)), 0) AS monto_ventas_periodo
       FROM ventas v
       WHERE ${ventasPeriodoWhere.join(" AND ")}
       GROUP BY v.cliente_id
     ) ventas_periodo ON ventas_periodo.cliente_id = c.id
     LEFT JOIN (
       SELECT
         pcc.cliente_id,
         COALESCE(SUM(pcc.monto_pagado), 0) AS cobrado_periodo,
         MAX(pcc.fecha) AS ultimo_pago
       FROM pagos_cuenta_corriente pcc
       LEFT JOIN ventas v ON v.id = pcc.venta_id
       WHERE ${cobrosPeriodoWhere.join(" AND ")}
       GROUP BY pcc.cliente_id
     ) cobros ON cobros.cliente_id = c.id
     WHERE ${clientesWhere.join(" AND ")}
     ORDER BY c.nombre ASC`,
    [...ventasPeriodoParams, ...cobrosPeriodoParams, ...clientesParams]
  );

  let clientes = clientesRows.map(mapReporteCuentaCorrienteCliente);
  if (estadoFiltro === "con_deuda") {
    clientes = clientes.filter((item) => item.deuda_actual > 0);
  } else if (estadoFiltro === "sin_deuda") {
    clientes = clientes.filter((item) => item.deuda_actual <= 0);
  } else if (estadoFiltro === "excedidos") {
    clientes = clientes.filter((item) => item.excedido);
  }

  const clienteIds = clientes.map((item) => item.cliente_id);
  let movimientos = [];
  if (clienteIds.length) {
    const placeholders = clienteIds.map(() => "?").join(",");
    const movimientosVentasWhere = [
      ...ventasBaseWhere,
      `v.cliente_id IN (${placeholders})`
    ];
    const movimientosVentasParams = [...clienteIds];
    if (desde) {
      movimientosVentasWhere.push("v.fecha >= ?");
      movimientosVentasParams.push(desde);
    }
    if (hasta) {
      movimientosVentasWhere.push("v.fecha <= ?");
      movimientosVentasParams.push(hasta);
    }

    const movimientosCobrosWhere = [
      "pcc.cliente_id IN (" + placeholders + ")",
      "(v.id IS NULL OR (COALESCE(v.estado, '') != 'anulado' AND COALESCE(v.tipo, '') != 'test_modificadores'))"
    ];
    const movimientosCobrosParams = [...clienteIds];
    if (desde) {
      movimientosCobrosWhere.push("pcc.fecha >= ?");
      movimientosCobrosParams.push(desde);
    }
    if (hasta) {
      movimientosCobrosWhere.push("pcc.fecha <= ?");
      movimientosCobrosParams.push(hasta);
    }

    movimientos = await allQuery(
      `SELECT *
       FROM (
         SELECT
           v.id AS id,
           v.fecha,
           v.hora,
           v.cliente_id,
           c.nombre AS cliente_nombre,
           'venta' AS tipo_movimiento,
           COALESCE(v.total_venta_original, v.total) AS importe,
           v.saldo_pendiente,
           v.tipo_cobro,
           v.id AS venta_id
         FROM ventas v
         LEFT JOIN clientes c ON c.id = v.cliente_id
         WHERE ${movimientosVentasWhere.join(" AND ")}
         UNION ALL
         SELECT
           pcc.id AS id,
           pcc.fecha,
           pcc.hora,
           pcc.cliente_id,
           c.nombre AS cliente_nombre,
           'pago' AS tipo_movimiento,
           pcc.monto_pagado AS importe,
           NULL AS saldo_pendiente,
           pcc.tipo_cobro,
           pcc.venta_id
         FROM pagos_cuenta_corriente pcc
         LEFT JOIN ventas v ON v.id = pcc.venta_id
         LEFT JOIN clientes c ON c.id = pcc.cliente_id
         WHERE ${movimientosCobrosWhere.join(" AND ")}
       )
       ORDER BY fecha DESC, hora DESC, id DESC
       LIMIT 200`,
      [...movimientosVentasParams, ...movimientosCobrosParams]
    );
  }

  return {
    filtros: {
      desde,
      hasta,
      cliente_id: cliente,
      estado: estadoFiltro,
      activo: activoFiltro
    },
    resumen: {
      clientes_total: clientes.length,
      clientes_activos: clientes.filter((item) => item.activo !== 0).length,
      clientes_inactivos: clientes.filter((item) => item.activo === 0).length,
      clientes_con_deuda: clientes.filter((item) => item.deuda_actual > 0).length,
      deuda_total: round2(clientes.reduce((acc, item) => acc + item.deuda_actual, 0)),
      deuda_vencida: round2(clientes.reduce((acc, item) => acc + item.deuda_vencida, 0)),
      deuda_no_vencida: round2(clientes.reduce((acc, item) => acc + item.deuda_no_vencida, 0)),
      clientes_con_deuda_vencida: clientes.filter((item) => item.deuda_vencida > 0).length,
      clientes_excedidos: clientes.filter((item) => item.excedido).length,
      clientes_requieren_autorizacion: clientes.filter((item) => item.deuda_actual > 0 && item.requiere_autorizacion).length,
      cobrado_periodo: round2(clientes.reduce((acc, item) => acc + item.cobrado_periodo, 0)),
      ventas_cuenta_corriente: clientes.reduce((acc, item) => acc + item.ventas_periodo, 0),
      monto_ventas_cuenta_corriente: round2(clientes.reduce((acc, item) => acc + item.monto_ventas_periodo, 0))
    },
    clientes,
    movimientos: movimientos.map((row) => ({
      id: Number(row.id),
      fecha: row.fecha,
      hora: row.hora,
      cliente_id: row.cliente_id == null ? null : Number(row.cliente_id),
      cliente_nombre: row.cliente_nombre || null,
      tipo_movimiento: row.tipo_movimiento,
      importe: round2(row.importe),
      saldo_pendiente: row.saldo_pendiente == null ? null : round2(row.saldo_pendiente),
      tipo_cobro: row.tipo_cobro || null,
      venta_id: row.venta_id == null ? null : Number(row.venta_id)
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
  const cobrosCcWhere = [];
  const cobrosCcParams = [];

  if (desde) {
    ventasWhere.push("v.fecha >= ?");
    pagosWhere.push("p.fecha >= ?");
    conciliacionesWhere.push("c.fecha >= ?");
    cobrosCcWhere.push("pcc.fecha >= ?");
    ventasParams.push(desde);
    pagosParams.push(desde);
    conciliacionesParams.push(desde);
    cobrosCcParams.push(desde);
  }
  if (hasta) {
    ventasWhere.push("v.fecha <= ?");
    pagosWhere.push("p.fecha <= ?");
    conciliacionesWhere.push("c.fecha <= ?");
    cobrosCcWhere.push("pcc.fecha <= ?");
    ventasParams.push(hasta);
    pagosParams.push(hasta);
    conciliacionesParams.push(hasta);
    cobrosCcParams.push(hasta);
  }

  const conciliacionesClause = conciliacionesWhere.length ? `WHERE ${conciliacionesWhere.join(" AND ")}` : "";
  const cobrosCcClause = cobrosCcWhere.length ? `AND ${cobrosCcWhere.join(" AND ")}` : "";
  const [ventas, pagos, conciliaciones, cobrosCc] = await Promise.all([
    allQuery(
      `WITH vb AS (SELECT * FROM ventas v WHERE ${ventasWhere.join(" AND ")})
       SELECT
         vc_or_v.cuenta_cobro_id,
         COALESCE(vc_or_v.cuenta_cobro_nombre_snapshot, cc.nombre, 'Sin cuenta') AS cuenta_nombre,
         COALESCE(vc_or_v.cuenta_cobro_tipo_pago_snapshot, cc.tipo_pago_codigo, vc_or_v.tipo_cobro) AS tipo_pago_codigo,
         COALESCE(SUM(vc_or_v.monto), 0) AS ingresos,
         COUNT(DISTINCT vc_or_v.venta_id) AS ventas
       FROM (
         SELECT vc.cuenta_cobro_id, vc.tipo_cobro, vc.monto, vc.venta_id, vc.cuenta_cobro_nombre_snapshot, vc.cuenta_cobro_tipo_pago_snapshot
           FROM venta_cobros vc JOIN vb v ON v.id = vc.venta_id
           WHERE vc.estado = 'confirmado'
         UNION ALL
         SELECT v.cuenta_cobro_id, COALESCE(v.tipo_cobro, v.metodo_pago), v.total, v.id, NULL, NULL
           FROM vb v WHERE NOT EXISTS (SELECT 1 FROM venta_cobros vc WHERE vc.venta_id = v.id)
       ) vc_or_v
       LEFT JOIN cuentas_cobro cc ON cc.id = vc_or_v.cuenta_cobro_id
       GROUP BY vc_or_v.cuenta_cobro_id, cuenta_nombre, tipo_pago_codigo`,
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
    ),
    allQuery(
      `SELECT
         pcc.cuenta_cobro_id,
         COALESCE(pcc.cuenta_cobro_nombre_snapshot, cc.nombre, 'Sin cuenta') AS cuenta_nombre,
         COALESCE(pcc.cuenta_cobro_tipo_pago_snapshot, cc.tipo_pago_codigo, pcc.tipo_cobro) AS tipo_pago_codigo,
         COALESCE(SUM(pcc.monto), 0) AS ingresos
       FROM pagos_cc_cobros pcc
       LEFT JOIN cuentas_cobro cc ON cc.id = pcc.cuenta_cobro_id
       WHERE 1=1 ${cobrosCcClause}
       GROUP BY pcc.cuenta_cobro_id, cuenta_nombre, tipo_pago_codigo`,
      cobrosCcParams
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

  for (const row of cobrosCc) {
    const item = upsertCuenta(porCuenta, row);
    item.ingresos = round2(item.ingresos + Number(row.ingresos || 0));
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

async function getReporteModificadores({ desde = null, hasta = null } = {}) {
  const fechaWhere = [];
  const fechaParams = [];
  if (desde) { fechaWhere.push("v.fecha >= ?"); fechaParams.push(desde); }
  if (hasta) { fechaWhere.push("v.fecha <= ?"); fechaParams.push(hasta); }

  const fechaJoin = fechaWhere.length ? "AND " + fechaWhere.join(" AND ") : "";

  const baseConditions = [
    "COALESCE(v.estado, '') != 'anulado'",
    "COALESCE(v.tipo, '') != 'test_modificadores'",
    ...fechaWhere
  ];
  const baseSql = baseConditions.join(" AND ");

  const [
    modificadoresRows,
    ingredientesRows,
    combosRows,
    productosConModsRows
  ] = await Promise.all([
    allQuery(
      `SELECT
         dvm.modificador_id,
         dvm.nombre AS nombre_modificador,
         dvm.tipo,
         COUNT(*) AS veces_elegido,
         COALESCE(SUM(dvm.cantidad), 0) AS cantidad_total,
         COALESCE(SUM(dvm.precio_extra * dvm.cantidad), 0) AS total_facturado,
         COUNT(DISTINCT dv.venta_id) AS ventas_distintas
       FROM detalle_venta_modificadores dvm
       JOIN detalle_ventas dv ON dv.id = dvm.detalle_venta_id
       JOIN ventas v ON v.id = dv.venta_id
       WHERE ${baseSql}
       GROUP BY dvm.modificador_id, dvm.nombre, dvm.tipo
       ORDER BY veces_elegido DESC`,
      fechaParams
    ),
    allQuery(
      `SELECT
         dvi.nombre AS nombre_ingrediente,
         dvi.tipo,
         COUNT(*) AS veces,
         COALESCE(SUM(dvi.cantidad), 0) AS cantidad_total,
         COUNT(DISTINCT dv.venta_id) AS ventas_distintas
       FROM detalle_venta_ingredientes dvi
       JOIN detalle_ventas dv ON dv.id = dvi.detalle_venta_id
       JOIN ventas v ON v.id = dv.venta_id
       WHERE COALESCE(v.estado, '') != 'anulado'
         AND dvi.tipo = 'quitar'
         ${fechaJoin}
       GROUP BY dvi.nombre, dvi.tipo
       ORDER BY veces DESC`,
      fechaParams
    ),
    allQuery(
      `SELECT
         dv.producto_id,
         dv.nombre_producto,
         COUNT(DISTINCT v.id) AS ventas_distintas,
         COALESCE(SUM(dv.cantidad), 0) AS unidades_vendidas,
         COALESCE(SUM(dv.subtotal), 0) AS total_facturado
       FROM detalle_ventas dv
       JOIN ventas v ON v.id = dv.venta_id
       JOIN productos p ON p.id = dv.producto_id
       WHERE p.es_combo = 1
         AND COALESCE(v.estado, '') != 'anulado'
         ${fechaJoin}
       GROUP BY dv.producto_id, dv.nombre_producto
       ORDER BY total_facturado DESC`,
      fechaParams
    ),
    allQuery(
      `SELECT
         dv.producto_id,
         dv.nombre_producto,
         COUNT(dvm.id) AS total_modificadores,
         COUNT(DISTINCT v.id) AS ventas_distintas,
         COALESCE(SUM(dvm.precio_extra * dvm.cantidad), 0) AS total_facturado_modificadores
       FROM detalle_ventas dv
       JOIN ventas v ON v.id = dv.venta_id
       JOIN detalle_venta_modificadores dvm ON dvm.detalle_venta_id = dv.id
       WHERE ${baseSql}
       GROUP BY dv.producto_id, dv.nombre_producto
       ORDER BY total_modificadores DESC`,
      fechaParams
    )
  ]);

  const modificadoresMasUsados = modificadoresRows.map((row) => ({
    nombre_modificador: row.nombre_modificador,
    tipo: row.tipo,
    veces_elegido: Number(row.veces_elegido || 0),
    cantidad_total: round2(row.cantidad_total),
    total_facturado: round2(row.total_facturado),
    ventas_distintas: Number(row.ventas_distintas || 0)
  }));

  return {
    filtros: { desde, hasta },
    modificadores_mas_usados: modificadoresMasUsados,
    extras_mas_facturan: modificadoresMasUsados
      .filter((m) => m.total_facturado > 0)
      .sort((a, b) => b.total_facturado - a.total_facturado),
    opciones_sin_impacto: modificadoresMasUsados
      .filter((m) => m.tipo === "observacion")
      .sort((a, b) => b.veces_elegido - a.veces_elegido),
    ingredientes_mas_quitados: ingredientesRows.map((row) => ({
      nombre_ingrediente: row.nombre_ingrediente,
      tipo: row.tipo,
      veces: Number(row.veces || 0),
      cantidad_total: round2(row.cantidad_total),
      ventas_distintas: Number(row.ventas_distintas || 0)
    })),
    combos_mas_vendidos: combosRows.map((row) => ({
      producto_id: row.producto_id == null ? null : Number(row.producto_id),
      nombre_producto: row.nombre_producto,
      ventas_distintas: Number(row.ventas_distintas || 0),
      unidades_vendidas: round2(row.unidades_vendidas),
      total_facturado: round2(row.total_facturado)
    })),
    productos_con_mas_modificadores: productosConModsRows.map((row) => ({
      producto_id: row.producto_id == null ? null : Number(row.producto_id),
      nombre_producto: row.nombre_producto,
      total_modificadores: Number(row.total_modificadores || 0),
      ventas_distintas: Number(row.ventas_distintas || 0),
      total_facturado_modificadores: round2(row.total_facturado_modificadores)
    }))
  };
}

async function getReporteDesviosReceta({ desde = null, hasta = null } = {}) {
  const fechaWhere = [];
  const fechaParams = [];
  if (desde) { fechaWhere.push("sap.fecha >= ?"); fechaParams.push(desde); }
  if (hasta) { fechaWhere.push("sap.fecha <= ?"); fechaParams.push(hasta); }

  const baseWhere = [
    "sap.motivo LIKE 'Consumo teorico venta receta: %'",
    ...fechaWhere
  ];
  const baseSql = baseWhere.join(" AND ");

  const [resumenRows, productosRows, recetasRows, itemsRows] = await Promise.all([
    allQuery(
      `SELECT
         COUNT(*) AS total_ajustes,
         COALESCE(SUM(CASE WHEN sap.estado = 'pendiente' THEN 1 ELSE 0 END), 0) AS total_pendiente,
         COALESCE(SUM(CASE WHEN sap.estado IN ('aprobado', 'corregido') THEN 1 ELSE 0 END), 0) AS total_aprobado,
         COALESCE(SUM(CASE WHEN sap.estado = 'rechazado' THEN 1 ELSE 0 END), 0) AS total_rechazado,
         COALESCE(SUM(sap.cantidad), 0) AS cantidad_total_detectada,
         COALESCE(SUM(COALESCE(NULLIF(p.costo_final, 0), NULLIF(p.precio_compra, 0), 0) * sap.cantidad), 0) AS impacto_estimado_total
       FROM stock_ajustes_pendientes sap
       JOIN productos p ON p.id = sap.producto_id
       WHERE ${baseSql}`,
      fechaParams
    ),
    allQuery(
      `SELECT
         sap.producto_id,
         p.nombre AS producto_nombre,
         COALESCE(SUM(sap.cantidad), 0) AS cantidad_detectada,
         COALESCE(SUM(COALESCE(sap.cantidad_aprobada, 0)), 0) AS cantidad_aprobada,
         COALESCE(SUM(CASE WHEN sap.estado = 'pendiente' THEN sap.cantidad ELSE 0 END), 0) AS cantidad_pendiente,
         COUNT(*) AS ajustes_total,
         COALESCE(SUM(CASE WHEN sap.estado IN ('aprobado', 'corregido') THEN 1 ELSE 0 END), 0) AS ajustes_aprobados,
         COALESCE(SUM(CASE WHEN sap.estado = 'rechazado' THEN 1 ELSE 0 END), 0) AS ajustes_rechazados,
         COALESCE(SUM(CASE WHEN sap.estado = 'pendiente' THEN 1 ELSE 0 END), 0) AS ajustes_pendientes,
         COALESCE(SUM(COALESCE(NULLIF(p.costo_final, 0), NULLIF(p.precio_compra, 0), 0) * sap.cantidad), 0) AS impacto_estimado
       FROM stock_ajustes_pendientes sap
       JOIN productos p ON p.id = sap.producto_id
       WHERE ${baseSql}
       GROUP BY sap.producto_id, p.nombre
       ORDER BY impacto_estimado DESC`,
      fechaParams
    ),
    allQuery(
      `SELECT
         SUBSTR(sap.motivo, LENGTH('Consumo teorico venta receta: ') + 1) AS receta_nombre,
         COUNT(*) AS ajustes_total,
         COALESCE(SUM(sap.cantidad), 0) AS cantidad_detectada,
         COUNT(DISTINCT sap.producto_id) AS productos_afectados,
         COALESCE(SUM(COALESCE(NULLIF(p.costo_final, 0), NULLIF(p.precio_compra, 0), 0) * sap.cantidad), 0) AS impacto_estimado
       FROM stock_ajustes_pendientes sap
       JOIN productos p ON p.id = sap.producto_id
       WHERE ${baseSql}
       GROUP BY receta_nombre
       ORDER BY impacto_estimado DESC`,
      fechaParams
    ),
    allQuery(
      `SELECT
         sap.fecha,
         sap.producto_id,
         p.nombre AS producto_nombre,
         sap.cantidad,
         sap.estado,
         sap.motivo,
         SUBSTR(sap.motivo, LENGTH('Consumo teorico venta receta: ') + 1) AS receta_nombre,
         sap.solicitado_por,
         sap.resuelto_por,
         COALESCE(NULLIF(p.costo_final, 0), NULLIF(p.precio_compra, 0), 0) * sap.cantidad AS impacto_estimado
       FROM stock_ajustes_pendientes sap
       JOIN productos p ON p.id = sap.producto_id
       WHERE ${baseSql}
       ORDER BY sap.fecha DESC, sap.hora DESC, sap.id DESC
       LIMIT 50`,
      fechaParams
    )
  ]);

  const res = resumenRows[0] || {};
  return {
    filtros: { desde, hasta },
    resumen: {
      total_ajustes: Number(res.total_ajustes || 0),
      total_pendiente: Number(res.total_pendiente || 0),
      total_aprobado: Number(res.total_aprobado || 0),
      total_rechazado: Number(res.total_rechazado || 0),
      productos_afectados: productosRows.length,
      cantidad_total_detectada: round2(res.cantidad_total_detectada),
      impacto_estimado_total: round2(res.impacto_estimado_total)
    },
    productos: productosRows.map((row) => ({
      producto_id: Number(row.producto_id),
      producto_nombre: row.producto_nombre,
      cantidad_detectada: round2(row.cantidad_detectada),
      cantidad_aprobada: round2(row.cantidad_aprobada),
      cantidad_pendiente: round2(row.cantidad_pendiente),
      ajustes_total: Number(row.ajustes_total || 0),
      ajustes_aprobados: Number(row.ajustes_aprobados || 0),
      ajustes_rechazados: Number(row.ajustes_rechazados || 0),
      ajustes_pendientes: Number(row.ajustes_pendientes || 0),
      impacto_estimado: round2(row.impacto_estimado)
    })),
    recetas: recetasRows.map((row) => ({
      receta_nombre: row.receta_nombre,
      ajustes_total: Number(row.ajustes_total || 0),
      cantidad_detectada: round2(row.cantidad_detectada),
      productos_afectados: Number(row.productos_afectados || 0),
      impacto_estimado: round2(row.impacto_estimado)
    })),
    items: itemsRows.map((row) => ({
      fecha: row.fecha,
      producto_id: Number(row.producto_id),
      producto_nombre: row.producto_nombre,
      cantidad: round2(row.cantidad),
      estado: row.estado,
      motivo: row.motivo,
      receta_nombre: row.receta_nombre,
      solicitado_por: row.solicitado_por || null,
      resuelto_por: row.resuelto_por || null,
      impacto_estimado: round2(row.impacto_estimado)
    }))
  };
}

async function getReporteSaludInventario() {
  const [compuestosRows, componentesRows, todosRows] = await Promise.all([
    allQuery(
      `SELECT id, nombre, rendimiento_receta, es_combo, costo_final, precio_compra
       FROM productos
       WHERE activo = 1 AND (tipo = 'compuesto' OR es_combo = 1)
       ORDER BY nombre ASC`
    ),
    allQuery(`SELECT producto_compuesto_id, producto_id, cantidad FROM producto_componentes`),
    allQuery(
      `SELECT id, nombre, stock, stock_minimo, maneja_stock, tipo, costo_final, precio_compra
       FROM productos WHERE activo = 1`
    )
  ]);

  const productMap = new Map(todosRows.map((p) => [p.id, p]));
  const compMap = new Map();
  componentesRows.forEach((c) => {
    if (!compMap.has(c.producto_compuesto_id)) compMap.set(c.producto_compuesto_id, []);
    compMap.get(c.producto_compuesto_id).push(c);
  });

  function flattenReceta(productoId, cantidadPorUnidad, visited) {
    if (visited.has(productoId)) return [];
    const newVisited = new Set([...visited, productoId]);
    const producto = productMap.get(productoId);
    const comps = compMap.get(productoId) || [];
    if (!comps.length) {
      if (producto && Number(producto.maneja_stock) === 1) {
        return [{
          id: productoId,
          nombre: producto.nombre,
          stock: round2(producto.stock),
          stock_minimo: round2(producto.stock_minimo),
          cantidadPorUnidad
        }];
      }
      return [];
    }
    const rendimiento = Math.max(1, Number(producto?.rendimiento_receta || 1));
    const result = [];
    for (const comp of comps) {
      const cantPorUnidad = cantidadPorUnidad * comp.cantidad / rendimiento;
      const sub = productMap.get(comp.producto_id);
      if (!sub) continue;
      if (Number(sub.maneja_stock) === 1) {
        result.push({
          id: comp.producto_id,
          nombre: sub.nombre,
          stock: round2(sub.stock),
          stock_minimo: round2(sub.stock_minimo),
          cantidadPorUnidad: cantPorUnidad
        });
      } else {
        result.push(...flattenReceta(comp.producto_id, cantPorUnidad, newVisited));
      }
    }
    return result;
  }

  const recetas = [];
  const insumosCriticosMap = new Map();

  for (const comp of compuestosRows) {
    const ingredientes = flattenReceta(comp.id, 1, new Set());
    if (!ingredientes.length) continue;

    let unidadesPosibles = Infinity;
    let limitante = null;
    for (const ing of ingredientes) {
      const posibles = ing.cantidadPorUnidad > 0
        ? Math.floor(ing.stock / ing.cantidadPorUnidad)
        : Infinity;
      if (posibles < unidadesPosibles) { unidadesPosibles = posibles; limitante = ing; }
    }
    if (!isFinite(unidadesPosibles)) unidadesPosibles = 0;

    const estado = unidadesPosibles <= 0 ? "bloqueada"
      : unidadesPosibles <= 10 ? "en_riesgo"
      : "saludable";

    recetas.push({
      producto_id: Number(comp.id),
      producto_nombre: comp.nombre,
      unidades_posibles: Number(unidadesPosibles),
      estado,
      insumo_limitante: limitante?.nombre || null,
      stock_limitante: limitante ? round2(limitante.stock) : null,
      cantidad_limitante: limitante ? round2(limitante.cantidadPorUnidad) : null,
      ingredientes_simples: ingredientes.length
    });

    if (limitante) {
      if (!insumosCriticosMap.has(limitante.id)) {
        insumosCriticosMap.set(limitante.id, {
          producto_id: Number(limitante.id),
          producto_nombre: limitante.nombre,
          stock_actual: limitante.stock,
          stock_minimo: limitante.stock_minimo,
          recetas_afectadas: [],
          severidad: limitante.stock <= 0 ? "sin_stock"
            : limitante.stock_minimo > 0 && limitante.stock <= limitante.stock_minimo
              ? "bajo_minimo" : "limitante"
        });
      }
      insumosCriticosMap.get(limitante.id).recetas_afectadas.push(comp.nombre);
    }
  }

  const saludables = recetas.filter((r) => r.estado === "saludable");
  const enRiesgo = recetas.filter((r) => r.estado === "en_riesgo");
  const bloqueadas = recetas.filter((r) => r.estado === "bloqueada");
  const insumosCriticos = [...insumosCriticosMap.values()]
    .sort((a, b) => a.stock_actual - b.stock_actual);

  return {
    resumen: {
      productos_analizados: recetas.length,
      recetas_saludables: saludables.length,
      recetas_en_riesgo: enRiesgo.length,
      recetas_bloqueadas: bloqueadas.length,
      insumos_criticos: insumosCriticos.length,
      valor_comprometido: round2(
        [...enRiesgo, ...bloqueadas].reduce((acc, r) => {
          const p = productMap.get(r.producto_id);
          const costo = Number(p?.costo_final || p?.precio_compra || 0);
          return acc + r.unidades_posibles * costo;
        }, 0)
      )
    },
    recetas: recetas.sort((a, b) => a.unidades_posibles - b.unidades_posibles),
    insumos_criticos: insumosCriticos
  };
}

async function getReporteDependenciaInsumos() {
  const [compuestosRows, componentesRows, todosRows] = await Promise.all([
    allQuery(
      `SELECT id, nombre, rendimiento_receta, es_combo
       FROM productos
       WHERE activo = 1 AND (tipo = 'compuesto' OR es_combo = 1)
       ORDER BY nombre ASC`
    ),
    allQuery(`SELECT producto_compuesto_id, producto_id, cantidad FROM producto_componentes`),
    allQuery(
      `SELECT id, nombre, stock, stock_minimo, maneja_stock, tipo
       FROM productos WHERE activo = 1`
    )
  ]);

  const productMap = new Map(todosRows.map((p) => [p.id, p]));
  const compMap = new Map();
  componentesRows.forEach((c) => {
    if (!compMap.has(c.producto_compuesto_id)) compMap.set(c.producto_compuesto_id, []);
    compMap.get(c.producto_compuesto_id).push(c);
  });

  function flattenReceta(productoId, cantidadPorUnidad, visited) {
    if (visited.has(productoId)) return [];
    const newVisited = new Set([...visited, productoId]);
    const producto = productMap.get(productoId);
    const comps = compMap.get(productoId) || [];
    if (!comps.length) {
      if (producto && Number(producto.maneja_stock) === 1) {
        return [{ id: productoId, nombre: producto.nombre, stock: round2(producto.stock), stock_minimo: round2(producto.stock_minimo), cantidadPorUnidad }];
      }
      return [];
    }
    const rendimiento = Math.max(1, Number(producto?.rendimiento_receta || 1));
    const result = [];
    for (const comp of comps) {
      const cantPorUnidad = cantidadPorUnidad * comp.cantidad / rendimiento;
      const sub = productMap.get(comp.producto_id);
      if (!sub) continue;
      if (Number(sub.maneja_stock) === 1) {
        result.push({ id: comp.producto_id, nombre: sub.nombre, stock: round2(sub.stock), stock_minimo: round2(sub.stock_minimo), cantidadPorUnidad: cantPorUnidad });
      } else {
        result.push(...flattenReceta(comp.producto_id, cantPorUnidad, newVisited));
      }
    }
    return result;
  }

  // Build dependency map: insumo_id → { info, recetas: Set<nombre>, veces_limitante }
  const depMap = new Map();

  for (const comp of compuestosRows) {
    const ingredientes = flattenReceta(comp.id, 1, new Set());
    if (!ingredientes.length) continue;

    // Find limitante for this recipe
    let minPosibles = Infinity;
    for (const ing of ingredientes) {
      const pos = ing.cantidadPorUnidad > 0 ? Math.floor(ing.stock / ing.cantidadPorUnidad) : Infinity;
      if (pos < minPosibles) minPosibles = pos;
    }
    const limitanteIds = new Set();
    if (isFinite(minPosibles)) {
      for (const ing of ingredientes) {
        const pos = ing.cantidadPorUnidad > 0 ? Math.floor(ing.stock / ing.cantidadPorUnidad) : Infinity;
        if (pos === minPosibles) limitanteIds.add(ing.id);
      }
    }

    for (const ing of ingredientes) {
      if (!depMap.has(ing.id)) {
        depMap.set(ing.id, {
          producto_id: Number(ing.id),
          producto_nombre: ing.nombre,
          stock_actual: ing.stock,
          stock_minimo: ing.stock_minimo,
          recetasSet: new Set(),
          veces_limitante: 0
        });
      }
      const entry = depMap.get(ing.id);
      entry.recetasSet.add(comp.nombre);
      if (limitanteIds.has(ing.id)) entry.veces_limitante++;
    }
  }

  const severidadOrden = { sin_stock: 0, bajo_minimo: 1, limitante: 2, ok: 3 };

  const insumos = [...depMap.values()]
    .map((entry) => {
      const sinStock = entry.stock_actual <= 0;
      const bajMin = entry.stock_minimo > 0 && entry.stock_actual <= entry.stock_minimo;
      const esLimitante = entry.veces_limitante > 0;
      const severidad = sinStock ? "sin_stock" : bajMin ? "bajo_minimo" : esLimitante ? "limitante" : "ok";
      return {
        producto_id: entry.producto_id,
        producto_nombre: entry.producto_nombre,
        stock_actual: entry.stock_actual,
        stock_minimo: entry.stock_minimo,
        recetas_dependientes: entry.recetasSet.size,
        recetas_afectadas: [...entry.recetasSet].sort(),
        veces_limitante: entry.veces_limitante,
        es_limitante: esLimitante,
        bajo_minimo: bajMin,
        sin_stock: sinStock,
        severidad
      };
    })
    .sort((a, b) => {
      const sd = severidadOrden[a.severidad] - severidadOrden[b.severidad];
      if (sd !== 0) return sd;
      const rd = b.recetas_dependientes - a.recetas_dependientes;
      if (rd !== 0) return rd;
      const vd = b.veces_limitante - a.veces_limitante;
      if (vd !== 0) return vd;
      return a.producto_nombre.localeCompare(b.producto_nombre);
    });

  return {
    resumen: {
      insumos_analizados: insumos.length,
      insumos_con_dependencias: insumos.filter((i) => i.recetas_dependientes > 0).length,
      insumos_limitantes: insumos.filter((i) => i.es_limitante).length,
      insumos_bajo_minimo: insumos.filter((i) => i.bajo_minimo).length,
      insumos_sin_stock: insumos.filter((i) => i.sin_stock).length
    },
    insumos
  };
}

async function getReporteRiesgoVentas({ desde = null, hasta = null } = {}) {
  const fechaHoy = new Date().toISOString().slice(0, 10);
  const fecha30 = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const desdeEfectivo = (desde && String(desde).slice(0, 10)) || fecha30;
  const hastaEfectivo = (hasta && String(hasta).slice(0, 10)) || fechaHoy;

  const d1 = new Date(desdeEfectivo);
  const d2 = new Date(hastaEfectivo);
  const diasPeriodo = Math.max(1, Math.round((d2 - d1) / (1000 * 60 * 60 * 24)) + 1);

  const [consumoRows, recetasRows] = await Promise.all([
    allQuery(
      `SELECT
         pc.producto_id AS producto_id,
         pi.nombre AS producto_nombre,
         pi.stock AS stock_actual,
         pi.stock_minimo AS stock_minimo,
         COALESCE(pi.unidad_medida, '') AS unidad_medida,
         COALESCE(SUM(dv.cantidad * pc.cantidad), 0) AS consumo_total_periodo,
         COUNT(DISTINCT v.id) AS ventas_periodo,
         COUNT(DISTINCT dv.producto_id) AS productos_vendidos_relacionados
       FROM detalle_ventas dv
       JOIN ventas v ON v.id = dv.venta_id
       JOIN productos pv ON pv.id = dv.producto_id
       JOIN producto_componentes pc ON pc.producto_compuesto_id = pv.id
       JOIN productos pi ON pi.id = pc.producto_id
       WHERE COALESCE(v.estado, '') != 'anulado'
         AND COALESCE(v.tipo, '') != 'test_modificadores'
         AND LOWER(COALESCE(pv.tipo, 'simple')) = 'compuesto'
         AND COALESCE(pv.maneja_stock, 0) = 0
         AND COALESCE(pi.maneja_stock, 0) = 1
         AND v.fecha >= ?
         AND v.fecha <= ?
       GROUP BY pc.producto_id, pi.nombre, pi.stock, pi.stock_minimo, pi.unidad_medida
       ORDER BY consumo_total_periodo DESC`,
      [desdeEfectivo, hastaEfectivo]
    ),
    allQuery(
      `SELECT
         pi.id AS producto_id,
         pi.nombre AS producto_nombre,
         pi.stock AS stock_actual,
         pi.stock_minimo AS stock_minimo,
         COALESCE(pi.unidad_medida, '') AS unidad_medida,
         GROUP_CONCAT(DISTINCT pv.nombre ORDER BY pv.nombre) AS recetas_raw
       FROM producto_componentes pc
       JOIN productos pi ON pi.id = pc.producto_id
         AND COALESCE(pi.maneja_stock, 0) = 1
         AND COALESCE(pi.activo, 0) = 1
       JOIN productos pv ON pv.id = pc.producto_compuesto_id
         AND (LOWER(COALESCE(pv.tipo, 'simple')) = 'compuesto' OR pv.es_combo = 1)
         AND COALESCE(pv.activo, 0) = 1
       GROUP BY pi.id, pi.nombre, pi.stock, pi.stock_minimo, pi.unidad_medida`
    )
  ]);

  const consumoMap = new Map();
  for (const row of consumoRows) {
    consumoMap.set(Number(row.producto_id), {
      consumo_total_periodo: round2(row.consumo_total_periodo),
      ventas_periodo: Number(row.ventas_periodo || 0),
      productos_vendidos_relacionados: Number(row.productos_vendidos_relacionados || 0)
    });
  }

  const sevOrd = { critico: 0, riesgo: 1, estable: 2, sin_consumo: 3 };

  const insumos = recetasRows.map((row) => {
    const id = Number(row.producto_id);
    const stockActual = round2(row.stock_actual);
    const consumo = consumoMap.get(id);
    const consumoTotal = consumo ? consumo.consumo_total_periodo : 0;
    const consumoPromDiario = round2(consumoTotal / diasPeriodo);
    const diasCobertura = consumoPromDiario > 0
      ? round2(stockActual / consumoPromDiario)
      : null;
    const severidad = diasCobertura === null ? "sin_consumo"
      : diasCobertura <= 3 ? "critico"
      : diasCobertura <= 7 ? "riesgo"
      : "estable";
    return {
      producto_id: id,
      producto_nombre: row.producto_nombre,
      unidad_medida: row.unidad_medida,
      stock_actual: stockActual,
      stock_minimo: round2(row.stock_minimo),
      consumo_total_periodo: consumoTotal,
      consumo_promedio_diario: consumoPromDiario,
      dias_cobertura: diasCobertura,
      ventas_periodo: consumo ? consumo.ventas_periodo : 0,
      productos_vendidos_relacionados: consumo ? consumo.productos_vendidos_relacionados : 0,
      recetas_afectadas: row.recetas_raw ? row.recetas_raw.split(",") : [],
      severidad
    };
  }).sort((a, b) => {
    const sd = sevOrd[a.severidad] - sevOrd[b.severidad];
    if (sd !== 0) return sd;
    if (a.dias_cobertura !== null && b.dias_cobertura !== null) {
      const dd = a.dias_cobertura - b.dias_cobertura;
      if (dd !== 0) return dd;
    }
    return b.consumo_total_periodo - a.consumo_total_periodo;
  });

  const coberturas = insumos.filter((i) => i.dias_cobertura !== null).map((i) => i.dias_cobertura);
  return {
    filtros: { desde: desdeEfectivo, hasta: hastaEfectivo, dias_periodo: diasPeriodo },
    resumen: {
      insumos_analizados: insumos.length,
      insumos_criticos: insumos.filter((i) => i.severidad === "critico").length,
      insumos_en_riesgo: insumos.filter((i) => i.severidad === "riesgo").length,
      insumos_estables: insumos.filter((i) => i.severidad === "estable").length,
      insumos_sin_consumo: insumos.filter((i) => i.severidad === "sin_consumo").length,
      cobertura_promedio: coberturas.length
        ? round2(coberturas.reduce((a, b) => a + b, 0) / coberturas.length)
        : null
    },
    insumos
  };
}

async function getReporteRentabilidadProductos({ desde = null, hasta = null } = {}) {
  const fechaWhere = [];
  const fechaParams = [];
  if (desde) { fechaWhere.push("v.fecha >= ?"); fechaParams.push(desde); }
  if (hasta) { fechaWhere.push("v.fecha <= ?"); fechaParams.push(hasta); }
  const fechaJoin = fechaWhere.length ? "AND " + fechaWhere.join(" AND ") : "";

  const rows = await allQuery(
    `SELECT
       dv.producto_id,
       dv.nombre_producto,
       COALESCE(cat.nombre, p.categoria, 'Sin categoría') AS categoria,
       p.tipo,
       COALESCE(SUM(dv.cantidad), 0) AS unidades_vendidas,
       COALESCE(SUM(dv.subtotal), 0) AS facturacion_total,
       COALESCE(SUM(dv.cantidad * COALESCE(NULLIF(p.costo_final, 0), NULLIF(p.precio_compra, 0), 0)), 0) AS costo_estimado_total
     FROM detalle_ventas dv
     JOIN ventas v ON v.id = dv.venta_id
     JOIN productos p ON p.id = dv.producto_id
     LEFT JOIN categorias cat ON cat.id = p.categoria_id
     WHERE COALESCE(v.estado, '') != 'anulado'
       AND COALESCE(v.tipo, '') != 'test_modificadores'
       ${fechaJoin}
     GROUP BY dv.producto_id, dv.nombre_producto, cat.nombre, p.categoria, p.tipo
     ORDER BY facturacion_total DESC`,
    fechaParams
  );

  const productos = rows.map((row) => {
    const facturacion = round2(row.facturacion_total);
    const costo = round2(row.costo_estimado_total);
    const margen = round2(facturacion - costo);
    const margenPct = facturacion > 0 ? round2((margen / facturacion) * 100) : 0;
    return {
      producto_id: row.producto_id == null ? null : Number(row.producto_id),
      producto_nombre: row.nombre_producto,
      categoria: row.categoria,
      tipo: row.tipo || "simple",
      unidades_vendidas: round2(row.unidades_vendidas),
      facturacion_total: facturacion,
      costo_estimado_total: costo,
      margen_bruto: margen,
      margen_porcentual: margenPct,
      ticket_promedio: round2(row.unidades_vendidas > 0 ? facturacion / row.unidades_vendidas : 0)
    };
  }).sort((a, b) => b.margen_bruto - a.margen_bruto);

  const facturacionTotal = round2(productos.reduce((acc, p) => acc + p.facturacion_total, 0));
  const costoTotal = round2(productos.reduce((acc, p) => acc + p.costo_estimado_total, 0));
  const margenTotal = round2(facturacionTotal - costoTotal);
  const margenPromedio = facturacionTotal > 0 ? round2((margenTotal / facturacionTotal) * 100) : 0;
  const porRentabilidad = [...productos].sort((a, b) => b.margen_bruto - a.margen_bruto);
  const porMargenPct = [...productos].filter((p) => p.facturacion_total > 0).sort((a, b) => b.margen_porcentual - a.margen_porcentual);

  return {
    filtros: { desde, hasta },
    resumen: {
      facturacion_total: facturacionTotal,
      costo_total: costoTotal,
      margen_total: margenTotal,
      margen_promedio: margenPromedio,
      producto_mayor_rentabilidad: porRentabilidad[0]?.producto_nombre || null,
      producto_menor_rentabilidad: porMargenPct[porMargenPct.length - 1]?.producto_nombre || null
    },
    productos
  };
}

async function getReporteRentabilidadCategorias({ desde = null, hasta = null } = {}) {
  const fechaWhere = [];
  const fechaParams = [];
  if (desde) { fechaWhere.push("v.fecha >= ?"); fechaParams.push(desde); }
  if (hasta) { fechaWhere.push("v.fecha <= ?"); fechaParams.push(hasta); }
  const fechaJoin = fechaWhere.length ? "AND " + fechaWhere.join(" AND ") : "";

  const rows = await allQuery(
    `SELECT
       COALESCE(cat.nombre, p.categoria, 'Sin categoría') AS categoria,
       COUNT(DISTINCT dv.producto_id) AS productos_vendidos,
       COALESCE(SUM(dv.cantidad), 0) AS unidades_vendidas,
       COALESCE(SUM(dv.subtotal), 0) AS facturacion_total,
       COALESCE(SUM(dv.cantidad * COALESCE(NULLIF(p.costo_final, 0), NULLIF(p.precio_compra, 0), 0)), 0) AS costo_estimado_total
     FROM detalle_ventas dv
     JOIN ventas v ON v.id = dv.venta_id
     JOIN productos p ON p.id = dv.producto_id
     LEFT JOIN categorias cat ON cat.id = p.categoria_id
     WHERE COALESCE(v.estado, '') != 'anulado'
       AND COALESCE(v.tipo, '') != 'test_modificadores'
       ${fechaJoin}
     GROUP BY categoria
     ORDER BY facturacion_total DESC`,
    fechaParams
  );

  const categorias = rows.map((row) => {
    const facturacion = round2(row.facturacion_total);
    const costo = round2(row.costo_estimado_total);
    const margen = round2(facturacion - costo);
    const margenPct = facturacion > 0 ? round2((margen / facturacion) * 100) : 0;
    const unidades = round2(row.unidades_vendidas);
    return {
      categoria: row.categoria,
      productos_vendidos: Number(row.productos_vendidos || 0),
      unidades_vendidas: unidades,
      facturacion_total: facturacion,
      costo_estimado_total: costo,
      margen_bruto: margen,
      margen_porcentual: margenPct,
      ticket_promedio: round2(unidades > 0 ? facturacion / unidades : 0)
    };
  }).sort((a, b) => b.margen_bruto - a.margen_bruto);

  const facturacionTotal = round2(categorias.reduce((acc, c) => acc + c.facturacion_total, 0));
  const costoTotal = round2(categorias.reduce((acc, c) => acc + c.costo_estimado_total, 0));
  const margenTotal = round2(facturacionTotal - costoTotal);
  const margenPromedio = facturacionTotal > 0 ? round2((margenTotal / facturacionTotal) * 100) : 0;
  const porMargenPct = [...categorias].filter((c) => c.facturacion_total > 0).sort((a, b) => b.margen_porcentual - a.margen_porcentual);

  return {
    filtros: { desde, hasta },
    resumen: {
      categorias_analizadas: categorias.length,
      facturacion_total: facturacionTotal,
      costo_total: costoTotal,
      margen_total: margenTotal,
      margen_promedio: margenPromedio,
      categoria_mayor_rentabilidad: categorias[0]?.categoria || null,
      categoria_menor_rentabilidad: porMargenPct[porMargenPct.length - 1]?.categoria || null
    },
    categorias
  };
}

async function getReporteDashboardEjecutivo({ desde = null, hasta = null } = {}) {
  const safe = async (fn) => { try { return await fn(); } catch { return null; } };

  const [resumenVentas, rentabilidadProd, rentabilidadCat, cuentasCorrientes, saludInv, riesgoVentas] = await Promise.all([
    safe(() => getResumenReportes({ desde, hasta })),
    safe(() => getReporteRentabilidadProductos({ desde, hasta })),
    safe(() => getReporteRentabilidadCategorias({ desde, hasta })),
    safe(() => getReporteCuentasCorrientes({ desde, hasta })),
    safe(() => getReporteSaludInventario()),
    safe(() => getReporteRiesgoVentas({ desde, hasta }))
  ]);

  const ventasRes = resumenVentas || {};
  const rentProdRes = rentabilidadProd?.resumen || {};
  const rentCatRes = rentabilidadCat?.resumen || {};
  const ccRes = cuentasCorrientes?.resumen || {};
  const salud = saludInv?.resumen || {};
  const riesgo = riesgoVentas?.resumen || {};

  const alertas = [];
  if (round2(ccRes.deuda_vencida) > 0) alertas.push({ tipo: "riesgo", titulo: "Deuda vencida", detalle: `Hay ${new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(ccRes.deuda_vencida)} de deuda vencida.` });
  if (Number(ccRes.clientes_excedidos) > 0) alertas.push({ tipo: "riesgo", titulo: "Clientes excedidos", detalle: `Hay ${ccRes.clientes_excedidos} cliente(s) excedido(s).` });
  if (Number(salud.recetas_bloqueadas) > 0) alertas.push({ tipo: "critica", titulo: "Recetas bloqueadas", detalle: `Hay ${salud.recetas_bloqueadas} receta(s) bloqueada(s) por stock.` });
  if (Number(salud.recetas_en_riesgo) > 0) alertas.push({ tipo: "riesgo", titulo: "Recetas en riesgo", detalle: `Hay ${salud.recetas_en_riesgo} receta(s) con baja disponibilidad.` });
  if (Number(salud.insumos_criticos) > 0) alertas.push({ tipo: "riesgo", titulo: "Insumos críticos", detalle: `Hay ${salud.insumos_criticos} insumo(s) crítico(s).` });
  const catBajoMargen = (rentabilidadCat?.categorias || []).find((c) => c.facturacion_total > 0 && c.margen_porcentual < 30);
  if (catBajoMargen) alertas.push({ tipo: "info", titulo: "Categoría con bajo margen", detalle: `${catBajoMargen.categoria} tiene margen de ${round2(catBajoMargen.margen_porcentual)}%.` });
  if (!alertas.length) alertas.push({ tipo: "info", titulo: "Sin alertas críticas", detalle: "No se detectaron alertas relevantes en el período." });

  return {
    filtros: { desde, hasta },
    ventas: {
      facturacion_total: round2(ventasRes.ventas_totales),
      ingresos_reales: round2(ventasRes.ingresos_reales || 0),
      operaciones: Number(ventasRes.total_ventas || 0),
      ticket_promedio: round2(ventasRes.ticket_promedio)
    },
    rentabilidad: {
      costo_total: round2(rentProdRes.costo_total),
      margen_total: round2(rentProdRes.margen_total),
      margen_promedio: round2(rentProdRes.margen_promedio),
      producto_mayor_rentabilidad: rentProdRes.producto_mayor_rentabilidad || null,
      categoria_mayor_rentabilidad: rentCatRes.categoria_mayor_rentabilidad || null
    },
    cuentas_corrientes: {
      deuda_total: round2(ccRes.deuda_total),
      deuda_vencida: round2(ccRes.deuda_vencida),
      clientes_con_deuda: Number(ccRes.clientes_con_deuda || 0),
      clientes_con_deuda_vencida: Number(ccRes.clientes_con_deuda_vencida || 0),
      clientes_excedidos: Number(ccRes.clientes_excedidos || 0)
    },
    inventario: {
      recetas_saludables: Number(salud.recetas_saludables || 0),
      recetas_en_riesgo: Number(salud.recetas_en_riesgo || 0),
      recetas_bloqueadas: Number(salud.recetas_bloqueadas || 0),
      insumos_criticos: Number(salud.insumos_criticos || 0),
      cobertura_promedio: riesgo.cobertura_promedio != null ? round2(riesgo.cobertura_promedio) : null
    },
    alertas,
    top: {
      productos_margen: (rentabilidadProd?.productos || []).sort((a, b) => b.margen_bruto - a.margen_bruto).slice(0, 5),
      categorias_margen: (rentabilidadCat?.categorias || []).sort((a, b) => b.margen_bruto - a.margen_bruto).slice(0, 5),
      clientes_deuda: (cuentasCorrientes?.clientes || []).filter((c) => c.deuda_actual > 0).sort((a, b) => b.deuda_actual - a.deuda_actual).slice(0, 5),
      insumos_riesgo: (riesgoVentas?.insumos || []).filter((i) => i.severidad !== "estable").slice(0, 5)
    }
  };
}

module.exports = {
  getResumenReportes,
  getReporteVentas,
  getReporteCaja,
  getReporteStock,
  getReporteCuentasCorrientes,
  getProductosMasVendidos,
  getResumenProveedoresPagos,
  getVentasPorDia,
  getResumenCuentasCobro,
  getReporteModificadores,
  getReporteDesviosReceta,
  getReporteSaludInventario,
  getReporteDependenciaInsumos,
  getReporteRiesgoVentas,
  getReporteRentabilidadProductos,
  getReporteRentabilidadCategorias,
  getReporteDashboardEjecutivo
};
