const { allQuery, runQuery } = require("../db");
const { resolveCobroData } = require("./ventaService");

const TIPOS_PAGO_DEFAULTS = [
  {
    codigo: "efectivo",
    nombre: "Efectivo",
    activo: 1,
    impacta_caja: 1,
    impacta_digital: 0,
    permite_mixto: 0,
    requiere_caja_abierta: 1,
    orden: 10,
    usa_recargo: 0,
    porcentaje_recargo: 0,
    permite_cuotas: 0,
    cuotas_json: null
  },
  {
    codigo: "debito",
    nombre: "Debito",
    activo: 1,
    impacta_caja: 0,
    impacta_digital: 1,
    permite_mixto: 0,
    requiere_caja_abierta: 1,
    orden: 20,
    usa_recargo: 0,
    porcentaje_recargo: 0,
    permite_cuotas: 0,
    cuotas_json: null
  },
  {
    codigo: "transferencia",
    nombre: "Transferencia",
    activo: 1,
    impacta_caja: 0,
    impacta_digital: 1,
    permite_mixto: 0,
    requiere_caja_abierta: 1,
    orden: 30,
    usa_recargo: 0,
    porcentaje_recargo: 0,
    permite_cuotas: 0,
    cuotas_json: null
  },
  {
    codigo: "mixto",
    nombre: "Mixto",
    activo: 1,
    impacta_caja: 1,
    impacta_digital: 1,
    permite_mixto: 1,
    requiere_caja_abierta: 1,
    orden: 40,
    usa_recargo: 0,
    porcentaje_recargo: 0,
    permite_cuotas: 0,
    cuotas_json: null
  }
];

const TIPOS_PAGO_SELECT = `
  SELECT id, codigo, nombre, activo, impacta_caja, impacta_digital, permite_mixto, requiere_caja_abierta, orden,
         COALESCE(usa_recargo, 0) AS usa_recargo,
         COALESCE(porcentaje_recargo, 0) AS porcentaje_recargo,
         COALESCE(permite_cuotas, 0) AS permite_cuotas,
         cuotas_json
  FROM tipos_pago
`;

async function seedTiposPagoDefaults() {
  for (const tipo of TIPOS_PAGO_DEFAULTS) {
    await runQuery(
      `INSERT INTO tipos_pago
       (codigo, nombre, activo, impacta_caja, impacta_digital, permite_mixto, requiere_caja_abierta, orden,
        usa_recargo, porcentaje_recargo, permite_cuotas, cuotas_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(codigo) DO NOTHING`,
      [
        tipo.codigo,
        tipo.nombre,
        tipo.activo,
        tipo.impacta_caja,
        tipo.impacta_digital,
        tipo.permite_mixto,
        tipo.requiere_caja_abierta,
        tipo.orden,
        tipo.usa_recargo,
        tipo.porcentaje_recargo,
        tipo.permite_cuotas,
        tipo.cuotas_json
      ]
    );
  }
}

async function getTiposPagoActivos() {
  try {
    const tipos = await allQuery(
      `${TIPOS_PAGO_SELECT}
       WHERE activo = 1
       ORDER BY orden ASC, nombre ASC`
    );

    if (tipos.length) {
      return tipos;
    }
  } catch (error) {
    return TIPOS_PAGO_DEFAULTS.filter((tipo) => Number(tipo.activo) === 1);
  }

  return TIPOS_PAGO_DEFAULTS.filter((tipo) => Number(tipo.activo) === 1);
}

async function getTodosTiposPago() {
  try {
    const tipos = await allQuery(
      `${TIPOS_PAGO_SELECT}
       ORDER BY orden ASC, nombre ASC`
    );
    return tipos.length ? tipos : TIPOS_PAGO_DEFAULTS;
  } catch {
    return TIPOS_PAGO_DEFAULTS;
  }
}

function normalizarCuotasJson(cuotasJson) {
  if (cuotasJson == null || cuotasJson === "") return null;
  const parsed = typeof cuotasJson === "string" ? JSON.parse(cuotasJson) : cuotasJson;
  if (!Array.isArray(parsed)) throw new Error("cuotas_json debe ser un array");
  const cuotas = parsed
    .map((item) => ({
      cuotas: Math.max(1, Math.trunc(Number(item?.cuotas) || 0)),
      recargo: Math.max(0, Number(item?.recargo) || 0)
    }))
    .filter((item) => item.cuotas > 0)
    .sort((a, b) => a.cuotas - b.cuotas);
  return cuotas.length ? JSON.stringify(cuotas) : null;
}

function normalizarTipoPagoPayload(payload = {}) {
  const usaRecargo = payload.usa_recargo === true || payload.usa_recargo === 1 || payload.usa_recargo === "1";
  const permiteCuotas = payload.permite_cuotas === true || payload.permite_cuotas === 1 || payload.permite_cuotas === "1";
  const porcentajeRecargo = usaRecargo ? Math.max(0, Number(payload.porcentaje_recargo) || 0) : 0;
  return {
    usa_recargo: usaRecargo ? 1 : 0,
    porcentaje_recargo: Number(porcentajeRecargo.toFixed(2)),
    permite_cuotas: permiteCuotas ? 1 : 0,
    cuotas_json: permiteCuotas ? normalizarCuotasJson(payload.cuotas_json) : null
  };
}

async function crearTipoPago({ codigo, nombre, orden, usa_recargo, porcentaje_recargo, permite_cuotas, cuotas_json }) {
  const recargo = normalizarTipoPagoPayload({ usa_recargo, porcentaje_recargo, permite_cuotas, cuotas_json });
  await runQuery(
    `INSERT INTO tipos_pago
     (codigo, nombre, activo, impacta_caja, impacta_digital, permite_mixto, requiere_caja_abierta, orden,
      usa_recargo, porcentaje_recargo, permite_cuotas, cuotas_json)
     VALUES (?, ?, 1, 0, 1, 0, 1, ?, ?, ?, ?, ?)`,
    [codigo, nombre, Number(orden) || 50, recargo.usa_recargo, recargo.porcentaje_recargo, recargo.permite_cuotas, recargo.cuotas_json]
  );
}

async function actualizarTipoPago(id, { nombre, orden, usa_recargo, porcentaje_recargo, permite_cuotas, cuotas_json }) {
  const recargo = normalizarTipoPagoPayload({ usa_recargo, porcentaje_recargo, permite_cuotas, cuotas_json });
  await runQuery(
    `UPDATE tipos_pago
     SET nombre = ?, orden = ?, usa_recargo = ?, porcentaje_recargo = ?, permite_cuotas = ?, cuotas_json = ?
     WHERE id = ?`,
    [nombre, Number(orden) || 0, recargo.usa_recargo, recargo.porcentaje_recargo, recargo.permite_cuotas, recargo.cuotas_json, id]
  );
}

async function toggleActivoTipoPago(id, activo) {
  await runQuery(
    `UPDATE tipos_pago SET activo = ? WHERE id = ?`,
    [activo ? 1 : 0, id]
  );
}

async function eliminarTipoPago(id) {
  await runQuery(`DELETE FROM tipos_pago WHERE id = ?`, [id]);
}

function resolvePagoData(total, tipoPago, montoEfectivo, montoDebito) {
  return resolveCobroData(total, tipoPago, montoEfectivo, montoDebito);
}

async function getTipoPagoPorCodigo(codigo, { todos = false } = {}) {
  const normalized = String(codigo || "").trim().toLowerCase();
  if (!normalized) return null;
  try {
    return await allQuery(
      `${TIPOS_PAGO_SELECT}
       WHERE codigo = ? ${todos ? "" : "AND activo = 1"}
       LIMIT 1`,
      [normalized]
    ).then((rows) => rows[0] || null);
  } catch {
    return TIPOS_PAGO_DEFAULTS.find((tipo) => tipo.codigo === normalized && (todos || Number(tipo.activo) === 1)) || null;
  }
}

function parseCuotasConfig(cuotasJson) {
  try {
    const parsed = typeof cuotasJson === "string" ? JSON.parse(cuotasJson || "[]") : cuotasJson;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function calcularRecargoTipoPago({ tipoPagoCodigo, subtotal, cuotas }) {
  const tipo = await getTipoPagoPorCodigo(tipoPagoCodigo);
  if (!tipo) {
    return { ok: false, message: "Metodo de cobro invalido" };
  }

  const subtotalNormalizado = Number((Number(subtotal) || 0).toFixed(2));
  let porcentaje = Number(tipo.usa_recargo) === 1 ? Number(tipo.porcentaje_recargo || 0) : 0;
  let cuotasAplicadas = null;

  if (Number(tipo.permite_cuotas) === 1) {
    const cuotasSolicitadas = Math.trunc(Number(cuotas) || 0);
    const configCuotas = parseCuotasConfig(tipo.cuotas_json);
    const cuota = configCuotas.find((item) => Number(item.cuotas) === cuotasSolicitadas);
    if (cuota) {
      porcentaje = Number(cuota.recargo || 0);
      cuotasAplicadas = cuotasSolicitadas;
    }
  }

  const recargoMonto = Number((subtotalNormalizado * Math.max(0, porcentaje) / 100).toFixed(2));
  return {
    ok: true,
    tipo,
    subtotal: subtotalNormalizado,
    porcentaje_recargo: Number(Math.max(0, porcentaje).toFixed(2)),
    recargo_monto: recargoMonto,
    cuotas: cuotasAplicadas,
    total: Number((subtotalNormalizado + recargoMonto).toFixed(2))
  };
}

module.exports = {
  TIPOS_PAGO_DEFAULTS,
  calcularRecargoTipoPago,
  getTiposPagoActivos,
  getTodosTiposPago,
  getTipoPagoPorCodigo,
  crearTipoPago,
  actualizarTipoPago,
  eliminarTipoPago,
  toggleActivoTipoPago,
  resolvePagoData,
  seedTiposPagoDefaults
};
