const { allQuery, getQuery, runQuery } = require("../db");

const CUENTAS_DESTINO_DEFAULTS = [
  { nombre: "Caja efectivo", tipo_destino: "efectivo", orden: 10 },
  { nombre: "Mercado Pago", tipo_destino: "billetera", orden: 20 }
];

const TIPOS_DESTINO_VALIDOS = new Set(["efectivo", "banco", "billetera", "otro"]);

function normalizarTexto(valor) {
  return String(valor || "").trim();
}

function normalizarActivo(valor, fallback = 1) {
  if (valor === undefined || valor === null || valor === "") return fallback;
  return valor === false || valor === 0 || valor === "0" ? 0 : 1;
}

function normalizarTipoDestino(valor) {
  const tipo = normalizarTexto(valor).toLowerCase();
  return TIPOS_DESTINO_VALIDOS.has(tipo) ? tipo : "otro";
}

function normalizarPayload(payload = {}) {
  return {
    nombre: normalizarTexto(payload.nombre),
    tipo_destino: normalizarTipoDestino(payload.tipo_destino),
    alias: normalizarTexto(payload.alias),
    cbu_cvu: normalizarTexto(payload.cbu_cvu),
    activo: normalizarActivo(payload.activo, 1),
    orden: Number(payload.orden) || 0
  };
}

function validarPayload(data) {
  if (!data.nombre) return "El nombre es obligatorio";
  if (!TIPOS_DESTINO_VALIDOS.has(data.tipo_destino)) return "Tipo de destino invalido";
  return null;
}

async function seedCuentasDestinoDefaults() {
  for (const cuenta of CUENTAS_DESTINO_DEFAULTS) {
    const existente = await getQuery(
      "SELECT id FROM cuentas_destino WHERE lower(nombre) = lower(?) LIMIT 1",
      [cuenta.nombre]
    );
    if (existente) continue;
    await runQuery(
      `INSERT INTO cuentas_destino
       (nombre, tipo_destino, alias, cbu_cvu, activo, orden, created_at, updated_at)
       VALUES (?, ?, '', '', 1, ?, datetime('now'), datetime('now'))`,
      [cuenta.nombre, cuenta.tipo_destino, cuenta.orden]
    );
  }
}

async function listarCuentasDestino({ todos = false } = {}) {
  return allQuery(
    `SELECT id, nombre, tipo_destino, alias, cbu_cvu, activo, orden, created_at, updated_at
     FROM cuentas_destino
     ${todos ? "" : "WHERE activo = 1"}
     ORDER BY orden ASC, nombre ASC`
  );
}

async function obtenerCuentaDestino(id) {
  return getQuery(
    `SELECT id, nombre, tipo_destino, alias, cbu_cvu, activo, orden, created_at, updated_at
     FROM cuentas_destino
     WHERE id = ?`,
    [Number(id)]
  );
}

async function crearCuentaDestino(payload) {
  const data = normalizarPayload(payload);
  const error = validarPayload(data);
  if (error) {
    const err = new Error(error);
    err.statusCode = 400;
    throw err;
  }

  const result = await runQuery(
    `INSERT INTO cuentas_destino
     (nombre, tipo_destino, alias, cbu_cvu, activo, orden, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [data.nombre, data.tipo_destino, data.alias, data.cbu_cvu, data.activo, data.orden]
  );

  return obtenerCuentaDestino(result.lastID);
}

async function actualizarCuentaDestino(id, payload) {
  const data = normalizarPayload(payload);
  const error = validarPayload(data);
  if (error) {
    const err = new Error(error);
    err.statusCode = 400;
    throw err;
  }

  await runQuery(
    `UPDATE cuentas_destino
     SET nombre = ?, tipo_destino = ?, alias = ?, cbu_cvu = ?, activo = ?, orden = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [data.nombre, data.tipo_destino, data.alias, data.cbu_cvu, data.activo, data.orden, Number(id)]
  );

  return obtenerCuentaDestino(id);
}

async function setActivoCuentaDestino(id, activo) {
  await runQuery(
    "UPDATE cuentas_destino SET activo = ?, updated_at = datetime('now') WHERE id = ?",
    [normalizarActivo(activo, 1), Number(id)]
  );
  return obtenerCuentaDestino(id);
}

async function eliminarCuentaDestino(id) {
  const idNum = Number(id);
  const cuenta = await obtenerCuentaDestino(idNum);
  if (!cuenta) {
    const err = new Error("Cuenta destino no encontrada");
    err.statusCode = 404;
    throw err;
  }

  const uso = await getQuery(
    `SELECT
      (SELECT COUNT(*) FROM cuentas_cobro                   WHERE cuenta_destino_id = ?) +
      (SELECT COUNT(*) FROM conciliaciones_cuentas_destino  WHERE cuenta_destino_id = ?) +
      (SELECT COUNT(*) FROM venta_cobros                    WHERE cuenta_destino_id_snapshot = ?) +
      (SELECT COUNT(*) FROM pagos_cc_cobros                 WHERE cuenta_destino_id_snapshot = ?) AS total`,
    [idNum, idNum, idNum, idNum]
  );

  if (Number(uso?.total || 0) === 0) {
    await runQuery("DELETE FROM cuentas_destino WHERE id = ?", [idNum]);
    return { eliminado: true, desactivado: false, message: "Cuenta destino eliminada" };
  }

  await runQuery("UPDATE cuentas_destino SET activo = 0, updated_at = datetime('now') WHERE id = ?", [idNum]);

  const canalesAfectados = await getQuery(
    "SELECT COUNT(*) AS total FROM cuentas_cobro WHERE cuenta_destino_id = ? AND activo = 1",
    [idNum]
  );

  return {
    eliminado: false,
    desactivado: true,
    canales_afectados: Number(canalesAfectados?.total || 0),
    requiere_snapshot_futuro: false,
    message: "La cuenta destino tiene movimientos históricos. Se desactivó para conservar la trazabilidad."
  };
}

module.exports = {
  seedCuentasDestinoDefaults,
  listarCuentasDestino,
  obtenerCuentaDestino,
  crearCuentaDestino,
  actualizarCuentaDestino,
  setActivoCuentaDestino,
  eliminarCuentaDestino
};
