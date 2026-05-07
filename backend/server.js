const express = require("express");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const { runQuery, getQuery, allQuery } = require("./db");
const {
  CONFIGURACION_DEFAULTS,
  getConfiguracionGlobal,
  parsearConfigValor,
  requirePermiso,
  serializarConfigValor,
  tienePermisoAccion
} = require("./services/configService");
const {
  normalizarInsumosCostos,
  calcularCostoPorRendimiento,
  guardarInsumosProducto,
  normalizarTipoProducto,
  guardarProductoCompuestoConfig,
  getComponentesProductoCompuesto,
  getCostosExtraProductoCompuesto,
  calcularStockDisponibleCompuesto,
  calcularCostoProductoCompuesto,
  calcularCostoProductoCompuestoPayload,
  applyStockChange,
  applyStockForNewItems,
  applyStockDiff
} = require("./services/stockService");
const {
  buildCajaArqueoData,
  buildCajaResumenConSaldoMp,
  buildCajaSnapshot,
  buildConteoBilletes,
  ensureCajaArqueosTable,
  ensureCajaMovimientosTable,
  getCajaAbiertaActual,
  getCajaParaArqueos,
  getPagosCaja,
  getUltimaCajaRegistrada,
  mapCajaArqueo,
  parseJsonOrFallback
} = require("./services/cajaService");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const AUTHORIZATION_CANCEL_CODE = "0000"; // fallback solo si la DB no tiene clave configurada

async function getClaveAutorizacion() {
  try {
    const row = await getQuery("SELECT valor FROM configuracion_global WHERE clave = 'autorizacion_clave_maestra'");
    const val = String(parsearConfigValor(row?.valor) || "").trim();
    return val || AUTHORIZATION_CANCEL_CODE;
  } catch { return AUTHORIZATION_CANCEL_CODE; }
}

const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCK_MS = 10 * 60 * 1000;
const PROVEEDOR_IMPACTOS = new Set([
  "costo_fijo_operativo",
  "costo_variable_mercaderia",
  "inversion",
  "otro_no_computable"
]);
const PROVEEDOR_CONDICIONES_IVA = new Set(["responsable_inscripto", "monotributo", "exento", "consumidor_final", "no_informado"]);
const PROVEEDOR_COMPROBANTES = new Set(["factura_a", "factura_b", "factura_c", "recibo_x", "otro"]);

app.use(express.json({ limit: "10mb" }));
app.use("/uploads", express.static(path.join(__dirname, "../uploads"), {
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  }
}));
app.use(express.static(path.join(__dirname, "../frontend"), {
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  }
}));

const RUTAS_PUBLICAS = new Set(["/", "/login", "/logout"]);

function logError(contexto, error, extra = "") {
  const msg = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error && error.stack ? `\n  ${error.stack.split("\n")[1]?.trim()}` : "";
  console.error(`[ERROR] ${contexto}${extra ? " | " + extra : ""}: ${msg}${stack}`);
}

async function requireAuth(req, res, next) {
  if (RUTAS_PUBLICAS.has(req.path)) return next();

  const authHeader = String(req.headers.authorization || "");
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

  if (!token) {
    return res.status(401).json({ message: "No autenticado. Iniciá sesión." });
  }

  try {
    const sesion = await getQuery(
      "SELECT usuario_id, nombre, rol FROM sesiones WHERE token = ? AND expira > datetime('now')",
      [token]
    );
    if (!sesion) {
      return res.status(401).json({ message: "Sesión expirada. Iniciá sesión nuevamente." });
    }
    req.usuario = { id: sesion.usuario_id, nombre: sesion.nombre, rol: sesion.rol };
    next();
  } catch (error) {
    console.error("Error validando sesión:", error.message);
    return res.status(500).json({ message: "Error de autenticación" });
  }
}

app.use(requireAuth);

const ROLES = {
  ADMIN: new Set(["admin"]),
  ADMIN_ENCARGADO: new Set(["admin", "encargado"]),
  CAJA: new Set(["admin", "encargado", "colaborador"]),
  TODOS: new Set(["admin", "encargado", "colaborador"])
};

function normalizarRol(rol) {
  const normalizado = String(rol || "").trim().toLowerCase().replace(/\s+/g, "_");
  return { operador: "colaborador", caja: "colaborador", cajero: "colaborador" }[normalizado] || normalizado;
}

function puedeRol(req, roles) {
  return roles.has(normalizarRol(req.usuario?.rol));
}

function esUsuarioPropio(req, pathname) {
  const match = pathname.match(/^\/usuarios\/(\d+)\//);
  return Number(match?.[1] || 0) === Number(req.usuario?.id || 0);
}

function endpointUsuarioPropio(pathname) {
  return /^\/usuarios\/\d+\/(perfil|password)$/.test(pathname);
}

async function requireServerPermissions(req, res, next) {
  if (RUTAS_PUBLICAS.has(req.path)) return next();
  if (!req.usuario) return next();

  const method = req.method.toUpperCase();
  const pathname = req.path;
  const esLectura = method === "GET";

  if (pathname.startsWith("/admin")) {
    if (!puedeRol(req, ROLES.ADMIN)) return res.status(403).json({ message: "No tenes permisos para esta accion" });
    return next();
  }

  if (pathname.startsWith("/usuarios")) {
    if (pathname === "/usuarios/foto") return next();
    if (endpointUsuarioPropio(pathname) && (puedeRol(req, ROLES.ADMIN) || esUsuarioPropio(req, pathname))) return next();
    if (!(await tienePermisoAccion(req, "admin_usuarios"))) return res.status(403).json({ message: "No tenes permisos para administrar usuarios" });
    if (!puedeRol(req, ROLES.ADMIN)) return res.status(403).json({ message: "No tenes permisos para administrar usuarios" });
    return next();
  }

  if (pathname.startsWith("/configuracion")) {
    if (esLectura) return next();
    if (!(await tienePermisoAccion(req, "admin_configuracion"))) return res.status(403).json({ message: "No tenes permisos para modificar configuracion" });
    if (!puedeRol(req, ROLES.ADMIN)) return res.status(403).json({ message: "No tenes permisos para modificar configuracion" });
    return next();
  }

  if (
    pathname.startsWith("/productos")
    || pathname.startsWith("/productos_compuestos")
    || pathname.startsWith("/categorias")
  ) {
    if (esLectura) return next();
    if (!puedeRol(req, ROLES.ADMIN_ENCARGADO)) return res.status(403).json({ message: "No tenes permisos para modificar stock" });
    return next();
  }

  if (pathname.startsWith("/proveedores") || pathname.startsWith("/pagos")) {
    if (esLectura) return next();
    if (!puedeRol(req, ROLES.ADMIN_ENCARGADO)) return res.status(403).json({ message: "No tenes permisos para esta accion" });
    return next();
  }

  if (pathname.startsWith("/caja")) {
    if (!puedeRol(req, ROLES.CAJA)) return res.status(403).json({ message: "No tenes permisos para caja" });
    return next();
  }

  return next();
}

app.use(requireServerPermissions);

async function ensureColumn(tableName, columnName, definition) {
  const columns = await allQuery(`PRAGMA table_info(${tableName})`);
  const exists = columns.some((column) => column.name === columnName);

  if (!exists) {
    await runQuery(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

async function ensureProveedoresSchema() {
  await ensureColumn("proveedores", "email", "TEXT");
  await ensureColumn("proveedores", "contacto", "TEXT");
  await ensureColumn("proveedores", "direccion", "TEXT");
  await ensureColumn("proveedores", "localidad", "TEXT");
  await ensureColumn("proveedores", "codigo_postal", "TEXT");
  await ensureColumn("proveedores", "tipo_persona", "TEXT NOT NULL DEFAULT 'juridica'");
  await ensureColumn("proveedores", "maneja_cuenta_corriente", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("proveedores", "limite_credito", "REAL NOT NULL DEFAULT 0");
  await ensureColumn("proveedores", "dias_vencimiento", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("proveedores", "dia_vencimiento_fijo", "INTEGER");
  await ensureColumn("proveedores", "moneda", "TEXT NOT NULL DEFAULT 'ARS'");
  await ensureColumn("proveedores", "tipo_impacto", "TEXT NOT NULL DEFAULT 'otro_no_computable'");
  await ensureColumn("proveedores", "categoria_id", "INTEGER");
  await ensureColumn("proveedores", "categoria_especial", "TEXT");
  await ensureColumn("proveedores", "condicion_iva", "TEXT NOT NULL DEFAULT 'no_informado'");
  await ensureColumn("proveedores", "tipo_comprobante", "TEXT NOT NULL DEFAULT 'otro'");
  await ensureColumn("proveedores", "iva_alicuota", "REAL NOT NULL DEFAULT 21");
  await ensureColumn("pagos", "iva_credito_fiscal", "REAL NOT NULL DEFAULT 0");
}

async function ensureProductosSchema() {
  await ensureColumn("productos", "codigo", "TEXT");
  await ensureColumn("productos", "descripcion", "TEXT");
  await ensureColumn("productos", "stock_minimo", "REAL NOT NULL DEFAULT 0");
  await ensureColumn("productos", "unidad_medida", "TEXT NOT NULL DEFAULT 'unidad'");
  await ensureColumn("productos", "codigo_barras", "TEXT");
  await ensureColumn("productos", "marca", "TEXT");
  await ensureColumn("productos", "presentacion", "TEXT");
  await ensureColumn("productos", "ubicacion", "TEXT");
  await ensureColumn("productos", "vencimiento", "TEXT");
  await ensureColumn("productos", "alerta_stock_minimo", "INTEGER NOT NULL DEFAULT 1");
  await ensureColumn("productos", "usa_costos_varios", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("productos", "precio_referencial_proveedor", "REAL NOT NULL DEFAULT 0");
  await ensureColumn("productos", "agregar_proveedor_info", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("productos", "es_combo", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("productos", "aplica_para_combo", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("productos", "tipo", "TEXT NOT NULL DEFAULT 'simple'");
  await ensureColumn("productos", "rendimiento_receta", "INTEGER NOT NULL DEFAULT 1");
  await runQuery(`
    CREATE TABLE IF NOT EXISTS categorias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      margen_porcentaje REAL NOT NULL DEFAULT 0,
      activo INTEGER NOT NULL DEFAULT 1
    )
  `);
  await ensureColumn("categorias", "maneja_stock", "INTEGER NOT NULL DEFAULT 1");
  await ensureColumn("categorias", "usa_costos_varios", "INTEGER NOT NULL DEFAULT 0");
  await runQuery(`
    CREATE TABLE IF NOT EXISTS producto_costos_insumos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      producto_id INTEGER NOT NULL,
      nombre TEXT NOT NULL,
      costo_total REAL NOT NULL DEFAULT 0,
      cantidad_rinde REAL NOT NULL DEFAULT 1,
      unidad TEXT NOT NULL DEFAULT 'un',
      cantidad_usada REAL NOT NULL DEFAULT 1,
      costo_unitario REAL NOT NULL DEFAULT 0,
      costo_aplicado REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (producto_id) REFERENCES productos(id)
    )
  `);
  await runQuery(`
    CREATE TABLE IF NOT EXISTS producto_componentes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      producto_compuesto_id INTEGER NOT NULL,
      producto_id INTEGER NOT NULL,
      cantidad REAL NOT NULL DEFAULT 1,
      FOREIGN KEY (producto_compuesto_id) REFERENCES productos(id),
      FOREIGN KEY (producto_id) REFERENCES productos(id)
    )
  `);
  await runQuery(`
    CREATE TABLE IF NOT EXISTS producto_costos_extra (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      producto_compuesto_id INTEGER NOT NULL,
      descripcion TEXT NOT NULL,
      monto REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (producto_compuesto_id) REFERENCES productos(id)
    )
  `);
  await runQuery(
    "UPDATE productos SET stock = 0, stock_minimo = 0, alerta_stock_minimo = 0 WHERE tipo = 'compuesto' AND maneja_stock = 0 AND (rendimiento_receta IS NULL OR rendimiento_receta <= 1)"
  );
}

async function ensureClientesSchema() {
  await ensureColumn("clientes", "dni_cuit", "TEXT");
  await ensureColumn("clientes", "tipo_persona", "TEXT NOT NULL DEFAULT 'fisica'");
  await ensureColumn("clientes", "email", "TEXT");
  await ensureColumn("clientes", "contacto", "TEXT");
  await ensureColumn("clientes", "localidad", "TEXT");
  await ensureColumn("clientes", "codigo_postal", "TEXT");
  await ensureColumn("clientes", "dias_vencimiento", "INTEGER NOT NULL DEFAULT 30");
  await ensureColumn("clientes", "dia_vencimiento_fijo", "INTEGER");
  await ensureColumn("clientes", "moneda", "TEXT NOT NULL DEFAULT 'ARS'");
  await ensureColumn("clientes", "habilita_cuenta_corriente", "INTEGER NOT NULL DEFAULT 1");
  await ensureColumn("clientes", "notas", "TEXT");
  await ensureColumn("clientes", "foto_url", "TEXT");
}

async function ensureConfiguracionSchema() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS configuracion_global (
      clave TEXT PRIMARY KEY,
      valor TEXT NOT NULL,
      seccion TEXT NOT NULL,
      actualizado_en TEXT NOT NULL
    )
  `);
}

async function ensureUsuariosSchema() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      usuario TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      rol TEXT NOT NULL,
      activo INTEGER NOT NULL DEFAULT 1
    )
  `);
  await ensureColumn("usuarios", "email", "TEXT");
  await ensureColumn("usuarios", "telefono", "TEXT");
  await ensureColumn("usuarios", "foto_url", "TEXT");
  await ensureColumn("usuarios", "ultimo_acceso", "TEXT");
  await ensureColumn("usuarios", "creado_en", "TEXT");
  await ensureColumn("usuarios", "actualizado_en", "TEXT");
  await ensureColumn("usuarios", "intentos_fallidos", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("usuarios", "bloqueado_hasta", "TEXT");
  await runQuery(`
    CREATE TABLE IF NOT EXISTS sesiones (
      token TEXT PRIMARY KEY,
      usuario_id INTEGER NOT NULL,
      nombre TEXT NOT NULL,
      rol TEXT NOT NULL,
      expira TEXT NOT NULL
    )
  `);
  await runQuery("UPDATE usuarios SET rol = 'colaborador' WHERE rol IN ('operador', 'caja', 'cajero')");
  await runQuery("UPDATE sesiones SET rol = 'colaborador' WHERE rol IN ('operador', 'caja', 'cajero')");
}

function getNowParts() {
  const now = new Date();
  return {
    fecha: now.toISOString().slice(0, 10),
    hora: now.toTimeString().slice(0, 8)
  };
}

function calcularCostoFinal(precioCompra, ivaPorcentaje, incluyeIva) {
  const compra = Number(precioCompra) || 0;
  const iva = Number(ivaPorcentaje) || 0;

  if (Number(incluyeIva) === 1) {
    return Number(compra.toFixed(2));
  }

  return Number((compra * (1 + iva / 100)).toFixed(2));
}

function aplicarRedondeo(valor, redondeo) {
  const base = Number(redondeo) || 0;

  if (base <= 0) {
    return Number((Number(valor) || 0).toFixed(2));
  }

  return Math.ceil((Number(valor) || 0) / base) * base;
}

function calcularPrecioSugerido(costoFinal, margenPorcentaje, redondeo) {
  const costo = Number(costoFinal) || 0;
  const margen = Number(margenPorcentaje) || 0;
  const sugerido = costo * (1 + margen / 100);
  return Number(aplicarRedondeo(sugerido, redondeo).toFixed(2));
}

async function generarCodigoProducto(categoriaId) {
  const categoria = categoriaId ? await getQuery("SELECT nombre FROM categorias WHERE id = ?", [categoriaId]) : null;
  const baseNombre = String(categoria?.nombre || "producto").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z]/g, "").toUpperCase() || "PRO";
  const prefijo = baseNombre.slice(0, 3).padEnd(3, "X");
  const row = await getQuery("SELECT COUNT(*) AS total FROM productos WHERE codigo LIKE ?", [`${prefijo}%`]);
  const inicio = Number(row?.total || 0) + 1;
  for (let i = inicio; i < inicio + 999; i += 1) {
    const codigo = `${prefijo}${String(i).padStart(3, "0")}`;
    const existente = await getQuery("SELECT id FROM productos WHERE codigo = ?", [codigo]);
    if (!existente) return codigo;
  }
  const fallbackRow = await getQuery("SELECT COUNT(*) AS total FROM productos", []);
  return `PRD${String(Number(fallbackRow?.total || 0) + 1).padStart(6, "0")}`;
}

function normalizeItems(items) {
  return items.map((item) => ({
    producto_id: item.producto_id ?? item.id ?? null,
    nombre_producto: String(item.nombre_producto ?? item.nombre ?? "").trim(),
    cantidad: Number(item.cantidad) || 0,
    precio_unitario: Number(item.precio_unitario ?? item.precio_venta) || 0
  }));
}

function calculateTotal(items) {
  return items.reduce((acc, item) => {
    return acc + item.cantidad * item.precio_unitario;
  }, 0);
}

function resolveCobroData(total, tipoCobro, montoEfectivo, montoDebito) {
  const tipo = String(tipoCobro || "").trim().toLowerCase();
  const totalRounded = Number(total.toFixed(2));

  if (tipo === "efectivo") {
    return {
      tipo_cobro: "efectivo",
      monto_efectivo: totalRounded,
      monto_debito: 0
    };
  }

  if (tipo === "debito") {
    return {
      tipo_cobro: "debito",
      monto_efectivo: 0,
      monto_debito: totalRounded
    };
  }

  if (tipo === "transferencia") {
    return {
      tipo_cobro: "transferencia",
      monto_efectivo: 0,
      monto_debito: totalRounded
    };
  }

  if (tipo === "mixto") {
    const efectivo = Number(montoEfectivo) || 0;
    const debito = Number(montoDebito) || 0;

    if (efectivo < 0 || debito < 0) return null;

    const suma = Number((efectivo + debito).toFixed(2));

    if (Math.abs(suma - totalRounded) > 0.01) {
      return null;
    }

    return {
      tipo_cobro: "mixto",
      monto_efectivo: Number(efectivo.toFixed(2)),
      monto_debito: Number(debito.toFixed(2))
    };
  }

  return null;
}

async function getPagoCuentaCorrienteTotal(ventaId) {
  const row = await getQuery(
    `SELECT COALESCE(SUM(monto_pagado), 0) AS total_pagado
     FROM pagos_cuenta_corriente
     WHERE venta_id = ?`,
    [ventaId]
  );

  return Number(row?.total_pagado || 0);
}

async function getVentaCuentaCorrienteSnapshot(ventaId) {
  const venta = await getQuery("SELECT * FROM ventas WHERE id = ?", [ventaId]);

  if (!venta) {
    return null;
  }

  const items = await allQuery(
    `SELECT dv.producto_id, dv.nombre_producto, dv.cantidad, dv.precio_unitario,
            p.id AS producto_actual_id, p.nombre AS producto_actual_nombre, p.precio_venta AS precio_actual, p.activo AS producto_activo
     FROM detalle_ventas dv
     LEFT JOIN productos p ON p.id = dv.producto_id
     WHERE dv.venta_id = ?
     ORDER BY dv.id ASC`,
    [ventaId]
  );

  const itemsCalculados = items.map((item) => {
    const cantidad = Number(item.cantidad || 0);
    const precioHistorico = Number(item.precio_unitario || 0);
    const productoSigueVigente = item.producto_actual_id && Number(item.producto_activo) === 1;
    const precioAplicado = productoSigueVigente
      ? Number(item.precio_actual || 0)
      : precioHistorico;

    return {
      producto_id: item.producto_id,
      nombre_producto: item.nombre_producto,
      cantidad,
      precio_historico: precioHistorico,
      precio_actual: item.producto_actual_id ? Number(item.precio_actual || 0) : null,
      usa_precio_actual: Boolean(productoSigueVigente),
      subtotal_actual: Number((cantidad * precioAplicado).toFixed(2))
    };
  });

  const totalActual = Number(
    itemsCalculados.reduce((acc, item) => acc + item.subtotal_actual, 0).toFixed(2)
  );
  const totalPagado = Number((await getPagoCuentaCorrienteTotal(ventaId)).toFixed(2));
  const saldoActual = Number(Math.max(0, totalActual - totalPagado).toFixed(2));

  return {
    venta,
    items: itemsCalculados,
    total_actual: totalActual,
    total_pagado: totalPagado,
    saldo_actual: saldoActual
  };
}

async function refreshCuentaCorrienteSaldo(ventaId) {
  const snapshot = await getVentaCuentaCorrienteSnapshot(ventaId);

  if (!snapshot) {
    return null;
  }

  await runQuery(
    `UPDATE ventas
     SET saldo_pendiente = ?, total = ?, estado = ?
     WHERE id = ?`,
    [
      snapshot.saldo_actual,
      snapshot.total_actual,
      snapshot.saldo_actual === 0 ? "cobrada" : "cuenta_corriente_pendiente",
      ventaId
    ]
  );

  return snapshot;
}

async function replaceVentaDetalle(ventaId, items) {
  await runQuery("DELETE FROM detalle_ventas WHERE venta_id = ?", [ventaId]);

  for (const item of items) {
    const subtotal = item.cantidad * item.precio_unitario;

    await runQuery(
      `INSERT INTO detalle_ventas
      (venta_id, producto_id, nombre_producto, cantidad, precio_unitario, subtotal)
      VALUES (?, ?, ?, ?, ?, ?)`,
      [
        ventaId,
        item.producto_id,
        item.nombre_producto,
        item.cantidad,
        item.precio_unitario,
        subtotal
      ]
    );
  }
}

async function getVentaDetalleRows(ventaId) {
  return allQuery(
    `SELECT id, venta_id, producto_id, nombre_producto, cantidad, precio_unitario, subtotal
     FROM detalle_ventas
     WHERE venta_id = ?
     ORDER BY id ASC`,
    [ventaId]
  );
}

async function getVentaConDetalle(ventaId) {
  const venta = await getQuery("SELECT * FROM ventas WHERE id = ?", [ventaId]);

  if (!venta) {
    return null;
  }

  const items = await getVentaDetalleRows(ventaId);
  return { venta, items };
}

async function logHistorialProducto(productoId, campo, valorAnterior, valorNuevo, motivo = "", usuario = "admin") {
  const { fecha, hora } = getNowParts();

  await runQuery(
    `INSERT INTO historial_productos
    (producto_id, campo_modificado, valor_anterior, valor_nuevo, usuario, fecha, hora, motivo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      productoId,
      campo,
      valorAnterior == null ? null : String(valorAnterior),
      valorNuevo == null ? null : String(valorNuevo),
      usuario,
      fecha,
      hora,
      motivo || ""
    ]
  );
}

async function registrarCambiosProducto(productoId, anterior, nuevo, usuario = "admin", motivo = "") {
  const campos = [
    "nombre",
    "categoria",
    "precio_compra",
    "precio_venta",
    "stock",
    "maneja_stock",
    "proveedor_principal",
    "proveedor_id",
    "activo",
    "eliminado",
    "observaciones",
    "imagen_url",
    "iva_porcentaje",
    "precio_compra_incluye_iva",
    "costo_final",
    "categoria_id",
    "redondeo"
  ];

  for (const campo of campos) {
    const valorAnterior = anterior?.[campo] ?? null;
    const valorNuevo = nuevo?.[campo] ?? null;

    if (String(valorAnterior ?? "") !== String(valorNuevo ?? "")) {
      await logHistorialProducto(productoId, campo, valorAnterior, valorNuevo, motivo, usuario);
    }
  }
}

// Pagina principal
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/login.html"));
});

// Login
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/login.html"));
});

app.post("/logout", async (req, res) => {
  const authHeader = String(req.headers.authorization || "");
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (token) {
    try { await runQuery("DELETE FROM sesiones WHERE token = ?", [token]); } catch {}
  }
  return res.json({ message: "Sesión cerrada" });
});

app.post("/login", async (req, res) => {
  const usuario = String(req.body?.usuario || "").trim();
  const password = String(req.body?.password || "");
  const remember = Boolean(req.body?.remember);

  if (!usuario || !password) {
    return res.status(400).json({ message: "Usuario y contrasena son obligatorios" });
  }

  try {
    const user = await getQuery("SELECT * FROM usuarios WHERE usuario = ?", [usuario]);

    if (!user) {
      return res.status(401).json({ message: "Usuario no encontrado" });
    }

    if (Number(user.activo) !== 1) {
      return res.status(403).json({ message: "Usuario inactivo" });
    }

    const intentos = Number(user.intentos_fallidos || 0);
    if (intentos >= MAX_LOGIN_ATTEMPTS && user.bloqueado_hasta) {
      const bloqueadoHasta = new Date(user.bloqueado_hasta).getTime();
      if (bloqueadoHasta > Date.now()) {
        const minutes = Math.ceil((bloqueadoHasta - Date.now()) / 60000);
        return res.status(429).json({ message: `Demasiados intentos fallidos. Reintentar en ${minutes} min.` });
      }
      await runQuery("UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = ?", [user.id]);
    }

    const valid = await bcrypt.compare(password, user.password);

    if (!valid) {
      const nuevosIntentos = (intentos >= MAX_LOGIN_ATTEMPTS ? 0 : intentos) + 1;
      const bloqueadoHasta = nuevosIntentos >= MAX_LOGIN_ATTEMPTS
        ? new Date(Date.now() + LOGIN_LOCK_MS).toISOString()
        : null;
      await runQuery(
        "UPDATE usuarios SET intentos_fallidos = ?, bloqueado_hasta = ? WHERE id = ?",
        [nuevosIntentos, bloqueadoHasta, user.id]
      );
      if (bloqueadoHasta) {
        return res.status(429).json({ message: `Demasiados intentos fallidos. Cuenta bloqueada por 10 min.` });
      }
      return res.status(401).json({ message: "Contrasena incorrecta" });
    }

    await runQuery(
      "UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL, ultimo_acceso = ? WHERE id = ?",
      [new Date().toISOString(), user.id]
    );

    const expiresInMs = remember ? 7 * 24 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000;
    const token = crypto.randomBytes(32).toString("hex");
    const expiraISO = new Date(Date.now() + expiresInMs).toISOString();

    const rolSesion = normalizarRol(user.rol);
    await runQuery(
      "INSERT OR REPLACE INTO sesiones (token, usuario_id, nombre, rol, expira) VALUES (?, ?, ?, ?, ?)",
      [token, user.id, user.nombre, rolSesion, expiraISO]
    );
    await runQuery("DELETE FROM sesiones WHERE expira < datetime('now')");

    return res.json({
      message: "Login correcto",
      token,
      expires_at: expiraISO,
      remember,
      user: {
        id: user.id,
        nombre: user.nombre,
        usuario: user.usuario,
        rol: rolSesion,
        email: user.email || "",
        telefono: user.telefono || "",
        foto_url: user.foto_url || ""
      }
    });
  } catch (error) {
    console.error("Error en login:", error.message);
    return res.status(500).json({ message: "Error en el servidor" });
  }
});

function parseUsuarioPayload(body, includePassword = false) {
  const data = {
    nombre: String(body?.nombre || "").trim(),
    usuario: String(body?.usuario || "").trim(),
    rol: normalizarRol(body?.rol || "colaborador"),
    email: String(body?.email || "").trim(),
    telefono: String(body?.telefono || "").trim(),
    activo: body?.activo === false || Number(body?.activo) === 0 ? 0 : 1
  };

  if (includePassword) {
    data.password = String(body?.password || "");
    data.confirmar_password = String(body?.confirmar_password || "");
  }

  return data;
}

function usuarioResponse(row) {
  return {
    id: row.id,
    nombre: row.nombre,
    usuario: row.usuario,
    rol: normalizarRol(row.rol),
    email: row.email || "",
    telefono: row.telefono || "",
    foto_url: row.foto_url || "",
    activo: Number(row.activo) === 1,
    estado: Number(row.activo) === 1 ? "Activo" : "Inactivo",
    ultimo_acceso: row.ultimo_acceso || null,
    creado_en: row.creado_en || null,
    actualizado_en: row.actualizado_en || null
  };
}

async function getUsuarioById(id) {
  const row = await getQuery(
    `SELECT id, nombre, usuario, rol, email, telefono, foto_url, activo, ultimo_acceso, creado_en, actualizado_en
     FROM usuarios
     WHERE id = ?`,
    [id]
  );
  return row ? usuarioResponse(row) : null;
}

app.get("/usuarios", async (req, res) => {
  const estado = String(req.query.estado || "todos").toLowerCase();
  const rol = normalizarRol(req.query.rol || "");
  const params = [];
  const where = [];

  if (estado === "activos") where.push("activo = 1");
  if (estado === "inactivos") where.push("activo = 0");
  if (rol) {
    if (rol === "colaborador") {
      where.push("rol IN (?, ?, ?)");
      params.push("colaborador", "operador", "caja");
    } else {
      where.push("rol = ?");
      params.push(rol);
    }
  }

  try {
    const rows = await allQuery(
      `SELECT id, nombre, usuario, rol, email, telefono, foto_url, activo, ultimo_acceso, creado_en, actualizado_en
       FROM usuarios
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY nombre ASC`,
      params
    );
    return res.json(rows.map(usuarioResponse));
  } catch (error) {
    logError("Error al listar usuarios:", error);
    return res.status(500).json({ message: "Error al obtener usuarios" });
  }
});

app.get("/usuarios/:id", async (req, res) => {
  try {
    const usuario = await getUsuarioById(Number(req.params.id));
    if (!usuario) {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }
    return res.json(usuario);
  } catch (error) {
    logError("Error al obtener usuario:", error);
    return res.status(500).json({ message: "Error al obtener usuario" });
  }
});

app.post("/usuarios", async (req, res) => {
  const data = parseUsuarioPayload(req.body, true);

  if (!data.nombre || !data.usuario || !data.password || !data.confirmar_password || !data.rol) {
    return res.status(400).json({ message: "Nombre, usuario, contrasena y rol son obligatorios" });
  }

  const ROLES_VALIDOS = ["admin", "encargado", "colaborador"];
  if (!ROLES_VALIDOS.includes(data.rol)) {
    return res.status(400).json({ message: "Rol inválido. Valores permitidos: admin, encargado, colaborador" });
  }

  if (data.password.length < 8) {
    return res.status(400).json({ message: "La contraseña debe tener al menos 8 caracteres" });
  }
  if (!/\d/.test(data.password)) {
    return res.status(400).json({ message: "La contraseña debe incluir al menos un número" });
  }

  if (data.password !== data.confirmar_password) {
    return res.status(400).json({ message: "Las contrasenas no coinciden" });
  }

  try {
    const existente = await getQuery("SELECT id FROM usuarios WHERE usuario = ?", [data.usuario]);
    if (existente) {
      return res.status(409).json({ message: "Ya existe un usuario con ese login" });
    }

    const passwordHash = await bcrypt.hash(data.password, 10);
    const now = new Date().toISOString();
    const result = await runQuery(
      `INSERT INTO usuarios (nombre, usuario, password, rol, email, telefono, activo, creado_en, actualizado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [data.nombre, data.usuario, passwordHash, data.rol, data.email, data.telefono, data.activo, now, now]
    );

    return res.json({ message: "Usuario creado correctamente", usuario: await getUsuarioById(result.lastID) });
  } catch (error) {
    logError("Error al crear usuario:", error);
    return res.status(500).json({ message: "Error al crear usuario" });
  }
});

app.put("/usuarios/:id", async (req, res) => {
  const usuarioId = Number(req.params.id);
  const data = parseUsuarioPayload(req.body);

  if (!data.nombre || !data.usuario || !data.rol) {
    return res.status(400).json({ message: "Nombre, usuario y rol son obligatorios" });
  }

  const ROLES_VALIDOS_PUT = ["admin", "encargado", "colaborador"];
  if (!ROLES_VALIDOS_PUT.includes(data.rol)) {
    return res.status(400).json({ message: "Rol inválido. Valores permitidos: admin, encargado, colaborador" });
  }

  try {
    const actual = await getQuery("SELECT id FROM usuarios WHERE id = ?", [usuarioId]);
    if (!actual) {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    const duplicado = await getQuery("SELECT id FROM usuarios WHERE usuario = ? AND id != ?", [data.usuario, usuarioId]);
    if (duplicado) {
      return res.status(409).json({ message: "Ya existe otro usuario con ese login" });
    }

    await runQuery(
      `UPDATE usuarios
       SET nombre = ?, usuario = ?, rol = ?, email = ?, telefono = ?, activo = ?, actualizado_en = ?
       WHERE id = ?`,
      [data.nombre, data.usuario, data.rol, data.email, data.telefono, data.activo, new Date().toISOString(), usuarioId]
    );

    return res.json({ message: "Usuario actualizado correctamente", usuario: await getUsuarioById(usuarioId) });
  } catch (error) {
    logError("Error al actualizar usuario:", error);
    return res.status(500).json({ message: "Error al actualizar usuario" });
  }
});

app.patch("/usuarios/:id/estado", async (req, res) => {
  const usuarioId = Number(req.params.id);
  const activo = req.body?.activo ? 1 : 0;

  try {
    const usuario = await getQuery("SELECT id FROM usuarios WHERE id = ?", [usuarioId]);
    if (!usuario) {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    await runQuery(
      "UPDATE usuarios SET activo = ?, actualizado_en = ? WHERE id = ?",
      [activo, new Date().toISOString(), usuarioId]
    );
    return res.json({ message: activo ? "Usuario activado" : "Usuario desactivado", usuario: await getUsuarioById(usuarioId) });
  } catch (error) {
    logError("Error al cambiar estado del usuario:", error);
    return res.status(500).json({ message: "Error al cambiar estado del usuario" });
  }
});

app.patch("/usuarios/:id/password", async (req, res) => {
  const usuarioId = Number(req.params.id);
  const password = String(req.body?.password || "");
  const confirmarPassword = String(req.body?.confirmar_password || "");

  if (!password || !confirmarPassword) {
    return res.status(400).json({ message: "Debe completar la nueva contrasena" });
  }

  if (password.length < 8) {
    return res.status(400).json({ message: "La contraseña debe tener al menos 8 caracteres" });
  }
  if (!/\d/.test(password)) {
    return res.status(400).json({ message: "La contraseña debe incluir al menos un número" });
  }

  if (password !== confirmarPassword) {
    return res.status(400).json({ message: "Las contrasenas no coinciden" });
  }

  try {
    const usuario = await getQuery("SELECT id FROM usuarios WHERE id = ?", [usuarioId]);
    if (!usuario) {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await runQuery(
      "UPDATE usuarios SET password = ?, actualizado_en = ? WHERE id = ?",
      [passwordHash, new Date().toISOString(), usuarioId]
    );
    return res.json({ message: "Contrasena actualizada correctamente" });
  } catch (error) {
    logError("Error al cambiar contrasena:", error);
    return res.status(500).json({ message: "Error al cambiar contrasena" });
  }
});

app.post("/usuarios/foto", async (req, res) => {
  try {
    const { nombre, data_url } = req.body || {};
    const match = String(data_url || "").match(/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/i);

    if (!match) {
      return res.status(400).json({ message: "La foto debe enviarse como imagen valida" });
    }

    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length || buffer.length > 5 * 1024 * 1024) {
      return res.status(400).json({ message: "La foto no puede superar 5 MB" });
    }

    const extension = match[1].toLowerCase().replace("jpeg", "jpg");
    const baseName = String(nombre || "perfil").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "perfil";
    const fileName = `${Date.now()}-${baseName.slice(0, 32)}-${crypto.randomBytes(4).toString("hex")}.${extension}`;
    const uploadDir = path.join(__dirname, "../uploads/usuarios");
    const filePath = path.join(uploadDir, fileName);

    await fs.promises.mkdir(uploadDir, { recursive: true });
    await fs.promises.writeFile(filePath, buffer);

    return res.status(201).json({ url: `/uploads/usuarios/${fileName}` });
  } catch (error) {
    logError("Error al guardar foto de usuario:", error);
    return res.status(500).json({ message: "Error al guardar foto" });
  }
});

app.patch("/usuarios/:id/perfil", async (req, res) => {
  const usuarioId = Number(req.params.id);
  const nombre = String(req.body?.nombre || "").trim();
  const email = String(req.body?.email || "").trim();
  const telefono = String(req.body?.telefono || "").trim();
  const fotoUrl = String(req.body?.foto_url || "").trim();

  if (!nombre) {
    return res.status(400).json({ message: "El nombre es obligatorio" });
  }

  try {
    const usuario = await getQuery("SELECT id FROM usuarios WHERE id = ?", [usuarioId]);
    if (!usuario) {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    await runQuery(
      `UPDATE usuarios
       SET nombre = ?, email = ?, telefono = ?, foto_url = ?, actualizado_en = ?
       WHERE id = ?`,
      [nombre, email, telefono, fotoUrl, new Date().toISOString(), usuarioId]
    );

    return res.json({ message: "Perfil actualizado", usuario: await getUsuarioById(usuarioId) });
  } catch (error) {
    logError("Error al actualizar perfil:", error);
    return res.status(500).json({ message: "Error al actualizar perfil" });
  }
});

app.delete("/usuarios/:id", async (req, res) => {
  const usuarioId = Number(req.params.id);

  try {
    const usuario = await getQuery("SELECT id, usuario FROM usuarios WHERE id = ?", [usuarioId]);
    if (!usuario) {
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    const actividad = await getQuery(
      `SELECT
         (SELECT COUNT(*) FROM ventas WHERE usuario = ?) AS ventas,
         (SELECT COUNT(*) FROM caja_aperturas WHERE usuario = ?) AS cajas`,
      [usuario.usuario, usuario.usuario]
    );

    if (Number(actividad?.ventas || 0) + Number(actividad?.cajas || 0) > 0) {
      return res.status(409).json({ message: "No se puede eliminar un usuario con actividad. Se puede desactivar." });
    }

    await runQuery("DELETE FROM usuarios WHERE id = ?", [usuarioId]);
    return res.json({ message: "Usuario eliminado correctamente" });
  } catch (error) {
    logError("Error al eliminar usuario:", error);
    return res.status(500).json({ message: "Error al eliminar usuario" });
  }
});

app.post("/productos/imagen", async (req, res) => {
  try {
    const { nombre, data_url } = req.body || {};
    const match = String(data_url || "").match(/^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/i);

    if (!match) {
      return res.status(400).json({ message: "La imagen debe enviarse como archivo de imagen valido" });
    }

    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length || buffer.length > 5 * 1024 * 1024) {
      return res.status(400).json({ message: "La imagen no puede superar 5 MB" });
    }

    const extension = match[1].toLowerCase().replace("jpeg", "jpg");
    const baseName = String(nombre || "producto").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "producto";
    const fileName = `${Date.now()}-${baseName.slice(0, 32)}-${crypto.randomBytes(4).toString("hex")}.${extension}`;
    const uploadDir = path.join(__dirname, "../uploads/productos");
    const filePath = path.join(uploadDir, fileName);

    await fs.promises.mkdir(uploadDir, { recursive: true });
    await fs.promises.writeFile(filePath, buffer);

    return res.status(201).json({ url: `/uploads/productos/${fileName}` });
  } catch (err) {
    logError("Error al guardar imagen de producto:", err);
    return res.status(500).json({ message: "Error al guardar imagen" });
  }
});

// Crear producto
app.post("/productos", async (req, res) => {
  if (!(await requirePermiso(req, res, "stock_crear_producto", "No tenes permisos para crear productos"))) return;

  const {
    nombre,
    categoria,
    precio_compra,
    precio_venta,
    stock,
    maneja_stock,
    proveedor_principal,
    proveedor_id,
    activo,
    observaciones,
    imagen_url,
    iva_porcentaje,
    precio_compra_incluye_iva,
    categoria_id,
    redondeo,
    codigo,
    descripcion,
    stock_minimo,
    unidad_medida,
    codigo_barras,
    marca,
    presentacion,
    ubicacion,
    vencimiento,
    alerta_stock_minimo,
    usa_costos_varios,
    costos_insumos,
    precio_referencial_proveedor,
    agregar_proveedor_info,
    es_combo,
    aplica_para_combo,
    tipo,
    componentes,
    costos_extra,
    usuario
  } = req.body;

  if (!nombre || !String(nombre).trim()) {
    return res.status(400).json({ message: "El nombre del producto es obligatorio" });
  }

  if (!categoria_id) {
    return res.status(400).json({ message: "La categoria es obligatoria" });
  }

  if (Number(precio_compra) < 0 || Number(precio_venta) < 0) {
    return res.status(400).json({ message: "Los precios no pueden ser negativos" });
  }

  try {
    const categoriaData = categoria_id
      ? await getQuery("SELECT margen_porcentaje, maneja_stock, usa_costos_varios FROM categorias WHERE id = ?", [Number(categoria_id)])
      : null;
    if (!categoriaData) {
      return res.status(400).json({ message: "La categoria seleccionada no existe" });
    }
    const tipoProducto = normalizarTipoProducto(tipo);
    const usaCostos = tipoProducto === "simple" && (usa_costos_varios || categoriaData?.usa_costos_varios);
    const stockInicial = Number(stock) || 0;
    const recetaSinStockFisico = tipoProducto === "compuesto" && !maneja_stock;
    const rendimientoPost = recetaSinStockFisico ? Math.max(1, Number(req.body.rendimiento_receta) || 1) : 1;
    const esBatchPost = recetaSinStockFisico && rendimientoPost > 1;
    const costoBase = tipoProducto === "compuesto"
      ? await calcularCostoProductoCompuestoPayload(componentes, costos_extra, rendimientoPost)
      : usaCostos ? calcularCostoPorRendimiento(costos_insumos) : Number(precio_compra) || 0;
    const costoFinal = calcularCostoFinal(costoBase, iva_porcentaje, precio_compra_incluye_iva ? 1 : 0);
    const precioVentaFinal = Number(precio_venta) || calcularPrecioSugerido(
      costoFinal,
      categoriaData?.margen_porcentaje || 0,
      redondeo
    );
    const codigoFinal = String(codigo || "").trim() || await generarCodigoProducto(Number(categoria_id));

    if (codigoFinal) {
      const codDuplicado = await getQuery(
        "SELECT id FROM productos WHERE codigo = ? AND eliminado = 0",
        [codigoFinal]
      );
      if (codDuplicado) {
        return res.status(409).json({ message: `Ya existe un producto con el código "${codigoFinal}"` });
      }
    }

    const result = await runQuery(
      `INSERT INTO productos
      (nombre, categoria, precio_compra, precio_venta, stock, maneja_stock, proveedor_principal, proveedor_id, activo, observaciones, imagen_url, iva_porcentaje, precio_compra_incluye_iva, costo_final, categoria_id, redondeo,
       codigo, descripcion, stock_minimo, unidad_medida, codigo_barras, marca, presentacion, ubicacion, vencimiento, alerta_stock_minimo, usa_costos_varios, precio_referencial_proveedor, agregar_proveedor_info, es_combo, aplica_para_combo, tipo, rendimiento_receta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(nombre).trim(),
        categoria || "",
        costoBase,
        precioVentaFinal,
        esBatchPost ? rendimientoPost : (recetaSinStockFisico ? 0 : stockInicial),
        recetaSinStockFisico ? 0 : (maneja_stock ? 1 : 0),
        proveedor_principal || "",
        proveedor_id ? Number(proveedor_id) : null,
        activo ? 1 : 0,
        observaciones || "",
        imagen_url || "",
        Number(iva_porcentaje) || 0,
        precio_compra_incluye_iva ? 1 : 0,
        costoFinal,
        categoria_id ? Number(categoria_id) : null,
        Number(redondeo) || 0,
        codigoFinal,
        descripcion || "",
        recetaSinStockFisico ? 0 : Number(stock_minimo) || 0,
        unidad_medida || "unidad",
        codigo_barras || "",
        marca || "",
        presentacion || "",
        ubicacion || "",
        vencimiento || "",
        recetaSinStockFisico ? 0 : alerta_stock_minimo === false ? 0 : 1,
        usaCostos ? 1 : 0,
        Number(precio_referencial_proveedor) || 0,
        agregar_proveedor_info ? 1 : 0,
        es_combo ? 1 : 0,
        aplica_para_combo ? 1 : 0,
        tipoProducto,
        rendimientoPost
      ]
    );

    if (usaCostos) await guardarInsumosProducto(result.lastID, costos_insumos);
    if (tipoProducto === "compuesto") await guardarProductoCompuestoConfig(result.lastID, componentes, costos_extra);

    const nuevo = await getQuery("SELECT * FROM productos WHERE id = ?", [result.lastID]);
    await registrarCambiosProducto(result.lastID, null, nuevo, usuario || "admin", "creacion");

    return res.json({
      message: "Producto guardado correctamente",
      id: result.lastID
    });
  } catch (err) {
    logError("Error al guardar producto:", err);
    return res.status(500).json({ message: "Error al guardar producto" });
  }
});

// Listar productos
app.get("/productos", async (req, res) => {
  const includeInactive = String(req.query.include_inactive || "") === "1";
  const sql = `
    SELECT p.*, pr.nombre AS proveedor_nombre, c.nombre AS categoria_nombre, c.margen_porcentaje,
           COALESCE(dv.total_vendido, 0) AS total_vendido
    FROM productos p
    LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
    LEFT JOIN categorias c ON c.id = p.categoria_id
    LEFT JOIN (SELECT producto_id, SUM(cantidad) AS total_vendido FROM detalle_ventas GROUP BY producto_id) dv ON dv.producto_id = p.id
    ${includeInactive ? "WHERE COALESCE(p.eliminado, 0) = 0" : "WHERE p.activo = 1 AND COALESCE(p.eliminado, 0) = 0"}
    ORDER BY p.id DESC
  `;

  try {
    const rows = await allQuery(sql);
    if (!rows.length) return res.json([]);

    const ids = rows.map((r) => r.id);
    const ph = ids.map(() => "?").join(",");

    const compuestoIds = rows
      .filter((r) => normalizarTipoProducto(r.tipo) === "compuesto" || Number(r.es_combo) === 1)
      .map((r) => r.id);
    const chComp = compuestoIds.length ? compuestoIds.map(() => "?").join(",") : null;

    const [insumosRaw, componentesRaw, costosExtraRaw] = await Promise.all([
      allQuery(`SELECT producto_id, costo_unitario, cantidad_usada FROM producto_costos_insumos WHERE producto_id IN (${ph})`, ids),
      chComp ? allQuery(
        `SELECT pc.producto_compuesto_id, pc.producto_id, pc.cantidad,
                p.stock, p.costo_final, p.precio_compra, p.tipo, p.maneja_stock
         FROM producto_componentes pc
         LEFT JOIN productos p ON p.id = pc.producto_id
         WHERE pc.producto_compuesto_id IN (${chComp})`, compuestoIds
      ) : Promise.resolve([]),
      chComp ? allQuery(`SELECT producto_compuesto_id, monto FROM producto_costos_extra WHERE producto_compuesto_id IN (${chComp})`, compuestoIds) : Promise.resolve([])
    ]);

    const insumosMap = new Map();
    for (const i of insumosRaw) {
      if (!insumosMap.has(i.producto_id)) insumosMap.set(i.producto_id, []);
      insumosMap.get(i.producto_id).push(i);
    }
    const componentesMap = new Map();
    for (const c of componentesRaw) {
      if (!componentesMap.has(c.producto_compuesto_id)) componentesMap.set(c.producto_compuesto_id, []);
      componentesMap.get(c.producto_compuesto_id).push(c);
    }
    const costosExtraMap = new Map();
    for (const ce of costosExtraRaw) {
      if (!costosExtraMap.has(ce.producto_compuesto_id)) costosExtraMap.set(ce.producto_compuesto_id, []);
      costosExtraMap.get(ce.producto_compuesto_id).push(ce);
    }

    function costoCompuestoMemoria(id, rendimiento) {
      const comps = componentesMap.get(id) || [];
      const extras = (costosExtraMap.get(id) || []).reduce((a, e) => a + Number(e.monto || 0), 0);
      const costoComps = comps.reduce((a, c) => a + Number(c.costo_final || c.precio_compra || 0) * Number(c.cantidad || 0), 0);
      return Number(((costoComps + extras) / Math.max(1, Number(rendimiento) || 1)).toFixed(2));
    }

    function stockCompuestoMemoria(id, rendimiento) {
      const comps = componentesMap.get(id) || [];
      if (!comps.length) return 0;
      const disp = comps
        .filter((c) => Number(c.cantidad || 0) > 0)
        .map((c) => Number(c.stock || 0) / Number(c.cantidad));
      if (!disp.length) return 0;
      return Math.max(0, Math.floor(Math.min(...disp))) * Math.max(1, Number(rendimiento) || 1);
    }

    function costoConsumoMemoria(row) {
      const insumos = insumosMap.get(row.id) || [];
      if (insumos.length) return Number(insumos.reduce((a, i) => a + Number(i.costo_unitario || 0), 0).toFixed(4));
      return Number(Number(row.costo_final || row.precio_compra || 0).toFixed(4));
    }

    function stockFraccionadoMemoria(row) {
      const insumos = normalizarInsumosCostos(insumosMap.get(row.id) || []);
      const consumo = insumos.reduce((a, i) => a + Number(i.cantidad_usada || 0), 0);
      if (consumo <= 0) return Math.max(0, Math.floor(Number(row.stock) || 0));
      return Math.max(0, Math.floor((Number(row.stock) || 0) / consumo));
    }

    const enriquecidos = rows.map((row) => {
      const esCompuesto = normalizarTipoProducto(row.tipo) === "compuesto";
      const esCombo = Number(row.es_combo) === 1;

      if (esCompuesto) {
        const costo = costoCompuestoMemoria(row.id, row.rendimiento_receta);
        const stock = stockCompuestoMemoria(row.id, row.rendimiento_receta);
        return {
          ...row,
          stock_fisico: 0,
          stock_disponible: stock,
          stock_vendible_calculado: stock,
          precio_compra: costo,
          costo_final: costo,
          costo_teorico: costo,
          costo_consumo_unitario: costo,
          precio_sugerido: calcularPrecioSugerido(costo, row.margen_porcentaje, row.redondeo)
        };
      }

      if (esCombo) {
        const stock = stockCompuestoMemoria(row.id, 1);
        const costo = costoCompuestoMemoria(row.id, 1);
        return {
          ...row,
          stock_fisico: 0,
          stock_disponible: stock,
          stock_vendible_calculado: stock,
          costo_teorico: costo,
          costo_consumo_unitario: costo,
          precio_sugerido: calcularPrecioSugerido(row.costo_final, row.margen_porcentaje, row.redondeo)
        };
      }

      const esFraccionado = Number(row.usa_costos_varios) === 1 && Number(row.maneja_stock) === 1;
      const stockVendible = esFraccionado ? stockFraccionadoMemoria(row) : Number(row.stock || 0);
      const costoConsumo = costoConsumoMemoria(row);

      return {
        ...row,
        stock_fisico: Number(row.stock || 0),
        stock_disponible: undefined,
        stock_vendible_calculado: stockVendible,
        costo_teorico: Number(row.costo_final || row.precio_compra || 0),
        costo_consumo_unitario: costoConsumo,
        precio_sugerido: calcularPrecioSugerido(row.costo_final, row.margen_porcentaje, row.redondeo)
      };
    });

    return res.json(enriquecidos);
  } catch (err) {
    logError("Error al listar productos:", err);
    return res.status(500).json({ message: "Error al obtener productos" });
  }
});

// Editar producto
app.put("/productos/:id", async (req, res) => {
  if (!(await requirePermiso(req, res, "stock_editar_producto", "No tenes permisos para editar productos"))) return;

  const productoId = Number(req.params.id);
  const {
    nombre,
    categoria,
    precio_compra,
    precio_venta,
    stock,
    maneja_stock,
    proveedor_principal,
    proveedor_id,
    activo,
    observaciones,
    imagen_url,
    iva_porcentaje,
    precio_compra_incluye_iva,
    categoria_id,
    redondeo,
    codigo,
    descripcion,
    stock_minimo,
    unidad_medida,
    codigo_barras,
    marca,
    presentacion,
    ubicacion,
    vencimiento,
    alerta_stock_minimo,
    usa_costos_varios,
    costos_insumos,
    precio_referencial_proveedor,
    agregar_proveedor_info,
    es_combo,
    aplica_para_combo,
    tipo,
    componentes,
    costos_extra,
    usuario
  } = req.body;

  if (!nombre || !String(nombre).trim()) {
    return res.status(400).json({ message: "El nombre del producto es obligatorio" });
  }

  if (!categoria_id) {
    return res.status(400).json({ message: "La categoria es obligatoria" });
  }

  if (Number(precio_compra) < 0 || Number(precio_venta) < 0) {
    return res.status(400).json({ message: "Los precios no pueden ser negativos" });
  }

  try {
    const existente = await getQuery("SELECT * FROM productos WHERE id = ?", [productoId]);

    if (!existente) {
      return res.status(404).json({ message: "Producto no encontrado" });
    }

    const codigoEditado = String(codigo || "").trim();
    if (codigoEditado) {
      const codDuplicado = await getQuery(
        "SELECT id FROM productos WHERE codigo = ? AND id != ? AND eliminado = 0",
        [codigoEditado, productoId]
      );
      if (codDuplicado) {
        return res.status(409).json({ message: `Ya existe un producto con el código "${codigoEditado}"` });
      }
    }

    const categoriaData = categoria_id
      ? await getQuery("SELECT margen_porcentaje, maneja_stock, usa_costos_varios FROM categorias WHERE id = ?", [Number(categoria_id)])
      : null;
    if (!categoriaData) {
      return res.status(400).json({ message: "La categoria seleccionada no existe" });
    }
    const tipoProducto = normalizarTipoProducto(tipo);
    const usaCostos = tipoProducto === "simple" && (usa_costos_varios || categoriaData?.usa_costos_varios);
    const rendimientoReceta = (tipoProducto === "compuesto" && !maneja_stock) ? Math.max(1, Number(req.body.rendimiento_receta) || 1) : 1;
    const esBatchCounter = tipoProducto === "compuesto" && !maneja_stock && rendimientoReceta > 1;
    const stockProducto = esBatchCounter ? rendimientoReceta : (Number(stock) || 0);
    const recetaSinStockFisico = tipoProducto === "compuesto" && !maneja_stock;
    const costoBase = tipoProducto === "compuesto"
      ? await calcularCostoProductoCompuestoPayload(componentes, costos_extra, rendimientoReceta)
      : usaCostos ? calcularCostoPorRendimiento(costos_insumos) : Number(precio_compra) || 0;
    const costoFinal = calcularCostoFinal(costoBase, iva_porcentaje, precio_compra_incluye_iva ? 1 : 0);
    const precioVentaFinal = Number(precio_venta) || calcularPrecioSugerido(
      costoFinal,
      categoriaData?.margen_porcentaje || 0,
      redondeo
    );

    await runQuery("BEGIN TRANSACTION");

    await runQuery(
      `UPDATE productos
       SET nombre = ?, categoria = ?, precio_compra = ?, precio_venta = ?, stock = ?,
           maneja_stock = ?, proveedor_principal = ?, proveedor_id = ?, activo = ?,
           observaciones = ?, imagen_url = ?, iva_porcentaje = ?, precio_compra_incluye_iva = ?,
           costo_final = ?, categoria_id = ?, redondeo = ?, codigo = ?, descripcion = ?, stock_minimo = ?,
           unidad_medida = ?, codigo_barras = ?, marca = ?, presentacion = ?, ubicacion = ?, vencimiento = ?,
           alerta_stock_minimo = ?, usa_costos_varios = ?, precio_referencial_proveedor = ?, agregar_proveedor_info = ?, es_combo = ?, aplica_para_combo = ?, tipo = ?, rendimiento_receta = ?
       WHERE id = ?`,
      [
        String(nombre).trim(),
        categoria || "",
        costoBase,
        precioVentaFinal,
        esBatchCounter ? Number(existente.stock || 0) : (recetaSinStockFisico ? 0 : stockProducto),
        recetaSinStockFisico ? 0 : (maneja_stock ? 1 : 0),
        proveedor_principal || "",
        proveedor_id ? Number(proveedor_id) : null,
        activo ? 1 : 0,
        observaciones || "",
        imagen_url || "",
        Number(iva_porcentaje) || 0,
        precio_compra_incluye_iva ? 1 : 0,
        costoFinal,
        categoria_id ? Number(categoria_id) : null,
        Number(redondeo) || 0,
        String(codigo || "").trim() || null,
        descripcion || "",
        recetaSinStockFisico ? 0 : Number(stock_minimo) || 0,
        unidad_medida || "unidad",
        codigo_barras || "",
        marca || "",
        presentacion || "",
        ubicacion || "",
        vencimiento || "",
        recetaSinStockFisico ? 0 : alerta_stock_minimo === false ? 0 : 1,
        usaCostos ? 1 : 0,
        Number(precio_referencial_proveedor) || 0,
        agregar_proveedor_info ? 1 : 0,
        es_combo ? 1 : 0,
        aplica_para_combo ? 1 : 0,
        tipoProducto,
        rendimientoReceta,
        productoId
      ]
    );

    if (usaCostos) {
      await guardarInsumosProducto(productoId, costos_insumos);
    } else {
      await runQuery("DELETE FROM producto_costos_insumos WHERE producto_id = ?", [productoId]);
    }

    if (tipoProducto === "compuesto") {
      await guardarProductoCompuestoConfig(productoId, componentes, costos_extra);
    } else {
      await runQuery("DELETE FROM producto_componentes WHERE producto_compuesto_id = ?", [productoId]);
      await runQuery("DELETE FROM producto_costos_extra WHERE producto_compuesto_id = ?", [productoId]);
    }

    await runQuery("COMMIT");

    const actualizado = await getQuery("SELECT * FROM productos WHERE id = ?", [productoId]);
    await registrarCambiosProducto(productoId, existente, actualizado, usuario || "admin", "edicion");

    return res.json({ message: "Producto actualizado correctamente" });
  } catch (error) {
    try { await runQuery("ROLLBACK"); } catch {}
    logError("Error al actualizar producto", error, "id: " + productoId);
    return res.status(500).json({ message: "Error al actualizar producto" });
  }
});

app.patch("/productos/:id/inactivar", async (req, res) => {
  if (!(await requirePermiso(req, res, "stock_eliminar_producto", "No tenes permisos para eliminar productos"))) return;

  const productoId = Number(req.params.id);

  try {
    const existente = await getQuery("SELECT id FROM productos WHERE id = ?", [productoId]);

    if (!existente) {
      return res.status(404).json({ message: "Producto no encontrado" });
    }

    await runQuery("UPDATE productos SET activo = 0 WHERE id = ?", [productoId]);
    const actualizado = await getQuery("SELECT * FROM productos WHERE id = ?", [productoId]);
    await registrarCambiosProducto(productoId, existente, actualizado, "admin", "inactivacion");
    return res.json({ message: "Producto inactivado correctamente" });
  } catch (error) {
    logError("Error al inactivar producto:", error);
    return res.status(500).json({ message: "Error al inactivar producto" });
  }
});

app.patch("/productos/:id/combo", async (req, res) => {
  if (!(await requirePermiso(req, res, "stock_editar_producto", "No tenes permisos para editar productos"))) return;

  const productoId = Number(req.params.id);
  const aplicaParaCombo = req.body?.aplica_para_combo ? 1 : 0;

  try {
    const existente = await getQuery("SELECT * FROM productos WHERE id = ?", [productoId]);

    if (!existente) {
      return res.status(404).json({ message: "Producto no encontrado" });
    }

    await runQuery("UPDATE productos SET aplica_para_combo = ? WHERE id = ?", [aplicaParaCombo, productoId]);

    if (!aplicaParaCombo) {
      await runQuery(`
        UPDATE productos SET activo = 0
        WHERE es_combo = 1
          AND id IN (
            SELECT producto_compuesto_id FROM producto_componentes WHERE producto_id = ?
          )
      `, [productoId]);
    }

    const actualizado = await getQuery("SELECT * FROM productos WHERE id = ?", [productoId]);
    await registrarCambiosProducto(productoId, existente, actualizado, "admin", "combo");
    return res.json({ message: aplicaParaCombo ? "Producto habilitado para combos" : "Producto quitado de combos" });
  } catch (error) {
    logError("Error al actualizar combo del producto:", error);
    return res.status(500).json({ message: "Error al actualizar combo del producto" });
  }
});

// Vista previa: herramienta temporal de migración (read-only, sin auth)
app.get("/admin/combo-preview", async (req, res) => {
  try {
    const productos = await allQuery(`
      SELECT p.id, p.nombre,
             COALESCE(c.nombre, p.categoria, 'Sin categoría') AS categoria,
             COALESCE(p.tipo, 'simple') AS tipo,
             p.es_combo, p.aplica_para_combo
      FROM productos p
      LEFT JOIN categorias c ON c.id = p.categoria_id
      WHERE p.es_combo = 1
        AND COALESCE(p.tipo, 'simple') != 'compuesto'
        AND COALESCE(p.eliminado, 0) = 0
      ORDER BY p.nombre
    `);
    return res.json({ productos, total: productos.length });
  } catch (err) {
    console.error("Error en combo-preview:", err.message);
    return res.status(500).json({ message: "Error al obtener preview de migración" });
  }
});

// Aplicar corrección: mover es_combo=1 (no reales) a aplica_para_combo=1 — requiere clave maestra
app.post("/admin/combo-aplicar", async (req, res) => {
  const claveConfig = await getClaveAutorizacion();
  const clave = String(req.body?.clave || "").trim();
  if (clave !== claveConfig) {
    return res.status(403).json({ message: "Clave maestra requerida" });
  }
  try {
    const afectados = await allQuery(`
      SELECT id FROM productos
      WHERE es_combo = 1
        AND COALESCE(tipo, 'simple') != 'compuesto'
        AND COALESCE(eliminado, 0) = 0
    `);
    if (!afectados.length) {
      return res.json({ message: "No hay productos para corregir", total: 0 });
    }
    await runQuery(`
      UPDATE productos
      SET es_combo = 0, aplica_para_combo = 1
      WHERE es_combo = 1
        AND COALESCE(tipo, 'simple') != 'compuesto'
        AND COALESCE(eliminado, 0) = 0
    `);
    return res.json({
      message: `${afectados.length} producto(s) corregido(s): es_combo → aplica_para_combo`,
      total: afectados.length
    });
  } catch (err) {
    console.error("Error en combo-aplicar:", err.message);
    return res.status(500).json({ message: "Error al aplicar corrección de combos" });
  }
});

app.post("/productos_compuestos", async (req, res) => {
  if (!(await requirePermiso(req, res, "stock_crear_producto", "No tenes permisos para crear productos"))) return;

  const {
    nombre,
    categoria,
    categoria_id,
    precio_venta,
    redondeo,
    codigo,
    descripcion,
    unidad_medida,
    stock,
    stock_minimo,
    alerta_stock_minimo,
    activo,
    observaciones,
    imagen_url,
    componentes,
    costos_extra,
    usuario
  } = req.body;

  if (!nombre || !String(nombre).trim()) {
    return res.status(400).json({ message: "El nombre del producto es obligatorio" });
  }

  if (!categoria_id) {
    return res.status(400).json({ message: "La categoria es obligatoria" });
  }

  try {
    const categoriaData = await getQuery(
      "SELECT margen_porcentaje FROM categorias WHERE id = ?",
      [Number(categoria_id)]
    );

    if (!categoriaData) {
      return res.status(400).json({ message: "La categoria seleccionada no existe" });
    }

    const costoBase = await calcularCostoProductoCompuestoPayload(componentes, costos_extra);
    const precioVentaFinal = Number(precio_venta) || calcularPrecioSugerido(
      costoBase,
      categoriaData?.margen_porcentaje || 0,
      redondeo
    );
    const codigoFinal = String(codigo || "").trim() || await generarCodigoProducto(Number(categoria_id));

    await runQuery("BEGIN TRANSACTION");
    const result = await runQuery(
      `INSERT INTO productos
      (nombre, categoria, precio_compra, precio_venta, stock, maneja_stock, proveedor_principal, proveedor_id, activo, observaciones, imagen_url, iva_porcentaje, precio_compra_incluye_iva, costo_final, categoria_id, redondeo,
       codigo, descripcion, stock_minimo, unidad_medida, codigo_barras, marca, presentacion, ubicacion, vencimiento, alerta_stock_minimo, usa_costos_varios, precio_referencial_proveedor, agregar_proveedor_info, es_combo, tipo)
      VALUES (?, ?, ?, ?, 0, 0, '', NULL, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?, 0, ?, '', '', '', '', '', 0, 0, 0, 0, 0, 'compuesto')`,
      [
        String(nombre).trim(),
        categoria || "",
        costoBase,
        precioVentaFinal,
        activo === false ? 0 : 1,
        observaciones || "",
        imagen_url || "",
        costoBase,
        Number(categoria_id),
        Number(redondeo) || 0,
        codigoFinal,
        descripcion || "",
        unidad_medida || "un"
      ]
    );

    await guardarProductoCompuestoConfig(result.lastID, componentes, costos_extra);
    const nuevo = await getQuery("SELECT * FROM productos WHERE id = ?", [result.lastID]);
    await registrarCambiosProducto(result.lastID, null, nuevo, usuario || "admin", "creacion producto compuesto");
    await runQuery("COMMIT");

    return res.json({
      message: "Producto compuesto guardado correctamente",
      id: result.lastID
    });
  } catch (error) {
    try {
      await runQuery("ROLLBACK");
    } catch (rollbackError) {
      logError("Rollback producto compuesto", rollbackError);
    }

    logError("Error al guardar producto compuesto:", error);
    return res.status(500).json({ message: "Error al guardar producto compuesto" });
  }
});

app.get("/productos_compuestos/:id", async (req, res) => {
  const productoId = Number(req.params.id);

  try {
    const producto = await getQuery("SELECT * FROM productos WHERE id = ?", [productoId]);

    if (!producto || (normalizarTipoProducto(producto.tipo) !== "compuesto")) {
      return res.status(404).json({ message: "Producto compuesto no encontrado" });
    }

    const [componentes, costos_extra, stock_disponible, costo] = await Promise.all([
      getComponentesProductoCompuesto(productoId),
      getCostosExtraProductoCompuesto(productoId),
      calcularStockDisponibleCompuesto(productoId),
      calcularCostoProductoCompuesto(productoId)
    ]);

    return res.json({
      ...producto,
      stock: 0,
      stock_fisico: 0,
      stock_disponible,
      stock_vendible_calculado: stock_disponible,
      precio_compra: costo,
      costo_final: costo,
      costo_teorico: costo,
      componentes,
      consumo_teorico_ingredientes: componentes.map((item) => ({
        producto_id: item.producto_id,
        producto_nombre: item.producto_nombre,
        cantidad_por_venta: Number(item.cantidad || 0),
        unidad_medida: item.unidad_medida || "un"
      })),
      costos_extra
    });
  } catch (error) {
    logError("Error al obtener producto compuesto:", error);
    return res.status(500).json({ message: "Error al obtener producto compuesto" });
  }
});

app.get("/productos_compuestos/:id/stock_disponible", async (req, res) => {
  const productoId = Number(req.params.id);

  try {
    const producto = await getQuery("SELECT id, tipo, es_combo FROM productos WHERE id = ?", [productoId]);

    if (!producto || (normalizarTipoProducto(producto.tipo) !== "compuesto")) {
      return res.status(404).json({ message: "Producto compuesto no encontrado" });
    }

    const stock_disponible = await calcularStockDisponibleCompuesto(productoId);
    return res.json({ producto_id: productoId, stock_disponible, stock_vendible_calculado: stock_disponible });
  } catch (error) {
    logError("Error al calcular stock disponible:", error);
    return res.status(500).json({ message: "Error al calcular stock disponible" });
  }
});

app.patch("/productos/aumento-masivo", async (req, res) => {
  if (!(await requirePermiso(req, res, "stock_editar_producto", "No tenes permisos para editar productos"))) return;

  const proveedorId = req.body?.proveedor_id ? Number(req.body.proveedor_id) : null;
  const categoriaId = req.body?.categoria_id ? Number(req.body.categoria_id) : null;
  const porcentaje = Number(req.body?.porcentaje) || 0;
  const campo = String(req.body?.campo || "precio_venta").trim().toLowerCase();

  if (!porcentaje) {
    return res.status(400).json({ message: "El porcentaje es obligatorio" });
  }

  if (!["precio_venta", "precio_compra", "ambos"].includes(campo)) {
    return res.status(400).json({ message: "Campo de aumento invalido" });
  }

  try {
    const where = ["activo = 1", "COALESCE(eliminado, 0) = 0"];
    const params = [];

    if (proveedorId) {
      where.push("proveedor_id = ?");
      params.push(proveedorId);
    }

    if (categoriaId) {
      where.push("categoria_id = ?");
      params.push(categoriaId);
    }

    const productos = await allQuery(
      `SELECT * FROM productos WHERE ${where.join(" AND ")}`,
      params
    );

    if (!productos.length) {
      return res.status(404).json({ message: "No hay productos que cumplan la condicion" });
    }

    const factor = 1 + porcentaje / 100;
    for (const producto of productos) {
      const precioCompra = ["precio_compra", "ambos"].includes(campo)
        ? Math.round((Number(producto.precio_compra || 0) * factor) * 100) / 100
        : Number(producto.precio_compra || 0);
      const precioVenta = ["precio_venta", "ambos"].includes(campo)
        ? Math.round((Number(producto.precio_venta || 0) * factor) * 100) / 100
        : Number(producto.precio_venta || 0);
      const costoFinal = ["precio_compra", "ambos"].includes(campo)
        ? Math.round((Number(producto.costo_final || producto.precio_compra || 0) * factor) * 100) / 100
        : Number(producto.costo_final || 0);

      await runQuery(
        "UPDATE productos SET precio_compra = ?, precio_venta = ?, costo_final = ? WHERE id = ?",
        [precioCompra, precioVenta, costoFinal, producto.id]
      );

      const actualizado = await getQuery("SELECT * FROM productos WHERE id = ?", [producto.id]);
      await registrarCambiosProducto(producto.id, producto, actualizado, "admin", "aumento masivo");
    }

    return res.json({ message: `Aumento aplicado a ${productos.length} producto(s)`, cantidad: productos.length });
  } catch (error) {
    logError("Error al aplicar aumento masivo:", error);
    return res.status(500).json({ message: "Error al aplicar aumento masivo" });
  }
});

app.patch("/productos/:id/reactivar", async (req, res) => {
  if (!(await requirePermiso(req, res, "stock_editar_producto", "No tenes permisos para editar productos"))) return;

  const productoId = Number(req.params.id);

  try {
    const existente = await getQuery("SELECT id FROM productos WHERE id = ?", [productoId]);

    if (!existente) {
      return res.status(404).json({ message: "Producto no encontrado" });
    }

    await runQuery("UPDATE productos SET activo = 1 WHERE id = ?", [productoId]);
    const actualizado = await getQuery("SELECT * FROM productos WHERE id = ?", [productoId]);
    await registrarCambiosProducto(productoId, existente, actualizado, "admin", "reactivacion");
    return res.json({ message: "Producto reactivado correctamente" });
  } catch (error) {
    logError("Error al reactivar producto:", error);
    return res.status(500).json({ message: "Error al reactivar producto" });
  }
});

app.delete("/productos/:id", async (req, res) => {
  if (!(await requirePermiso(req, res, "stock_eliminar_producto", "No tenes permisos para eliminar productos"))) return;

  const productoId = Number(req.params.id);

  try {
    const producto = await getQuery(
      "SELECT id, nombre FROM productos WHERE id = ?",
      [productoId]
    );

    if (!producto) {
      return res.status(404).json({ message: "Producto no encontrado" });
    }

    const usoEnDetalle = await getQuery(
      "SELECT COUNT(*) AS total FROM detalle_ventas WHERE producto_id = ?",
      [productoId]
    );
    const esComponente = await getQuery(
      "SELECT COUNT(*) AS total FROM producto_componentes WHERE producto_id = ?",
      [productoId]
    );

    const tieneMovimientos = Number(usoEnDetalle?.total || 0) > 0;
    const esIngrediente = Number(esComponente?.total || 0) > 0;

    if (esIngrediente) {
      return res.status(409).json({ message: "No se puede eliminar: este producto es componente de una o más recetas activas" });
    }

    if (!tieneMovimientos) {
      await runQuery("DELETE FROM productos WHERE id = ?", [productoId]);
      await logHistorialProducto(productoId, "eliminacion", "activo", "borrado", "eliminacion fisica", "admin");
      return res.json({ message: "Producto eliminado definitivamente", eliminacion: "fisica" });
    }

    const anterior = await getQuery("SELECT * FROM productos WHERE id = ?", [productoId]);
    await runQuery(
      "UPDATE productos SET activo = 0, eliminado = 1 WHERE id = ?",
      [productoId]
    );
    const actualizado = await getQuery("SELECT * FROM productos WHERE id = ?", [productoId]);
    await registrarCambiosProducto(productoId, anterior, actualizado, "admin", "eliminacion logica");

    return res.json({
      message: "Producto con historial: se aplico eliminacion logica segura",
      eliminacion: "logica"
    });
  } catch (error) {
    logError("Error al eliminar producto:", error);
    return res.status(500).json({ message: "Error al eliminar producto" });
  }
});

app.get("/categorias", async (req, res) => {
  try {
    const categorias = await allQuery(
      "SELECT * FROM categorias WHERE activo = 1 ORDER BY nombre ASC"
    );
    return res.json(categorias);
  } catch (error) {
    logError("Error al listar categorias:", error);
    return res.status(500).json({ message: "Error al obtener categorias" });
  }
});

app.post("/categorias", async (req, res) => {
  if (!(await requirePermiso(req, res, "stock_crear_producto", "No tenes permisos para crear categorias"))) return;

  const nombre = String(req.body.nombre || "").trim();
  const margen = Number(req.body.margen_porcentaje) || 0;
  const manejaStock = req.body.maneja_stock === false ? 0 : 1;
  const usaCostosVarios = req.body.usa_costos_varios ? 1 : 0;

  if (!nombre) {
    return res.status(400).json({ message: "El nombre de la categoria es obligatorio" });
  }

  try {
    const result = await runQuery(
      "INSERT INTO categorias (nombre, margen_porcentaje, maneja_stock, usa_costos_varios, activo) VALUES (?, ?, ?, ?, 1)",
      [nombre, margen, manejaStock, usaCostosVarios]
    );
    return res.json({ message: "Categoria creada correctamente", id: result.lastID });
  } catch (error) {
    logError("Error al crear categoria:", error);
    return res.status(500).json({ message: "Error al crear categoria" });
  }
});

app.put("/categorias/:id", async (req, res) => {
  if (!(await requirePermiso(req, res, "stock_editar_producto", "No tenes permisos para editar categorias"))) return;

  const categoriaId = Number(req.params.id);
  const nombre = String(req.body.nombre || "").trim();
  const margen = Number(req.body.margen_porcentaje) || 0;
  const manejaStock = req.body.maneja_stock === false ? 0 : 1;
  const usaCostosVarios = req.body.usa_costos_varios ? 1 : 0;

  if (!nombre) {
    return res.status(400).json({ message: "El nombre de la categoria es obligatorio" });
  }

  try {
    await runQuery(
      "UPDATE categorias SET nombre = ?, margen_porcentaje = ?, maneja_stock = ?, usa_costos_varios = ? WHERE id = ?",
      [nombre, margen, manejaStock, usaCostosVarios, categoriaId]
    );
    return res.json({ message: "Categoria actualizada correctamente" });
  } catch (error) {
    logError("Error al actualizar categoria:", error);
    return res.status(500).json({ message: "Error al actualizar categoria" });
  }
});

app.get("/productos/:id/costos-insumos", async (req, res) => {
  const productoId = Number(req.params.id);
  try {
    const insumos = await allQuery(
      "SELECT * FROM producto_costos_insumos WHERE producto_id = ? ORDER BY id ASC",
      [productoId]
    );
    return res.json(insumos);
  } catch (error) {
    logError("Error al obtener costos por rendimiento:", error);
    return res.status(500).json({ message: "Error al obtener costos por rendimiento" });
  }
});

app.get("/productos/:id/proveedores", async (req, res) => {
  const productoId = Number(req.params.id);

  try {
    const proveedores = await allQuery(
      `SELECT pp.*, p.nombre AS proveedor_nombre
       FROM producto_proveedores pp
       LEFT JOIN proveedores p ON p.id = pp.proveedor_id
       WHERE pp.producto_id = ?
       ORDER BY pp.es_principal DESC, pp.id DESC`,
      [productoId]
    );
    return res.json(proveedores);
  } catch (error) {
    logError("Error al obtener proveedores del producto:", error);
    return res.status(500).json({ message: "Error al obtener proveedores del producto" });
  }
});

app.post("/productos/:id/proveedores", async (req, res) => {
  if (!(await requirePermiso(req, res, "stock_editar_producto", "No tenes permisos para editar productos"))) return;

  const productoId = Number(req.params.id);
  const proveedorId = Number(req.body.proveedor_id) || 0;
  const precioCompra = Number(req.body.precio_compra) || 0;
  const esPrincipal = req.body.es_principal ? 1 : 0;
  const { fecha } = getNowParts();

  if (!proveedorId) {
    return res.status(400).json({ message: "Debe seleccionar un proveedor" });
  }

  try {
    if (esPrincipal) {
      await runQuery(
        "UPDATE producto_proveedores SET es_principal = 0 WHERE producto_id = ?",
        [productoId]
      );
    }

    await runQuery(
      `INSERT INTO producto_proveedores
      (producto_id, proveedor_id, precio_compra, fecha_actualizacion, es_principal)
      VALUES (?, ?, ?, ?, ?)`,
      [productoId, proveedorId, precioCompra, fecha, esPrincipal]
    );

    if (esPrincipal) {
      await runQuery(
        "UPDATE productos SET proveedor_id = ? WHERE id = ?",
        [proveedorId, productoId]
      );
    }

    await logHistorialProducto(productoId, "proveedor_multiple", null, `${proveedorId}:${precioCompra}`, "proveedor producto", "admin");
    return res.json({ message: "Proveedor asociado correctamente" });
  } catch (error) {
    logError("Error al asociar proveedor al producto:", error);
    return res.status(500).json({ message: "Error al asociar proveedor al producto" });
  }
});

app.post("/productos/:id/movimientos-stock", async (req, res) => {
  if (!(await requirePermiso(req, res, "stock_ajustar", "No tenes permisos para ajustar stock"))) return;

  const productoId = Number(req.params.id);
  const tipoMovimiento = String(req.body.tipo_movimiento || "").trim();
  const cantidad = Number(req.body.cantidad) || 0;
  const motivo = String(req.body.motivo || "").trim();
  const proveedorId = req.body.proveedor_id ? Number(req.body.proveedor_id) : null;
  const usuario = String(req.body.usuario || "admin").trim() || "admin";
  const { fecha, hora } = getNowParts();

  if (!tipoMovimiento || cantidad <= 0) {
    return res.status(400).json({ message: "Movimiento de stock invalido" });
  }

  try {
    const producto = await getQuery("SELECT * FROM productos WHERE id = ?", [productoId]);

    if (!producto) {
      return res.status(404).json({ message: "Producto no encontrado" });
    }
    const esCompuesto = normalizarTipoProducto(producto.tipo) === "compuesto";
    const esBatch = esCompuesto && !Number(producto.maneja_stock) && Number(producto.rendimiento_receta || 1) > 1;
    const esStockCalculado = esCompuesto && !Number(producto.maneja_stock) && !esBatch;
    if (esStockCalculado) {
      return res.status(400).json({ message: "Este producto no posee stock propio. Ajusta sus ingredientes." });
    }

    const stockAnterior = Number(producto.stock || 0);
    const tiposPositivos = ["ingreso", "ajuste positivo", "devolucion"];
    const esIngreso = tiposPositivos.includes(tipoMovimiento.toLowerCase());
    const stockNuevo = esIngreso ? stockAnterior + cantidad : stockAnterior - cantidad;

    // Para batch counter: si el egreso lo deja en <= 0, activar replenishment automático
    let stockFinal = stockNuevo;
    let batchesReponer = 0;
    if (esBatch && !esIngreso && stockNuevo <= 0) {
      const rendimiento = Number(producto.rendimiento_receta);
      let restante = stockNuevo;
      while (restante <= 0) {
        batchesReponer++;
        restante += rendimiento;
      }
      stockFinal = restante;
    }

    await runQuery("BEGIN TRANSACTION");
    await runQuery(
      `INSERT INTO movimientos_stock
      (producto_id, tipo_movimiento, cantidad, stock_anterior, stock_nuevo, motivo, proveedor_id, usuario, fecha, hora)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [productoId, tipoMovimiento, cantidad, stockAnterior, stockFinal, motivo, proveedorId, usuario, fecha, hora]
    );
    await runQuery("UPDATE productos SET stock = ? WHERE id = ?", [stockFinal, productoId]);

    // Batch counter: consumir ingredientes de los batches necesarios
    if (esBatch && batchesReponer > 0) {
      const rendimiento = Number(producto.rendimiento_receta);
      const componentes = await getComponentesProductoCompuesto(productoId);
      for (const comp of componentes) {
        const consumo = Number(comp.cantidad || 0) * rendimiento * batchesReponer;
        if (consumo <= 0) continue;
        const ing = await getQuery("SELECT stock FROM productos WHERE id = ?", [comp.producto_id]);
        if (ing) {
          const nuevoStockIng = Number(ing.stock || 0) - consumo;
          await runQuery("UPDATE productos SET stock = ? WHERE id = ?", [nuevoStockIng, comp.producto_id]);
          await runQuery(
            `INSERT INTO movimientos_stock (producto_id, tipo_movimiento, cantidad, stock_anterior, stock_nuevo, motivo, usuario, fecha, hora)
             VALUES (?, 'egreso', ?, ?, ?, ?, ?, ?, ?)`,
            [comp.producto_id, consumo, Number(ing.stock || 0), nuevoStockIng,
             `Replenishment batch: ${producto.nombre} (${batchesReponer} lote/s)`, usuario, fecha, hora]
          );
        }
      }
    }

    // Si es receta con stock propio y es un ingreso, descontar ingredientes
    if (esCompuesto && Number(producto.maneja_stock) && esIngreso) {
      const componentes = await getComponentesProductoCompuesto(productoId);
      for (const comp of componentes) {
        const consumo = cantidad * Number(comp.cantidad);
        // Para batch counters: usar applyStockChange (dispara replenishment si llega a 0)
        // Para el resto: descuento directo (evita doble-multiplicación de fracciones gr/ml)
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
          if (ing) {
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
    }
    if (normalizarTipoProducto(producto.tipo) === "compuesto") {
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
    await logHistorialProducto(productoId, "stock", stockAnterior, stockNuevo, motivo || tipoMovimiento, usuario);
    await runQuery("COMMIT");

    const mensajeMovimiento = esBatch
      ? `Contador actualizado: ${stockNuevo}/${producto.rendimiento_receta} porciones`
      : "Movimiento registrado correctamente";
    return res.json({ message: mensajeMovimiento, stock_nuevo: stockNuevo });
  } catch (error) {
    try {
      await runQuery("ROLLBACK");
    } catch {}
    logError("Error al registrar movimiento de stock:", error);
    return res.status(500).json({ message: "Error al registrar movimiento de stock" });
  }
});

app.get("/productos/:id/movimientos-stock", async (req, res) => {
  const productoId = Number(req.params.id);

  try {
    const movimientos = await allQuery(
      `SELECT ms.*, p.nombre AS proveedor_nombre
       FROM movimientos_stock ms
       LEFT JOIN proveedores p ON p.id = ms.proveedor_id
       WHERE ms.producto_id = ?
       ORDER BY ms.id DESC`,
      [productoId]
    );
    return res.json(movimientos);
  } catch (error) {
    logError("Error al obtener movimientos de stock:", error);
    return res.status(500).json({ message: "Error al obtener movimientos de stock" });
  }
});

app.get("/productos/:id/historial", async (req, res) => {
  const productoId = Number(req.params.id);

  try {
    const historial = await allQuery(
      `SELECT *
       FROM historial_productos
       WHERE producto_id = ?
       ORDER BY id DESC`,
      [productoId]
    );
    return res.json(historial);
  } catch (error) {
    logError("Error al obtener historial del producto:", error);
    return res.status(500).json({ message: "Error al obtener historial del producto" });
  }
});

function parseProveedorPayload(body) {
  const condicionRaw = String(body.condicion_iva || "").trim().toLowerCase();
  const comprobanteRaw = String(body.tipo_comprobante || "").trim().toLowerCase();
  const condicionNormalizada = condicionRaw.includes("responsable") || condicionRaw === "ri" ? "responsable_inscripto" : condicionRaw;
  const comprobanteNormalizado = comprobanteRaw.includes("fact") && comprobanteRaw.endsWith("a") ? "factura_a"
    : comprobanteRaw.includes("fact") && comprobanteRaw.endsWith("b") ? "factura_b"
      : comprobanteRaw.includes("fact") && comprobanteRaw.endsWith("c") ? "factura_c"
        : comprobanteRaw.includes("rec") ? "recibo_x"
          : comprobanteRaw;
  return {
    nombre: String(body.nombre || "").trim(),
    alias: String(body.alias || "").trim(),
    cuit: String(body.cuit || "").trim(),
    tipo_persona: String(body.tipo_persona || "juridica").trim().toLowerCase(),
    telefono: String(body.telefono || "").trim(),
    email: String(body.email || "").trim(),
    contacto: String(body.contacto || "").trim(),
    direccion: String(body.direccion || "").trim(),
    localidad: String(body.localidad || "").trim(),
    codigo_postal: String(body.codigo_postal || "").trim(),
    observaciones: String(body.observaciones || "").trim(),
    maneja_cuenta_corriente: body.maneja_cuenta_corriente ? 1 : 0,
    limite_credito: Math.max(0, Number(body.limite_credito) || 0),
    dias_vencimiento: Math.max(0, Number(body.dias_vencimiento) || 0),
    dia_vencimiento_fijo: body.dia_vencimiento_fijo ? Number(body.dia_vencimiento_fijo) : null,
    moneda: String(body.moneda || "ARS").trim().toUpperCase(),
    tipo_impacto: PROVEEDOR_IMPACTOS.has(String(body.tipo_impacto || "").trim().toLowerCase())
      ? String(body.tipo_impacto).trim().toLowerCase()
      : "otro_no_computable",
    categoria_id: body.categoria_id ? Number(body.categoria_id) : null,
    categoria_especial: String(body.categoria_especial || "").trim(),
    condicion_iva: PROVEEDOR_CONDICIONES_IVA.has(condicionNormalizada) ? condicionNormalizada : "responsable_inscripto",
    tipo_comprobante: PROVEEDOR_COMPROBANTES.has(comprobanteNormalizado) ? comprobanteNormalizado : "factura_a",
    iva_alicuota: Math.max(0, Number(body.iva_alicuota) || 21),
    activo: body.activo === false || Number(body.activo) === 0 ? 0 : 1
  };
}

function calcularIvaCreditoFiscal(montoTotal, proveedor) {
  const condicion = String(proveedor?.condicion_iva || "").trim().toLowerCase();
  const comprobante = String(proveedor?.tipo_comprobante || "").trim().toLowerCase();
  const alicuota = Math.max(0, Number(proveedor?.iva_alicuota) || 0);
  if (condicion !== "responsable_inscripto" || comprobante !== "factura_a" || alicuota <= 0) return 0;
  return Number((Number(montoTotal || 0) * alicuota / (100 + alicuota)).toFixed(2));
}

async function getProveedorConMetricas(proveedorId) {
  return getQuery(
    `SELECT p.*, cat.nombre AS categoria_nombre,
            COALESCE(stats.pagos_mes, 0) AS pagos_mes,
            COALESCE(stats.compras_mes, 0) AS compras_mes,
            COALESCE(stats.compras_anio, 0) AS compras_anio,
            COALESCE(stats.saldo_pendiente, 0) AS saldo_pendiente,
            stats.ultima_compra AS ultima_compra
     FROM proveedores p
     LEFT JOIN categorias cat ON cat.id = p.categoria_id
     LEFT JOIN (
       SELECT proveedor_id,
              SUM(CASE WHEN estado != 'pendiente' AND strftime('%Y-%m', fecha) = strftime('%Y-%m', 'now', 'localtime') THEN monto_total ELSE 0 END) AS pagos_mes,
              SUM(CASE WHEN strftime('%Y-%m', fecha) = strftime('%Y-%m', 'now', 'localtime') THEN monto_total ELSE 0 END) AS compras_mes,
              SUM(CASE WHEN strftime('%Y', fecha) = strftime('%Y', 'now', 'localtime') THEN monto_total ELSE 0 END) AS compras_anio,
              SUM(CASE WHEN estado = 'pendiente' THEN monto_total ELSE 0 END) AS saldo_pendiente,
              MAX(fecha) AS ultima_compra
       FROM pagos
       WHERE proveedor_id IS NOT NULL
       GROUP BY proveedor_id
     ) stats ON stats.proveedor_id = p.id
     WHERE p.id = ?`,
    [proveedorId]
  );
}

// Listar proveedores
app.get("/proveedores", async (req, res) => {
  try {
    const includeInactive = String(req.query.include_inactive || "") === "1";
    const proveedores = await allQuery(
      `SELECT p.*, cat.nombre AS categoria_nombre,
              COALESCE(stats.pagos_mes, 0) AS pagos_mes,
              COALESCE(stats.compras_mes, 0) AS compras_mes,
              COALESCE(stats.compras_anio, 0) AS compras_anio,
              COALESCE(stats.saldo_pendiente, 0) AS saldo_pendiente,
              stats.ultima_compra AS ultima_compra
       FROM proveedores p
       LEFT JOIN categorias cat ON cat.id = p.categoria_id
       LEFT JOIN (
         SELECT proveedor_id,
                SUM(CASE WHEN estado != 'pendiente' AND strftime('%Y-%m', fecha) = strftime('%Y-%m', 'now', 'localtime') THEN monto_total ELSE 0 END) AS pagos_mes,
                SUM(CASE WHEN strftime('%Y-%m', fecha) = strftime('%Y-%m', 'now', 'localtime') THEN monto_total ELSE 0 END) AS compras_mes,
                SUM(CASE WHEN strftime('%Y', fecha) = strftime('%Y', 'now', 'localtime') THEN monto_total ELSE 0 END) AS compras_anio,
                SUM(CASE WHEN estado = 'pendiente' THEN monto_total ELSE 0 END) AS saldo_pendiente,
                MAX(fecha) AS ultima_compra
         FROM pagos
         WHERE proveedor_id IS NOT NULL
         GROUP BY proveedor_id
       ) stats ON stats.proveedor_id = p.id
       ${includeInactive ? "" : "WHERE p.activo = 1"}
       ORDER BY p.nombre ASC`
    );
    return res.json(proveedores);
  } catch (error) {
    logError("Error al listar proveedores:", error);
    return res.status(500).json({ message: "Error al obtener proveedores" });
  }
});

app.get("/proveedores/:id/movimientos", async (req, res) => {
  const proveedorId = Number(req.params.id);

  try {
    const proveedor = await getQuery("SELECT id FROM proveedores WHERE id = ?", [proveedorId]);
    if (!proveedor) {
      return res.status(404).json({ message: "Proveedor no encontrado" });
    }

    const pagos = await allQuery(
      `SELECT id, fecha, hora, monto_total AS monto, estado, tipo_pago, comprobante, numero_comprobante,
              referencia, observaciones, 'pago' AS tipo_movimiento
       FROM pagos
       WHERE proveedor_id = ?
       ORDER BY fecha DESC, hora DESC, id DESC`,
      [proveedorId]
    );

    const stock = await allQuery(
      `SELECT ms.id, ms.fecha, ms.hora, ms.cantidad AS monto, ms.tipo_movimiento AS estado,
              p.nombre AS producto_nombre, ms.motivo AS observaciones, 'stock' AS tipo_movimiento
       FROM movimientos_stock ms
       LEFT JOIN productos p ON p.id = ms.producto_id
       WHERE ms.proveedor_id = ?
       ORDER BY ms.fecha DESC, ms.hora DESC, ms.id DESC`,
      [proveedorId]
    );

    return res.json([...pagos, ...stock].sort((a, b) => `${b.fecha} ${b.hora} ${b.id}`.localeCompare(`${a.fecha} ${a.hora} ${a.id}`)));
  } catch (error) {
    logError("Error al obtener movimientos del proveedor:", error);
    return res.status(500).json({ message: "Error al obtener movimientos del proveedor" });
  }
});

// Crear proveedor
app.post("/proveedores", async (req, res) => {
  const proveedorData = parseProveedorPayload(req.body);

  if (!proveedorData.nombre) {
    return res.status(400).json({ message: "El nombre del proveedor es obligatorio" });
  }

  if (!["fisica", "juridica"].includes(proveedorData.tipo_persona)) {
    return res.status(400).json({ message: "Tipo de persona invalido" });
  }

  if (proveedorData.dia_vencimiento_fijo && (proveedorData.dia_vencimiento_fijo < 1 || proveedorData.dia_vencimiento_fijo > 31)) {
    return res.status(400).json({ message: "Dia de vencimiento fijo invalido" });
  }

  try {
    const existente = proveedorData.cuit ? await getQuery(
      "SELECT id FROM proveedores WHERE cuit = ?",
      [proveedorData.cuit]
    ) : null;

    if (existente) {
      return res.status(409).json({ message: "Ya existe un proveedor con ese CUIT" });
    }

    const result = await runQuery(
      `INSERT INTO proveedores
       (nombre, alias, cuit, tipo_persona, telefono, email, contacto, direccion, localidad, codigo_postal,
        observaciones, maneja_cuenta_corriente, limite_credito, dias_vencimiento, dia_vencimiento_fijo, moneda, tipo_impacto, categoria_id, categoria_especial,
        condicion_iva, tipo_comprobante, iva_alicuota, activo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        proveedorData.nombre,
        proveedorData.alias,
        proveedorData.cuit,
        proveedorData.tipo_persona,
        proveedorData.telefono,
        proveedorData.email,
        proveedorData.contacto,
        proveedorData.direccion,
        proveedorData.localidad,
        proveedorData.codigo_postal,
        proveedorData.observaciones,
        proveedorData.maneja_cuenta_corriente,
        proveedorData.limite_credito,
        proveedorData.dias_vencimiento,
        proveedorData.dia_vencimiento_fijo,
        proveedorData.moneda,
        proveedorData.tipo_impacto,
        proveedorData.categoria_id,
        proveedorData.categoria_especial,
        proveedorData.condicion_iva,
        proveedorData.tipo_comprobante,
        proveedorData.iva_alicuota,
        proveedorData.activo
      ]
    );

    return res.json({
      message: "Proveedor creado correctamente",
      proveedor: await getProveedorConMetricas(result.lastID)
    });
  } catch (error) {
    logError("Error al crear proveedor:", error);
    return res.status(500).json({ message: "Error al crear proveedor" });
  }
});

app.put("/proveedores/:id", async (req, res) => {
  const proveedorId = Number(req.params.id);
  const proveedorData = parseProveedorPayload(req.body);

  if (!proveedorData.nombre) {
    return res.status(400).json({ message: "El nombre del proveedor es obligatorio" });
  }

  try {
    const existente = await getQuery("SELECT id FROM proveedores WHERE id = ?", [proveedorId]);
    if (!existente) {
      return res.status(404).json({ message: "Proveedor no encontrado" });
    }

    const cuitExistente = proveedorData.cuit ? await getQuery(
      "SELECT id FROM proveedores WHERE cuit = ? AND id != ?",
      [proveedorData.cuit, proveedorId]
    ) : null;

    if (cuitExistente) {
      return res.status(409).json({ message: "Ya existe otro proveedor con ese CUIT" });
    }

    await runQuery(
      `UPDATE proveedores
       SET nombre = ?, alias = ?, cuit = ?, tipo_persona = ?, telefono = ?, email = ?, contacto = ?,
           direccion = ?, localidad = ?, codigo_postal = ?, observaciones = ?, maneja_cuenta_corriente = ?,
           limite_credito = ?, dias_vencimiento = ?, dia_vencimiento_fijo = ?, moneda = ?, tipo_impacto = ?, categoria_id = ?, categoria_especial = ?,
           condicion_iva = ?, tipo_comprobante = ?, iva_alicuota = ?, activo = ?
       WHERE id = ?`,
      [
        proveedorData.nombre,
        proveedorData.alias,
        proveedorData.cuit,
        proveedorData.tipo_persona,
        proveedorData.telefono,
        proveedorData.email,
        proveedorData.contacto,
        proveedorData.direccion,
        proveedorData.localidad,
        proveedorData.codigo_postal,
        proveedorData.observaciones,
        proveedorData.maneja_cuenta_corriente,
        proveedorData.limite_credito,
        proveedorData.dias_vencimiento,
        proveedorData.dia_vencimiento_fijo,
        proveedorData.moneda,
        proveedorData.tipo_impacto,
        proveedorData.categoria_id,
        proveedorData.categoria_especial,
        proveedorData.condicion_iva,
        proveedorData.tipo_comprobante,
        proveedorData.iva_alicuota,
        proveedorData.activo,
        proveedorId
      ]
    );

    return res.json({
      message: "Proveedor actualizado correctamente",
      proveedor: await getProveedorConMetricas(proveedorId)
    });
  } catch (error) {
    logError("Error al actualizar proveedor:", error);
    return res.status(500).json({ message: "Error al actualizar proveedor" });
  }
});

app.patch("/proveedores/:id/estado", async (req, res) => {
  const proveedorId = Number(req.params.id);
  const activo = req.body.activo ? 1 : 0;

  try {
    const proveedor = await getQuery("SELECT id FROM proveedores WHERE id = ?", [proveedorId]);
    if (!proveedor) {
      return res.status(404).json({ message: "Proveedor no encontrado" });
    }

    await runQuery("UPDATE proveedores SET activo = ? WHERE id = ?", [activo, proveedorId]);
    return res.json({
      message: activo ? "Proveedor activado" : "Proveedor desactivado",
      proveedor: await getProveedorConMetricas(proveedorId)
    });
  } catch (error) {
    logError("Error al cambiar estado del proveedor:", error);
    return res.status(500).json({ message: "Error al cambiar estado del proveedor" });
  }
});

app.delete("/proveedores/:id", async (req, res) => {
  const proveedorId = Number(req.params.id);

  try {
    const proveedor = await getQuery("SELECT id FROM proveedores WHERE id = ?", [proveedorId]);
    if (!proveedor) {
      return res.status(404).json({ message: "Proveedor no encontrado" });
    }

    const usos = await getQuery(
      `SELECT
         (SELECT COUNT(*) FROM pagos WHERE proveedor_id = ?) AS pagos,
         (SELECT COUNT(*) FROM productos WHERE proveedor_id = ?) AS productos,
         (SELECT COUNT(*) FROM movimientos_stock WHERE proveedor_id = ?) AS movimientos`,
      [proveedorId, proveedorId, proveedorId]
    );

    if (Number(usos.pagos || 0) + Number(usos.productos || 0) + Number(usos.movimientos || 0) > 0) {
      return res.status(409).json({ message: "No se puede eliminar un proveedor con movimientos. Se puede desactivar." });
    }

    await runQuery("DELETE FROM proveedores WHERE id = ?", [proveedorId]);
    return res.json({ message: "Proveedor eliminado correctamente" });
  } catch (error) {
    logError("Error al eliminar proveedor:", error);
    return res.status(500).json({ message: "Error al eliminar proveedor" });
  }
});

// Listar pagos
app.get("/pagos", async (req, res) => {
  try {
    const pagos = await allQuery(
      `SELECT p.*, pr.nombre AS proveedor_nombre, pr.tipo_impacto AS proveedor_tipo_impacto,
              pr.condicion_iva AS proveedor_condicion_iva, pr.tipo_comprobante AS proveedor_tipo_comprobante,
              pr.iva_alicuota AS proveedor_iva_alicuota,
              CASE
                WHEN p.estado != 'pendiente'
                 AND pr.condicion_iva = 'responsable_inscripto'
                 AND pr.tipo_comprobante = 'factura_a'
                 AND COALESCE(pr.iva_alicuota, 0) > 0
                THEN ROUND(p.monto_total * pr.iva_alicuota / (100 + pr.iva_alicuota), 2)
                ELSE COALESCE(p.iva_credito_fiscal, 0)
              END AS iva_credito_fiscal_estimado
       FROM pagos p
       LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
       ORDER BY p.fecha DESC, p.hora DESC, p.id DESC`
    );

    return res.json(pagos);
  } catch (error) {
    logError("Error al listar pagos:", error);
    return res.status(500).json({ message: "Error al obtener pagos" });
  }
});

// Registrar pago
app.post("/pagos", async (req, res) => {
  if (!(await requirePermiso(req, res, "pagos_crear", "No tenes permisos para registrar pagos"))) return;

  const proveedorId = req.body.proveedor_id ? Number(req.body.proveedor_id) : null;
  const concepto = String(req.body.concepto || "").trim();
  const montoTotal = Number(req.body.monto_total) || 0;
  const tipoPago = String(req.body.tipo_pago || "").trim().toLowerCase();
  let categoriaPago = String(req.body.categoria_pago || "otro_no_computable").trim().toLowerCase();
  const comprobante = String(req.body.comprobante || "").trim();
  const numeroComprobante = String(req.body.numero_comprobante || "").trim();
  const cuentaDestino = String(req.body.cuenta_destino || "").trim();
  const referencia = String(req.body.referencia || "").trim();
  const observaciones = String(req.body.observaciones || "").trim();
  const estadoPago = String(req.body.estado || "registrado").trim().toLowerCase();
  const esCuentaCorriente = req.body.es_cuenta_corriente ? 1 : 0;
  const nowParts = getNowParts();
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.fecha || ""))
    ? String(req.body.fecha)
    : nowParts.fecha;
  const hora = nowParts.hora;

  if (!concepto) {
    return res.status(400).json({ message: "El concepto es obligatorio" });
  }

  if (montoTotal <= 0) {
    return res.status(400).json({ message: "El monto debe ser mayor a cero" });
  }

  let proveedorPago = null;
  if (proveedorId) {
    proveedorPago = await getQuery(
      "SELECT id, tipo_impacto, condicion_iva, tipo_comprobante, iva_alicuota FROM proveedores WHERE id = ? AND activo = 1",
      [proveedorId]
    );

    if (!proveedorPago) {
      return res.status(400).json({ message: "Proveedor invalido" });
    }

    categoriaPago = PROVEEDOR_IMPACTOS.has(String(proveedorPago.tipo_impacto || "").trim().toLowerCase())
      ? String(proveedorPago.tipo_impacto).trim().toLowerCase()
      : "otro_no_computable";
  }

  if (!["registrado", "pendiente"].includes(estadoPago)) {
    return res.status(400).json({ message: "Estado de pago invalido" });
  }

  const cobro = resolveCobroData(
    montoTotal,
    tipoPago,
    req.body.monto_efectivo,
    req.body.monto_debito
  );

  if (!cobro) {
    return res.status(400).json({ message: "Los montos del pago no son validos" });
  }

  try {
    if (!PROVEEDOR_IMPACTOS.has(categoriaPago)) {
      return res.status(400).json({ message: "Impacto de pago invalido. Revisar el proveedor." });
    }

    const requiereCaja = estadoPago !== "pendiente";
    const cajaActiva = requiereCaja ? await getCajaAbiertaActual() : null;
    const ivaCreditoFiscal = estadoPago === "pendiente" ? 0 : calcularIvaCreditoFiscal(montoTotal, proveedorPago);

    if (requiereCaja && !cajaActiva) {
      return res.status(400).json({ message: "No hay una caja abierta para registrar el pago" });
    }

    const result = await runQuery(
      `INSERT INTO pagos
      (proveedor_id, concepto, monto_total, tipo_pago, monto_efectivo, monto_debito, fecha, hora, estado, caja_id,
       categoria_pago, comprobante, numero_comprobante, cuenta_destino, referencia, observaciones, es_cuenta_corriente, iva_credito_fiscal)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        proveedorId,
        concepto,
        montoTotal,
        cobro.tipo_cobro,
        estadoPago === "pendiente" ? 0 : cobro.monto_efectivo,
        estadoPago === "pendiente" ? 0 : cobro.monto_debito,
        fecha,
        hora,
        estadoPago,
        cajaActiva?.id || null,
        categoriaPago,
        comprobante,
        numeroComprobante,
        cuentaDestino,
        referencia,
        observaciones,
        esCuentaCorriente,
        ivaCreditoFiscal
      ]
    );

    const pago = await getQuery(
      "SELECT * FROM pagos WHERE id = ?",
      [result.lastID]
    );

    return res.json({
      message: "Pago registrado correctamente",
      pago
    });
  } catch (error) {
    logError("Error al registrar pago:", error);
    return res.status(500).json({ message: "Error al registrar pago" });
  }
});

// Editar pago — requiere clave maestra 1234. Con arqueo solo Dueño/Encargado.
app.put("/pagos/:id", async (req, res) => {
  if (!(await requirePermiso(req, res, "pagos_editar", "No tenes permisos para editar pagos"))) return;

  const pagoId = Number(req.params.id);
  const { clave, rol, concepto, monto_total, tipo_pago, monto_efectivo, monto_debito,
          categoria_pago, comprobante, numero_comprobante, cuenta_destino, observaciones } = req.body;

  const claveConfig = await getClaveAutorizacion();
  if (clave !== claveConfig) {
    return res.status(403).json({ message: "Clave maestra incorrecta" });
  }

  try {
    const pago = await getQuery("SELECT * FROM pagos WHERE id = ?", [pagoId]);
    if (!pago) return res.status(404).json({ message: "Pago no encontrado" });

    let tieneArqueo = false;
    let cajaEstado = null;

    if (pago.caja_id) {
      const caja = await getQuery("SELECT estado FROM caja_aperturas WHERE id = ?", [pago.caja_id]);
      cajaEstado = caja?.estado || null;
      const arqueo = await getQuery("SELECT id FROM caja_arqueos WHERE caja_id = ?", [pago.caja_id]);
      tieneArqueo = !!arqueo;
    }

    const esPrivilegiado = rol === "admin" || rol === "encargado";
    if (tieneArqueo && !esPrivilegiado) {
      return res.status(403).json({ message: "Este pago pertenece a un arqueo registrado. Solo Dueño o Encargado puede editarlo." });
    }

    // Preservar valores originales para campos NOT NULL que no se editan en el form
    await runQuery(
      `UPDATE pagos SET concepto=?, monto_total=?, tipo_pago=?, monto_efectivo=?, monto_debito=?,
       categoria_pago=?, comprobante=?, numero_comprobante=?, cuenta_destino=?, observaciones=? WHERE id = ?`,
      [
        concepto ?? pago.concepto,
        Number(monto_total) || Number(pago.monto_total) || 0,
        tipo_pago ?? pago.tipo_pago,
        monto_efectivo != null ? Number(monto_efectivo) : Number(pago.monto_efectivo) || 0,
        monto_debito != null ? Number(monto_debito) : Number(pago.monto_debito) || 0,
        categoria_pago ?? pago.categoria_pago ?? null,
        comprobante ?? pago.comprobante ?? null,
        numero_comprobante ?? pago.numero_comprobante ?? null,
        cuenta_destino ?? pago.cuenta_destino ?? null,
        observaciones ?? pago.observaciones ?? null,
        pagoId
      ]
    );

    return res.json({ message: "Pago actualizado correctamente", tieneArqueo, cajaEstado });
  } catch (error) {
    logError("Error al editar pago:", error);
    return res.status(500).json({ message: "Error al editar pago" });
  }
});

// Eliminar pago — bloqueado si la caja está cerrada (tiene cierre registrado)
app.delete("/pagos/:id", async (req, res) => {
  if (!(await requirePermiso(req, res, "pagos_eliminar", "No tenes permisos para eliminar pagos"))) return;

  const pagoId = Number(req.params.id);
  const { clave, rol } = req.body;

  const claveConfig = await getClaveAutorizacion();
  if (clave !== claveConfig) {
    return res.status(403).json({ message: "Clave maestra incorrecta" });
  }

  try {
    const pago = await getQuery("SELECT * FROM pagos WHERE id = ?", [pagoId]);
    if (!pago) return res.status(404).json({ message: "Pago no encontrado" });

    if (pago.caja_id) {
      const caja = await getQuery("SELECT estado FROM caja_aperturas WHERE id = ?", [pago.caja_id]);
      if (caja?.estado === "cerrada") {
        return res.status(403).json({ message: "No se puede eliminar un pago de una caja cerrada." });
      }
    }

    await runQuery("BEGIN TRANSACTION");
    await runQuery("DELETE FROM pagos WHERE id = ?", [pagoId]);
    await runQuery("COMMIT");
    return res.json({ message: "Pago eliminado" });
  } catch (error) {
    try { await runQuery("ROLLBACK"); } catch {}
    logError("Error al eliminar pago", error, "id: " + pagoId);
    return res.status(500).json({ message: "Error al eliminar pago" });
  }
});

// Registrar venta o pendiente
app.post("/ventas", async (req, res) => {
  const {
    items,
    usuario,
    tipo,
    estado,
    identificador_pendiente,
    cliente_id,
    es_cuenta_corriente,
    tipo_cobro,
    monto_efectivo,
    monto_debito
  } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "El ticket no puede estar vacio" });
  }

  const itemsNormalizados = normalizeItems(items);
  const hayItemInvalido = itemsNormalizados.some((item) => {
    return !item.nombre_producto || item.cantidad <= 0;
  });

  if (hayItemInvalido) {
    return res.status(400).json({ message: "Hay productos invalidos en el ticket" });
  }

  const tipoVenta = tipo || "normal";
  const identificadorPendiente =
    tipoVenta === "pendiente" ? String(identificador_pendiente || "").trim() : null;

  if (tipoVenta === "pendiente" && !identificadorPendiente) {
    return res.status(400).json({ message: "El ticket pendiente necesita un identificador" });
  }

  const esCuentaCorriente = Boolean(es_cuenta_corriente);
  const estadoVenta = tipoVenta === "pendiente"
    ? "pendiente"
    : esCuentaCorriente
      ? "cuenta_corriente_pendiente"
      : "cobrada";
  const total = calculateTotal(itemsNormalizados);
  const { fecha, hora } = getNowParts();
  const usuarioVenta = usuario || "admin";
  const clienteId = cliente_id ? Number(cliente_id) : null;
  const cobro = tipoVenta === "normal" && !esCuentaCorriente
    ? resolveCobroData(total, tipo_cobro, monto_efectivo, monto_debito)
    : {
        tipo_cobro: null,
        monto_efectivo: 0,
        monto_debito: 0
      };

  if (tipoVenta === "normal" && !esCuentaCorriente && !cobro) {
    return res.status(400).json({ message: "Datos de cobro invalidos" });
  }

  if (esCuentaCorriente && !clienteId) {
    return res.status(400).json({ message: "La cuenta corriente requiere cliente asociado" });
  }

  if (esCuentaCorriente && clienteId) {
    const clienteCC = await getQuery("SELECT habilita_cuenta_corriente FROM clientes WHERE id = ?", [clienteId]);
    if (!clienteCC || Number(clienteCC.habilita_cuenta_corriente) !== 1) {
      return res.status(400).json({ message: "Este cliente no tiene cuenta corriente habilitada" });
    }
  }

  if (clienteId) {
    const cliente = await getQuery(
      "SELECT id FROM clientes WHERE id = ? AND activo = 1",
      [clienteId]
    );

    if (!cliente) {
      return res.status(400).json({ message: "Cliente invalido" });
    }
  }

  try {
    const cajaActiva = await getCajaAbiertaActual();

    if (tipoVenta === "normal" && !cajaActiva) {
      return res.status(400).json({ message: "No hay una caja abierta para registrar la venta" });
    }

    await runQuery("BEGIN TRANSACTION");

    // metodo_pago es alias legacy de tipo_cobro — ambos reciben el mismo valor
    const venta = await runQuery(
      `INSERT INTO ventas
      (fecha, hora, usuario, total, tipo, estado, identificador_pendiente, metodo_pago, tipo_cobro, monto_efectivo, monto_debito, cliente_id, es_cuenta_corriente, saldo_pendiente, caja_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fecha,
        hora,
        usuarioVenta,
        total,
        tipoVenta,
        estadoVenta,
        identificadorPendiente,
        cobro.tipo_cobro,
        cobro.tipo_cobro,
        cobro.monto_efectivo,
        cobro.monto_debito,
        clienteId,
        esCuentaCorriente ? 1 : 0,
        esCuentaCorriente ? total : 0,
        tipoVenta === "normal" ? cajaActiva.id : null
      ]
    );

    await replaceVentaDetalle(venta.lastID, itemsNormalizados);
    await applyStockForNewItems(itemsNormalizados);

    await runQuery("COMMIT");

    return res.json({
      message: tipoVenta === "pendiente" ? "Ticket pendiente guardado" : "Venta registrada",
      venta_id: venta.lastID,
      total
    });
  } catch (error) {
    try {
      await runQuery("ROLLBACK");
    } catch (rollbackError) {
      logError("Rollback venta", rollbackError);
    }

    logError("Error al registrar venta:", error);
    return res.status(500).json({ message: "Error al registrar venta" });
  }
});

// Resumen de cuenta corriente por cliente
app.get("/clientes/:id/cuenta-corriente", async (req, res) => {
  const clienteId = Number(req.params.id);

  try {
    const cliente = await getQuery(
      "SELECT * FROM clientes WHERE id = ?",
      [clienteId]
    );

    if (!cliente) {
      return res.status(404).json({ message: "Cliente no encontrado" });
    }

    const ventasPendientesBase = await allQuery(
      `SELECT id, fecha, total, saldo_pendiente
       FROM ventas
       WHERE cliente_id = ? AND es_cuenta_corriente = 1 AND saldo_pendiente > 0
       ORDER BY id DESC`,
      [clienteId]
    );

    const ventasPendientes = [];

    for (const venta of ventasPendientesBase) {
      const snapshot = await refreshCuentaCorrienteSaldo(venta.id);

      if (!snapshot || snapshot.saldo_actual <= 0) {
        continue;
      }

      ventasPendientes.push({
        id: venta.id,
        fecha: venta.fecha,
        total_historico: Number(snapshot.venta.total || 0),
        total_actual: snapshot.total_actual,
        total_pagado: snapshot.total_pagado,
        saldo_pendiente: snapshot.saldo_actual,
        items: snapshot.items
      });
    }

    const saldo = ventasPendientes.reduce((acc, venta) => acc + Number(venta.saldo_pendiente || 0), 0);

    return res.json({
      cliente,
      saldo_pendiente: saldo,
      ventas_pendientes: ventasPendientes
    });
  } catch (error) {
    logError("Error al obtener cuenta corriente:", error);
    return res.status(500).json({ message: "Error al obtener cuenta corriente" });
  }
});

app.get("/clientes/:id/movimientos-cuenta-corriente", async (req, res) => {
  const clienteId = Number(req.params.id);

  try {
    const cliente = await getQuery("SELECT * FROM clientes WHERE id = ?", [clienteId]);
    if (!cliente) {
      return res.status(404).json({ message: "Cliente no encontrado" });
    }

    const ventas = await allQuery(
      `SELECT id, fecha, hora, total AS importe, saldo_pendiente, tipo_cobro, identificador_pendiente,
              'venta' AS tipo_movimiento
       FROM ventas
       WHERE cliente_id = ? AND es_cuenta_corriente = 1
       ORDER BY fecha ASC, hora ASC, id ASC`,
      [clienteId]
    );
    const pagos = await allQuery(
      `SELECT id, venta_id, fecha, hora, monto_pagado AS importe, tipo_cobro, 'pago' AS tipo_movimiento
       FROM pagos_cuenta_corriente
       WHERE cliente_id = ?
       ORDER BY fecha ASC, hora ASC, id ASC`,
      [clienteId]
    );

    const movimientos = [...ventas, ...pagos].sort((a, b) => `${a.fecha} ${a.hora} ${a.id}`.localeCompare(`${b.fecha} ${b.hora} ${b.id}`));
    let saldo = 0;
    const conSaldo = movimientos.map((movimiento) => {
      saldo += movimiento.tipo_movimiento === "pago"
        ? -Number(movimiento.importe || 0)
        : Number(movimiento.importe || 0);
      return {
        ...movimiento,
        saldo_acumulado: Number(Math.max(0, saldo).toFixed(2))
      };
    }).reverse();

    return res.json(conSaldo);
  } catch (error) {
    logError("Error al obtener movimientos de cuenta corriente:", error);
    return res.status(500).json({ message: "Error al obtener movimientos de cuenta corriente" });
  }
});

app.post("/clientes/:id/venta-cuenta", async (req, res) => {
  const clienteId = Number(req.params.id);
  const total = Number(req.body.total) || 0;
  const concepto = String(req.body.concepto || "Venta a cuenta").trim();
  const autorizarExcedido = Boolean(req.body.autorizar_excedido);
  const items = Array.isArray(req.body.items) && req.body.items.length
    ? normalizeItems(req.body.items)
    : normalizeItems([{ nombre_producto: concepto, cantidad: 1, precio_unitario: total }]);

  if (total <= 0 || items.some((item) => !item.nombre_producto || item.cantidad <= 0)) {
    return res.status(400).json({ message: "Venta a cuenta invalida" });
  }

  try {
    const cliente = await getClienteConMetricas(clienteId);
    if (!cliente || Number(cliente.activo) !== 1) {
      return res.status(404).json({ message: "Cliente activo no encontrado" });
    }
    if (Number(cliente.habilita_cuenta_corriente) !== 1) {
      return res.status(400).json({ message: "El cliente no tiene cuenta corriente habilitada" });
    }
    const deudaProyectada = Number(cliente.deuda_actual || 0) + total;
    if (Number(cliente.limite_fiado || 0) > 0 && deudaProyectada > Number(cliente.limite_fiado) && !autorizarExcedido) {
      return res.status(409).json({ message: "La venta excede el limite de credito del cliente" });
    }

    const { fecha, hora } = getNowParts();
    await runQuery("BEGIN TRANSACTION");
    const result = await runQuery(
      `INSERT INTO ventas
      (fecha, hora, usuario, total, tipo, estado, identificador_pendiente, metodo_pago, tipo_cobro,
       monto_efectivo, monto_debito, cliente_id, es_cuenta_corriente, saldo_pendiente, caja_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fecha,
        hora,
        "admin",
        total,
        "cuenta_corriente",
        "cuenta_corriente_pendiente",
        concepto,
        "cuenta_corriente",
        "cuenta_corriente",
        0,
        0,
        clienteId,
        1,
        total,
        null
      ]
    );
    await replaceVentaDetalle(result.lastID, items);
    await applyStockForNewItems(items);
    await runQuery("COMMIT");
    return res.json({ message: "Venta a cuenta registrada", venta_id: result.lastID });
  } catch (error) {
    try {
      await runQuery("ROLLBACK");
    } catch (rollbackError) {
      logError("Rollback venta a cuenta", rollbackError);
    }
    logError("Error al registrar venta a cuenta:", error);
    return res.status(500).json({ message: "Error al registrar venta a cuenta" });
  }
});

// Pagar cuenta corriente
app.post("/ventas/:id/pagar-cuenta-corriente", async (req, res) => {
  const ventaId = Number(req.params.id);
  const montoPagado = Number(req.body.monto_pagado) || 0;
  const tipoCobro = req.body.tipo_cobro;

  try {
    const snapshot = await refreshCuentaCorrienteSaldo(ventaId);
    const venta = snapshot?.venta;
    const cajaActiva = await getCajaAbiertaActual();

    if (!venta || Number(venta.es_cuenta_corriente) !== 1 || Number(snapshot.saldo_actual) <= 0) {
      return res.status(404).json({ message: "Venta de cuenta corriente no encontrada" });
    }

    if (!cajaActiva) {
      return res.status(400).json({ message: "No hay una caja abierta para registrar el cobro" });
    }

    if (montoPagado <= 0 || montoPagado > Number(snapshot.saldo_actual)) {
      return res.status(400).json({ message: "Monto de pago invalido" });
    }

    const cobro = resolveCobroData(
      montoPagado,
      tipoCobro,
      req.body.monto_efectivo,
      req.body.monto_debito
    );

    if (!cobro) {
      return res.status(400).json({ message: "Datos de cobro invalidos" });
    }

    const nuevoSaldo = Number((Number(snapshot.saldo_actual) - montoPagado).toFixed(2));
    const { fecha, hora } = getNowParts();

    await runQuery("BEGIN TRANSACTION");
    await runQuery(
      `INSERT INTO pagos_cuenta_corriente
      (venta_id, cliente_id, fecha, hora, monto_pagado, tipo_cobro, monto_efectivo, monto_debito, caja_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ventaId,
        venta.cliente_id,
        fecha,
        hora,
        montoPagado,
        cobro.tipo_cobro,
        cobro.monto_efectivo,
        cobro.monto_debito,
        cajaActiva.id
      ]
    );

    await runQuery(
      `UPDATE ventas
       SET saldo_pendiente = ?, estado = ?, metodo_pago = ?, tipo_cobro = ?, monto_efectivo = monto_efectivo + ?, monto_debito = monto_debito + ?
       WHERE id = ?`,
      [
        nuevoSaldo,
        nuevoSaldo === 0 ? "cobrada" : "cuenta_corriente_pendiente",
        cobro.tipo_cobro,
        cobro.tipo_cobro,
        cobro.monto_efectivo,
        cobro.monto_debito,
        ventaId
      ]
    );
    await runQuery("COMMIT");

    return res.json({
      message: nuevoSaldo === 0 ? "Cuenta corriente saldada" : "Pago registrado",
      saldo_pendiente: nuevoSaldo
    });
  } catch (error) {
    try {
      await runQuery("ROLLBACK");
    } catch (rollbackError) {
      logError("Rollback pago cuenta corriente", rollbackError);
    }

    logError("Error al pagar cuenta corriente:", error);
    return res.status(500).json({ message: "Error al pagar cuenta corriente" });
  }
});

// Consultar caja del dia
app.get("/caja/resumen", async (req, res) => {
  const fecha = String(req.query.fecha || getNowParts().fecha);

  try {
    const apertura = await getCajaAbiertaActual();
    const ultimaCaja = apertura || await getUltimaCajaRegistrada();

    if (ultimaCaja && ultimaCaja.estado === "cerrada") {
      return res.json({
        fecha: ultimaCaja.fecha || fecha,
        apertura: ultimaCaja,
        resumen: parseJsonOrFallback(ultimaCaja.resumen_snapshot, {
          total_efectivo: Number(ultimaCaja.efectivo_esperado || 0) - Number(ultimaCaja.monto_apertura || 0),
          total_debito: 0,
          total_debito_tarjeta: 0,
          total_transferencia: 0,
          total_cuenta_corriente: 0,
          total_pagos_efectivo: 0,
          total_pagos_debito: 0,
          total_pagos_general: 0,
          operaciones_mixtas: 0,
          total_general: Number(ultimaCaja.efectivo_esperado || 0) - Number(ultimaCaja.monto_apertura || 0),
          total_ventas: 0,
          costo_estimado_vendido: 0,
          ganancia_bruta_estimada: 0,
          total_ventas_manual_sin_costo: 0,
          resultado_estimado_dia: 0,
          saldo_inicial_mp: Number(ultimaCaja.saldo_inicial_mp || 0),
          saldo_mp_estimado: Number(ultimaCaja.saldo_inicial_mp || 0)
        }),
        ventas: parseJsonOrFallback(ultimaCaja.ventas_snapshot, [])
      });
    }

    const ventas = apertura ? await buildCajaSnapshot(apertura.id) : [];
    const resumen = buildCajaResumenConSaldoMp(ventas, apertura);

    return res.json({
      fecha,
      apertura,
      resumen,
      ventas
    });
  } catch (error) {
    logError("Error al obtener resumen de caja:", error);
    return res.status(500).json({ message: "Error al obtener resumen de caja" });
  }
});

// Consultar apertura de caja actual
app.get("/caja/apertura", async (req, res) => {
  const fecha = String(req.query.fecha || getNowParts().fecha);

  try {
    const apertura = await getCajaAbiertaActual();
    const ultimaCaja = apertura || await getUltimaCajaRegistrada();
    return res.json({ fecha, apertura: ultimaCaja });
  } catch (error) {
    logError("Error al obtener apertura de caja:", error);
    return res.status(500).json({ message: "Error al obtener apertura de caja" });
  }
});

// Registrar apertura de caja
app.post("/caja/apertura", async (req, res) => {
  if (!(await requirePermiso(req, res, "caja_abrir", "No tenes permisos para abrir caja"))) return;

  const montoApertura = Number(req.body.monto_apertura) || 0;
  const saldoInicialMp = Number(req.body.saldo_inicial_mp) || 0;
  const usuario = String(req.body.usuario || "admin").trim() || "admin";
  const { fecha, hora } = getNowParts();

  if (montoApertura < 0 || saldoInicialMp < 0) {
    return res.status(400).json({ message: "El monto de apertura es invalido" });
  }

  try {
    const aperturaExistente = await getCajaAbiertaActual();

    if (aperturaExistente && aperturaExistente.estado === "abierta") {
      return res.status(400).json({ message: "Ya hay una caja abierta" });
    }

    const result = await runQuery(
      `INSERT INTO caja_aperturas (fecha, hora, monto_apertura, saldo_inicial_mp, usuario, estado)
       VALUES (?, ?, ?, ?, ?, 'abierta')`,
      [fecha, hora, montoApertura, saldoInicialMp, usuario]
    );

    const apertura = await getQuery(
      "SELECT * FROM caja_aperturas WHERE id = ?",
      [result.lastID]
    );

    return res.json({
      message: "Caja abierta correctamente",
      apertura
    });
  } catch (error) {
    logError("Error al registrar apertura de caja:", error);
    return res.status(500).json({ message: "Error al registrar apertura de caja" });
  }
});

app.post("/caja/movimientos", async (req, res) => {
  if (!(await requirePermiso(req, res, "caja_movimientos", "No tenes permisos para movimientos de caja"))) return;

  const tipo = String(req.body.tipo || "").trim().toLowerCase();
  const concepto = String(req.body.concepto || "").trim();
  const monto = Number(req.body.monto) || 0;
  const usuario = String(req.body.usuario || "admin").trim() || "admin";
  const { fecha, hora } = getNowParts();

  if (!["ingreso", "egreso"].includes(tipo)) {
    return res.status(400).json({ message: "Tipo de movimiento invalido" });
  }

  if (monto <= 0) {
    return res.status(400).json({ message: "El monto debe ser mayor a cero" });
  }

  if (!concepto) {
    return res.status(400).json({ message: "El concepto es obligatorio" });
  }

  try {
    await ensureCajaMovimientosTable();
    const apertura = await getCajaAbiertaActual();

    if (!apertura || apertura.estado !== "abierta") {
      return res.status(400).json({ message: "No hay una caja abierta para registrar el movimiento" });
    }

    const result = await runQuery(
      `INSERT INTO caja_movimientos (caja_id, tipo, concepto, monto, usuario, fecha, hora)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [apertura.id, tipo, concepto, Number(monto.toFixed(2)), usuario, fecha, hora]
    );

    const movimiento = await getQuery(
      "SELECT * FROM caja_movimientos WHERE id = ?",
      [result.lastID]
    );

    return res.status(201).json({
      message: tipo === "ingreso" ? "Ingreso de dinero registrado" : "Retiro de dinero registrado",
      movimiento
    });
  } catch (error) {
    logError("Error al registrar movimiento de caja:", error);
    return res.status(500).json({ message: "Error al registrar movimiento de caja" });
  }
});

// Cerrar caja
app.post("/caja/cierre", async (req, res) => {
  if (!(await requirePermiso(req, res, "caja_cerrar", "No tenes permisos para cerrar caja"))) return;

  const { fecha, hora } = getNowParts();
  const conteo = req.body.conteo || {};
  const montoCajaApertura = Number(req.body.monto_caja_apertura) || 0;
  const montoCajaFondo = Number(req.body.monto_caja_fondo) || 0;

  try {
    await ensureCajaArqueosTable();
    const apertura = await getCajaAbiertaActual();

    if (!apertura || apertura.estado !== "abierta") {
      return res.status(400).json({ message: "No hay una caja abierta para cerrar" });
    }

    const arqueoRegistrado = await getQuery(
      `SELECT id
       FROM caja_arqueos
       WHERE caja_id = ? AND registrado_cierre = 1
       ORDER BY fecha DESC, hora DESC, id DESC
       LIMIT 1`,
      [apertura.id]
    );

    if (!arqueoRegistrado) {
      return res.status(400).json({ message: "Registra el arqueo antes de cerrar caja" });
    }

    const ventas = await buildCajaSnapshot(apertura.id);
    const pagosSnapshot = await getPagosCaja(apertura.id);
    const resumen = buildCajaResumenConSaldoMp(ventas, apertura);
    const efectivoEsperado = Number(
      (
        Number(apertura.monto_apertura || 0) +
        Number(resumen.total_efectivo || 0) -
        Number(resumen.total_pagos_efectivo || 0)
      ).toFixed(2)
    );
    const conteoResultado = buildConteoBilletes(conteo);
    const efectivoContado = conteoResultado.total;
    const diferencia = Number((efectivoContado - efectivoEsperado).toFixed(2));

    if (montoCajaApertura < 0 || montoCajaFondo < 0) {
      return res.status(400).json({ message: "Los montos de caja apertura y caja fondo deben ser validos" });
    }

    if (Number((montoCajaApertura + montoCajaFondo).toFixed(2)) > efectivoContado) {
      return res.status(400).json({ message: "La suma de caja apertura y caja fondo no puede superar el efectivo contado" });
    }

    await runQuery("BEGIN TRANSACTION");

    await runQuery(
      `UPDATE caja_aperturas
       SET estado = 'cerrada',
           hora_cierre = ?,
           efectivo_esperado = ?,
           efectivo_contado = ?,
           diferencia = ?,
           monto_caja_apertura = ?,
           monto_caja_fondo = ?,
           conteo_detalle = ?,
           resumen_snapshot = ?,
           ventas_snapshot = ?,
           pagos_snapshot = ?
       WHERE id = ?`,
      [
        hora,
        efectivoEsperado,
        efectivoContado,
        diferencia,
        montoCajaApertura,
        montoCajaFondo,
        JSON.stringify(conteoResultado.detalle),
        JSON.stringify({
          total_efectivo: resumen.total_efectivo,
          total_debito: resumen.total_debito,
          total_debito_tarjeta: resumen.total_debito_tarjeta,
          total_transferencia: resumen.total_transferencia,
          total_cuenta_corriente: resumen.total_cuenta_corriente,
          total_ventas: resumen.total_ventas,
          costo_estimado_vendido: resumen.costo_estimado_vendido,
          ganancia_bruta_estimada: resumen.ganancia_bruta_estimada,
          total_ventas_manual_sin_costo: resumen.total_ventas_manual_sin_costo,
          total_pagos_efectivo: resumen.total_pagos_efectivo,
          total_pagos_debito: resumen.total_pagos_debito,
          total_pagos_general: resumen.total_pagos_general,
          resultado_estimado_dia: resumen.resultado_estimado_dia,
          operaciones_mixtas: resumen.operaciones_mixtas,
          total_general: resumen.total_general,
          saldo_inicial_mp: resumen.saldo_inicial_mp,
          saldo_mp_estimado: resumen.saldo_mp_estimado
        }),
        JSON.stringify(ventas),
        JSON.stringify(pagosSnapshot),
        apertura.id
      ]
    );

    await runQuery("COMMIT");

    const cajaCerrada = await getQuery(
      "SELECT * FROM caja_aperturas WHERE id = ?",
      [apertura.id]
    );

    return res.json({
      message: "Caja cerrada correctamente",
      caja: cajaCerrada
    });
  } catch (error) {
    try { await runQuery("ROLLBACK"); } catch {}
    logError("Error al cerrar caja:", error);
    return res.status(500).json({ message: "Error al cerrar caja" });
  }
});

// Historial de arqueos de caja
app.get("/caja/arqueos", async (req, res) => {
  try {
    await ensureCajaArqueosTable();
    const caja = await getCajaParaArqueos();

    if (!caja) {
      return res.json([]);
    }

    const arqueos = await allQuery(
      `SELECT *
       FROM caja_arqueos
       WHERE caja_id = ?
       ORDER BY fecha DESC, hora DESC, id DESC`,
      [caja.id]
    );

    return res.json(arqueos.map(mapCajaArqueo));
  } catch (error) {
    logError("Error al obtener arqueos:", error);
    return res.status(500).json({ message: "Error al obtener arqueos" });
  }
});

// Detalle de arqueo
app.get("/caja/arqueos/:id", async (req, res) => {
  const arqueoId = Number(req.params.id);

  try {
    await ensureCajaArqueosTable();
    const arqueo = await getQuery("SELECT * FROM caja_arqueos WHERE id = ?", [arqueoId]);

    if (!arqueo) {
      return res.status(404).json({ message: "Arqueo no encontrado" });
    }

    return res.json(mapCajaArqueo(arqueo));
  } catch (error) {
    logError("Error al obtener detalle del arqueo:", error);
    return res.status(500).json({ message: "Error al obtener detalle del arqueo" });
  }
});

// Registrar arqueo de caja
app.post("/caja/arqueos", async (req, res) => {
  if (!(await requirePermiso(req, res, "caja_registrar_arqueo", "No tenes permisos para registrar arqueos"))) return;

  const { fecha, hora } = getNowParts();
  const registradoCierre = Number(req.body.registrado_cierre) === 1 ? 1 : 0;

  try {
    await ensureCajaArqueosTable();
    const apertura = await getCajaAbiertaActual();

    if (!apertura || apertura.estado !== "abierta") {
      return res.status(400).json({ message: "No hay una caja abierta para registrar el arqueo" });
    }

    const arqueoData = await buildCajaArqueoData(apertura, req.body);

    const result = await runQuery(
      `INSERT INTO caja_arqueos
       (caja_id, fecha, hora, usuario, efectivo_esperado, efectivo_contado, diferencia_efectivo,
        digital_esperado, digital_real, diferencia_digital, resultado_final, estado, observaciones,
        conteo_detalle, cuentas_detalle, resumen_snapshot, registrado_cierre)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        apertura.id,
        fecha,
        hora,
        arqueoData.usuario,
        arqueoData.efectivoEsperado,
        arqueoData.efectivoContado,
        arqueoData.diferenciaEfectivo,
        arqueoData.digitalEsperado,
        arqueoData.digitalReal,
        arqueoData.diferenciaDigital,
        arqueoData.resultadoFinal,
        arqueoData.estado,
        arqueoData.observaciones,
        JSON.stringify(arqueoData.conteoDetalle),
        JSON.stringify(arqueoData.cuentasDetalle),
        JSON.stringify(arqueoData.resumen),
        registradoCierre
      ]
    );

    const arqueo = await getQuery("SELECT * FROM caja_arqueos WHERE id = ?", [result.lastID]);
    return res.status(201).json({
      message: registradoCierre ? "Arqueo registrado" : "Arqueo guardado",
      arqueo: mapCajaArqueo(arqueo)
    });
  } catch (error) {
    logError("Error al registrar arqueo:", error);
    return res.status(500).json({ message: "Error al registrar arqueo" });
  }
});

// Editar arqueo de caja
app.put("/caja/arqueos/:id", async (req, res) => {
  if (!(await requirePermiso(req, res, "caja_registrar_arqueo", "No tenes permisos para registrar arqueos"))) return;

  const arqueoId = Number(req.params.id);
  const registradoCierre = Number(req.body.registrado_cierre) === 1 ? 1 : 0;

  try {
    await ensureCajaArqueosTable();
    const arqueoActual = await getQuery("SELECT * FROM caja_arqueos WHERE id = ?", [arqueoId]);

    if (!arqueoActual) {
      return res.status(404).json({ message: "Arqueo no encontrado" });
    }

    const apertura = await getCajaAbiertaActual();

    if (!apertura || apertura.estado !== "abierta" || Number(apertura.id) !== Number(arqueoActual.caja_id)) {
      return res.status(400).json({ message: "Solo se puede editar un arqueo de la caja abierta" });
    }

    const arqueoData = await buildCajaArqueoData(apertura, req.body);

    await runQuery(
      `UPDATE caja_arqueos
       SET usuario = ?,
           efectivo_esperado = ?,
           efectivo_contado = ?,
           diferencia_efectivo = ?,
           digital_esperado = ?,
           digital_real = ?,
           diferencia_digital = ?,
           resultado_final = ?,
           estado = ?,
           observaciones = ?,
           conteo_detalle = ?,
           cuentas_detalle = ?,
           resumen_snapshot = ?,
           registrado_cierre = ?
       WHERE id = ?`,
      [
        arqueoData.usuario,
        arqueoData.efectivoEsperado,
        arqueoData.efectivoContado,
        arqueoData.diferenciaEfectivo,
        arqueoData.digitalEsperado,
        arqueoData.digitalReal,
        arqueoData.diferenciaDigital,
        arqueoData.resultadoFinal,
        arqueoData.estado,
        arqueoData.observaciones,
        JSON.stringify(arqueoData.conteoDetalle),
        JSON.stringify(arqueoData.cuentasDetalle),
        JSON.stringify(arqueoData.resumen),
        registradoCierre,
        arqueoId
      ]
    );

    const arqueo = await getQuery("SELECT * FROM caja_arqueos WHERE id = ?", [arqueoId]);
    return res.json({
      message: registradoCierre ? "Arqueo registrado" : "Arqueo guardado",
      arqueo: mapCajaArqueo(arqueo)
    });
  } catch (error) {
    logError("Error al editar arqueo:", error);
    return res.status(500).json({ message: "Error al editar arqueo" });
  }
});

// Historial de cierres de caja
app.get("/caja/cierres", async (req, res) => {
  try {
    const cierres = await allQuery(
      `SELECT id, fecha, hora, hora_cierre, monto_apertura, efectivo_esperado, efectivo_contado,
              diferencia, monto_caja_apertura, monto_caja_fondo, usuario, estado, resumen_snapshot
       FROM caja_aperturas
       WHERE estado = 'cerrada'
       ORDER BY fecha DESC, hora_cierre DESC, id DESC`
    );

    return res.json(cierres.map((cierre) => ({
      ...cierre,
      resumen_snapshot: parseJsonOrFallback(cierre.resumen_snapshot, null)
    })));
  } catch (error) {
    logError("Error al obtener historial de cierres:", error);
    return res.status(500).json({ message: "Error al obtener historial de cierres" });
  }
});

// Detalle de un cierre de caja
app.get("/caja/cierres/:id", async (req, res) => {
  const cierreId = Number(req.params.id);

  try {
    const cierre = await getQuery(
      "SELECT * FROM caja_aperturas WHERE id = ? AND estado = 'cerrada'",
      [cierreId]
    );

    if (!cierre) {
      return res.status(404).json({ message: "Cierre no encontrado" });
    }

    return res.json({
      ...cierre,
      conteo_detalle: cierre.conteo_detalle ? JSON.parse(cierre.conteo_detalle) : {},
      resumen_snapshot: cierre.resumen_snapshot ? JSON.parse(cierre.resumen_snapshot) : null,
      ventas_snapshot: cierre.ventas_snapshot ? JSON.parse(cierre.ventas_snapshot) : [],
      pagos_snapshot: cierre.pagos_snapshot ? JSON.parse(cierre.pagos_snapshot) : []
    });
  } catch (error) {
    logError("Error al obtener detalle del cierre:", error);
    return res.status(500).json({ message: "Error al obtener detalle del cierre" });
  }
});

// Listar tickets pendientes
app.get("/ventas/pendientes", async (req, res) => {
  try {
    const pendientes = await allQuery(
      `SELECT *
       FROM ventas
       WHERE tipo = 'pendiente' AND estado = 'pendiente'
       ORDER BY id DESC`
    );

    return res.json(pendientes);
  } catch (error) {
    logError("Error al listar pendientes:", error);
    return res.status(500).json({ message: "Error al obtener tickets pendientes" });
  }
});

function parseClientePayload(body) {
  return {
    nombre: String(body.nombre || "").trim(),
    dni_cuit: String(body.dni_cuit || body.cuit || "").trim(),
    tipo_persona: String(body.tipo_persona || "fisica").trim().toLowerCase(),
    telefono: String(body.telefono || "").trim(),
    email: String(body.email || "").trim(),
    contacto: String(body.contacto || "").trim(),
    direccion: String(body.direccion || "").trim(),
    localidad: String(body.localidad || "").trim(),
    codigo_postal: String(body.codigo_postal || "").trim(),
    alias: String(body.alias || "").trim(),
    observaciones: String(body.observaciones || "").trim(),
    notas: String(body.notas || "").trim(),
    foto_url: String(body.foto_url || "").trim(),
    limite_fiado: Math.max(0, Number(body.limite_fiado) || 0),
    dias_vencimiento: Math.max(0, Number(body.dias_vencimiento) || 30),
    dia_vencimiento_fijo: body.dia_vencimiento_fijo ? Number(body.dia_vencimiento_fijo) : null,
    moneda: String(body.moneda || "ARS").trim().toUpperCase(),
    habilita_cuenta_corriente: body.habilita_cuenta_corriente === false || Number(body.habilita_cuenta_corriente) === 0 ? 0 : 1,
    activo: body.activo === false || Number(body.activo) === 0 ? 0 : 1
  };
}

async function buildClienteCuentaResumen(clienteId) {
  const cuenta = await getQuery(
    `SELECT COALESCE(SUM(saldo_pendiente), 0) AS deuda_actual,
            MIN(CASE WHEN saldo_pendiente > 0 THEN fecha ELSE NULL END) AS primera_deuda,
            MAX(CASE WHEN es_cuenta_corriente = 1 THEN fecha ELSE NULL END) AS ultima_venta
     FROM ventas
     WHERE cliente_id = ? AND es_cuenta_corriente = 1`,
    [clienteId]
  );
  const pago = await getQuery(
    `SELECT COALESCE(SUM(CASE WHEN fecha = date('now', 'localtime') THEN monto_pagado ELSE 0 END), 0) AS cobrado_hoy,
            MAX(fecha) AS ultimo_pago
     FROM pagos_cuenta_corriente
     WHERE cliente_id = ?`,
    [clienteId]
  );
  return {
    deuda_actual: Number(cuenta?.deuda_actual || 0),
    primera_deuda: cuenta?.primera_deuda || null,
    ultima_venta: cuenta?.ultima_venta || null,
    cobrado_hoy: Number(pago?.cobrado_hoy || 0),
    ultimo_pago: pago?.ultimo_pago || null
  };
}

async function getClienteConMetricas(clienteId) {
  const cliente = await getQuery("SELECT * FROM clientes WHERE id = ?", [clienteId]);
  if (!cliente) return null;
  return { ...cliente, ...(await buildClienteCuentaResumen(clienteId)) };
}

// Listar clientes
app.get("/clientes", async (req, res) => {
  try {
    const includeInactive = String(req.query.include_inactive || "") === "1";
    const limite = Math.min(Number(req.query.limit) || 500, 2000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const clientes = await allQuery(
      `${includeInactive ? "SELECT * FROM clientes" : "SELECT * FROM clientes WHERE activo = 1"} ORDER BY nombre ASC LIMIT ? OFFSET ?`,
      [limite, offset]
    );

    if (!clientes.length) return res.json([]);

    const [ventasMetricas, pagosMetricas] = await Promise.all([
      allQuery(
        `SELECT cliente_id,
                COALESCE(SUM(saldo_pendiente), 0) AS deuda_actual,
                MIN(CASE WHEN saldo_pendiente > 0 THEN fecha ELSE NULL END) AS primera_deuda,
                MAX(CASE WHEN es_cuenta_corriente = 1 THEN fecha ELSE NULL END) AS ultima_venta
         FROM ventas
         WHERE es_cuenta_corriente = 1 AND cliente_id IS NOT NULL
         GROUP BY cliente_id`
      ),
      allQuery(
        `SELECT cliente_id,
                COALESCE(SUM(CASE WHEN fecha = date('now','localtime') THEN monto_pagado ELSE 0 END), 0) AS cobrado_hoy,
                MAX(fecha) AS ultimo_pago
         FROM pagos_cuenta_corriente
         WHERE cliente_id IS NOT NULL
         GROUP BY cliente_id`
      )
    ]);

    const ventasMap = new Map(ventasMetricas.map((v) => [v.cliente_id, v]));
    const pagosMap = new Map(pagosMetricas.map((p) => [p.cliente_id, p]));

    const conMetricas = clientes.map((cliente) => {
      const v = ventasMap.get(cliente.id) || {};
      const p = pagosMap.get(cliente.id) || {};
      return {
        ...cliente,
        deuda_actual: Number(v.deuda_actual || 0),
        primera_deuda: v.primera_deuda || null,
        ultima_venta: v.ultima_venta || null,
        cobrado_hoy: Number(p.cobrado_hoy || 0),
        ultimo_pago: p.ultimo_pago || null
      };
    });

    return res.json(conMetricas);
  } catch (error) {
    logError("Error al listar clientes:", error);
    return res.status(500).json({ message: "Error al obtener clientes" });
  }
});

app.post("/clientes/imagen", async (req, res) => {
  try {
    const { nombre, data_url } = req.body || {};
    const match = String(data_url || "").match(/^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/i);

    if (!match) {
      return res.status(400).json({ message: "La foto debe enviarse como imagen valida" });
    }

    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length || buffer.length > 5 * 1024 * 1024) {
      return res.status(400).json({ message: "La foto no puede superar 5 MB" });
    }

    const extension = match[1].toLowerCase().replace("jpeg", "jpg");
    const baseName = String(nombre || "cliente").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "cliente";
    const fileName = `${Date.now()}-${baseName.slice(0, 32)}-${crypto.randomBytes(4).toString("hex")}.${extension}`;
    const uploadDir = path.join(__dirname, "../uploads/clientes");
    const filePath = path.join(uploadDir, fileName);

    await fs.promises.mkdir(uploadDir, { recursive: true });
    await fs.promises.writeFile(filePath, buffer);

    return res.status(201).json({ url: `/uploads/clientes/${fileName}` });
  } catch (error) {
    logError("Error al guardar foto de cliente:", error);
    return res.status(500).json({ message: "Error al guardar foto" });
  }
});

app.post("/configuracion/logo", async (req, res) => {
  try {
    const { nombre, data_url } = req.body || {};
    const match = String(data_url || "").match(/^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/i);

    if (!match) {
      return res.status(400).json({ message: "El logo debe enviarse como imagen valida" });
    }

    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length || buffer.length > 5 * 1024 * 1024) {
      return res.status(400).json({ message: "El logo no puede superar 5 MB" });
    }

    const extension = match[1].toLowerCase().replace("jpeg", "jpg");
    const baseName = String(nombre || "logo").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "logo";
    const fileName = `${Date.now()}-${baseName.slice(0, 32)}-${crypto.randomBytes(4).toString("hex")}.${extension}`;
    const uploadDir = path.join(__dirname, "../uploads/configuracion");
    const filePath = path.join(uploadDir, fileName);

    await fs.promises.mkdir(uploadDir, { recursive: true });
    await fs.promises.writeFile(filePath, buffer);

    return res.status(201).json({ url: `/uploads/configuracion/${fileName}` });
  } catch (error) {
    logError("Error al guardar logo:", error);
    return res.status(500).json({ message: "Error al guardar logo" });
  }
});

// Crear cliente
app.post("/clientes", async (req, res) => {
  const clienteData = parseClientePayload(req.body);

  if (!clienteData.nombre) {
    return res.status(400).json({ message: "El nombre del cliente es obligatorio" });
  }

  if (!clienteData.dni_cuit) {
    return res.status(400).json({ message: "El CUIT / DNI del cliente es obligatorio" });
  }

  if (!["fisica", "juridica"].includes(clienteData.tipo_persona)) {
    return res.status(400).json({ message: "Tipo de persona invalido" });
  }

  try {
    const existente = await getQuery("SELECT id FROM clientes WHERE dni_cuit = ?", [clienteData.dni_cuit]);
    if (existente) {
      return res.status(409).json({ message: "Ya existe un cliente con ese CUIT / DNI" });
    }

    const result = await runQuery(
      `INSERT INTO clientes
       (nombre, dni_cuit, tipo_persona, telefono, email, contacto, direccion, localidad, codigo_postal,
        alias, observaciones, notas, foto_url, limite_fiado, dias_vencimiento, dia_vencimiento_fijo, moneda,
        habilita_cuenta_corriente, activo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        clienteData.nombre,
        clienteData.dni_cuit,
        clienteData.tipo_persona,
        clienteData.telefono,
        clienteData.email,
        clienteData.contacto,
        clienteData.direccion,
        clienteData.localidad,
        clienteData.codigo_postal,
        clienteData.alias,
        clienteData.observaciones,
        clienteData.notas,
        clienteData.foto_url,
        clienteData.limite_fiado,
        clienteData.dias_vencimiento,
        clienteData.dia_vencimiento_fijo,
        clienteData.moneda,
        clienteData.habilita_cuenta_corriente,
        clienteData.activo
      ]
    );

    return res.json({
      message: "Cliente creado correctamente",
      cliente: await getClienteConMetricas(result.lastID)
    });
  } catch (error) {
    logError("Error al crear cliente:", error);
    return res.status(500).json({ message: "Error al crear cliente" });
  }
});

app.put("/clientes/:id", async (req, res) => {
  const clienteId = Number(req.params.id);
  const clienteData = parseClientePayload(req.body);

  if (!clienteData.nombre || !clienteData.dni_cuit) {
    return res.status(400).json({ message: "Nombre y CUIT / DNI son obligatorios" });
  }

  try {
    const existente = await getQuery("SELECT id FROM clientes WHERE id = ?", [clienteId]);
    if (!existente) {
      return res.status(404).json({ message: "Cliente no encontrado" });
    }
    const dniExistente = await getQuery("SELECT id FROM clientes WHERE dni_cuit = ? AND id != ?", [clienteData.dni_cuit, clienteId]);
    if (dniExistente) {
      return res.status(409).json({ message: "Ya existe otro cliente con ese CUIT / DNI" });
    }
    await runQuery(
      `UPDATE clientes
       SET nombre = ?, dni_cuit = ?, tipo_persona = ?, telefono = ?, email = ?, contacto = ?,
           direccion = ?, localidad = ?, codigo_postal = ?, alias = ?, observaciones = ?, notas = ?, foto_url = ?,
           limite_fiado = ?, dias_vencimiento = ?, dia_vencimiento_fijo = ?, moneda = ?,
           habilita_cuenta_corriente = ?, activo = ?
       WHERE id = ?`,
      [
        clienteData.nombre,
        clienteData.dni_cuit,
        clienteData.tipo_persona,
        clienteData.telefono,
        clienteData.email,
        clienteData.contacto,
        clienteData.direccion,
        clienteData.localidad,
        clienteData.codigo_postal,
        clienteData.alias,
        clienteData.observaciones,
        clienteData.notas,
        clienteData.foto_url,
        clienteData.limite_fiado,
        clienteData.dias_vencimiento,
        clienteData.dia_vencimiento_fijo,
        clienteData.moneda,
        clienteData.habilita_cuenta_corriente,
        clienteData.activo,
        clienteId
      ]
    );
    return res.json({ message: "Cliente actualizado correctamente", cliente: await getClienteConMetricas(clienteId) });
  } catch (error) {
    logError("Error al actualizar cliente:", error);
    return res.status(500).json({ message: "Error al actualizar cliente" });
  }
});

app.patch("/clientes/:id/estado", async (req, res) => {
  const clienteId = Number(req.params.id);
  const activo = req.body.activo ? 1 : 0;

  try {
    const cliente = await getQuery("SELECT id FROM clientes WHERE id = ?", [clienteId]);
    if (!cliente) return res.status(404).json({ message: "Cliente no encontrado" });
    await runQuery("UPDATE clientes SET activo = ? WHERE id = ?", [activo, clienteId]);
    return res.json({ message: activo ? "Cliente activado" : "Cliente desactivado", cliente: await getClienteConMetricas(clienteId) });
  } catch (error) {
    logError("Error al cambiar estado del cliente:", error);
    return res.status(500).json({ message: "Error al cambiar estado del cliente" });
  }
});

app.delete("/clientes/:id", async (req, res) => {
  const clienteId = Number(req.params.id);

  try {
    const usos = await getQuery(
      `SELECT
         (SELECT COUNT(*) FROM ventas WHERE cliente_id = ?) AS ventas,
         (SELECT COUNT(*) FROM pagos_cuenta_corriente WHERE cliente_id = ?) AS pagos`,
      [clienteId, clienteId]
    );
    if (Number(usos?.ventas || 0) + Number(usos?.pagos || 0) > 0) {
      return res.status(409).json({ message: "No se puede eliminar un cliente con historial. Se puede desactivar." });
    }
    await runQuery("DELETE FROM clientes WHERE id = ?", [clienteId]);
    return res.json({ message: "Cliente eliminado correctamente" });
  } catch (error) {
    logError("Error al eliminar cliente:", error);
    return res.status(500).json({ message: "Error al eliminar cliente" });
  }
});

// Historial de compras por cliente
app.get("/clientes/:id/historial", async (req, res) => {
  const clienteId = Number(req.params.id);

  try {
    const cliente = await getQuery(
      "SELECT * FROM clientes WHERE id = ?",
      [clienteId]
    );

    if (!cliente) {
      return res.status(404).json({ message: "Cliente no encontrado" });
    }

    const ventas = await allQuery(
      `SELECT v.id, v.fecha, v.total
              , v.tipo, v.estado
       FROM ventas v
       WHERE v.cliente_id = ?
       ORDER BY v.id DESC`,
      [clienteId]
    );

    const historial = [];

    for (const venta of ventas) {
      const items = await allQuery(
        `SELECT nombre_producto, cantidad
         FROM detalle_ventas
         WHERE venta_id = ?
         ORDER BY id ASC`,
        [venta.id]
      );

      historial.push({
        id: venta.id,
        fecha: venta.fecha,
        total: venta.total,
        tipo: venta.tipo,
        estado: venta.estado,
        items
      });
    }

    return res.json({
      cliente,
      historial
    });
  } catch (error) {
    logError("Error al obtener historial del cliente:", error);
    return res.status(500).json({ message: "Error al obtener historial del cliente" });
  }
});

// Ver venta con detalle
app.get("/ventas/:id/detalle", async (req, res) => {
  try {
    const data = await getVentaConDetalle(req.params.id);

    if (!data) {
      return res.status(404).json({ message: "Venta no encontrada" });
    }

    return res.json(data);
  } catch (error) {
    logError("Error al obtener detalle de venta:", error);
    return res.status(500).json({ message: "Error al obtener detalle de venta" });
  }
});

// Actualizar ticket pendiente
app.put("/ventas/:id/pendiente", async (req, res) => {
  const { items, identificador_pendiente } = req.body;
  const ventaId = req.params.id;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "El ticket no puede estar vacio" });
  }

  const identificador = String(identificador_pendiente || "").trim();

  if (!identificador) {
    return res.status(400).json({ message: "El ticket pendiente necesita un identificador" });
  }

  const itemsNormalizados = normalizeItems(items);
  const hayItemInvalido = itemsNormalizados.some((item) => {
    return !item.nombre_producto || item.cantidad <= 0;
  });

  if (hayItemInvalido) {
    return res.status(400).json({ message: "Hay productos invalidos en el ticket" });
  }

  try {
    const venta = await getQuery("SELECT * FROM ventas WHERE id = ?", [ventaId]);

    if (!venta || venta.tipo !== "pendiente" || venta.estado !== "pendiente") {
      return res.status(404).json({ message: "Ticket pendiente no encontrado" });
    }

    const oldItems = await getVentaDetalleRows(ventaId);
    const total = calculateTotal(itemsNormalizados);

    await runQuery("BEGIN TRANSACTION");
    await applyStockDiff(oldItems, itemsNormalizados);
    await replaceVentaDetalle(ventaId, itemsNormalizados);
    await runQuery(
      `UPDATE ventas
       SET total = ?, identificador_pendiente = ?
       WHERE id = ?`,
      [total, identificador, ventaId]
    );
    await runQuery("COMMIT");

    return res.json({ message: "Ticket pendiente actualizado", venta_id: Number(ventaId), total });
  } catch (error) {
    try {
      await runQuery("ROLLBACK");
    } catch (rollbackError) {
      logError("Rollback pendiente", rollbackError);
    }

    logError("Error al actualizar ticket pendiente:", error);
    return res.status(500).json({ message: "Error al actualizar ticket pendiente" });
  }
});

// Cobrar ticket pendiente
app.post("/ventas/:id/cobrar", async (req, res) => {
  const ventaId = Number(req.params.id);
  const tipoCobro = req.body.tipo_cobro;

  try {
    const venta = await getQuery("SELECT * FROM ventas WHERE id = ?", [ventaId]);
    const cajaActiva = await getCajaAbiertaActual();

    if (!venta || venta.tipo !== "pendiente" || venta.estado !== "pendiente") {
      return res.status(404).json({ message: "Ticket pendiente no encontrado" });
    }

    if (!cajaActiva) {
      return res.status(400).json({ message: "No hay una caja abierta para cobrar el ticket" });
    }

    const cobroReal = resolveCobroData(
      Number(venta.total) || 0,
      tipoCobro,
      req.body.monto_efectivo,
      req.body.monto_debito
    );

    if (!cobroReal) {
      return res.status(400).json({ message: "Datos de cobro invalidos" });
    }

    await runQuery("BEGIN TRANSACTION");

    await runQuery(
      `UPDATE ventas
       SET estado = 'cobrada', metodo_pago = ?, tipo_cobro = ?, monto_efectivo = ?, monto_debito = ?, caja_id = ?
       WHERE id = ?`,
      [
        cobroReal.tipo_cobro,
        cobroReal.tipo_cobro,
        cobroReal.monto_efectivo,
        cobroReal.monto_debito,
        cajaActiva.id,
        ventaId
      ]
    );

    await runQuery("COMMIT");

    return res.json({ message: "Ticket pendiente cobrado" });
  } catch (error) {
    try { await runQuery("ROLLBACK"); } catch {}
    logError("Error al cobrar ticket pendiente", error, "id: " + ventaId);
    return res.status(500).json({ message: "Error al cobrar ticket pendiente" });
  }
});

// Anular ticket pendiente
app.post("/ventas/:id/anular", async (req, res) => {
  const ventaId = req.params.id;
  const authorizationCode = String(req.body.authorization_code || "").trim();

  if (!(await tienePermisoAccion(req, "ventas_eliminar_pendiente"))) {
    return res.status(403).json({ message: "No tenes permisos para eliminar tickets pendientes" });
  }

  const claveActual = await getClaveAutorizacion();
  if (authorizationCode !== claveActual) {
    return res.status(403).json({ message: "Codigo de autorizacion incorrecto" });
  }

  try {
    const venta = await getQuery("SELECT * FROM ventas WHERE id = ?", [ventaId]);

    if (!venta || venta.tipo !== "pendiente" || venta.estado !== "pendiente") {
      return res.status(404).json({ message: "Ticket pendiente no encontrado" });
    }

    const items = await getVentaDetalleRows(ventaId);

    await runQuery("BEGIN TRANSACTION");

    for (const item of items) {
      if (!item.producto_id) {
        continue;
      }

      await applyStockChange(item.producto_id, -Number(item.cantidad || 0));
    }

    await runQuery(
      `UPDATE ventas
       SET estado = 'anulado', metodo_pago = NULL
       WHERE id = ?`,
      [ventaId]
    );

    await runQuery("COMMIT");

    return res.json({ message: "Ticket pendiente anulado" });
  } catch (error) {
    try {
      await runQuery("ROLLBACK");
    } catch (rollbackError) {
      logError("Rollback anulacion", rollbackError);
    }

    logError("Error al anular ticket pendiente:", error);
    return res.status(500).json({ message: "Error al anular ticket pendiente" });
  }
});

app.patch("/ventas/:id/cobro", async (req, res) => {
  const ventaId = Number(req.params.id);

  if (!(await tienePermisoAccion(req, "ventas_editar_ticket"))) {
    return res.status(403).json({ message: "No tenes permisos para editar tickets" });
  }

  try {
    const venta = await getQuery("SELECT * FROM ventas WHERE id = ?", [ventaId]);

    if (!venta || venta.estado !== "cobrada") {
      return res.status(404).json({ message: "Ticket cobrado no encontrado" });
    }

    const cobro = resolveCobroData(
      Number(venta.total) || 0,
      req.body.tipo_cobro,
      req.body.monto_efectivo,
      req.body.monto_debito
    );

    if (!cobro) {
      return res.status(400).json({ message: "Datos de cobro invalidos" });
    }

    await runQuery(
      `UPDATE ventas
       SET metodo_pago = ?, tipo_cobro = ?, monto_efectivo = ?, monto_debito = ?
       WHERE id = ?`,
      [cobro.tipo_cobro, cobro.tipo_cobro, cobro.monto_efectivo, cobro.monto_debito, ventaId]
    );

    return res.json({ message: `Metodo de pago actualizado en ticket ${ventaId}` });
  } catch (error) {
    logError("Error al actualizar cobro:", error);
    return res.status(500).json({ message: "Error al actualizar cobro" });
  }
});

app.post("/ventas/:id/anular-cobrada", async (req, res) => {
  const ventaId = Number(req.params.id);
  const authorizationCode = String(req.body.authorization_code || "").trim();

  if (!(await tienePermisoAccion(req, "ventas_anular_ticket"))) {
    return res.status(403).json({ message: "No tenes permisos para anular tickets" });
  }

  const claveActual = await getClaveAutorizacion();
  if (authorizationCode !== claveActual) {
    return res.status(403).json({ message: "Codigo de autorizacion incorrecto" });
  }

  try {
    const venta = await getQuery("SELECT * FROM ventas WHERE id = ?", [ventaId]);

    if (!venta || venta.estado !== "cobrada") {
      return res.status(404).json({ message: "Ticket cobrado no encontrado" });
    }

    const items = await getVentaDetalleRows(ventaId);

    await runQuery("BEGIN TRANSACTION");

    for (const item of items) {
      if (item.producto_id) {
        await applyStockChange(item.producto_id, -Number(item.cantidad || 0));
      }
    }

    await runQuery(
      `UPDATE ventas
       SET estado = 'anulado', metodo_pago = NULL, tipo_cobro = NULL, monto_efectivo = 0, monto_debito = 0
       WHERE id = ?`,
      [ventaId]
    );

    const cajaActiva = await getCajaAbiertaActual();
    if (cajaActiva) {
      const { fecha, hora } = getNowParts();
      const montoEfectivo = Number(venta.monto_efectivo || 0);
      const montoDebito = Number(venta.monto_debito || 0);
      if (montoEfectivo > 0) {
        await runQuery(
          `INSERT INTO caja_movimientos (caja_id, tipo, concepto, monto, usuario, fecha, hora)
           VALUES (?, 'egreso', ?, ?, 'admin', ?, ?)`,
          [cajaActiva.id, `Anulación venta #${ventaId} (efectivo)`, montoEfectivo, fecha, hora]
        );
      }
      if (montoDebito > 0) {
        await runQuery(
          `INSERT INTO caja_movimientos (caja_id, tipo, concepto, monto, usuario, fecha, hora)
           VALUES (?, 'egreso', ?, ?, 'admin', ?, ?)`,
          [cajaActiva.id, `Anulación venta #${ventaId} (digital)`, montoDebito, fecha, hora]
        );
      }
    }

    await runQuery("COMMIT");

    return res.json({ message: `Ticket anulado ${ventaId}` });
  } catch (error) {
    try {
      await runQuery("ROLLBACK");
    } catch (rollbackError) {
      logError("Rollback anulacion cobrada", rollbackError);
    }

    logError("Error al anular ticket cobrado:", error);
    return res.status(500).json({ message: "Error al anular ticket cobrado" });
  }
});

// Consultar ventas
app.get("/ventas", async (req, res) => {
  try {
    const limite = Math.min(Number(req.query.limit) || 500, 2000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const ventas = await allQuery(
      "SELECT * FROM ventas ORDER BY id DESC LIMIT ? OFFSET ?",
      [limite, offset]
    );
    return res.json(ventas);
  } catch (error) {
    logError("Error al listar ventas:", error);
    return res.status(500).json({ message: "Error al obtener ventas" });
  }
});

// Consultar detalle de ventas
app.get("/detalle-ventas", async (req, res) => {
  try {
    const detalleVentas = await allQuery(
      "SELECT * FROM detalle_ventas ORDER BY id DESC"
    );
    return res.json(detalleVentas);
  } catch (error) {
    logError("Error al listar detalle de ventas:", error);
    return res.status(500).json({ message: "Error al obtener detalle de ventas" });
  }
});

const REPORTES_MODULOS = new Set([
  "generales",
  "ventas",
  "caja",
  "stock",
  "cuentas-corrientes",
  "proveedores-pagos"
]);

function normalizarFormatoReporte(formato) {
  return formato === "pdf" ? "pdf" : "xlsx";
}

function nombreArchivoReporte(modulo, desde, hasta, formato) {
  return `${modulo}_${desde}_${hasta}.${normalizarFormatoReporte(formato)}`;
}

// Contrato base para reportes futuros
app.get("/reportes/:modulo", async (req, res) => {
  const { modulo } = req.params;

  if (!REPORTES_MODULOS.has(modulo)) {
    return res.status(404).json({ message: "Modulo de reporte no disponible" });
  }

  const { desde = null, hasta = null, comparacion = "periodo_anterior" } = req.query;

  return res.json({
    modulo,
    desde,
    hasta,
    comparacion,
    estado: "pendiente_backend",
    message: "Endpoint preparado para agregaciones y metricas futuras",
    data: null
  });
});

// Contrato base para exportaciones futuras
app.post("/reportes/exportar", async (req, res) => {
  const { modulo, desde, hasta, formato = "excel", contenido = [] } = req.body || {};
  const formatoArchivo = normalizarFormatoReporte(formato);

  if (!REPORTES_MODULOS.has(modulo)) {
    return res.status(400).json({ message: "Modulo de reporte invalido" });
  }

  if (!desde || !hasta) {
    return res.status(400).json({ message: "Debe indicar rango de fechas" });
  }

  if (!Array.isArray(contenido) || contenido.length === 0) {
    return res.status(400).json({ message: "Debe seleccionar contenido para exportar" });
  }

  return res.status(202).json({
    estado: "simulado",
    message: "Exportacion registrada. Generacion PDF/Excel pendiente de backend.",
    filename: nombreArchivoReporte(modulo, desde, hasta, formatoArchivo)
  });
});

app.get("/configuracion", async (req, res) => {
  try {
    const config = await getConfiguracionGlobal();
    return res.json({
      config,
      schema: Object.fromEntries(
        Object.entries(CONFIGURACION_DEFAULTS).map(([clave, item]) => [clave, item.seccion])
      )
    });
  } catch (error) {
    logError("Error al obtener configuracion:", error);
    return res.status(500).json({ message: "Error al obtener configuracion" });
  }
});

app.post("/autorizacion/validar", async (req, res) => {
  const clave = String(req.body?.clave || "").trim();
  const claveActual = await getClaveAutorizacion();
  if (clave !== claveActual) {
    return res.status(403).json({ message: "Clave maestra incorrecta" });
  }
  return res.json({ ok: true });
});

app.put("/configuracion", async (req, res) => {
  const cambios = req.body?.config || {};
  const clavesInvalidas = Object.keys(cambios).filter(
    (clave) => !Object.prototype.hasOwnProperty.call(CONFIGURACION_DEFAULTS, clave)
  );

  if (clavesInvalidas.length) {
    return res.status(400).json({ message: `Configuraciones invalidas: ${clavesInvalidas.join(", ")}` });
  }

  try {
    const actualizadoEn = new Date().toISOString();

    await runQuery("BEGIN TRANSACTION");
    for (const [clave, valor] of Object.entries(cambios)) {
      const seccion = CONFIGURACION_DEFAULTS[clave].seccion;
      await runQuery(
        `INSERT INTO configuracion_global (clave, valor, seccion, actualizado_en)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(clave) DO UPDATE SET
           valor = excluded.valor,
           seccion = excluded.seccion,
           actualizado_en = excluded.actualizado_en`,
        [clave, serializarConfigValor(valor), seccion, actualizadoEn]
      );
    }
    await runQuery("COMMIT");

    const config = await getConfiguracionGlobal();
    return res.json({ message: "Configuracion guardada", config });
  } catch (error) {
    try {
      await runQuery("ROLLBACK");
    } catch (rollbackError) {
      logError("Rollback configuracion", rollbackError);
    }

    logError("Error al guardar configuracion:", error);
    return res.status(500).json({ message: "Error al guardar configuracion" });
  }
});

Promise.all([
  ensureUsuariosSchema(),
  ensureCajaMovimientosTable(),
  ensureProveedoresSchema(),
  ensureProductosSchema(),
  ensureClientesSchema(),
  ensureConfiguracionSchema()
])
  .then(async () => {
    await Promise.all([
      runQuery("CREATE INDEX IF NOT EXISTS idx_usuarios_usuario ON usuarios(usuario)"),
      runQuery("CREATE INDEX IF NOT EXISTS idx_productos_activo ON productos(activo)"),
      runQuery("CREATE INDEX IF NOT EXISTS idx_ventas_estado ON ventas(estado)"),
      runQuery("CREATE INDEX IF NOT EXISTS idx_ventas_cliente ON ventas(cliente_id)"),
      runQuery("CREATE INDEX IF NOT EXISTS idx_ventas_caja ON ventas(caja_id)"),
      runQuery("CREATE INDEX IF NOT EXISTS idx_detalle_ventas_venta ON detalle_ventas(venta_id)"),
      runQuery("CREATE INDEX IF NOT EXISTS idx_movimientos_stock_producto ON movimientos_stock(producto_id)"),
      runQuery("CREATE INDEX IF NOT EXISTS idx_caja_movimientos_caja ON caja_movimientos(caja_id)"),
      runQuery("CREATE UNIQUE INDEX IF NOT EXISTS idx_productos_codigo_unique ON productos(codigo) WHERE codigo IS NOT NULL AND codigo != '' AND eliminado = 0"),
      runQuery("CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_dni_cuit_unique ON clientes(dni_cuit) WHERE dni_cuit IS NOT NULL AND dni_cuit != ''")
    ]);
    app.listen(PORT, () => {
      console.log(`Servidor corriendo en http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    logError("Error al preparar la base de datos:", error);
    process.exit(1);
  });
