const { allQuery, getQuery, runQuery } = require("../db");

async function ensureColumn(tableName, columnName, definition) {
  const columns = await allQuery(`PRAGMA table_info(${tableName})`);
  const exists = columns.some((column) => column.name === columnName);

  if (!exists) {
    await runQuery(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

async function ensureCajaMovimientosTable() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS caja_movimientos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caja_id INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      concepto TEXT NOT NULL,
      monto REAL NOT NULL,
      usuario TEXT NOT NULL DEFAULT 'admin',
      fecha TEXT NOT NULL,
      hora TEXT NOT NULL
    )
  `);
}

async function ensureCajaArqueosTable() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS caja_arqueos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caja_id INTEGER NOT NULL,
      fecha TEXT NOT NULL,
      hora TEXT NOT NULL,
      usuario TEXT NOT NULL DEFAULT 'admin',
      efectivo_esperado REAL NOT NULL DEFAULT 0,
      efectivo_contado REAL NOT NULL DEFAULT 0,
      diferencia_efectivo REAL NOT NULL DEFAULT 0,
      digital_esperado REAL NOT NULL DEFAULT 0,
      digital_real REAL NOT NULL DEFAULT 0,
      diferencia_digital REAL NOT NULL DEFAULT 0,
      resultado_final REAL NOT NULL DEFAULT 0,
      estado TEXT NOT NULL DEFAULT 'Sobra',
      observaciones TEXT,
      conteo_detalle TEXT,
      cuentas_detalle TEXT,
      resumen_snapshot TEXT
    )
  `);
  await ensureColumn("caja_arqueos", "registrado_cierre", "INTEGER NOT NULL DEFAULT 1");
}

async function getCajaAperturaHoy(fecha) {
  return getQuery(
    `SELECT *
     FROM caja_aperturas
     WHERE fecha = ?
     ORDER BY id DESC
     LIMIT 1`,
    [fecha]
  );
}

async function getCajaAbiertaActual() {
  return getQuery(
    `SELECT *
     FROM caja_aperturas
     WHERE estado = 'abierta'
     ORDER BY id DESC
     LIMIT 1`
  );
}

async function getUltimaCajaRegistrada() {
  return getQuery(
    `SELECT *
     FROM caja_aperturas
     ORDER BY id DESC
     LIMIT 1`
  );
}

function parseJsonOrFallback(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function buildConteoBilletes(conteo = {}) {
  const denominaciones = [10, 20, 50, 100, 200, 500, 1000, 2000, 10000, 20000];
  const detalle = {};
  let total = 0;

  denominaciones.forEach((denominacion) => {
    const cantidad = Number(conteo[String(denominacion)] ?? conteo[denominacion]) || 0;
    detalle[String(denominacion)] = cantidad;

    if (denominacion < 500) {
      total += denominacion * cantidad;
      return;
    }

    if (denominacion === 500) {
      total += (cantidad % 2 === 1 ? 500 : 0) + Math.floor(cantidad / 2) * 1000;
      return;
    }

    total += denominacion * cantidad;
  });

  return {
    detalle,
    total: Number(total.toFixed(2))
  };
}

async function getPagosCaja(cajaId) {
  if (!cajaId) {
    return [];
  }

  const pagosEgresos = await allQuery(
    `SELECT p.id, p.fecha, p.hora, p.monto_total AS total, p.tipo_pago AS tipo_cobro,
            p.monto_efectivo, p.monto_debito, p.proveedor_id, p.caja_id,
            'registrado' AS estado, pr.nombre AS proveedor_nombre, p.concepto,
            'egreso' AS tipo
     FROM pagos p
     LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
     WHERE p.caja_id = ?
     ORDER BY p.hora DESC, p.id DESC`,
    [cajaId]
  );
  return pagosEgresos.map((pago) => ({
    ...pago,
    tipo_operacion: "pago_proveedor"
  }));
}

async function getOperacionesCaja(cajaId) {
  if (!cajaId) {
    return [];
  }

  await ensureCajaMovimientosTable();

  const ventas = await allQuery(
    `SELECT v.id, v.fecha, v.hora, v.total, v.tipo_cobro, v.monto_efectivo, v.monto_debito,
            v.cliente_id, v.estado, v.es_cuenta_corriente, c.nombre AS cliente_nombre, v.tipo, v.caja_id
     FROM ventas v
     LEFT JOIN clientes c ON c.id = v.cliente_id
     WHERE (v.caja_id = ? OR EXISTS (
       SELECT 1
       FROM pagos_cuenta_corriente pcc
       WHERE pcc.venta_id = v.id AND pcc.caja_id = ?
     ))
       AND (v.estado = 'cobrada' OR (v.es_cuenta_corriente = 1 AND v.estado = 'cuenta_corriente_pendiente'))
       AND (v.tipo = 'normal' OR v.tipo = 'pendiente')
     ORDER BY v.hora DESC, v.id DESC`,
    [cajaId, cajaId]
  );

  const pagosCuentaCorriente = await allQuery(
    `SELECT pcc.id, pcc.fecha, pcc.hora, pcc.monto_pagado AS total, pcc.tipo_cobro,
            pcc.monto_efectivo, pcc.monto_debito, pcc.cliente_id, pcc.caja_id,
            'cobrada' AS estado, c.nombre AS cliente_nombre,
            'cuenta_corriente' AS tipo
     FROM pagos_cuenta_corriente pcc
     LEFT JOIN clientes c ON c.id = pcc.cliente_id
     WHERE pcc.caja_id = ?
     ORDER BY pcc.hora DESC, pcc.id DESC`,
    [cajaId]
  );

  const pagosEgresos = await getPagosCaja(cajaId);
  const movimientosManuales = await allQuery(
    `SELECT id, caja_id, tipo, concepto, monto AS total, usuario, fecha, hora,
            'efectivo' AS tipo_cobro,
            CASE WHEN tipo = 'ingreso' THEN monto ELSE 0 END AS monto_efectivo,
            0 AS monto_debito
     FROM caja_movimientos
     WHERE caja_id = ?
     ORDER BY hora DESC, id DESC`,
    [cajaId]
  );

  const operaciones = [
    ...ventas.map((venta) => ({
      ...venta,
      tipo_operacion: Number(venta.es_cuenta_corriente) === 1
        ? "venta_cuenta_corriente"
        : venta.tipo === "pendiente"
          ? "venta_pendiente_cobrada"
          : "venta_normal"
    })),
    ...pagosCuentaCorriente.map((pago) => ({
      ...pago,
      tipo_operacion: "cobro_cuenta_corriente"
    })),
    ...pagosEgresos.map((pago) => ({
      ...pago,
      cliente_nombre: null,
      tipo_operacion: "pago_proveedor"
    })),
    ...movimientosManuales.map((movimiento) => ({
      ...movimiento,
      cliente_nombre: null,
      proveedor_nombre: null,
      tipo_operacion: movimiento.tipo === "ingreso"
        ? "caja_movimiento_ingreso"
        : "caja_movimiento_egreso",
      monto_efectivo: Number(movimiento.total || 0),
      monto_debito: 0
    }))
  ];

  operaciones.sort((a, b) => {
    const timeA = `${a.fecha} ${a.hora} ${String(a.id).padStart(8, "0")}`;
    const timeB = `${b.fecha} ${b.hora} ${String(b.id).padStart(8, "0")}`;
    return timeA < timeB ? 1 : -1;
  });

  return operaciones;
}

function mapearProductosDetalle(rows) {
  return rows.map((producto) => {
    const cantidad = Number(producto.cantidad || 0);
    const subtotal = Number(producto.subtotal || 0);
    const costoFinal = Number(producto.costo_final || 0);
    const precioCompra = Number(producto.precio_compra || 0);
    const costoBase = costoFinal > 0 ? costoFinal : precioCompra > 0 ? precioCompra : null;
    const sinCostoInformado = !producto.producto_id || costoBase == null;
    const costoItem = sinCostoInformado ? null : Number((costoBase * cantidad).toFixed(2));
    const gananciaEstimada = sinCostoInformado ? null : Number((subtotal - costoItem).toFixed(2));
    return {
      producto_id: producto.producto_id,
      nombre_producto: producto.nombre_producto,
      cantidad,
      precio_venta: Number(producto.precio_unitario || 0),
      subtotal,
      costo_final_usado: costoBase,
      costo_item: costoItem,
      ganancia_estimada: gananciaEstimada,
      sin_costo_informado: sinCostoInformado
    };
  });
}

const TIPOS_SIN_DETALLE = new Set([
  "cobro_cuenta_corriente",
  "pago_proveedor",
  "caja_movimiento_ingreso",
  "caja_movimiento_egreso"
]);

async function buildCajaSnapshot(cajaId) {
  const operaciones = await getOperacionesCaja(cajaId);

  const ventaIds = operaciones
    .filter((op) => !TIPOS_SIN_DETALLE.has(op.tipo_operacion))
    .map((op) => op.id);

  if (!ventaIds.length) {
    return operaciones.map((op) => ({ ...op, productos: [] }));
  }

  const detalles = await allQuery(
    `SELECT dv.venta_id, dv.producto_id, dv.nombre_producto, dv.cantidad, dv.precio_unitario, dv.subtotal,
            p.costo_final, p.precio_compra
     FROM detalle_ventas dv
     LEFT JOIN productos p ON p.id = dv.producto_id
     WHERE dv.venta_id IN (${ventaIds.map(() => "?").join(",")})
     ORDER BY dv.venta_id, dv.id ASC`,
    ventaIds
  );

  const detalleMap = new Map();
  for (const d of detalles) {
    if (!detalleMap.has(d.venta_id)) detalleMap.set(d.venta_id, []);
    detalleMap.get(d.venta_id).push(d);
  }

  return operaciones.map((operacion) => ({
    ...operacion,
    productos: TIPOS_SIN_DETALLE.has(operacion.tipo_operacion)
      ? []
      : mapearProductosDetalle(detalleMap.get(operacion.id) || [])
  }));
}

function buildCajaResumen(ventas) {
  const resumen = ventas.reduce(
    (acc, movimiento) => {
      const efectivo = Number(movimiento.monto_efectivo || 0);
      const debito = Number(movimiento.monto_debito || 0);
      const esPago = movimiento.tipo_operacion === "pago_proveedor";
      const esIngresoManual = movimiento.tipo_operacion === "caja_movimiento_ingreso";
      const esEgresoManual = movimiento.tipo_operacion === "caja_movimiento_egreso";
      const esVenta = movimiento.tipo_operacion === "venta_normal" ||
        movimiento.tipo_operacion === "venta_pendiente_cobrada" ||
        movimiento.tipo_operacion === "venta_cuenta_corriente";
      const esCuentaCorrientePendiente = movimiento.tipo_operacion === "venta_cuenta_corriente";
      const tipoCobro = String(movimiento.tipo_cobro || "").toLowerCase();

      if (esPago || esEgresoManual) {
        acc.total_pagos_efectivo += efectivo;
        acc.total_pagos_debito += debito;
        acc.total_pagos_general += Number((efectivo + debito).toFixed(2));
      } else if (esIngresoManual) {
        acc.total_efectivo += efectivo;
      } else if (esCuentaCorrientePendiente) {
        acc.total_cuenta_corriente += Number(movimiento.total || 0);
      } else {
        acc.total_efectivo += efectivo;
        acc.total_debito += debito;

        if (tipoCobro === "transferencia") {
          acc.total_transferencia += debito;
        } else if (tipoCobro === "debito") {
          acc.total_debito_tarjeta += debito;
        } else if (tipoCobro === "mixto") {
          acc.total_debito_tarjeta += debito;
          acc.operaciones_mixtas += 1;
        }
      }

      if (esVenta) {
        acc.total_ventas += Number(movimiento.total || 0);

        if (Array.isArray(movimiento.productos)) {
          movimiento.productos.forEach((producto) => {
            if (producto.sin_costo_informado) {
              acc.total_ventas_manual_sin_costo += Number(producto.subtotal || 0);
              return;
            }

            acc.costo_estimado_vendido += Number(producto.costo_item || 0);
            acc.ganancia_bruta_estimada += Number(producto.ganancia_estimada || 0);
          });
        }
      }

      acc.total_general = Number(
        (acc.total_efectivo + acc.total_debito - acc.total_pagos_general).toFixed(2)
      );
      acc.resultado_estimado_dia = Number(
        (acc.ganancia_bruta_estimada - acc.total_pagos_general).toFixed(2)
      );
      return acc;
    },
    {
      total_efectivo: 0,
      total_debito: 0,
      total_debito_tarjeta: 0,
      total_transferencia: 0,
      total_cuenta_corriente: 0,
      total_pagos_efectivo: 0,
      total_pagos_debito: 0,
      total_pagos_general: 0,
      operaciones_mixtas: 0,
      total_general: 0,
      total_ventas: 0,
      costo_estimado_vendido: 0,
      ganancia_bruta_estimada: 0,
      total_ventas_manual_sin_costo: 0,
      resultado_estimado_dia: 0,
      saldo_inicial_mp: 0,
      saldo_mp_estimado: 0
    }
  );

  resumen.total_efectivo = Number(resumen.total_efectivo.toFixed(2));
  resumen.total_debito = Number(resumen.total_debito.toFixed(2));
  resumen.total_debito_tarjeta = Number(resumen.total_debito_tarjeta.toFixed(2));
  resumen.total_transferencia = Number(resumen.total_transferencia.toFixed(2));
  resumen.total_cuenta_corriente = Number(resumen.total_cuenta_corriente.toFixed(2));
  resumen.total_pagos_efectivo = Number(resumen.total_pagos_efectivo.toFixed(2));
  resumen.total_pagos_debito = Number(resumen.total_pagos_debito.toFixed(2));
  resumen.total_pagos_general = Number(resumen.total_pagos_general.toFixed(2));
  resumen.total_general = Number(resumen.total_general.toFixed(2));
  resumen.total_ventas = Number(resumen.total_ventas.toFixed(2));
  resumen.costo_estimado_vendido = Number(resumen.costo_estimado_vendido.toFixed(2));
  resumen.ganancia_bruta_estimada = Number(resumen.ganancia_bruta_estimada.toFixed(2));
  resumen.total_ventas_manual_sin_costo = Number(resumen.total_ventas_manual_sin_costo.toFixed(2));
  resumen.resultado_estimado_dia = Number(resumen.resultado_estimado_dia.toFixed(2));
  return resumen;
}

function buildCajaResumenConSaldoMp(ventas, apertura) {
  const resumen = buildCajaResumen(ventas);
  const saldoInicialMp = Number(apertura?.saldo_inicial_mp || 0);

  return {
    ...resumen,
    saldo_inicial_mp: Number(saldoInicialMp.toFixed(2)),
    saldo_mp_estimado: Number(
      (saldoInicialMp + Number(resumen.total_debito || 0) - Number(resumen.total_pagos_debito || 0)).toFixed(2)
    ),
    total_dinero_digital: Number(resumen.total_debito.toFixed(2))
  };
}

function mapCajaArqueo(arqueo) {
  return {
    ...arqueo,
    conteo_detalle: parseJsonOrFallback(arqueo.conteo_detalle, {}),
    cuentas_detalle: parseJsonOrFallback(arqueo.cuentas_detalle, []),
    resumen_snapshot: parseJsonOrFallback(arqueo.resumen_snapshot, null)
  };
}

async function getCajaParaArqueos() {
  return await getCajaAbiertaActual() || await getUltimaCajaRegistrada();
}

async function buildCajaArqueoData(apertura, body = {}) {
  const usuario = String(body.usuario || "admin").trim() || "admin";
  const observaciones = String(body.observaciones || "").trim();
  const conteo = body.conteo || {};
  const cuentas = Array.isArray(body.cuentas) ? body.cuentas : [];
  const operaciones = await buildCajaSnapshot(apertura.id);
  const resumen = buildCajaResumenConSaldoMp(operaciones, apertura);
  const efectivoEsperado = Number(
    (
      Number(apertura.monto_apertura || 0) +
      Number(resumen.total_efectivo || 0) -
      Number(resumen.total_pagos_efectivo || 0)
    ).toFixed(2)
  );
  const conteoResultado = buildConteoBilletes(conteo);
  const efectivoContado = Number(conteoResultado.total || 0);
  const diferenciaEfectivo = Number((efectivoContado - efectivoEsperado).toFixed(2));
  const cuentasDetalle = cuentas.map((cuenta, index) => {
    const nombre = String(cuenta.nombre || `Cuenta ${index + 1}`).trim() || `Cuenta ${index + 1}`;
    const saldoInicial = Number(cuenta.saldo_inicial || 0);
    const saldoActual = Number(cuenta.saldo_actual || 0);
    return {
      nombre,
      saldo_inicial: Number(saldoInicial.toFixed(2)),
      saldo_actual: Number(saldoActual.toFixed(2)),
      recaudacion_real: Number((saldoActual - saldoInicial).toFixed(2))
    };
  });
  const digitalReal = Number(
    cuentasDetalle.reduce((acc, cuenta) => acc + Number(cuenta.recaudacion_real || 0), 0).toFixed(2)
  );
  const digitalEsperado = Number((
    Number(resumen.total_debito_tarjeta ?? resumen.total_debito ?? 0) +
    Number(resumen.total_transferencia || 0)
  ).toFixed(2));
  const diferenciaDigital = Number((digitalReal - digitalEsperado).toFixed(2));
  const resultadoFinal = Number((diferenciaEfectivo + diferenciaDigital).toFixed(2));
  const estado = resultadoFinal >= 0 ? "Sobra" : "Falta";

  return {
    usuario,
    observaciones,
    efectivoEsperado,
    efectivoContado,
    diferenciaEfectivo,
    digitalEsperado,
    digitalReal,
    diferenciaDigital,
    resultadoFinal,
    estado,
    conteoDetalle: conteoResultado.detalle,
    cuentasDetalle,
    resumen
  };
}

module.exports = {
  buildCajaArqueoData,
  buildCajaResumen,
  buildCajaResumenConSaldoMp,
  buildCajaSnapshot,
  buildConteoBilletes,
  ensureCajaArqueosTable,
  ensureCajaMovimientosTable,
  getCajaAbiertaActual,
  getCajaAperturaHoy,
  getCajaParaArqueos,
  getOperacionesCaja,
  getPagosCaja,
  getUltimaCajaRegistrada,
  mapCajaArqueo,
  parseJsonOrFallback
};
