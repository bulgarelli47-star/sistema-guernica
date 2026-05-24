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
  const pagosWhere = ["COALESCE(estado, '') = 'pendiente'", "proveedor_id IS NULL"];
  const pagosParams = [];
  if (desde) { pagosWhere.push("fecha >= ?"); pagosParams.push(desde); }
  if (hasta) { pagosWhere.push("fecha <= ?"); pagosParams.push(hasta); }
  const pagosRows = await allQuery(
    `SELECT COALESCE(SUM(monto_total), 0) AS total FROM pagos WHERE ${pagosWhere.join(" AND ")}`,
    pagosParams
  );

  const pasivos = {
    pagos_pendientes: round2(pagosRows[0]?.total),
    proveedores_pendientes: round2(proveedores?.resumen?.total_pendiente),
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

async function getResumenFinanciero({ desde = null, hasta = null } = {}) {
  const alertas = [];
  const fechaCorte = new Date().toISOString();

  const [liquidez, pendientesCobro, capitalInmovilizado, pasivos] = await Promise.all([
    obtenerLiquidez(alertas),
    obtenerPendientesCobro({ desde, hasta }, alertas),
    obtenerCapitalInmovilizado({ desde, hasta }),
    obtenerPasivos({ desde, hasta }, alertas)
  ]);

  return {
    fecha_corte: fechaCorte,
    filtros: { desde, hasta },
    liquidez,
    pendientes_cobro: pendientesCobro,
    capital_inmovilizado: capitalInmovilizado,
    pasivos,
    resultado: {
      posicion_liquida: round2(liquidez.total),
      masa_monetaria_bruta: round2(liquidez.total + pendientesCobro.total + capitalInmovilizado.total_operativo),
      patrimonio_operativo_estimado: round2(
        liquidez.total +
        pendientesCobro.total +
        capitalInmovilizado.stock_fisico_valorizado -
        pasivos.total
      ),
      deuda_neta: round2(pasivos.total - pendientesCobro.cuentas_corrientes_clientes)
    },
    alertas
  };
}

module.exports = {
  getResumenFinanciero
};
