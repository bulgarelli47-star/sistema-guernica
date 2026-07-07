const express = require("express");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
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
  sanitizarConfiguracionParaRol,
  serializarConfigValor,
  tienePermisoAccion
} = require("./services/configService");
const {
  normalizarInsumosCostos,
  calcularCostoPorRendimiento,
  guardarInsumosProducto,
  normalizarTipoProducto,
  consolidarComponentesDuplicados,
  guardarProductoCompuestoConfig,
  getComponentesProductoCompuesto,
  getCostosExtraProductoCompuesto,
  calcularStockDisponibleCompuesto,
  calcularCostoProductoCompuesto,
  calcularCostoProductoCompuestoPayload,
  applyStockChange,
  applyStockForNewItems,
  applyStockDiff,
  guardarRecetaSnapshotVenta,
  borrarRecetaSnapshotVenta
} = require("./services/stockService");
const {
  buildCajaArqueoData,
  buildCajaResumenConSaldoMp,
  buildCajaSnapshot,
  buildConteoBilletes,
  ensureCajaArqueosTable,
  ensureCajaMovimientosTable,
  ensureConciliacionesCuentasCobroTable,
  ensureConciliacionesCuentasDestinoTable,
  getCajaAbiertaActual,
  getCajaParaArqueos,
  getConciliacionesCuentaCobro,
  getConciliacionesCuentaDestino,
  getPagosCaja,
  getResumenPorCuentaCobro,
  getResumenPorCuentaDestino,
  getUltimaCajaRegistrada,
  guardarConciliacionCuentaCobro,
  guardarConciliacionCuentaDestino,
  getUltimoSaldoArrastradoPorCuenta,
  mapCajaArqueo,
  parseJsonOrFallback
} = require("./services/cajaService");
const {
  getVentaConDetalle,
  getVentaDetalleRows,
  refreshCuentaCorrienteSaldo,
  replaceVentaDetalle,
  resolveCobroData
} = require("./services/ventaService");
const {
  getResumenReportes,
  getReporteVentas,
  getReporteCaja,
  getReporteStock,
  getReporteCuentasCorrientes,
  getProductosMasVendidos,
  getResumenProveedoresPagos,
  getVentasPorDia,
  getResumenCuentasCobro,
  getReporteModificadores,
  getReporteDesviosReceta,
  getReporteSaludInventario,
  getReporteDependenciaInsumos,
  getReporteRiesgoVentas,
  getReporteRentabilidadProductos,
  getReporteRentabilidadCategorias,
  getReporteDashboardEjecutivo
} = require("./services/reportesService");
const {
  getResumenFinanciero
} = require("./services/finanzasService");
const {
  getTiposPagoActivos,
  getTodosTiposPago,
  calcularRecargoTipoPago,
  crearTipoPago,
  actualizarTipoPago,
  toggleActivoTipoPago,
  eliminarTipoPago,
  resolvePagoData,
  seedTiposPagoDefaults
} = require("./services/pagoService");
const {
  PROVEEDOR_IMPACTOS,
  calcularIvaCreditoFiscal,
  getProveedorConMetricas,
  parseProveedorPayload
} = require("./services/proveedorService");
const {
  parseClientePayload,
  buildClienteCuentaResumen,
  getClienteConMetricas,
  getHistorialProductosCliente,
  getDeudaActualizadaCliente,
  aplicarRecalculoDeudaCliente,
  ensureRecalculosCuentaCorrienteTable
} = require("./services/clienteService");
const {
  actualizarCuentaCobro,
  crearCuentaCobro,
  getCuentasCobro,
  getCuentasCobroPorTipo,
  toggleActivoCuentaCobro,
  validarCuentaCobroPago,
  validarCuentaCobroParaTipo,
  validarCuentaCobroVenta
} = require("./services/cuentaCobroService");
const {
  actualizarCuentaDestino,
  crearCuentaDestino,
  eliminarCuentaDestino,
  listarCuentasDestino,
  obtenerCuentaDestino,
  seedCuentasDestinoDefaults,
  setActivoCuentaDestino
} = require("./services/cuentaDestinoService");
const {
  aplicarStockComponentesSnapshot,
  aplicarStockDiffComponentesExtra,
  borrarSnapshotsDetalles,
  crearModificadorProducto,
  ensureModificadoresSchema,
  getComponentesSnapshotVenta,
  getStockDeltaVentaItem,
  getModificadoresProducto,
  getModificadoresProductoTodos,
  actualizarModificador,
  setActivoModificador,
  guardarComponentesSnapshot,
  guardarModificadoresDetalleVenta,
  guardarSnapshotsModificadoresVenta,
  resolverComposicionItemVenta
} = require("./services/modificadorService");
const {
  aprobarAjustePendiente,
  cancelarAjustesPendientesVentaReceta,
  crearAjustePendiente,
  crearAjustePendienteStockNegativo,
  crearAjustesPendientesVentaReceta,
  ensureStockAjustesPendientesSchema,
  getResumenCuentaLocalNoMonetaria,
  getResumenAjustesPendientes,
  listarAjustesPendientes,
  obtenerAjustePendiente,
  reconciliarAjustesPendientes,
  rechazarAjustePendiente,
  resolverAjustePendienteConCuentaLocal,
  resolverAjustePendienteConVenta
} = require("./services/stockAjustePendienteService");
const {
  crearIntentoPoint,
  crearOrdenPointDiagnostico,
  ensureMercadoPagoPointSchema,
  listarIntentosPoint,
  listarTerminalesPoint,
  obtenerIntentoPoint
} = require("./services/mercadoPagoPointService");
const {
  buildPreviewProduccion,
  listarProductosProducibles,
  listarProducciones,
  obtenerProduccion,
  registrarProduccion
} = require("./services/produccionService");

// Cargar variables de .env local si existe (sin dependencia dotenv)
{
  const envFile = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envFile)) {
    fs.readFileSync(envFile, "utf8")
      .split(/\r?\n/)
      .forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return;
        const eq = trimmed.indexOf("=");
        if (eq < 1) return;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (key && !(key in process.env)) process.env[key] = val;
      });
  }
}

const app = express();
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));

const RL_MSG = { message: "Demasiados intentos. Esperá unos minutos e intentá nuevamente." };
const rateLimitAutorizacion = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, message: RL_MSG, standardHeaders: true, legacyHeaders: false });
const rateLimitLogin = rateLimit({ windowMs: 60 * 1000, limit: 20, message: RL_MSG, standardHeaders: true, legacyHeaders: false });

app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = function(body) {
    if (!res.getHeader("Cache-Control")) res.setHeader("Cache-Control", "no-store");
    return originalJson(body);
  };
  next();
});

const PORT = Number(process.env.PORT) || 3000;
async function getClaveAutorizacion() {
  try {
    const row = await getQuery("SELECT valor FROM configuracion_global WHERE clave = 'autorizacion_clave_maestra'");
    const val = String(parsearConfigValor(row?.valor) || "").trim();
    return val || null;
  } catch { return null; }
}

function requerirClaveConfigurada(clave, res) {
  if (clave) return true;
  res.status(403).json({ message: "Configurá una clave de autorización antes de usar esta acción." });
  return false;
}

const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCK_MS = 10 * 60 * 1000;

app.use(express.json({ limit: "15mb" }));
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

const RUTAS_PUBLICAS = new Set(["/", "/login", "/logout", "/tienda/publica", "/tienda/publica/productos", "/tienda/publica/pedidos"]);

function logError(contexto, error, extra = "") {
  const msg = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error && error.stack ? `\n  ${error.stack.split("\n")[1]?.trim()}` : "";
  console.error(`[ERROR] ${contexto}${extra ? " | " + extra : ""}: ${msg}${stack}`);
}

async function requireAuth(req, res, next) {
  if (RUTAS_PUBLICAS.has(req.path) || req.path.startsWith("/tienda/publica/")) return next();

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

  if (pathname.startsWith("/clientes")) {
    if (esLectura) return next();
    const esCrudCliente =
      pathname === "/clientes" ||
      /^\/clientes\/\d+$/.test(pathname) ||
      /^\/clientes\/\d+\/estado$/.test(pathname);
    if (esCrudCliente && !puedeRol(req, ROLES.ADMIN_ENCARGADO))
      return res.status(403).json({ message: "No tenes permisos para gestionar clientes" });
    return next();
  }

  if (pathname.startsWith("/cuentas_cobro")) {
    if (esLectura) return next();
    if (!puedeRol(req, ROLES.ADMIN_ENCARGADO))
      return res.status(403).json({ message: "No tenes permisos para gestionar cuentas de cobro" });
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

async function ensureTiposPagoSchema() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS tipos_pago (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT NOT NULL UNIQUE,
      nombre TEXT NOT NULL,
      activo INTEGER NOT NULL DEFAULT 1,
      impacta_caja INTEGER NOT NULL DEFAULT 0,
      impacta_digital INTEGER NOT NULL DEFAULT 0,
      permite_mixto INTEGER NOT NULL DEFAULT 0,
      requiere_caja_abierta INTEGER NOT NULL DEFAULT 1,
      orden INTEGER NOT NULL DEFAULT 0,
      usa_recargo INTEGER NOT NULL DEFAULT 0,
      porcentaje_recargo REAL NOT NULL DEFAULT 0,
      permite_cuotas INTEGER NOT NULL DEFAULT 0,
      cuotas_json TEXT
    )
  `);
  await ensureColumn("tipos_pago", "usa_recargo", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("tipos_pago", "porcentaje_recargo", "REAL NOT NULL DEFAULT 0");
  await ensureColumn("tipos_pago", "permite_cuotas", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("tipos_pago", "cuotas_json", "TEXT");
  await seedTiposPagoDefaults();
}

async function ensureCuentasCobroSchema() {
  await ensureColumn("pagos", "cuenta_cobro_id", "INTEGER");
  await ensureColumn("ventas", "cuenta_cobro_id", "INTEGER");
  await ensureColumn("ventas", "recargo_porcentaje", "REAL NOT NULL DEFAULT 0");
  await ensureColumn("ventas", "recargo_monto", "REAL NOT NULL DEFAULT 0");
  await runQuery(`
    CREATE TABLE IF NOT EXISTS cuentas_destino (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      tipo_destino TEXT NOT NULL DEFAULT 'otro',
      alias TEXT,
      cbu_cvu TEXT,
      activo INTEGER NOT NULL DEFAULT 1,
      orden INTEGER NOT NULL DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    )
  `);
  await runQuery(`
    CREATE TABLE IF NOT EXISTS cuentas_cobro (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      tipo_pago_codigo TEXT NOT NULL,
      tipo_cuenta TEXT,
      proveedor_integracion TEXT,
      activo INTEGER NOT NULL DEFAULT 1,
      orden INTEGER NOT NULL DEFAULT 0,
      alias TEXT,
      cbu_cvu TEXT,
      external_id TEXT,
      terminal_id TEXT,
      store_id TEXT,
      pos_id TEXT,
      metadata_json TEXT,
      cuenta_destino_id INTEGER,
      created_at TEXT,
      updated_at TEXT
    )
  `);
  await ensureColumn("cuentas_cobro", "cuenta_destino_id", "INTEGER");
  await seedCuentasDestinoDefaults();
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
    "UPDATE productos SET stock = 0, stock_minimo = 0, alerta_stock_minimo = 0 WHERE tipo = 'compuesto' AND maneja_stock = 0"
  );
}

async function ensureVentaRecetaSnapshotSchema() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS detalle_venta_receta_snapshot (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venta_id INTEGER NOT NULL,
      detalle_venta_id INTEGER NOT NULL,
      producto_vendido_id INTEGER NOT NULL,
      componente_id INTEGER NOT NULL,
      componente_nombre_snapshot TEXT NOT NULL,
      cantidad_por_porcion REAL NOT NULL DEFAULT 0,
      cantidad_total REAL NOT NULL DEFAULT 0,
      unidad TEXT NOT NULL DEFAULT 'un',
      costo_unitario_snapshot REAL NOT NULL DEFAULT 0,
      costo_total_snapshot REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (venta_id) REFERENCES ventas(id),
      FOREIGN KEY (detalle_venta_id) REFERENCES detalle_ventas(id)
    )
  `);
  await runQuery("CREATE INDEX IF NOT EXISTS idx_dvrs_venta ON detalle_venta_receta_snapshot(venta_id)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_dvrs_detalle ON detalle_venta_receta_snapshot(detalle_venta_id)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_dvrs_componente ON detalle_venta_receta_snapshot(componente_id)");
}

async function ensureClientesSchema() {
  await ensureColumn("clientes", "dni_cuit", "TEXT");
  await ensureColumn("clientes", "tipo_persona", "TEXT NOT NULL DEFAULT 'fisica'");
  await ensureColumn("clientes", "tipo_cliente", "TEXT NOT NULL DEFAULT 'cliente'");
  await ensureColumn("clientes", "tipo_cuenta_corriente", "TEXT NOT NULL DEFAULT 'normal'");
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
  await ensureColumn("clientes", "suspendido", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("clientes", "perfil_cliente", "TEXT NOT NULL DEFAULT 'normal'");
  await ensureColumn("clientes", "permite_excedente", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("clientes", "requiere_autorizacion", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("clientes", "usa_reglas_personalizadas", "INTEGER NOT NULL DEFAULT 0");
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

async function ensureTiendaSchema() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS tienda_pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo_publico TEXT NOT NULL UNIQUE,
      cliente_nombre TEXT NOT NULL,
      cliente_telefono TEXT,
      observacion TEXT,
      estado TEXT NOT NULL DEFAULT 'recibido',
      total_estimado REAL NOT NULL DEFAULT 0,
      origen TEXT NOT NULL DEFAULT 'qr',
      creado_en TEXT NOT NULL,
      actualizado_en TEXT NOT NULL,
      tomado_por_usuario_id INTEGER,
      venta_id INTEGER
    )
  `);
  await runQuery(`
    CREATE TABLE IF NOT EXISTS tienda_pedido_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL,
      producto_id INTEGER NOT NULL,
      producto_nombre_snapshot TEXT NOT NULL,
      cantidad REAL NOT NULL DEFAULT 1,
      precio_unitario_snapshot REAL NOT NULL DEFAULT 0,
      subtotal_snapshot REAL NOT NULL DEFAULT 0,
      observacion TEXT,
      estado_stock_snapshot TEXT NOT NULL DEFAULT 'disponible',
      FOREIGN KEY (pedido_id) REFERENCES tienda_pedidos(id),
      FOREIGN KEY (producto_id) REFERENCES productos(id)
    )
  `);
  await runQuery(`
    CREATE TABLE IF NOT EXISTS tienda_pedido_item_modificadores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_item_id INTEGER NOT NULL,
      modificador_id INTEGER NOT NULL,
      modificador_nombre_snapshot TEXT NOT NULL,
      tipo_snapshot TEXT NOT NULL,
      cantidad REAL NOT NULL DEFAULT 1,
      precio_extra_snapshot REAL NOT NULL DEFAULT 0,
      subtotal_snapshot REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (pedido_item_id) REFERENCES tienda_pedido_items(id),
      FOREIGN KEY (modificador_id) REFERENCES modificadores(id)
    )
  `);
  await ensureColumn("tienda_pedidos", "motivo_rechazo", "TEXT");
  await runQuery(`
    CREATE TABLE IF NOT EXISTS producto_ingredientes_visibles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      producto_id INTEGER NOT NULL,
      nombre TEXT NOT NULL,
      incluido_por_defecto INTEGER NOT NULL DEFAULT 1,
      permite_quitar INTEGER NOT NULL DEFAULT 1,
      permite_extra INTEGER NOT NULL DEFAULT 0,
      precio_extra REAL NOT NULL DEFAULT 0,
      orden INTEGER NOT NULL DEFAULT 0,
      activo INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (producto_id) REFERENCES productos(id)
    )
  `);
  await runQuery(
    "CREATE INDEX IF NOT EXISTS idx_piv_producto ON producto_ingredientes_visibles(producto_id)"
  );
  await runQuery(`
    CREATE TABLE IF NOT EXISTS tienda_pedido_item_ingredientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_item_id INTEGER NOT NULL,
      ingrediente_id INTEGER,
      tipo TEXT NOT NULL,
      nombre_snapshot TEXT NOT NULL,
      precio_extra_snapshot REAL NOT NULL DEFAULT 0,
      cantidad REAL NOT NULL DEFAULT 1,
      nota TEXT,
      FOREIGN KEY (pedido_item_id) REFERENCES tienda_pedido_items(id),
      FOREIGN KEY (ingrediente_id) REFERENCES producto_ingredientes_visibles(id)
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

async function getRecetasSinStockIdsVenta(items = []) {
  const ids = [...new Set((Array.isArray(items) ? items : [])
    .map((item) => Number(item.producto_id || 0))
    .filter(Boolean))];
  if (!ids.length) return new Set();

  const rows = await allQuery(
    `SELECT id
     FROM productos
     WHERE id IN (${ids.map(() => "?").join(",")})
       AND LOWER(COALESCE(tipo, 'simple')) = 'compuesto'
       AND COALESCE(maneja_stock, 0) = 0`,
    ids
  );
  return new Set(rows.map((row) => Number(row.id)));
}

async function filtrarDetallesConStockFisico(detalles = []) {
  const recetasSinStock = await getRecetasSinStockIdsVenta(detalles);
  if (!recetasSinStock.size) return detalles;
  return detalles.filter((detalle) => !recetasSinStock.has(Number(detalle.producto_id || 0)));
}

async function filtrarComponentesSnapshotConStockFisico(componentes = [], detalles = []) {
  const recetasSinStock = await getRecetasSinStockIdsVenta(detalles);
  if (!recetasSinStock.size) return componentes;

  const detalleRecetaIds = new Set(
    detalles
      .filter((detalle) => recetasSinStock.has(Number(detalle.producto_id || 0)))
      .map((detalle) => Number(detalle.detalle_venta_id ?? detalle.id))
      .filter(Boolean)
  );
  return componentes.filter((componente) => !detalleRecetaIds.has(Number(componente.detalle_venta_id || 0)));
}

async function getComponentesItemsConStockFisico(items = []) {
  const recetasSinStock = await getRecetasSinStockIdsVenta(items);
  return (Array.isArray(items) ? items : [])
    .filter((item) => !recetasSinStock.has(Number(item.producto_id || 0)))
    .flatMap((item) => Array.isArray(item.componentes) ? item.componentes : []);
}

function getUsuarioAuditoria(req, fallback = "admin") {
  return req.usuario?.usuario || fallback || "admin";
}

// CV2.5-B: rellena snapshots históricos en filas anteriores a esta fase
async function backfillCobrosV25Snapshots() {
  const tblCC = await getQuery("SELECT name FROM sqlite_master WHERE type='table' AND name='cuentas_cobro'");
  if (!tblCC) return; // instalación limpia sin data — nada que rellenar

  await runQuery(`
    UPDATE venta_cobros
    SET
      cuenta_cobro_nombre_snapshot    = (SELECT cc.nombre            FROM cuentas_cobro cc WHERE cc.id = venta_cobros.cuenta_cobro_id),
      cuenta_cobro_tipo_pago_snapshot = (SELECT cc.tipo_pago_codigo  FROM cuentas_cobro cc WHERE cc.id = venta_cobros.cuenta_cobro_id),
      cuenta_destino_id_snapshot      = (SELECT cc.cuenta_destino_id FROM cuentas_cobro cc WHERE cc.id = venta_cobros.cuenta_cobro_id),
      cuenta_destino_nombre_snapshot  = (
        SELECT cd.nombre FROM cuentas_cobro cc
        LEFT JOIN cuentas_destino cd ON cd.id = cc.cuenta_destino_id
        WHERE cc.id = venta_cobros.cuenta_cobro_id
      )
    WHERE cuenta_cobro_nombre_snapshot IS NULL
      AND cuenta_cobro_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM cuentas_cobro cc WHERE cc.id = venta_cobros.cuenta_cobro_id)
  `);

  await runQuery(`
    UPDATE pagos_cc_cobros
    SET
      cuenta_cobro_nombre_snapshot    = (SELECT cc.nombre            FROM cuentas_cobro cc WHERE cc.id = pagos_cc_cobros.cuenta_cobro_id),
      cuenta_cobro_tipo_pago_snapshot = (SELECT cc.tipo_pago_codigo  FROM cuentas_cobro cc WHERE cc.id = pagos_cc_cobros.cuenta_cobro_id),
      cuenta_destino_id_snapshot      = (SELECT cc.cuenta_destino_id FROM cuentas_cobro cc WHERE cc.id = pagos_cc_cobros.cuenta_cobro_id),
      cuenta_destino_nombre_snapshot  = (
        SELECT cd.nombre FROM cuentas_cobro cc
        LEFT JOIN cuentas_destino cd ON cd.id = cc.cuenta_destino_id
        WHERE cc.id = pagos_cc_cobros.cuenta_cobro_id
      )
    WHERE cuenta_cobro_nombre_snapshot IS NULL
      AND cuenta_cobro_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM cuentas_cobro cc WHERE cc.id = pagos_cc_cobros.cuenta_cobro_id)
  `);
}

// ── Cobros V2 ─────────────────────────────────────────────────────────────────
async function ensureVentaCobrosSchema() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS venta_cobros (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      venta_id        INTEGER NOT NULL,
      tipo_cobro      TEXT NOT NULL,
      cuenta_cobro_id INTEGER,
      monto           REAL NOT NULL DEFAULT 0,
      estado          TEXT NOT NULL DEFAULT 'confirmado',
      created_at      TEXT,
      FOREIGN KEY (venta_id) REFERENCES ventas(id)
    )
  `);

  // ── CC 3.0A: canal de cobro para pagos de deuda en cuenta corriente ──────────
  await runQuery(`
    CREATE TABLE IF NOT EXISTS pagos_cc_cobros (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id        TEXT NOT NULL,
      tipo_cobro      TEXT NOT NULL,
      cuenta_cobro_id INTEGER,
      monto           REAL NOT NULL,
      caja_id         INTEGER,
      fecha           TEXT,
      hora            TEXT,
      created_at      TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await ensureColumn("pagos_cuenta_corriente", "group_id", "TEXT");

  // CV2.5-A: snapshot de cuenta al momento de la transacción — permite renombrar/desactivar cuentas sin romper históricos
  await ensureColumn("venta_cobros",    "cuenta_cobro_nombre_snapshot",   "TEXT");
  await ensureColumn("venta_cobros",    "cuenta_cobro_tipo_pago_snapshot", "TEXT");
  await ensureColumn("venta_cobros",    "cuenta_destino_id_snapshot",      "INTEGER");
  await ensureColumn("venta_cobros",    "cuenta_destino_nombre_snapshot",  "TEXT");
  await ensureColumn("pagos_cc_cobros", "cuenta_cobro_nombre_snapshot",   "TEXT");
  await ensureColumn("pagos_cc_cobros", "cuenta_cobro_tipo_pago_snapshot", "TEXT");
  await ensureColumn("pagos_cc_cobros", "cuenta_destino_id_snapshot",      "INTEGER");
  await ensureColumn("pagos_cc_cobros", "cuenta_destino_nombre_snapshot",  "TEXT");
  // CC3B-A: auditoría básica de cobros CC
  await ensureColumn("pagos_cuenta_corriente", "observacion",        "TEXT");
  await ensureColumn("pagos_cuenta_corriente", "numero_comprobante", "TEXT");
  await ensureColumn("pagos_cuenta_corriente", "usuario_id",         "INTEGER");
  await ensureColumn("pagos_cuenta_corriente", "usuario_nombre",     "TEXT");
  await ensureColumn("pagos_cc_cobros",        "observacion",        "TEXT");
  await ensureColumn("pagos_cc_cobros",        "numero_comprobante", "TEXT");
  await ensureColumn("pagos_cc_cobros",        "usuario_id",         "INTEGER");
  await ensureColumn("pagos_cc_cobros",        "usuario_nombre",     "TEXT");
  // CC3B-E1: schema reversa — campos para marcar cobro revertido e insertar grupo reversa
  await ensureColumn("pagos_cuenta_corriente", "revertido",              "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("pagos_cuenta_corriente", "reversa_de_group_id",    "TEXT");
  await ensureColumn("pagos_cuenta_corriente", "motivo_reversa",         "TEXT");
  await ensureColumn("pagos_cuenta_corriente", "usuario_reversa_id",     "INTEGER");
  await ensureColumn("pagos_cuenta_corriente", "usuario_reversa_nombre", "TEXT");
  await ensureColumn("pagos_cuenta_corriente", "fecha_reversa",          "TEXT");
  await ensureColumn("pagos_cuenta_corriente", "hora_reversa",           "TEXT");
  await ensureColumn("pagos_cuenta_corriente", "tipo_movimiento",        "TEXT NOT NULL DEFAULT 'cobro'");
  await ensureColumn("pagos_cc_cobros",        "reversa_de_group_id",    "TEXT");
  await ensureColumn("pagos_cc_cobros",        "tipo_movimiento",        "TEXT NOT NULL DEFAULT 'cobro'");
  await backfillCobrosV25Snapshots();
}

const COBROS_V2_TIPOS_VALIDOS = new Set(["efectivo", "debito", "credito", "transferencia", "qr"]);

function normalizarCobrosV2(cobros) {
  if (!Array.isArray(cobros) || cobros.length === 0) return null;
  const resultado = [];
  for (const c of cobros) {
    const tipo = String(c.tipo_cobro || "").trim().toLowerCase();
    const monto = Number(c.monto ?? c.amount ?? 0);
    if (!COBROS_V2_TIPOS_VALIDOS.has(tipo)) {
      return { error: `tipo_cobro inválido en cobros[]: "${tipo}". Valores permitidos: ${[...COBROS_V2_TIPOS_VALIDOS].join(", ")}` };
    }
    if (!monto || monto <= 0) {
      return { error: `monto debe ser mayor a 0 en cobros[] (tipo: ${tipo})` };
    }
    resultado.push({
      tipo_cobro: tipo,
      cuenta_cobro_id: c.cuenta_cobro_id != null ? Number(c.cuenta_cobro_id) || null : null,
      monto: Number(monto.toFixed(2))
    });
  }
  return resultado;
}

function derivarCobroLegacy(cobrosNormalizados) {
  const montoEfectivo = Number(
    cobrosNormalizados.filter((c) => c.tipo_cobro === "efectivo").reduce((a, c) => a + c.monto, 0).toFixed(2)
  );
  const montoDebito = Number(
    cobrosNormalizados.filter((c) => c.tipo_cobro !== "efectivo").reduce((a, c) => a + c.monto, 0).toFixed(2)
  );
  const esSingle = cobrosNormalizados.length === 1;
  return {
    tipo_cobro: esSingle ? cobrosNormalizados[0].tipo_cobro : "mixto",
    monto_efectivo: montoEfectivo,
    monto_debito: montoDebito,
    cuenta_cobro_id: esSingle ? (cobrosNormalizados[0].cuenta_cobro_id ?? null) : null
  };
}

async function getCuentaCobroSnapshot(cuentaCobroId) {
  if (!cuentaCobroId) return { cuenta_cobro_nombre_snapshot: null, cuenta_cobro_tipo_pago_snapshot: null, cuenta_destino_id_snapshot: null, cuenta_destino_nombre_snapshot: null };
  const row = await getQuery(`
    SELECT cc.nombre            AS cuenta_cobro_nombre_snapshot,
           cc.tipo_pago_codigo  AS cuenta_cobro_tipo_pago_snapshot,
           cc.cuenta_destino_id AS cuenta_destino_id_snapshot,
           cd.nombre            AS cuenta_destino_nombre_snapshot
    FROM cuentas_cobro cc
    LEFT JOIN cuentas_destino cd ON cd.id = cc.cuenta_destino_id
    WHERE cc.id = ?
  `, [cuentaCobroId]);
  return {
    cuenta_cobro_nombre_snapshot:    row?.cuenta_cobro_nombre_snapshot    || null,
    cuenta_cobro_tipo_pago_snapshot: row?.cuenta_cobro_tipo_pago_snapshot || null,
    cuenta_destino_id_snapshot:      row?.cuenta_destino_id_snapshot      ?? null,
    cuenta_destino_nombre_snapshot:  row?.cuenta_destino_nombre_snapshot  || null
  };
}

async function registrarVentaCobros(ventaId, cobro, cuentaCobroId, created_at, cobrosV2 = null) {
  if (!ventaId) return;
  const now = created_at || new Date().toISOString();
  // Cobros V2: insertar exactamente las filas provistas
  if (Array.isArray(cobrosV2) && cobrosV2.length > 0) {
    let cuentaEfectivoId = null;
    if (cobrosV2.some(c => c.tipo_cobro === "efectivo" && c.cuenta_cobro_id == null)) {
      const efRow = await getQuery(
        "SELECT id FROM cuentas_cobro WHERE tipo_pago_codigo = 'efectivo' AND activo = 1 ORDER BY orden ASC, id ASC LIMIT 1"
      );
      cuentaEfectivoId = efRow ? efRow.id : null;
    }
    for (const c of cobrosV2) {
      const cuentaFinal = c.cuenta_cobro_id ??
        (c.tipo_cobro === "efectivo" ? cuentaEfectivoId : null);
      const snap = await getCuentaCobroSnapshot(cuentaFinal);
      await runQuery(
        `INSERT INTO venta_cobros (venta_id, tipo_cobro, cuenta_cobro_id, monto, estado, created_at, cuenta_cobro_nombre_snapshot, cuenta_cobro_tipo_pago_snapshot, cuenta_destino_id_snapshot, cuenta_destino_nombre_snapshot) VALUES (?, ?, ?, ?, 'confirmado', ?, ?, ?, ?, ?)`,
        [ventaId, c.tipo_cobro, cuentaFinal, c.monto, now, snap.cuenta_cobro_nombre_snapshot, snap.cuenta_cobro_tipo_pago_snapshot, snap.cuenta_destino_id_snapshot, snap.cuenta_destino_nombre_snapshot]
      );
    }
    return;
  }
  // Legacy fallback
  if (!cobro) return;
  const tipo = String(cobro.tipo_cobro || "").toLowerCase();
  if (!tipo || tipo === "cuenta_corriente" || tipo === "cuenta_corriente_pendiente") return;
  const needsEfectivo = tipo === "mixto" ? Number(cobro.monto_efectivo) > 0 : tipo === "efectivo";
  let cuentaEfectivoId = null;
  if (needsEfectivo) {
    const efRow = await getQuery(
      "SELECT id FROM cuentas_cobro WHERE tipo_pago_codigo = 'efectivo' AND activo = 1 ORDER BY orden ASC, id ASC LIMIT 1"
    );
    cuentaEfectivoId = efRow ? efRow.id : null;
  }
  if (tipo === "mixto") {
    if (Number(cobro.monto_efectivo) > 0) {
      const snapEf = await getCuentaCobroSnapshot(cuentaEfectivoId);
      await runQuery(
        `INSERT INTO venta_cobros (venta_id, tipo_cobro, cuenta_cobro_id, monto, estado, created_at, cuenta_cobro_nombre_snapshot, cuenta_cobro_tipo_pago_snapshot, cuenta_destino_id_snapshot, cuenta_destino_nombre_snapshot) VALUES (?, 'efectivo', ?, ?, 'confirmado', ?, ?, ?, ?, ?)`,
        [ventaId, cuentaEfectivoId, Number(cobro.monto_efectivo), now, snapEf.cuenta_cobro_nombre_snapshot, snapEf.cuenta_cobro_tipo_pago_snapshot, snapEf.cuenta_destino_id_snapshot, snapEf.cuenta_destino_nombre_snapshot]
      );
    }
    if (Number(cobro.monto_debito) > 0) {
      const snapDeb = await getCuentaCobroSnapshot(cuentaCobroId ?? null);
      await runQuery(
        `INSERT INTO venta_cobros (venta_id, tipo_cobro, cuenta_cobro_id, monto, estado, created_at, cuenta_cobro_nombre_snapshot, cuenta_cobro_tipo_pago_snapshot, cuenta_destino_id_snapshot, cuenta_destino_nombre_snapshot) VALUES (?, 'debito', ?, ?, 'confirmado', ?, ?, ?, ?, ?)`,
        [ventaId, cuentaCobroId ?? null, Number(cobro.monto_debito), now, snapDeb.cuenta_cobro_nombre_snapshot, snapDeb.cuenta_cobro_tipo_pago_snapshot, snapDeb.cuenta_destino_id_snapshot, snapDeb.cuenta_destino_nombre_snapshot]
      );
    }
  } else {
    const monto = tipo === "efectivo" ? Number(cobro.monto_efectivo) : Number(cobro.monto_debito);
    const cuentaFinal = tipo === "efectivo"
      ? (cuentaCobroId ?? cuentaEfectivoId)
      : (cuentaCobroId ?? null);
    const snapSimple = await getCuentaCobroSnapshot(cuentaFinal);
    await runQuery(
      `INSERT INTO venta_cobros (venta_id, tipo_cobro, cuenta_cobro_id, monto, estado, created_at, cuenta_cobro_nombre_snapshot, cuenta_cobro_tipo_pago_snapshot, cuenta_destino_id_snapshot, cuenta_destino_nombre_snapshot) VALUES (?, ?, ?, ?, 'confirmado', ?, ?, ?, ?, ?)`,
      [ventaId, tipo, cuentaFinal, monto || 0, now, snapSimple.cuenta_cobro_nombre_snapshot, snapSimple.cuenta_cobro_tipo_pago_snapshot, snapSimple.cuenta_destino_id_snapshot, snapSimple.cuenta_destino_nombre_snapshot]
    );
  }
}
async function migrarVentaCobrosLegacy() {
  // Ventas simples cobradas sin fila en venta_cobros (idempotente: NOT EXISTS)
  await runQuery(`
    INSERT INTO venta_cobros (venta_id, tipo_cobro, cuenta_cobro_id, monto, estado, created_at,
      cuenta_cobro_nombre_snapshot, cuenta_cobro_tipo_pago_snapshot, cuenta_destino_id_snapshot, cuenta_destino_nombre_snapshot)
    SELECT v.id,
           LOWER(v.tipo_cobro),
           v.cuenta_cobro_id,
           CASE WHEN LOWER(v.tipo_cobro) = 'efectivo' THEN v.monto_efectivo ELSE v.monto_debito END,
           'confirmado',
           v.fecha || ' ' || v.hora,
           cc.nombre,
           cc.tipo_pago_codigo,
           cc.cuenta_destino_id,
           cd.nombre
    FROM ventas v
    LEFT JOIN cuentas_cobro cc ON cc.id = v.cuenta_cobro_id
    LEFT JOIN cuentas_destino cd ON cd.id = cc.cuenta_destino_id
    WHERE v.estado = 'cobrada'
      AND v.tipo_cobro IS NOT NULL
      AND LOWER(v.tipo_cobro) NOT IN ('mixto', 'cuenta_corriente', 'cuenta_corriente_pendiente')
      AND NOT EXISTS (SELECT 1 FROM venta_cobros vc WHERE vc.venta_id = v.id)
  `);

  // Mixtas: parte efectivo (solo si no existe fila efectivo para esa venta)
  await runQuery(`
    INSERT INTO venta_cobros (venta_id, tipo_cobro, cuenta_cobro_id, monto, estado, created_at,
      cuenta_cobro_nombre_snapshot, cuenta_cobro_tipo_pago_snapshot, cuenta_destino_id_snapshot, cuenta_destino_nombre_snapshot)
    SELECT v.id, 'efectivo', NULL, v.monto_efectivo, 'confirmado', v.fecha || ' ' || v.hora,
           NULL, NULL, NULL, NULL
    FROM ventas v
    WHERE LOWER(v.tipo_cobro) = 'mixto'
      AND v.monto_efectivo > 0
      AND NOT EXISTS (
        SELECT 1 FROM venta_cobros vc WHERE vc.venta_id = v.id AND vc.tipo_cobro = 'efectivo'
      )
  `);

  // Mixtas: parte debito (solo si no existe fila debito para esa venta)
  await runQuery(`
    INSERT INTO venta_cobros (venta_id, tipo_cobro, cuenta_cobro_id, monto, estado, created_at,
      cuenta_cobro_nombre_snapshot, cuenta_cobro_tipo_pago_snapshot, cuenta_destino_id_snapshot, cuenta_destino_nombre_snapshot)
    SELECT v.id, 'debito', v.cuenta_cobro_id, v.monto_debito, 'confirmado', v.fecha || ' ' || v.hora,
           cc.nombre, cc.tipo_pago_codigo, cc.cuenta_destino_id, cd.nombre
    FROM ventas v
    LEFT JOIN cuentas_cobro cc ON cc.id = v.cuenta_cobro_id
    LEFT JOIN cuentas_destino cd ON cd.id = cc.cuenta_destino_id
    WHERE LOWER(v.tipo_cobro) = 'mixto'
      AND v.monto_debito > 0
      AND NOT EXISTS (
        SELECT 1 FROM venta_cobros vc WHERE vc.venta_id = v.id AND vc.tipo_cobro = 'debito'
      )
  `);
}
// ─────────────────────────────────────────────────────────────────────────────

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
    precio_unitario: Number(item.precio_unitario ?? item.precio_venta) || 0,
    modificadores: Array.isArray(item.modificadores) ? item.modificadores : [],
    ingredientes: Array.isArray(item.ingredientes) ? item.ingredientes : []
  }));
}

function calculateTotal(items) {
  return items.reduce((acc, item) => {
    return acc + item.cantidad * item.precio_unitario;
  }, 0);
}

function tieneModificadoresVenta(items = []) {
  return items.some((item) => Array.isArray(item.modificadores) && item.modificadores.length > 0);
}

async function resolverItemsVentaNormalConModificadores(items) {
  const resueltos = [];
  for (const item of items) {
    resueltos.push(await resolverComposicionItemVenta(item, {
      validarAsociacion: true,
      tiposPermitidos: ["libre", "observacion", "agregar", "quitar"]
    }));
  }
  return resueltos;
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

app.post("/login", rateLimitLogin, async (req, res) => {
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
    console.log("IMG MIME:", match[1]);
    console.log("IMG BASE64 LENGTH:", match[2].length);
    console.log("IMG BUFFER LENGTH:", buffer.length);
    if (!buffer.length || buffer.length > 5 * 1024 * 1024) {
      console.log("IMG RECHAZADA > 5MB");
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
    const costoBase = tipoProducto === "compuesto"
      ? await calcularCostoProductoCompuestoPayload(componentes, costos_extra, rendimientoPost)
      : usaCostos ? calcularCostoPorRendimiento(costos_insumos) : Number(precio_compra) || 0;
    const costoFinal = calcularCostoFinal(costoBase, iva_porcentaje, precio_compra_incluye_iva ? 1 : 0);
    const precioVentaFinal = Number(precio_venta) || calcularPrecioSugerido(
      costoFinal,
      categoriaData?.margen_porcentaje || 0,
      redondeo
    );
    const configGlobal = await getConfiguracionGlobal();
    const codigoManual = String(codigo || "").trim();
    const codigoAutomaticoActivo = configGlobal.stock_codigo_automatico !== false;
    const codigoFinal = codigoManual || (codigoAutomaticoActivo ? await generarCodigoProducto(Number(categoria_id)) : "");

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
        recetaSinStockFisico ? 0 : stockInicial,
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
                p.stock, p.costo_final, p.precio_compra, p.tipo, p.maneja_stock,
                (SELECT SUM(ci.costo_unitario) FROM producto_costos_insumos ci WHERE ci.producto_id = p.id) AS costo_consumo_unitario
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
      const costoComps = comps.reduce((a, c) => {
        const cu = c.costo_consumo_unitario != null
          ? Number(c.costo_consumo_unitario)
          : Number(c.costo_final || c.precio_compra || 0);
        return a + cu * Number(c.cantidad || 0);
      }, 0);
      const rend = Math.max(1, Number(rendimiento) || 1);
      const extrasPorPorcion = Number((extras / rend).toFixed(4));
      return Number((costoComps + extrasPorPorcion).toFixed(2));
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
        const manejaStockPropio = Number(row.maneja_stock) === 1;
        const stockFisico = Number(row.stock || 0);
        const stock = manejaStockPropio ? stockFisico : stockCompuestoMemoria(row.id, row.rendimiento_receta);
        return {
          ...row,
          stock_fisico: manejaStockPropio ? stockFisico : 0,
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

    const CAMPOS_COSTO = ["precio_compra","costo_final","costo_teorico","costo_consumo_unitario","margen_porcentaje","precio_sugerido","precio_referencial_proveedor","precio_compra_incluye_iva"];
    const productos = !puedeRol(req, ROLES.ADMIN_ENCARGADO)
      ? enriquecidos.map(p => { const f = { ...p }; CAMPOS_COSTO.forEach(c => delete f[c]); return f; })
      : enriquecidos;
    return res.json(productos);
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
    const stockProducto = Number(stock) || 0;
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
        recetaSinStockFisico ? 0 : stockProducto,
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
  if (!requerirClaveConfigurada(claveConfig, res)) return;
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
    const configGlobal = await getConfiguracionGlobal();
    const codigoManual = String(codigo || "").trim();
    const codigoAutomaticoActivo = configGlobal.stock_codigo_automatico !== false;
    const codigoFinal = codigoManual || (codigoAutomaticoActivo ? await generarCodigoProducto(Number(categoria_id)) : "");

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

    const manejaStockPropio = Number(producto.maneja_stock) === 1;

    const [componentes, costos_extra, costo] = await Promise.all([
      getComponentesProductoCompuesto(productoId),
      getCostosExtraProductoCompuesto(productoId),
      calcularCostoProductoCompuesto(productoId)
    ]);

    const stockFisico = manejaStockPropio ? Number(producto.stock || 0) : 0;
    const stock_disponible = manejaStockPropio
      ? stockFisico
      : await calcularStockDisponibleCompuesto(productoId);

    return res.json({
      ...producto,
      stock: manejaStockPropio ? stockFisico : 0,
      stock_fisico: stockFisico,
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
    const producto = await getQuery(
      "SELECT id, tipo, es_combo, maneja_stock, stock FROM productos WHERE id = ?",
      [productoId]
    );

    if (!producto || (normalizarTipoProducto(producto.tipo) !== "compuesto")) {
      return res.status(404).json({ message: "Producto compuesto no encontrado" });
    }

    const stock_disponible = Number(producto.maneja_stock) === 1
      ? Number(producto.stock || 0)
      : await calcularStockDisponibleCompuesto(productoId);

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
  const clave = String(req.body?.clave || req.body?.authorization_code || "").trim();

  try {
    const claveActual = await getClaveAutorizacion();
    if (!requerirClaveConfigurada(claveActual, res)) return;
    if (!clave || clave !== claveActual) {
      return res.status(403).json({ message: "Clave maestra incorrecta" });
    }

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

app.get("/productos/:id/modificadores", async (req, res) => {
  try {
    const producto = await getQuery("SELECT id FROM productos WHERE id = ? AND COALESCE(eliminado, 0) = 0", [req.params.id]);
    if (!producto) return res.status(404).json({ message: "Producto no encontrado" });
    const todos = req.query.todos === "1";
    return res.json(todos
      ? await getModificadoresProductoTodos(req.params.id)
      : await getModificadoresProducto(req.params.id));
  } catch (error) {
    logError("Error al obtener modificadores del producto:", error);
    return res.status(500).json({ message: "Error al obtener modificadores del producto" });
  }
});

app.put("/modificadores/:id", async (req, res) => {
  if (!(await requirePermiso(req, res, "stock_editar_producto", "No tenes permisos para editar modificadores"))) return;
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: "ID inválido" });
  try {
    const modificador = await actualizarModificador(id, req.body);
    return res.json({ message: "Modificador actualizado", modificador });
  } catch (error) {
    logError("Error al actualizar modificador:", error);
    return res.status(error.statusCode || 500).json({ message: error.message || "Error al actualizar modificador" });
  }
});

app.patch("/modificadores/:id/activo", async (req, res) => {
  if (!(await requirePermiso(req, res, "stock_editar_producto", "No tenes permisos para editar modificadores"))) return;
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: "ID inválido" });
  const activo = req.body.activo !== false && req.body.activo !== 0 && req.body.activo !== "0";
  try {
    await setActivoModificador(id, activo);
    return res.json({ message: activo ? "Modificador reactivado" : "Modificador desactivado" });
  } catch (error) {
    logError("Error al cambiar estado de modificador:", error);
    return res.status(500).json({ message: "Error al cambiar estado del modificador" });
  }
});

app.post("/productos/:id/modificadores", async (req, res) => {
  if (!(await requirePermiso(req, res, "stock_editar_producto", "No tenes permisos para editar productos"))) return;

  try {
    const producto = await getQuery("SELECT id FROM productos WHERE id = ? AND COALESCE(eliminado, 0) = 0", [req.params.id]);
    if (!producto) {
      return res.status(404).json({ message: "Producto no encontrado" });
    }

    const modificador = await crearModificadorProducto(req.params.id, req.body);
    return res.status(201).json({ message: "Modificador creado", modificador });
  } catch (error) {
    logError("Error al crear modificador del producto:", error);
    return res.status(error.statusCode || 500).json({ message: error.message || "Error al crear modificador del producto" });
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
    const esRecetaSinStockFisico = esCompuesto && !Number(producto.maneja_stock);
    if (esRecetaSinStockFisico) {
      return res.status(400).json({ message: "Este producto no posee stock propio. Ajusta sus ingredientes." });
    }

    const stockAnterior = Number(producto.stock || 0);
    const tiposPositivos = ["ingreso", "ajuste positivo", "devolucion"];
    const esIngreso = tiposPositivos.includes(tipoMovimiento.toLowerCase());
    const stockNuevo = esIngreso ? stockAnterior + cantidad : stockAnterior - cantidad;

    const stockFinal = stockNuevo;

    await runQuery("BEGIN TRANSACTION");
    await runQuery(
      `INSERT INTO movimientos_stock
      (producto_id, tipo_movimiento, cantidad, stock_anterior, stock_nuevo, motivo, proveedor_id, usuario, fecha, hora)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [productoId, tipoMovimiento, cantidad, stockAnterior, stockFinal, motivo, proveedorId, usuario, fecha, hora]
    );
    await runQuery("UPDATE productos SET stock = ? WHERE id = ?", [stockFinal, productoId]);

    // Si es receta con stock propio y es un ingreso, descontar ingredientes
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

    return res.json({ message: "Movimiento registrado correctamente", stock_nuevo: stockNuevo });
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

async function puedeGestionarAjustesPendientes(req) {
  if (normalizarRol(req.usuario?.rol) === "colaborador") return false;
  return puedeRol(req, ROLES.ADMIN_ENCARGADO) || await tienePermisoAccion(req, "stock_ajustar");
}

function buildConsumoTeoricoWhere(query = {}) {
  const where = [
    "COALESCE(v.estado, '') != 'anulado'",
    "COALESCE(v.tipo, '') != 'test_modificadores'",
    "LOWER(COALESCE(pv.tipo, 'simple')) = 'compuesto'",
    "COALESCE(pv.maneja_stock, 0) = 0"
  ];
  const params = [];
  if (query.desde) {
    where.push("v.fecha >= ?");
    params.push(String(query.desde).slice(0, 10));
  }
  if (query.hasta) {
    where.push("v.fecha <= ?");
    params.push(String(query.hasta).slice(0, 10));
  }
  return { where, params };
}

function roundConsumo(value) {
  return Number((Number(value) || 0).toFixed(4));
}

async function getConsumoTeoricoInsumos({ desde = null, hasta = null } = {}) {
  const filtros = buildConsumoTeoricoWhere({ desde, hasta });
  const whereSql = filtros.where.join(" AND ");

  const [baseRows, modificadorRows] = await Promise.all([
    allQuery(
      `SELECT
         pc.producto_id AS insumo_id,
         pi.nombre AS insumo_nombre,
         pi.unidad_medida,
         dv.producto_id AS producto_vendido_id,
         dv.nombre_producto AS producto_vendido_nombre,
         COALESCE(SUM(dv.cantidad), 0) AS cantidad_vendida,
         COALESCE(SUM(dv.cantidad * pc.cantidad), 0) AS cantidad_base,
         COUNT(DISTINCT v.id) AS ventas
       FROM detalle_ventas dv
       INNER JOIN ventas v ON v.id = dv.venta_id
       INNER JOIN productos pv ON pv.id = dv.producto_id
       INNER JOIN producto_componentes pc ON pc.producto_compuesto_id = pv.id
       INNER JOIN productos pi ON pi.id = pc.producto_id
       WHERE ${whereSql}
       GROUP BY pc.producto_id, pi.nombre, pi.unidad_medida, dv.producto_id, dv.nombre_producto`,
      filtros.params
    ),
    allQuery(
      `SELECT
         md.producto_id AS insumo_id,
         COALESCE(pi.nombre, md.nombre_producto) AS insumo_nombre,
         pi.unidad_medida,
         dv.producto_id AS producto_vendido_id,
         dv.nombre_producto AS producto_vendido_nombre,
         COALESCE(SUM(dv.cantidad), 0) AS cantidad_vendida,
         COALESCE(SUM(md.cantidad_delta), 0) AS cantidad_delta,
         COUNT(DISTINCT v.id) AS ventas
       FROM (
         SELECT
           detalle_venta_id,
           producto_id,
           MAX(nombre_producto) AS nombre_producto,
           COALESCE(SUM(CASE WHEN operacion = 'quitar' THEN -cantidad ELSE cantidad END), 0) AS cantidad_delta
         FROM detalle_venta_componentes_snapshot
         WHERE producto_id IS NOT NULL
           AND operacion IN ('agregar', 'quitar')
         GROUP BY detalle_venta_id, producto_id
       ) md
       INNER JOIN detalle_ventas dv ON dv.id = md.detalle_venta_id
       INNER JOIN ventas v ON v.id = dv.venta_id
       INNER JOIN productos pv ON pv.id = dv.producto_id
       LEFT JOIN productos pi ON pi.id = md.producto_id
       WHERE ${whereSql}
       GROUP BY md.producto_id, COALESCE(pi.nombre, md.nombre_producto), pi.unidad_medida, dv.producto_id, dv.nombre_producto`,
      filtros.params
    )
  ]);

  const detalleMap = new Map();
  const ensureDetalle = (row) => {
    const key = `${Number(row.insumo_id)}:${Number(row.producto_vendido_id)}`;
    if (!detalleMap.has(key)) {
      detalleMap.set(key, {
        producto_id: Number(row.insumo_id),
        nombre: row.insumo_nombre || `Insumo ${row.insumo_id}`,
        unidad_medida: row.unidad_medida || "",
        producto_vendido_id: Number(row.producto_vendido_id),
        producto_vendido_nombre: row.producto_vendido_nombre || `Producto ${row.producto_vendido_id}`,
        cantidad_vendida: 0,
        cantidad_base: 0,
        cantidad_delta: 0,
        ventas: 0
      });
    }
    return detalleMap.get(key);
  };

  for (const row of baseRows) {
    const item = ensureDetalle(row);
    item.cantidad_vendida = Math.max(item.cantidad_vendida, Number(row.cantidad_vendida || 0));
    item.cantidad_base += Number(row.cantidad_base || 0);
    item.ventas = Math.max(item.ventas, Number(row.ventas || 0));
  }

  for (const row of modificadorRows) {
    const item = ensureDetalle(row);
    item.cantidad_vendida = Math.max(item.cantidad_vendida, Number(row.cantidad_vendida || 0));
    item.cantidad_delta += Number(row.cantidad_delta || 0);
    item.ventas = Math.max(item.ventas, Number(row.ventas || 0));
  }

  const insumosMap = new Map();
  for (const item of detalleMap.values()) {
    const cantidadTeorica = Math.max(0, Number(item.cantidad_base || 0) + Number(item.cantidad_delta || 0));
    if (cantidadTeorica <= 0) continue;
    if (!insumosMap.has(item.producto_id)) {
      insumosMap.set(item.producto_id, {
        producto_id: item.producto_id,
        nombre: item.nombre,
        unidad_medida: item.unidad_medida,
        cantidad_total: 0,
        detalle: []
      });
    }
    const insumo = insumosMap.get(item.producto_id);
    insumo.cantidad_total += cantidadTeorica;
    insumo.detalle.push({
      producto_vendido_id: item.producto_vendido_id,
      producto_vendido_nombre: item.producto_vendido_nombre,
      cantidad_vendida: roundConsumo(item.cantidad_vendida),
      cantidad_teorica: roundConsumo(cantidadTeorica),
      ventas: Number(item.ventas || 0)
    });
  }

  const insumos = [...insumosMap.values()]
    .map((insumo) => ({
      ...insumo,
      cantidad_total: roundConsumo(insumo.cantidad_total),
      detalle: insumo.detalle.sort((a, b) => b.cantidad_teorica - a.cantidad_teorica || a.producto_vendido_nombre.localeCompare(b.producto_vendido_nombre))
    }))
    .sort((a, b) => b.cantidad_total - a.cantidad_total || a.nombre.localeCompare(b.nombre));

  return {
    desde: desde || null,
    hasta: hasta || null,
    insumos,
    limitaciones: [
      "El consumo base se calcula con la receta actual hasta activar snapshot base por venta."
    ]
  };
}

app.get("/stock/consumo-teorico", async (req, res) => {
  if (!(await requirePermiso(req, res, "stock_ver", "No tenes permisos para consultar consumo teorico"))) return;

  try {
    const data = await getConsumoTeoricoInsumos({
      desde: req.query.desde,
      hasta: req.query.hasta
    });
    return res.json(data);
  } catch (error) {
    logError("Error al obtener consumo teorico de stock:", error);
    return res.status(500).json({ message: "Error al obtener consumo teorico" });
  }
});

app.post("/stock/ajustes-pendientes", async (req, res) => {
  if (!(await requirePermiso(req, res, "stock_ver", "No tenes permisos para proponer ajustes de stock"))) return;

  try {
    const ajuste = await crearAjustePendiente({
      producto_id: req.body.producto_id,
      tipo_movimiento: req.body.tipo_movimiento,
      cantidad: req.body.cantidad,
      motivo: req.body.motivo,
      observaciones: req.body.observaciones,
      proveedor_id: req.body.proveedor_id,
      caja_id: req.body.caja_id,
      usuario: req.usuario?.nombre || req.body.usuario || "usuario",
      rol: req.usuario?.rol || ""
    });

    return res.status(201).json({
      ajuste: {
        id: ajuste.id,
        producto_id: ajuste.producto_id,
        producto_nombre: ajuste.producto_nombre,
        tipo_movimiento: ajuste.tipo_movimiento,
        cantidad: ajuste.cantidad,
        estado: ajuste.estado,
        stock_actual_snapshot: ajuste.stock_actual_snapshot
      }
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    logError("Error al crear ajuste pendiente de stock:", error);
    return res.status(500).json({ message: "Error al crear ajuste pendiente de stock" });
  }
});

app.get("/stock/ajustes-pendientes", async (req, res) => {
  if (!(await puedeGestionarAjustesPendientes(req))) {
    return res.status(403).json({ message: "No tenes permisos para listar ajustes pendientes de stock" });
  }

  try {
    const ajustes = await listarAjustesPendientes({
      estado: req.query.estado,
      solo_accionables: String(req.query.solo_accionables || "") === "1"
    });
    return res.json(ajustes);
  } catch (error) {
    logError("Error al listar ajustes pendientes de stock:", error);
    return res.status(500).json({ message: "Error al listar ajustes pendientes de stock" });
  }
});

app.get("/stock/ajustes-pendientes/resumen", async (req, res) => {
  if (!(await puedeGestionarAjustesPendientes(req))) {
    return res.status(403).json({ message: "No tenes permisos para consultar resumen de ajustes pendientes" });
  }

  try {
    const resumen = await getResumenAjustesPendientes();
    return res.json(resumen);
  } catch (error) {
    logError("Error al obtener resumen de ajustes pendientes:", error);
    return res.status(500).json({ message: "Error al obtener resumen de ajustes pendientes" });
  }
});

app.post("/stock/ajustes-pendientes/reconciliar", async (req, res) => {
  if (!(await requirePermiso(req, res, "stock_ver", "No tenes permisos para reconciliar ajustes pendientes"))) return;

  try {
    const puedeGestionar = await puedeGestionarAjustesPendientes(req);
    const ajustes = await reconciliarAjustesPendientes({
      ids: req.body?.ids,
      usuario: req.usuario?.nombre || "",
      puedeGestionar
    });
    return res.json({ ajustes });
  } catch (error) {
    logError("Error al reconciliar ajustes pendientes de stock:", error);
    return res.status(500).json({ message: "Error al reconciliar ajustes pendientes de stock" });
  }
});

app.get("/stock/ajustes-pendientes/:id", async (req, res) => {
  try {
    const ajuste = await obtenerAjustePendiente(req.params.id);
    if (!ajuste) {
      return res.status(404).json({ message: "Ajuste pendiente no encontrado" });
    }

    const esCreador = String(ajuste.solicitado_por || "").trim() === String(req.usuario?.nombre || "").trim();
    if (!(await puedeGestionarAjustesPendientes(req)) && !esCreador) {
      return res.status(403).json({ message: "No tenes permisos para ver este ajuste pendiente" });
    }

    return res.json(ajuste);
  } catch (error) {
    logError("Error al obtener ajuste pendiente de stock:", error);
    return res.status(500).json({ message: "Error al obtener ajuste pendiente de stock" });
  }
});

app.post("/stock/ajustes-pendientes/:id/aprobar", async (req, res) => {
  if (!(await puedeGestionarAjustesPendientes(req))) {
    return res.status(403).json({ message: "No tenes permisos para aprobar ajustes pendientes de stock" });
  }

  try {
    const ajuste = await aprobarAjustePendiente(req.params.id, {
      usuario: req.usuario?.nombre || req.body.usuario || "admin",
      cantidad_aprobada: req.body.cantidad_aprobada,
      tipo_movimiento_aprobado: req.body.tipo_movimiento_aprobado,
      observaciones_admin: req.body.observaciones_admin
    });
    return res.json({ message: "Ajuste aprobado", ajuste });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    logError("Error al aprobar ajuste pendiente de stock:", error);
    return res.status(500).json({ message: "Error al aprobar ajuste pendiente de stock" });
  }
});

app.post("/stock/ajustes-pendientes/:id/rechazar", async (req, res) => {
  if (!(await puedeGestionarAjustesPendientes(req))) {
    return res.status(403).json({ message: "No tenes permisos para rechazar ajustes pendientes de stock" });
  }

  try {
    const ajuste = await rechazarAjustePendiente(req.params.id, {
      usuario: req.usuario?.nombre || req.body.usuario || "admin",
      observaciones_admin: req.body.observaciones_admin
    });
    return res.json({ message: "Ajuste rechazado", ajuste });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    logError("Error al rechazar ajuste pendiente de stock:", error);
    return res.status(500).json({ message: "Error al rechazar ajuste pendiente de stock" });
  }
});

app.post("/stock/ajustes-pendientes/:id/resolver", async (req, res) => {
  if (!(await puedeGestionarAjustesPendientes(req))) {
    return res.status(403).json({ message: "No tenes permisos para resolver ajustes pendientes de stock" });
  }

  try {
    const ajuste = await resolverAjustePendienteConVenta(req.params.id, {
      venta_id: req.body.venta_id,
      tipo_resolucion: req.body.tipo_resolucion,
      usuario: req.usuario?.nombre || req.body.usuario || "admin"
    });
    return res.json({ message: "Ajuste vinculado a venta", ajuste });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    logError("Error al resolver ajuste pendiente de stock:", error);
    return res.status(500).json({ message: "Error al resolver ajuste pendiente de stock" });
  }
});

app.post("/stock/ajustes-pendientes/:id/cuenta-local", async (req, res) => {
  if (!(await puedeGestionarAjustesPendientes(req))) {
    return res.status(403).json({ message: "No tenes permisos para resolver ajustes pendientes de stock" });
  }

  try {
    const ajuste = await resolverAjustePendienteConCuentaLocal(req.params.id, {
      integracion: req.body.integracion,
      responsable: req.body.responsable,
      observacion: req.body.observacion,
      usuario: req.usuario?.nombre || req.body.usuario || "admin"
    });
    return res.json({ message: "Ajuste enviado a Cuenta Local", ajuste });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    logError("Error al resolver ajuste pendiente con Cuenta Local:", error);
    return res.status(500).json({ message: "Error al resolver ajuste pendiente con Cuenta Local" });
  }
});

app.get("/produccion/productos", async (req, res) => {
  if (!(await requirePermiso(req, res, "stock_ver", "No tenes permisos para ver produccion"))) return;

  try {
    return res.json(await listarProductosProducibles());
  } catch (error) {
    logError("Error al listar productos producibles:", error);
    return res.status(500).json({ message: "Error al listar productos producibles" });
  }
});

app.get("/produccion/preview", async (req, res) => {
  if (!(await requirePermiso(req, res, "stock_ver", "No tenes permisos para ver produccion"))) return;

  try {
    const preview = await buildPreviewProduccion({
      producto_id: req.query.producto_id,
      cantidad: req.query.cantidad
    });
    return res.json(preview);
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) logError("Error al previsualizar produccion:", error);
    return res.status(status).json({ message: error.message || "Error al previsualizar produccion" });
  }
});

app.post("/produccion", async (req, res) => {
  if (!(await requirePermiso(req, res, "stock_ajustar", "No tenes permisos para registrar produccion"))) return;

  try {
    const produccion = await registrarProduccion({
      producto_id: req.body.producto_id,
      cantidad_producida: req.body.cantidad_producida,
      responsable: req.body.responsable,
      observacion: req.body.observacion,
      usuario: req.usuario?.nombre || req.body.usuario || "admin"
    });
    return res.status(201).json({ message: "Produccion registrada", produccion });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) logError("Error al registrar produccion:", error);
    return res.status(status).json({ message: error.message || "Error al registrar produccion" });
  }
});

app.get("/produccion", async (req, res) => {
  if (!(await requirePermiso(req, res, "stock_ver", "No tenes permisos para ver produccion"))) return;

  try {
    const producciones = await listarProducciones({
      desde: req.query.desde || null,
      hasta: req.query.hasta || null,
      producto_id: req.query.producto_id || null,
      estado: req.query.estado || null
    });
    return res.json(producciones);
  } catch (error) {
    logError("Error al listar producciones:", error);
    return res.status(500).json({ message: "Error al listar producciones" });
  }
});

app.get("/produccion/:id", async (req, res) => {
  if (!(await requirePermiso(req, res, "stock_ver", "No tenes permisos para ver produccion"))) return;

  try {
    const produccion = await obtenerProduccion(req.params.id);
    if (!produccion) return res.status(404).json({ message: "Produccion no encontrada" });
    return res.json(produccion);
  } catch (error) {
    logError("Error al obtener produccion:", error);
    return res.status(500).json({ message: "Error al obtener produccion" });
  }
});

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
              cc.nombre AS cuenta_cobro_nombre,
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
       LEFT JOIN cuentas_cobro cc ON cc.id = p.cuenta_cobro_id
       ORDER BY p.fecha DESC, p.hora DESC, p.id DESC`
    );

    return res.json(pagos);
  } catch (error) {
    logError("Error al listar pagos:", error);
    return res.status(500).json({ message: "Error al obtener pagos" });
  }
});

app.get("/tipos_pago", async (req, res) => {
  try {
    const todos = req.query.todos === "1";
    return res.json(todos ? await getTodosTiposPago() : await getTiposPagoActivos());
  } catch (error) {
    logError("Error al listar tipos de pago:", error);
    return res.status(500).json({ message: "Error al obtener tipos de pago" });
  }
});

app.get("/cuentas_cobro", async (req, res) => {
  try {
    return res.json(await getCuentasCobro({ todos: req.query.todos === "1" }));
  } catch (error) {
    logError("Error al listar cuentas de cobro:", error);
    return res.status(500).json({ message: "Error al obtener cuentas de cobro" });
  }
});

app.get("/cuentas_cobro/tipo/:codigo", async (req, res) => {
  try {
    return res.json(await getCuentasCobroPorTipo(req.params.codigo));
  } catch (error) {
    logError("Error al listar cuentas de cobro por tipo:", error);
    return res.status(500).json({ message: "Error al obtener cuentas de cobro" });
  }
});

app.get("/cuentas_destino", async (req, res) => {
  try {
    return res.json(await listarCuentasDestino({ todos: req.query.todos === "1" }));
  } catch (error) {
    logError("Error al listar cuentas destino:", error);
    return res.status(500).json({ message: "Error al obtener cuentas destino" });
  }
});

app.get("/cuentas_destino/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: "ID invalido" });
  try {
    const cuenta = await obtenerCuentaDestino(id);
    if (!cuenta) return res.status(404).json({ message: "Cuenta destino no encontrada" });
    return res.json(cuenta);
  } catch (error) {
    logError("Error al obtener cuenta destino:", error);
    return res.status(500).json({ message: "Error al obtener cuenta destino" });
  }
});

app.post("/cuentas_destino", async (req, res) => {
  try {
    const cuenta = await crearCuentaDestino(req.body);
    return res.json({ message: "Cuenta destino creada", cuenta });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    logError("Error al crear cuenta destino:", error);
    return res.status(500).json({ message: "Error al crear cuenta destino" });
  }
});

app.put("/cuentas_destino/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: "ID invalido" });
  try {
    const cuenta = await actualizarCuentaDestino(id, req.body);
    if (!cuenta) return res.status(404).json({ message: "Cuenta destino no encontrada" });
    return res.json({ message: "Cuenta destino actualizada", cuenta });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    logError("Error al actualizar cuenta destino:", error);
    return res.status(500).json({ message: "Error al actualizar cuenta destino" });
  }
});

app.patch("/cuentas_destino/:id/activo", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: "ID invalido" });
  try {
    const cuenta = await setActivoCuentaDestino(id, req.body.activo);
    if (!cuenta) return res.status(404).json({ message: "Cuenta destino no encontrada" });
    return res.json({ message: Number(cuenta.activo) === 1 ? "Cuenta destino activada" : "Cuenta destino desactivada", cuenta });
  } catch (error) {
    logError("Error al cambiar estado de cuenta destino:", error);
    return res.status(500).json({ message: "Error al cambiar estado" });
  }
});

app.delete("/cuentas_destino/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: "ID invalido" });
  try {
    const result = await eliminarCuentaDestino(id);
    return res.json(result);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    logError("Error al eliminar cuenta destino:", error);
    return res.status(500).json({ message: "Error al eliminar cuenta destino" });
  }
});

app.post("/cuentas_cobro", async (req, res) => {
  try {
    const cuenta = await crearCuentaCobro(req.body);
    return res.json({ message: "Cuenta de cobro creada", cuenta });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    logError("Error al crear cuenta de cobro:", error);
    return res.status(500).json({ message: "Error al crear cuenta de cobro" });
  }
});

app.put("/cuentas_cobro/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: "ID invalido" });

  try {
    const cuenta = await actualizarCuentaCobro(id, req.body);
    if (!cuenta) return res.status(404).json({ message: "Cuenta de cobro no encontrada" });
    return res.json({ message: "Cuenta de cobro actualizada", cuenta });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    logError("Error al actualizar cuenta de cobro:", error);
    return res.status(500).json({ message: "Error al actualizar cuenta de cobro" });
  }
});

app.patch("/cuentas_cobro/:id/activo", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: "ID invalido" });

  try {
    const cuenta = await toggleActivoCuentaCobro(id, req.body.activo);
    if (!cuenta) return res.status(404).json({ message: "Cuenta de cobro no encontrada" });
    return res.json({ message: Number(cuenta.activo) === 1 ? "Cuenta activada" : "Cuenta desactivada", cuenta });
  } catch (error) {
    logError("Error al cambiar estado de cuenta de cobro:", error);
    return res.status(500).json({ message: "Error al cambiar estado" });
  }
});

app.delete("/cuentas_cobro/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: "ID invalido" });
  try {
    const cuenta = await getQuery("SELECT id FROM cuentas_cobro WHERE id = ?", [id]);
    if (!cuenta) return res.status(404).json({ message: "Canal no encontrado" });
    const uso = await getQuery(
      `SELECT
        (SELECT COUNT(*) FROM venta_cobros                WHERE cuenta_cobro_id = ?) +
        (SELECT COUNT(*) FROM ventas                      WHERE cuenta_cobro_id = ?) +
        (SELECT COUNT(*) FROM pagos                       WHERE cuenta_cobro_id = ?) +
        (SELECT COUNT(*) FROM conciliaciones_cuentas_cobro WHERE cuenta_cobro_id = ?) +
        (SELECT COUNT(*) FROM pagos_cc_cobros             WHERE cuenta_cobro_id = ?) AS total`,
      [id, id, id, id, id]
    );
    if (Number(uso?.total || 0) > 0) {
      await runQuery("UPDATE cuentas_cobro SET activo = 0, updated_at = datetime('now') WHERE id = ?", [id]);
      return res.json({ message: "La cuenta tiene movimientos. Se desactivó para conservar el historial.", desactivado: true });
    }
    await runQuery("DELETE FROM cuentas_cobro WHERE id = ?", [id]);
    return res.json({ message: "Canal eliminado", eliminado: true });
  } catch (error) {
    logError("Error al eliminar cuenta de cobro:", error);
    return res.status(500).json({ message: "Error al eliminar canal" });
  }
});

app.post("/integraciones/mercadopago-point/intentos", async (req, res) => {
  try {
    const intento = await crearIntentoPoint({
      cuenta_cobro_id: req.body?.cuenta_cobro_id,
      monto_total: req.body?.monto_total,
      venta_id: req.body?.venta_id
    });
    return res.json({ message: "Intento Mercado Pago Point creado", intento });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    logError("Error al crear intento Mercado Pago Point:", error);
    return res.status(500).json({ message: "Error al crear intento Mercado Pago Point" });
  }
});

app.get("/integraciones/mercadopago-point/intentos", async (req, res) => {
  try {
    return res.json(await listarIntentosPoint({ estado: req.query.estado }));
  } catch (error) {
    logError("Error al listar intentos Mercado Pago Point:", error);
    return res.status(500).json({ message: "Error al listar intentos Mercado Pago Point" });
  }
});

app.get("/integraciones/mercadopago-point/intentos/:id", async (req, res) => {
  try {
    const intento = await obtenerIntentoPoint(req.params.id);
    if (!intento) return res.status(404).json({ message: "Intento Mercado Pago Point no encontrado" });
    return res.json(intento);
  } catch (error) {
    logError("Error al obtener intento Mercado Pago Point:", error);
    return res.status(500).json({ message: "Error al obtener intento Mercado Pago Point" });
  }
});

app.get("/integraciones/mercadopago-point/debug/terminales", async (req, res) => {
  if (!puedeRol(req, ROLES.ADMIN))
    return res.status(403).json({ message: "No tenes permisos para usar herramientas de diagnóstico." });
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!token || !token.trim()) {
    return res.json({
      ok: false,
      origen: "config",
      message: "MERCADOPAGO_ACCESS_TOKEN no configurado. Creá un archivo .env en la raíz del proyecto con esa variable."
    });
  }
  try {
    const store_id = String(req.query.store_id || "").trim() || undefined;
    const pos_id = String(req.query.pos_id || "").trim() || undefined;
    const resultado = await listarTerminalesPoint(token.trim(), { store_id, pos_id });
    return res.json({ ok: true, ...resultado });
  } catch (error) {
    logError("Error diagnóstico terminales MP Point:", error);
    return res.json({
      ok: false,
      origen: "mercadopago",
      message: error.message || "Error al consultar terminales Mercado Pago Point"
    });
  }
});

app.post("/integraciones/mercadopago-point/debug/test-orden", async (req, res) => {
  if (!puedeRol(req, ROLES.ADMIN))
    return res.status(403).json({ message: "No tenes permisos para usar herramientas de diagnóstico." });
  res.setHeader("Content-Type", "application/json");
  try {
    const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
    if (!token || !token.trim()) {
      return res.json({ ok: false, origen: "config", message: "MERCADOPAGO_ACCESS_TOKEN no configurado en .env" });
    }
    const terminal_id = String(req.body?.terminal_id || "").trim();
    if (!terminal_id) {
      return res.json({ ok: false, origen: "validacion", message: "terminal_id es requerido" });
    }
    const monto = Number(req.body?.monto || 0);
    if (monto <= 0) {
      return res.json({ ok: false, origen: "validacion", message: "monto debe ser mayor a 0" });
    }
    const store_id = String(req.body?.store_id || "").trim() || undefined;
    const pos_id = String(req.body?.pos_id || "").trim() || undefined;
    const resultado = await crearOrdenPointDiagnostico(token.trim(), { terminal_id, monto, store_id, pos_id });
    return res.json({ ok: true, ...resultado });
  } catch (error) {
    logError("Error diagnóstico orden MP Point:", error);
    return res.json({ ok: false, origen: "server", message: error.message || "Error al crear orden de diagnóstico" });
  }
});

app.post("/tipos_pago", async (req, res) => {
  const nombre = String(req.body.nombre || "").trim();
  const codigo = String(req.body.codigo || "").trim().toLowerCase().replace(/\s+/g, "_");
  const orden = Number(req.body.orden) || 50;

  if (!nombre) return res.status(400).json({ message: "El nombre es obligatorio" });
  if (!codigo) return res.status(400).json({ message: "El código es obligatorio" });
  if (!/^[a-z0-9_]+$/.test(codigo)) return res.status(400).json({ message: "El código solo puede tener letras, números y guiones bajos" });

  try {
    await crearTipoPago({
      codigo,
      nombre,
      orden,
      usa_recargo: req.body.usa_recargo,
      porcentaje_recargo: req.body.porcentaje_recargo,
      permite_cuotas: req.body.permite_cuotas,
      cuotas_json: req.body.cuotas_json
    });
    return res.json({ message: "Tipo de pago creado" });
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      return res.status(400).json({ message: `Ya existe un tipo con código '${codigo}'` });
    }
    logError("Error al crear tipo de pago:", error);
    return res.status(500).json({ message: "Error al crear tipo de pago" });
  }
});

app.put("/tipos_pago/:id", async (req, res) => {
  const id = Number(req.params.id);
  const nombre = String(req.body.nombre || "").trim();
  const orden = Number(req.body.orden) || 0;

  if (!id) return res.status(400).json({ message: "ID inválido" });
  if (!nombre) return res.status(400).json({ message: "El nombre es obligatorio" });

  try {
    await actualizarTipoPago(id, {
      nombre,
      orden,
      usa_recargo: req.body.usa_recargo,
      porcentaje_recargo: req.body.porcentaje_recargo,
      permite_cuotas: req.body.permite_cuotas,
      cuotas_json: req.body.cuotas_json
    });
    return res.json({ message: "Tipo de pago actualizado" });
  } catch (error) {
    logError("Error al actualizar tipo de pago:", error);
    return res.status(500).json({ message: "Error al actualizar tipo de pago" });
  }
});

app.patch("/tipos_pago/:id/activo", async (req, res) => {
  const id = Number(req.params.id);
  const activo = req.body.activo !== false && req.body.activo !== 0 && req.body.activo !== "0";

  if (!id) return res.status(400).json({ message: "ID inválido" });

  try {
    await toggleActivoTipoPago(id, activo);
    return res.json({ message: activo ? "Tipo activado" : "Tipo desactivado" });
  } catch (error) {
    logError("Error al cambiar estado de tipo de pago:", error);
    return res.status(500).json({ message: "Error al cambiar estado" });
  }
});

app.delete("/tipos_pago/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ message: "ID inválido" });

  const CODIGOS_DEFAULT = new Set(["efectivo", "debito", "transferencia", "mixto"]);

  try {
    const tipo = await getQuery("SELECT id, codigo, nombre FROM tipos_pago WHERE id = ?", [id]);
    if (!tipo) return res.status(404).json({ message: "Tipo de pago no encontrado" });

    if (CODIGOS_DEFAULT.has(tipo.codigo)) {
      return res.status(400).json({ message: `"${tipo.nombre}" es un método predeterminado del sistema y no puede eliminarse` });
    }

    const enUso = await getQuery("SELECT id FROM pagos WHERE tipo_pago = ? LIMIT 1", [tipo.codigo]);
    if (enUso) {
      return res.status(400).json({ message: `No se puede eliminar: hay pagos registrados con el método "${tipo.nombre}"` });
    }

    await eliminarTipoPago(id);
    return res.json({ message: `Tipo de pago "${tipo.nombre}" eliminado` });
  } catch (error) {
    logError("Error al eliminar tipo de pago:", error);
    return res.status(500).json({ message: "Error al eliminar tipo de pago" });
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
  const cuentaCobroId = req.body.cuenta_cobro_id ?? null;
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

  const cobro = resolvePagoData(
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
    const cuentaCobro = await validarCuentaCobroPago(cuentaCobroId, cobro, { estado: estadoPago });

    if (!cuentaCobro.ok) {
      return res.status(cuentaCobro.statusCode || 400).json({ message: cuentaCobro.message });
    }

    if (requiereCaja && !cajaActiva) {
      return res.status(400).json({ message: "No hay una caja abierta para registrar el pago" });
    }

    const result = await runQuery(
      `INSERT INTO pagos
      (proveedor_id, concepto, monto_total, tipo_pago, monto_efectivo, monto_debito, fecha, hora, estado, caja_id,
       categoria_pago, comprobante, numero_comprobante, cuenta_destino, referencia, observaciones, es_cuenta_corriente, iva_credito_fiscal, cuenta_cobro_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        ivaCreditoFiscal,
        cuentaCobro.cuenta_cobro_id
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
          categoria_pago, comprobante, numero_comprobante, cuenta_destino, observaciones, cuenta_cobro_id } = req.body;

  const claveConfig = await getClaveAutorizacion();
  if (!requerirClaveConfigurada(claveConfig, res)) return;
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

    const tipoPagoFinal = String(tipo_pago ?? pago.tipo_pago ?? "").trim().toLowerCase();
    let cuentaCobroFinal = pago.cuenta_cobro_id ?? null;
    if (Object.prototype.hasOwnProperty.call(req.body, "cuenta_cobro_id")) {
      const cuentaCobro = await validarCuentaCobroPago(cuenta_cobro_id, {
        tipo_cobro: tipoPagoFinal,
        monto_debito: monto_debito != null ? Number(monto_debito) : Number(pago.monto_debito) || 0
      }, { estado: pago.estado });
      if (!cuentaCobro.ok) {
        return res.status(cuentaCobro.statusCode || 400).json({ message: cuentaCobro.message });
      }
      cuentaCobroFinal = cuentaCobro.cuenta_cobro_id;
    } else if (cuentaCobroFinal) {
      const cuentaCobro = await validarCuentaCobroPago(cuentaCobroFinal, {
        tipo_cobro: tipoPagoFinal,
        monto_debito: monto_debito != null ? Number(monto_debito) : Number(pago.monto_debito) || 0
      }, { estado: pago.estado });
      if (!cuentaCobro.ok) {
        return res.status(cuentaCobro.statusCode || 400).json({ message: cuentaCobro.message });
      }
    }

    // Preservar valores originales para campos NOT NULL que no se editan en el form
    await runQuery(
      `UPDATE pagos SET concepto=?, monto_total=?, tipo_pago=?, monto_efectivo=?, monto_debito=?,
       categoria_pago=?, comprobante=?, numero_comprobante=?, cuenta_destino=?, observaciones=?, cuenta_cobro_id=? WHERE id = ?`,
      [
        concepto ?? pago.concepto,
        Number(monto_total) || Number(pago.monto_total) || 0,
        tipoPagoFinal || pago.tipo_pago,
        monto_efectivo != null ? Number(monto_efectivo) : Number(pago.monto_efectivo) || 0,
        monto_debito != null ? Number(monto_debito) : Number(pago.monto_debito) || 0,
        categoria_pago ?? pago.categoria_pago ?? null,
        comprobante ?? pago.comprobante ?? null,
        numero_comprobante ?? pago.numero_comprobante ?? null,
        cuenta_destino ?? pago.cuenta_destino ?? null,
        observaciones ?? pago.observaciones ?? null,
        cuentaCobroFinal,
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
  if (!requerirClaveConfigurada(claveConfig, res)) return;
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

app.post("/ventas/test-modificadores", async (req, res) => {
  const itemEntrada = Array.isArray(req.body.items) ? req.body.items[0] : req.body.item;
  if (!itemEntrada) {
    return res.status(400).json({ message: "Item de prueba requerido" });
  }

  try {
    const producto = itemEntrada.producto_id
      ? await getQuery("SELECT id, nombre, precio_venta FROM productos WHERE id = ?", [itemEntrada.producto_id])
      : null;
    if (!producto) {
      return res.status(400).json({ message: "Producto invalido para prueba de modificadores" });
    }

    const itemResuelto = await resolverComposicionItemVenta({
      producto_id: producto.id,
      nombre_producto: itemEntrada.nombre_producto || producto.nombre,
      cantidad: Number(itemEntrada.cantidad || 1),
      precio_unitario: Number(itemEntrada.precio_unitario ?? producto.precio_venta ?? 0),
      modificadores: Array.isArray(itemEntrada.modificadores) ? itemEntrada.modificadores : []
    });

    if (!itemResuelto.nombre_producto || Number(itemResuelto.cantidad || 0) <= 0) {
      return res.status(400).json({ message: "Item de prueba invalido" });
    }

    const total = Number((Number(itemResuelto.cantidad || 0) * Number(itemResuelto.precio_unitario || 0)).toFixed(2));
    const { fecha, hora } = getNowParts();

    await runQuery("BEGIN TRANSACTION");
    const venta = await runQuery(
      `INSERT INTO ventas
       (fecha, hora, usuario, total, tipo, estado, identificador_pendiente, metodo_pago, tipo_cobro,
        monto_efectivo, monto_debito, cliente_id, es_cuenta_corriente, saldo_pendiente, caja_id, cuenta_cobro_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fecha,
        hora,
        req.body.usuario || "test",
        total,
        "test_modificadores",
        "anulado",
        "TEST modificadores",
        null,
        null,
        0,
        0,
        null,
        0,
        0,
        null,
        null
      ]
    );

    const detalle = await runQuery(
      `INSERT INTO detalle_ventas
       (venta_id, producto_id, nombre_producto, cantidad, precio_unitario, subtotal)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        venta.lastID,
        itemResuelto.producto_id,
        itemResuelto.nombre_producto,
        itemResuelto.cantidad,
        itemResuelto.precio_unitario,
        total
      ]
    );

    await guardarModificadoresDetalleVenta(detalle.lastID, itemResuelto.modificadores);
    await guardarComponentesSnapshot(detalle.lastID, itemResuelto.componentes);
    await runQuery("COMMIT");

    return res.json({
      message: "Venta test de modificadores registrada",
      venta_id: venta.lastID,
      detalle_venta_id: detalle.lastID,
      item: itemResuelto,
      total,
      stock_delta: getStockDeltaVentaItem(itemResuelto)
    });
  } catch (error) {
    try { await runQuery("ROLLBACK"); } catch {}
    logError("Error en venta test de modificadores:", error);
    return res.status(500).json({ message: "Error en venta test de modificadores" });
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
    cuotas
  } = req.body;
  // Cobros V2: si viene cobros[], normalizar y derivar campos legacy
  let cobrosV2Normalizados = null;
  let tipo_cobro = req.body.tipo_cobro;
  let monto_efectivo = req.body.monto_efectivo;
  let monto_debito = req.body.monto_debito;
  let cuenta_cobro_id = req.body.cuenta_cobro_id;
  if (Array.isArray(req.body.cobros) && req.body.cobros.length > 0) {
    const resultado = normalizarCobrosV2(req.body.cobros);
    if (resultado && resultado.error) return res.status(400).json({ message: resultado.error });
    cobrosV2Normalizados = resultado;
    const legacy = derivarCobroLegacy(cobrosV2Normalizados);
    tipo_cobro = legacy.tipo_cobro;
    monto_efectivo = legacy.monto_efectivo;
    monto_debito = legacy.monto_debito;
    cuenta_cobro_id = legacy.cuenta_cobro_id;
  }

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
  let itemsVenta = itemsNormalizados;
  const hayModificadores = tieneModificadoresVenta(itemsNormalizados);

  if (hayModificadores && (!["normal", "pendiente"].includes(tipoVenta) || esCuentaCorriente)) {
    return res.status(400).json({ message: "Los modificadores solo estan habilitados para ventas normales o pendientes nuevas" });
  }

  if (hayModificadores) {
    try {
      itemsVenta = await resolverItemsVentaNormalConModificadores(itemsNormalizados);
    } catch (error) {
      return res.status(error.statusCode || 400).json({ message: error.message || "Modificadores invalidos" });
    }
  }

  const estadoVenta = tipoVenta === "pendiente"
    ? "pendiente"
    : esCuentaCorriente
      ? "cuenta_corriente_pendiente"
      : "cobrada";
  const subtotalVenta = Number(calculateTotal(itemsVenta).toFixed(2));
  let total = subtotalVenta;
  let recargoVenta = {
    porcentaje_recargo: 0,
    recargo_monto: 0,
    cuotas: null,
    total
  };

  if (tipoVenta === "normal" && !esCuentaCorriente) {
    let recargo;
    if (cobrosV2Normalizados && tipo_cobro === "mixto") {
      recargo = { ok: true, porcentaje_recargo: 0, recargo_monto: 0, cuotas: null, total: subtotalVenta };
    } else {
      recargo = await calcularRecargoTipoPago({ tipoPagoCodigo: tipo_cobro, subtotal: subtotalVenta, cuotas });
      if (!recargo.ok) {
        return res.status(400).json({ message: recargo.message || "Metodo de cobro invalido" });
      }
    }
    recargoVenta = recargo;
    total = recargo.total;
  }

  const { fecha, hora } = getNowParts();
  const usuarioVenta = getUsuarioAuditoria(req, usuario || "admin");
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

  let cuentaCobroVenta = { cuenta_cobro_id: null };
  if (tipoVenta === "normal" && !esCuentaCorriente && !(cobrosV2Normalizados && tipo_cobro === "mixto")) {
    cuentaCobroVenta = await validarCuentaCobroVenta(cuenta_cobro_id, cobro);
    if (!cuentaCobroVenta.ok) {
      return res.status(cuentaCobroVenta.statusCode || 400).json({ message: cuentaCobroVenta.message });
    }
  }

  if (esCuentaCorriente && !clienteId) {
    return res.status(400).json({ message: "La cuenta corriente requiere cliente asociado" });
  }

  if (esCuentaCorriente && clienteId) {
    const clienteCC = await getClienteConMetricas(clienteId);
    if (!clienteCC || Number(clienteCC.activo) !== 1) {
      return res.status(404).json({ message: "Cliente activo no encontrado" });
    }
    if (Number(clienteCC.habilita_cuenta_corriente) !== 1) {
      return res.status(400).json({ message: "Este cliente no tiene cuenta corriente habilitada" });
    }
    const configCC = await getConfiguracionGlobal();
    const reglasCC = resolverReglasCuenta(clienteCC, configCC);
    if (
      Number(clienteCC.suspendido) !== 1 &&
      Number(clienteCC.deuda_actual || 0) > 0 &&
      Boolean(configCC.cuentas_desactivar_por_vencimiento) &&
      clienteCC.primera_deuda
    ) {
      const { fecha: hoyCC } = getNowParts();
      const diasDesdeCC = Math.floor((new Date(hoyCC) - new Date(clienteCC.primera_deuda)) / 86400000);
      if (diasDesdeCC >= reglasCC.dias_vencimiento) {
        await runQuery("UPDATE clientes SET suspendido = 1 WHERE id = ? AND suspendido = 0", [clienteId]);
        clienteCC.suspendido = 1;
      }
    }
    if (Number(clienteCC.suspendido) === 1) {
      return res.status(403).json({ message: "Cliente suspendido: solo se permiten cobros" });
    }
    if (reglasCC.requiere_autorizacion === 1 && !["admin", "encargado"].includes(req.usuario?.rol)) {
      return res.status(403).json({ message: "Esta cuenta requiere autorización de encargado o admin" });
    }
    const subtotalCC = Number(calculateTotal(itemsNormalizados).toFixed(2));
    const deudaProyectadaCC = Number(clienteCC.deuda_actual || 0) + subtotalCC;
    if (reglasCC.limite_fiado > 0 && deudaProyectadaCC > reglasCC.limite_fiado) {
      const autorizarExcedidoCC = Boolean(req.body.autorizar_excedido);
      if (reglasCC.permite_excedente !== 1 && !autorizarExcedidoCC) {
        return res.status(409).json({ message: "La venta excede el limite de credito del cliente" });
      }
    }
  }

  if (!esCuentaCorriente && clienteId) {
    const clienteSimple = await getQuery(
      "SELECT id FROM clientes WHERE id = ? AND activo = 1",
      [clienteId]
    );
    if (!clienteSimple) {
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
      (fecha, hora, usuario, total, tipo, estado, identificador_pendiente, metodo_pago, tipo_cobro, monto_efectivo, monto_debito, cliente_id, es_cuenta_corriente, saldo_pendiente, caja_id, cuenta_cobro_id, recargo_porcentaje, recargo_monto)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fecha,
        hora,
        usuarioVenta,
        subtotalVenta,
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
        tipoVenta === "normal" ? cajaActiva.id : null,
        cuentaCobroVenta.cuenta_cobro_id,
        recargoVenta.porcentaje_recargo,
        recargoVenta.recargo_monto
      ]
    );

    const detalles = await replaceVentaDetalle(venta.lastID, itemsVenta);
    if (hayModificadores) {
      await guardarSnapshotsModificadoresVenta(detalles);
    }
    await applyStockForNewItems(itemsVenta);
    try {
      const prodIdsVenta = [...new Set(itemsVenta.map((i) => Number(i.producto_id)).filter(Boolean))];
      for (const pid of prodIdsVenta) {
        const prodFinal = await getQuery("SELECT id, stock FROM productos WHERE id = ?", [pid]);
        if (prodFinal && Number(prodFinal.stock) < 0) {
          await crearAjustePendienteStockNegativo({
            productoId: pid,
            cantidad: Math.abs(Number(prodFinal.stock)),
            ventaId: venta.lastID,
            stockNuevo: Number(prodFinal.stock),
            usuario: getUsuarioAuditoria(req, usuarioVenta)
          });
        }
      }
    } catch (stockNegativoError) {
      logError("Error al crear ajuste por stock negativo:", stockNegativoError);
    }
    await crearAjustesPendientesVentaReceta({
      ventaId: venta.lastID,
      detalles,
      usuario: getUsuarioAuditoria(req, usuarioVenta),
      rol: req.usuario?.rol
    });
    await guardarRecetaSnapshotVenta(venta.lastID, detalles);
    if (hayModificadores) {
      await aplicarStockComponentesSnapshot(await filtrarDetallesConStockFisico(detalles), 1);
    }
    if (tipoVenta === "normal" && !esCuentaCorriente && (cobrosV2Normalizados || cobro?.tipo_cobro)) {
      await registrarVentaCobros(venta.lastID, cobro, cuentaCobroVenta.cuenta_cobro_id, `${fecha} ${hora}`, cobrosV2Normalizados);
    }

    await runQuery("COMMIT");

    return res.json({
      message: tipoVenta === "pendiente" ? "Ticket pendiente guardado" : "Venta registrada",
      venta_id: venta.lastID,
      subtotal: subtotalVenta,
      recargo_porcentaje: recargoVenta.porcentaje_recargo,
      recargo_monto: recargoVenta.recargo_monto,
      cuotas: recargoVenta.cuotas,
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

// CC3B-G1: estado de cuenta imprimible — solo lectura, no escribe DB
app.get("/clientes/:id/estado-cuenta", async (req, res) => {
  const clienteId = Number(req.params.id);

  try {
    const clienteRaw = await getClienteConMetricas(clienteId);
    if (!clienteRaw) return res.status(404).json({ message: "Cliente no encontrado" });

    const config = await getConfiguracionGlobal();
    const comercio = {
      nombre:       String(config.negocio_nombre_comercial || config.ticket_nombre || "Atlas OS"),
      razon_social: config.negocio_razon_social || null,
      cuit:         config.negocio_cuit         || null,
      direccion:    config.negocio_direccion     || null,
      telefono:     config.negocio_telefono      || null,
    };

    const ahora = await getQuery(
      "SELECT date('now', 'localtime') AS fecha, time('now', 'localtime') AS hora"
    );
    const emision = { fecha: ahora?.fecha || null, hora: ahora?.hora || null };

    const deudaActual       = Number(clienteRaw.deuda_actual  || 0);
    const limiteFiado       = Number(clienteRaw.limite_fiado  || 0);
    const creditoUtilizado  = deudaActual;
    const creditoDisponible = Math.max(0, limiteFiado - deudaActual);

    const cliente = {
      id:                        clienteRaw.id,
      nombre:                    clienteRaw.nombre,
      dni_cuit:                  clienteRaw.dni_cuit               || null,
      telefono:                  clienteRaw.telefono               || null,
      tipo_cliente:              clienteRaw.tipo_cliente            || null,
      tipo_cuenta_corriente:     clienteRaw.tipo_cuenta_corriente  || "normal",
      limite_fiado:              limiteFiado,
      deuda_actual:              deudaActual,
      observaciones:             clienteRaw.observaciones          || null,
      notas:                     clienteRaw.notas                  || null,
      habilita_cuenta_corriente: Number(clienteRaw.habilita_cuenta_corriente || 0),
      credito_utilizado:         Number(creditoUtilizado.toFixed(2)),
      credito_disponible:        Number(creditoDisponible.toFixed(2)),
    };

    const ventas = await allQuery(
      `SELECT id, fecha, hora, total AS importe
       FROM ventas
       WHERE cliente_id = ? AND es_cuenta_corriente = 1
         AND COALESCE(estado, '') != 'anulado'
       ORDER BY fecha ASC, hora ASC, id ASC`,
      [clienteId]
    );

    const pagos = await allQuery(
      `SELECT id, fecha, hora, monto_pagado AS importe,
              tipo_movimiento, group_id, numero_comprobante,
              usuario_nombre, observacion
       FROM pagos_cuenta_corriente
       WHERE cliente_id = ?
       ORDER BY fecha ASC, hora ASC, id ASC`,
      [clienteId]
    );

    const recalculos = await allQuery(
      `SELECT id, fecha, hora, diferencia AS importe, usuario, motivo
       FROM recalculos_cuenta_corriente
       WHERE cliente_id = ?
       ORDER BY fecha ASC, hora ASC, id ASC`,
      [clienteId]
    );

    const raw = [
      ...ventas.map(r    => ({ ...r, _src: "venta"    })),
      ...pagos.map(r     => ({ ...r, _src: r.tipo_movimiento || "cobro" })),
      ...recalculos.map(r => ({ ...r, _src: "recalculo" })),
    ].sort((a, b) => {
      const ts = `${a.fecha} ${a.hora}`.localeCompare(`${b.fecha} ${b.hora}`);
      if (ts !== 0) return ts;
      const orden = { venta: 0, cobro: 1, reversa: 2, recalculo: 3 };
      const oa = orden[a._src] ?? 4;
      const ob = orden[b._src] ?? 4;
      if (oa !== ob) return oa - ob;
      return a.id - b.id;
    });

    let saldo = 0;
    let total_vendido = 0;
    let total_cobrado = 0;
    let total_ajustes = 0;

    const movimientos = raw.map(r => {
      const tipo    = r._src;
      const importe = Number(r.importe || 0);
      let debe = 0, haber = 0, descripcion = "", usuario = null, observacion = null;

      if (tipo === "venta") {
        debe           = Number(importe.toFixed(2));
        saldo         += importe;
        total_vendido += importe;
        descripcion    = `Venta CC #${r.id}`;

      } else if (tipo === "cobro") {
        haber          = Number(importe.toFixed(2));
        saldo         -= importe;
        total_cobrado += importe;
        descripcion    = "Cobro CC";
        usuario        = r.usuario_nombre || null;
        observacion    = r.observacion    || null;

      } else if (tipo === "reversa") {
        // monto_pagado almacenado como negativo; debe muestra valor absoluto
        debe        = Number(Math.abs(importe).toFixed(2));
        saldo      += Math.abs(importe);
        descripcion = "Reversa de cobro";
        usuario     = r.usuario_nombre || null;
        observacion = r.observacion    || null;

      } else if (tipo === "recalculo") {
        if (importe > 0) {
          debe  = Number(importe.toFixed(2));
        } else {
          haber = Number(Math.abs(importe).toFixed(2));
        }
        saldo         += importe;
        total_ajustes += importe;
        descripcion    = "Recalculo de deuda";
        usuario        = r.usuario  || null;
        observacion    = r.motivo   || null;
      }

      return {
        tipo,
        fecha:              r.fecha              || null,
        hora:               r.hora               || null,
        descripcion,
        debe,
        haber,
        saldo_acumulado:    Number(saldo.toFixed(2)),
        usuario,
        observacion,
        numero_comprobante: r.numero_comprobante || null,
        group_id:           r.group_id           || null,
      };
    });

    const totales = {
      total_vendido:   Number(total_vendido.toFixed(2)),
      total_cobrado:   Number(total_cobrado.toFixed(2)),
      total_ajustes:   Number(total_ajustes.toFixed(2)),
      saldo_pendiente: Number(deudaActual.toFixed(2)),
    };

    return res.json({ comercio, cliente, emision, movimientos, totales });

  } catch (error) {
    logError("Error al generar estado de cuenta CC:", error);
    return res.status(500).json({ message: "Error al generar estado de cuenta" });
  }
});

// CC3B: historial de cobros CC agrupado por group_id
app.get("/clientes/:id/cobros-cc", async (req, res) => {
  const clienteId = Number(req.params.id);
  try {
    const cliente = await getQuery("SELECT id FROM clientes WHERE id = ?", [clienteId]);
    if (!cliente) {
      return res.status(404).json({ message: "Cliente no encontrado" });
    }

    // Grupos V2 (con group_id) — incluye CC3A, CC3B-A, CC3B-E2 (cobros y reversas)
    const grupos = await allQuery(
      `SELECT group_id,
              MIN(fecha) AS fecha, MIN(hora) AS hora, MIN(id) AS min_id,
              SUM(monto_pagado) AS monto_total,
              COUNT(DISTINCT venta_id) AS cantidad_ventas,
              MAX(numero_comprobante) AS numero_comprobante,
              MAX(usuario_id) AS usuario_id,
              MAX(usuario_nombre) AS usuario_nombre,
              MAX(observacion) AS observacion,
              MAX(tipo_movimiento)        AS tipo_movimiento,
              MAX(revertido)              AS revertido,
              MAX(reversa_de_group_id)    AS reversa_de_group_id,
              MAX(motivo_reversa)         AS motivo_reversa,
              MAX(usuario_reversa_id)     AS usuario_reversa_id,
              MAX(usuario_reversa_nombre) AS usuario_reversa_nombre,
              MAX(fecha_reversa)          AS fecha_reversa,
              MAX(hora_reversa)           AS hora_reversa
       FROM pagos_cuenta_corriente
       WHERE cliente_id = ? AND group_id IS NOT NULL
       GROUP BY group_id
       ORDER BY MIN(fecha) DESC, MIN(hora) DESC, MIN(id) DESC`,
      [clienteId]
    );

    // Filas legacy (sin group_id, anteriores a CC3A)
    const legacy = await allQuery(
      `SELECT id, fecha, hora, monto_pagado, venta_id, tipo_cobro
       FROM pagos_cuenta_corriente
       WHERE cliente_id = ? AND group_id IS NULL
       ORDER BY fecha DESC, hora DESC, id DESC`,
      [clienteId]
    );

    const resultado = [];

    for (const g of grupos) {
      const ventasAfectadas = await allQuery(
        `SELECT venta_id, monto_pagado
         FROM pagos_cuenta_corriente
         WHERE cliente_id = ? AND group_id = ?
         ORDER BY id ASC`,
        [clienteId, g.group_id]
      );
      const canales = await allQuery(
        `SELECT tipo_cobro, cuenta_cobro_id,
                cuenta_cobro_nombre_snapshot, cuenta_cobro_tipo_pago_snapshot,
                cuenta_destino_id_snapshot, cuenta_destino_nombre_snapshot, monto
         FROM pagos_cc_cobros
         WHERE group_id = ?
         ORDER BY id ASC`,
        [g.group_id]
      );
      const tm = g.tipo_movimiento || "cobro";
      const revertido = Number(g.revertido || 0);
      const estadoAuditoria = tm === "reversa" ? "reversa"
                            : revertido === 1   ? "revertido"
                            :                     "cobro";

      resultado.push({
        group_id: g.group_id,
        numero_comprobante: g.numero_comprobante || null,
        fecha: g.fecha,
        hora: g.hora,
        cliente_id: clienteId,
        usuario_id: g.usuario_id || null,
        usuario_nombre: g.usuario_nombre || null,
        observacion: g.observacion || null,
        monto_total: Number(Number(g.monto_total).toFixed(2)),
        cantidad_ventas_afectadas: Number(g.cantidad_ventas || 0),
        ventas_afectadas: ventasAfectadas.map(v => ({
          venta_id: v.venta_id,
          monto_pagado: Number(Number(v.monto_pagado).toFixed(2))
        })),
        canales: canales.map(c => ({
          tipo_cobro: c.tipo_cobro,
          cuenta_cobro_id: c.cuenta_cobro_id || null,
          cuenta_cobro_nombre_snapshot: c.cuenta_cobro_nombre_snapshot || null,
          cuenta_cobro_tipo_pago_snapshot: c.cuenta_cobro_tipo_pago_snapshot || null,
          cuenta_destino_id_snapshot: c.cuenta_destino_id_snapshot || null,
          cuenta_destino_nombre_snapshot: c.cuenta_destino_nombre_snapshot || null,
          monto: Number(Number(c.monto).toFixed(2))
        })),
        tipo_movimiento:        tm,
        revertido:              revertido,
        reversa_de_group_id:    g.reversa_de_group_id    || null,
        motivo_reversa:         g.motivo_reversa         || null,
        usuario_reversa_id:     g.usuario_reversa_id     || null,
        usuario_reversa_nombre: g.usuario_reversa_nombre || null,
        fecha_reversa:          g.fecha_reversa          || null,
        hora_reversa:           g.hora_reversa           || null,
        estado_auditoria:       estadoAuditoria
      });
    }

    // Filas legacy: cada fila es un cobro independiente sin pagos_cc_cobros
    for (const row of legacy) {
      resultado.push({
        group_id: null,
        numero_comprobante: null,
        fecha: row.fecha,
        hora: row.hora,
        cliente_id: clienteId,
        usuario_id: null,
        usuario_nombre: null,
        observacion: null,
        monto_total: Number(Number(row.monto_pagado).toFixed(2)),
        cantidad_ventas_afectadas: 1,
        ventas_afectadas: [{ venta_id: row.venta_id, monto_pagado: Number(Number(row.monto_pagado).toFixed(2)) }],
        canales: row.tipo_cobro
          ? [{ tipo_cobro: row.tipo_cobro, cuenta_cobro_id: null, cuenta_cobro_nombre_snapshot: null,
               cuenta_cobro_tipo_pago_snapshot: row.tipo_cobro, cuenta_destino_id_snapshot: null,
               cuenta_destino_nombre_snapshot: null, monto: Number(Number(row.monto_pagado).toFixed(2)) }]
          : [],
        tipo_movimiento:        "legacy",
        revertido:              0,
        reversa_de_group_id:    null,
        motivo_reversa:         null,
        usuario_reversa_id:     null,
        usuario_reversa_nombre: null,
        fecha_reversa:          null,
        hora_reversa:           null,
        estado_auditoria:       "legacy"
      });
    }

    resultado.sort((a, b) => `${b.fecha || ""} ${b.hora || ""}`.localeCompare(`${a.fecha || ""} ${a.hora || ""}`));

    return res.json(resultado);
  } catch (error) {
    logError("Error al obtener cobros CC del cliente:", error);
    return res.status(500).json({ message: "Error al obtener cobros CC del cliente" });
  }
});

// CC3B-F1/F2: recibo de cobranza CC por group_id — solo lectura, no escribe DB
app.get("/clientes/:id/cobros-cc/:group_id/recibo", async (req, res) => {
  const clienteId = Number(req.params.id);
  const groupId   = String(req.params.group_id || "").trim();
  if (!groupId) return res.status(400).json({ message: "group_id requerido" });

  try {
    const cliente = await getQuery(
      "SELECT id, nombre, dni_cuit, telefono FROM clientes WHERE id = ?",
      [clienteId]
    );
    if (!cliente) return res.status(404).json({ message: "Cliente no encontrado" });

    const g = await getQuery(
      `SELECT group_id,
              MIN(fecha)                   AS fecha,
              MIN(hora)                    AS hora,
              SUM(monto_pagado)            AS monto_total,
              MAX(numero_comprobante)      AS numero_comprobante,
              MAX(usuario_id)              AS usuario_id,
              MAX(usuario_nombre)          AS usuario_nombre,
              MAX(observacion)             AS observacion,
              MAX(tipo_movimiento)         AS tipo_movimiento,
              MAX(revertido)               AS revertido,
              MAX(reversa_de_group_id)     AS reversa_de_group_id,
              MAX(motivo_reversa)          AS motivo_reversa,
              MAX(usuario_reversa_id)      AS usuario_reversa_id,
              MAX(usuario_reversa_nombre)  AS usuario_reversa_nombre,
              MAX(fecha_reversa)           AS fecha_reversa,
              MAX(hora_reversa)            AS hora_reversa
       FROM pagos_cuenta_corriente
       WHERE cliente_id = ? AND group_id = ?`,
      [clienteId, groupId]
    );
    if (!g || !g.group_id) {
      return res.status(404).json({ message: "Cobro no encontrado para este cliente" });
    }

    const config = await getConfiguracionGlobal();
    const comercio = {
      nombre:       String(config.negocio_nombre_comercial || config.ticket_nombre || "Atlas OS"),
      razon_social: config.negocio_razon_social  || null,
      cuit:         config.negocio_cuit          || null,
      direccion:    config.negocio_direccion     || null,
      telefono:     config.negocio_telefono      || null,
    };

    const canales = await allQuery(
      `SELECT tipo_cobro, cuenta_cobro_id,
              cuenta_cobro_nombre_snapshot, cuenta_cobro_tipo_pago_snapshot,
              cuenta_destino_id_snapshot, cuenta_destino_nombre_snapshot, monto
       FROM pagos_cc_cobros WHERE group_id = ? ORDER BY id ASC`,
      [groupId]
    );

    const ventasAfectadas = await allQuery(
      `SELECT p.venta_id, p.monto_pagado AS monto_aplicado,
              v.fecha AS venta_fecha, v.hora AS venta_hora, v.total AS venta_total
       FROM pagos_cuenta_corriente p
       LEFT JOIN ventas v ON v.id = p.venta_id
       WHERE p.cliente_id = ? AND p.group_id = ?
       ORDER BY p.id ASC`,
      [clienteId, groupId]
    );

    // Reconstrucción de timeline para saldo_anterior / saldo_posterior
    const ventasCC = await allQuery(
      `SELECT id, fecha, hora, total AS importe FROM ventas
       WHERE cliente_id = ? AND es_cuenta_corriente = 1
       ORDER BY fecha ASC, hora ASC, id ASC`,
      [clienteId]
    );
    const pagosCC = await allQuery(
      `SELECT id, group_id AS pago_group_id, fecha, hora, monto_pagado AS importe
       FROM pagos_cuenta_corriente WHERE cliente_id = ?
       ORDER BY fecha ASC, hora ASC, id ASC`,
      [clienteId]
    );

    const groupRowIds = new Set(
      pagosCC.filter(p => p.pago_group_id === groupId).map(p => p.id)
    );

    const timeline = [
      ...ventasCC.map(v => ({ ...v, _tipo: "venta" })),
      ...pagosCC.map(p => ({ ...p, _tipo: "pago"  }))
    ].sort((a, b) => {
      const ts = `${a.fecha} ${a.hora}`.localeCompare(`${b.fecha} ${b.hora}`);
      if (ts !== 0) return ts;
      if (a._tipo !== b._tipo) return a._tipo === "venta" ? -1 : 1;
      return a.id - b.id;
    });

    let saldo = 0;
    let saldo_anterior = null;
    let saldo_posterior = null;

    for (const mov of timeline) {
      if (mov._tipo === "venta") {
        saldo += Number(mov.importe || 0);
      } else {
        if (groupRowIds.has(mov.id)) {
          if (saldo_anterior === null) saldo_anterior = Number(saldo.toFixed(2));
          saldo -= Number(mov.importe || 0);
          saldo_posterior = Number(Math.max(0, saldo).toFixed(2));
        } else {
          saldo -= Number(mov.importe || 0);
        }
      }
    }
    if (saldo_anterior === null) saldo_anterior = 0;
    if (saldo_posterior === null) saldo_posterior = 0;

    const tm             = g.tipo_movimiento || "cobro";
    const revertido      = Number(g.revertido || 0);
    const estadoAuditoria = tm === "reversa" ? "reversa"
                          : revertido === 1   ? "revertido"
                          :                     "cobro";

    return res.json({
      comercio,
      cliente: {
        id:       cliente.id,
        nombre:   cliente.nombre,
        dni_cuit: cliente.dni_cuit  || null,
        telefono: cliente.telefono  || null,
      },
      recibo: {
        group_id:               g.group_id,
        numero_comprobante:     g.numero_comprobante     || null,
        fecha:                  g.fecha,
        hora:                   g.hora,
        monto_total:            Number(Number(g.monto_total).toFixed(2)),
        saldo_anterior,
        saldo_posterior,
        usuario_id:             g.usuario_id             || null,
        usuario_nombre:         g.usuario_nombre         || null,
        observacion:            g.observacion            || null,
        tipo_movimiento:        tm,
        revertido,
        reversa_de_group_id:    g.reversa_de_group_id    || null,
        estado_auditoria:       estadoAuditoria,
        motivo_reversa:         g.motivo_reversa         || null,
        usuario_reversa_id:     g.usuario_reversa_id     || null,
        usuario_reversa_nombre: g.usuario_reversa_nombre || null,
        fecha_reversa:          g.fecha_reversa          || null,
        hora_reversa:           g.hora_reversa           || null,
      },
      canales: canales.map(c => ({
        tipo_cobro:                      c.tipo_cobro,
        cuenta_cobro_id:                 c.cuenta_cobro_id                  || null,
        cuenta_cobro_nombre_snapshot:    c.cuenta_cobro_nombre_snapshot     || null,
        cuenta_cobro_tipo_pago_snapshot: c.cuenta_cobro_tipo_pago_snapshot  || null,
        cuenta_destino_id_snapshot:      c.cuenta_destino_id_snapshot       || null,
        cuenta_destino_nombre_snapshot:  c.cuenta_destino_nombre_snapshot   || null,
        monto: Number(Number(c.monto).toFixed(2)),
      })),
      ventas_afectadas: ventasAfectadas.map(v => ({
        venta_id:       v.venta_id,
        fecha:          v.venta_fecha  || null,
        hora:           v.venta_hora   || null,
        total:          v.venta_total  ? Number(Number(v.venta_total).toFixed(2)) : null,
        monto_aplicado: Number(Number(v.monto_aplicado).toFixed(2)),
      })),
    });
  } catch (error) {
    logError("Error al generar recibo CC:", error);
    return res.status(500).json({ message: "Error al generar recibo de cobranza" });
  }
});

// CC3B-E2: reversa segura de cobro CC — movimiento compensatorio negativo
app.post("/clientes/:id/cobros-cc/:group_id/revertir", async (req, res) => {
  const clienteId      = Number(req.params.id);
  const groupIdOriginal = String(req.params.group_id || "").trim();

  try {
    if (!(await requirePermiso(req, res, "pagos_eliminar", "No tenes permisos para revertir cobros"))) return;

    // 1. Cliente existe
    const cliente = await getQuery("SELECT id FROM clientes WHERE id = ?", [clienteId]);
    if (!cliente) return res.status(404).json({ message: "Cliente no encontrado" });

    // 2. Caja abierta (igual que cobrar-deuda)
    const cajaActiva = await getCajaAbiertaActual();
    if (!cajaActiva) return res.status(400).json({ message: "No hay una caja abierta para registrar la reversa" });

    // 3. Motivo obligatorio
    const motivoReversa = typeof req.body.motivo_reversa === "string" ? req.body.motivo_reversa.trim() : "";
    if (!motivoReversa) return res.status(400).json({ message: "motivo_reversa es obligatorio" });

    // 4. group_id válido y pertenece al cliente (con JOIN a ventas para saldo/total/estado)
    const filasOriginales = await allQuery(
      `SELECT pcc.id, pcc.venta_id, pcc.monto_pagado, pcc.tipo_cobro,
              pcc.revertido, pcc.reversa_de_group_id, pcc.tipo_movimiento
       FROM pagos_cuenta_corriente pcc
       WHERE pcc.group_id = ? AND pcc.cliente_id = ?
       ORDER BY pcc.id ASC`,
      [groupIdOriginal, clienteId]
    );

    if (!filasOriginales.length) {
      return res.status(404).json({ message: "Cobro no encontrado para este cliente" });
    }

    // 5. No permitir reversa de reversa
    const esReversa = filasOriginales.some(
      f => f.tipo_movimiento === "reversa" || f.reversa_de_group_id != null
    );
    if (esReversa) {
      return res.status(409).json({ message: "No se puede revertir una reversa" });
    }

    // 6a. No doble reversa: filas ya marcadas
    const yaRevertido = filasOriginales.some(f => Number(f.revertido) === 1);
    if (yaRevertido) {
      return res.status(409).json({ message: "Este cobro ya fue revertido" });
    }

    // 6b. No doble reversa: ya existe grupo reversa
    const reversaExistente = await getQuery(
      "SELECT 1 FROM pagos_cuenta_corriente WHERE reversa_de_group_id = ? LIMIT 1",
      [groupIdOriginal]
    );
    if (reversaExistente) {
      return res.status(409).json({ message: "Este cobro ya fue revertido" });
    }

    // 7-8. Leer ventas afectadas y validar que ninguna esté anulada
    const ventaIds = [...new Set(filasOriginales.map(f => f.venta_id))];
    const ventasData = await allQuery(
      `SELECT id, total, saldo_pendiente, estado
       FROM ventas WHERE id IN (${ventaIds.map(() => "?").join(",")})`,
      ventaIds
    );
    const ventasMap = new Map(ventasData.map(v => [v.id, v]));

    const ventasAnuladas = ventaIds.filter(id => ventasMap.get(id)?.estado === "anulado");
    if (ventasAnuladas.length) {
      return res.status(422).json({
        message: "No se puede revertir: hay ventas anuladas en este cobro",
        ventas_anuladas: ventasAnuladas
      });
    }

    // Canales originales en pagos_cc_cobros
    const canalesOriginales = await allQuery(
      `SELECT id, tipo_cobro, cuenta_cobro_id, monto,
              cuenta_cobro_nombre_snapshot, cuenta_cobro_tipo_pago_snapshot,
              cuenta_destino_id_snapshot, cuenta_destino_nombre_snapshot
       FROM pagos_cc_cobros
       WHERE group_id = ?
       ORDER BY id ASC`,
      [groupIdOriginal]
    );

    // 9. Monto total a revertir
    const montoRevertido = Number(
      filasOriginales.reduce((s, f) => s + Number(f.monto_pagado), 0).toFixed(2)
    );

    const { fecha, hora } = getNowParts();
    const usuarioId      = req.usuario?.id     ?? null;
    const usuarioNombre  = req.usuario?.nombre ?? null;
    const groupIdReversa       = crypto.randomBytes(16).toString("hex");
    const numeroComprobanteRev = `REV-${fecha.replace(/-/g, "")}-${groupIdReversa.slice(0, 8)}`;

    const ventasResultado = [];

    await runQuery("BEGIN TRANSACTION");
    try {
      // Revalidar doble reversa dentro de la transacción
      const revalidar = await getQuery(
        "SELECT 1 FROM pagos_cuenta_corriente WHERE reversa_de_group_id = ? LIMIT 1",
        [groupIdOriginal]
      );
      if (revalidar) {
        await runQuery("ROLLBACK");
        return res.status(409).json({ message: "Este cobro ya fue revertido (conflicto concurrente)" });
      }

      // Marcar grupo original como revertido
      await runQuery(
        `UPDATE pagos_cuenta_corriente
         SET revertido = 1,
             motivo_reversa = ?,
             usuario_reversa_id = ?,
             usuario_reversa_nombre = ?,
             fecha_reversa = ?,
             hora_reversa = ?
         WHERE group_id = ?`,
        [motivoReversa, usuarioId, usuarioNombre, fecha, hora, groupIdOriginal]
      );

      // Insertar filas negativas en pagos_cuenta_corriente y restaurar saldo
      for (const fila of filasOriginales) {
        const montoPagadoNeg = Number((-Number(fila.monto_pagado)).toFixed(2));

        await runQuery(
          `INSERT INTO pagos_cuenta_corriente
           (venta_id, cliente_id, fecha, hora, monto_pagado, tipo_cobro,
            monto_efectivo, monto_debito, caja_id, group_id,
            observacion, numero_comprobante, usuario_id, usuario_nombre,
            reversa_de_group_id, motivo_reversa,
            usuario_reversa_id, usuario_reversa_nombre,
            fecha_reversa, hora_reversa, tipo_movimiento)
           VALUES (?, ?, ?, ?, ?, ?,
                   0, 0, ?, ?,
                   ?, ?, ?, ?,
                   ?, ?,
                   ?, ?,
                   ?, ?, ?)`,
          [
            fila.venta_id, clienteId, fecha, hora, montoPagadoNeg, fila.tipo_cobro,
            cajaActiva.id, groupIdReversa,
            motivoReversa, numeroComprobanteRev, usuarioId, usuarioNombre,
            groupIdOriginal, motivoReversa,
            usuarioId, usuarioNombre,
            fecha, hora, "reversa"
          ]
        );

        // Leer saldo actual dentro de la transacción para evitar race condition
        const ventaRt = await getQuery(
          "SELECT saldo_pendiente, total FROM ventas WHERE id = ?",
          [fila.venta_id]
        );
        const saldoActual = Number(ventaRt?.saldo_pendiente ?? 0);
        const ventaTotal  = Number(ventaRt?.total ?? 0);
        const montoOriginal = Number(fila.monto_pagado);
        const nuevoSaldo  = Number(Math.min(ventaTotal, saldoActual + montoOriginal).toFixed(2));
        const nuevoEstado = nuevoSaldo > 0 ? "cuenta_corriente_pendiente" : "cobrada";

        await runQuery(
          "UPDATE ventas SET saldo_pendiente = ?, estado = ? WHERE id = ?",
          [nuevoSaldo, nuevoEstado, fila.venta_id]
        );

        ventasResultado.push({
          venta_id: fila.venta_id,
          monto_revertido: montoOriginal,
          nuevo_saldo: nuevoSaldo
        });
      }

      // Insertar filas negativas en pagos_cc_cobros
      for (const canal of canalesOriginales) {
        const montoNeg = Number((-Number(canal.monto)).toFixed(2));
        await runQuery(
          `INSERT INTO pagos_cc_cobros
           (group_id, tipo_cobro, cuenta_cobro_id, monto, caja_id, fecha, hora,
            cuenta_cobro_nombre_snapshot, cuenta_cobro_tipo_pago_snapshot,
            cuenta_destino_id_snapshot, cuenta_destino_nombre_snapshot,
            observacion, numero_comprobante, usuario_id, usuario_nombre,
            reversa_de_group_id, tipo_movimiento)
           VALUES (?, ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, ?,
                   ?, ?, ?, ?,
                   ?, ?)`,
          [
            groupIdReversa, canal.tipo_cobro, canal.cuenta_cobro_id, montoNeg,
            cajaActiva.id, fecha, hora,
            canal.cuenta_cobro_nombre_snapshot,
            canal.cuenta_cobro_tipo_pago_snapshot,
            canal.cuenta_destino_id_snapshot,
            canal.cuenta_destino_nombre_snapshot,
            motivoReversa, numeroComprobanteRev, usuarioId, usuarioNombre,
            groupIdOriginal, "reversa"
          ]
        );
      }

      await runQuery("COMMIT");
    } catch (txError) {
      try { await runQuery("ROLLBACK"); } catch (_) {}
      throw txError;
    }

    const resumenPost    = await buildClienteCuentaResumen(clienteId);
    const deudaResultante = resumenPost.deuda_actual;

    return res.json({
      message: "Cobro revertido correctamente",
      group_id_original: groupIdOriginal,
      group_id_reversa: groupIdReversa,
      numero_comprobante_reversa: numeroComprobanteRev,
      monto_revertido: montoRevertido,
      deuda_resultante: deudaResultante,
      ventas_afectadas: ventasResultado
    });
  } catch (error) {
    logError("Error al revertir cobro CC:", error);
    return res.status(500).json({ message: "Error al revertir cobro CC" });
  }
});

function resolverReglasCuenta(cliente, config) {
  if (Number(cliente.usa_reglas_personalizadas) === 1) {
    return {
      origen: "cliente",
      limite_fiado: Number(cliente.limite_fiado || 0),
      dias_vencimiento: Number(cliente.dias_vencimiento || 30),
      permite_excedente: Number(cliente.permite_excedente || 0),
      requiere_autorizacion: Number(cliente.requiere_autorizacion || 0),
      interes_mora_activo: false,
      interes_mora: 0
    };
  }
  const limiteActivo = Boolean(config.cuentas_limite_global_activo);
  return {
    origen: "general",
    limite_fiado: limiteActivo ? Number(config.cuentas_limite_global_monto || 0) : 0,
    dias_vencimiento: Number(config.cuentas_dias_vencimiento || 30),
    permite_excedente: 0,
    requiere_autorizacion: 0,
    interes_mora_activo: Boolean(config.cuentas_interes_mora_activo),
    interes_mora: Number(config.cuentas_interes_mora || 0)
  };
}

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
  if (autorizarExcedido && !["admin", "encargado"].includes(req.usuario?.rol)) {
    return res.status(403).json({ message: "Solo encargado o admin puede autorizar excedentes" });
  }

  try {
    const cliente = await getClienteConMetricas(clienteId);
    if (!cliente || Number(cliente.activo) !== 1) {
      return res.status(404).json({ message: "Cliente activo no encontrado" });
    }
    if (Number(cliente.habilita_cuenta_corriente) !== 1) {
      return res.status(400).json({ message: "El cliente no tiene cuenta corriente habilitada" });
    }
    const configGlobal = await getConfiguracionGlobal();
    const reglas = resolverReglasCuenta(cliente, configGlobal);
    if (
      Number(cliente.suspendido) !== 1 &&
      Number(cliente.deuda_actual || 0) > 0 &&
      Boolean(configGlobal.cuentas_desactivar_por_vencimiento) &&
      cliente.primera_deuda
    ) {
      const { fecha: hoy } = getNowParts();
      const diasDesde = Math.floor((new Date(hoy) - new Date(cliente.primera_deuda)) / 86400000);
      if (diasDesde >= reglas.dias_vencimiento) {
        await runQuery("UPDATE clientes SET suspendido = 1 WHERE id = ? AND suspendido = 0", [clienteId]);
        cliente.suspendido = 1;
      }
    }
    if (Number(cliente.suspendido) === 1) {
      return res.status(403).json({ message: "Cliente suspendido: solo se permiten cobros" });
    }

    if (reglas.requiere_autorizacion === 1 && !["admin", "encargado"].includes(req.usuario?.rol)) {
      return res.status(403).json({ message: "Esta cuenta requiere autorización de encargado o admin" });
    }
    const deudaProyectada = Number(cliente.deuda_actual || 0) + total;
    if (reglas.limite_fiado > 0 && deudaProyectada > reglas.limite_fiado) {
      const excedentPermitido = reglas.permite_excedente === 1 || autorizarExcedido;
      if (!excedentPermitido) {
        return res.status(409).json({ message: "La venta excede el limite de credito del cliente" });
      }
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
        getUsuarioAuditoria(req),
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
    const detalles = await replaceVentaDetalle(result.lastID, items);
    await applyStockForNewItems(items);
    await crearAjustesPendientesVentaReceta({
      ventaId: result.lastID,
      detalles,
      usuario: getUsuarioAuditoria(req),
      rol: req.usuario?.rol
    });
    await guardarRecetaSnapshotVenta(result.lastID, detalles);
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

    const { fecha, hora } = getNowParts();

    await runQuery("BEGIN TRANSACTION");

    const ventaDb = await getQuery(
      `SELECT saldo_pendiente FROM ventas
       WHERE id = ? AND estado = 'cuenta_corriente_pendiente' AND saldo_pendiente > 0`,
      [ventaId]
    );

    if (!ventaDb || Number(ventaDb.saldo_pendiente) <= 0) {
      await runQuery("ROLLBACK");
      return res.status(409).json({ message: "La venta ya fue pagada o no tiene saldo pendiente." });
    }

    const saldoActualDb = Number(ventaDb.saldo_pendiente);
    const nuevoSaldo = Number(Math.max(0, saldoActualDb - montoPagado).toFixed(2));

    const resultPago = await runQuery(
      `UPDATE ventas
       SET saldo_pendiente = ?, estado = ?, metodo_pago = ?, tipo_cobro = ?, monto_efectivo = monto_efectivo + ?, monto_debito = monto_debito + ?
       WHERE id = ? AND estado = 'cuenta_corriente_pendiente' AND saldo_pendiente = ?`,
      [
        nuevoSaldo,
        nuevoSaldo === 0 ? "cobrada" : "cuenta_corriente_pendiente",
        cobro.tipo_cobro,
        cobro.tipo_cobro,
        cobro.monto_efectivo,
        cobro.monto_debito,
        ventaId,
        saldoActualDb
      ]
    );

    if (resultPago.changes === 0) {
      await runQuery("ROLLBACK");
      return res.status(409).json({ message: "La venta ya fue pagada o no tiene saldo pendiente." });
    }

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

app.get("/caja/movimientos-no-monetarios", async (req, res) => {
  try {
    const resumen = await getResumenCuentaLocalNoMonetaria({
      desde: req.query.desde || null,
      hasta: req.query.hasta || null,
      limite: req.query.limite || 8
    });
    return res.json({ cuenta_local: resumen });
  } catch (error) {
    logError("Error al obtener movimientos no monetarios de caja:", error);
    return res.status(500).json({ message: "Error al obtener movimientos no monetarios de caja" });
  }
});

app.get("/caja/resumen/cuentas", async (req, res) => {
  try {
    const cajaId = Number(req.query.caja_id) || null;
    const caja = cajaId
      ? await getQuery("SELECT * FROM caja_aperturas WHERE id = ?", [cajaId])
      : await getCajaAbiertaActual() || await getUltimaCajaRegistrada();

    if (!caja) {
      return res.json({ caja: null, cuentas: [] });
    }

    return res.json({
      caja,
      cuentas: await getResumenPorCuentaCobro({ cajaId: caja.id })
    });
  } catch (error) {
    logError("Error al obtener resumen por cuenta de cobro:", error);
    return res.status(500).json({ message: "Error al obtener resumen por cuenta de cobro" });
  }
});

app.get("/caja/resumen/cuentas-destino", async (req, res) => {
  try {
    const cajaId = Number(req.query.caja_id) || null;
    const caja = cajaId
      ? await getQuery("SELECT * FROM caja_aperturas WHERE id = ?", [cajaId])
      : await getCajaAbiertaActual() || await getUltimaCajaRegistrada();

    if (!caja) {
      return res.json({ caja: null, cuentas: [] });
    }

    return res.json({
      caja,
      cuentas: await getResumenPorCuentaDestino({ cajaId: caja.id })
    });
  } catch (error) {
    logError("Error al obtener resumen por cuenta destino:", error);
    return res.status(500).json({ message: "Error al obtener resumen por cuenta destino" });
  }
});

app.get("/caja/conciliaciones/cuentas", async (req, res) => {
  try {
    const cajaId = Number(req.query.caja_id) || null;
    const caja = cajaId
      ? await getQuery("SELECT * FROM caja_aperturas WHERE id = ?", [cajaId])
      : await getCajaAbiertaActual() || await getUltimaCajaRegistrada();

    if (!caja) {
      return res.json({ caja: null, conciliaciones: [] });
    }

    return res.json({
      caja,
      conciliaciones: await getConciliacionesCuentaCobro({ cajaId: caja.id })
    });
  } catch (error) {
    logError("Error al obtener conciliaciones por cuenta de cobro:", error);
    return res.status(500).json({ message: "Error al obtener conciliaciones por cuenta de cobro" });
  }
});

app.post("/caja/conciliaciones/cuentas", async (req, res) => {
  if (!(await requirePermiso(req, res, "caja_registrar_arqueo", "No tenes permisos para conciliar caja"))) return;

  try {
    const cajaId = Number(req.body.caja_id) || null;
    const caja = cajaId
      ? await getQuery("SELECT * FROM caja_aperturas WHERE id = ?", [cajaId])
      : await getCajaAbiertaActual() || await getUltimaCajaRegistrada();

    if (!caja) {
      return res.status(400).json({ message: "No hay caja disponible para conciliar" });
    }

    const { fecha, hora } = getNowParts();
    const conciliacion = await guardarConciliacionCuentaCobro({
      cajaId: caja.id,
      cuentaCobroId: req.body.cuenta_cobro_id,
      montoSistema: req.body.monto_sistema,
      montoReal: req.body.monto_real,
      observaciones: req.body.observaciones,
      usuario: req.body.usuario || req.usuario?.nombre || req.usuario?.usuario || "admin",
      fecha,
      hora
    });

    return res.json({ message: "Conciliacion guardada", caja, conciliacion });
  } catch (error) {
    logError("Error al guardar conciliacion por cuenta de cobro:", error);
    return res.status(error.statusCode || 500).json({ message: error.message || "Error al guardar conciliacion por cuenta de cobro" });
  }
});

app.get("/caja/conciliaciones/cuentas-destino", async (req, res) => {
  try {
    const cajaId = Number(req.query.caja_id) || null;
    const caja = cajaId
      ? await getQuery("SELECT * FROM caja_aperturas WHERE id = ?", [cajaId])
      : await getCajaAbiertaActual() || await getUltimaCajaRegistrada();

    if (!caja) {
      return res.json({ caja: null, conciliaciones: [] });
    }

    return res.json({
      caja,
      conciliaciones: await getConciliacionesCuentaDestino({ cajaId: caja.id })
    });
  } catch (error) {
    logError("Error al obtener conciliaciones por cuenta destino:", error);
    return res.status(500).json({ message: "Error al obtener conciliaciones por cuenta destino" });
  }
});

app.post("/caja/conciliaciones/cuentas-destino", async (req, res) => {
  if (!(await requirePermiso(req, res, "caja_registrar_arqueo", "No tenes permisos para conciliar caja"))) return;

  try {
    const cajaId = Number(req.body.caja_id) || null;
    const caja = cajaId
      ? await getQuery("SELECT * FROM caja_aperturas WHERE id = ?", [cajaId])
      : await getCajaAbiertaActual() || await getUltimaCajaRegistrada();

    if (!caja) {
      return res.status(400).json({ message: "No hay caja disponible para conciliar" });
    }

    const { fecha, hora } = getNowParts();
    const conciliacion = await guardarConciliacionCuentaDestino({
      cajaId: caja.id,
      cuentaDestinoId: req.body.cuenta_destino_id,
      montoSistema: req.body.monto_sistema,
      montoReal: req.body.monto_real,
      saldoInicial: req.body.saldo_inicial,
      decisionCierre: req.body.decision_cierre,
      montoRetiro: req.body.monto_retiro,
      saldoArrastrado: req.body.saldo_arrastrado,
      observaciones: req.body.observaciones,
      usuario: req.body.usuario || req.usuario?.nombre || req.usuario?.usuario || "admin",
      fecha,
      hora
    });

    return res.json({ message: "Conciliacion de cuenta destino guardada", caja, conciliacion });
  } catch (error) {
    logError("Error al guardar conciliacion por cuenta destino:", error);
    return res.status(error.statusCode || 500).json({ message: error.message || "Error al guardar conciliacion por cuenta destino" });
  }
});

app.get("/caja/ultimo-saldo-arrastrado", async (req, res) => {
  try {
    const cuentaDestinoId = req.query.cuenta_destino_id != null && req.query.cuenta_destino_id !== ""
      ? Number(req.query.cuenta_destino_id)
      : null;
    const saldo = await getUltimoSaldoArrastradoPorCuenta(cuentaDestinoId);
    return res.json({ saldo });
  } catch (error) {
    logError("Error al obtener ultimo saldo arrastrado:", error);
    return res.status(error.statusCode || 500).json({ message: error.message || "Error al obtener ultimo saldo arrastrado" });
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

app.put("/caja/movimientos/:id", async (req, res) => {
  if (!(await requirePermiso(req, res, "caja_movimientos", "No tenes permisos para movimientos de caja"))) return;

  const movimientoId = Number(req.params.id);
  const tipo = String(req.body.tipo || "").trim().toLowerCase();
  const concepto = String(req.body.concepto || "").trim();
  const monto = Number(req.body.monto) || 0;
  const usuario = String(req.body.usuario || "admin").trim() || "admin";
  const clave = String(req.body.clave || req.body.authorization_code || "").trim();

  if (!Number.isInteger(movimientoId) || movimientoId <= 0) {
    return res.status(400).json({ message: "Movimiento invalido" });
  }

  const claveActual = await getClaveAutorizacion();
  if (!requerirClaveConfigurada(claveActual, res)) return;
  if (!clave || clave !== claveActual) {
    return res.status(403).json({ message: "Clave maestra incorrecta" });
  }

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
    const movimiento = await getQuery(
      `SELECT cm.*, ca.estado AS caja_estado
       FROM caja_movimientos cm
       LEFT JOIN caja_aperturas ca ON ca.id = cm.caja_id
       WHERE cm.id = ?`,
      [movimientoId]
    );

    if (!movimiento) {
      return res.status(404).json({ message: "Movimiento no encontrado" });
    }

    if (movimiento.caja_estado !== "abierta") {
      return res.status(400).json({ message: "Solo se pueden editar movimientos de una caja abierta" });
    }

    await runQuery(
      `UPDATE caja_movimientos
       SET tipo = ?, concepto = ?, monto = ?, usuario = ?
       WHERE id = ?`,
      [tipo, concepto, Number(monto.toFixed(2)), usuario, movimientoId]
    );

    const actualizado = await getQuery(
      "SELECT * FROM caja_movimientos WHERE id = ?",
      [movimientoId]
    );

    return res.json({
      message: "Movimiento de caja actualizado",
      movimiento: actualizado
    });
  } catch (error) {
    logError("Error al editar movimiento de caja:", error);
    return res.status(500).json({ message: "Error al editar movimiento de caja" });
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
              diferencia, monto_caja_apertura, monto_caja_fondo, usuario, estado, resumen_snapshot,
              ventas_snapshot
       FROM caja_aperturas
       WHERE estado = 'cerrada'
       ORDER BY fecha DESC, hora_cierre DESC, id DESC`
    );

    return res.json(cierres.map((cierre) => ({
      ...cierre,
      resumen_snapshot: parseJsonOrFallback(cierre.resumen_snapshot, null),
      ventas_snapshot: cierre.ventas_snapshot ? JSON.parse(cierre.ventas_snapshot) : []
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

app.get("/clientes/:id/productos", async (req, res) => {
  const clienteId = Number(req.params.id);
  try {
    const cliente = await getQuery("SELECT id FROM clientes WHERE id = ?", [clienteId]);
    if (!cliente) {
      return res.status(404).json({ message: "Cliente no encontrado" });
    }
    const productos = await getHistorialProductosCliente(clienteId, { limite: req.query.limite });
    return res.json({ cliente_id: clienteId, productos });
  } catch (error) {
    logError("Error al obtener productos del cliente:", error);
    return res.status(500).json({ message: "Error al obtener productos del cliente" });
  }
});

app.get("/clientes/:id/deuda-actualizada", async (req, res) => {
  const clienteId = Number(req.params.id);
  try {
    const cliente = await getQuery("SELECT id FROM clientes WHERE id = ?", [clienteId]);
    if (!cliente) {
      return res.status(404).json({ message: "Cliente no encontrado" });
    }
    const comparacion = await getDeudaActualizadaCliente(clienteId);
    return res.json({ cliente_id: clienteId, ...comparacion });
  } catch (error) {
    logError("Error al calcular deuda actualizada del cliente:", error);
    return res.status(500).json({ message: "Error al calcular deuda actualizada" });
  }
});

app.post("/clientes/:id/recalcular-deuda", async (req, res) => {
  const clienteId = Number(req.params.id);
  try {
    const cliente = await getQuery("SELECT id FROM clientes WHERE id = ?", [clienteId]);
    if (!cliente) {
      return res.status(404).json({ message: "Cliente no encontrado" });
    }

    const config = await getConfiguracionGlobal();
    const flagActivo = config.cuenta_corriente_actualizar_fiado_por_precio_actual === true
      || config.cuenta_corriente_actualizar_fiado_por_precio_actual === 1
      || config.cuenta_corriente_actualizar_fiado_por_precio_actual === "true"
      || config.cuenta_corriente_actualizar_fiado_por_precio_actual === "1";

    if (!flagActivo) {
      return res.status(403).json({ message: "El recalculo de deuda por precio actual no esta habilitado" });
    }

    const claveIngresada = String(req.body?.clave_autorizacion || "").trim();
    const claveMaestra = await getClaveAutorizacion();
    if (!requerirClaveConfigurada(claveMaestra, res)) return;
    if (!claveIngresada || claveIngresada !== claveMaestra) {
      return res.status(403).json({ message: "Clave maestra incorrecta" });
    }

    const resultado = await aplicarRecalculoDeudaCliente(clienteId, {
      usuario: req.usuario?.nombre || req.usuario?.usuario || "admin",
      motivo: req.body?.motivo || "Actualizacion por precio vigente"
    });

    return res.json({ cliente_id: clienteId, ...resultado });
  } catch (error) {
    logError("Error al recalcular deuda del cliente:", error);
    return res.status(500).json({ message: "Error al recalcular deuda" });
  }
});

// ── CC 3.0A: cobrar deuda con Cobros V2 ───────────────────────────────────────
app.post("/clientes/:id/cobrar-deuda", async (req, res) => {
  const clienteId = Number(req.params.id);
  try {
    const cliente = await getQuery("SELECT id FROM clientes WHERE id = ?", [clienteId]);
    if (!cliente) {
      return res.status(404).json({ message: "Cliente no encontrado" });
    }

    const cajaActiva = await getCajaAbiertaActual();
    if (!cajaActiva) {
      return res.status(400).json({ message: "No hay una caja abierta para registrar el cobro" });
    }

    const cobrosRaw = req.body.cobros;
    const observacion = typeof req.body.observacion === "string" && req.body.observacion.trim() ? req.body.observacion.trim() : null;
    const ventasRaw = req.body.ventas;
    const ventasManual = Array.isArray(ventasRaw) && ventasRaw.length > 0 ? ventasRaw : null;
    if (!Array.isArray(cobrosRaw) || cobrosRaw.length === 0) {
      return res.status(400).json({ message: "cobros[] es obligatorio y no puede estar vacio" });
    }

    const cobrosNormalizados = normalizarCobrosV2(cobrosRaw);
    if (!cobrosNormalizados || cobrosNormalizados.error) {
      return res.status(400).json({ message: cobrosNormalizados?.error || "cobros[] invalido" });
    }

    const montoTotal = Number(cobrosNormalizados.reduce((s, c) => s + c.monto, 0).toFixed(2));
    if (montoTotal <= 0) {
      return res.status(400).json({ message: "El monto total debe ser mayor a 0" });
    }

    if (ventasManual) {
      for (const item of ventasManual) {
        const vid = Number(item.venta_id);
        const mon = Number(item.monto);
        if (!Number.isInteger(vid) || vid <= 0) {
          return res.status(400).json({ message: "ventas[].venta_id debe ser un entero positivo" });
        }
        if (!isFinite(mon) || mon <= 0) {
          return res.status(400).json({ message: "ventas[].monto debe ser mayor a 0" });
        }
      }
      const ventaIdsManual = ventasManual.map(v => Number(v.venta_id));
      if (new Set(ventaIdsManual).size !== ventaIdsManual.length) {
        return res.status(400).json({ message: "ventas[] contiene venta_id duplicados" });
      }
      const sumaVentas = Number(ventasManual.reduce((s, v) => s + Number(v.monto), 0).toFixed(2));
      if (Math.abs(sumaVentas - montoTotal) > 0.01) {
        return res.status(400).json({
          message: `La suma de ventas (${sumaVentas}) no coincide con el monto total de cobros (${montoTotal})`
        });
      }
    }

    for (const cobro of cobrosNormalizados) {
      const valido = await validarCuentaCobroVenta(cobro.cuenta_cobro_id, cobro);
      if (!valido.ok) {
        return res.status(valido.statusCode || 400).json({ message: valido.message });
      }
    }

    const resumen = await buildClienteCuentaResumen(clienteId);
    const deudaAnterior = resumen.deuda_actual;
    if (deudaAnterior <= 0) {
      return res.status(400).json({ message: "El cliente no tiene deuda pendiente" });
    }
    if (montoTotal > deudaAnterior + 0.01) {
      return res.status(400).json({
        message: `El monto (${montoTotal}) supera la deuda actual (${deudaAnterior})`
      });
    }

    let ventasPendientes = [];
    if (!ventasManual) {
      ventasPendientes = await allQuery(
        `SELECT id, saldo_pendiente
         FROM ventas
         WHERE cliente_id = ? AND es_cuenta_corriente = 1 AND saldo_pendiente > 0
         ORDER BY fecha ASC, hora ASC, id ASC`,
        [clienteId]
      );
      if (!ventasPendientes.length) {
        return res.status(400).json({ message: "No hay ventas pendientes para este cliente" });
      }
    }

    const { fecha, hora } = getNowParts();
    const groupId = crypto.randomBytes(16).toString("hex");
    const numeroComprobante = `CC-${fecha.replace(/-/g, "")}-${groupId.slice(0, 8)}`;
    const usuarioId = req.usuario?.id ?? null;
    const usuarioNombre = req.usuario?.nombre ?? null;
    const tipoCc = cobrosNormalizados.length === 1 ? cobrosNormalizados[0].tipo_cobro : "mixto";
    let restante = montoTotal;
    const ventasAfectadas = [];

    await runQuery("BEGIN TRANSACTION");
    try {
      if (ventasManual) {
        for (const item of ventasManual) {
          const ventaId = Number(item.venta_id);
          const montoPago = Number(Number(item.monto).toFixed(2));
          const ventaRt = await getQuery(
            `SELECT id, saldo_pendiente, estado, es_cuenta_corriente
             FROM ventas WHERE id = ? AND cliente_id = ?`,
            [ventaId, clienteId]
          );
          if (!ventaRt) {
            await runQuery("ROLLBACK");
            return res.status(400).json({ message: `Venta #${ventaId} no encontrada para este cliente` });
          }
          if (!Number(ventaRt.es_cuenta_corriente)) {
            await runQuery("ROLLBACK");
            return res.status(400).json({ message: `Venta #${ventaId} no es una venta a cuenta corriente` });
          }
          if (ventaRt.estado === "anulado") {
            await runQuery("ROLLBACK");
            return res.status(400).json({ message: `Venta #${ventaId} está anulada` });
          }
          const saldoActual = Number(ventaRt.saldo_pendiente);
          if (saldoActual <= 0) {
            await runQuery("ROLLBACK");
            return res.status(400).json({ message: `Venta #${ventaId} no tiene saldo pendiente` });
          }
          if (montoPago > saldoActual + 0.01) {
            await runQuery("ROLLBACK");
            return res.status(409).json({ message: `El monto (${montoPago}) supera el saldo pendiente de venta #${ventaId} (${saldoActual})` });
          }
          const nuevoSaldo = Number(Math.max(0, saldoActual - montoPago).toFixed(2));
          await runQuery(
            `INSERT INTO pagos_cuenta_corriente
             (venta_id, cliente_id, fecha, hora, monto_pagado, tipo_cobro, monto_efectivo, monto_debito, caja_id, group_id, observacion, numero_comprobante, usuario_id, usuario_nombre)
             VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`,
            [ventaId, clienteId, fecha, hora, montoPago, tipoCc, cajaActiva.id, groupId, observacion, numeroComprobante, usuarioId, usuarioNombre]
          );
          await runQuery(
            "UPDATE ventas SET saldo_pendiente = ?, estado = ? WHERE id = ?",
            [nuevoSaldo, nuevoSaldo <= 0 ? "cobrada" : "cuenta_corriente_pendiente", ventaId]
          );
          ventasAfectadas.push({ venta_id: ventaId, monto_pagado: montoPago, saldo_restante: nuevoSaldo });
        }
      } else {
        for (const venta of ventasPendientes) {
          if (restante <= 0) break;
          const ventaActual = await getQuery(
            `SELECT saldo_pendiente FROM ventas
             WHERE id = ? AND estado = 'cuenta_corriente_pendiente' AND saldo_pendiente > 0`,
            [venta.id]
          );
          if (!ventaActual || Number(ventaActual.saldo_pendiente) <= 0) continue;
          const saldoVenta = Number(ventaActual.saldo_pendiente);
          const montoPago = Number(Math.min(restante, saldoVenta).toFixed(2));
          if (montoPago <= 0) continue;
          const nuevoSaldo = Number((saldoVenta - montoPago).toFixed(2));
          const resultFifo = await runQuery(
            `UPDATE ventas
             SET saldo_pendiente = ?, estado = ?
             WHERE id = ? AND estado = 'cuenta_corriente_pendiente' AND saldo_pendiente = ?`,
            [nuevoSaldo, nuevoSaldo <= 0 ? "cobrada" : "cuenta_corriente_pendiente", venta.id, saldoVenta]
          );
          if (resultFifo.changes === 0) continue;
          await runQuery(
            `INSERT INTO pagos_cuenta_corriente
             (venta_id, cliente_id, fecha, hora, monto_pagado, tipo_cobro, monto_efectivo, monto_debito, caja_id, group_id, observacion, numero_comprobante, usuario_id, usuario_nombre)
             VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`,
            [venta.id, clienteId, fecha, hora, montoPago, tipoCc, cajaActiva.id, groupId, observacion, numeroComprobante, usuarioId, usuarioNombre]
          );
          ventasAfectadas.push({ venta_id: venta.id, monto_pagado: montoPago, saldo_restante: nuevoSaldo });
          restante = Number((restante - montoPago).toFixed(2));
        }
        if (ventasAfectadas.length === 0) {
          await runQuery("ROLLBACK");
          return res.status(409).json({ message: "La deuda ya fue cobrada o no hay saldo pendiente." });
        }
      }

      let cuentaEfectivoIdCc = null;
      if (cobrosNormalizados.some(c => c.tipo_cobro === "efectivo" && c.cuenta_cobro_id == null)) {
        const efRow = await getQuery(
          "SELECT id FROM cuentas_cobro WHERE tipo_pago_codigo = 'efectivo' AND activo = 1 ORDER BY orden ASC, id ASC LIMIT 1"
        );
        cuentaEfectivoIdCc = efRow ? efRow.id : null;
      }
      for (const cobro of cobrosNormalizados) {
        const cuentaFinal = cobro.cuenta_cobro_id ??
          (cobro.tipo_cobro === "efectivo" ? cuentaEfectivoIdCc : null);
        const snap = await getCuentaCobroSnapshot(cuentaFinal);
        await runQuery(
          `INSERT INTO pagos_cc_cobros (group_id, tipo_cobro, cuenta_cobro_id, monto, caja_id, fecha, hora, cuenta_cobro_nombre_snapshot, cuenta_cobro_tipo_pago_snapshot, cuenta_destino_id_snapshot, cuenta_destino_nombre_snapshot, observacion, numero_comprobante, usuario_id, usuario_nombre)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [groupId, cobro.tipo_cobro, cuentaFinal, cobro.monto, cajaActiva.id, fecha, hora, snap.cuenta_cobro_nombre_snapshot, snap.cuenta_cobro_tipo_pago_snapshot, snap.cuenta_destino_id_snapshot, snap.cuenta_destino_nombre_snapshot, observacion, numeroComprobante, usuarioId, usuarioNombre]
        );
      }

      await runQuery("COMMIT");
    } catch (txError) {
      try { await runQuery("ROLLBACK"); } catch (_) {}
      throw txError;
    }

    const deudaRestante = Math.max(0, Number((deudaAnterior - montoTotal).toFixed(2)));
    return res.json({
      message: "Pago de cuenta corriente registrado",
      cliente_id: clienteId,
      group_id: groupId,
      numero_comprobante: numeroComprobante,
      observacion,
      monto_pagado: montoTotal,
      deuda_anterior: deudaAnterior,
      deuda_restante: deudaRestante,
      ventas_afectadas: ventasAfectadas,
      cobros: cobrosNormalizados,
      aplicacion: ventasManual ? "manual" : "fifo"
    });
  } catch (error) {
    logError("Error al cobrar deuda del cliente:", error);
    return res.status(500).json({ message: "Error al cobrar deuda del cliente" });
  }
});

app.get("/clientes/:id", async (req, res) => {
  try {
    const cliente = await getClienteConMetricas(Number(req.params.id));
    if (!cliente) {
      return res.status(404).json({ message: "Cliente no encontrado" });
    }
    return res.json(cliente);
  } catch (error) {
    logError("Error al obtener cliente:", error);
    return res.status(500).json({ message: "Error al obtener cliente" });
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
       (nombre, dni_cuit, tipo_persona, tipo_cliente, tipo_cuenta_corriente, telefono, email, contacto, direccion, localidad, codigo_postal,
        alias, observaciones, notas, foto_url, limite_fiado, dias_vencimiento, dia_vencimiento_fijo, moneda,
        habilita_cuenta_corriente, activo, suspendido, perfil_cliente, permite_excedente, requiere_autorizacion, usa_reglas_personalizadas)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        clienteData.nombre,
        clienteData.dni_cuit,
        clienteData.tipo_persona,
        clienteData.tipo_cliente,
        clienteData.tipo_cuenta_corriente,
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
        clienteData.suspendido,
        clienteData.perfil_cliente,
        clienteData.permite_excedente,
        clienteData.requiere_autorizacion,
        clienteData.usa_reglas_personalizadas
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
       SET nombre = ?, dni_cuit = ?, tipo_persona = ?, tipo_cliente = ?, tipo_cuenta_corriente = ?, telefono = ?, email = ?, contacto = ?,
           direccion = ?, localidad = ?, codigo_postal = ?, alias = ?, observaciones = ?, notas = ?, foto_url = ?,
           limite_fiado = ?, dias_vencimiento = ?, dia_vencimiento_fijo = ?, moneda = ?,
           habilita_cuenta_corriente = ?, activo = ?, suspendido = ?, perfil_cliente = ?, permite_excedente = ?, requiere_autorizacion = ?, usa_reglas_personalizadas = ?
       WHERE id = ?`,
      [
        clienteData.nombre,
        clienteData.dni_cuit,
        clienteData.tipo_persona,
        clienteData.tipo_cliente,
        clienteData.tipo_cuenta_corriente,
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
        clienteData.suspendido,
        clienteData.perfil_cliente,
        clienteData.permite_excedente,
        clienteData.requiere_autorizacion,
        clienteData.usa_reglas_personalizadas,
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

  let itemsVenta = itemsNormalizados;
  const hayModificadores = tieneModificadoresVenta(itemsNormalizados);
  if (hayModificadores) {
    try {
      itemsVenta = await resolverItemsVentaNormalConModificadores(itemsNormalizados);
    } catch (error) {
      return res.status(error.statusCode || 400).json({ message: error.message || "Modificadores invalidos" });
    }
  }

  try {
    const venta = await getQuery("SELECT * FROM ventas WHERE id = ?", [ventaId]);

    if (!venta || venta.tipo !== "pendiente" || venta.estado !== "pendiente") {
      return res.status(404).json({ message: "Ticket pendiente no encontrado" });
    }

    const oldItems = await getVentaDetalleRows(ventaId);
    const oldComponentesExtra = await getComponentesSnapshotVenta(ventaId);
    const oldComponentesExtraStockFisico = await filtrarComponentesSnapshotConStockFisico(oldComponentesExtra, oldItems);
    const newComponentesExtraStockFisico = await getComponentesItemsConStockFisico(itemsVenta);
    const total = calculateTotal(itemsVenta);

    await runQuery("BEGIN TRANSACTION");
    await applyStockDiff(oldItems, itemsVenta);
    await aplicarStockDiffComponentesExtra(oldComponentesExtraStockFisico, newComponentesExtraStockFisico);
    await cancelarAjustesPendientesVentaReceta(ventaId, {
      usuario: getUsuarioAuditoria(req),
      observaciones_admin: "Cancelado por edicion de ticket pendiente"
    });
    await borrarSnapshotsDetalles(oldItems);
    await borrarRecetaSnapshotVenta(oldItems);
    const detalles = await replaceVentaDetalle(ventaId, itemsVenta);
    if (hayModificadores) {
      await guardarSnapshotsModificadoresVenta(detalles);
    }
    await crearAjustesPendientesVentaReceta({
      ventaId,
      detalles,
      usuario: getUsuarioAuditoria(req),
      rol: req.usuario?.rol
    });
    await guardarRecetaSnapshotVenta(ventaId, detalles);
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
  // Cobros V2: normalizar si viene cobros[]
  let cobrosV2Cobrar = null;
  let tipoCobro = req.body.tipo_cobro;
  let montoEfectivoCobrar = req.body.monto_efectivo;
  let montoDebitoCobrar = req.body.monto_debito;
  let cuentaCobroIdCobrar = req.body.cuenta_cobro_id;
  if (Array.isArray(req.body.cobros) && req.body.cobros.length > 0) {
    const resultado = normalizarCobrosV2(req.body.cobros);
    if (resultado && resultado.error) return res.status(400).json({ message: resultado.error });
    cobrosV2Cobrar = resultado;
    const legacy = derivarCobroLegacy(cobrosV2Cobrar);
    tipoCobro = legacy.tipo_cobro;
    montoEfectivoCobrar = legacy.monto_efectivo;
    montoDebitoCobrar = legacy.monto_debito;
    cuentaCobroIdCobrar = legacy.cuenta_cobro_id;
  }

  try {
    const venta = await getQuery("SELECT * FROM ventas WHERE id = ?", [ventaId]);
    const cajaActiva = await getCajaAbiertaActual();

    if (!venta || venta.tipo !== "pendiente" || venta.estado !== "pendiente") {
      return res.status(404).json({ message: "Ticket pendiente no encontrado" });
    }

    if (!cajaActiva) {
      return res.status(400).json({ message: "No hay una caja abierta para cobrar el ticket" });
    }

    let recargo;
    if (cobrosV2Cobrar && tipoCobro === "mixto") {
      recargo = { ok: true, porcentaje_recargo: 0, recargo_monto: 0, cuotas: null, total: Number(venta.total) || 0 };
    } else {
      recargo = await calcularRecargoTipoPago({
        tipoPagoCodigo: tipoCobro,
        subtotal: Number(venta.total) || 0,
        cuotas: req.body.cuotas
      });
      if (!recargo.ok) {
        return res.status(400).json({ message: recargo.message || "Metodo de cobro invalido" });
      }
    }

    const cobroReal = resolveCobroData(
      recargo.total,
      tipoCobro,
      montoEfectivoCobrar,
      montoDebitoCobrar
    );

    if (!cobroReal) {
      return res.status(400).json({ message: "Datos de cobro invalidos" });
    }

    let cuentaCobro = { ok: true, cuenta_cobro_id: null };
    if (!(cobrosV2Cobrar && tipoCobro === "mixto")) {
      cuentaCobro = await validarCuentaCobroVenta(cuentaCobroIdCobrar, cobroReal);
      if (!cuentaCobro.ok) {
        return res.status(cuentaCobro.statusCode || 400).json({ message: cuentaCobro.message });
      }
    }

    await runQuery("BEGIN TRANSACTION");

    const resultCobrar = await runQuery(
      `UPDATE ventas
       SET estado = 'cobrada', total = ?, metodo_pago = ?, tipo_cobro = ?, monto_efectivo = ?, monto_debito = ?, caja_id = ?, cuenta_cobro_id = ?, recargo_porcentaje = ?, recargo_monto = ?
       WHERE id = ? AND estado = 'pendiente'`,
      [
        Number(venta.total),
        cobroReal.tipo_cobro,
        cobroReal.tipo_cobro,
        cobroReal.monto_efectivo,
        cobroReal.monto_debito,
        cajaActiva.id,
        cuentaCobro.cuenta_cobro_id,
        recargo.porcentaje_recargo,
        recargo.recargo_monto,
        ventaId
      ]
    );

    if (resultCobrar.changes === 0) {
      await runQuery("ROLLBACK");
      return res.status(409).json({ message: "La venta ya fue cobrada o no está pendiente." });
    }

    await registrarVentaCobros(ventaId, cobroReal, cuentaCobro.cuenta_cobro_id, null, cobrosV2Cobrar);

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
  if (!requerirClaveConfigurada(claveActual, res)) return;
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

    const resultAnular = await runQuery(
      `UPDATE ventas
       SET estado = 'anulado', metodo_pago = NULL
       WHERE id = ? AND estado = 'pendiente'`,
      [ventaId]
    );

    if (resultAnular.changes === 0) {
      await runQuery("ROLLBACK");
      return res.status(409).json({ message: "La venta ya fue anulada o no está pendiente." });
    }

    for (const item of items) {
      if (!item.producto_id) {
        continue;
      }

      await applyStockChange(item.producto_id, -Number(item.cantidad || 0));
    }
    await aplicarStockComponentesSnapshot(await filtrarDetallesConStockFisico(items), -1);
    await cancelarAjustesPendientesVentaReceta(ventaId, {
      usuario: getUsuarioAuditoria(req),
      observaciones_admin: "Cancelado por anulacion de ticket pendiente"
    });
    await borrarRecetaSnapshotVenta(items);

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

  // Cobros V2: normalizar si viene cobros[]
  let cobrosV2Patch = null;
  let tipoCobro_patch = req.body.tipo_cobro;
  let montoEfectivo_patch = req.body.monto_efectivo;
  let montoDebito_patch = req.body.monto_debito;
  let cuentaCobroId_patch = req.body.cuenta_cobro_id;
  if (Array.isArray(req.body.cobros) && req.body.cobros.length > 0) {
    const resultado = normalizarCobrosV2(req.body.cobros);
    if (resultado && resultado.error) return res.status(400).json({ message: resultado.error });
    cobrosV2Patch = resultado;
    const legacy = derivarCobroLegacy(cobrosV2Patch);
    tipoCobro_patch = legacy.tipo_cobro;
    montoEfectivo_patch = legacy.monto_efectivo;
    montoDebito_patch = legacy.monto_debito;
    cuentaCobroId_patch = legacy.cuenta_cobro_id;
  }

  try {
    const venta = await getQuery("SELECT * FROM ventas WHERE id = ?", [ventaId]);

    if (!venta || venta.estado !== "cobrada") {
      return res.status(404).json({ message: "Ticket cobrado no encontrado" });
    }

    const cobro = resolveCobroData(
      Number(venta.total) || 0,
      tipoCobro_patch,
      montoEfectivo_patch,
      montoDebito_patch
    );

    if (!cobro) {
      return res.status(400).json({ message: "Datos de cobro invalidos" });
    }

    let cuentaCobroFinal = venta.cuenta_cobro_id ?? null;
    if (!(cobrosV2Patch && tipoCobro_patch === "mixto")) {
      const hasCuentaEnBody = cobrosV2Patch ? true : Object.prototype.hasOwnProperty.call(req.body, "cuenta_cobro_id");
      if (hasCuentaEnBody) {
        const cuentaCobro = await validarCuentaCobroVenta(cuentaCobroId_patch, cobro);
        if (!cuentaCobro.ok) {
          return res.status(cuentaCobro.statusCode || 400).json({ message: cuentaCobro.message });
        }
        cuentaCobroFinal = cuentaCobro.cuenta_cobro_id;
      } else if (cuentaCobroFinal) {
        const cuentaCobro = await validarCuentaCobroVenta(cuentaCobroFinal, cobro);
        if (!cuentaCobro.ok) {
          return res.status(cuentaCobro.statusCode || 400).json({ message: cuentaCobro.message });
        }
      } else {
        const cuentaCobro = await validarCuentaCobroVenta(cuentaCobroFinal, cobro);
        if (!cuentaCobro.ok) {
          return res.status(cuentaCobro.statusCode || 400).json({ message: cuentaCobro.message });
        }
      }
    }

    await runQuery(
      `UPDATE ventas
       SET metodo_pago = ?, tipo_cobro = ?, monto_efectivo = ?, monto_debito = ?, cuenta_cobro_id = ?
       WHERE id = ?`,
      [cobro.tipo_cobro, cobro.tipo_cobro, cobro.monto_efectivo, cobro.monto_debito, cuentaCobroFinal, ventaId]
    );
    await runQuery("DELETE FROM venta_cobros WHERE venta_id = ?", [ventaId]);
    await registrarVentaCobros(ventaId, cobro, cuentaCobroFinal, null, cobrosV2Patch);

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
  if (!requerirClaveConfigurada(claveActual, res)) return;
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

    const resultAnular = await runQuery(
      `UPDATE ventas
       SET estado = 'anulado', metodo_pago = NULL, tipo_cobro = NULL, monto_efectivo = 0, monto_debito = 0
       WHERE id = ? AND estado = 'cobrada'`,
      [ventaId]
    );

    if (resultAnular.changes === 0) {
      await runQuery("ROLLBACK");
      return res.status(409).json({ message: "La venta ya fue anulada o no está cobrada." });
    }

    for (const item of items) {
      if (item.producto_id) {
        await applyStockChange(item.producto_id, -Number(item.cantidad || 0));
      }
    }
    await aplicarStockComponentesSnapshot(await filtrarDetallesConStockFisico(items), -1);
    await cancelarAjustesPendientesVentaReceta(ventaId, {
      usuario: getUsuarioAuditoria(req),
      observaciones_admin: "Cancelado por anulacion de venta cobrada"
    });
    await borrarRecetaSnapshotVenta(items);

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

app.post("/ventas/:id/anular-cc", async (req, res) => {
  const ventaId = Number(req.params.id);
  const authorizationCode = String(req.body.authorization_code || "").trim();

  if (!(await tienePermisoAccion(req, "ventas_anular_ticket"))) {
    return res.status(403).json({ message: "No tenes permisos para anular tickets" });
  }

  const claveActual = await getClaveAutorizacion();
  if (!requerirClaveConfigurada(claveActual, res)) return;
  if (authorizationCode !== claveActual) {
    return res.status(403).json({ message: "Codigo de autorizacion incorrecto" });
  }

  try {
    const venta = await getQuery("SELECT * FROM ventas WHERE id = ?", [ventaId]);

    if (!venta || venta.estado !== "cuenta_corriente_pendiente" || !venta.es_cuenta_corriente) {
      return res.status(404).json({ message: "Venta de cuenta corriente pendiente no encontrada" });
    }

    const cobroActivo = await getQuery(
      `SELECT 1 FROM pagos_cuenta_corriente
       WHERE venta_id = ?
         AND tipo_movimiento = 'cobro'
         AND COALESCE(revertido, 0) = 0
       LIMIT 1`,
      [ventaId]
    );

    if (cobroActivo) {
      return res.status(409).json({
        message: "La venta tiene cobros aplicados. Revertí primero los cobros desde Cuenta Corriente."
      });
    }

    const items = await getVentaDetalleRows(ventaId);

    await runQuery("BEGIN TRANSACTION");

    const resultAnular = await runQuery(
      `UPDATE ventas
       SET estado = 'anulado', saldo_pendiente = 0
       WHERE id = ? AND estado = 'cuenta_corriente_pendiente'`,
      [ventaId]
    );

    if (resultAnular.changes === 0) {
      await runQuery("ROLLBACK");
      return res.status(409).json({ message: "La venta ya fue anulada o no está pendiente en cuenta corriente." });
    }

    for (const item of items) {
      if (item.producto_id) {
        await applyStockChange(item.producto_id, -Number(item.cantidad || 0));
      }
    }
    await aplicarStockComponentesSnapshot(await filtrarDetallesConStockFisico(items), -1);
    await cancelarAjustesPendientesVentaReceta(ventaId, {
      usuario: getUsuarioAuditoria(req),
      observaciones_admin: "Cancelado por anulacion de venta cuenta corriente"
    });
    await borrarRecetaSnapshotVenta(items);
    await borrarSnapshotsDetalles(items);

    await runQuery("COMMIT");

    return res.json({ message: `Venta CC #${ventaId} anulada` });
  } catch (error) {
    try {
      await runQuery("ROLLBACK");
    } catch (rollbackError) {
      logError("Rollback anulacion CC", rollbackError);
    }

    logError("Error al anular venta CC:", error);
    return res.status(500).json({ message: "Error al anular venta de cuenta corriente" });
  }
});

app.get("/ventas/:id/receta-snapshot", async (req, res) => {
  const ventaId = Number(req.params.id);
  try {
    const snapshots = await allQuery(
      `SELECT *
       FROM detalle_venta_receta_snapshot
       WHERE venta_id = ?
       ORDER BY detalle_venta_id ASC, componente_nombre_snapshot ASC`,
      [ventaId]
    );
    return res.json({ venta_id: ventaId, snapshots });
  } catch (error) {
    logError("Error al obtener snapshot de receta:", error);
    return res.status(500).json({ message: "Error al obtener snapshot de receta" });
  }
});

// Consultar ventas
app.get("/ventas", async (req, res) => {
  try {
    const limite = Math.min(Number(req.query.limit) || 500, 2000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const ventas = await allQuery(
      `SELECT v.*, cc.nombre AS cuenta_cobro_nombre
       FROM ventas v
       LEFT JOIN cuentas_cobro cc ON cc.id = v.cuenta_cobro_id
       WHERE COALESCE(v.tipo, '') != 'test_modificadores'
       ORDER BY v.id DESC LIMIT ? OFFSET ?`,
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
      `SELECT dv.*
       FROM detalle_ventas dv
       INNER JOIN ventas v ON v.id = dv.venta_id
       WHERE COALESCE(v.tipo, '') != 'test_modificadores'
       ORDER BY dv.id DESC`
    );
    return res.json(detalleVentas);
  } catch (error) {
    logError("Error al listar detalle de ventas:", error);
    return res.status(500).json({ message: "Error al obtener detalle de ventas" });
  }
});

app.get("/finanzas/resumen", async (req, res) => {
  if (!puedeRol(req, ROLES.ADMIN)) {
    return res.status(403).json({ message: "No tenes permisos para acceder al resumen financiero" });
  }

  const { desde = null, hasta = null } = req.query;

  try {
    return res.json(await getResumenFinanciero({ desde, hasta }));
  } catch (error) {
    logError("Error al obtener resumen financiero:", error);
    return res.status(500).json({ message: "Error al obtener resumen financiero" });
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

const REPORTES_OPERATIVOS = new Set([
  "ventas",
  "ventas-por-dia",
  "productos-mas-vendidos"
]);

function puedeAccederReporte(req, modulo) {
  const rol = normalizarRol(req.usuario?.rol);
  if (rol === "admin") return true;
  if (rol === "encargado" || rol === "colaborador") return REPORTES_OPERATIVOS.has(modulo);
  return false;
}

function asegurarAccesoReporte(req, res, modulo) {
  if (puedeAccederReporte(req, modulo)) return true;
  res.status(403).json({ message: "No tenes permisos para acceder a este reporte" });
  return false;
}

function normalizarFormatoReporte(formato) {
  return formato === "pdf" ? "pdf" : "xlsx";
}

function nombreArchivoReporte(modulo, desde, hasta, formato) {
  return `${modulo}_${desde}_${hasta}.${normalizarFormatoReporte(formato)}`;
}

function sanitizarCsvCelda(value) {
  const str = String(value == null ? "" : value);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function escaparHtmlExport(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function generarCSV(headers, rows) {
  const lineas = [
    headers.map(sanitizarCsvCelda).join(","),
    ...rows.map((row) => row.map(sanitizarCsvCelda).join(","))
  ];
  return "﻿" + lineas.join("\r\n");
}

function generarXLS(headers, rows) {
  const ths = headers.map((h) => `<th>${escaparHtmlExport(h)}</th>`).join("");
  const trs = rows.map((row) =>
    `<tr>${row.map((cell) => `<td>${escaparHtmlExport(cell)}</td>`).join("")}</tr>`
  ).join("");
  return `<html><head><meta charset="utf-8"></head><body>` +
    `<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>` +
    `</body></html>`;
}

function responderArchivoExport(res, contenido, filename, formato) {
  const safe = filename.replace(/[^\w._-]/g, "_");
  if (formato === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safe}"`);
    return res.send(contenido);
  }
  res.setHeader("Content-Type", "application/vnd.ms-excel; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${safe}"`);
  return res.send(contenido);
}

function mapearFilasExport(modulo, datos) {
  switch (modulo) {
    case "generales": {
      const headers = ["Indicador", "Valor"];
      const rows = [
        ["Ventas totales", datos.ventas_totales ?? ""],
        ["Pagos totales", datos.pagos_totales ?? ""],
        ["Balance general", datos.balance_general ?? ""],
        ["IVA crédito fiscal", datos.iva_credito_fiscal ?? ""],
        ["Operaciones (ventas)", datos.total_ventas ?? ""],
        ["Ticket promedio", datos.ticket_promedio ?? ""]
      ];
      return { headers, rows };
    }
    case "ventas": {
      const headers = ["Fecha", "Cantidad ventas", "Total", "Ticket promedio"];
      const rows = (datos.por_dia || []).map((row) => [
        row.fecha || "",
        row.cantidad_ventas ?? 0,
        row.total ?? 0,
        row.ticket_promedio ?? 0
      ]);
      return { headers, rows };
    }
    case "caja": {
      const headers = ["Fecha", "Concepto", "Tipo", "Ingreso", "Egreso", "Método", "Cuenta"];
      const rows = (datos.movimientos || []).map((row) => [
        (row.fecha || "").slice(0, 10),
        row.concepto || row.tipo_operacion || "",
        Number(row.ingreso || 0) > 0 ? "Ingreso" : "Egreso",
        row.ingreso ?? 0,
        row.egreso ?? 0,
        row.metodo || "",
        row.cuenta_nombre || ""
      ]);
      return { headers, rows };
    }
    case "stock": {
      const headers = ["Código", "Producto", "Categoría", "Tipo", "Stock físico", "Stock mínimo", "Estado stock", "Valorizado est."];
      const rows = (datos.productos || []).map((row) => [
        row.codigo || `#${row.producto_id}`,
        row.nombre || "",
        row.categoria || "",
        row.tipo || "",
        row.stock_fisico ?? 0,
        row.stock_minimo ?? 0,
        row.estado_stock || "",
        row.stock_valorizado_estimado ?? 0
      ]);
      return { headers, rows };
    }
    case "cuentas-corrientes": {
      const headers = ["Cliente", "DNI/CUIT", "Deuda actual", "Límite crédito", "Cobrado período", "Excedido", "Estado"];
      const rows = (datos.clientes || []).map((row) => [
        row.nombre || "",
        row.dni_cuit || "",
        row.deuda_actual ?? 0,
        row.limite_credito ?? 0,
        row.cobrado_periodo ?? 0,
        row.excedido ? "Sí" : "No",
        row.excedido ? "Excedido" : (row.deuda_actual > 0 ? "Con deuda" : "Sin deuda")
      ]);
      return { headers, rows };
    }
    case "proveedores-pagos": {
      const headers = ["Proveedor", "CUIT", "Tipo impacto", "Pagado período", "Pendiente", "IVA crédito fiscal", "Cantidad pagos", "Última compra"];
      const rows = (datos.proveedores || []).map((row) => [
        row.proveedor_nombre || "",
        row.cuit || "",
        row.tipo_impacto || "",
        row.total_pagado ?? 0,
        row.total_pendiente ?? 0,
        row.iva_credito_fiscal ?? 0,
        row.cantidad_pagos ?? 0,
        row.ultima_compra || ""
      ]);
      return { headers, rows };
    }
    default:
      return { headers: ["Sin datos"], rows: [] };
  }
}

app.get("/reportes/resumen", async (req, res) => {
  if (!asegurarAccesoReporte(req, res, "generales")) return;
  const { desde = null, hasta = null } = req.query;
  try {
    return res.json(await getResumenReportes({ desde, hasta }));
  } catch (error) {
    logError("Error al obtener resumen de reportes:", error);
    return res.status(500).json({ message: "Error al obtener resumen" });
  }
});

app.get("/reportes/ventas", async (req, res) => {
  if (!asegurarAccesoReporte(req, res, "ventas")) return;
  const { desde = null, hasta = null, estado = null } = req.query;
  try {
    return res.json(await getReporteVentas({ desde, hasta, estado }));
  } catch (error) {
    logError("Error al obtener reporte de ventas:", error);
    return res.status(500).json({ message: "Error al obtener reporte de ventas" });
  }
});

app.get("/reportes/caja", async (req, res) => {
  if (!asegurarAccesoReporte(req, res, "caja")) return;
  const {
    desde = null,
    hasta = null,
    caja_id = null,
    cuenta_cobro_id = null,
    estado = null
  } = req.query;

  try {
    return res.json(await getReporteCaja({
      desde,
      hasta,
      cajaId: caja_id,
      cuentaCobroId: cuenta_cobro_id,
      estado
    }));
  } catch (error) {
    logError("Error al obtener reporte de caja:", error);
    return res.status(500).json({ message: "Error al obtener reporte de caja" });
  }
});

app.get("/reportes/stock", async (req, res) => {
  if (!asegurarAccesoReporte(req, res, "stock")) return;
  const {
    categoria = null,
    bajo_stock = null,
    sin_stock = null,
    activo = null,
    tipo = null,
    maneja_stock = null,
    desde = null,
    hasta = null
  } = req.query;

  try {
    return res.json(await getReporteStock({
      categoria,
      bajoStock: bajo_stock,
      sinStock: sin_stock,
      activo,
      tipo,
      manejaStock: maneja_stock,
      desde,
      hasta
    }));
  } catch (error) {
    logError("Error al obtener reporte de stock:", error);
    return res.status(500).json({ message: "Error al obtener reporte de stock" });
  }
});

app.get("/reportes/cuentas-corrientes", async (req, res) => {
  if (!asegurarAccesoReporte(req, res, "cuentas-corrientes")) return;
  const {
    desde = null,
    hasta = null,
    cliente_id = null,
    estado = null,
    activo = "todos"
  } = req.query;

  try {
    return res.json(await getReporteCuentasCorrientes({
      desde,
      hasta,
      clienteId: cliente_id,
      estado,
      activo
    }));
  } catch (error) {
    logError("Error al obtener reporte de cuentas corrientes:", error);
    return res.status(500).json({ message: "Error al obtener reporte de cuentas corrientes" });
  }
});

app.get("/reportes/productos-mas-vendidos", async (req, res) => {
  if (!asegurarAccesoReporte(req, res, "productos-mas-vendidos")) return;
  const { desde = null, hasta = null, limite = 20 } = req.query;
  try {
    return res.json(await getProductosMasVendidos({ desde, hasta, limite }));
  } catch (error) {
    logError("Error al obtener productos mas vendidos:", error);
    return res.status(500).json({ message: "Error al obtener productos mas vendidos" });
  }
});

app.get("/reportes/proveedores-pagos", async (req, res) => {
  if (!asegurarAccesoReporte(req, res, "proveedores-pagos")) return;
  const { desde = null, hasta = null, proveedor_id = null, estado = null, activo = null } = req.query;
  try {
    return res.json(await getResumenProveedoresPagos({ desde, hasta, proveedor_id, estado, activo }));
  } catch (error) {
    logError("Error al obtener resumen de proveedores y pagos:", error);
    return res.status(500).json({ message: "Error al obtener resumen de proveedores y pagos" });
  }
});

app.get("/reportes/ventas-por-dia", async (req, res) => {
  if (!asegurarAccesoReporte(req, res, "ventas-por-dia")) return;
  const { desde = null, hasta = null } = req.query;
  try {
    return res.json(await getVentasPorDia({ desde, hasta }));
  } catch (error) {
    logError("Error al obtener ventas por dia:", error);
    return res.status(500).json({ message: "Error al obtener ventas por dia" });
  }
});

app.get("/reportes/cuentas-cobro", async (req, res) => {
  if (!asegurarAccesoReporte(req, res, "cuentas-cobro")) return;
  const { desde = null, hasta = null } = req.query;
  try {
    return res.json(await getResumenCuentasCobro({ desde, hasta }));
  } catch (error) {
    logError("Error al obtener reporte de cuentas de cobro:", error);
    return res.status(500).json({ message: "Error al obtener reporte de cuentas de cobro" });
  }
});

app.get("/reportes/modificadores", async (req, res) => {
  if (!asegurarAccesoReporte(req, res, "ventas")) return;
  const { desde = null, hasta = null } = req.query;
  try {
    return res.json(await getReporteModificadores({ desde, hasta }));
  } catch (error) {
    logError("Error al obtener reporte de modificadores:", error);
    return res.status(500).json({ message: "Error al obtener reporte de modificadores" });
  }
});

app.get("/reportes/desvios-receta", async (req, res) => {
  if (!asegurarAccesoReporte(req, res, "stock")) return;
  const { desde = null, hasta = null } = req.query;
  try {
    return res.json(await getReporteDesviosReceta({ desde, hasta }));
  } catch (error) {
    logError("Error al obtener reporte de desvíos de receta:", error);
    return res.status(500).json({ message: "Error al obtener reporte de desvíos de receta" });
  }
});

app.get("/reportes/salud-inventario", async (req, res) => {
  if (!asegurarAccesoReporte(req, res, "stock")) return;
  try {
    return res.json(await getReporteSaludInventario());
  } catch (error) {
    logError("Error al obtener reporte de salud de inventario:", error);
    return res.status(500).json({ message: "Error al obtener reporte de salud de inventario" });
  }
});

app.get("/reportes/dependencia-insumos", async (req, res) => {
  if (!asegurarAccesoReporte(req, res, "stock")) return;
  try {
    return res.json(await getReporteDependenciaInsumos());
  } catch (error) {
    logError("Error al obtener reporte de dependencia de insumos:", error);
    return res.status(500).json({ message: "Error al obtener reporte de dependencia de insumos" });
  }
});

app.get("/reportes/riesgo-ventas", async (req, res) => {
  if (!asegurarAccesoReporte(req, res, "stock")) return;
  const { desde = null, hasta = null } = req.query;
  try {
    return res.json(await getReporteRiesgoVentas({ desde, hasta }));
  } catch (error) {
    logError("Error al obtener reporte de riesgo de ventas:", error);
    return res.status(500).json({ message: "Error al obtener reporte de riesgo de ventas" });
  }
});

app.get("/reportes/rentabilidad-productos", async (req, res) => {
  if (!asegurarAccesoReporte(req, res, "ventas")) return;
  const { desde = null, hasta = null } = req.query;
  try {
    return res.json(await getReporteRentabilidadProductos({ desde, hasta }));
  } catch (error) {
    logError("Error al obtener reporte de rentabilidad por producto:", error);
    return res.status(500).json({ message: "Error al obtener reporte de rentabilidad por producto" });
  }
});

app.get("/reportes/rentabilidad-categorias", async (req, res) => {
  if (!asegurarAccesoReporte(req, res, "ventas")) return;
  const { desde = null, hasta = null } = req.query;
  try {
    return res.json(await getReporteRentabilidadCategorias({ desde, hasta }));
  } catch (error) {
    logError("Error al obtener reporte de rentabilidad por categoría:", error);
    return res.status(500).json({ message: "Error al obtener reporte de rentabilidad por categoría" });
  }
});

app.get("/reportes/dashboard-ejecutivo", async (req, res) => {
  if (!asegurarAccesoReporte(req, res, "generales")) return;
  const { desde = null, hasta = null } = req.query;
  try {
    return res.json(await getReporteDashboardEjecutivo({ desde, hasta }));
  } catch (error) {
    logError("Error al obtener dashboard ejecutivo:", error);
    return res.status(500).json({ message: "Error al obtener dashboard ejecutivo" });
  }
});

app.get("/reportes/exportar", async (req, res) => {
  const { modulo, desde = null, hasta = null, formato = "excel" } = req.query;

  if (!REPORTES_MODULOS.has(modulo)) {
    return res.status(400).json({ message: "Modulo de reporte invalido" });
  }
  if (!asegurarAccesoReporte(req, res, modulo)) return;

  const formatoNorm = formato === "csv" ? "csv" : "excel";
  const ext = formatoNorm === "csv" ? "csv" : "xls";
  const desdeStr = desde || "sin-fecha";
  const hastaStr = hasta || "sin-fecha";
  const filename = `reporte_${modulo}_${desdeStr}_${hastaStr}.${ext}`;

  try {
    let datos;
    switch (modulo) {
      case "generales":
        datos = await getResumenReportes({ desde, hasta });
        break;
      case "ventas":
        datos = await getReporteVentas({ desde, hasta });
        break;
      case "caja":
        datos = await getReporteCaja({ desde, hasta });
        break;
      case "stock":
        datos = await getReporteStock({ desde, hasta });
        break;
      case "cuentas-corrientes":
        datos = await getReporteCuentasCorrientes({ desde, hasta });
        break;
      case "proveedores-pagos":
        datos = await getResumenProveedoresPagos({ desde, hasta });
        break;
      default:
        return res.status(400).json({ message: "Modulo no soportado" });
    }

    const { headers, rows } = mapearFilasExport(modulo, datos);
    const contenido = formatoNorm === "csv" ? generarCSV(headers, rows) : generarXLS(headers, rows);
    return responderArchivoExport(res, contenido, filename, formatoNorm);
  } catch (error) {
    logError("Error al exportar reporte:", error);
    return res.status(500).json({ message: "Error al generar exportacion" });
  }
});

app.get("/configuracion", async (req, res) => {
  try {
    const configCompleta = await getConfiguracionGlobal();
    const config = sanitizarConfiguracionParaRol(configCompleta, req.usuario?.rol);
    return res.json({
      config,
      schema: Object.fromEntries(
        Object.entries(CONFIGURACION_DEFAULTS)
          .filter(([clave]) => Object.prototype.hasOwnProperty.call(config, clave))
          .map(([clave, item]) => [clave, item.seccion])
      )
    });
  } catch (error) {
    logError("Error al obtener configuracion:", error);
    return res.status(500).json({ message: "Error al obtener configuracion" });
  }
});

app.post("/autorizacion/validar", rateLimitAutorizacion, async (req, res) => {
  const clave = String(req.body?.clave || "").trim();
  const claveActual = await getClaveAutorizacion();
  if (!requerirClaveConfigurada(claveActual, res)) return;
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

// ── Tienda pública QR ──────────────────────────────────────────────────────────

app.get("/tienda/publica", async (req, res) => {
  try {
    const config = await getConfiguracionGlobal();
    return res.json({
      nombre: config.negocio_nombre_comercial || "Tienda",
      logo_url: config.negocio_logo_url || ""
    });
  } catch (error) {
    logError("GET /tienda/publica", error);
    return res.status(500).json({ message: "Error al cargar datos del local" });
  }
});

app.get("/tienda/publica/productos", async (req, res) => {
  try {
    const [rows, config] = await Promise.all([
      allQuery(`
        SELECT p.id, p.nombre, p.precio_venta AS precio, p.descripcion, p.unidad_medida,
               p.maneja_stock, p.stock, p.imagen_url,
               c.id AS categoria_id, c.nombre AS categoria_nombre,
               EXISTS(
                 SELECT 1 FROM producto_modificadores pm
                 INNER JOIN modificadores m ON m.id = pm.modificador_id
                 WHERE pm.producto_id = p.id AND pm.activo = 1 AND m.activo = 1
               ) AS tiene_modificadores,
               EXISTS(
                 SELECT 1 FROM producto_ingredientes_visibles piv
                 WHERE piv.producto_id = p.id AND piv.activo = 1
               ) AS tiene_ingredientes_visibles
        FROM productos p
        LEFT JOIN categorias c ON c.id = p.categoria_id
        WHERE p.activo = 1 AND COALESCE(p.eliminado, 0) = 0
        ORDER BY c.nombre ASC, p.nombre ASC
      `),
      getConfiguracionGlobal()
    ]);

    const catCSV = String(config.dashboard_pizarra_categorias || "");
    const prodCSV = String(config.dashboard_pizarra_productos || "");
    const catDestacadas = new Set(
      catCSV.split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
    );
    const idDestacados = new Set(
      prodCSV.split(",").map(s => Number(s.trim())).filter(n => n > 0)
    );

    const productos = rows.map(p => {
      const catNombre = (p.categoria_nombre || "").toLowerCase();
      const destacado = catDestacadas.has(catNombre) || idDestacados.has(p.id);
      return {
        id: p.id,
        nombre: p.nombre,
        precio: Number(p.precio) || 0,
        descripcion: p.descripcion || "",
        unidad_medida: p.unidad_medida || "unidad",
        categoria_id: p.categoria_id || null,
        categoria_nombre: p.categoria_nombre || "General",
        imagen_url: p.imagen_url || "",
        disponible: Number(p.maneja_stock) === 0 ? true : Number(p.stock) > 0,
        tiene_modificadores: p.tiene_modificadores === 1,
        tiene_ingredientes_visibles: p.tiene_ingredientes_visibles === 1,
        destacado
      };
    });

    // Categorías con productos activos (para el catálogo completo)
    const categoriasSet = [...new Set(productos.map(p => p.categoria_nombre))].sort();

    // Categorías destacadas: solo las configuradas que tienen al menos un producto
    const categoriasDestacadas = catDestacadas.size > 0
      ? categoriasSet.filter(nombre => catDestacadas.has(nombre.toLowerCase()))
      : [];

    // Productos destacados por ID explícito (subconjunto de productos)
    const productosDestacados = idDestacados.size > 0
      ? productos.filter(p => idDestacados.has(p.id))
      : [];

    return res.json({
      categorias_destacadas: categoriasDestacadas,
      productos_destacados: productosDestacados,
      categorias: categoriasSet,
      productos
    });
  } catch (error) {
    logError("GET /tienda/publica/productos", error);
    return res.status(500).json({ message: "Error al cargar productos" });
  }
});

app.get("/tienda/publica/productos/:id/modificadores", async (req, res) => {
  try {
    const productoId = Number(req.params.id);
    if (!productoId || productoId <= 0) return res.status(400).json({ message: "ID inválido." });
    const producto = await getQuery(
      "SELECT id FROM productos WHERE id = ? AND activo = 1 AND COALESCE(eliminado, 0) = 0",
      [productoId]
    );
    if (!producto) return res.status(404).json({ message: "Producto no encontrado." });
    const mods = await getModificadoresProducto(productoId);
    return res.json(mods.map(m => ({
      modificador_id: m.id,
      nombre: m.nombre,
      tipo: m.tipo,
      precio_extra: Number(m.precio_extra) || 0,
      obligatorio: m.obligatorio === 1,
      max_usos: Number(m.max_usos) || 1,
      orden: Number(m.orden) || 0
    })));
  } catch (error) {
    logError("GET /tienda/publica/productos/:id/modificadores", error);
    return res.status(500).json({ message: "Error al cargar extras del producto." });
  }
});

app.get("/tienda/publica/productos/:id/ingredientes", async (req, res) => {
  try {
    const productoId = Number(req.params.id);
    if (!productoId || productoId <= 0) return res.status(400).json({ message: "ID inválido." });
    const producto = await getQuery(
      "SELECT id FROM productos WHERE id = ? AND activo = 1 AND COALESCE(eliminado, 0) = 0",
      [productoId]
    );
    if (!producto) return res.status(404).json({ message: "Producto no encontrado." });
    const ingredientes = await allQuery(
      `SELECT id, nombre, incluido_por_defecto, permite_quitar, permite_extra, precio_extra, orden
       FROM producto_ingredientes_visibles
       WHERE producto_id = ? AND activo = 1
       ORDER BY orden ASC, id ASC`,
      [productoId]
    );
    return res.json(ingredientes.map(i => ({
      id: i.id,
      nombre: i.nombre,
      incluido_por_defecto: i.incluido_por_defecto === 1,
      permite_quitar: i.permite_quitar === 1,
      permite_extra: i.permite_extra === 1,
      precio_extra: Number(i.precio_extra) || 0,
      orden: Number(i.orden) || 0
    })));
  } catch (error) {
    logError("GET /tienda/publica/productos/:id/ingredientes", error);
    return res.status(500).json({ message: "Error al cargar ingredientes del producto." });
  }
});

app.post("/tienda/publica/pedidos", async (req, res) => {
  const { cliente_nombre, cliente_telefono, observacion, items } = req.body || {};

  const nombreCliente = String(cliente_nombre || "").trim();
  if (!nombreCliente) {
    return res.status(400).json({ message: "El nombre es obligatorio." });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "El pedido debe tener al menos un producto." });
  }

  const itemsValidados = [];
  for (const item of items) {
    const productoId = Number(item.producto_id);
    const cantidad = Number(item.cantidad);
    if (!Number.isInteger(productoId) || productoId <= 0) {
      return res.status(400).json({ message: "Producto inválido en el pedido." });
    }
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      return res.status(400).json({ message: "Cantidad inválida en el pedido." });
    }
    if (cantidad > 100) {
      return res.status(400).json({ message: "La cantidad máxima por producto es 100" });
    }
    const mods = Array.isArray(item.modificadores) ? item.modificadores : [];
    for (const mod of mods) {
      const modId = Number(mod.modificador_id);
      const modCant = Number(mod.cantidad || 1);
      if (!Number.isInteger(modId) || modId <= 0) {
        return res.status(400).json({ message: "modificador_id inválido en el pedido." });
      }
      if (!Number.isFinite(modCant) || modCant < 1 || !Number.isInteger(modCant)) {
        return res.status(400).json({ message: "Cantidad de modificador debe ser un entero mayor a 0." });
      }
    }
    const ings = Array.isArray(item.ingredientes) ? item.ingredientes : [];
    for (const ing of ings) {
      const ingId = Number(ing.ingrediente_id);
      if (!Number.isInteger(ingId) || ingId <= 0) {
        return res.status(400).json({ message: "ingrediente_id inválido en el pedido." });
      }
      const tipo = String(ing.tipo || "").toLowerCase();
      if (tipo !== "quitar" && tipo !== "extra") {
        return res.status(400).json({ message: `Tipo de ingrediente inválido: "${ing.tipo}". Debe ser "quitar" o "extra".` });
      }
    }
    itemsValidados.push({
      producto_id: productoId,
      cantidad,
      observacion: String(item.observacion || "").trim(),
      modificadores: mods,
      ingredientes: ings
    });
  }

  try {
    const ids = itemsValidados.map(i => i.producto_id);
    const ph = ids.map(() => "?").join(",");
    const [productos, modsAsociadas, ingsAsociados] = await Promise.all([
      allQuery(
        `SELECT id, nombre, precio_venta, maneja_stock, stock, activo, COALESCE(eliminado, 0) AS eliminado FROM productos WHERE id IN (${ph})`,
        ids
      ),
      allQuery(
        `SELECT pm.producto_id, pm.modificador_id, pm.max_usos, m.nombre, m.tipo, m.precio_extra
         FROM producto_modificadores pm
         INNER JOIN modificadores m ON m.id = pm.modificador_id
         WHERE pm.producto_id IN (${ph}) AND pm.activo = 1 AND m.activo = 1`,
        ids
      ),
      allQuery(
        `SELECT id, producto_id, nombre, permite_quitar, permite_extra, precio_extra
         FROM producto_ingredientes_visibles
         WHERE producto_id IN (${ph}) AND activo = 1`,
        ids
      )
    ]);

    const productosMap = Object.fromEntries(productos.map(p => [p.id, p]));
    const modsMap = {};
    for (const row of modsAsociadas) {
      modsMap[`${row.producto_id}:${row.modificador_id}`] = row;
    }
    const ingsMap = {};
    for (const row of ingsAsociados) {
      ingsMap[`${row.producto_id}:${row.id}`] = row;
    }

    for (const item of itemsValidados) {
      const p = productosMap[item.producto_id];
      if (!p || !p.activo || p.eliminado) {
        return res.status(400).json({ message: `Producto no disponible (id ${item.producto_id}).` });
      }
    }

    // Validate modifiers and calculate prices before transaction
    const itemsConPrecio = [];
    for (const item of itemsValidados) {
      const p = productosMap[item.producto_id];
      let precioExtrasTotal = 0;
      const modsValidados = [];

      for (const mod of item.modificadores) {
        const modId = Number(mod.modificador_id);
        const modCant = Number(mod.cantidad || 1);
        const assoc = modsMap[`${item.producto_id}:${modId}`];
        if (!assoc) {
          return res.status(400).json({ message: `Modificador no disponible para el producto solicitado.` });
        }
        if (modCant > (Number(assoc.max_usos) || 1)) {
          return res.status(400).json({ message: `Cantidad excede el límite del modificador "${assoc.nombre}".` });
        }
        const precioExtra = assoc.tipo === "observacion" ? 0 : Number(assoc.precio_extra) || 0;
        precioExtrasTotal += precioExtra * modCant;
        modsValidados.push({ modId, modCant, assoc, precioExtra });
      }

      let precioIngExtrasTotal = 0;
      const ingsValidados = [];
      for (const ing of item.ingredientes) {
        const ingId = Number(ing.ingrediente_id);
        const tipo = String(ing.tipo || "").toLowerCase();
        const dbIng = ingsMap[`${item.producto_id}:${ingId}`];
        if (!dbIng) {
          return res.status(400).json({ message: "Ingrediente no disponible para el producto solicitado." });
        }
        if (tipo === "quitar" && !dbIng.permite_quitar) {
          return res.status(400).json({ message: `El ingrediente "${dbIng.nombre}" no se puede quitar.` });
        }
        if (tipo === "extra" && !dbIng.permite_extra) {
          return res.status(400).json({ message: `El ingrediente "${dbIng.nombre}" no se puede agregar como extra.` });
        }
        const precioExtra = tipo === "extra" ? (Number(dbIng.precio_extra) || 0) : 0;
        precioIngExtrasTotal += precioExtra;
        ingsValidados.push({
          ingId,
          tipo,
          nombre: dbIng.nombre,
          precioExtra,
          nota: String(ing.nota || "").trim().slice(0, 200) || null
        });
      }

      const precioBase = Number(p.precio_venta) || 0;
      const precioUnitarioFinal = Number((precioBase + precioExtrasTotal + precioIngExtrasTotal).toFixed(2));
      const subtotal = Number((precioUnitarioFinal * item.cantidad).toFixed(2));
      const estadoStock = Number(p.maneja_stock) === 0 ? "disponible" : Number(p.stock) > 0 ? "disponible" : "sin_stock";
      itemsConPrecio.push({ ...item, p, precioUnitarioFinal, subtotal, estadoStock, modsValidados, ingsValidados });
    }

    const ahora = new Date().toISOString();
    const codigoPublico = "PED-" + Date.now().toString(36).toUpperCase().slice(-6);
    let totalEstimado = 0;

    await runQuery("BEGIN TRANSACTION");
    const pedidoResult = await runQuery(
      `INSERT INTO tienda_pedidos (codigo_publico, cliente_nombre, cliente_telefono, observacion, estado, total_estimado, origen, creado_en, actualizado_en)
       VALUES (?, ?, ?, ?, 'recibido', 0, 'qr', ?, ?)`,
      [codigoPublico, nombreCliente, String(cliente_telefono || "").trim() || null, String(observacion || "").trim() || null, ahora, ahora]
    );
    const pedidoId = pedidoResult.lastID;

    for (const item of itemsConPrecio) {
      totalEstimado += item.subtotal;
      const itemResult = await runQuery(
        `INSERT INTO tienda_pedido_items (pedido_id, producto_id, producto_nombre_snapshot, cantidad, precio_unitario_snapshot, subtotal_snapshot, observacion, estado_stock_snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [pedidoId, item.producto_id, item.p.nombre, item.cantidad, item.precioUnitarioFinal, item.subtotal, item.observacion || null, item.estadoStock]
      );
      const itemId = itemResult.lastID;
      for (const { modId, modCant, assoc, precioExtra } of item.modsValidados) {
        const subtotalMod = Number((precioExtra * modCant).toFixed(2));
        await runQuery(
          `INSERT INTO tienda_pedido_item_modificadores (pedido_item_id, modificador_id, modificador_nombre_snapshot, tipo_snapshot, cantidad, precio_extra_snapshot, subtotal_snapshot)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [itemId, modId, assoc.nombre, assoc.tipo, modCant, precioExtra, subtotalMod]
        );
      }
      for (const { ingId, tipo, nombre, precioExtra, nota } of item.ingsValidados) {
        await runQuery(
          `INSERT INTO tienda_pedido_item_ingredientes (pedido_item_id, ingrediente_id, tipo, nombre_snapshot, precio_extra_snapshot, cantidad, nota)
           VALUES (?, ?, ?, ?, ?, 1, ?)`,
          [itemId, ingId, tipo, nombre, precioExtra, nota]
        );
      }
    }

    await runQuery("UPDATE tienda_pedidos SET total_estimado = ? WHERE id = ?", [Number(totalEstimado.toFixed(2)), pedidoId]);
    await runQuery("COMMIT");

    return res.status(201).json({
      ok: true,
      codigo_publico: codigoPublico,
      total_estimado: Number(totalEstimado.toFixed(2))
    });
  } catch (error) {
    try { await runQuery("ROLLBACK"); } catch {}
    logError("POST /tienda/publica/pedidos", error);
    return res.status(500).json({ message: "Error al crear el pedido. Intentá de nuevo." });
  }
});

// ── Fin Tienda pública QR ──────────────────────────────────────────────────────

// ── Tienda interna — gestión de pedidos ───────────────────────────────────────

function checkTiendaPermiso(req, res) {
  const rol = normalizarRol(req.usuario?.rol || "");
  if (!["admin", "encargado", "colaborador"].includes(rol)) {
    res.status(403).json({ message: "No tenes permisos para gestionar pedidos de tienda." });
    return false;
  }
  return true;
}

app.get("/tienda/pedidos/resumen", async (req, res) => {
  if (!checkTiendaPermiso(req, res)) return;
  try {
    const row = await getQuery(`
      SELECT
        SUM(CASE WHEN estado='recibido' THEN 1 ELSE 0 END) AS recibidos,
        SUM(CASE WHEN estado='aceptado' THEN 1 ELSE 0 END) AS aceptados,
        SUM(CASE WHEN estado='preparando' THEN 1 ELSE 0 END) AS preparando,
        SUM(CASE WHEN estado='listo' THEN 1 ELSE 0 END) AS listos
      FROM tienda_pedidos
      WHERE estado NOT IN ('rechazado', 'cancelado', 'convertido_venta')
    `);
    return res.json({
      recibidos: Number(row?.recibidos) || 0,
      aceptados: Number(row?.aceptados) || 0,
      preparando: Number(row?.preparando) || 0,
      listos: Number(row?.listos) || 0
    });
  } catch (error) {
    logError("GET /tienda/pedidos/resumen", error);
    return res.status(500).json({ message: "Error al cargar resumen de pedidos." });
  }
});

app.get("/tienda/pedidos", async (req, res) => {
  if (!checkTiendaPermiso(req, res)) return;
  try {
    const { estado, desde, hasta } = req.query;
    const params = [];
    let where = "1=1";
    if (estado) { where += " AND p.estado = ?"; params.push(estado); }
    if (desde) { where += " AND p.creado_en >= ?"; params.push(desde); }
    if (hasta) { where += " AND p.creado_en <= ?"; params.push(hasta + " 23:59:59"); }
    const rows = await allQuery(`
      SELECT p.id, p.codigo_publico, p.cliente_nombre, p.cliente_telefono,
             p.observacion, p.estado, p.total_estimado, p.creado_en, p.actualizado_en,
             COUNT(i.id) AS items_count
      FROM tienda_pedidos p
      LEFT JOIN tienda_pedido_items i ON i.pedido_id = p.id
      WHERE ${where}
      GROUP BY p.id
      ORDER BY p.creado_en DESC
      LIMIT 100
    `, params);
    return res.json(rows.map(r => ({
      id: r.id,
      codigo_publico: r.codigo_publico,
      cliente_nombre: r.cliente_nombre,
      cliente_telefono: r.cliente_telefono || "",
      observacion: r.observacion || "",
      estado: r.estado,
      total_estimado: Number(r.total_estimado) || 0,
      creado_en: r.creado_en,
      actualizado_en: r.actualizado_en,
      items_count: Number(r.items_count) || 0
    })));
  } catch (error) {
    logError("GET /tienda/pedidos", error);
    return res.status(500).json({ message: "Error al cargar pedidos." });
  }
});

app.get("/tienda/pedidos/:id", async (req, res) => {
  if (!checkTiendaPermiso(req, res)) return;
  try {
    const pedidoId = Number(req.params.id);
    if (!pedidoId || pedidoId <= 0) return res.status(400).json({ message: "ID inválido." });
    const pedido = await getQuery(`
      SELECT p.*, u.nombre AS tomado_por_nombre
      FROM tienda_pedidos p
      LEFT JOIN usuarios u ON u.id = p.tomado_por_usuario_id
      WHERE p.id = ?
    `, [pedidoId]);
    if (!pedido) return res.status(404).json({ message: "Pedido no encontrado." });
    const items = await allQuery(`
      SELECT id, producto_id, producto_nombre_snapshot, cantidad,
             precio_unitario_snapshot, subtotal_snapshot, observacion, estado_stock_snapshot
      FROM tienda_pedido_items
      WHERE pedido_id = ?
      ORDER BY id ASC
    `, [pedidoId]);
    const itemIds = items.map(i => i.id);
    const modsMap = {};
    const ingredientesMap = {};
    if (itemIds.length) {
      const ph2 = itemIds.map(() => "?").join(",");
      const [mods, ingredientes] = await Promise.all([
        allQuery(
          `SELECT pedido_item_id, modificador_id, modificador_nombre_snapshot,
                  tipo_snapshot, cantidad, precio_extra_snapshot, subtotal_snapshot
           FROM tienda_pedido_item_modificadores
           WHERE pedido_item_id IN (${ph2})
           ORDER BY pedido_item_id ASC, id ASC`,
          itemIds
        ),
        allQuery(
          `SELECT pedido_item_id, ingrediente_id, tipo, nombre_snapshot,
                  precio_extra_snapshot, cantidad, nota
           FROM tienda_pedido_item_ingredientes
           WHERE pedido_item_id IN (${ph2})
           ORDER BY pedido_item_id ASC, id ASC`,
          itemIds
        )
      ]);
      mods.forEach(m => {
        if (!modsMap[m.pedido_item_id]) modsMap[m.pedido_item_id] = [];
        modsMap[m.pedido_item_id].push({
          modificador_id: m.modificador_id,
          nombre: m.modificador_nombre_snapshot,
          tipo: m.tipo_snapshot,
          cantidad: Number(m.cantidad),
          precio_extra: Number(m.precio_extra_snapshot),
          subtotal: Number(m.subtotal_snapshot)
        });
      });
      ingredientes.forEach(i => {
        if (!ingredientesMap[i.pedido_item_id]) ingredientesMap[i.pedido_item_id] = [];
        ingredientesMap[i.pedido_item_id].push({
          ingrediente_id: i.ingrediente_id,
          tipo: i.tipo,
          nombre: i.nombre_snapshot,
          precio_extra: Number(i.precio_extra_snapshot),
          cantidad: Number(i.cantidad),
          nota: i.nota || ""
        });
      });
    }
    return res.json({
      id: pedido.id,
      codigo_publico: pedido.codigo_publico,
      cliente_nombre: pedido.cliente_nombre,
      cliente_telefono: pedido.cliente_telefono || "",
      observacion: pedido.observacion || "",
      estado: pedido.estado,
      total_estimado: Number(pedido.total_estimado) || 0,
      venta_id: pedido.venta_id || null,
      creado_en: pedido.creado_en,
      actualizado_en: pedido.actualizado_en,
      tomado_por_nombre: pedido.tomado_por_nombre || null,
      motivo_rechazo: pedido.motivo_rechazo || null,
      items: items.map(i => ({
        id: i.id,
        producto_id: i.producto_id,
        producto_nombre_snapshot: i.producto_nombre_snapshot,
        cantidad: Number(i.cantidad),
        precio_unitario_snapshot: Number(i.precio_unitario_snapshot),
        subtotal_snapshot: Number(i.subtotal_snapshot),
        observacion: i.observacion || "",
        modificadores: modsMap[i.id] || [],
        ingredientes: ingredientesMap[i.id] || []
      }))
    });
  } catch (error) {
    logError("GET /tienda/pedidos/:id", error);
    return res.status(500).json({ message: "Error al cargar el pedido." });
  }
});

app.post("/tienda/pedidos/:id/aceptar", async (req, res) => {
  if (!checkTiendaPermiso(req, res)) return;
  try {
    const pedidoId = Number(req.params.id);
    if (!pedidoId || pedidoId <= 0) return res.status(400).json({ message: "ID inválido." });
    const pedido = await getQuery("SELECT id, estado FROM tienda_pedidos WHERE id = ?", [pedidoId]);
    if (!pedido) return res.status(404).json({ message: "Pedido no encontrado." });
    if (pedido.estado !== "recibido") return res.status(409).json({ message: `No se puede aceptar un pedido en estado '${pedido.estado}'.` });
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    await runQuery(
      "UPDATE tienda_pedidos SET estado='aceptado', tomado_por_usuario_id=?, actualizado_en=? WHERE id=?",
      [req.usuario.id, now, pedidoId]
    );
    return res.json({ ok: true, message: "Pedido aceptado." });
  } catch (error) {
    logError("POST /tienda/pedidos/:id/aceptar", error);
    return res.status(500).json({ message: "Error al aceptar el pedido." });
  }
});

app.post("/tienda/pedidos/:id/rechazar", async (req, res) => {
  if (!checkTiendaPermiso(req, res)) return;
  try {
    const pedidoId = Number(req.params.id);
    if (!pedidoId || pedidoId <= 0) return res.status(400).json({ message: "ID inválido." });
    const pedido = await getQuery("SELECT id, estado FROM tienda_pedidos WHERE id = ?", [pedidoId]);
    if (!pedido) return res.status(404).json({ message: "Pedido no encontrado." });
    if (!["recibido", "aceptado"].includes(pedido.estado)) return res.status(409).json({ message: `No se puede rechazar un pedido en estado '${pedido.estado}'.` });
    const motivo = String(req.body?.motivo || "").trim() || null;
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    await runQuery(
      "UPDATE tienda_pedidos SET estado='rechazado', motivo_rechazo=?, actualizado_en=? WHERE id=?",
      [motivo, now, pedidoId]
    );
    return res.json({ ok: true, message: "Pedido rechazado." });
  } catch (error) {
    logError("POST /tienda/pedidos/:id/rechazar", error);
    return res.status(500).json({ message: "Error al rechazar el pedido." });
  }
});

app.post("/tienda/pedidos/:id/preparando", async (req, res) => {
  if (!checkTiendaPermiso(req, res)) return;
  try {
    const pedidoId = Number(req.params.id);
    if (!pedidoId || pedidoId <= 0) return res.status(400).json({ message: "ID inválido." });
    const pedido = await getQuery("SELECT id, estado FROM tienda_pedidos WHERE id = ?", [pedidoId]);
    if (!pedido) return res.status(404).json({ message: "Pedido no encontrado." });
    if (pedido.estado !== "aceptado") return res.status(409).json({ message: `No se puede marcar preparando un pedido en estado '${pedido.estado}'.` });
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    await runQuery("UPDATE tienda_pedidos SET estado='preparando', actualizado_en=? WHERE id=?", [now, pedidoId]);
    return res.json({ ok: true, message: "Pedido marcado como preparando." });
  } catch (error) {
    logError("POST /tienda/pedidos/:id/preparando", error);
    return res.status(500).json({ message: "Error al actualizar el pedido." });
  }
});

app.post("/tienda/pedidos/:id/listo", async (req, res) => {
  if (!checkTiendaPermiso(req, res)) return;
  try {
    const pedidoId = Number(req.params.id);
    if (!pedidoId || pedidoId <= 0) return res.status(400).json({ message: "ID inválido." });
    const pedido = await getQuery("SELECT id, estado FROM tienda_pedidos WHERE id = ?", [pedidoId]);
    if (!pedido) return res.status(404).json({ message: "Pedido no encontrado." });
    if (!["preparando", "aceptado"].includes(pedido.estado)) return res.status(409).json({ message: `No se puede marcar listo un pedido en estado '${pedido.estado}'.` });
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    await runQuery("UPDATE tienda_pedidos SET estado='listo', actualizado_en=? WHERE id=?", [now, pedidoId]);
    return res.json({ ok: true, message: "Pedido listo." });
  } catch (error) {
    logError("POST /tienda/pedidos/:id/listo", error);
    return res.status(500).json({ message: "Error al actualizar el pedido." });
  }
});

// V1C: convertir pedido listo en ticket pendiente de ventas
app.post("/tienda/pedidos/:id/convertir-venta", async (req, res) => {
  const rol = normalizarRol(req.usuario?.rol || "");
  if (!["admin", "encargado"].includes(rol)) {
    return res.status(403).json({ message: "Solo admin o encargado pueden convertir pedidos en tickets." });
  }
  try {
    const pedidoId = Number(req.params.id);
    if (!pedidoId || pedidoId <= 0) return res.status(400).json({ message: "ID inválido." });

    const pedido = await getQuery(
      "SELECT id, codigo_publico, estado, venta_id, cliente_nombre, observacion, total_estimado FROM tienda_pedidos WHERE id = ?",
      [pedidoId]
    );
    if (!pedido) return res.status(404).json({ message: "Pedido no encontrado." });
    if (pedido.estado !== "listo") {
      return res.status(409).json({ message: `El pedido debe estar en estado 'listo' para convertirse en ticket (estado actual: '${pedido.estado}').` });
    }
    if (pedido.venta_id) {
      return res.status(409).json({ message: `Este pedido ya fue convertido en ticket (venta #${pedido.venta_id}).` });
    }

    const tiendaItems = await allQuery(
      "SELECT id, producto_id, producto_nombre_snapshot, cantidad, precio_unitario_snapshot, subtotal_snapshot FROM tienda_pedido_items WHERE pedido_id = ?",
      [pedidoId]
    );
    if (!tiendaItems || tiendaItems.length === 0) {
      return res.status(400).json({ message: "El pedido no tiene ítems." });
    }

    // Verificar que todos los productos existen y están activos
    const productoIds = [...new Set(tiendaItems.map((i) => i.producto_id))];
    const productosActivos = await allQuery(
      `SELECT id FROM productos WHERE id IN (${productoIds.map(() => "?").join(",")}) AND activo = 1`,
      productoIds
    );
    const activosSet = new Set(productosActivos.map((p) => p.id));
    const inactivo = tiendaItems.find((i) => !activosSet.has(i.producto_id));
    if (inactivo) {
      return res.status(409).json({
        message: `El producto "${inactivo.producto_nombre_snapshot}" ya no está disponible en el sistema.`
      });
    }

    const tiendaItemIds = tiendaItems.map((item) => item.id);
    const tiendaIngredientesMap = {};
    const tiendaModificadoresMap = {};
    if (tiendaItemIds.length) {
      const placeholders = tiendaItemIds.map(() => "?").join(",");
      const [ingredientesPedido, modificadoresPedido] = await Promise.all([
        allQuery(
          `SELECT pedido_item_id, ingrediente_id, tipo, nombre_snapshot, cantidad, nota
           FROM tienda_pedido_item_ingredientes
           WHERE pedido_item_id IN (${placeholders})
           ORDER BY pedido_item_id ASC, id ASC`,
          tiendaItemIds
        ),
        allQuery(
          `SELECT pedido_item_id, modificador_id, modificador_nombre_snapshot, tipo_snapshot, cantidad, precio_extra_snapshot
           FROM tienda_pedido_item_modificadores
           WHERE pedido_item_id IN (${placeholders})
           ORDER BY pedido_item_id ASC, id ASC`,
          tiendaItemIds
        )
      ]);
      ingredientesPedido.forEach((ingrediente) => {
        if (!tiendaIngredientesMap[ingrediente.pedido_item_id]) tiendaIngredientesMap[ingrediente.pedido_item_id] = [];
        tiendaIngredientesMap[ingrediente.pedido_item_id].push({
          ingrediente_id: ingrediente.ingrediente_id,
          tipo: ingrediente.tipo,
          nombre: ingrediente.nombre_snapshot,
          cantidad: Number(ingrediente.cantidad || 1) || 1,
          nota: ingrediente.nota || ""
        });
      });
      modificadoresPedido.forEach((modificador) => {
        if (!tiendaModificadoresMap[modificador.pedido_item_id]) tiendaModificadoresMap[modificador.pedido_item_id] = [];
        tiendaModificadoresMap[modificador.pedido_item_id].push({
          modificador_id: modificador.modificador_id,
          nombre: modificador.modificador_nombre_snapshot,
          tipo: modificador.tipo_snapshot,
          cantidad: Number(modificador.cantidad || 1) || 1,
          precio_extra: Number(modificador.precio_extra_snapshot || 0) || 0
        });
      });
    }

    // Construir items para venta usando snapshots de precio del pedido
    const itemsVenta = tiendaItems.map((i) => ({
      producto_id: i.producto_id,
      nombre_producto: i.producto_nombre_snapshot,
      cantidad: Number(i.cantidad),
      precio_unitario: Number(i.precio_unitario_snapshot),
      modificadores: tiendaModificadoresMap[i.id] || [],
      ingredientes: tiendaIngredientesMap[i.id] || []
    }));

    const totalVenta = Number(calculateTotal(itemsVenta).toFixed(2));
    const { fecha, hora } = getNowParts();
    const usuarioVenta = req.usuario?.usuario || "admin";
    const identificadorPendiente = pedido.codigo_publico;

    await runQuery("BEGIN TRANSACTION");

    const venta = await runQuery(
      `INSERT INTO ventas
      (fecha, hora, usuario, total, tipo, estado, identificador_pendiente, metodo_pago, tipo_cobro, monto_efectivo, monto_debito, cliente_id, es_cuenta_corriente, saldo_pendiente, caja_id, cuenta_cobro_id, recargo_porcentaje, recargo_monto)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [fecha, hora, usuarioVenta, totalVenta, "pendiente", "pendiente", identificadorPendiente,
       null, null, 0, 0, null, 0, 0, null, null, 0, 0]
    );

    const detalles = await replaceVentaDetalle(venta.lastID, itemsVenta);
    if (itemsVenta.some((item) => Array.isArray(item.modificadores) && item.modificadores.length)) {
      await guardarSnapshotsModificadoresVenta(detalles);
    }
    await applyStockForNewItems(itemsVenta);
    await crearAjustesPendientesVentaReceta({
      ventaId: venta.lastID,
      detalles,
      usuario: getUsuarioAuditoria(req, usuarioVenta),
      rol: req.usuario?.rol
    });
    await guardarRecetaSnapshotVenta(venta.lastID, detalles);

    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    await runQuery(
      "UPDATE tienda_pedidos SET estado='convertido_venta', venta_id=?, actualizado_en=? WHERE id=?",
      [venta.lastID, now, pedidoId]
    );

    await runQuery("COMMIT");

    return res.json({
      ok: true,
      venta_id: venta.lastID,
      codigo_publico: pedido.codigo_publico,
      message: "Pedido convertido en ticket pendiente."
    });
  } catch (error) {
    try { await runQuery("ROLLBACK"); } catch {}
    logError("POST /tienda/pedidos/:id/convertir-venta", error);
    return res.status(500).json({ message: "Error al convertir el pedido." });
  }
});

// ── Admin CRUD: ingredientes visibles por producto ────────────────────────────

app.get("/productos/:id/ingredientes-visibles", async (req, res) => {
  if (!(await requirePermiso(req, res, "stock_editar_producto", "No tenes permisos para ver ingredientes"))) return;
  const productoId = Number(req.params.id);
  const todos = req.query.todos === "1";
  try {
    const producto = await getQuery(
      "SELECT id FROM productos WHERE id = ? AND COALESCE(eliminado, 0) = 0",
      [productoId]
    );
    if (!producto) return res.status(404).json({ message: "Producto no encontrado." });
    const rows = await allQuery(
      `SELECT id, nombre, incluido_por_defecto, permite_quitar, permite_extra, precio_extra, orden, activo
       FROM producto_ingredientes_visibles
       WHERE producto_id = ? ${todos ? "" : "AND activo = 1"}
       ORDER BY orden ASC, id ASC`,
      [productoId]
    );
    return res.json(rows.map(r => ({
      id: r.id,
      nombre: r.nombre,
      incluido_por_defecto: r.incluido_por_defecto === 1,
      permite_quitar: r.permite_quitar === 1,
      permite_extra: r.permite_extra === 1,
      precio_extra: Number(r.precio_extra) || 0,
      orden: Number(r.orden) || 0,
      activo: r.activo === 1
    })));
  } catch (error) {
    logError("GET /productos/:id/ingredientes-visibles", error);
    return res.status(500).json({ message: "Error al cargar ingredientes." });
  }
});

app.post("/productos/:id/ingredientes-visibles", async (req, res) => {
  if (!(await requirePermiso(req, res, "stock_editar_producto", "No tenes permisos para agregar ingredientes"))) return;
  const productoId = Number(req.params.id);
  const { nombre, incluido_por_defecto = 1, permite_quitar = 1, permite_extra = 0, precio_extra = 0, orden = 0 } = req.body || {};
  const nombreClean = String(nombre || "").trim();
  if (!nombreClean) return res.status(400).json({ message: "El nombre del ingrediente es obligatorio." });
  const precioExtraNum = Number(precio_extra) || 0;
  if (precioExtraNum < 0) return res.status(400).json({ message: "El precio extra no puede ser negativo." });
  try {
    const producto = await getQuery(
      "SELECT id FROM productos WHERE id = ? AND COALESCE(eliminado, 0) = 0",
      [productoId]
    );
    if (!producto) return res.status(404).json({ message: "Producto no encontrado." });
    const result = await runQuery(
      `INSERT INTO producto_ingredientes_visibles
         (producto_id, nombre, incluido_por_defecto, permite_quitar, permite_extra, precio_extra, orden, activo)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [productoId, nombreClean, incluido_por_defecto ? 1 : 0, permite_quitar ? 1 : 0, permite_extra ? 1 : 0, precioExtraNum, Number(orden) || 0]
    );
    const nuevo = await getQuery("SELECT * FROM producto_ingredientes_visibles WHERE id = ?", [result.lastID]);
    return res.status(201).json({
      id: nuevo.id,
      nombre: nuevo.nombre,
      incluido_por_defecto: nuevo.incluido_por_defecto === 1,
      permite_quitar: nuevo.permite_quitar === 1,
      permite_extra: nuevo.permite_extra === 1,
      precio_extra: Number(nuevo.precio_extra) || 0,
      orden: Number(nuevo.orden) || 0,
      activo: nuevo.activo === 1
    });
  } catch (error) {
    logError("POST /productos/:id/ingredientes-visibles", error);
    return res.status(500).json({ message: "Error al crear ingrediente." });
  }
});

app.put("/productos/:id/ingredientes-visibles/:ingId", async (req, res) => {
  if (!(await requirePermiso(req, res, "stock_editar_producto", "No tenes permisos para editar ingredientes"))) return;
  const productoId = Number(req.params.id);
  const ingId = Number(req.params.ingId);
  const { nombre, incluido_por_defecto, permite_quitar, permite_extra, precio_extra, orden, activo } = req.body || {};
  const nombreClean = String(nombre || "").trim();
  if (!nombreClean) return res.status(400).json({ message: "El nombre del ingrediente es obligatorio." });
  const precioExtraNum = Number(precio_extra) || 0;
  if (precioExtraNum < 0) return res.status(400).json({ message: "El precio extra no puede ser negativo." });
  try {
    const ing = await getQuery(
      "SELECT id FROM producto_ingredientes_visibles WHERE id = ? AND producto_id = ?",
      [ingId, productoId]
    );
    if (!ing) return res.status(404).json({ message: "Ingrediente no encontrado." });
    await runQuery(
      `UPDATE producto_ingredientes_visibles
       SET nombre = ?, incluido_por_defecto = ?, permite_quitar = ?, permite_extra = ?,
           precio_extra = ?, orden = ?, activo = ?
       WHERE id = ?`,
      [nombreClean, incluido_por_defecto ? 1 : 0, permite_quitar ? 1 : 0, permite_extra ? 1 : 0,
       precioExtraNum, Number(orden) || 0, activo !== false ? 1 : 0, ingId]
    );
    const act = await getQuery("SELECT * FROM producto_ingredientes_visibles WHERE id = ?", [ingId]);
    return res.json({
      id: act.id,
      nombre: act.nombre,
      incluido_por_defecto: act.incluido_por_defecto === 1,
      permite_quitar: act.permite_quitar === 1,
      permite_extra: act.permite_extra === 1,
      precio_extra: Number(act.precio_extra) || 0,
      orden: Number(act.orden) || 0,
      activo: act.activo === 1
    });
  } catch (error) {
    logError("PUT /productos/:id/ingredientes-visibles/:ingId", error);
    return res.status(500).json({ message: "Error al actualizar ingrediente." });
  }
});

app.delete("/productos/:id/ingredientes-visibles/:ingId", async (req, res) => {
  if (!(await requirePermiso(req, res, "stock_editar_producto", "No tenes permisos para eliminar ingredientes"))) return;
  const productoId = Number(req.params.id);
  const ingId = Number(req.params.ingId);
  try {
    const ing = await getQuery(
      "SELECT id FROM producto_ingredientes_visibles WHERE id = ? AND producto_id = ?",
      [ingId, productoId]
    );
    if (!ing) return res.status(404).json({ message: "Ingrediente no encontrado." });
    await runQuery("UPDATE producto_ingredientes_visibles SET activo = 0 WHERE id = ?", [ingId]);
    return res.json({ ok: true });
  } catch (error) {
    logError("DELETE /productos/:id/ingredientes-visibles/:ingId", error);
    return res.status(500).json({ message: "Error al eliminar ingrediente." });
  }
});

// ── Fin Tienda interna ─────────────────────────────────────────────────────────

// Handler 404 para rutas no encontradas — siempre JSON
app.use((req, res) => {
  res.status(404).json({ ok: false, message: `Ruta no encontrada: ${req.method} ${req.path}` });
});

// Handler global de errores no controlados — siempre JSON, nunca HTML
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err?.type === "entity.too.large" || err?.status === 413) {
    return res.status(413).json({ message: "La imagen es demasiado pesada. Probá con una imagen menor a 5 MB." });
  }
  next(err);
});

app.use((err, req, res, _next) => {
  logError("Error no controlado en request", err);
  if (!res.headersSent) {
    res.setHeader("Content-Type", "application/json");
    res.status(500).json({ ok: false, origen: "server", message: err.message || "Error interno del servidor" });
  }
});

Promise.all([
  ensureUsuariosSchema(),
  ensureCajaMovimientosTable(),
  ensureProveedoresSchema(),
  ensureTiposPagoSchema(),
  ensureCuentasCobroSchema(),
  ensureConciliacionesCuentasCobroTable(),
  ensureConciliacionesCuentasDestinoTable(),
  ensureModificadoresSchema(),
  ensureRecalculosCuentaCorrienteTable(),
  ensureStockAjustesPendientesSchema(),
  ensureMercadoPagoPointSchema(),
  ensureProductosSchema(),
  ensureClientesSchema(),
  ensureConfiguracionSchema(),
  ensureTiendaSchema(),
  ensureVentaRecetaSnapshotSchema(),
  ensureVentaCobrosSchema()
])
  .then(() => migrarVentaCobrosLegacy())
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
      runQuery("CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_dni_cuit_unique ON clientes(dni_cuit) WHERE dni_cuit IS NOT NULL AND dni_cuit != ''"),
      runQuery("CREATE INDEX IF NOT EXISTS idx_venta_cobros_venta ON venta_cobros(venta_id)"),
      runQuery("CREATE INDEX IF NOT EXISTS idx_venta_cobros_cuenta ON venta_cobros(cuenta_cobro_id)")
    ]);
    await consolidarComponentesDuplicados();
    app.listen(PORT, () => {
      console.log(`Servidor corriendo en http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    logError("Error al preparar la base de datos:", error);
    process.exit(1);
  });
