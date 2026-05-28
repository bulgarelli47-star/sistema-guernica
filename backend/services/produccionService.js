const { allQuery, getQuery, runQuery } = require("../db");
const {
  calcularCostoProductoCompuesto,
  getComponentesProductoCompuesto,
  getCostoConsumoUnitarioProducto,
  normalizarTipoProducto
} = require("./stockService");
const { getConfiguracionGlobal } = require("./configService");

function getNowParts() {
  const now = new Date();
  return {
    fecha: now.toISOString().slice(0, 10),
    hora: now.toTimeString().slice(0, 8)
  };
}

function round2(value) {
  return Number((Number(value) || 0).toFixed(2));
}

function round4(value) {
  return Number((Number(value) || 0).toFixed(4));
}

function crearError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function ensureProduccionSchema() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS producciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      producto_id INTEGER NOT NULL,
      producto_nombre_snapshot TEXT,
      cantidad_producida REAL NOT NULL,
      fecha TEXT NOT NULL,
      hora TEXT NOT NULL,
      responsable TEXT,
      observacion TEXT,
      costo_estimado REAL NOT NULL DEFAULT 0,
      estado TEXT NOT NULL DEFAULT 'registrada',
      movimiento_stock_ingreso_id INTEGER,
      creado_por TEXT,
      created_at TEXT,
      anulada_at TEXT,
      anulada_por TEXT,
      motivo_anulacion TEXT
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS produccion_componentes_snapshot (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produccion_id INTEGER NOT NULL,
      producto_id INTEGER NOT NULL,
      producto_nombre_snapshot TEXT,
      cantidad_unitaria REAL NOT NULL,
      cantidad_consumida REAL NOT NULL,
      stock_anterior REAL,
      stock_nuevo REAL,
      costo_unitario_snapshot REAL NOT NULL DEFAULT 0,
      costo_total_snapshot REAL NOT NULL DEFAULT 0,
      movimiento_stock_id INTEGER
    )
  `);

  await runQuery("CREATE INDEX IF NOT EXISTS idx_producciones_producto ON producciones(producto_id)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_producciones_fecha ON producciones(fecha)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_produccion_componentes_produccion ON produccion_componentes_snapshot(produccion_id)");
}

function esProductoProducible(producto) {
  return normalizarTipoProducto(producto?.tipo) === "compuesto" && Number(producto?.maneja_stock || 0) === 1;
}

async function obtenerProductoProducible(productoId) {
  const producto = await getQuery(
    `SELECT id, nombre, tipo, maneja_stock, stock, costo_final, precio_compra, activo, COALESCE(eliminado, 0) AS eliminado
     FROM productos
     WHERE id = ?`,
    [Number(productoId)]
  );

  if (!producto || Number(producto.eliminado || 0) === 1) {
    throw crearError("Producto no encontrado", 404);
  }
  if (!esProductoProducible(producto)) {
    throw crearError("Produccion V1 solo permite productos compuestos con stock fisico propio", 400);
  }
  return producto;
}

async function listarProductosProducibles() {
  await ensureProduccionSchema();
  return allQuery(
    `SELECT p.id, p.nombre, p.codigo, p.categoria, c.nombre AS categoria_nombre, p.stock, p.costo_final, p.precio_compra
     FROM productos p
     LEFT JOIN categorias c ON c.id = p.categoria_id
     WHERE COALESCE(p.eliminado, 0) = 0
       AND COALESCE(p.activo, 1) = 1
       AND LOWER(COALESCE(p.tipo, 'simple')) = 'compuesto'
       AND COALESCE(p.maneja_stock, 0) = 1
     ORDER BY p.nombre ASC`
  );
}

async function buildPreviewProduccion({ producto_id, cantidad }) {
  await ensureProduccionSchema();
  const producto = await obtenerProductoProducible(producto_id);
  const cantidadProducida = Number(cantidad);
  if (!Number.isFinite(cantidadProducida) || cantidadProducida <= 0) {
    throw crearError("La cantidad a producir debe ser mayor a cero", 400);
  }

  const componentes = await getComponentesProductoCompuesto(producto.id);
  if (!componentes.length) {
    throw crearError("El producto no tiene componentes configurados", 400);
  }

  const componentesPreview = [];
  for (const componente of componentes) {
    if (Number(componente.maneja_stock || 0) !== 1) {
      componentesPreview.push({
        producto_id: Number(componente.producto_id),
        producto_nombre: componente.producto_nombre || "",
        cantidad_unitaria: round4(componente.cantidad),
        cantidad_requerida: round4(Number(componente.cantidad || 0) * cantidadProducida),
        stock_actual: round4(componente.stock),
        faltante: 0,
        costo_unitario: 0,
        costo_total: 0,
        auditable: false,
        bloqueo: "El componente no tiene stock fisico auditable"
      });
      continue;
    }

    const cantidadRequerida = round4(Number(componente.cantidad || 0) * cantidadProducida);
    const stockActual = round4(componente.stock);
    const faltante = round4(Math.max(0, cantidadRequerida - stockActual));
    const costoUnitario = round4(await getCostoConsumoUnitarioProducto(componente.producto_id, componente));
    componentesPreview.push({
      producto_id: Number(componente.producto_id),
      producto_nombre: componente.producto_nombre || "",
      cantidad_unitaria: round4(componente.cantidad),
      cantidad_requerida: cantidadRequerida,
      stock_actual: stockActual,
      faltante,
      costo_unitario: costoUnitario,
      costo_total: round2(costoUnitario * cantidadRequerida),
      auditable: true,
      bloqueo: null
    });
  }

  const config = await getConfiguracionGlobal();
  const bloqueos = componentesPreview.filter((item) => item.bloqueo);
  const faltantes = componentesPreview.filter((item) => item.faltante > 0);
  const puedeProducir = bloqueos.length === 0 && (config.stock_permitir_negativo || faltantes.length === 0);
  const costoComponentes = componentesPreview.reduce((acc, item) => acc + Number(item.costo_total || 0), 0);
  const costoUnitarioReceta = await calcularCostoProductoCompuesto(producto.id);

  return {
    producto: {
      id: Number(producto.id),
      nombre: producto.nombre,
      stock_actual: round4(producto.stock),
      costo_unitario_estimado: round2(costoUnitarioReceta)
    },
    cantidad_producida: round4(cantidadProducida),
    componentes: componentesPreview,
    costo_estimado: round2(costoComponentes || (costoUnitarioReceta * cantidadProducida)),
    puede_producir: Boolean(puedeProducir),
    faltantes,
    bloqueos
  };
}

async function registrarMovimientoFisico({ productoId, tipoMovimiento, cantidad, motivo, usuario }) {
  const producto = await getQuery("SELECT id, stock FROM productos WHERE id = ?", [Number(productoId)]);
  if (!producto) throw crearError("Producto de stock no encontrado", 404);
  const stockAnterior = Number(producto.stock || 0);
  const esIngreso = tipoMovimiento === "produccion_ingreso";
  const stockNuevo = round4(esIngreso ? stockAnterior + Number(cantidad || 0) : stockAnterior - Number(cantidad || 0));

  await runQuery("UPDATE productos SET stock = ? WHERE id = ?", [stockNuevo, productoId]);
  const { fecha, hora } = getNowParts();
  const result = await runQuery(
    `INSERT INTO movimientos_stock (producto_id, tipo_movimiento, cantidad, stock_anterior, stock_nuevo, motivo, usuario, fecha, hora)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [productoId, tipoMovimiento, round4(cantidad), stockAnterior, stockNuevo, motivo, usuario || "admin", fecha, hora]
  );

  return {
    id: result.lastID,
    stock_anterior: stockAnterior,
    stock_nuevo: stockNuevo
  };
}

async function registrarProduccion({ producto_id, cantidad_producida, responsable = "", observacion = "", usuario = "admin" } = {}) {
  const cantidad = Number(cantidad_producida);
  const preview = await buildPreviewProduccion({ producto_id, cantidad });
  if (!preview.puede_producir) {
    throw crearError("No se puede registrar produccion: hay componentes faltantes o no auditables", 400);
  }

  const producto = await obtenerProductoProducible(producto_id);
  const { fecha, hora } = getNowParts();

  await runQuery("BEGIN TRANSACTION");
  try {
    const produccionInsert = await runQuery(
      `INSERT INTO producciones
       (producto_id, producto_nombre_snapshot, cantidad_producida, fecha, hora, responsable, observacion, costo_estimado, estado, creado_por, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'registrada', ?, datetime('now'))`,
      [
        producto.id,
        producto.nombre,
        round4(cantidad),
        fecha,
        hora,
        String(responsable || "").trim(),
        String(observacion || "").trim(),
        round2(preview.costo_estimado),
        usuario || "admin"
      ]
    );
    const produccionId = produccionInsert.lastID;

    for (const componente of preview.componentes) {
      const movimiento = await registrarMovimientoFisico({
        productoId: componente.producto_id,
        tipoMovimiento: "produccion_consumo",
        cantidad: componente.cantidad_requerida,
        motivo: `Consumo produccion: ${producto.nombre}`,
        usuario
      });
      await runQuery(
        `INSERT INTO produccion_componentes_snapshot
         (produccion_id, producto_id, producto_nombre_snapshot, cantidad_unitaria, cantidad_consumida,
          stock_anterior, stock_nuevo, costo_unitario_snapshot, costo_total_snapshot, movimiento_stock_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          produccionId,
          componente.producto_id,
          componente.producto_nombre,
          componente.cantidad_unitaria,
          componente.cantidad_requerida,
          movimiento.stock_anterior,
          movimiento.stock_nuevo,
          componente.costo_unitario,
          componente.costo_total,
          movimiento.id
        ]
      );
    }

    const ingreso = await registrarMovimientoFisico({
      productoId: producto.id,
      tipoMovimiento: "produccion_ingreso",
      cantidad,
      motivo: "Ingreso por produccion",
      usuario
    });

    await runQuery(
      "UPDATE producciones SET movimiento_stock_ingreso_id = ? WHERE id = ?",
      [ingreso.id, produccionId]
    );

    await runQuery("COMMIT");
    return obtenerProduccion(produccionId);
  } catch (error) {
    try { await runQuery("ROLLBACK"); } catch {}
    throw error;
  }
}

async function listarProducciones({ desde = null, hasta = null, producto_id = null, estado = null } = {}) {
  await ensureProduccionSchema();
  const where = ["1 = 1"];
  const params = [];
  if (desde) {
    where.push("fecha >= ?");
    params.push(String(desde).slice(0, 10));
  }
  if (hasta) {
    where.push("fecha <= ?");
    params.push(String(hasta).slice(0, 10));
  }
  if (producto_id) {
    where.push("producto_id = ?");
    params.push(Number(producto_id));
  }
  if (estado) {
    where.push("estado = ?");
    params.push(String(estado));
  }

  return allQuery(
    `SELECT *
     FROM producciones
     WHERE ${where.join(" AND ")}
     ORDER BY fecha DESC, hora DESC, id DESC
     LIMIT 150`,
    params
  );
}

async function obtenerProduccion(id) {
  await ensureProduccionSchema();
  const produccion = await getQuery("SELECT * FROM producciones WHERE id = ?", [Number(id)]);
  if (!produccion) return null;
  const componentes = await allQuery(
    `SELECT *
     FROM produccion_componentes_snapshot
     WHERE produccion_id = ?
     ORDER BY id ASC`,
    [Number(id)]
  );
  return {
    ...produccion,
    id: Number(produccion.id),
    producto_id: Number(produccion.producto_id),
    cantidad_producida: round4(produccion.cantidad_producida),
    costo_estimado: round2(produccion.costo_estimado),
    movimiento_stock_ingreso_id: produccion.movimiento_stock_ingreso_id == null ? null : Number(produccion.movimiento_stock_ingreso_id),
    componentes: componentes.map((item) => ({
      ...item,
      id: Number(item.id),
      produccion_id: Number(item.produccion_id),
      producto_id: Number(item.producto_id),
      cantidad_unitaria: round4(item.cantidad_unitaria),
      cantidad_consumida: round4(item.cantidad_consumida),
      stock_anterior: round4(item.stock_anterior),
      stock_nuevo: round4(item.stock_nuevo),
      costo_unitario_snapshot: round4(item.costo_unitario_snapshot),
      costo_total_snapshot: round2(item.costo_total_snapshot),
      movimiento_stock_id: item.movimiento_stock_id == null ? null : Number(item.movimiento_stock_id)
    }))
  };
}

module.exports = {
  ensureProduccionSchema,
  listarProductosProducibles,
  buildPreviewProduccion,
  registrarProduccion,
  listarProducciones,
  obtenerProduccion
};
