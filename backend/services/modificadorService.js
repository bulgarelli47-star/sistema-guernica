const { allQuery, getQuery, runQuery } = require("../db");
const { applyStockChange } = require("./stockService");

const TIPOS_MODIFICADOR = new Set(["agregar", "quitar", "multiplicar", "reemplazar", "libre", "observacion"]);
function crearErrorValidacion(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function normalizarTipoModificador(tipo) {
  const normalizado = String(tipo || "libre").trim().toLowerCase();
  return TIPOS_MODIFICADOR.has(normalizado) ? normalizado : "libre";
}

// Los modificadores no son productos vendidos ni lineas independientes de venta.
// Viven pegados a detalle_ventas para describir como se configuro el item vendido.
// El snapshot historico es obligatorio: anulaciones y reportes no deben recalcular
// una venta vieja usando la configuracion actual del producto o del modificador.
async function ensureModificadoresSchema() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS modificadores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT UNIQUE,
      nombre TEXT NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'libre',
      precio_extra REAL NOT NULL DEFAULT 0,
      activo INTEGER NOT NULL DEFAULT 1,
      orden INTEGER NOT NULL DEFAULT 0,
      observacion_cocina TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS producto_modificadores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      producto_id INTEGER NOT NULL,
      modificador_id INTEGER NOT NULL,
      obligatorio INTEGER NOT NULL DEFAULT 0,
      max_usos INTEGER NOT NULL DEFAULT 1,
      orden INTEGER NOT NULL DEFAULT 0,
      activo INTEGER NOT NULL DEFAULT 1,
      UNIQUE(producto_id, modificador_id),
      FOREIGN KEY (producto_id) REFERENCES productos(id),
      FOREIGN KEY (modificador_id) REFERENCES modificadores(id)
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS modificador_componentes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      modificador_id INTEGER NOT NULL,
      producto_id INTEGER,
      cantidad REAL NOT NULL DEFAULT 0,
      operacion TEXT NOT NULL DEFAULT 'agregar',
      metadata_json TEXT,
      FOREIGN KEY (modificador_id) REFERENCES modificadores(id),
      FOREIGN KEY (producto_id) REFERENCES productos(id)
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS detalle_venta_modificadores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      detalle_venta_id INTEGER NOT NULL,
      modificador_id INTEGER,
      nombre TEXT NOT NULL,
      tipo TEXT NOT NULL,
      precio_extra REAL NOT NULL DEFAULT 0,
      cantidad REAL NOT NULL DEFAULT 1,
      metadata_json TEXT,
      FOREIGN KEY (detalle_venta_id) REFERENCES detalle_ventas(id),
      FOREIGN KEY (modificador_id) REFERENCES modificadores(id)
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS detalle_venta_componentes_snapshot (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      detalle_venta_id INTEGER NOT NULL,
      producto_id INTEGER,
      nombre_producto TEXT,
      cantidad REAL NOT NULL DEFAULT 0,
      operacion TEXT NOT NULL DEFAULT 'base',
      origen TEXT NOT NULL DEFAULT 'producto',
      modificador_id INTEGER,
      metadata_json TEXT,
      FOREIGN KEY (detalle_venta_id) REFERENCES detalle_ventas(id),
      FOREIGN KEY (producto_id) REFERENCES productos(id),
      FOREIGN KEY (modificador_id) REFERENCES modificadores(id)
    )
  `);

  await runQuery("CREATE INDEX IF NOT EXISTS idx_producto_modificadores_producto ON producto_modificadores(producto_id)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_detalle_venta_modificadores_detalle ON detalle_venta_modificadores(detalle_venta_id)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_detalle_venta_componentes_snapshot_detalle ON detalle_venta_componentes_snapshot(detalle_venta_id)");
}

async function getModificadoresProducto(productoId) {
  if (!productoId) return [];

  await ensureModificadoresSchema();
  const modificadores = await allQuery(
    `SELECT m.*, pm.obligatorio, pm.max_usos, pm.orden AS producto_orden
     FROM producto_modificadores pm
     INNER JOIN modificadores m ON m.id = pm.modificador_id
     WHERE pm.producto_id = ?
       AND pm.activo = 1
       AND m.activo = 1
     ORDER BY pm.orden ASC, m.orden ASC, m.nombre ASC`,
    [productoId]
  );

  for (const modificador of modificadores) {
    modificador.componentes = await getComponentesModificador(modificador.id);
  }

  return modificadores;
}

async function getComponentesModificador(modificadorId) {
  if (!modificadorId) return [];

  await ensureModificadoresSchema();
  return allQuery(
    `SELECT mc.*, p.nombre AS nombre_producto
     FROM modificador_componentes mc
     LEFT JOIN productos p ON p.id = mc.producto_id
     WHERE mc.modificador_id = ?
     ORDER BY mc.id ASC`,
    [modificadorId]
  );
}

async function getModificadorConComponentes(modificadorId) {
  if (!modificadorId) return null;

  const modificador = await getQuery("SELECT * FROM modificadores WHERE id = ? AND activo = 1", [modificadorId]);
  if (!modificador) return null;
  modificador.componentes = await getComponentesModificador(modificador.id);
  return modificador;
}

async function getModificadorProductoActivo(productoId, modificadorId) {
  if (!productoId || !modificadorId) return null;

  await ensureModificadoresSchema();
  const modificador = await getQuery(
    `SELECT m.*, pm.producto_id, pm.max_usos, pm.obligatorio, pm.orden AS producto_orden
     FROM producto_modificadores pm
     INNER JOIN modificadores m ON m.id = pm.modificador_id
     WHERE pm.producto_id = ?
       AND pm.modificador_id = ?
       AND pm.activo = 1
       AND m.activo = 1`,
    [productoId, modificadorId]
  );
  if (!modificador) return null;
  modificador.componentes = await getComponentesModificador(modificador.id);
  return modificador;
}

async function crearModificadorProducto(productoId, payload = {}) {
  await ensureModificadoresSchema();
  const producto = Number(productoId) || 0;
  const nombre = String(payload.nombre || "").trim();
  if (!producto || !nombre) {
    const error = new Error("Producto y nombre de modificador son obligatorios");
    error.statusCode = 400;
    throw error;
  }

  const tipo = normalizarTipoModificador(payload.tipo);
  const codigo = String(payload.codigo || "").trim() || null;
  const precioExtra = tipo === "observacion" ? 0 : Number(payload.precio_extra ?? payload.precio ?? 0) || 0;
  const now = new Date().toISOString();

  const result = await runQuery(
    `INSERT INTO modificadores
     (codigo, nombre, tipo, precio_extra, activo, orden, observacion_cocina, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      codigo,
      nombre,
      tipo,
      precioExtra,
      payload.activo === false ? 0 : 1,
      Number(payload.orden || 0),
      payload.observacion_cocina || null,
      now,
      now
    ]
  );

  const modificadorId = result.lastID;
  await runQuery(
    `INSERT INTO producto_modificadores
     (producto_id, modificador_id, obligatorio, max_usos, orden, activo)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      producto,
      modificadorId,
      payload.obligatorio ? 1 : 0,
      Math.max(1, Number(payload.max_usos || 1)),
      Number(payload.producto_orden ?? payload.orden ?? 0),
      payload.activo === false ? 0 : 1
    ]
  );

  const componentes = Array.isArray(payload.componentes) ? payload.componentes : [];
  for (const componente of componentes) {
    const componenteId = componente.producto_id ? Number(componente.producto_id) : null;
    const cantidad = Number(componente.cantidad || 0);
    if (!componenteId || cantidad <= 0) continue;
    await runQuery(
      `INSERT INTO modificador_componentes
       (modificador_id, producto_id, cantidad, operacion, metadata_json)
       VALUES (?, ?, ?, ?, ?)`,
      [
        modificadorId,
        componenteId,
        cantidad,
        componente.operacion || tipo,
        componente.metadata_json || null
      ]
    );
  }

  return getModificadorConComponentes(modificadorId);
}

function normalizarModificadoresItem(item = {}) {
  const modificadores = Array.isArray(item.modificadores) ? item.modificadores : [];
  return modificadores
    .map((modificador) => ({
      modificador_id: modificador.modificador_id ?? modificador.id ?? null,
      nombre: String(modificador.nombre || "").trim(),
      tipo: normalizarTipoModificador(modificador.tipo),
      precio_extra: Number(modificador.precio_extra ?? modificador.precio ?? 0) || 0,
      cantidad: Number(modificador.cantidad || 1) || 1,
      metadata_json: modificador.metadata_json || null,
      componentes: Array.isArray(modificador.componentes) ? modificador.componentes : []
    }))
    .filter((modificador) => modificador.nombre);
}

function calcularPrecioItemConModificadores(item = {}) {
  const precioBase = Number(item.precio_unitario ?? item.precio_venta ?? 0) || 0;
  const extras = normalizarModificadoresItem(item).reduce(
    (acc, modificador) => {
      if (modificador.tipo === "observacion") return acc;
      return acc + Number(modificador.precio_extra || 0) * Number(modificador.cantidad || 1);
    },
    0
  );
  return Number((precioBase + extras).toFixed(2));
}

async function resolverComposicionItemVenta(item = {}, options = {}) {
  const validarAsociacion = Boolean(options.validarAsociacion);
  const tiposPermitidos = options.tiposPermitidos
    ? new Set(options.tiposPermitidos)
    : null;
  const seleccionados = [];
  for (const modificadorRaw of Array.isArray(item.modificadores) ? item.modificadores : []) {
    const modificadorId = modificadorRaw.modificador_id ?? modificadorRaw.id ?? null;
    const cantidad = Number(modificadorRaw.cantidad || 1) || 0;
    if (cantidad <= 0) {
      throw crearErrorValidacion("La cantidad del modificador debe ser mayor a 0");
    }

    if (validarAsociacion && !modificadorId) {
      throw crearErrorValidacion("El modificador_id es obligatorio");
    }

    const desdeDb = modificadorId
      ? validarAsociacion
        ? await getModificadorProductoActivo(item.producto_id, modificadorId)
        : await getModificadorConComponentes(modificadorId)
      : null;

    if (validarAsociacion && !desdeDb) {
      throw crearErrorValidacion("Modificador invalido para el producto vendido");
    }

    const base = desdeDb || modificadorRaw;
    if (!base) continue;
    const tipo = normalizarTipoModificador(base.tipo);

    if (tiposPermitidos && !tiposPermitidos.has(tipo)) {
      throw crearErrorValidacion(`El modificador tipo ${tipo} no esta habilitado para ventas normales`);
    }

    seleccionados.push({
      modificador_id: base.id ?? modificadorId ?? null,
      nombre: String(base.nombre || "").trim(),
      tipo,
      precio_extra: Number(base.precio_extra ?? base.precio ?? 0) || 0,
      cantidad,
      metadata_json: modificadorRaw.metadata_json || base.metadata_json || null,
      componentes: Array.isArray(base.componentes) ? base.componentes : []
    });
  }

  const itemConModificadores = { ...item, modificadores: seleccionados };
  const precio_unitario = calcularPrecioItemConModificadores(itemConModificadores);
  const cantidadItem = Number(item.cantidad || 0) || 0;
  const componentes = [];

  for (const modificador of seleccionados) {
    if (modificador.tipo !== "agregar") continue;
    for (const componente of modificador.componentes) {
      componentes.push({
        producto_id: componente.producto_id ?? null,
        nombre_producto: componente.nombre_producto || null,
        cantidad: Number((Number(componente.cantidad || 0) * Number(modificador.cantidad || 1) * cantidadItem).toFixed(4)),
        operacion: "agregar",
        origen: "modificador",
        modificador_id: modificador.modificador_id,
        metadata_json: componente.metadata_json || null
      });
    }
  }

  return {
    ...item,
    precio_unitario,
    modificadores: seleccionados,
    componentes
  };
}

async function guardarModificadoresDetalleVenta(detalleVentaId, modificadores = []) {
  if (!detalleVentaId || !Array.isArray(modificadores) || !modificadores.length) return;

  await ensureModificadoresSchema();
  for (const modificador of normalizarModificadoresItem({ modificadores })) {
    await runQuery(
      `INSERT INTO detalle_venta_modificadores
       (detalle_venta_id, modificador_id, nombre, tipo, precio_extra, cantidad, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        detalleVentaId,
        modificador.modificador_id,
        modificador.nombre,
        modificador.tipo,
        modificador.precio_extra,
        modificador.cantidad,
        modificador.metadata_json
      ]
    );
  }
}

async function guardarComponentesSnapshot(detalleVentaId, componentes = []) {
  if (!detalleVentaId || !Array.isArray(componentes) || !componentes.length) return;

  await ensureModificadoresSchema();
  for (const componente of componentes) {
    await runQuery(
      `INSERT INTO detalle_venta_componentes_snapshot
       (detalle_venta_id, producto_id, nombre_producto, cantidad, operacion, origen, modificador_id, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        detalleVentaId,
        componente.producto_id ?? null,
        componente.nombre_producto || null,
        Number(componente.cantidad || 0),
        componente.operacion || "base",
        componente.origen || "producto",
        componente.modificador_id ?? null,
        componente.metadata_json || null
      ]
    );
  }
}

async function getComponentesSnapshotDetalle(detalleVentaId) {
  if (!detalleVentaId) return [];

  await ensureModificadoresSchema();
  return allQuery(
    `SELECT *
     FROM detalle_venta_componentes_snapshot
     WHERE detalle_venta_id = ?
     ORDER BY id ASC`,
    [detalleVentaId]
  );
}

async function guardarSnapshotsModificadoresVenta(detalles = []) {
  for (const detalle of detalles) {
    await guardarModificadoresDetalleVenta(detalle.detalle_venta_id, detalle.modificadores);
    await guardarComponentesSnapshot(detalle.detalle_venta_id, detalle.componentes);
  }
}

async function aplicarStockComponentesSnapshot(detalles = [], signo = 1) {
  for (const detalle of detalles) {
    const componentes = await getComponentesSnapshotDetalle(detalle.detalle_venta_id ?? detalle.id);
    for (const componente of componentes) {
      const productoId = Number(componente.producto_id || 0);
      const cantidad = Number(componente.cantidad || 0);
      if (!productoId || cantidad <= 0) continue;
      await applyStockChange(productoId, signo * cantidad, { comoComponente: true });
    }
  }
}

function getComponentesItemsVenta(items = []) {
  return items.flatMap((item) => Array.isArray(item.componentes) ? item.componentes : []);
}

async function getComponentesSnapshotVenta(ventaId) {
  return allQuery(
    `SELECT dvc.*
     FROM detalle_venta_componentes_snapshot dvc
     INNER JOIN detalle_ventas dv ON dv.id = dvc.detalle_venta_id
     WHERE dv.venta_id = ?
     ORDER BY dvc.id ASC`,
    [ventaId]
  );
}

async function aplicarStockDiffComponentesExtra(oldComponentes = [], newComponentes = []) {
  const deltaByProduct = new Map();

  for (const componente of oldComponentes) {
    const productoId = Number(componente.producto_id || 0);
    if (!productoId) continue;
    const current = deltaByProduct.get(productoId) || 0;
    deltaByProduct.set(productoId, current - Number(componente.cantidad || 0));
  }

  for (const componente of newComponentes) {
    const productoId = Number(componente.producto_id || 0);
    if (!productoId) continue;
    const current = deltaByProduct.get(productoId) || 0;
    deltaByProduct.set(productoId, current + Number(componente.cantidad || 0));
  }

  for (const [productoId, delta] of deltaByProduct.entries()) {
    await applyStockChange(productoId, delta, { comoComponente: true });
  }
}

async function borrarSnapshotsDetalles(detalles = []) {
  const ids = detalles
    .map((detalle) => Number(detalle.detalle_venta_id ?? detalle.id ?? 0))
    .filter(Boolean);
  if (!ids.length) return;

  const placeholders = ids.map(() => "?").join(",");
  await runQuery(`DELETE FROM detalle_venta_modificadores WHERE detalle_venta_id IN (${placeholders})`, ids);
  await runQuery(`DELETE FROM detalle_venta_componentes_snapshot WHERE detalle_venta_id IN (${placeholders})`, ids);
}

async function getModificadoresProductoTodos(productoId) {
  if (!productoId) return [];
  await ensureModificadoresSchema();
  const modificadores = await allQuery(
    `SELECT m.*, pm.obligatorio, pm.max_usos, pm.orden AS producto_orden
     FROM producto_modificadores pm
     INNER JOIN modificadores m ON m.id = pm.modificador_id
     WHERE pm.producto_id = ?
     ORDER BY pm.orden ASC, m.orden ASC, m.nombre ASC`,
    [productoId]
  );
  for (const mod of modificadores) {
    mod.componentes = await getComponentesModificador(mod.id);
  }
  return modificadores;
}

async function actualizarModificador(id, payload = {}) {
  const nombre = String(payload.nombre || "").trim();
  if (!nombre) throw crearErrorValidacion("El nombre es obligatorio");

  const tipo = normalizarTipoModificador(payload.tipo);
  const tiposPermitidos = ["libre", "observacion", "agregar"];
  if (!tiposPermitidos.includes(tipo)) throw crearErrorValidacion("Tipo no permitido");

  const precioExtra = tipo === "observacion" ? 0 : Math.max(0, Number(payload.precio_extra ?? 0) || 0);
  const activo = payload.activo === false || payload.activo === 0 || payload.activo === "0" ? 0 : 1;
  const now = new Date().toISOString();

  await runQuery(
    `UPDATE modificadores SET nombre = ?, tipo = ?, precio_extra = ?, activo = ?, updated_at = ? WHERE id = ?`,
    [nombre, tipo, precioExtra, activo, now, id]
  );

  // Resetea y recrea componentes (solo afecta ventas futuras, snapshots históricos intactos)
  await runQuery(`DELETE FROM modificador_componentes WHERE modificador_id = ?`, [id]);
  if (tipo === "agregar") {
    const componentes = Array.isArray(payload.componentes) ? payload.componentes : [];
    for (const comp of componentes) {
      const compId = Number(comp.producto_id || 0);
      const cantidad = Number(comp.cantidad || 0);
      if (!compId || cantidad <= 0) continue;
      await runQuery(
        `INSERT INTO modificador_componentes (modificador_id, producto_id, cantidad, operacion, metadata_json) VALUES (?, ?, ?, ?, ?)`,
        [id, compId, cantidad, tipo, comp.metadata_json || null]
      );
    }
  }

  const modificador = await getQuery("SELECT * FROM modificadores WHERE id = ?", [id]);
  if (modificador) modificador.componentes = await getComponentesModificador(id);
  return modificador;
}

async function setActivoModificador(id, activo) {
  const val = activo ? 1 : 0;
  const now = new Date().toISOString();
  await runQuery(`UPDATE modificadores SET activo = ?, updated_at = ? WHERE id = ?`, [val, now, id]);
  await runQuery(`UPDATE producto_modificadores SET activo = ? WHERE modificador_id = ?`, [val, id]);
}

function getStockDeltaVentaItem(item = {}) {
  return {
    producto_id: item.producto_id,
    cantidad: Number(item.cantidad || 0),
    componentes: Array.isArray(item.componentes) ? item.componentes : []
  };
}

module.exports = {
  ensureModificadoresSchema,
  crearModificadorProducto,
  getModificadoresProducto,
  normalizarModificadoresItem,
  resolverComposicionItemVenta,
  calcularPrecioItemConModificadores,
  guardarModificadoresDetalleVenta,
  guardarComponentesSnapshot,
  getComponentesSnapshotDetalle,
  guardarSnapshotsModificadoresVenta,
  aplicarStockComponentesSnapshot,
  getComponentesItemsVenta,
  getComponentesSnapshotVenta,
  aplicarStockDiffComponentesExtra,
  borrarSnapshotsDetalles,
  getStockDeltaVentaItem,
  getModificadoresProductoTodos,
  actualizarModificador,
  setActivoModificador
};
