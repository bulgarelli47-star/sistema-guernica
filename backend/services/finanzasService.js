const { allQuery } = require("../db");
const {
  getReporteStock,
  getReporteCuentasCorrientes,
  getResumenProveedoresPagos
} = require("./reportesService");
const {
  getCajaAbiertaActual,
  getUltimaCajaRegistrada,
  getConciliacionesCuentaDestino
} = require("./cajaService");
const { getConfiguracionGlobal } = require("./configService");

function round2(value) {
  return Number(Number(value || 0).toFixed(2));
}

function sumar(items, key) {
  return round2((items || []).reduce((acc, item) => acc + Number(item?.[key] || 0), 0));
}

function alerta(codigo, mensaje) {
  return { codigo, mensaje };
}

async function obtenerLiquidez(alertas) {
  const liquidez = {
    efectivo_contado: 0,
    caja_cambio: 0,
    caja_grande_resguardado: 0,
    cuentas_digitales_conciliadas: 0,
    bancos_billeteras: [],
    total: 0
  };

  const caja = await getCajaAbiertaActual() || await getUltimaCajaRegistrada();
  if (!caja) {
    alertas.push(alerta("sin_caja", "No hay caja registrada para tomar una lectura de liquidez."));
    return liquidez;
  }

  liquidez.efectivo_contado = round2(caja.efectivo_contado);
  liquidez.caja_cambio = round2(caja.monto_caja_apertura);
  liquidez.caja_grande_resguardado = round2(caja.monto_caja_fondo);

  if (liquidez.efectivo_contado <= 0 && caja.estado === "abierta") {
    alertas.push(alerta(
      "efectivo_sin_cierre",
      "La caja actual esta abierta o no tiene efectivo contado; la liquidez en efectivo puede quedar en 0 hasta registrar arqueo/cierre."
    ));
  }

  const conciliaciones = await getConciliacionesCuentaDestino({ cajaId: caja.id });
  if (!conciliaciones.length) {
    alertas.push(alerta(
      "sin_conciliaciones_destino",
      "No hay conciliaciones por cuenta destino para confirmar bancos o billeteras."
    ));
  }

  for (const item of conciliaciones) {
    const estado = String(item.estado || "").toLowerCase();
    const tipo = String(item.tipo_destino || "otro").toLowerCase();
    if (estado !== "conciliado") continue;

    const monto = round2(item.monto_real);
    if (monto <= 0 || tipo === "efectivo") continue;

    const cuenta = {
      cuenta_destino_id: item.cuenta_destino_id == null ? null : Number(item.cuenta_destino_id),
      nombre: item.cuenta_destino_nombre || "Cuenta destino",
      tipo_destino: tipo,
      monto
    };

    if (["banco", "billetera"].includes(tipo)) {
      liquidez.bancos_billeteras.push(cuenta);
    } else {
      liquidez.cuentas_digitales_conciliadas = round2(liquidez.cuentas_digitales_conciliadas + monto);
    }
  }

  liquidez.total = round2(
    liquidez.efectivo_contado +
    liquidez.cuentas_digitales_conciliadas +
    sumar(liquidez.bancos_billeteras, "monto")
  );

  return liquidez;
}

async function obtenerPendientesCobro({ desde, hasta }, alertas) {
  const pendientes = {
    cuentas_corrientes_clientes: 0,
    ventas_pendientes: 0,
    acreditaciones_pendientes_estimadas: 0,
    total: 0
  };

  const cuentas = await getReporteCuentasCorrientes({ desde, hasta });
  pendientes.cuentas_corrientes_clientes = round2(cuentas?.resumen?.deuda_total);
  pendientes.clientes_con_deuda = Number(cuentas?.resumen?.clientes_con_deuda || 0);
  pendientes.clientes_excedidos = Number(cuentas?.resumen?.clientes_excedidos || 0);
  pendientes.cobrado_periodo = round2(cuentas?.resumen?.cobrado_periodo);

  const ventasWhere = ["COALESCE(tipo, '') = 'pendiente'", "COALESCE(estado, '') = 'pendiente'"];
  const ventasParams = [];
  if (desde) { ventasWhere.push("fecha >= ?"); ventasParams.push(desde); }
  if (hasta) { ventasWhere.push("fecha <= ?"); ventasParams.push(hasta); }
  const ventasRows = await allQuery(
    `SELECT COALESCE(SUM(total), 0) AS total FROM ventas WHERE ${ventasWhere.join(" AND ")}`,
    ventasParams
  );
  pendientes.ventas_pendientes = round2(ventasRows[0]?.total);

  alertas.push(alerta(
    "acreditaciones_pendientes_no_modeladas",
    "Las acreditaciones pendientes por Posnet/billetera todavia no tienen modelo propio; se informan en 0."
  ));

  pendientes.total = round2(
    pendientes.cuentas_corrientes_clientes +
    pendientes.ventas_pendientes +
    pendientes.acreditaciones_pendientes_estimadas
  );

  return pendientes;
}

async function obtenerIngresosPeriodo({ desde, hasta }) {
  const where = ["COALESCE(estado, '') != 'anulado'"];
  const params = [];
  if (desde) { where.push("fecha >= ?"); params.push(desde); }
  if (hasta) { where.push("fecha <= ?"); params.push(hasta); }

  // F4-A: filtros de fecha para la query de ventas_cobradas (se aplican a ambas ramas del UNION ALL)
  const vcFechaWhere = [];
  const vcFechaParams = [];
  if (desde) { vcFechaWhere.push("v.fecha >= ?"); vcFechaParams.push(desde); }
  if (hasta) { vcFechaWhere.push("v.fecha <= ?"); vcFechaParams.push(hasta); }
  const vcFechaSQL = vcFechaWhere.length ? `AND ${vcFechaWhere.join(" AND ")}` : "";

  // pagos_cc_cobros: cobros CC V2 (con group_id) filtrados por fecha de cobro real
  const cobrosV2Where = [];
  const cobrosV2Params = [];
  if (desde) { cobrosV2Where.push("pcc.fecha >= ?"); cobrosV2Params.push(desde); }
  if (hasta) { cobrosV2Where.push("pcc.fecha <= ?"); cobrosV2Params.push(hasta); }
  const cobrosV2WhereSQL = cobrosV2Where.length ? `WHERE ${cobrosV2Where.join(" AND ")}` : "";

  // pagos_cuenta_corriente: fallback histórico para cobros CC sin group_id (pre-CC 3.0A)
  const cobrosLegacyWhere = ["pcc.group_id IS NULL"];
  const cobrosLegacyParams = [];
  if (desde) { cobrosLegacyWhere.push("pcc.fecha >= ?"); cobrosLegacyParams.push(desde); }
  if (hasta) { cobrosLegacyWhere.push("pcc.fecha <= ?"); cobrosLegacyParams.push(hasta); }

  const [rows, ventasCobradaRows, cobrosRows] = await Promise.all([
    allQuery(
      `SELECT
         COALESCE(SUM(CASE WHEN estado = 'pendiente' AND COALESCE(es_cuenta_corriente, 0) = 0 THEN total ELSE 0 END), 0) AS ventas_pendientes,
         COALESCE(SUM(CASE WHEN COALESCE(es_cuenta_corriente, 0) = 1 THEN total ELSE 0 END), 0) AS ventas_cuenta_corriente,
         COALESCE(SUM(total), 0) AS total_periodo,
         COALESCE(SUM(CASE WHEN estado = 'cobrada' AND COALESCE(es_cuenta_corriente, 0) = 0 THEN recargo_monto ELSE 0 END), 0) AS recargos_periodo
       FROM ventas
       WHERE ${where.join(" AND ")}`,
      params
    ),
    // F4-A: ventas_cobradas desde venta_cobros.monto (Cobros V2) con fallback legacy
    allQuery(
      `SELECT COALESCE(SUM(monto_cobrado), 0) AS ventas_cobradas
       FROM (
         SELECT vc.monto AS monto_cobrado
           FROM venta_cobros vc
           JOIN ventas v ON v.id = vc.venta_id
           WHERE vc.estado = 'confirmado'
             AND v.estado = 'cobrada'
             AND COALESCE(v.es_cuenta_corriente, 0) = 0
             AND COALESCE(v.estado, '') != 'anulado'
             ${vcFechaSQL}
         UNION ALL
         SELECT v.total AS monto_cobrado
           FROM ventas v
           WHERE NOT EXISTS (SELECT 1 FROM venta_cobros vc WHERE vc.venta_id = v.id)
             AND v.estado = 'cobrada'
             AND COALESCE(v.es_cuenta_corriente, 0) = 0
             AND COALESCE(v.estado, '') != 'anulado'
             ${vcFechaSQL}
       )`,
      [...vcFechaParams, ...vcFechaParams]
    ),
    allQuery(
      `SELECT COALESCE(SUM(total_cobro), 0) AS cobros_cc
       FROM (
         SELECT pcc.monto AS total_cobro
           FROM pagos_cc_cobros pcc
           ${cobrosV2WhereSQL}
         UNION ALL
         SELECT pcc.monto_pagado AS total_cobro
           FROM pagos_cuenta_corriente pcc
           WHERE ${cobrosLegacyWhere.join(" AND ")}
       )`,
      [...cobrosV2Params, ...cobrosLegacyParams]
    )
  ]);

  const row = rows[0] || {};
  const vcRow = ventasCobradaRows[0] || {};
  const cobrosRow = cobrosRows[0] || {};
  // total_periodo es SUM directo sin CASE: valor comercial del período (no dinero cobrado)
  return {
    ventas_cobradas: round2(vcRow.ventas_cobradas),
    ventas_pendientes: round2(row.ventas_pendientes),
    ventas_cuenta_corriente: round2(row.ventas_cuenta_corriente),
    cobros_cuenta_corriente: round2(cobrosRow.cobros_cc),
    total_periodo: round2(row.total_periodo),
    recargos_periodo: round2(row.recargos_periodo)
  };
}

async function obtenerCapitalInmovilizado({ desde, hasta }) {
  const stock = await getReporteStock({ desde, hasta });
  const stockFisico = round2(stock?.resumen?.stock_valorizado_fisico);
  const estimado = round2(stock?.resumen?.valor_rendimiento_estimado);
  return {
    stock_fisico_valorizado: stockFisico,
    estimado_receta_rendimiento: estimado,
    total_operativo: round2(stockFisico + estimado)
  };
}

async function obtenerPasivos({ desde, hasta }, alertas) {
  const proveedores = await getResumenProveedoresPagos({ desde, hasta });
  // Sin doble conteo: pagos_pendientes filtra proveedor_id IS NULL (pagos sin proveedor asignado).
  // proveedores_pendientes viene del JOIN desde proveedores — solo captura pagos con proveedor_id asignado.
  // Los dos conjuntos son disjuntos por construccion.
  const pagosWhere = ["COALESCE(estado, '') = 'pendiente'", "proveedor_id IS NULL"];
  const pagosParams = [];
  if (desde) { pagosWhere.push("fecha >= ?"); pagosParams.push(desde); }
  if (hasta) { pagosWhere.push("fecha <= ?"); pagosParams.push(hasta); }
  const pagosRows = await allQuery(
    `SELECT COALESCE(SUM(monto_total), 0) AS total FROM pagos WHERE ${pagosWhere.join(" AND ")}`,
    pagosParams
  );

  // Pagos ejecutados sin proveedor (alquileres, sueldos, gastos varios sin proveedor asignado)
  const ejecutadosWhere = ["COALESCE(estado, '') != 'pendiente'", "proveedor_id IS NULL"];
  const ejecutadosParams = [];
  if (desde) { ejecutadosWhere.push("fecha >= ?"); ejecutadosParams.push(desde); }
  if (hasta) { ejecutadosWhere.push("fecha <= ?"); ejecutadosParams.push(hasta); }
  const ejecutadosRows = await allQuery(
    `SELECT COALESCE(SUM(monto_total), 0) AS total FROM pagos WHERE ${ejecutadosWhere.join(" AND ")}`,
    ejecutadosParams
  );
  const pagosEjecutadosSinProveedor = round2(ejecutadosRows[0]?.total);

  const pasivos = {
    pagos_pendientes: round2(pagosRows[0]?.total),
    proveedores_pendientes: round2(proveedores?.resumen?.total_pendiente),
    // egresos_ejecutados: pagos con proveedor + pagos ejecutados sin proveedor en el período.
    pagos_ejecutados_sin_proveedor: pagosEjecutadosSinProveedor,
    egresos_ejecutados: round2(round2(proveedores?.resumen?.total_pagado) + pagosEjecutadosSinProveedor),
    iva_credito_fiscal: round2(proveedores?.resumen?.iva_credito_fiscal),
    por_tipo_impacto: (proveedores?.por_impacto || []).map((item) => ({
      tipo_impacto: String(item.tipo_impacto || "otro_no_computable"),
      total_pagado: round2(item.total_pagado),
      total_pendiente: round2(item.total_pendiente),
      iva_credito_fiscal: round2(item.iva_credito_fiscal)
    })),
    impuestos_estimados: 0,
    total: 0
  };

  alertas.push(alerta(
    "impuestos_estimados_no_modelados",
    "Los impuestos estimados todavia no tienen liquidacion fiscal consolidada; se informan en 0."
  ));

  pasivos.total = round2(
    pasivos.pagos_pendientes +
    pasivos.proveedores_pendientes +
    pasivos.impuestos_estimados
  );

  return pasivos;
}

async function obtenerMovimientosNoMonetarios({ desde, hasta } = {}) {
  const base = {
    cuenta_local: {
      produccion: {
        movimientos: 0,
        unidades: 0,
        costo_estimado: 0
      },
      interno_cortesia: {
        movimientos: 0,
        unidades: 0,
        costo_estimado: 0
      },
      total_absorbido: 0,
      movimientos_recientes: []
    }
  };

  const where = [
    "sap.tipo_resolucion = 'cuenta_local'",
    "sap.estado IN ('aprobado', 'corregido')"
  ];
  const params = [];
  if (desde) {
    where.push("sap.fecha_resolucion >= ?");
    params.push(desde);
  }
  if (hasta) {
    where.push("sap.fecha_resolucion <= ?");
    params.push(hasta);
  }

  const whereSql = where.join(" AND ");
  const [resumenRows, recientesRows] = await Promise.all([
    allQuery(
      `SELECT
         COALESCE(sap.cuenta_local_integracion, 'interno_cortesia') AS integracion,
         COUNT(*) AS movimientos,
         COALESCE(SUM(COALESCE(sap.cantidad_aprobada, sap.cantidad, 0)), 0) AS unidades,
         COALESCE(SUM(COALESCE(sap.cuenta_local_costo_estimado, 0)), 0) AS costo_estimado
       FROM stock_ajustes_pendientes sap
       WHERE ${whereSql}
       GROUP BY COALESCE(sap.cuenta_local_integracion, 'interno_cortesia')`,
      params
    ),
    allQuery(
      `SELECT
         sap.fecha_resolucion AS fecha,
         sap.hora_resolucion AS hora,
         COALESCE(p.nombre, sap.producto_id) AS producto_nombre,
         COALESCE(sap.cantidad_aprobada, sap.cantidad, 0) AS cantidad,
         COALESCE(sap.cuenta_local_integracion, 'interno_cortesia') AS integracion,
         sap.cuenta_local_responsable AS responsable,
         sap.cuenta_local_observacion AS observacion,
         COALESCE(sap.cuenta_local_costo_estimado, 0) AS costo_estimado,
         sap.resuelto_por
       FROM stock_ajustes_pendientes sap
       LEFT JOIN productos p ON p.id = sap.producto_id
       WHERE ${whereSql}
       ORDER BY sap.fecha_resolucion DESC, sap.hora_resolucion DESC, sap.id DESC
       LIMIT 10`,
      params
    )
  ]);

  resumenRows.forEach((row) => {
    const key = row.integracion === "produccion" ? "produccion" : "interno_cortesia";
    base.cuenta_local[key] = {
      movimientos: Number(row.movimientos || 0),
      unidades: round2(row.unidades),
      costo_estimado: round2(row.costo_estimado)
    };
  });

  base.cuenta_local.total_absorbido = round2(
    base.cuenta_local.produccion.costo_estimado +
    base.cuenta_local.interno_cortesia.costo_estimado
  );

  base.cuenta_local.movimientos_recientes = recientesRows.map((row) => ({
    fecha: row.fecha || null,
    hora: row.hora || null,
    producto_nombre: row.producto_nombre || "",
    cantidad: round2(row.cantidad),
    integracion: row.integracion === "produccion" ? "produccion" : "interno_cortesia",
    responsable: row.responsable || "",
    observacion: row.observacion || "",
    costo_estimado: round2(row.costo_estimado),
    resuelto_por: row.resuelto_por || ""
  }));

  return base;
}

async function obtenerCostosOperativosFijos({ desde, hasta }) {
  const config = await getConfiguracionGlobal();
  const alquiler_mensual = round2(config.finanzas_costo_alquiler_mensual);
  const servicios_mensual = round2(config.finanzas_costo_servicios_mensual);
  const sueldos_mensual = round2(config.finanzas_costo_sueldos_mensual);
  const impuestos_mensual = round2(config.finanzas_costo_impuestos_mensual);
  const expensas_mensual = round2(config.finanzas_costo_expensas_mensual);
  const otros_mensual = round2(config.finanzas_costo_otros_mensual);
  const total_mensual = round2(alquiler_mensual + servicios_mensual + sueldos_mensual + impuestos_mensual + expensas_mensual + otros_mensual);
  const promedio_diario = round2(total_mensual / 30);

  let dias_periodo = 30;
  if (desde && hasta) {
    const d = new Date(desde);
    const h = new Date(hasta);
    const diff = Math.round((h - d) / (1000 * 60 * 60 * 24)) + 1;
    if (diff > 0) dias_periodo = diff;
  }

  return {
    alquiler_mensual,
    servicios_mensual,
    sueldos_mensual,
    impuestos_mensual,
    expensas_mensual,
    otros_mensual,
    observaciones: String(config.finanzas_costos_observaciones || ""),
    total_mensual,
    promedio_diario,
    dias_periodo,
    costo_proporcional_periodo: round2(promedio_diario * dias_periodo),
    estado: total_mensual > 0 ? "configurado" : "incompleto"
  };
}

async function obtenerDesglosePorCanal({ desde, hasta }) {
  const vcWhere = [
    "vc.estado = 'confirmado'",
    "v.estado = 'cobrada'",
    "COALESCE(v.es_cuenta_corriente, 0) = 0",
    "COALESCE(v.estado, '') != 'anulado'"
  ];
  const vcParams = [];
  if (desde) { vcWhere.push("v.fecha >= ?"); vcParams.push(desde); }
  if (hasta) { vcWhere.push("v.fecha <= ?"); vcParams.push(hasta); }

  const legacyWhere = [
    "NOT EXISTS (SELECT 1 FROM venta_cobros vc WHERE vc.venta_id = v.id)",
    "v.estado = 'cobrada'",
    "COALESCE(v.es_cuenta_corriente, 0) = 0",
    "COALESCE(v.estado, '') != 'anulado'"
  ];
  const legacyParams = [];
  if (desde) { legacyWhere.push("v.fecha >= ?"); legacyParams.push(desde); }
  if (hasta) { legacyWhere.push("v.fecha <= ?"); legacyParams.push(hasta); }

  const pccWhere = [];
  const pccParams = [];
  if (desde) { pccWhere.push("pcc.fecha >= ?"); pccParams.push(desde); }
  if (hasta) { pccWhere.push("pcc.fecha <= ?"); pccParams.push(hasta); }
  const pccWhereSQL = pccWhere.length ? `WHERE ${pccWhere.join(" AND ")}` : "";

  const rows = await allQuery(
    `SELECT
       canal.cuenta_cobro_id,
       canal.cuenta_nombre,
       canal.tipo_pago_codigo,
       COALESCE(SUM(canal.ingresos), 0)        AS ingresos,
       COALESCE(SUM(canal.ventas_count), 0)    AS ventas,
       COALESCE(SUM(canal.cobros_cc_count), 0) AS cobros_cc
     FROM (
       SELECT
         vc.cuenta_cobro_id,
         COALESCE(vc.cuenta_cobro_nombre_snapshot, cc.nombre, 'Sin cuenta') AS cuenta_nombre,
         COALESCE(vc.cuenta_cobro_tipo_pago_snapshot, cc.tipo_pago_codigo, vc.tipo_cobro) AS tipo_pago_codigo,
         vc.monto AS ingresos,
         1 AS ventas_count,
         0 AS cobros_cc_count
       FROM venta_cobros vc
       JOIN ventas v ON v.id = vc.venta_id
       LEFT JOIN cuentas_cobro cc ON cc.id = vc.cuenta_cobro_id
       WHERE ${vcWhere.join(" AND ")}
       UNION ALL
       SELECT
         v.cuenta_cobro_id,
         COALESCE(cc.nombre, 'Sin cuenta') AS cuenta_nombre,
         COALESCE(cc.tipo_pago_codigo, v.tipo_cobro, v.metodo_pago) AS tipo_pago_codigo,
         v.total AS ingresos,
         1 AS ventas_count,
         0 AS cobros_cc_count
       FROM ventas v
       LEFT JOIN cuentas_cobro cc ON cc.id = v.cuenta_cobro_id
       WHERE ${legacyWhere.join(" AND ")}
       UNION ALL
       SELECT
         pcc.cuenta_cobro_id,
         COALESCE(pcc.cuenta_cobro_nombre_snapshot, cc.nombre, 'Sin cuenta') AS cuenta_nombre,
         COALESCE(pcc.cuenta_cobro_tipo_pago_snapshot, cc.tipo_pago_codigo, pcc.tipo_cobro) AS tipo_pago_codigo,
         pcc.monto AS ingresos,
         0 AS ventas_count,
         1 AS cobros_cc_count
       FROM pagos_cc_cobros pcc
       LEFT JOIN cuentas_cobro cc ON cc.id = pcc.cuenta_cobro_id
       ${pccWhereSQL}
     ) canal
     GROUP BY canal.cuenta_cobro_id, canal.cuenta_nombre, canal.tipo_pago_codigo
     ORDER BY ingresos DESC`,
    [...vcParams, ...legacyParams, ...pccParams]
  );

  return rows.map((r) => ({
    cuenta_cobro_id: r.cuenta_cobro_id == null ? null : Number(r.cuenta_cobro_id),
    cuenta_nombre: r.cuenta_nombre || "Sin cuenta",
    tipo_pago_codigo: r.tipo_pago_codigo || "",
    ingresos: round2(r.ingresos),
    ventas: Number(r.ventas || 0),
    cobros_cc: Number(r.cobros_cc || 0)
  }));
}

async function getResumenFinanciero({ desde = null, hasta = null } = {}) {
  const alertas = [];
  const fechaCorte = new Date().toISOString();

  const [liquidez, pendientesCobro, capitalInmovilizado, pasivos, movimientosNoMonetarios, ingresosPeriodo, costosOperativosFijos, desglosePorCanal] = await Promise.all([
    obtenerLiquidez(alertas),
    obtenerPendientesCobro({ desde, hasta }, alertas),
    obtenerCapitalInmovilizado({ desde, hasta }),
    obtenerPasivos({ desde, hasta }, alertas),
    obtenerMovimientosNoMonetarios({ desde, hasta }),
    obtenerIngresosPeriodo({ desde, hasta }),
    obtenerCostosOperativosFijos({ desde, hasta }),
    obtenerDesglosePorCanal({ desde, hasta })
  ]);

  const resultado_operativo = round2(ingresosPeriodo.ventas_cobradas + ingresosPeriodo.cobros_cuenta_corriente - pasivos.egresos_ejecutados);
  return {
    fecha_corte: fechaCorte,
    filtros: { desde, hasta },
    liquidez,
    pendientes_cobro: pendientesCobro,
    capital_inmovilizado: capitalInmovilizado,
    pasivos,
    ingresos_periodo: ingresosPeriodo,
    desglose_por_canal: desglosePorCanal,
    movimientos_no_monetarios: movimientosNoMonetarios,
    costos_operativos_fijos: costosOperativosFijos,
    resultado: {
      posicion_liquida: round2(liquidez.total),
      masa_monetaria_bruta: round2(liquidez.total + pendientesCobro.total + capitalInmovilizado.total_operativo),
      patrimonio_operativo_estimado: round2(
        liquidez.total +
        pendientesCobro.total +
        capitalInmovilizado.stock_fisico_valorizado -
        pasivos.total
      ),
      deuda_neta: round2(pasivos.total - pendientesCobro.cuentas_corrientes_clientes),
      resultado_operativo,
      resultado_neto_estimado: round2(resultado_operativo - costosOperativosFijos.costo_proporcional_periodo)
    },
    alertas
  };
}

module.exports = {
  getResumenFinanciero
};
