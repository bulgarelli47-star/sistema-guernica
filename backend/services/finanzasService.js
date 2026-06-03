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

  const rows = await allQuery(
    `SELECT
       COALESCE(SUM(CASE WHEN estado = 'cobrada' THEN total ELSE 0 END), 0) AS ventas_cobradas,
       COALESCE(SUM(CASE WHEN estado = 'pendiente' AND COALESCE(es_cuenta_corriente, 0) = 0 THEN total ELSE 0 END), 0) AS ventas_pendientes,
       COALESCE(SUM(CASE WHEN COALESCE(es_cuenta_corriente, 0) = 1 THEN total ELSE 0 END), 0) AS ventas_cuenta_corriente,
       COALESCE(SUM(total), 0) AS total_periodo
     FROM ventas
     WHERE ${where.join(" AND ")}`,
    params
  );

  const row = rows[0] || {};
  // total_periodo es SUM directo sin CASE: una venta CC cobrada se cuenta una sola vez
  return {
    ventas_cobradas: round2(row.ventas_cobradas),
    ventas_pendientes: round2(row.ventas_pendientes),
    ventas_cuenta_corriente: round2(row.ventas_cuenta_corriente),
    total_periodo: round2(row.total_periodo)
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

async function getResumenFinanciero({ desde = null, hasta = null } = {}) {
  const alertas = [];
  const fechaCorte = new Date().toISOString();

  const [liquidez, pendientesCobro, capitalInmovilizado, pasivos, movimientosNoMonetarios, ingresosPeriodo] = await Promise.all([
    obtenerLiquidez(alertas),
    obtenerPendientesCobro({ desde, hasta }, alertas),
    obtenerCapitalInmovilizado({ desde, hasta }),
    obtenerPasivos({ desde, hasta }, alertas),
    obtenerMovimientosNoMonetarios({ desde, hasta }),
    obtenerIngresosPeriodo({ desde, hasta })
  ]);

  return {
    fecha_corte: fechaCorte,
    filtros: { desde, hasta },
    liquidez,
    pendientes_cobro: pendientesCobro,
    capital_inmovilizado: capitalInmovilizado,
    pasivos,
    ingresos_periodo: ingresosPeriodo,
    movimientos_no_monetarios: movimientosNoMonetarios,
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
      resultado_operativo: round2(ingresosPeriodo.ventas_cobradas - pasivos.egresos_ejecutados)
    },
    alertas
  };
}

module.exports = {
  getResumenFinanciero
};
