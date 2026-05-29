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

  return componentes
    .map((item) => ({
      producto_id: Number(item.producto_id ?? item.id),
      cantidad: Number(item.cantidad) || 0
    }))
    .filter((item) => item.producto_id > 0 && item.cantidad > 0);
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

async function descontarComponentesReceta(productoId, deltaCantidad, visited) {
  const componentes = await getComponentesProductoCompuesto(productoId);

  if (!componentes.length) {
    return;
  }

  for (const componente of componentes) {
    await applyStockChange(
      componente.producto_id,
      Number(deltaCantidad || 0) * Number(componente.cantidad || 0),
      { comoComponente: true, visited: new Set(visited) }
    );
  }
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

    // Receta sin stock propio: nunca usa productos.stock como contador.
    // Siempre descuenta los componentes directos, sin importar rendimiento_receta.
    await descontarComponentesReceta(producto.id, deltaCantidad, visited);

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

module.exports = {
  normalizarInsumosCostos,
  calcularCostoPorRendimiento,
  calcularStockPorRendimiento,
  guardarInsumosProducto,
  normalizarTipoProducto,
  esProductoReceta,
  normalizarComponentesProducto,
  normalizarCostosExtraProducto,
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
  descontarComponentesReceta,
  applyStockChange,
  applyStockForNewItems,
  applyStockDiff
};
