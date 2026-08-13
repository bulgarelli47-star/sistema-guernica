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

function normalizarAlicuota(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return round2(number);
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
  round2,
  normalizarCompra,
  normalizarComprobanteCompra,
  buildResumenIvaComprobante
};
