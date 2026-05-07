const { getQuery } = require("../db");

const PROVEEDOR_IMPACTOS = new Set([
  "costo_fijo_operativo",
  "costo_variable_mercaderia",
  "inversion",
  "otro_no_computable"
]);
const PROVEEDOR_CONDICIONES_IVA = new Set(["responsable_inscripto", "monotributo", "exento", "consumidor_final", "no_informado"]);
const PROVEEDOR_COMPROBANTES = new Set(["factura_a", "factura_b", "factura_c", "recibo_x", "otro"]);

function parseProveedorPayload(body) {
  const condicionRaw = String(body.condicion_iva || "").trim().toLowerCase();
  const comprobanteRaw = String(body.tipo_comprobante || "").trim().toLowerCase();
  const condicionNormalizada = condicionRaw.includes("responsable") || condicionRaw === "ri" ? "responsable_inscripto" : condicionRaw;
  const comprobanteNormalizado = comprobanteRaw.includes("fact") && comprobanteRaw.endsWith("a") ? "factura_a"
    : comprobanteRaw.includes("fact") && comprobanteRaw.endsWith("b") ? "factura_b"
      : comprobanteRaw.includes("fact") && comprobanteRaw.endsWith("c") ? "factura_c"
        : comprobanteRaw.includes("rec") ? "recibo_x"
          : comprobanteRaw;
  return {
    nombre: String(body.nombre || "").trim(),
    alias: String(body.alias || "").trim(),
    cuit: String(body.cuit || "").trim(),
    tipo_persona: String(body.tipo_persona || "juridica").trim().toLowerCase(),
    telefono: String(body.telefono || "").trim(),
    email: String(body.email || "").trim(),
    contacto: String(body.contacto || "").trim(),
    direccion: String(body.direccion || "").trim(),
    localidad: String(body.localidad || "").trim(),
    codigo_postal: String(body.codigo_postal || "").trim(),
    observaciones: String(body.observaciones || "").trim(),
    maneja_cuenta_corriente: body.maneja_cuenta_corriente ? 1 : 0,
    limite_credito: Math.max(0, Number(body.limite_credito) || 0),
    dias_vencimiento: Math.max(0, Number(body.dias_vencimiento) || 0),
    dia_vencimiento_fijo: body.dia_vencimiento_fijo ? Number(body.dia_vencimiento_fijo) : null,
    moneda: String(body.moneda || "ARS").trim().toUpperCase(),
    tipo_impacto: PROVEEDOR_IMPACTOS.has(String(body.tipo_impacto || "").trim().toLowerCase())
      ? String(body.tipo_impacto).trim().toLowerCase()
      : "otro_no_computable",
    categoria_id: body.categoria_id ? Number(body.categoria_id) : null,
    categoria_especial: String(body.categoria_especial || "").trim(),
    condicion_iva: PROVEEDOR_CONDICIONES_IVA.has(condicionNormalizada) ? condicionNormalizada : "responsable_inscripto",
    tipo_comprobante: PROVEEDOR_COMPROBANTES.has(comprobanteNormalizado) ? comprobanteNormalizado : "factura_a",
    iva_alicuota: Math.max(0, Number(body.iva_alicuota) || 21),
    activo: body.activo === false || Number(body.activo) === 0 ? 0 : 1
  };
}

function calcularIvaCreditoFiscal(montoTotal, proveedor) {
  const condicion = String(proveedor?.condicion_iva || "").trim().toLowerCase();
  const comprobante = String(proveedor?.tipo_comprobante || "").trim().toLowerCase();
  const alicuota = Math.max(0, Number(proveedor?.iva_alicuota) || 0);
  if (condicion !== "responsable_inscripto" || comprobante !== "factura_a" || alicuota <= 0) return 0;
  return Number((Number(montoTotal || 0) * alicuota / (100 + alicuota)).toFixed(2));
}

async function getProveedorConMetricas(proveedorId) {
  return getQuery(
    `SELECT p.*, cat.nombre AS categoria_nombre,
            COALESCE(stats.pagos_mes, 0) AS pagos_mes,
            COALESCE(stats.compras_mes, 0) AS compras_mes,
            COALESCE(stats.compras_anio, 0) AS compras_anio,
            COALESCE(stats.saldo_pendiente, 0) AS saldo_pendiente,
            stats.ultima_compra AS ultima_compra
     FROM proveedores p
     LEFT JOIN categorias cat ON cat.id = p.categoria_id
     LEFT JOIN (
       SELECT proveedor_id,
              SUM(CASE WHEN estado != 'pendiente' AND strftime('%Y-%m', fecha) = strftime('%Y-%m', 'now', 'localtime') THEN monto_total ELSE 0 END) AS pagos_mes,
              SUM(CASE WHEN strftime('%Y-%m', fecha) = strftime('%Y-%m', 'now', 'localtime') THEN monto_total ELSE 0 END) AS compras_mes,
              SUM(CASE WHEN strftime('%Y', fecha) = strftime('%Y', 'now', 'localtime') THEN monto_total ELSE 0 END) AS compras_anio,
              SUM(CASE WHEN estado = 'pendiente' THEN monto_total ELSE 0 END) AS saldo_pendiente,
              MAX(fecha) AS ultima_compra
       FROM pagos
       WHERE proveedor_id IS NOT NULL
       GROUP BY proveedor_id
     ) stats ON stats.proveedor_id = p.id
     WHERE p.id = ?`,
    [proveedorId]
  );
}

module.exports = {
  PROVEEDOR_COMPROBANTES,
  PROVEEDOR_CONDICIONES_IVA,
  PROVEEDOR_IMPACTOS,
  calcularIvaCreditoFiscal,
  getProveedorConMetricas,
  parseProveedorPayload
};
