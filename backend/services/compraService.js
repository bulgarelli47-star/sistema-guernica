const TIPOS_COMPROBANTE_COMPRA = Object.freeze([
  "factura_a",
  "factura_b",
  "factura_c",
  "ticket",
  "recibo",
  "nota_credito",
  "nota_debito",
  "otro"
]);

const ESTADOS_COMPRA = Object.freeze(["pendiente", "parcial", "saldada", "anulada"]);
const ESTADOS_COMPROBANTE_COMPRA = Object.freeze(["registrado", "anulado"]);
const MONTO_TOLERANCIA = 0.01;
const CANTIDAD_TOLERANCIA = 0.0001;

function round2(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round((number + Number.EPSILON) * 100) / 100;
}

function normalizarTexto(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function normalizarImporte(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return round2(number);
}

function round4(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round((number + Number.EPSILON) * 10000) / 10000;
}

function calcularEstadoCompra({ total_compra, total_pagado, estado_actual } = {}) {
  if (String(estado_actual || "").trim().toLowerCase() === "anulada") {
    return "anulada";
  }
  const total = normalizarImporte(total_compra);
  const pagado = normalizarImporte(total_pagado);
  const saldo = Math.max(0, round2(total - pagado));
  if (saldo <= 0) return "saldada";
  if (pagado > 0) return "parcial";
  return "pendiente";
}

async function getTotalPagadoCompra(compraId, { getQuery }) {
  const row = await getQuery(
    "SELECT COALESCE(SUM(monto_total), 0) AS total_pagado FROM pagos WHERE compra_id = ?",
    [compraId]
  );
  return round2(row?.total_pagado || 0);
}

async function refreshCompraSaldo(compraId, { getQuery, runQuery }) {
  const compra = await getQuery("SELECT * FROM compras WHERE id = ?", [compraId]);
  if (!compra) return null;
  const totalPagado = await getTotalPagadoCompra(compraId, { getQuery });
  const saldoPendiente = Math.max(0, round2(Number(compra.total_compra || 0) - totalPagado));
  const estado = calcularEstadoCompra({
    total_compra: compra.total_compra,
    total_pagado: totalPagado,
    estado_actual: compra.estado
  });
  await runQuery(
    "UPDATE compras SET saldo_pendiente = ?, estado = ?, updated_at = datetime('now') WHERE id = ?",
    [saldoPendiente, estado, compraId]
  );
  return {
    ...compra,
    total_pagado: totalPagado,
    saldo_pendiente: saldoPendiente,
    estado
  };
}

function normalizarAlicuota(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return round2(number);
}

function normalizarCompraItem(input = {}, producto = null) {
  const productoId = input.producto_id === undefined || input.producto_id === null || input.producto_id === ""
    ? null
    : Number(input.producto_id);
  const cantidadComprada = round4(Number(input.cantidad_comprada));
  const costoUnitario = normalizarImporte(input.costo_unitario);
  const subtotalCalculado = round2(cantidadComprada * costoUnitario);
  const tieneSubtotalExplicito = input.subtotal !== undefined && input.subtotal !== null && input.subtotal !== "";
  const subtotal = tieneSubtotalExplicito ? normalizarImporte(input.subtotal) : subtotalCalculado;
  const afectaStockSolicitado = Number(input.afecta_stock || 0) === 1;
  const descripcion = normalizarTexto(
    input.descripcion_snapshot,
    normalizarTexto(producto?.nombre, "Item de compra")
  );
  const unidadSnapshot = normalizarTexto(
    input.unidad_snapshot,
    productoId ? normalizarTexto(producto?.unidad_medida, null) : null
  );
  const errores = [];

  if (!(cantidadComprada > 0)) errores.push("cantidad_comprada debe ser mayor a cero");
  if (costoUnitario < 0) errores.push("costo_unitario no puede ser negativo");
  if (!descripcion) errores.push("descripcion_snapshot es obligatoria");
  if (productoId === null && afectaStockSolicitado) {
    errores.push("producto_id es obligatorio cuando afecta_stock = 1");
  }

  let afectaStock = afectaStockSolicitado ? 1 : 0;
  if (productoId === null) {
    afectaStock = 0;
  }

  if (afectaStock === 1) {
    if (!producto) {
      errores.push("producto requerido para validar afecta_stock");
    } else {
      const tipo = String(producto.tipo || "simple").trim().toLowerCase();
      const manejaStock = Number(producto.maneja_stock ?? 1) === 1;
      if (tipo === "compuesto" && !manejaStock) {
        errores.push("producto compuesto sin stock propio no puede recibirse directamente");
      }
      if (!manejaStock) {
        errores.push("producto no maneja stock");
      }
    }
  }

  const diferenciaSubtotal = round2(subtotal - subtotalCalculado);
  const subtotalConsistente = Math.abs(diferenciaSubtotal) <= MONTO_TOLERANCIA;
  if (!subtotalConsistente) {
    errores.push("subtotal no coincide con cantidad_comprada * costo_unitario");
  }

  return {
    compra_id: Number(input.compra_id || 0),
    producto_id: productoId,
    descripcion_snapshot: descripcion,
    cantidad_comprada: cantidadComprada,
    unidad_snapshot: unidadSnapshot,
    costo_unitario: costoUnitario,
    subtotal,
    afecta_stock: afectaStock,
    observaciones: normalizarTexto(input.observaciones),
    subtotal_calculado: subtotalCalculado,
    diferencia_subtotal: diferenciaSubtotal,
    subtotal_consistente: subtotalConsistente,
    apto_recepcion: afectaStock === 1 && errores.length === 0,
    validacion: {
      ok: errores.length === 0,
      errores
    }
  };
}

function buildResumenItemsCompra(compra = {}, items = []) {
  const subtotalItems = round2((Array.isArray(items) ? items : [])
    .reduce((total, item) => total + normalizarImporte(item?.subtotal), 0));
  const totalCompra = normalizarImporte(compra.total_compra);
  const diferencia = round2(totalCompra - subtotalItems);
  return {
    subtotal_items: subtotalItems,
    total_compra: totalCompra,
    diferencia_compra_items: diferencia,
    cierre_items_consistente: Math.abs(diferencia) <= MONTO_TOLERANCIA,
    cantidad_items: Array.isArray(items) ? items.length : 0
  };
}

function esRecepcionActiva(recepcion = {}) {
  return String(recepcion.estado || "registrada").trim().toLowerCase() !== "anulada";
}

function buildResumenRecepcionItem(item = {}, recepciones = []) {
  const cantidadComprada = round4(Number(item.cantidad_comprada || 0));
  const cantidadRecibida = round4((Array.isArray(recepciones) ? recepciones : [])
    .filter(esRecepcionActiva)
    .filter((recepcion) => {
      if (recepcion.compra_item_id == null || item.id == null) return true;
      return Number(recepcion.compra_item_id) === Number(item.id);
    })
    .reduce((total, recepcion) => total + Number(recepcion.cantidad_recibida || 0), 0));
  const cantidadPendiente = Math.max(0, round4(cantidadComprada - cantidadRecibida));
  const estadoRecepcion = cantidadRecibida <= CANTIDAD_TOLERANCIA
    ? "pendiente"
    : cantidadPendiente <= CANTIDAD_TOLERANCIA
      ? "completa"
      : "parcial";

  return {
    cantidad_comprada: cantidadComprada,
    cantidad_recibida: cantidadRecibida,
    cantidad_pendiente: cantidadPendiente,
    estado_recepcion: estadoRecepcion
  };
}

function validarCantidadRecepcion(item = {}, recepciones = [], cantidadNueva = 0, compra = {}) {
  const cantidad = round4(Number(cantidadNueva || 0));
  const resumen = buildResumenRecepcionItem(item, recepciones);
  const errores = [];

  if (String(compra.estado || "").trim().toLowerCase() === "anulada") {
    errores.push("la compra anulada no admite recepciones");
  }
  if (Number(item.afecta_stock || 0) !== 1) {
    errores.push("el item no afecta stock y no puede recibirse fisicamente");
  }
  if (!(cantidad > 0)) {
    errores.push("la cantidad recibida debe ser mayor a cero");
  }
  if (round4(resumen.cantidad_recibida + cantidad) > round4(resumen.cantidad_comprada + CANTIDAD_TOLERANCIA)) {
    errores.push("la recepcion supera la cantidad comprada");
  }

  return {
    ok: errores.length === 0,
    errores,
    cantidad_nueva: cantidad,
    cantidad_recibida_actual: resumen.cantidad_recibida,
    cantidad_recibida_resultante: round4(resumen.cantidad_recibida + cantidad),
    cantidad_comprada: resumen.cantidad_comprada
  };
}

function normalizarCompra(input = {}) {
  const estado = normalizarTexto(input.estado, "pendiente");
  return {
    proveedor_id: Number(input.proveedor_id || 0),
    fecha_compra: normalizarTexto(input.fecha_compra),
    hora: normalizarTexto(input.hora),
    concepto: normalizarTexto(input.concepto),
    tipo_impacto: normalizarTexto(input.tipo_impacto, "otro_no_computable"),
    moneda: normalizarTexto(input.moneda, "ARS"),
    total_compra: normalizarImporte(input.total_compra),
    saldo_pendiente: normalizarImporte(input.saldo_pendiente),
    estado: ESTADOS_COMPRA.includes(estado) ? estado : "pendiente",
    observaciones: normalizarTexto(input.observaciones),
    usuario: normalizarTexto(input.usuario),
    created_at: normalizarTexto(input.created_at),
    updated_at: normalizarTexto(input.updated_at)
  };
}

function snapshotProveedorComprobante(proveedor = {}) {
  return {
    proveedor_nombre_snapshot: normalizarTexto(proveedor.nombre),
    proveedor_cuit_snapshot: normalizarTexto(proveedor.cuit),
    condicion_iva_proveedor_snapshot: normalizarTexto(proveedor.condicion_iva)
  };
}

function normalizarComprobanteCompra(input = {}, proveedor = null) {
  const tipo = normalizarTexto(input.tipo_comprobante, "otro");
  const estado = normalizarTexto(input.estado, "registrado");
  const proveedorSnapshot = proveedor ? snapshotProveedorComprobante(proveedor) : {};
  return {
    compra_id: Number(input.compra_id || 0),
    tipo_comprobante: TIPOS_COMPROBANTE_COMPRA.includes(tipo) ? tipo : "otro",
    punto_venta: normalizarTexto(input.punto_venta),
    numero_comprobante: normalizarTexto(input.numero_comprobante),
    fecha_emision: normalizarTexto(input.fecha_emision),
    fecha_recepcion: normalizarTexto(input.fecha_recepcion),
    proveedor_nombre_snapshot: normalizarTexto(input.proveedor_nombre_snapshot, proveedorSnapshot.proveedor_nombre_snapshot),
    proveedor_cuit_snapshot: normalizarTexto(input.proveedor_cuit_snapshot, proveedorSnapshot.proveedor_cuit_snapshot),
    condicion_iva_proveedor_snapshot: normalizarTexto(input.condicion_iva_proveedor_snapshot, proveedorSnapshot.condicion_iva_proveedor_snapshot),
    moneda: normalizarTexto(input.moneda, "ARS"),
    neto_gravado: input.neto_gravado === undefined || input.neto_gravado === null ? null : normalizarImporte(input.neto_gravado),
    iva_total: input.iva_total === undefined || input.iva_total === null ? null : normalizarImporte(input.iva_total),
    monto_exento: normalizarImporte(input.monto_exento),
    monto_no_gravado: normalizarImporte(input.monto_no_gravado),
    otros_tributos: normalizarImporte(input.otros_tributos),
    total_comprobante: normalizarImporte(input.total_comprobante),
    estado: ESTADOS_COMPROBANTE_COMPRA.includes(estado) ? estado : "registrado",
    observaciones: normalizarTexto(input.observaciones),
    created_at: normalizarTexto(input.created_at),
    updated_at: normalizarTexto(input.updated_at)
  };
}

function normalizarAlicuotasComprobante(alicuotas = []) {
  return (Array.isArray(alicuotas) ? alicuotas : [])
    .map((item) => ({
      alicuota: normalizarAlicuota(item?.alicuota),
      neto_gravado: normalizarImporte(item?.neto_gravado),
      iva_monto: normalizarImporte(item?.iva_monto)
    }))
    .sort((a, b) => a.alicuota - b.alicuota);
}

function buildResumenIvaComprobante(comprobante = {}, alicuotas = []) {
  const buckets = normalizarAlicuotasComprobante(alicuotas);
  const netoGravadoCalculado = round2(buckets.reduce((total, item) => total + item.neto_gravado, 0));
  const ivaTotalCalculado = round2(buckets.reduce((total, item) => total + item.iva_monto, 0));
  const montoExento = normalizarImporte(comprobante.monto_exento);
  const montoNoGravado = normalizarImporte(comprobante.monto_no_gravado);
  const otrosTributos = normalizarImporte(comprobante.otros_tributos);
  const totalComprobante = normalizarImporte(comprobante.total_comprobante);
  const totalComponentes = round2(netoGravadoCalculado + ivaTotalCalculado + montoExento + montoNoGravado + otrosTributos);
  const diferencia = round2(totalComprobante - totalComponentes);

  return {
    neto_gravado_calculado: netoGravadoCalculado,
    iva_total_calculado: ivaTotalCalculado,
    monto_exento: montoExento,
    monto_no_gravado: montoNoGravado,
    otros_tributos: otrosTributos,
    total_componentes: totalComponentes,
    total_comprobante: totalComprobante,
    diferencia,
    cierre_consistente: Math.abs(diferencia) <= 0.01,
    alicuotas: buckets
  };
}

module.exports = {
  TIPOS_COMPROBANTE_COMPRA,
  ESTADOS_COMPRA,
  ESTADOS_COMPROBANTE_COMPRA,
  MONTO_TOLERANCIA,
  CANTIDAD_TOLERANCIA,
  round2,
  round4,
  calcularEstadoCompra,
  getTotalPagadoCompra,
  refreshCompraSaldo,
  normalizarCompra,
  normalizarCompraItem,
  normalizarComprobanteCompra,
  buildResumenIvaComprobante,
  buildResumenItemsCompra,
  buildResumenRecepcionItem,
  validarCantidadRecepcion
};
