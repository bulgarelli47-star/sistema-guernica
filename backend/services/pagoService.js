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
    orden: 10
  },
  {
    codigo: "debito",
    nombre: "Debito",
    activo: 1,
    impacta_caja: 0,
    impacta_digital: 1,
    permite_mixto: 0,
    requiere_caja_abierta: 1,
    orden: 20
  },
  {
    codigo: "transferencia",
    nombre: "Transferencia",
    activo: 1,
    impacta_caja: 0,
    impacta_digital: 1,
    permite_mixto: 0,
    requiere_caja_abierta: 1,
    orden: 30
  },
  {
    codigo: "mixto",
    nombre: "Mixto",
    activo: 1,
    impacta_caja: 1,
    impacta_digital: 1,
    permite_mixto: 1,
    requiere_caja_abierta: 1,
    orden: 40
  }
];

async function seedTiposPagoDefaults() {
  for (const tipo of TIPOS_PAGO_DEFAULTS) {
    await runQuery(
      `INSERT INTO tipos_pago
       (codigo, nombre, activo, impacta_caja, impacta_digital, permite_mixto, requiere_caja_abierta, orden)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(codigo) DO NOTHING`,
      [
        tipo.codigo,
        tipo.nombre,
        tipo.activo,
        tipo.impacta_caja,
        tipo.impacta_digital,
        tipo.permite_mixto,
        tipo.requiere_caja_abierta,
        tipo.orden
      ]
    );
  }
}

async function getTiposPagoActivos() {
  try {
    const tipos = await allQuery(
      `SELECT id, codigo, nombre, activo, impacta_caja, impacta_digital, permite_mixto, requiere_caja_abierta, orden
       FROM tipos_pago
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
      `SELECT id, codigo, nombre, activo, impacta_caja, impacta_digital, permite_mixto, requiere_caja_abierta, orden
       FROM tipos_pago
       ORDER BY orden ASC, nombre ASC`
    );
    return tipos.length ? tipos : TIPOS_PAGO_DEFAULTS;
  } catch {
    return TIPOS_PAGO_DEFAULTS;
  }
}

async function crearTipoPago({ codigo, nombre, orden }) {
  await runQuery(
    `INSERT INTO tipos_pago (codigo, nombre, activo, impacta_caja, impacta_digital, permite_mixto, requiere_caja_abierta, orden)
     VALUES (?, ?, 1, 0, 1, 0, 1, ?)`,
    [codigo, nombre, Number(orden) || 50]
  );
}

async function actualizarTipoPago(id, { nombre, orden }) {
  await runQuery(
    `UPDATE tipos_pago SET nombre = ?, orden = ? WHERE id = ?`,
    [nombre, Number(orden) || 0, id]
  );
}

async function toggleActivoTipoPago(id, activo) {
  await runQuery(
    `UPDATE tipos_pago SET activo = ? WHERE id = ?`,
    [activo ? 1 : 0, id]
  );
}

function resolvePagoData(total, tipoPago, montoEfectivo, montoDebito) {
  return resolveCobroData(total, tipoPago, montoEfectivo, montoDebito);
}

module.exports = {
  TIPOS_PAGO_DEFAULTS,
  getTiposPagoActivos,
  getTodosTiposPago,
  crearTipoPago,
  actualizarTipoPago,
  toggleActivoTipoPago,
  resolvePagoData,
  seedTiposPagoDefaults
};
