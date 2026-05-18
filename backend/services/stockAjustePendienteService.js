const { allQuery, getQuery, runQuery } = require("../db");

const TIPOS_MOVIMIENTO_VALIDOS = new Set(["ingreso", "egreso"]);
const ESTADOS_VALIDOS = new Set(["pendiente", "aprobado", "rechazado", "corregido"]);

function normalizarTexto(valor) {
  return String(valor || "").trim();
}

function normalizarId(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) && numero > 0 ? numero : null;
}

function getNowParts() {
  const now = new Date();
  return {
    fecha: now.toISOString().slice(0, 10),
    hora: now.toTimeString().slice(0, 8)
  };
}

async function ensureStockAjustesPendientesSchema() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS stock_ajustes_pendientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      producto_id INTEGER NOT NULL,
      tipo_movimiento TEXT NOT NULL,
      cantidad REAL NOT NULL,
      motivo TEXT,
      observaciones TEXT,
      proveedor_id INTEGER,
      stock_actual_snapshot REAL NOT NULL DEFAULT 0,
      estado TEXT NOT NULL DEFAULT 'pendiente',
      solicitado_por TEXT NOT NULL,
      solicitado_rol TEXT,
      fecha TEXT NOT NULL,
      hora TEXT NOT NULL,
      created_at TEXT,
      revisado_por TEXT,
      revisado_at TEXT,
      cantidad_aprobada REAL,
      tipo_movimiento_aprobado TEXT,
      observaciones_admin TEXT,
      movimiento_stock_id INTEGER,
      caja_id INTEGER
    )
  `);

  await runQuery("CREATE INDEX IF NOT EXISTS idx_stock_ajustes_pendientes_estado ON stock_ajustes_pendientes(estado)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_stock_ajustes_pendientes_producto ON stock_ajustes_pendientes(producto_id)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_stock_ajustes_pendientes_caja ON stock_ajustes_pendientes(caja_id)");
}

function mapAjuste(row) {
  if (!row) return null;
  return {
    ...row,
    producto_id: Number(row.producto_id),
    cantidad: Number(row.cantidad || 0),
    proveedor_id: row.proveedor_id === null || row.proveedor_id === undefined ? null : Number(row.proveedor_id),
    stock_actual_snapshot: Number(row.stock_actual_snapshot || 0),
    cantidad_aprobada: row.cantidad_aprobada === null || row.cantidad_aprobada === undefined ? null : Number(row.cantidad_aprobada),
    movimiento_stock_id: row.movimiento_stock_id === null || row.movimiento_stock_id === undefined ? null : Number(row.movimiento_stock_id),
    caja_id: row.caja_id === null || row.caja_id === undefined ? null : Number(row.caja_id)
  };
}

async function obtenerAjustePendiente(id) {
  const row = await getQuery(
    `SELECT sap.*, p.nombre AS producto_nombre
     FROM stock_ajustes_pendientes sap
     LEFT JOIN productos p ON p.id = sap.producto_id
     WHERE sap.id = ?`,
    [Number(id)]
  );
  return mapAjuste(row);
}

async function crearAjustePendiente({
  producto_id,
  tipo_movimiento,
  cantidad,
  motivo,
  observaciones,
  proveedor_id,
  usuario,
  rol,
  caja_id
}) {
  await ensureStockAjustesPendientesSchema();

  const productoId = normalizarId(producto_id);
  const tipoMovimiento = normalizarTexto(tipo_movimiento).toLowerCase();
  const cantidadNumero = Number(cantidad);

  if (!productoId) {
    const error = new Error("Producto invalido");
    error.statusCode = 400;
    throw error;
  }

  if (!TIPOS_MOVIMIENTO_VALIDOS.has(tipoMovimiento)) {
    const error = new Error("Tipo de movimiento invalido");
    error.statusCode = 400;
    throw error;
  }

  if (!Number.isFinite(cantidadNumero) || cantidadNumero <= 0) {
    const error = new Error("Cantidad invalida");
    error.statusCode = 400;
    throw error;
  }

  const producto = await getQuery("SELECT id, nombre, stock FROM productos WHERE id = ?", [productoId]);
  if (!producto) {
    const error = new Error("Producto no encontrado");
    error.statusCode = 404;
    throw error;
  }

  const { fecha, hora } = getNowParts();
  const result = await runQuery(
    `INSERT INTO stock_ajustes_pendientes
     (producto_id, tipo_movimiento, cantidad, motivo, observaciones, proveedor_id,
      stock_actual_snapshot, estado, solicitado_por, solicitado_rol, fecha, hora,
      created_at, caja_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?, ?, ?, datetime('now'), ?)`,
    [
      productoId,
      tipoMovimiento,
      cantidadNumero,
      normalizarTexto(motivo),
      normalizarTexto(observaciones),
      normalizarId(proveedor_id),
      Number(producto.stock || 0),
      normalizarTexto(usuario) || "usuario",
      normalizarTexto(rol),
      fecha,
      hora,
      normalizarId(caja_id)
    ]
  );

  return obtenerAjustePendiente(result.lastID);
}

async function listarAjustesPendientes({ estado } = {}) {
  await ensureStockAjustesPendientesSchema();
  const estadoNormalizado = normalizarTexto(estado).toLowerCase();
  const filtrarEstado = ESTADOS_VALIDOS.has(estadoNormalizado);
  const rows = await allQuery(
    `SELECT sap.*, p.nombre AS producto_nombre
     FROM stock_ajustes_pendientes sap
     LEFT JOIN productos p ON p.id = sap.producto_id
     ${filtrarEstado ? "WHERE sap.estado = ?" : ""}
     ORDER BY sap.id DESC`,
    filtrarEstado ? [estadoNormalizado] : []
  );
  return rows.map(mapAjuste);
}

module.exports = {
  ensureStockAjustesPendientesSchema,
  crearAjustePendiente,
  listarAjustesPendientes,
  obtenerAjustePendiente
};
