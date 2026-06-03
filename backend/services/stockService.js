const { allQuery, getQuery, runQuery } = require("../db");
const { getConfiguracionGlobal } = require("./configService");

function getNowParts() {
  const now = new Date();
  return {
    fecha: now.toISOString().slice(0, 10),
    hora: now.toTimeString().slice(0, 8)
  };
}

function normalizarInsumosCostos(insumos = []) {
  if (!Array.isArray(insumos)) return [];
  return insumos
    .map((item) => {
      const nombre = String(item.nombre || "").trim();
      const costoTotal = Number(item.costo_total) || 0;
      const cantidadRinde = Number(item.cantidad_rinde) || 0;
      const cantidadUsada = Number(item.cantidad_usada) || 1;
      const costoUnitario = cantidadRinde > 0 ? costoTotal / cantidadRinde : 0;
      const costoAplicado = costoUnitario * cantidadUsada;
      return {
        nombre,
        costo_total: Number(costoTotal.toFixed(2)),
        cantidad_rinde: Number(cantidadRinde.toFixed(4)),
        unidad: String(item.unidad || "un").trim() || "un",
        cantidad_usada: Number(cantidadUsada.toFixed(4)),
        costo_unitario: Number(costoUnitario.toFixed(4)),
        costo_aplicado: Number(costoAplicado.toFixed(2))
      };
    })
    .filter((item) => item.nombre && item.cantidad_rinde > 0);
}

function calcularCostoPorRendimiento(insumos = []) {
  return Number(normalizarInsumosCostos(insumos).reduce((acc, item) => acc + item.costo_aplicado, 0).toFixed(2));
}

function calcularStockPorRendimiento(insumos = []) {
  return Number(normalizarInsumosCostos(insumos).reduce((acc, item) => acc + Number(item.cantidad_rinde || 0), 0).toFixed(4));
}

async function guardarInsumosProducto(productoId, insumos = []) {
  const normalizados = normalizarInsumosCostos(insumos);
  await runQuery("DELETE FROM producto_costos_insumos WHERE producto_id = ?", [productoId]);
  for (const item of normalizados) {
    await runQuery(
      `INSERT INTO producto_costos_insumos
       (producto_id, nombre, costo_total, cantidad_rinde, unidad, cantidad_usada, costo_unitario, costo_aplicado)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [productoId, item.nombre, item.costo_total, item.cantidad_rinde, item.unidad, item.cantidad_usada, item.costo_unitario, item.costo_aplicado]
    );
  }
}

function normalizarTipoProducto(tipo) {
  return String(tipo || "simple").toLowerCase() === "compuesto" ? "compuesto" : "simple";
}

function esProductoReceta(producto = {}) {
  return normalizarTipoProducto(producto.tipo) === "compuesto";
}

function normalizarComponentesProducto(componentes = []) {
  if (!Array.isArray(componentes)) {
    return [];
  }

  const base = componentes
    .map((item) => ({
      producto_id: Number(item.producto_id ?? item.id),
      cantidad: Number(item.cantidad) || 0
    }))
    .filter((item) => item.producto_id > 0 && item.cantidad > 0);

  const map = new Map();
  for (const item of base) {
    const prev = map.get(item.producto_id);
    map.set(item.producto_id, prev
      ? { producto_id: item.producto_id, cantidad: prev.cantidad + item.cantidad }
      : item
    );
  }
  return [...map.values()];
}

function normalizarCostosExtraProducto(costosExtra = []) {
  if (!Array.isArray(costosExtra)) {
    return [];
  }

  return costosExtra
    .map((item) => ({
      descripcion: String(item.descripcion || "").trim(),
      monto: Number(item.monto) || 0
    }))
    .filter((item) => item.descripcion && item.monto !== 0);
}

async function guardarProductoCompuestoConfig(productoCompuestoId, componentes = [], costosExtra = []) {
  await runQuery("DELETE FROM producto_componentes WHERE producto_compuesto_id = ?", [productoCompuestoId]);
  await runQuery("DELETE FROM producto_costos_extra WHERE producto_compuesto_id = ?", [productoCompuestoId]);

  for (const componente of normalizarComponentesProducto(componentes)) {
    if (Number(componente.producto_id) === Number(productoCompuestoId)) {
      continue;
    }

    await runQuery(
      `INSERT INTO producto_componentes (producto_compuesto_id, producto_id, cantidad)
       VALUES (?, ?, ?)`,
      [productoCompuestoId, componente.producto_id, componente.cantidad]
    );
  }

  for (const costo of normalizarCostosExtraProducto(costosExtra)) {
    await runQuery(
      `INSERT INTO producto_costos_extra (producto_compuesto_id, descripcion, monto)
       VALUES (?, ?, ?)`,
      [productoCompuestoId, costo.descripcion, costo.monto]
    );
  }
}

async function getComponentesProductoCompuesto(productoCompuestoId) {
  return allQuery(
    `SELECT pc.id, pc.producto_compuesto_id, pc.producto_id, pc.cantidad,
            p.nombre AS producto_nombre, p.stock, p.maneja_stock, p.tipo, p.es_combo,
            p.unidad_medida, p.precio_compra, p.costo_final, p.precio_venta
     FROM producto_componentes pc
     INNER JOIN productos p ON p.id = pc.producto_id
     WHERE pc.producto_compuesto_id = ?
     ORDER BY pc.id ASC`,
    [productoCompuestoId]
  );
}

async function getCostosExtraProductoCompuesto(productoCompuestoId) {
  return allQuery(
    `SELECT id, producto_compuesto_id, descripcion, monto
     FROM producto_costos_extra
     WHERE producto_compuesto_id = ?
     ORDER BY id ASC`,
    [productoCompuestoId]
  );
}

async function calcularStockDisponibleCompuesto(productoCompuestoId, visited = new Set()) {
  const compuestoId = Number(productoCompuestoId);
  if (!compuestoId || visited.has(compuestoId)) {
    return 0;
  }
  visited.add(compuestoId);

  const [producto, componentes] = await Promise.all([
    getQuery("SELECT rendimiento_receta FROM productos WHERE id = ?", [compuestoId]),
    getComponentesProductoCompuesto(productoCompuestoId)
  ]);

  if (!componentes.length) {
    return 0;
  }

  const disponibilidades = [];
  for (const item of componentes) {
    const cantidad = Number(item.cantidad || 0);
    if (cantidad <= 0) {
      continue;
    }

    const stockBase = esProductoReceta(item) && Number(item.maneja_stock) !== 1
      ? await calcularStockDisponibleCompuesto(item.producto_id, new Set(visited))
      : Number(item.stock || 0);
    disponibilidades.push(stockBase / cantidad);
  }

  if (!disponibilidades.length) return 0;

  const batchesDisponibles = Math.max(0, Math.floor(Math.min(...disponibilidades)));
  const rendimiento = Math.max(1, Number(producto?.rendimiento_receta) || 1);
  return batchesDisponibles * rendimiento;
}

async function getCostoConsumoUnitarioProducto(productoId, productoRow = null) {
  const costos = await allQuery(
    "SELECT costo_unitario FROM producto_costos_insumos WHERE producto_id = ?",
    [productoId]
  );

  if (costos.length) {
    const total = costos.reduce((acc, item) => acc + Number(item.costo_unitario || 0), 0);
    return Number(total.toFixed(4));
  }

  const producto = productoRow || await getQuery(
    "SELECT precio_compra, costo_final FROM productos WHERE id = ?",
    [productoId]
  );
  return Number(Number(producto?.costo_final || producto?.precio_compra || 0).toFixed(4));
}

async function calcularStockVendibleFraccionado(productoId, stockActual = 0) {
  const costos = await normalizarInsumosCostos(await allQuery(
    "SELECT * FROM producto_costos_insumos WHERE producto_id = ? ORDER BY id ASC",
    [productoId]
  ));
  const consumoUnidad = costos.reduce((acc, item) => acc + Number(item.cantidad_usada || 0), 0);
  if (consumoUnidad <= 0) {
    return Math.max(0, Math.floor(Number(stockActual) || 0));
  }
  return Math.max(0, Math.floor((Number(stockActual) || 0) / consumoUnidad));
}

async function calcularStockVendible(productoId, stockActual = 0) {
  return calcularStockVendibleFraccionado(productoId, stockActual);
}

async function calcularCostoProductoCompuesto(productoCompuestoId) {
  const [producto, componentes, costosExtra] = await Promise.all([
    getQuery("SELECT rendimiento_receta FROM productos WHERE id = ?", [productoCompuestoId]),
    getComponentesProductoCompuesto(productoCompuestoId),
    getCostosExtraProductoCompuesto(productoCompuestoId)
  ]);

  let costoComponentes = 0;
  for (const item of componentes) {
    const costoUnitarioConsumo = await getCostoConsumoUnitarioProducto(item.producto_id, item);
    costoComponentes += costoUnitarioConsumo * Number(item.cantidad || 0);
  }
  const extras = costosExtra.reduce((acc, item) => acc + Number(item.monto || 0), 0);
  const rendimiento = Math.max(1, Number(producto?.rendimiento_receta) || 1);
  const extrasPorPorcion = Number((extras / rendimiento).toFixed(4));
  return Number((costoComponentes + extrasPorPorcion).toFixed(2));
}

async function calcularCostoProductoCompuestoPayload(componentes = [], costosExtra = [], rendimientoReceta = 1) {
  const componentesNormalizados = normalizarComponentesProducto(componentes);
  let costoComponentes = 0;

  for (const componente of componentesNormalizados) {
    const costoUnitarioConsumo = await getCostoConsumoUnitarioProducto(componente.producto_id);
    costoComponentes += costoUnitarioConsumo * componente.cantidad;
  }

  const extras = normalizarCostosExtraProducto(costosExtra)
    .reduce((acc, item) => acc + Number(item.monto || 0), 0);
  const rendimiento = Math.max(1, Number(rendimientoReceta) || 1);
  const extrasPorPorcion = Number((extras / rendimiento).toFixed(4));
  return Number((costoComponentes + extrasPorPorcion).toFixed(2));
}

async function descontarStockFisicoProducto(productoId, producto, deltaCantidad, comoComponente = false) {
  if (Number(producto.maneja_stock) !== 1) {
    return;
  }

  let cantidadDescontar;
  if (comoComponente) {
    // Cuando es ingrediente de una receta, el delta ya viene en unidades correctas
    // NO aplicar el multiplicador de fracciones (cantidad_usada) — evita over-consumo en productos gr/ml
    cantidadDescontar = Number(deltaCantidad || 0);
  } else {
    const costos = await normalizarInsumosCostos(await allQuery(
      "SELECT * FROM producto_costos_insumos WHERE producto_id = ? ORDER BY id ASC",
      [productoId]
    ));
    cantidadDescontar = costos.length
      ? costos.reduce((acc, item) => acc + Number(item.cantidad_usada || 0), 0) * Number(deltaCantidad || 0)
      : Number(deltaCantidad || 0);
  }

  const stockAnterior = Number(producto.stock || 0);
  const stockNuevo = stockAnterior - cantidadDescontar;

  const config = await getConfiguracionGlobal();
  if (!config.stock_permitir_negativo && stockNuevo < 0) {
    throw new Error(`Stock insuficiente para el producto (id: ${productoId}). Disponible: ${stockAnterior}`);
  }

  await runQuery(
    "UPDATE productos SET stock = stock - ? WHERE id = ?",
    [cantidadDescontar, productoId]
  );

  const { fecha, hora } = getNowParts();
  await runQuery(
    `INSERT INTO movimientos_stock (producto_id, tipo_movimiento, cantidad, stock_anterior, stock_nuevo, motivo, usuario, fecha, hora)
     VALUES (?, 'venta', ?, ?, ?, 'Descuento por venta', 'admin', ?, ?)`,
    [productoId, cantidadDescontar, stockAnterior, stockNuevo, fecha, hora]
  );
}

async function descontarStockPropioProducto(productoId, producto, deltaCantidad, comoComponente = false) {
  return descontarStockFisicoProducto(productoId, producto, deltaCantidad, comoComponente);
}

async function applyStockChange(productoId, deltaCantidad, options = {}) {
  if (!productoId || deltaCantidad === 0) {
    return;
  }

  const visited = options.visited || new Set();
  const productoKey = Number(productoId);
  if (visited.has(productoKey)) {
    return;
  }
  visited.add(productoKey);

  const producto = await getQuery(
    "SELECT id, maneja_stock, tipo, es_combo, stock, rendimiento_receta FROM productos WHERE id = ?",
    [productoId]
  );

  if (!producto) {
    return;
  }

  if (esProductoReceta(producto)) {
    // Modo pre-armado: tiene stock propio → descuenta de sí mismo como producto simple
    if (Number(producto.maneja_stock) === 1) {
      await descontarStockFisicoProducto(productoId, producto, deltaCantidad, options.comoComponente || false);
      return;
    }

    // Receta sin stock propio: no mueve stock fisico en ventas ni anulaciones.
    // El consumo se audita como ajuste pendiente y se descuenta solo al aprobarlo.
    return;
  }

  await descontarStockFisicoProducto(productoId, producto, deltaCantidad, options.comoComponente || false);
}

async function applyStockForNewItems(items) {
  for (const item of items) {
    await applyStockChange(item.producto_id, item.cantidad);
  }
}

async function applyStockDiff(oldItems, newItems) {
  const deltaByProduct = new Map();

  for (const item of oldItems) {
    if (!item.producto_id) {
      continue;
    }

    const current = deltaByProduct.get(item.producto_id) || 0;
    deltaByProduct.set(item.producto_id, current - Number(item.cantidad || 0));
  }

  for (const item of newItems) {
    if (!item.producto_id) {
      continue;
    }

    const current = deltaByProduct.get(item.producto_id) || 0;
    deltaByProduct.set(item.producto_id, current + Number(item.cantidad || 0));
  }

  for (const [productoId, delta] of deltaByProduct.entries()) {
    await applyStockChange(productoId, delta);
  }
}

async function guardarRecetaSnapshotVenta(ventaId, detalles = []) {
  // ventaId debe ser explícito — los objetos detalle no siempre lo llevan
  if (!ventaId || !Array.isArray(detalles)) return;

  for (const detalle of detalles) {
    const detalleId = Number(detalle.id || detalle.detalle_venta_id || 0);
    if (!detalleId || !detalle.producto_id) continue;

    const producto = await getQuery(
      "SELECT tipo FROM productos WHERE id = ?",
      [Number(detalle.producto_id)]
    );
    if (!producto || normalizarTipoProducto(producto.tipo) !== "compuesto") continue;

    const componentes = await getComponentesProductoCompuesto(detalle.producto_id);
    if (!componentes.length) continue;

    const cantidadVendida = Number(detalle.cantidad || 1);

    for (const comp of componentes) {
      const costoUnitario = await getCostoConsumoUnitarioProducto(comp.producto_id, comp);
      const cantidadPorPorcion = Number(comp.cantidad || 0);
      const cantidadTotal = Number((cantidadPorPorcion * cantidadVendida).toFixed(4));

      await runQuery(
        `INSERT INTO detalle_venta_receta_snapshot
         (venta_id, detalle_venta_id, producto_vendido_id, componente_id,
          componente_nombre_snapshot, cantidad_por_porcion, cantidad_total, unidad,
          costo_unitario_snapshot, costo_total_snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          Number(ventaId),
          detalleId,
          Number(detalle.producto_id),
          Number(comp.producto_id),
          String(comp.producto_nombre || ""),
          Number(cantidadPorPorcion.toFixed(4)),
          cantidadTotal,
          String(comp.unidad_medida || "un"),
          Number(costoUnitario.toFixed(4)),
          Number((costoUnitario * cantidadTotal).toFixed(2))
        ]
      );
    }
  }
}

async function borrarRecetaSnapshotVenta(detalles = []) {
  const ids = detalles
    .map((d) => Number(d.detalle_venta_id ?? d.id ?? 0))
    .filter(Boolean);
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  await runQuery(
    `DELETE FROM detalle_venta_receta_snapshot WHERE detalle_venta_id IN (${placeholders})`,
    ids
  );
}

async function consolidarComponentesDuplicados() {
  const duplicados = await allQuery(
    `SELECT producto_compuesto_id, producto_id, SUM(cantidad) AS cantidad_total, COUNT(*) AS total_filas
     FROM producto_componentes
     GROUP BY producto_compuesto_id, producto_id
     HAVING total_filas > 1`
  );
  for (const dup of duplicados) {
    const filas = await allQuery(
      `SELECT id FROM producto_componentes
       WHERE producto_compuesto_id = ? AND producto_id = ?
       ORDER BY id ASC`,
      [Number(dup.producto_compuesto_id), Number(dup.producto_id)]
    );
    if (filas.length < 2) continue;
    await runQuery(
      `UPDATE producto_componentes SET cantidad = ? WHERE id = ?`,
      [Number(dup.cantidad_total), filas[0].id]
    );
    const restoIds = filas.slice(1).map((f) => Number(f.id));
    await runQuery(
      `DELETE FROM producto_componentes WHERE id IN (${restoIds.map(() => "?").join(",")})`,
      restoIds
    );
  }
  if (duplicados.length > 0) {
    console.log(`[stockService] Consolidados ${duplicados.length} grupos de componentes duplicados`);
  }
}

module.exports = {
  normalizarInsumosCostos,
  calcularCostoPorRendimiento,
  calcularStockPorRendimiento,
  guardarInsumosProducto,
  normalizarTipoProducto,
  esProductoReceta,
  normalizarComponentesProducto,
  normalizarCostosExtraProducto,
  consolidarComponentesDuplicados,
  guardarProductoCompuestoConfig,
  getComponentesProductoCompuesto,
  getCostosExtraProductoCompuesto,
  calcularStockDisponibleCompuesto,
  getCostoConsumoUnitarioProducto,
  calcularStockVendible,
  calcularStockVendibleFraccionado,
  calcularCostoProductoCompuesto,
  calcularCostoProductoCompuestoPayload,
  descontarStockFisicoProducto,
  descontarStockPropioProducto,
  applyStockChange,
  applyStockForNewItems,
  applyStockDiff,
  guardarRecetaSnapshotVenta,
  borrarRecetaSnapshotVenta
};
