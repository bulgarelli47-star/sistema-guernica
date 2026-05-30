const { allQuery, getQuery, runQuery } = require("../db");
const {
  applyStockChange,
  calcularCostoProductoCompuesto,
  getComponentesProductoCompuesto,
  normalizarTipoProducto
} = require("./stockService");
const { getConfiguracionGlobal } = require("./configService");

const TIPOS_MOVIMIENTO_VALIDOS = new Set(["ingreso", "egreso"]);
const ESTADOS_VALIDOS = new Set(["pendiente", "aprobado", "rechazado", "corregido"]);
const TIPOS_RESOLUCION_VALIDOS = new Set(["cobrar", "cuenta_corriente", "ajuste_stock", "perdida_interna", "rechazado", "cuenta_local"]);
const TIPOS_RESOLUCION_VENTA_VALIDOS = new Set(["cobrar", "cuenta_corriente", "ajuste_stock", "perdida_interna", "rechazado"]);
const ORIGEN_VENTA_RECETA = "venta_receta";
const ORIGEN_STOCK_NEGATIVO = "stock_negativo_venta";

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

function crearError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function configBool(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

async function ensureColumnStockAjustesPendientes(columnName, definition) {
  const columns = await allQuery("PRAGMA table_info(stock_ajustes_pendientes)");
  const exists = columns.some((column) => column.name === columnName);
  if (!exists) {
    await runQuery(`ALTER TABLE stock_ajustes_pendientes ADD COLUMN ${columnName} ${definition}`);
  }
}

function aplicarRedondeo(valor, redondeo) {
  const base = Number(redondeo) || 0;
  if (base <= 0) return Number(valor) || 0;
  return Math.ceil((Number(valor) || 0) / base) * base;
}

function calcularPrecioSugerido(costoFinal, margenPorcentaje, redondeo) {
  const costo = Number(costoFinal) || 0;
  const margen = Number(margenPorcentaje) || 0;
  return Number(aplicarRedondeo(costo * (1 + margen / 100), redondeo).toFixed(2));
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
      caja_id INTEGER,
      venta_id INTEGER,
      tipo_resolucion TEXT,
      fecha_resolucion TEXT,
      hora_resolucion TEXT,
      resuelto_por TEXT,
      cantidad_resuelta REAL DEFAULT 0,
      cantidad_pendiente_resolucion REAL DEFAULT 0,
      resolucion_parcial INTEGER DEFAULT 0,
      cuenta_local_integracion TEXT,
      cuenta_local_observacion TEXT,
      cuenta_local_responsable TEXT,
      cuenta_local_nombre_snapshot TEXT,
      cuenta_local_costo_estimado REAL DEFAULT 0,
      origen TEXT,
      detalle_venta_id INTEGER,
      producto_vendido_id INTEGER,
      producto_vendido_nombre_snapshot TEXT,
      componente_id INTEGER,
      cantidad_teorica REAL
    )
  `);

  await ensureColumnStockAjustesPendientes("venta_id", "INTEGER");
  await ensureColumnStockAjustesPendientes("tipo_resolucion", "TEXT");
  await ensureColumnStockAjustesPendientes("fecha_resolucion", "TEXT");
  await ensureColumnStockAjustesPendientes("hora_resolucion", "TEXT");
  await ensureColumnStockAjustesPendientes("resuelto_por", "TEXT");
  await ensureColumnStockAjustesPendientes("cantidad_resuelta", "REAL DEFAULT 0");
  await ensureColumnStockAjustesPendientes("cantidad_pendiente_resolucion", "REAL DEFAULT 0");
  await ensureColumnStockAjustesPendientes("resolucion_parcial", "INTEGER DEFAULT 0");
  await ensureColumnStockAjustesPendientes("cuenta_local_integracion", "TEXT");
  await ensureColumnStockAjustesPendientes("cuenta_local_observacion", "TEXT");
  await ensureColumnStockAjustesPendientes("cuenta_local_responsable", "TEXT");
  await ensureColumnStockAjustesPendientes("cuenta_local_nombre_snapshot", "TEXT");
  await ensureColumnStockAjustesPendientes("cuenta_local_costo_estimado", "REAL DEFAULT 0");
  await ensureColumnStockAjustesPendientes("origen", "TEXT");
  await ensureColumnStockAjustesPendientes("detalle_venta_id", "INTEGER");
  await ensureColumnStockAjustesPendientes("producto_vendido_id", "INTEGER");
  await ensureColumnStockAjustesPendientes("producto_vendido_nombre_snapshot", "TEXT");
  await ensureColumnStockAjustesPendientes("componente_id", "INTEGER");
  await ensureColumnStockAjustesPendientes("cantidad_teorica", "REAL");

  await runQuery("CREATE INDEX IF NOT EXISTS idx_stock_ajustes_pendientes_estado ON stock_ajustes_pendientes(estado)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_stock_ajustes_pendientes_producto ON stock_ajustes_pendientes(producto_id)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_stock_ajustes_pendientes_caja ON stock_ajustes_pendientes(caja_id)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_stock_ajustes_pendientes_venta_origen ON stock_ajustes_pendientes(venta_id, origen)");
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
    caja_id: row.caja_id === null || row.caja_id === undefined ? null : Number(row.caja_id),
    venta_id: row.venta_id === null || row.venta_id === undefined ? null : Number(row.venta_id),
    cantidad_resuelta: Number(row.cantidad_resuelta || 0),
    cantidad_pendiente_resolucion: Number(row.cantidad_pendiente_resolucion || 0),
    resolucion_parcial: Number(row.resolucion_parcial || 0),
    cuenta_local_costo_estimado: Number(row.cuenta_local_costo_estimado || 0),
    detalle_venta_id: row.detalle_venta_id === null || row.detalle_venta_id === undefined ? null : Number(row.detalle_venta_id),
    producto_vendido_id: row.producto_vendido_id === null || row.producto_vendido_id === undefined ? null : Number(row.producto_vendido_id),
    componente_id: row.componente_id === null || row.componente_id === undefined ? null : Number(row.componente_id),
    cantidad_teorica: row.cantidad_teorica === null || row.cantidad_teorica === undefined ? null : Number(row.cantidad_teorica)
  };
}

function round2(valor) {
  return Number((Number(valor) || 0).toFixed(2));
}

const AJUSTE_ACCIONABLE_SQL = `(
  (COALESCE(sap.origen, '') = '${ORIGEN_VENTA_RECETA}')
  OR (COALESCE(sap.origen, '') = '${ORIGEN_STOCK_NEGATIVO}')
  OR (sap.venta_id IS NULL AND COALESCE(sap.tipo_resolucion, '') = '')
  OR COALESCE(sap.resolucion_parcial, 0) = 1
  OR COALESCE(sap.cantidad_pendiente_resolucion, 0) > 0
)`;

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

async function acumularComponenteFisico(productoId, cantidad, acumulado, visited = new Set()) {
  const componenteId = Number(productoId);
  const cantidadNumero = Number(cantidad || 0);
  if (!componenteId || !Number.isFinite(cantidadNumero) || Math.abs(cantidadNumero) <= 0.0001) {
    return;
  }

  if (visited.has(componenteId)) {
    return;
  }

  const producto = await getQuery(
    "SELECT id, nombre, stock, tipo, maneja_stock FROM productos WHERE id = ?",
    [componenteId]
  );
  if (!producto) return;

  const esRecetaSinStock = normalizarTipoProducto(producto.tipo) === "compuesto" && !Number(producto.maneja_stock);
  if (esRecetaSinStock) {
    const componentes = await getComponentesProductoCompuesto(componenteId);
    if (!componentes.length) {
      return;
    }

    const nextVisited = new Set(visited);
    nextVisited.add(componenteId);
    for (const componente of componentes) {
      await acumularComponenteFisico(
        componente.producto_id,
        cantidadNumero * Number(componente.cantidad || 0),
        acumulado,
        nextVisited
      );
    }
    return;
  }

  const actual = acumulado.get(componenteId) || {
    producto,
    cantidad: 0
  };
  actual.cantidad += cantidadNumero;
  acumulado.set(componenteId, actual);
}

async function crearAjustesPendientesVentaReceta({
  ventaId,
  detalles = [],
  usuario,
  rol
} = {}) {
  await ensureStockAjustesPendientesSchema();

  const venta = normalizarId(ventaId);
  if (!venta || !Array.isArray(detalles) || !detalles.length) {
    return [];
  }

  const creados = [];
  const { fecha, hora } = getNowParts();
  const solicitadoPor = normalizarTexto(usuario) || "admin";
  const solicitadoRol = normalizarTexto(rol);

  for (const detalle of detalles) {
    const productoVendidoId = normalizarId(detalle.producto_id);
    const detalleVentaId = normalizarId(detalle.detalle_venta_id ?? detalle.id);
    const cantidadVendida = Number(detalle.cantidad || 0);
    if (!productoVendidoId || !detalleVentaId || cantidadVendida <= 0) continue;

    const productoVendido = await getQuery(
      "SELECT id, nombre, tipo, maneja_stock FROM productos WHERE id = ?",
      [productoVendidoId]
    );
    const esRecetaSinStock = productoVendido
      && normalizarTipoProducto(productoVendido.tipo) === "compuesto"
      && !Number(productoVendido.maneja_stock);
    if (!esRecetaSinStock) continue;

    const acumulado = new Map();
    const componentesBase = await getComponentesProductoCompuesto(productoVendidoId);
    for (const componente of componentesBase) {
      await acumularComponenteFisico(
        componente.producto_id,
        cantidadVendida * Number(componente.cantidad || 0),
        acumulado,
        new Set([productoVendidoId])
      );
    }

    for (const componente of Array.isArray(detalle.componentes) ? detalle.componentes : []) {
      const efecto = componente.operacion === "quitar" ? -1 : 1;
      await acumularComponenteFisico(
        componente.producto_id,
        efecto * Number(componente.cantidad || 0),
        acumulado,
        new Set([productoVendidoId])
      );
    }

    for (const [componenteId, item] of acumulado.entries()) {
      const cantidadTeorica = Number(Number(item.cantidad || 0).toFixed(4));
      if (cantidadTeorica <= 0) continue;

      const result = await runQuery(
        `INSERT INTO stock_ajustes_pendientes
         (producto_id, componente_id, tipo_movimiento, cantidad, cantidad_teorica,
          motivo, observaciones, proveedor_id, stock_actual_snapshot, estado,
          solicitado_por, solicitado_rol, fecha, hora, created_at, caja_id,
          venta_id, detalle_venta_id, producto_vendido_id, producto_vendido_nombre_snapshot, origen)
         VALUES (?, ?, 'egreso', ?, ?, ?, ?, NULL, ?, 'pendiente',
                 ?, ?, ?, ?, datetime('now'), NULL, ?, ?, ?, ?, ?)`,
        [
          componenteId,
          componenteId,
          cantidadTeorica,
          cantidadTeorica,
          `Consumo teorico venta receta: ${productoVendido.nombre || detalle.nombre_producto || productoVendidoId}`,
          `Venta #${venta} detalle #${detalleVentaId}`,
          Number(item.producto.stock || 0),
          solicitadoPor,
          solicitadoRol,
          fecha,
          hora,
          venta,
          detalleVentaId,
          productoVendidoId,
          normalizarTexto(productoVendido.nombre || detalle.nombre_producto),
          ORIGEN_VENTA_RECETA
        ]
      );
      creados.push(await obtenerAjustePendiente(result.lastID));
    }
  }

  return creados;
}

async function cancelarAjustesPendientesVentaReceta(ventaId, {
  usuario,
  observaciones_admin
} = {}) {
  await ensureStockAjustesPendientesSchema();

  const venta = normalizarId(ventaId);
  if (!venta) {
    return { cancelados: 0 };
  }

  const result = await runQuery(
    `UPDATE stock_ajustes_pendientes
     SET estado = 'rechazado', revisado_por = ?, revisado_at = datetime('now'),
         observaciones_admin = ?
     WHERE venta_id = ?
       AND origen = ?
       AND estado = 'pendiente'`,
    [
      normalizarTexto(usuario) || "admin",
      normalizarTexto(observaciones_admin) || "Cancelado por anulacion o reemplazo de venta",
      venta,
      ORIGEN_VENTA_RECETA
    ]
  );

  return { cancelados: Number(result?.changes || 0) };
}

async function listarAjustesPendientes({ estado, solo_accionables = false } = {}) {
  await ensureStockAjustesPendientesSchema();
  const estadoNormalizado = normalizarTexto(estado).toLowerCase();
  const filtrarEstado = ESTADOS_VALIDOS.has(estadoNormalizado);
  const where = [];
  const params = [];
  if (filtrarEstado) {
    where.push("sap.estado = ?");
    params.push(estadoNormalizado);
  }
  if (solo_accionables) {
    where.push(AJUSTE_ACCIONABLE_SQL);
  }
  const rows = await allQuery(
    `SELECT sap.*, p.nombre AS producto_nombre
     FROM stock_ajustes_pendientes sap
     LEFT JOIN productos p ON p.id = sap.producto_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY sap.id DESC`,
    params
  );
  return rows.map(mapAjuste);
}

async function reconciliarAjustesPendientes({ ids = [], usuario, puedeGestionar = false } = {}) {
  await ensureStockAjustesPendientesSchema();
  const idsNormalizados = [...new Set((Array.isArray(ids) ? ids : [])
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0))]
    .slice(0, 80);

  if (!idsNormalizados.length) {
    return [];
  }

  const params = [...idsNormalizados];
  const where = [`sap.id IN (${idsNormalizados.map(() => "?").join(",")})`];
  if (!puedeGestionar) {
    where.push("trim(COALESCE(sap.solicitado_por, '')) = trim(?)");
    params.push(normalizarTexto(usuario));
  }

  const rows = await allQuery(
    `SELECT sap.id, sap.estado, sap.producto_id
     FROM stock_ajustes_pendientes sap
     WHERE ${where.join(" AND ")}
     ORDER BY sap.id DESC`,
    params
  );

  return rows.map((row) => ({
    id: Number(row.id),
    estado: row.estado,
    producto_id: Number(row.producto_id)
  }));
}

async function registrarMovimientoStockAprobado({
  productoId,
  tipoMovimiento,
  cantidad,
  motivo,
  proveedorId,
  usuario
}) {
  const producto = await getQuery("SELECT * FROM productos WHERE id = ?", [productoId]);
  if (!producto) {
    throw crearError("Producto no encontrado", 404);
  }

  const esCompuesto = normalizarTipoProducto(producto.tipo) === "compuesto";
  const esRecetaSinStockFisico = esCompuesto && !Number(producto.maneja_stock);
  if (esRecetaSinStockFisico) {
    throw crearError("Este producto no posee stock propio. Ajusta sus ingredientes.", 400);
  }

  const { fecha, hora } = getNowParts();
  const stockAnterior = Number(producto.stock || 0);
  const esIngreso = tipoMovimiento === "ingreso";
  const stockNuevo = esIngreso ? stockAnterior + cantidad : stockAnterior - cantidad;
  const stockFinal = stockNuevo;

  const movimiento = await runQuery(
    `INSERT INTO movimientos_stock
     (producto_id, tipo_movimiento, cantidad, stock_anterior, stock_nuevo, motivo, proveedor_id, usuario, fecha, hora)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [productoId, tipoMovimiento, cantidad, stockAnterior, stockFinal, motivo, proveedorId, usuario, fecha, hora]
  );
  await runQuery("UPDATE productos SET stock = ? WHERE id = ?", [stockFinal, productoId]);

  if (esCompuesto && Number(producto.maneja_stock) && esIngreso) {
    const componentes = await getComponentesProductoCompuesto(productoId);
    for (const comp of componentes) {
      const consumo = cantidad * Number(comp.cantidad);
      const compProd = await getQuery(
        "SELECT tipo, maneja_stock, rendimiento_receta FROM productos WHERE id = ?",
        [comp.producto_id]
      );
      const esCompuestoSinStock = compProd
        && normalizarTipoProducto(compProd.tipo) === "compuesto"
        && !Number(compProd.maneja_stock);

      if (esCompuestoSinStock) {
        await applyStockChange(comp.producto_id, consumo);
      } else {
        const ing = await getQuery("SELECT stock FROM productos WHERE id = ?", [comp.producto_id]);
        if (!ing) continue;
        const nuevoStockIng = Math.max(0, Number(ing.stock || 0) - consumo);
        await runQuery("UPDATE productos SET stock = ? WHERE id = ?", [nuevoStockIng, comp.producto_id]);
        await runQuery(
          `INSERT INTO movimientos_stock (producto_id, tipo_movimiento, cantidad, stock_anterior, stock_nuevo, motivo, usuario, fecha, hora)
           VALUES (?, 'egreso', ?, ?, ?, ?, ?, ?, ?)`,
          [comp.producto_id, consumo, Number(ing.stock || 0), nuevoStockIng, `Consumo receta: ${producto.nombre}`, usuario, fecha, hora]
        );
      }
    }
  }

  if (esCompuesto) {
    const categoria = producto.categoria_id
      ? await getQuery("SELECT margen_porcentaje FROM categorias WHERE id = ?", [producto.categoria_id])
      : null;
    const costoCompuesto = await calcularCostoProductoCompuesto(productoId);
    const sugeridoAnterior = calcularPrecioSugerido(
      Number(producto.costo_final || producto.precio_compra || 0),
      Number(categoria?.margen_porcentaje || 0),
      producto.redondeo
    );
    const sugeridoNuevo = calcularPrecioSugerido(
      costoCompuesto,
      Number(categoria?.margen_porcentaje || 0),
      producto.redondeo
    );
    const precioActual = Number(producto.precio_venta || 0);
    const sigueSugerido = precioActual <= 0 || Math.abs(precioActual - sugeridoAnterior) < 0.01;
    await runQuery(
      `UPDATE productos
       SET precio_compra = ?, costo_final = ?, precio_venta = ?
       WHERE id = ?`,
      [costoCompuesto, costoCompuesto, sigueSugerido ? sugeridoNuevo : precioActual, productoId]
    );
  }

  return {
    movimiento_stock_id: movimiento.lastID,
    stock_anterior: stockAnterior,
    stock_nuevo: stockFinal
  };
}

async function aprobarAjustePendiente(id, {
  usuario,
  cantidad_aprobada,
  tipo_movimiento_aprobado,
  observaciones_admin
} = {}) {
  await ensureStockAjustesPendientesSchema();

  await runQuery("BEGIN TRANSACTION");
  try {
    const ajuste = await getQuery("SELECT * FROM stock_ajustes_pendientes WHERE id = ?", [Number(id)]);
    if (!ajuste) throw crearError("Ajuste pendiente no encontrado", 404);
    if (ajuste.estado !== "pendiente") throw crearError("El ajuste pendiente ya fue revisado", 409);

    const cantidadOriginal = Number(ajuste.cantidad || 0);
    const tipoOriginal = normalizarTexto(ajuste.tipo_movimiento).toLowerCase();
    const cantidadAprobada = cantidad_aprobada === undefined || cantidad_aprobada === null || cantidad_aprobada === ""
      ? cantidadOriginal
      : Number(cantidad_aprobada);
    const tipoAprobado = normalizarTexto(tipo_movimiento_aprobado || tipoOriginal).toLowerCase();

    if (!Number.isFinite(cantidadAprobada) || cantidadAprobada <= 0) {
      throw crearError("Cantidad aprobada invalida", 400);
    }
    if (!TIPOS_MOVIMIENTO_VALIDOS.has(tipoAprobado)) {
      throw crearError("Tipo de movimiento aprobado invalido", 400);
    }

    const corregido = Math.abs(cantidadAprobada - cantidadOriginal) > 0.0001 || tipoAprobado !== tipoOriginal;
    const motivo = [
      "Ajuste pendiente aprobado",
      ajuste.motivo,
      observaciones_admin
    ].map(normalizarTexto).filter(Boolean).join(" | ");
    const movimiento = await registrarMovimientoStockAprobado({
      productoId: Number(ajuste.producto_id),
      tipoMovimiento: tipoAprobado,
      cantidad: cantidadAprobada,
      motivo,
      proveedorId: normalizarId(ajuste.proveedor_id),
      usuario: normalizarTexto(usuario) || "admin"
    });

    await runQuery(
      `UPDATE stock_ajustes_pendientes
       SET estado = ?, revisado_por = ?, revisado_at = datetime('now'),
           cantidad_aprobada = ?, tipo_movimiento_aprobado = ?,
           observaciones_admin = ?, movimiento_stock_id = ?
       WHERE id = ? AND estado = 'pendiente'`,
      [
        corregido ? "corregido" : "aprobado",
        normalizarTexto(usuario) || "admin",
        cantidadAprobada,
        tipoAprobado,
        normalizarTexto(observaciones_admin),
        movimiento.movimiento_stock_id,
        Number(id)
      ]
    );

    await runQuery("COMMIT");
    return obtenerAjustePendiente(id);
  } catch (error) {
    try {
      await runQuery("ROLLBACK");
    } catch {}
    throw error;
  }
}

async function rechazarAjustePendiente(id, {
  usuario,
  observaciones_admin
} = {}) {
  await ensureStockAjustesPendientesSchema();

  await runQuery("BEGIN TRANSACTION");
  try {
    const ajuste = await getQuery("SELECT * FROM stock_ajustes_pendientes WHERE id = ?", [Number(id)]);
    if (!ajuste) throw crearError("Ajuste pendiente no encontrado", 404);
    if (ajuste.estado !== "pendiente") throw crearError("El ajuste pendiente ya fue revisado", 409);

    await runQuery(
      `UPDATE stock_ajustes_pendientes
       SET estado = 'rechazado', revisado_por = ?, revisado_at = datetime('now'),
           observaciones_admin = ?
       WHERE id = ? AND estado = 'pendiente'`,
      [normalizarTexto(usuario) || "admin", normalizarTexto(observaciones_admin), Number(id)]
    );

    await runQuery("COMMIT");
    return obtenerAjustePendiente(id);
  } catch (error) {
    try {
      await runQuery("ROLLBACK");
    } catch {}
    throw error;
  }
}

async function resolverAjustePendienteConVenta(id, {
  venta_id,
  tipo_resolucion,
  usuario
} = {}) {
  await ensureStockAjustesPendientesSchema();

  const ajusteId = Number(id);
  const ventaId = normalizarId(venta_id);
  const tipoResolucion = normalizarTexto(tipo_resolucion).toLowerCase();

  if (!ventaId) {
    throw crearError("Venta invalida", 400);
  }

  if (!TIPOS_RESOLUCION_VENTA_VALIDOS.has(tipoResolucion)) {
    throw crearError("Tipo de resolucion invalido", 400);
  }

  await runQuery("BEGIN TRANSACTION");
  try {
    const ajuste = await getQuery("SELECT * FROM stock_ajustes_pendientes WHERE id = ?", [ajusteId]);
    if (!ajuste) throw crearError("Ajuste pendiente no encontrado", 404);
    if (ajuste.estado !== "pendiente") throw crearError("El ajuste pendiente ya fue revisado", 409);
    if (Number(ajuste.venta_id) === ventaId) throw crearError("El ajuste pendiente ya tiene esta venta vinculada", 409);

    const cantidadOriginal = Number(ajuste.cantidad || 0);
    const cantidadYaResuelta = Number(ajuste.cantidad_resuelta || 0);
    const pendienteActual = Math.max(0, cantidadOriginal - cantidadYaResuelta);
    if (ajuste.venta_id && pendienteActual <= 0) {
      throw crearError("El ajuste pendiente ya tiene una venta vinculada", 409);
    }

    const venta = await getQuery("SELECT id FROM ventas WHERE id = ?", [ventaId]);
    if (!venta) throw crearError("Venta no encontrada", 404);

    const detalleVenta = await getQuery(
      `SELECT COALESCE(SUM(cantidad), 0) AS total
       FROM detalle_ventas
       WHERE venta_id = ? AND producto_id = ?`,
      [ventaId, Number(ajuste.producto_id)]
    );
    const cantidadVendida = Number(detalleVenta?.total || 0);
    if (!Number.isFinite(cantidadVendida) || cantidadVendida <= 0) {
      throw crearError("La venta no incluye cantidad para el producto del ajuste", 400);
    }

    const cantidadResuelta = Math.min(cantidadOriginal, cantidadYaResuelta + cantidadVendida);
    const cantidadPendienteResolucion = Math.max(0, cantidadOriginal - cantidadResuelta);
    const resolucionParcial = cantidadResuelta > 0 && cantidadPendienteResolucion > 0 ? 1 : 0;

    const { fecha, hora } = getNowParts();
    await runQuery(
      `UPDATE stock_ajustes_pendientes
       SET venta_id = ?, tipo_resolucion = ?, fecha_resolucion = ?, hora_resolucion = ?, resuelto_por = ?,
           cantidad_resuelta = ?, cantidad_pendiente_resolucion = ?, resolucion_parcial = ?
       WHERE id = ? AND estado = 'pendiente'`,
      [
        ventaId,
        tipoResolucion,
        fecha,
        hora,
        normalizarTexto(usuario) || "admin",
        cantidadResuelta,
        cantidadPendienteResolucion,
        resolucionParcial,
        ajusteId
      ]
    );

    await runQuery("COMMIT");
    return obtenerAjustePendiente(ajusteId);
  } catch (error) {
    try {
      await runQuery("ROLLBACK");
    } catch {}
    throw error;
  }
}

async function calcularCostoEstimadoCuentaLocal(productoId, cantidad) {
  const costoInsumo = await getQuery(
    `SELECT costo_unitario
     FROM producto_costos_insumos
     WHERE producto_id = ? AND COALESCE(costo_unitario, 0) > 0
     ORDER BY id ASC
     LIMIT 1`,
    [productoId]
  ).catch(() => null);
  if (costoInsumo) {
    return Number((Number(costoInsumo.costo_unitario || 0) * cantidad).toFixed(2));
  }

  const producto = await getQuery(
    "SELECT costo_final, precio_compra FROM productos WHERE id = ?",
    [productoId]
  );
  const costoUnitario = Number(producto?.costo_final || producto?.precio_compra || 0);
  return Number((costoUnitario * cantidad).toFixed(2));
}

async function resolverAjustePendienteConCuentaLocal(id, {
  integracion,
  responsable,
  observacion,
  usuario
} = {}) {
  await ensureStockAjustesPendientesSchema();

  const config = await getConfiguracionGlobal();
  if (!configBool(config.cuenta_local_activa)) {
    throw crearError("Cuenta Local no esta activa", 400);
  }

  const integracionNormalizada = normalizarTexto(integracion).toLowerCase();
  const integracionesValidas = new Set(["produccion", "interno_cortesia"]);
  if (!integracionesValidas.has(integracionNormalizada)) {
    throw crearError("Integracion de Cuenta Local invalida", 400);
  }
  if (integracionNormalizada === "produccion" && !configBool(config.cuenta_local_produccion_activa)) {
    throw crearError("La integracion Produccion no esta habilitada", 400);
  }
  if (integracionNormalizada === "interno_cortesia" && !configBool(config.cuenta_local_interno_cortesia_activa)) {
    throw crearError("La integracion Interno / cortesia no esta habilitada", 400);
  }

  const ajusteId = Number(id);
  const responsableNormalizado = normalizarTexto(responsable);
  const observacionNormalizada = normalizarTexto(observacion);
  const usuarioNormalizado = normalizarTexto(usuario) || "admin";
  const cuentaLocalNombre = normalizarTexto(config.cuenta_local_nombre || config.negocio_nombre_comercial) || "Cuenta Local";

  await runQuery("BEGIN TRANSACTION");
  try {
    const ajuste = await getQuery(
      `SELECT sap.*, p.nombre AS producto_nombre, p.tipo AS producto_tipo, p.maneja_stock AS producto_maneja_stock
       FROM stock_ajustes_pendientes sap
       LEFT JOIN productos p ON p.id = sap.producto_id
       WHERE sap.id = ?`,
      [ajusteId]
    );
    if (!ajuste) throw crearError("Ajuste pendiente no encontrado", 404);
    if (ajuste.estado !== "pendiente") throw crearError("El ajuste pendiente ya fue revisado", 409);
    if (normalizarTexto(ajuste.tipo_movimiento).toLowerCase() !== "egreso") {
      throw crearError("Cuenta Local solo puede resolver egresos de stock", 400);
    }
    if (Number(ajuste.venta_id) > 0 || normalizarTexto(ajuste.tipo_resolucion)) {
      throw crearError("El ajuste pendiente ya tiene una resolucion operativa", 409);
    }

    const manejaStock = Number(ajuste.producto_maneja_stock) === 1;
    const esRecetaSinStock = normalizarTipoProducto(ajuste.producto_tipo) === "compuesto" && !manejaStock;
    if (esRecetaSinStock || !manejaStock) {
      throw crearError("Este producto no tiene stock fisico. Ajusta sus insumos.", 400);
    }

    const cantidad = Number(ajuste.cantidad || 0);
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      throw crearError("Cantidad invalida", 400);
    }

    const motivo = [
      "Cuenta Local / absorbida por el negocio",
      integracionNormalizada === "produccion" ? "Produccion" : "Interno / cortesia",
      ajuste.motivo,
      observacionNormalizada
    ].map(normalizarTexto).filter(Boolean).join(" | ");
    const movimiento = await registrarMovimientoStockAprobado({
      productoId: Number(ajuste.producto_id),
      tipoMovimiento: "egreso",
      cantidad,
      motivo,
      proveedorId: normalizarId(ajuste.proveedor_id),
      usuario: usuarioNormalizado
    });
    const costoEstimado = await calcularCostoEstimadoCuentaLocal(Number(ajuste.producto_id), cantidad);
    const { fecha, hora } = getNowParts();

    await runQuery(
      `UPDATE stock_ajustes_pendientes
       SET estado = 'aprobado',
           revisado_por = ?,
           revisado_at = datetime('now'),
           cantidad_aprobada = ?,
           tipo_movimiento_aprobado = 'egreso',
           observaciones_admin = ?,
           movimiento_stock_id = ?,
           tipo_resolucion = 'cuenta_local',
           fecha_resolucion = ?,
           hora_resolucion = ?,
           resuelto_por = ?,
           cantidad_resuelta = ?,
           cantidad_pendiente_resolucion = 0,
           resolucion_parcial = 0,
           cuenta_local_integracion = ?,
           cuenta_local_observacion = ?,
           cuenta_local_responsable = ?,
           cuenta_local_nombre_snapshot = ?,
           cuenta_local_costo_estimado = ?
       WHERE id = ? AND estado = 'pendiente'`,
      [
        usuarioNormalizado,
        cantidad,
        observacionNormalizada,
        movimiento.movimiento_stock_id,
        fecha,
        hora,
        usuarioNormalizado,
        cantidad,
        integracionNormalizada,
        observacionNormalizada,
        responsableNormalizado,
        cuentaLocalNombre,
        costoEstimado,
        ajusteId
      ]
    );

    await runQuery("COMMIT");
    return obtenerAjustePendiente(ajusteId);
  } catch (error) {
    try {
      await runQuery("ROLLBACK");
    } catch {}
    throw error;
  }
}

async function getResumenAjustesPendientes() {
  await ensureStockAjustesPendientesSchema();
  const hoy = new Date().toISOString().slice(0, 10);
  const [rowPendientes, rowResueltosPorVenta, rowAprobados, rowRechazados] = await Promise.all([
    getQuery(`SELECT COUNT(*) AS total
              FROM stock_ajustes_pendientes sap
              WHERE estado = 'pendiente'
                AND ${AJUSTE_ACCIONABLE_SQL}`),
    getQuery(`SELECT COUNT(*) AS total
              FROM stock_ajustes_pendientes
              WHERE estado = 'pendiente'
                AND venta_id IS NOT NULL
                AND COALESCE(origen, '') != ?
                AND COALESCE(resolucion_parcial, 0) = 0
                AND COALESCE(cantidad_pendiente_resolucion, 0) <= 0`,
      [ORIGEN_VENTA_RECETA]
    ),
    getQuery(
      "SELECT COUNT(*) AS total FROM stock_ajustes_pendientes WHERE estado IN ('aprobado', 'corregido') AND date(revisado_at) = ?",
      [hoy]
    ),
    getQuery(
      "SELECT COUNT(*) AS total FROM stock_ajustes_pendientes WHERE estado = 'rechazado' AND date(revisado_at) = ?",
      [hoy]
    )
  ]);
  return {
    pendientes: Number(rowPendientes?.total || 0),
    pendientes_accionables: Number(rowPendientes?.total || 0),
    resueltos_por_venta: Number(rowResueltosPorVenta?.total || 0),
    aprobados_hoy: Number(rowAprobados?.total || 0),
    rechazados_hoy: Number(rowRechazados?.total || 0)
  };
}

async function getResumenCuentaLocalNoMonetaria({ desde = null, hasta = null, limite = 8 } = {}) {
  await ensureStockAjustesPendientesSchema();

  const base = {
    produccion: {
      movimientos: 0,
      unidades: 0,
      costo_estimado: 0
    },
    interno_cortesia: {
      movimientos: 0,
      unidades: 0,
      costo_estimado: 0
    },
    total_absorbido: 0,
    movimientos_recientes: []
  };

  const where = [
    "sap.tipo_resolucion = 'cuenta_local'",
    "sap.estado IN ('aprobado', 'corregido')"
  ];
  const params = [];

  if (desde) {
    where.push("sap.fecha_resolucion >= ?");
    params.push(String(desde).slice(0, 10));
  }

  if (hasta) {
    where.push("sap.fecha_resolucion <= ?");
    params.push(String(hasta).slice(0, 10));
  }

  const whereSql = where.join(" AND ");
  const limiteSeguro = Math.min(Math.max(Number(limite) || 8, 1), 50);
  const [resumenRows, recientesRows] = await Promise.all([
    allQuery(
      `SELECT
         COALESCE(sap.cuenta_local_integracion, 'interno_cortesia') AS integracion,
         COUNT(*) AS movimientos,
         COALESCE(SUM(COALESCE(sap.cantidad_aprobada, sap.cantidad, 0)), 0) AS unidades,
         COALESCE(SUM(COALESCE(sap.cuenta_local_costo_estimado, 0)), 0) AS costo_estimado
       FROM stock_ajustes_pendientes sap
       WHERE ${whereSql}
       GROUP BY COALESCE(sap.cuenta_local_integracion, 'interno_cortesia')`,
      params
    ),
    allQuery(
      `SELECT
         sap.fecha_resolucion AS fecha,
         sap.hora_resolucion AS hora,
         COALESCE(p.nombre, sap.producto_id) AS producto_nombre,
         COALESCE(sap.cantidad_aprobada, sap.cantidad, 0) AS cantidad,
         COALESCE(sap.cuenta_local_integracion, 'interno_cortesia') AS integracion,
         sap.cuenta_local_responsable AS responsable,
         sap.cuenta_local_observacion AS observacion,
         COALESCE(sap.cuenta_local_costo_estimado, 0) AS costo_estimado,
         sap.resuelto_por
       FROM stock_ajustes_pendientes sap
       LEFT JOIN productos p ON p.id = sap.producto_id
       WHERE ${whereSql}
       ORDER BY sap.fecha_resolucion DESC, sap.hora_resolucion DESC, sap.id DESC
       LIMIT ?`,
      [...params, limiteSeguro]
    )
  ]);

  resumenRows.forEach((row) => {
    const key = row.integracion === "produccion" ? "produccion" : "interno_cortesia";
    base[key] = {
      movimientos: Number(row.movimientos || 0),
      unidades: round2(row.unidades),
      costo_estimado: round2(row.costo_estimado)
    };
  });

  base.total_absorbido = round2(base.produccion.costo_estimado + base.interno_cortesia.costo_estimado);
  base.movimientos_recientes = recientesRows.map((row) => ({
    fecha: row.fecha || null,
    hora: row.hora || null,
    producto_nombre: row.producto_nombre || "",
    cantidad: round2(row.cantidad),
    integracion: row.integracion === "produccion" ? "produccion" : "interno_cortesia",
    responsable: row.responsable || "",
    observacion: row.observacion || "",
    costo_estimado: round2(row.costo_estimado),
    resuelto_por: row.resuelto_por || ""
  }));

  return base;
}

async function crearAjustePendienteStockNegativo({
  productoId,
  cantidad,
  ventaId,
  stockAnterior,
  stockNuevo,
  usuario
}) {
  await ensureStockAjustesPendientesSchema();
  const pid = normalizarId(productoId);
  const vid = normalizarId(ventaId);
  if (!pid || !Number.isFinite(Number(cantidad)) || Number(cantidad) <= 0) return;

  if (vid) {
    const existente = await getQuery(
      `SELECT id FROM stock_ajustes_pendientes
       WHERE venta_id = ? AND producto_id = ? AND origen = '${ORIGEN_STOCK_NEGATIVO}' AND estado = 'pendiente'`,
      [vid, pid]
    );
    if (existente) return;
  }

  const { fecha, hora } = getNowParts();
  await runQuery(
    `INSERT INTO stock_ajustes_pendientes
     (producto_id, tipo_movimiento, cantidad, motivo, observaciones,
      stock_actual_snapshot, estado, solicitado_por, solicitado_rol, fecha, hora,
      created_at, venta_id, origen)
     VALUES (?, 'ingreso', ?, ?, ?, ?, 'pendiente', 'sistema', 'sistema', ?, ?, datetime('now'), ?, '${ORIGEN_STOCK_NEGATIVO}')`,
    [
      pid,
      round2(Number(cantidad)),
      "Stock negativo generado por venta",
      `Stock anterior: ${Number(stockAnterior || 0).toFixed(2)}. Stock negativo: ${Number(stockNuevo || 0).toFixed(2)}. Requiere ingreso correctivo.${vid ? " Venta #" + vid + "." : ""}`,
      round2(Number(stockAnterior || 0)),
      fecha,
      hora,
      vid
    ]
  );
}

module.exports = {
  ensureStockAjustesPendientesSchema,
  crearAjustePendiente,
  crearAjustePendienteStockNegativo,
  crearAjustesPendientesVentaReceta,
  cancelarAjustesPendientesVentaReceta,
  listarAjustesPendientes,
  reconciliarAjustesPendientes,
  obtenerAjustePendiente,
  aprobarAjustePendiente,
  rechazarAjustePendiente,
  resolverAjustePendienteConVenta,
  resolverAjustePendienteConCuentaLocal,
  getResumenAjustesPendientes,
  getResumenCuentaLocalNoMonetaria
};
