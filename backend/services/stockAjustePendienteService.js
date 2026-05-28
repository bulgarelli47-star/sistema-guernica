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
      cuenta_local_costo_estimado REAL DEFAULT 0
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
    caja_id: row.caja_id === null || row.caja_id === undefined ? null : Number(row.caja_id),
    venta_id: row.venta_id === null || row.venta_id === undefined ? null : Number(row.venta_id),
    cantidad_resuelta: Number(row.cantidad_resuelta || 0),
    cantidad_pendiente_resolucion: Number(row.cantidad_pendiente_resolucion || 0),
    resolucion_parcial: Number(row.resolucion_parcial || 0),
    cuenta_local_costo_estimado: Number(row.cuenta_local_costo_estimado || 0)
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
    where.push("((sap.venta_id IS NULL AND COALESCE(sap.tipo_resolucion, '') = '') OR COALESCE(sap.resolucion_parcial, 0) = 1 OR COALESCE(sap.cantidad_pendiente_resolucion, 0) > 0)");
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
  const esBatch = esCompuesto && !Number(producto.maneja_stock) && Number(producto.rendimiento_receta || 1) > 1;
  const esStockCalculado = esCompuesto && !Number(producto.maneja_stock) && !esBatch;
  if (esStockCalculado) {
    throw crearError("Este producto no posee stock propio. Ajusta sus ingredientes.", 400);
  }

  const { fecha, hora } = getNowParts();
  const stockAnterior = Number(producto.stock || 0);
  const esIngreso = tipoMovimiento === "ingreso";
  const stockNuevo = esIngreso ? stockAnterior + cantidad : stockAnterior - cantidad;
  let stockFinal = stockNuevo;
  let batchesReponer = 0;

  if (esBatch && !esIngreso && stockNuevo <= 0) {
    const rendimiento = Number(producto.rendimiento_receta);
    let restante = stockNuevo;
    while (restante <= 0) {
      batchesReponer += 1;
      restante += rendimiento;
    }
    stockFinal = restante;
  }

  const movimiento = await runQuery(
    `INSERT INTO movimientos_stock
     (producto_id, tipo_movimiento, cantidad, stock_anterior, stock_nuevo, motivo, proveedor_id, usuario, fecha, hora)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [productoId, tipoMovimiento, cantidad, stockAnterior, stockFinal, motivo, proveedorId, usuario, fecha, hora]
  );
  await runQuery("UPDATE productos SET stock = ? WHERE id = ?", [stockFinal, productoId]);

  if (esBatch && batchesReponer > 0) {
    const rendimiento = Number(producto.rendimiento_receta);
    const componentes = await getComponentesProductoCompuesto(productoId);
    for (const comp of componentes) {
      const consumo = Number(comp.cantidad || 0) * rendimiento * batchesReponer;
      if (consumo <= 0) continue;
      const ing = await getQuery("SELECT stock FROM productos WHERE id = ?", [comp.producto_id]);
      if (!ing) continue;
      const nuevoStockIng = Number(ing.stock || 0) - consumo;
      await runQuery("UPDATE productos SET stock = ? WHERE id = ?", [nuevoStockIng, comp.producto_id]);
      await runQuery(
        `INSERT INTO movimientos_stock (producto_id, tipo_movimiento, cantidad, stock_anterior, stock_nuevo, motivo, usuario, fecha, hora)
         VALUES (?, 'egreso', ?, ?, ?, ?, ?, ?, ?)`,
        [
          comp.producto_id,
          consumo,
          Number(ing.stock || 0),
          nuevoStockIng,
          `Replenishment batch: ${producto.nombre} (${batchesReponer} lote/s)`,
          usuario,
          fecha,
          hora
        ]
      );
    }
  }

  if (esCompuesto && Number(producto.maneja_stock) && esIngreso) {
    const componentes = await getComponentesProductoCompuesto(productoId);
    for (const comp of componentes) {
      const consumo = cantidad * Number(comp.cantidad);
      const compProd = await getQuery(
        "SELECT tipo, maneja_stock, rendimiento_receta FROM productos WHERE id = ?",
        [comp.producto_id]
      );
      const esCompBatch = compProd
        && normalizarTipoProducto(compProd.tipo) === "compuesto"
        && !Number(compProd.maneja_stock)
        && Number(compProd.rendimiento_receta || 1) > 1;

      if (esCompBatch) {
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
              FROM stock_ajustes_pendientes
              WHERE estado = 'pendiente'
                AND ((venta_id IS NULL AND COALESCE(tipo_resolucion, '') = '') OR COALESCE(resolucion_parcial, 0) = 1 OR COALESCE(cantidad_pendiente_resolucion, 0) > 0)`),
    getQuery(`SELECT COUNT(*) AS total
              FROM stock_ajustes_pendientes
              WHERE estado = 'pendiente'
                AND venta_id IS NOT NULL
                AND COALESCE(resolucion_parcial, 0) = 0
                AND COALESCE(cantidad_pendiente_resolucion, 0) <= 0`),
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

module.exports = {
  ensureStockAjustesPendientesSchema,
  crearAjustePendiente,
  listarAjustesPendientes,
  reconciliarAjustesPendientes,
  obtenerAjustePendiente,
  aprobarAjustePendiente,
  rechazarAjustePendiente,
  resolverAjustePendienteConVenta,
  resolverAjustePendienteConCuentaLocal,
  getResumenAjustesPendientes
};
