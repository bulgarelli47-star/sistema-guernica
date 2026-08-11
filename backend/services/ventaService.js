const { allQuery, getQuery, runQuery } = require("../db");

const IVA_VENTA_TRATAMIENTOS_SNAPSHOT = new Set(["gravado", "exento", "no_gravado"]);

function round2(value) {
  const numero = Number(value);
  if (!Number.isFinite(numero)) return 0;
  return Number(numero.toFixed(2));
}

function crearErrorSnapshotFiscal(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function normalizarNumeroSnapshot(value, { nullable = false } = {}) {
  if (value == null || value === "") return nullable ? null : 0;
  const numero = Number(value);
  if (!Number.isFinite(numero) || numero < 0) return nullable ? null : 0;
  return numero;
}

function buildDetalleVentaSnapshotFiscal({ producto = {}, cantidad = 0, precio_unitario = 0 } = {}) {
  const modeloFiscal = String(producto?.modelo_fiscal || "legacy").trim().toLowerCase();

  if (modeloFiscal !== "normalizado") {
    return {
      modelo_fiscal_snapshot: "legacy",
      costo_economico_snapshot: null,
      iva_venta_tratamiento_snapshot: null,
      iva_venta_alicuota_snapshot: null,
      subtotal_neto_snapshot: null,
      iva_monto_snapshot: null
    };
  }

  const tratamiento = String(producto?.iva_venta_tratamiento || "").trim().toLowerCase();
  if (!IVA_VENTA_TRATAMIENTOS_SNAPSHOT.has(tratamiento)) {
    throw crearErrorSnapshotFiscal("Producto normalizado sin tratamiento IVA de venta valido");
  }

  const cantidadNormalizada = normalizarNumeroSnapshot(cantidad);
  const precioUnitarioNormalizado = normalizarNumeroSnapshot(precio_unitario);
  const subtotal = round2(cantidadNormalizada * precioUnitarioNormalizado);
  const costoEconomico = normalizarNumeroSnapshot(producto?.costo_economico, { nullable: true });
  let alicuota = 0;
  if (tratamiento === "gravado") {
    const alicuotaRaw = Number(producto?.iva_venta_alicuota);
    if (producto?.iva_venta_alicuota == null || producto?.iva_venta_alicuota === "" || !Number.isFinite(alicuotaRaw) || alicuotaRaw < 0) {
      throw crearErrorSnapshotFiscal("Producto normalizado gravado sin alicuota IVA de venta valida");
    }
    alicuota = alicuotaRaw;
  }

  const subtotalNeto = tratamiento === "gravado" && alicuota > 0
    ? round2(subtotal / (1 + alicuota / 100))
    : subtotal;
  const ivaMonto = tratamiento === "gravado"
    ? round2(subtotal - subtotalNeto)
    : 0;

  return {
    modelo_fiscal_snapshot: "normalizado",
    costo_economico_snapshot: costoEconomico,
    iva_venta_tratamiento_snapshot: tratamiento,
    iva_venta_alicuota_snapshot: alicuota,
    subtotal_neto_snapshot: subtotalNeto,
    iva_monto_snapshot: ivaMonto
  };
}

function esNumeroFinito(value) {
  const numero = Number(value);
  return Number.isFinite(numero);
}

function normalizarTotalLinea(item) {
  if (esNumeroFinito(item?.subtotal)) return round2(Number(item.subtotal));
  return round2(normalizarNumeroSnapshot(item?.cantidad) * normalizarNumeroSnapshot(item?.precio_unitario));
}

function crearBucketFiscal(tratamiento, alicuota = 0) {
  return {
    tratamiento,
    alicuota: round2(alicuota),
    neto: 0,
    iva: 0,
    total: 0
  };
}

function sumarBucketFiscal(buckets, tratamiento, alicuota, neto, iva) {
  const alicuotaNormalizada = tratamiento === "gravado" ? round2(alicuota) : 0;
  const key = `${tratamiento}:${alicuotaNormalizada}`;
  if (!buckets.has(key)) {
    buckets.set(key, crearBucketFiscal(tratamiento, alicuotaNormalizada));
  }
  const bucket = buckets.get(key);
  bucket.neto = round2(bucket.neto + neto);
  bucket.iva = round2(bucket.iva + iva);
  bucket.total = round2(bucket.total + neto + iva);
}

function buildResumenFiscalVenta(venta = {}, items = []) {
  const rows = Array.isArray(items) ? items : [];
  const totalHistorico = round2(venta?.total_venta_original ?? venta?.total ?? 0);
  const recargoMonto = round2(venta?.recargo_monto ?? 0);
  const subtotalItems = round2(rows.reduce((acc, item) => acc + normalizarTotalLinea(item), 0));
  const diferenciaFueraItems = round2(totalHistorico - subtotalItems);
  const diferenciaComercialInconsistente = Math.abs(diferenciaFueraItems - recargoMonto) > 0.01;
  const recargoRequiereClasificacion = recargoMonto > 0;
  const buckets = new Map();

  let normalizados = 0;
  let legacy = 0;
  let sinSnapshot = 0;
  let invalidos = 0;
  let montoSinClasificacionFiscal = 0;

  for (const item of rows) {
    const subtotalLinea = normalizarTotalLinea(item);
    const modelo = item?.modelo_fiscal_snapshot == null || item?.modelo_fiscal_snapshot === ""
      ? null
      : String(item.modelo_fiscal_snapshot).trim().toLowerCase();

    if (modelo !== "normalizado") {
      if (modelo === "legacy") legacy += 1;
      else sinSnapshot += 1;
      montoSinClasificacionFiscal = round2(montoSinClasificacionFiscal + subtotalLinea);
      continue;
    }

    const tratamiento = String(item?.iva_venta_tratamiento_snapshot || "").trim().toLowerCase();
    const neto = Number(item?.subtotal_neto_snapshot);
    const iva = Number(item?.iva_monto_snapshot);
    const alicuota = Number(item?.iva_venta_alicuota_snapshot || 0);

    if (!IVA_VENTA_TRATAMIENTOS_SNAPSHOT.has(tratamiento) || !Number.isFinite(neto) || !Number.isFinite(iva) || !Number.isFinite(alicuota)) {
      invalidos += 1;
      montoSinClasificacionFiscal = round2(montoSinClasificacionFiscal + subtotalLinea);
      continue;
    }

    normalizados += 1;
    sumarBucketFiscal(buckets, tratamiento, tratamiento === "gravado" ? alicuota : 0, round2(neto), round2(iva));
  }

  const alicuotas = Array.from(buckets.values())
    .map((bucket) => ({
      ...bucket,
      neto: round2(bucket.neto),
      iva: round2(bucket.iva),
      total: round2(bucket.total)
    }))
    .sort((a, b) => {
      const orden = { gravado: 0, exento: 1, no_gravado: 2 };
      if (orden[a.tratamiento] !== orden[b.tratamiento]) return orden[a.tratamiento] - orden[b.tratamiento];
      return a.alicuota - b.alicuota;
    });

  const netoGravado = round2(alicuotas
    .filter((bucket) => bucket.tratamiento === "gravado")
    .reduce((acc, bucket) => acc + bucket.neto, 0));
  const ivaTotal = round2(alicuotas
    .filter((bucket) => bucket.tratamiento === "gravado")
    .reduce((acc, bucket) => acc + bucket.iva, 0));
  const montoExento = round2(alicuotas
    .filter((bucket) => bucket.tratamiento === "exento")
    .reduce((acc, bucket) => acc + bucket.total, 0));
  const montoNoGravado = round2(alicuotas
    .filter((bucket) => bucket.tratamiento === "no_gravado")
    .reduce((acc, bucket) => acc + bucket.total, 0));
  const subtotalClasificado = round2(alicuotas.reduce((acc, bucket) => acc + bucket.total, 0));
  const cierreFiscalItems = Math.abs(round2(subtotalClasificado + montoSinClasificacionFiscal) - subtotalItems) <= 0.01;

  let coberturaItems = "sin_snapshot";
  if (rows.length > 0) {
    if (normalizados === rows.length) coberturaItems = "completa";
    else if (legacy === rows.length) coberturaItems = "legacy";
    else if (sinSnapshot === rows.length) coberturaItems = "sin_snapshot";
    else coberturaItems = "parcial";
  }

  return {
    total_historico: totalHistorico,
    subtotal_items: subtotalItems,
    recargo_monto: recargoMonto,
    diferencia_fuera_items: diferenciaFueraItems,
    diferencia_comercial_inconsistente: diferenciaComercialInconsistente,

    neto_gravado: netoGravado,
    iva_total: ivaTotal,
    monto_exento: montoExento,
    monto_no_gravado: montoNoGravado,
    monto_sin_clasificacion_fiscal: montoSinClasificacionFiscal,
    alicuotas,

    cobertura_items: coberturaItems,
    recargo_requiere_clasificacion: recargoRequiereClasificacion,
    cierre_fiscal_items: cierreFiscalItems,
    snapshot_integracion_completo: coberturaItems === "completa"
      && !recargoRequiereClasificacion
      && !diferenciaComercialInconsistente
      && cierreFiscalItems
      && invalidos === 0
  };
}

async function ensureDetalleVentaIngredientesTable() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS detalle_venta_ingredientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      detalle_venta_id INTEGER NOT NULL,
      ingrediente_id INTEGER,
      tipo TEXT NOT NULL,
      nombre TEXT,
      cantidad REAL DEFAULT 1,
      nota TEXT,
      FOREIGN KEY (detalle_venta_id) REFERENCES detalle_ventas(id)
    )
  `);
  await runQuery("CREATE INDEX IF NOT EXISTS idx_detalle_venta_ingredientes_detalle ON detalle_venta_ingredientes(detalle_venta_id)");
}

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

  if (tipo) {
    return {
      tipo_cobro: tipo,
      monto_efectivo: 0,
      monto_debito: totalRounded
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
     SET saldo_pendiente = ?, estado = ?
     WHERE id = ?`,
    [
      snapshot.saldo_actual,
      snapshot.saldo_actual === 0 ? "cobrada" : "cuenta_corriente_pendiente",
      ventaId
    ]
  );

  return snapshot;
}

async function replaceVentaDetalle(ventaId, items) {
  await ensureDetalleVentaIngredientesTable();
  const detallesAnteriores = await allQuery("SELECT id FROM detalle_ventas WHERE venta_id = ?", [ventaId]);
  const detalleIds = detallesAnteriores.map((item) => item.id);
  if (detalleIds.length) {
    await runQuery(
      `DELETE FROM detalle_venta_ingredientes WHERE detalle_venta_id IN (${detalleIds.map(() => "?").join(",")})`,
      detalleIds
    );
  }
  await runQuery("DELETE FROM detalle_ventas WHERE venta_id = ?", [ventaId]);

  const productoIds = [...new Set(items.map((item) => Number(item.producto_id || 0)).filter(Boolean))];
  const productosPorId = new Map();
  if (productoIds.length) {
    const placeholders = productoIds.map(() => "?").join(",");
    const productos = await allQuery(
      `SELECT id, modelo_fiscal, costo_economico, iva_venta_tratamiento, iva_venta_alicuota
       FROM productos
       WHERE id IN (${placeholders})`,
      productoIds
    );
    productos.forEach((producto) => productosPorId.set(Number(producto.id), producto));

    const faltantes = productoIds.filter((id) => !productosPorId.has(id));
    if (faltantes.length) {
      throw crearErrorSnapshotFiscal(`Producto no encontrado para snapshot fiscal: ${faltantes.join(", ")}`);
    }
  }

  const detalles = [];
  for (const item of items) {
    const subtotal = item.cantidad * item.precio_unitario;
    const productoId = Number(item.producto_id || 0);
    const productoSnapshot = productoId ? productosPorId.get(productoId) : { modelo_fiscal: "legacy" };
    const snapshotFiscal = buildDetalleVentaSnapshotFiscal({
      producto: productoSnapshot,
      cantidad: item.cantidad,
      precio_unitario: item.precio_unitario
    });

    const result = await runQuery(
      `INSERT INTO detalle_ventas
      (venta_id, producto_id, nombre_producto, cantidad, precio_unitario, subtotal,
       modelo_fiscal_snapshot, costo_economico_snapshot, iva_venta_tratamiento_snapshot,
       iva_venta_alicuota_snapshot, subtotal_neto_snapshot, iva_monto_snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ventaId,
        item.producto_id,
        item.nombre_producto,
        item.cantidad,
        item.precio_unitario,
        subtotal,
        snapshotFiscal.modelo_fiscal_snapshot,
        snapshotFiscal.costo_economico_snapshot,
        snapshotFiscal.iva_venta_tratamiento_snapshot,
        snapshotFiscal.iva_venta_alicuota_snapshot,
        snapshotFiscal.subtotal_neto_snapshot,
        snapshotFiscal.iva_monto_snapshot
      ]
    );

    detalles.push({
      ...item,
      id: result.lastID,
      detalle_venta_id: result.lastID,
      subtotal,
      ...snapshotFiscal
    });

    for (const ingrediente of Array.isArray(item.ingredientes) ? item.ingredientes : []) {
      await runQuery(
        `INSERT INTO detalle_venta_ingredientes
        (detalle_venta_id, ingrediente_id, tipo, nombre, cantidad, nota)
        VALUES (?, ?, ?, ?, ?, ?)`,
        [
          result.lastID,
          ingrediente.ingrediente_id ?? ingrediente.id ?? null,
          String(ingrediente.tipo || "quitar").trim().toLowerCase(),
          ingrediente.nombre || ingrediente.nombre_snapshot || null,
          Number(ingrediente.cantidad || 1) || 1,
          ingrediente.nota || null
        ]
      );
    }
  }

  return detalles;
}

async function getVentaDetalleRows(ventaId) {
  return allQuery(
    `SELECT id, venta_id, producto_id, nombre_producto, cantidad, precio_unitario, subtotal,
            modelo_fiscal_snapshot, costo_economico_snapshot, iva_venta_tratamiento_snapshot,
            iva_venta_alicuota_snapshot, subtotal_neto_snapshot, iva_monto_snapshot
     FROM detalle_ventas
     WHERE venta_id = ?
     ORDER BY id ASC`,
    [ventaId]
  );
}

async function getVentaConDetalle(ventaId) {
  await ensureDetalleVentaIngredientesTable();
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
    item.ingredientes = await allQuery(
      `SELECT ingrediente_id, nombre, tipo, cantidad, nota
       FROM detalle_venta_ingredientes
       WHERE detalle_venta_id = ?
       ORDER BY id ASC`,
      [item.id]
    );
  }
  return {
    venta,
    items,
    resumen_fiscal: buildResumenFiscalVenta(venta, items)
  };
}

module.exports = {
  buildDetalleVentaSnapshotFiscal,
  buildResumenFiscalVenta,
  getPagoCuentaCorrienteTotal,
  getVentaConDetalle,
  getVentaCuentaCorrienteSnapshot,
  getVentaDetalleRows,
  refreshCuentaCorrienteSaldo,
  replaceVentaDetalle,
  resolveCobroData
};
