const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const sqlite3 = require("sqlite3").verbose();

const ROOT = path.resolve(__dirname, "..");
const SOURCE_DB = path.join(ROOT, "database", "guernica.db");

function tempDbPath() {
  return path.join(os.tmpdir(), `guernica-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
}

function runSql(dbPath, sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath);
    db.run(sql, params, function (error) {
      db.close();
      if (error) reject(error);
      else resolve(this);
    });
  });
}

function allSql(dbPath, sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath);
    db.all(sql, params, (error, rows) => {
      db.close();
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

async function prepareDb(dbPath, statements) {
  for (const [sql, params = []] of statements) {
    await runSql(dbPath, sql, params);
  }
}

function resetOperationalDataStatements() {
  return [
    ["DELETE FROM caja_arqueos"],
    ["DELETE FROM conciliaciones_cuentas_cobro"],
    ["DELETE FROM caja_movimientos"],
    ["DELETE FROM caja_aperturas"],
    ["DELETE FROM stock_ajustes_pendientes"],
    ["DELETE FROM pagos_cuenta_corriente"],
    ["DELETE FROM detalle_ventas"],
    ["DELETE FROM ventas"],
    ["DELETE FROM pagos"],
    ["UPDATE productos SET stock = 80, precio_venta = 100, costo_final = 50, precio_compra = 50 WHERE id = 11"],
    [
      `INSERT INTO configuracion_global (clave, valor, seccion, actualizado_en)
       VALUES ('autorizacion_clave_maestra', '"1234"', 'usuarios_permisos', datetime('now'))
       ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, seccion = excluded.seccion, actualizado_en = excluded.actualizado_en`
    ],
    [
      `INSERT INTO configuracion_global (clave, valor, seccion, actualizado_en)
       VALUES ('cuenta_corriente_actualizar_fiado_por_precio_actual', 'false', 'cuentas_corrientes', datetime('now'))
       ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, seccion = excluded.seccion, actualizado_en = excluded.actualizado_en`
    ]
  ];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(baseUrl) {
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(`${baseUrl}/login`);
      if (response.ok) return;
    } catch {}
    await delay(150);
  }
  throw new Error("El servidor de prueba no arranco a tiempo");
}

async function withServer(dbPath, fn) {
  const port = await getFreePort();
  const baseUrl = `http://localhost:${port}`;
  const child = spawn(process.execPath, ["backend/server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), GUERNICA_DB_PATH: dbPath },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });

  try {
    await waitForServer(baseUrl);
    await fn(baseUrl);
  } catch (error) {
    error.message = `${error.message}\nServidor test pid=${child.pid} port=${port}\n${logs}`;
    throw error;
  } finally {
    if (!child.killed) child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }

  if (child.exitCode && child.exitCode !== 0) {
    throw new Error(`Servidor de prueba finalizo con codigo ${child.exitCode}\n${logs}`);
  }
}

async function requestJson(baseUrl, method, url, body, token) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  return { response, data };
}

async function login(baseUrl, usuario, password) {
  const { response, data } = await requestJson(baseUrl, "POST", "/login", { usuario, password }, null);
  if (!response.ok || !data?.token) {
    throw new Error(`No se pudo iniciar sesion como ${usuario}: ${data?.message || response.status}`);
  }
  return data.token;
}

async function getProduct(baseUrl, token, id) {
  const { response, data } = await requestJson(baseUrl, "GET", "/productos", null, token);
  if (!response.ok) throw new Error(`No se pudo listar productos: ${response.status}`);
  return data.find((producto) => Number(producto.id) === Number(id));
}

async function getVentas(baseUrl, token) {
  const { response, data } = await requestJson(baseUrl, "GET", "/ventas", null, token);
  if (!response.ok) throw new Error(`No se pudo listar ventas: ${response.status}`);
  return data;
}

async function getCajaResumen(baseUrl, token) {
  const { response, data } = await requestJson(baseUrl, "GET", "/caja/resumen", null, token);
  if (!response.ok) throw new Error(`No se pudo obtener caja/resumen: ${response.status}`);
  return data;
}

async function getCajaResumenCuentas(baseUrl, token, cajaId = null) {
  const url = cajaId ? `/caja/resumen/cuentas?caja_id=${cajaId}` : "/caja/resumen/cuentas";
  const { response, data } = await requestJson(baseUrl, "GET", url, null, token);
  if (!response.ok) throw new Error(`No se pudo obtener caja/resumen/cuentas: ${data?.message || response.status}`);
  return data;
}

async function getCajaResumenCuentasDestino(baseUrl, token, cajaId = null) {
  const url = cajaId ? `/caja/resumen/cuentas-destino?caja_id=${cajaId}` : "/caja/resumen/cuentas-destino";
  const { response, data } = await requestJson(baseUrl, "GET", url, null, token);
  if (!response.ok) throw new Error(`No se pudo obtener caja/resumen/cuentas-destino: ${data?.message || response.status}`);
  return data;
}

async function getCajaConciliacionesCuentas(baseUrl, token, cajaId = null) {
  const url = cajaId ? `/caja/conciliaciones/cuentas?caja_id=${cajaId}` : "/caja/conciliaciones/cuentas";
  const { response, data } = await requestJson(baseUrl, "GET", url, null, token);
  if (!response.ok) throw new Error(`No se pudo obtener caja/conciliaciones/cuentas: ${data?.message || response.status}`);
  return data;
}

async function getCajaConciliacionesCuentasDestino(baseUrl, token, cajaId = null) {
  const url = cajaId ? `/caja/conciliaciones/cuentas-destino?caja_id=${cajaId}` : "/caja/conciliaciones/cuentas-destino";
  const { response, data } = await requestJson(baseUrl, "GET", url, null, token);
  if (!response.ok) throw new Error(`No se pudo obtener caja/conciliaciones/cuentas-destino: ${data?.message || response.status}`);
  return data;
}

async function guardarConciliacionCuenta(baseUrl, token, payload) {
  const { response, data } = await requestJson(baseUrl, "POST", "/caja/conciliaciones/cuentas", payload, token);
  if (!response.ok) throw new Error(`No se pudo guardar conciliacion cuenta: ${data?.message || response.status}`);
  return data;
}

async function guardarConciliacionCuentaDestino(baseUrl, token, payload) {
  const { response, data } = await requestJson(baseUrl, "POST", "/caja/conciliaciones/cuentas-destino", payload, token);
  if (!response.ok) throw new Error(`No se pudo guardar conciliacion cuenta destino: ${data?.message || response.status}`);
  return data;
}

async function getUltimoSaldoArrastrado(baseUrl, token, cuentaDestinoId = null) {
  const qs = cuentaDestinoId != null ? `?cuenta_destino_id=${cuentaDestinoId}` : "";
  const { response, data } = await requestJson(baseUrl, "GET", `/caja/ultimo-saldo-arrastrado${qs}`, null, token);
  if (!response.ok) throw new Error(`No se pudo obtener ultimo saldo arrastrado: ${data?.message || response.status}`);
  return data;
}

async function getMovimientosStock(baseUrl, token, productoId) {
  const { response, data } = await requestJson(baseUrl, "GET", `/productos/${productoId}/movimientos-stock`, null, token);
  if (!response.ok) throw new Error(`No se pudo obtener movimientos de stock: ${response.status}`);
  return data;
}

async function getAjustesPendientesStock(baseUrl, token, estado = "") {
  const url = estado ? `/stock/ajustes-pendientes?estado=${encodeURIComponent(estado)}` : "/stock/ajustes-pendientes";
  const { response, data } = await requestJson(baseUrl, "GET", url, null, token);
  if (!response.ok) throw new Error(`No se pudo obtener ajustes pendientes de stock: ${data?.message || response.status}`);
  return data;
}

async function crearAjustePendienteStock(baseUrl, token, payload) {
  const { response, data } = await requestJson(baseUrl, "POST", "/stock/ajustes-pendientes", payload, token);
  if (!response.ok) throw new Error(`No se pudo crear ajuste pendiente de stock: ${data?.message || response.status}`);
  return data.ajuste;
}

async function reconciliarAjustesPendientesStock(baseUrl, token, ids) {
  const { response, data } = await requestJson(baseUrl, "POST", "/stock/ajustes-pendientes/reconciliar", { ids }, token);
  if (!response.ok) throw new Error(`No se pudo reconciliar ajustes pendientes de stock: ${data?.message || response.status}`);
  return data.ajustes;
}

async function getVentaDetalle(baseUrl, token, ventaId) {
  const { response, data } = await requestJson(baseUrl, "GET", `/ventas/${ventaId}/detalle`, null, token);
  if (!response.ok) throw new Error(`No se pudo obtener detalle de venta: ${response.status}`);
  return data;
}

async function abrirCaja(baseUrl, token, montoApertura = 1000) {
  const result = await requestJson(baseUrl, "POST", "/caja/apertura", {
    monto_apertura: montoApertura,
    saldo_inicial_mp: 0,
    usuario: "test"
  }, token);
  if (!result.response.ok) {
    throw new Error(`No se pudo abrir caja: ${result.data?.message || result.response.status}`);
  }
  return result.data.apertura;
}

function buildConteoMonto(monto) {
  let restante = Number(monto) || 0;
  const conteo = {};
  const denominaciones = [20000, 10000, 2000, 1000, 500, 200, 100, 50, 20, 10];

  for (const denominacion of denominaciones) {
    const cantidad = Math.floor(restante / denominacion);
    if (cantidad > 0) {
      conteo[String(denominacion)] = cantidad;
      restante -= cantidad * denominacion;
    }
  }

  return conteo;
}

async function registrarArqueoCierre(baseUrl, token, efectivoContado) {
  const result = await requestJson(baseUrl, "POST", "/caja/arqueos", {
    usuario: "test",
    conteo: buildConteoMonto(efectivoContado),
    cuentas: [],
    observaciones: "TEST arqueo cierre",
    registrado_cierre: 1
  }, token);

  if (!result.response.ok) {
    throw new Error(`No se pudo registrar arqueo de cierre: ${result.data?.message || result.response.status}`);
  }

  return result.data.arqueo;
}

async function cerrarCaja(baseUrl, token, efectivoContado, montoCajaApertura = 0, montoCajaFondo = 0) {
  await registrarArqueoCierre(baseUrl, token, efectivoContado);
  const result = await requestJson(baseUrl, "POST", "/caja/cierre", {
    conteo: buildConteoMonto(efectivoContado),
    monto_caja_apertura: montoCajaApertura,
    monto_caja_fondo: montoCajaFondo
  }, token);

  if (!result.response.ok) {
    throw new Error(`No se pudo cerrar caja: ${result.data?.message || result.response.status}`);
  }

  return result.data.caja;
}

async function getCierreDetalle(baseUrl, token, cierreId) {
  const { response, data } = await requestJson(baseUrl, "GET", `/caja/cierres/${cierreId}`, null, token);
  if (!response.ok) throw new Error(`No se pudo obtener cierre ${cierreId}: ${data?.message || response.status}`);
  return data;
}

async function crearProveedor(baseUrl, token, overrides = {}) {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const result = await requestJson(baseUrl, "POST", "/proveedores", {
    nombre: `Proveedor Test ${suffix}`,
    alias: "Proveedor Test",
    cuit: `20${String(suffix).slice(-8)}`,
    tipo_persona: "juridica",
    tipo_impacto: "costo_variable_mercaderia",
    condicion_iva: "responsable_inscripto",
    tipo_comprobante: "factura_a",
    iva_alicuota: 21,
    activo: true,
    ...overrides
  }, token);

  if (!result.response.ok) {
    throw new Error(`No se pudo crear proveedor: ${result.data?.message || result.response.status}`);
  }

  return result.data.proveedor;
}

async function registrarPago(baseUrl, token, payload) {
  const result = await requestJson(baseUrl, "POST", "/pagos", payload, token);

  if (!result.response.ok) {
    throw new Error(`No se pudo registrar pago: ${result.data?.message || result.response.status}`);
  }

  return result.data.pago;
}

async function crearCuentaCobro(baseUrl, token, payload) {
  const tipoPago = String(payload?.tipo_pago_codigo || "efectivo").toLowerCase();
  const proveedor = String(payload?.proveedor_integracion || "interno").toLowerCase();
  const requiereDestino = !Object.prototype.hasOwnProperty.call(payload || {}, "cuenta_destino_id") &&
    payload?.activo !== false &&
    (tipoPago !== "efectivo" || proveedor === "mercadopago" || proveedor === "mercadopago_point");
  const cuentaDestino = requiereDestino
    ? await crearCuentaDestino(baseUrl, token, {
        nombre: `Cuenta destino cobro TEST ${Date.now()}${Math.floor(Math.random() * 10000)}`,
        tipo_destino: tipoPago === "efectivo" ? "efectivo" : "billetera"
      })
    : null;
  const result = await requestJson(baseUrl, "POST", "/cuentas_cobro", {
    nombre: `Cuenta cobro TEST ${Date.now()}`,
    tipo_pago_codigo: "efectivo",
    tipo_cuenta: "terminal",
    proveedor_integracion: "interno",
    activo: true,
    orden: 10,
    ...(cuentaDestino ? { cuenta_destino_id: cuentaDestino.id } : {}),
    ...payload
  }, token);

  if (!result.response.ok) {
    throw new Error(`No se pudo crear cuenta_cobro: ${result.data?.message || result.response.status}`);
  }

  return result.data.cuenta;
}

async function crearCuentaDestino(baseUrl, token, payload) {
  const result = await requestJson(baseUrl, "POST", "/cuentas_destino", {
    nombre: `Cuenta destino TEST ${Date.now()}`,
    tipo_destino: "billetera",
    alias: "",
    cbu_cvu: "",
    activo: true,
    orden: 10,
    ...payload
  }, token);

  if (!result.response.ok) {
    throw new Error(`No se pudo crear cuenta_destino: ${result.data?.message || result.response.status}`);
  }

  return result.data.cuenta;
}

async function getPagos(baseUrl, token) {
  const { response, data } = await requestJson(baseUrl, "GET", "/pagos", null, token);
  if (!response.ok) throw new Error(`No se pudo listar pagos: ${response.status}`);
  return data;
}

async function crearCategoria(baseUrl, token, nombre, overrides = {}) {
  const result = await requestJson(baseUrl, "POST", "/categorias", {
    nombre,
    margen_porcentaje: 0,
    maneja_stock: true,
    usa_costos_varios: false,
    ...overrides
  }, token);

  if (!result.response.ok) {
    throw new Error(`No se pudo crear categoria ${nombre}: ${result.data?.message || result.response.status}`);
  }

  return result.data.id;
}

async function crearProducto(baseUrl, token, payload) {
  const result = await requestJson(baseUrl, "POST", "/productos", {
    categoria: payload.categoria || "TEST",
    precio_compra: 10,
    precio_venta: 100,
    stock: 0,
    maneja_stock: true,
    activo: true,
    iva_porcentaje: 0,
    precio_compra_incluye_iva: false,
    redondeo: 0,
    unidad_medida: "unidad",
    usuario: "test",
    ...payload
  }, token);

  if (!result.response.ok) {
    throw new Error(`No se pudo crear producto ${payload.nombre}: ${result.data?.message || result.response.status}`);
  }

  return result.data.id;
}

async function crearProductoCompuesto(baseUrl, token, payload) {
  const result = await requestJson(baseUrl, "POST", "/productos_compuestos", {
    precio_venta: 100,
    componentes: [],
    costos_extra: [],
    usuario: "test",
    ...payload
  }, token);

  if (!result.response.ok) {
    throw new Error(`No se pudo crear producto compuesto ${payload.nombre}: ${result.data?.message || result.response.status}`);
  }

  return result.data.id;
}

function ventaSimplePayload(overrides = {}) {
  return {
    usuario: "test",
    tipo: "normal",
    tipo_cobro: "efectivo",
    items: [{
      producto_id: 11,
      nombre_producto: "Coca Cola 1250",
      cantidad: 2,
      precio_unitario: 100
    }],
    ...overrides
  };
}

function assertEqual(actual, expected, message) {
  if (Number(actual) !== Number(expected)) {
    throw new Error(`${message}. Esperado=${expected}, actual=${actual}`);
  }
}

function assertApprox(actual, expected, message, tolerance = 0.01) {
  if (Math.abs(Number(actual) - Number(expected)) > tolerance) {
    throw new Error(`${message}. Esperado=${expected}, actual=${actual}`);
  }
}

async function testRecetaSinStockBloqueaMovimientoManual() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const catId = await crearCategoria(baseUrl, token, "TEST RecetaSinStockFisico");

      // Ingrediente físico con stock propio
      const ingId = await crearProducto(baseUrl, token, {
        nombre: "TEST Ingrediente RecetaSinStock",
        categoria: "TEST RecetaSinStockFisico",
        categoria_id: catId,
        stock: 5000,
        maneja_stock: true
      });

      // Receta sin stock propio: tipo=compuesto, maneja_stock=false
      const recetaId = await crearProducto(baseUrl, token, {
        nombre: "TEST Receta Sin Stock Fisico",
        categoria: "TEST RecetaSinStockFisico",
        categoria_id: catId,
        tipo: "compuesto",
        maneja_stock: false,
        stock: 0,
        componentes: [{ producto_id: ingId, cantidad: 1 }],
        costos_extra: []
      });

      // Verificar que el producto tiene los atributos esperados antes del POST
      const receta = await getProduct(baseUrl, token, recetaId);
      if (!receta) throw new Error("Receta de prueba no encontrada en GET /productos");
      if (String(receta.tipo || "").toLowerCase() !== "compuesto") {
        throw new Error(`Receta debe ser tipo=compuesto, actual=${receta.tipo}`);
      }
      if (Number(receta.maneja_stock) !== 0) {
        throw new Error(`Receta sin stock debe tener maneja_stock=0, actual=${receta.maneja_stock}`);
      }

      const beforeReceta = Number(receta.stock || 0);
      const beforeIng = Number((await getProduct(baseUrl, token, ingId))?.stock || 0);

      const result = await requestJson(baseUrl, "POST", `/productos/${recetaId}/movimientos-stock`, {
        tipo_movimiento: "egreso",
        cantidad: 1,
        motivo: "TEST receta sin stock no ajustable",
        usuario: "test"
      }, token);

      assertEqual(result.response.status, 400, "Receta sin stock propio no debe recibir movimiento manual");
      assertEqual((await getProduct(baseUrl, token, recetaId)).stock, beforeReceta, "Receta debe conservar stock tras bloqueo");
      assertEqual((await getProduct(baseUrl, token, ingId)).stock, beforeIng, "Ingrediente no debe verse afectado por movimiento bloqueado");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testRecetaSinStockComoComponenteNoDescuentaDirecto() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, [
      ["UPDATE productos SET stock = 5000 WHERE id IN (3, 6)"],
      ["UPDATE productos SET stock = 1 WHERE id IN (4, 7)"],
      ["UPDATE productos SET stock = 71, maneja_stock = 1 WHERE id = 9"]
    ]);

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const result = await requestJson(baseUrl, "POST", "/productos/9/movimientos-stock", {
        tipo_movimiento: "ingreso",
        cantidad: 1,
        motivo: "TEST ingreso pizza prearmada",
        usuario: "test"
      }, token);

      if (!result.response.ok) throw new Error(`Ingreso pizza fallo: ${result.data?.message || result.response.status}`);
      assertEqual((await getProduct(baseUrl, token, 9)).stock, 72, "Pizza Muzzarella debe ingresar 1 unidad");
      assertEqual((await getProduct(baseUrl, token, 4)).stock, 0, "Salsa lista no debe usar stock como contador");
      assertEqual((await getProduct(baseUrl, token, 7)).stock, 0, "Pre Pizza no debe usar stock como contador");
      assertEqual((await getProduct(baseUrl, token, 3)).stock, 5000, "Receta sin stock como componente no debe consumir componentes directos");
      assertEqual((await getProduct(baseUrl, token, 6)).stock, 4800, "Muzzarella Cremac debe consumir 200gr");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function setupRecetaSinStockVenta(baseUrl, token) {
  const categoriaId = await crearCategoria(baseUrl, token, "TEST Receta Ajuste Pendiente");
  const componenteId = await crearProducto(baseUrl, token, {
    nombre: `TEST Insumo Receta ${Date.now()}`,
    categoria: "TEST Receta Ajuste Pendiente",
    categoria_id: categoriaId,
    stock: 100,
    maneja_stock: true,
    precio_venta: 10
  });
  const recetaId = await crearProductoCompuesto(baseUrl, token, {
    nombre: `TEST Receta Sin Stock ${Date.now()}`,
    categoria: "TEST Receta Ajuste Pendiente",
    categoria_id: categoriaId,
    precio_venta: 300,
    componentes: [{ producto_id: componenteId, cantidad: 2 }],
    rendimiento_receta: 8
  });
  await abrirCaja(baseUrl, token, 1000);
  return { componenteId, recetaId };
}

async function venderRecetaSinStock(baseUrl, token, recetaId, cantidad = 3) {
  return requestJson(baseUrl, "POST", "/ventas", {
    usuario: "test",
    tipo: "normal",
    tipo_cobro: "efectivo",
    items: [{
      producto_id: recetaId,
      nombre_producto: "TEST Receta Sin Stock",
      cantidad,
      precio_unitario: 300
    }]
  }, token);
}

async function testVentaRecetaSinStockGeneraAjustePendiente() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const { componenteId, recetaId } = await setupRecetaSinStockVenta(baseUrl, token);

      const venta = await venderRecetaSinStock(baseUrl, token, recetaId, 3);
      if (!venta.response.ok) throw new Error(`Venta receta sin stock fallo: ${venta.data?.message || venta.response.status}`);

      assertEqual((await getProduct(baseUrl, token, componenteId)).stock, 100, "Venta de receta sin stock no debe descontar componente");
      assertEqual((await getProduct(baseUrl, token, recetaId)).stock, 0, "Receta sin stock debe quedar en stock 0");

      const ajustes = await getAjustesPendientesStock(baseUrl, token, "pendiente");
      const ajuste = ajustes.find((item) => Number(item.venta_id) === Number(venta.data.venta_id) && item.origen === "venta_receta");
      if (!ajuste) throw new Error("Venta de receta sin stock debe crear ajuste pendiente venta_receta");
      assertEqual(ajuste.producto_id, componenteId, "Ajuste pendiente debe apuntar al componente fisico");
      assertEqual(ajuste.componente_id, componenteId, "Ajuste pendiente debe guardar componente_id");
      assertEqual(ajuste.producto_vendido_id, recetaId, "Ajuste pendiente debe guardar producto_vendido_id");
      assertApprox(ajuste.cantidad_teorica, 6, "Ajuste pendiente debe guardar cantidad teorica");

      const aprobar = await requestJson(baseUrl, "POST", `/stock/ajustes-pendientes/${ajuste.id}/aprobar`, {}, token);
      if (!aprobar.response.ok) throw new Error(`Aprobar ajuste teorico fallo: ${aprobar.data?.message || aprobar.response.status}`);
      assertEqual((await getProduct(baseUrl, token, componenteId)).stock, 94, "Aprobar ajuste pendiente debe descontar stock fisico");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testAnularRecetaSinStockCancelaPendienteSinReponerAprobado() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const { componenteId, recetaId } = await setupRecetaSinStockVenta(baseUrl, token);

      const ventaPendiente = await venderRecetaSinStock(baseUrl, token, recetaId, 1);
      if (!ventaPendiente.response.ok) throw new Error(`Venta pendiente ajuste fallo: ${ventaPendiente.data?.message || ventaPendiente.response.status}`);
      const anularPendiente = await requestJson(baseUrl, "POST", `/ventas/${ventaPendiente.data.venta_id}/anular-cobrada`, {
        authorization_code: "1234"
      }, token);
      if (!anularPendiente.response.ok) throw new Error(`Anular venta con ajuste pendiente fallo: ${anularPendiente.data?.message || anularPendiente.response.status}`);
      assertEqual((await getProduct(baseUrl, token, componenteId)).stock, 100, "Anular ajuste pendiente no debe mover stock fisico");
      const rechazados = await getAjustesPendientesStock(baseUrl, token, "rechazado");
      if (!rechazados.some((item) => Number(item.venta_id) === Number(ventaPendiente.data.venta_id) && item.origen === "venta_receta")) {
        throw new Error("Anular venta debe cancelar ajuste teorico pendiente");
      }

      const ventaAprobada = await venderRecetaSinStock(baseUrl, token, recetaId, 1);
      if (!ventaAprobada.response.ok) throw new Error(`Venta aprobada ajuste fallo: ${ventaAprobada.data?.message || ventaAprobada.response.status}`);
      const ajustes = await getAjustesPendientesStock(baseUrl, token, "pendiente");
      const ajuste = ajustes.find((item) => Number(item.venta_id) === Number(ventaAprobada.data.venta_id) && item.origen === "venta_receta");
      if (!ajuste) throw new Error("Debe existir ajuste pendiente para aprobar");
      const aprobar = await requestJson(baseUrl, "POST", `/stock/ajustes-pendientes/${ajuste.id}/aprobar`, {}, token);
      if (!aprobar.response.ok) throw new Error(`Aprobar ajuste antes de anular fallo: ${aprobar.data?.message || aprobar.response.status}`);
      assertEqual((await getProduct(baseUrl, token, componenteId)).stock, 98, "Aprobar ajuste debe descontar componente");

      const anularAprobada = await requestJson(baseUrl, "POST", `/ventas/${ventaAprobada.data.venta_id}/anular-cobrada`, {
        authorization_code: "1234"
      }, token);
      if (!anularAprobada.response.ok) throw new Error(`Anular venta con ajuste aprobado fallo: ${anularAprobada.data?.message || anularAprobada.response.status}`);
      assertEqual((await getProduct(baseUrl, token, componenteId)).stock, 98, "Anular venta con ajuste aprobado no debe reponer stock automatico");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testPermisosColaborador() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await withServer(dbPath, async (baseUrl) => {
      const adminToken = await login(baseUrl, "admin", "admin123");
      const configAdmin = await requestJson(baseUrl, "GET", "/configuracion", null, adminToken);
      if (!configAdmin.data?.config?.permisos_acciones_roles?.caja?.colaborador) {
        throw new Error("La configuracion debe exponer permisos para rol colaborador");
      }
      if (!configAdmin.data?.config?.autorizacion_clave_maestra) {
        throw new Error("Admin debe recibir configuracion sensible completa");
      }
      await requestJson(baseUrl, "POST", "/usuarios", {
        nombre: "Colaborador Test",
        usuario: "colaborador_test",
        password: "colaborador123",
        confirmar_password: "colaborador123",
        rol: "colaborador",
        activo: true
      }, adminToken);

      const colaboradorToken = await login(baseUrl, "colaborador_test", "colaborador123");
      const configColaborador = await requestJson(baseUrl, "GET", "/configuracion", null, colaboradorToken);
      if (!configColaborador.response.ok) throw new Error("El colaborador debe poder leer configuracion sanitizada");
      if (configColaborador.data?.config?.autorizacion_clave_maestra !== undefined) {
        throw new Error("Configuracion sanitizada no debe exponer clave maestra a colaborador");
      }
      if (configColaborador.data?.config?.permisos_acciones_roles !== undefined) {
        throw new Error("Configuracion sanitizada no debe exponer matriz de permisos a colaborador");
      }
      if (configColaborador.data?.config?.dashboard_tipo_colaborador === undefined) {
        throw new Error("Configuracion sanitizada debe conservar dashboard_tipo_colaborador");
      }

      const lecturaProductos = await requestJson(baseUrl, "GET", "/productos", null, colaboradorToken);
      if (!lecturaProductos.response.ok) throw new Error("El colaborador debe poder leer productos");

      const lecturaCaja = await requestJson(baseUrl, "GET", "/caja/resumen", null, colaboradorToken);
      if (!lecturaCaja.response.ok) throw new Error("El colaborador debe poder acceder a caja");

      const stock = await requestJson(baseUrl, "POST", "/productos/3/movimientos-stock", {
        tipo_movimiento: "ingreso",
        cantidad: 1,
        motivo: "TEST colaborador bloqueado",
        usuario: "colaborador_test"
      }, colaboradorToken);
      assertEqual(stock.response.status, 403, "El colaborador no debe modificar stock");

      const config = await requestJson(baseUrl, "PUT", "/configuracion", {
        ticket_nombre: "No autorizado"
      }, colaboradorToken);
      assertEqual(config.response.status, 403, "El colaborador no debe modificar configuracion");

      const reporteVentas = await requestJson(baseUrl, "GET", "/reportes/ventas", null, colaboradorToken);
      if (!reporteVentas.response.ok) throw new Error("El colaborador debe poder acceder al reporte operativo de ventas");

      const reporteStock = await requestJson(baseUrl, "GET", "/reportes/stock", null, colaboradorToken);
      assertEqual(reporteStock.response.status, 403, "El colaborador no debe acceder al reporte sensible de stock");

      const reporteProveedores = await requestJson(baseUrl, "GET", "/reportes/proveedores-pagos", null, colaboradorToken);
      assertEqual(reporteProveedores.response.status, 403, "El colaborador no debe acceder al reporte sensible de proveedores/pagos");

      const exportStock = await requestJson(baseUrl, "GET", "/reportes/exportar?modulo=stock&desde=2026-01-01&hasta=2026-01-31", null, colaboradorToken);
      assertEqual(exportStock.response.status, 403, "El colaborador no debe exportar reportes sensibles");

      const reporteStockAdmin = await requestJson(baseUrl, "GET", "/reportes/stock", null, adminToken);
      if (!reporteStockAdmin.response.ok) throw new Error("Admin debe acceder al reporte sensible de stock");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testFinanzasResumenBackendV1() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await withServer(dbPath, async (baseUrl) => {
      const adminToken = await login(baseUrl, "admin", "admin123");
      await requestJson(baseUrl, "POST", "/usuarios", {
        nombre: "Colaborador Finanzas",
        usuario: "colaborador_finanzas",
        password: "colaborador123",
        confirmar_password: "colaborador123",
        rol: "colaborador",
        activo: true
      }, adminToken);

      const colaboradorToken = await login(baseUrl, "colaborador_finanzas", "colaborador123");
      const bloqueado = await requestJson(baseUrl, "GET", "/finanzas/resumen", null, colaboradorToken);
      assertEqual(bloqueado.response.status, 403, "El colaborador no debe acceder a finanzas/resumen");

      const result = await requestJson(baseUrl, "GET", "/finanzas/resumen", null, adminToken);
      if (!result.response.ok) throw new Error(`Admin debe acceder a finanzas/resumen: ${result.data?.message || result.response.status}`);
      const data = result.data;
      ["liquidez", "pendientes_cobro", "capital_inmovilizado", "pasivos", "resultado", "alertas"].forEach((clave) => {
        if (data?.[clave] === undefined) throw new Error(`finanzas/resumen debe devolver ${clave}`);
      });
      if (!Array.isArray(data.alertas)) throw new Error("finanzas/resumen debe devolver alertas como array");
      if (data.capital_inmovilizado?.stock_fisico_valorizado === undefined) {
        throw new Error("Stock fisico valorizado debe quedar en capital_inmovilizado");
      }
      if (data.liquidez?.stock_fisico_valorizado !== undefined) {
        throw new Error("Stock fisico valorizado no debe mezclarse en liquidez");
      }
      ["posicion_liquida", "masa_monetaria_bruta", "patrimonio_operativo_estimado", "deuda_neta"].forEach((clave) => {
        if (data.resultado?.[clave] === undefined) throw new Error(`resultado debe devolver ${clave}`);
      });
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testProduccionV1DominioSeparado() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const adminToken = await login(baseUrl, "admin", "admin123");
      const categoriaId = await crearCategoria(baseUrl, adminToken, `Produccion TEST ${Date.now()}`);
      const insumoId = await crearProducto(baseUrl, adminToken, {
        nombre: `Insumo produccion TEST ${Date.now()}`,
        categoria_id: categoriaId,
        categoria: "Produccion TEST",
        stock: 10,
        precio_compra: 5,
        costo_final: 5,
        precio_venta: 5,
        maneja_stock: true,
        tipo: "simple"
      });
      const derivadoId = await crearProducto(baseUrl, adminToken, {
        nombre: `Derivado produccion TEST ${Date.now()}`,
        categoria_id: categoriaId,
        categoria: "Produccion TEST",
        stock: 0,
        precio_compra: 10,
        costo_final: 10,
        precio_venta: 20,
        maneja_stock: true,
        tipo: "compuesto",
        componentes: [{ producto_id: insumoId, cantidad: 2, cantidad_uso: 2, unidad_uso: "un" }],
        costos_extra: []
      });
      const recetaSinStockId = await crearProducto(baseUrl, adminToken, {
        nombre: `Receta sin stock TEST ${Date.now()}`,
        categoria_id: categoriaId,
        categoria: "Produccion TEST",
        stock: 0,
        precio_compra: 10,
        costo_final: 10,
        precio_venta: 20,
        maneja_stock: false,
        tipo: "compuesto",
        componentes: [{ producto_id: insumoId, cantidad: 1, cantidad_uso: 1, unidad_uso: "un" }],
        costos_extra: []
      });

      const rechazaSimple = await requestJson(baseUrl, "GET", `/produccion/preview?producto_id=${insumoId}&cantidad=1`, null, adminToken);
      assertEqual(rechazaSimple.response.status, 400, "Produccion debe rechazar producto simple");

      const rechazaSinStock = await requestJson(baseUrl, "GET", `/produccion/preview?producto_id=${recetaSinStockId}&cantidad=1`, null, adminToken);
      assertEqual(rechazaSinStock.response.status, 400, "Produccion debe rechazar compuesto sin stock fisico");

      const preview = await requestJson(baseUrl, "GET", `/produccion/preview?producto_id=${derivadoId}&cantidad=3`, null, adminToken);
      if (!preview.response.ok) throw new Error(`Preview produccion fallo: ${preview.data?.message || preview.response.status}`);
      assertEqual(preview.data.puede_producir ? 1 : 0, 1, "Preview debe permitir produccion valida");
      assertEqual(preview.data.componentes[0].cantidad_requerida, 6, "Preview debe calcular consumo de componentes");

      const ventasAntes = await getVentas(baseUrl, adminToken);
      const cajaAntes = await getCajaResumen(baseUrl, adminToken);
      const registrar = await requestJson(baseUrl, "POST", "/produccion", {
        producto_id: derivadoId,
        cantidad_producida: 3,
        responsable: "TEST cocina",
        observacion: "TEST produccion V1"
      }, adminToken);
      if (!registrar.response.ok) throw new Error(`Registrar produccion fallo: ${registrar.data?.message || registrar.response.status}`);

      assertEqual((await getProduct(baseUrl, adminToken, insumoId)).stock, 4, "Produccion debe descontar componentes fisicos");
      assertEqual((await getProduct(baseUrl, adminToken, derivadoId)).stock, 3, "Produccion debe ingresar stock derivado");
      if (!registrar.data.produccion?.movimiento_stock_ingreso_id) throw new Error("Produccion debe guardar movimiento_stock_ingreso_id");
      assertEqual(registrar.data.produccion.componentes.length, 1, "Produccion debe guardar snapshot de componentes");
      assertEqual(registrar.data.produccion.componentes[0].cantidad_consumida, 6, "Snapshot debe guardar cantidad consumida");

      const movimientosInsumo = await getMovimientosStock(baseUrl, adminToken, insumoId);
      const movimientosDerivado = await getMovimientosStock(baseUrl, adminToken, derivadoId);
      if (!movimientosInsumo.some((m) => m.tipo_movimiento === "produccion_consumo")) {
        throw new Error("Produccion debe crear movimiento produccion_consumo");
      }
      if (!movimientosDerivado.some((m) => m.tipo_movimiento === "produccion_ingreso")) {
        throw new Error("Produccion debe crear movimiento produccion_ingreso");
      }

      const detalle = await requestJson(baseUrl, "GET", `/produccion/${registrar.data.produccion.id}`, null, adminToken);
      if (!detalle.response.ok) throw new Error("Debe poder obtener detalle de produccion");
      assertEqual(detalle.data.componentes.length, 1, "Detalle debe incluir componentes snapshot");

      const ventasDespues = await getVentas(baseUrl, adminToken);
      const cajaDespues = await getCajaResumen(baseUrl, adminToken);
      assertEqual(ventasDespues.length, ventasAntes.length, "Produccion no debe crear ventas");
      assertEqual(cajaDespues.resumen.total_general, cajaAntes.resumen.total_general, "Produccion no debe modificar caja");
    });

    const producciones = await allSql(dbPath, "SELECT * FROM producciones");
    const snapshots = await allSql(dbPath, "SELECT * FROM produccion_componentes_snapshot");
    const ventas = await allSql(dbPath, "SELECT * FROM ventas");
    const pagosCuenta = await allSql(dbPath, "SELECT * FROM pagos_cuenta_corriente");
    if (producciones.length !== 1) throw new Error("Debe persistir una produccion");
    if (snapshots.length !== 1) throw new Error("Debe persistir un snapshot de componente");
    if (ventas.length !== 0) throw new Error("Produccion no debe persistir ventas");
    if (pagosCuenta.length !== 0) throw new Error("Produccion no debe persistir pagos de cuenta corriente");
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testConsumoTeoricoAgrupadoPorInsumo() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const categoriaId = await crearCategoria(baseUrl, token, `Consumo teorico TEST ${Date.now()}`);
      const insumoId = await crearProducto(baseUrl, token, {
        nombre: `Insumo consumo teorico TEST ${Date.now()}`,
        categoria_id: categoriaId,
        categoria: "Consumo teorico TEST",
        stock: 500,
        precio_compra: 2,
        costo_final: 2,
        precio_venta: 2,
        maneja_stock: true,
        tipo: "simple",
        unidad_medida: "g"
      });
      const recetaAId = await crearProducto(baseUrl, token, {
        nombre: `Receta A consumo TEST ${Date.now()}`,
        categoria_id: categoriaId,
        categoria: "Consumo teorico TEST",
        stock: 0,
        precio_compra: 10,
        costo_final: 10,
        precio_venta: 100,
        maneja_stock: false,
        tipo: "compuesto",
        componentes: [{ producto_id: insumoId, cantidad: 2 }],
        costos_extra: []
      });
      const recetaBId = await crearProducto(baseUrl, token, {
        nombre: `Receta B consumo TEST ${Date.now()}`,
        categoria_id: categoriaId,
        categoria: "Consumo teorico TEST",
        stock: 0,
        precio_compra: 10,
        costo_final: 10,
        precio_venta: 100,
        maneja_stock: false,
        tipo: "compuesto",
        componentes: [{ producto_id: insumoId, cantidad: 4 }],
        costos_extra: []
      });
      const derivadoId = await crearProducto(baseUrl, token, {
        nombre: `Derivado stock consumo TEST ${Date.now()}`,
        categoria_id: categoriaId,
        categoria: "Consumo teorico TEST",
        stock: 0,
        precio_compra: 10,
        costo_final: 10,
        precio_venta: 100,
        maneja_stock: true,
        tipo: "compuesto",
        componentes: [{ producto_id: insumoId, cantidad: 20 }],
        costos_extra: []
      });

      const agregar = await requestJson(baseUrl, "POST", `/productos/${recetaAId}/modificadores`, {
        nombre: `Extra consumo TEST ${Date.now()}`,
        tipo: "agregar",
        precio_extra: 10,
        componentes: [{ producto_id: insumoId, cantidad: 1 }]
      }, token);
      if (!agregar.response.ok) throw new Error(`Crear modificador agregar consumo teorico fallo: ${agregar.data?.message || agregar.response.status}`);

      const quitar = await requestJson(baseUrl, "POST", `/productos/${recetaAId}/modificadores`, {
        nombre: `Quitar consumo TEST ${Date.now()}`,
        tipo: "quitar",
        precio_extra: 0,
        componentes: [{ producto_id: insumoId, cantidad: 0.5 }]
      }, token);
      if (!quitar.response.ok) throw new Error(`Crear modificador quitar consumo teorico fallo: ${quitar.data?.message || quitar.response.status}`);

      const produccion = await requestJson(baseUrl, "POST", "/produccion", {
        producto_id: derivadoId,
        cantidad_producida: 2,
        responsable: "TEST",
        observacion: "No debe mezclarse con consumo teorico"
      }, token);
      if (!produccion.response.ok) throw new Error(`Produccion para consumo teorico fallo: ${produccion.data?.message || produccion.response.status}`);

      const venta = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test",
        tipo: "normal",
        tipo_cobro: "efectivo",
        items: [
          {
            producto_id: recetaAId,
            nombre_producto: "Receta A consumo",
            cantidad: 3,
            precio_unitario: 100,
            modificadores: [
              { modificador_id: agregar.data.modificador.id, cantidad: 1 },
              { modificador_id: quitar.data.modificador.id, cantidad: 1 }
            ]
          },
          {
            producto_id: recetaBId,
            nombre_producto: "Receta B consumo",
            cantidad: 1,
            precio_unitario: 100
          },
          {
            producto_id: derivadoId,
            nombre_producto: "Derivado con stock propio",
            cantidad: 2,
            precio_unitario: 100
          }
        ]
      }, token);
      if (!venta.response.ok) throw new Error(`Venta consumo teorico fallo: ${venta.data?.message || venta.response.status}`);

      const ventaAnulada = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test",
        tipo: "normal",
        tipo_cobro: "efectivo",
        items: [{
          producto_id: recetaBId,
          nombre_producto: "Receta B anulada",
          cantidad: 10,
          precio_unitario: 100
        }]
      }, token);
      if (!ventaAnulada.response.ok) throw new Error(`Venta anulada consumo teorico fallo: ${ventaAnulada.data?.message || ventaAnulada.response.status}`);
      const anulacion = await requestJson(baseUrl, "POST", `/ventas/${ventaAnulada.data.venta_id}/anular-cobrada`, {
        authorization_code: "1234"
      }, token);
      if (!anulacion.response.ok) throw new Error(`Anular venta consumo teorico fallo: ${anulacion.data?.message || anulacion.response.status}`);

      const consumo = await requestJson(baseUrl, "GET", "/stock/consumo-teorico", null, token);
      if (!consumo.response.ok) throw new Error(`GET consumo teorico fallo: ${consumo.data?.message || consumo.response.status}`);
      if (!Array.isArray(consumo.data.insumos)) throw new Error("Consumo teorico debe devolver insumos");
      const insumo = consumo.data.insumos.find((item) => Number(item.producto_id) === Number(insumoId));
      if (!insumo) throw new Error(`Consumo teorico debe incluir el insumo vendido. Respuesta=${JSON.stringify(consumo.data)}`);
      assertApprox(insumo.cantidad_total, 11.5, "Consumo teorico debe agrupar base de dos recetas y deltas agregar/quitar");
      if (insumo.detalle.some((item) => Number(item.producto_vendido_id) === Number(derivadoId))) {
        throw new Error("Producto compuesto con stock propio no debe expandirse en consumo teorico");
      }
      const detalleA = insumo.detalle.find((item) => Number(item.producto_vendido_id) === Number(recetaAId));
      const detalleB = insumo.detalle.find((item) => Number(item.producto_vendido_id) === Number(recetaBId));
      if (!detalleA || !detalleB) throw new Error(`Consumo teorico debe detallar ambas recetas. Detalle=${JSON.stringify(insumo.detalle)}`);
      assertApprox(detalleA.cantidad_teorica, 7.5, "Modificador agregar debe sumar y quitar debe restar sobre receta A");
      assertApprox(detalleB.cantidad_teorica, 4, "Receta B debe aportar su consumo base");
      if (!consumo.data.limitaciones?.some((item) => String(item).includes("receta actual"))) {
        throw new Error("Consumo teorico debe declarar la limitacion V1 de receta actual");
      }
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testAjustesPendientesStockInfraestructura() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const adminToken = await login(baseUrl, "admin", "admin123");
      await requestJson(baseUrl, "POST", "/usuarios", {
        nombre: "Colaborador Ajustes",
        usuario: "colaborador_ajustes",
        password: "colaborador123",
        confirmar_password: "colaborador123",
        rol: "colaborador",
        activo: true
      }, adminToken);

      const colaboradorToken = await login(baseUrl, "colaborador_ajustes", "colaborador123");
      const productoAntes = await getProduct(baseUrl, adminToken, 11);
      const movimientosAntes = await getMovimientosStock(baseUrl, adminToken, 11);

      const creado = await requestJson(baseUrl, "POST", "/stock/ajustes-pendientes", {
        producto_id: 11,
        tipo_movimiento: "ingreso",
        cantidad: 5,
        motivo: "TEST ajuste pendiente",
        observaciones: "Conteo informado por colaborador"
      }, colaboradorToken);
      if (!creado.response.ok) throw new Error(`Crear ajuste pendiente fallo: ${creado.data?.message || creado.response.status}`);

      assertEqual(creado.response.status, 201, "Crear ajuste pendiente debe responder 201");
      assertEqual(creado.data.ajuste.producto_id, 11, "Ajuste pendiente debe devolver producto_id");
      assertEqual(creado.data.ajuste.cantidad, 5, "Ajuste pendiente debe devolver cantidad");
      assertEqual(creado.data.ajuste.estado === "pendiente" ? 1 : 0, 1, "Estado inicial debe ser pendiente");
      assertEqual(creado.data.ajuste.stock_actual_snapshot, productoAntes.stock, "Snapshot debe guardar stock actual");
      if (!creado.data.ajuste.producto_nombre) throw new Error("Ajuste pendiente debe devolver producto_nombre");

      const productoDespues = await getProduct(baseUrl, adminToken, 11);
      assertEqual(productoDespues.stock, productoAntes.stock, "Crear pendiente no debe modificar productos.stock");

      const movimientosDespues = await getMovimientosStock(baseUrl, adminToken, 11);
      assertEqual(movimientosDespues.length, movimientosAntes.length, "Crear pendiente no debe insertar movimientos_stock");

      const propio = await requestJson(baseUrl, "GET", `/stock/ajustes-pendientes/${creado.data.ajuste.id}`, null, colaboradorToken);
      if (!propio.response.ok) throw new Error(`El creador debe poder ver su ajuste: ${propio.data?.message || propio.response.status}`);
      assertEqual(propio.data.id, creado.data.ajuste.id, "GET por id debe devolver el ajuste creado");

      const listado = await getAjustesPendientesStock(baseUrl, adminToken, "pendiente");
      const encontrado = listado.find((ajuste) => Number(ajuste.id) === Number(creado.data.ajuste.id));
      if (!encontrado) throw new Error("Admin debe listar el ajuste pendiente creado");
      assertEqual(encontrado.estado === "pendiente" ? 1 : 0, 1, "Listado debe conservar estado pendiente");

      const cantidadInvalida = await requestJson(baseUrl, "POST", "/stock/ajustes-pendientes", {
        producto_id: 11,
        tipo_movimiento: "ingreso",
        cantidad: 0
      }, colaboradorToken);
      assertEqual(cantidadInvalida.response.status, 400, "Cantidad invalida debe fallar");

      const tipoInvalido = await requestJson(baseUrl, "POST", "/stock/ajustes-pendientes", {
        producto_id: 11,
        tipo_movimiento: "rotura",
        cantidad: 1
      }, colaboradorToken);
      assertEqual(tipoInvalido.response.status, 400, "Tipo de movimiento invalido debe fallar");

      const productoInexistente = await requestJson(baseUrl, "POST", "/stock/ajustes-pendientes", {
        producto_id: 999999,
        tipo_movimiento: "egreso",
        cantidad: 1
      }, colaboradorToken);
      assertEqual(productoInexistente.response.status, 404, "Producto inexistente debe fallar");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testAjustePendienteRequiereStockVer() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, [
      [
        `INSERT INTO configuracion_global (clave, valor, seccion, actualizado_en)
         VALUES ('permisos_acciones_roles', ?, 'usuarios_permisos', datetime('now'))
         ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, seccion = excluded.seccion, actualizado_en = excluded.actualizado_en`,
        [JSON.stringify({ stock_ver: { admin: true, encargado: true, colaborador: false } })]
      ]
    ]);

    await withServer(dbPath, async (baseUrl) => {
      const adminToken = await login(baseUrl, "admin", "admin123");
      await requestJson(baseUrl, "POST", "/usuarios", {
        nombre: "Colaborador Sin Stock",
        usuario: "colaborador_sin_stock",
        password: "colaborador123",
        confirmar_password: "colaborador123",
        rol: "colaborador",
        activo: true
      }, adminToken);

      const colaboradorToken = await login(baseUrl, "colaborador_sin_stock", "colaborador123");
      const result = await requestJson(baseUrl, "POST", "/stock/ajustes-pendientes", {
        producto_id: 11,
        tipo_movimiento: "ingreso",
        cantidad: 1
      }, colaboradorToken);
      assertEqual(result.response.status, 403, "Usuario sin stock_ver no debe crear ajuste pendiente");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testAjustesPendientesAprobacionYRechazo() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const adminToken = await login(baseUrl, "admin", "admin123");
      await requestJson(baseUrl, "POST", "/usuarios", {
        nombre: "Colaborador Revisor",
        usuario: "colaborador_revisor",
        password: "colaborador123",
        confirmar_password: "colaborador123",
        rol: "colaborador",
        activo: true
      }, adminToken);
      const colaboradorToken = await login(baseUrl, "colaborador_revisor", "colaborador123");

      const ingreso = await crearAjustePendienteStock(baseUrl, colaboradorToken, {
        producto_id: 11,
        tipo_movimiento: "ingreso",
        cantidad: 5,
        motivo: "TEST aprobar ingreso"
      });
      const aprobarIngreso = await requestJson(baseUrl, "POST", `/stock/ajustes-pendientes/${ingreso.id}/aprobar`, {
        observaciones_admin: "OK ingreso"
      }, adminToken);
      if (!aprobarIngreso.response.ok) throw new Error(`Aprobar ingreso fallo: ${aprobarIngreso.data?.message || aprobarIngreso.response.status}`);
      assertEqual((await getProduct(baseUrl, adminToken, 11)).stock, 85, "Admin aprueba ingreso y aumenta stock");
      assertEqual(aprobarIngreso.data.ajuste.estado === "aprobado" ? 1 : 0, 1, "Aprobar sin cambios debe dejar estado aprobado");
      if (!aprobarIngreso.data.ajuste.movimiento_stock_id) throw new Error("Aprobar debe guardar movimiento_stock_id");
      if (!String(aprobarIngreso.data.ajuste.observaciones_admin || "").includes("OK ingreso")) throw new Error("Observaciones admin deben quedar guardadas");
      const movimientosIngreso = await getMovimientosStock(baseUrl, adminToken, 11);
      const movIngreso = movimientosIngreso.find((m) => Number(m.id) === Number(aprobarIngreso.data.ajuste.movimiento_stock_id));
      if (!movIngreso) throw new Error("Aprobar debe crear movimiento en movimientos_stock");
      assertEqual(movIngreso.tipo_movimiento === "ingreso" ? 1 : 0, 1, "Movimiento aprobado ingreso debe ser ingreso");
      assertEqual(movIngreso.cantidad, 5, "Movimiento aprobado debe guardar cantidad original");

      const doble = await requestJson(baseUrl, "POST", `/stock/ajustes-pendientes/${ingreso.id}/aprobar`, {}, adminToken);
      assertEqual(doble.response.status, 409, "Aprobar dos veces debe fallar");
      assertEqual((await getProduct(baseUrl, adminToken, 11)).stock, 85, "Aprobar dos veces no debe duplicar stock");

      const egreso = await crearAjustePendienteStock(baseUrl, colaboradorToken, {
        producto_id: 11,
        tipo_movimiento: "egreso",
        cantidad: 3,
        motivo: "TEST aprobar egreso"
      });
      const aprobarEgreso = await requestJson(baseUrl, "POST", `/stock/ajustes-pendientes/${egreso.id}/aprobar`, {}, adminToken);
      if (!aprobarEgreso.response.ok) throw new Error(`Aprobar egreso fallo: ${aprobarEgreso.data?.message || aprobarEgreso.response.status}`);
      assertEqual((await getProduct(baseUrl, adminToken, 11)).stock, 82, "Admin aprueba egreso y reduce stock");

      const corregirCantidad = await crearAjustePendienteStock(baseUrl, colaboradorToken, {
        producto_id: 11,
        tipo_movimiento: "ingreso",
        cantidad: 2,
        motivo: "TEST corregir cantidad"
      });
      const aprobarCantidad = await requestJson(baseUrl, "POST", `/stock/ajustes-pendientes/${corregirCantidad.id}/aprobar`, {
        cantidad_aprobada: 4,
        observaciones_admin: "Corrijo cantidad"
      }, adminToken);
      if (!aprobarCantidad.response.ok) throw new Error(`Corregir cantidad fallo: ${aprobarCantidad.data?.message || aprobarCantidad.response.status}`);
      assertEqual(aprobarCantidad.data.ajuste.estado === "corregido" ? 1 : 0, 1, "Cambiar cantidad debe dejar estado corregido");
      assertEqual(aprobarCantidad.data.ajuste.cantidad_aprobada, 4, "Debe guardar cantidad corregida");
      assertEqual((await getProduct(baseUrl, adminToken, 11)).stock, 86, "Corregir cantidad aplica cantidad corregida");

      const corregirTipo = await crearAjustePendienteStock(baseUrl, colaboradorToken, {
        producto_id: 11,
        tipo_movimiento: "ingreso",
        cantidad: 6,
        motivo: "TEST corregir tipo"
      });
      const aprobarTipo = await requestJson(baseUrl, "POST", `/stock/ajustes-pendientes/${corregirTipo.id}/aprobar`, {
        tipo_movimiento_aprobado: "egreso",
        observaciones_admin: "Era egreso"
      }, adminToken);
      if (!aprobarTipo.response.ok) throw new Error(`Corregir tipo fallo: ${aprobarTipo.data?.message || aprobarTipo.response.status}`);
      assertEqual(aprobarTipo.data.ajuste.estado === "corregido" ? 1 : 0, 1, "Cambiar tipo debe dejar estado corregido");
      assertEqual(aprobarTipo.data.ajuste.tipo_movimiento_aprobado === "egreso" ? 1 : 0, 1, "Debe guardar tipo corregido");
      assertEqual((await getProduct(baseUrl, adminToken, 11)).stock, 80, "Corregir tipo aplica tipo corregido");

      const rechazo = await crearAjustePendienteStock(baseUrl, colaboradorToken, {
        producto_id: 11,
        tipo_movimiento: "ingreso",
        cantidad: 9,
        motivo: "TEST rechazar"
      });
      const movimientosAntesRechazo = await getMovimientosStock(baseUrl, adminToken, 11);
      const rechazar = await requestJson(baseUrl, "POST", `/stock/ajustes-pendientes/${rechazo.id}/rechazar`, {
        observaciones_admin: "No corresponde"
      }, adminToken);
      if (!rechazar.response.ok) throw new Error(`Rechazar fallo: ${rechazar.data?.message || rechazar.response.status}`);
      assertEqual(rechazar.data.ajuste.estado === "rechazado" ? 1 : 0, 1, "Rechazo debe dejar estado rechazado");
      assertEqual((await getProduct(baseUrl, adminToken, 11)).stock, 80, "Rechazar no cambia stock");
      const movimientosDespuesRechazo = await getMovimientosStock(baseUrl, adminToken, 11);
      assertEqual(movimientosDespuesRechazo.length, movimientosAntesRechazo.length, "Rechazar no crea movimiento");
      if (!String(rechazar.data.ajuste.observaciones_admin || "").includes("No corresponde")) throw new Error("Rechazo debe guardar observaciones admin");

      const rechazarAprobado = await requestJson(baseUrl, "POST", `/stock/ajustes-pendientes/${ingreso.id}/rechazar`, {}, adminToken);
      assertEqual(rechazarAprobado.response.status, 409, "Pendiente aprobado no puede rechazarse despues");

      const pendienteColaborador = await crearAjustePendienteStock(baseUrl, colaboradorToken, {
        producto_id: 11,
        tipo_movimiento: "ingreso",
        cantidad: 1,
        motivo: "TEST colaborador no aprueba"
      });
      const aprobarColaborador = await requestJson(baseUrl, "POST", `/stock/ajustes-pendientes/${pendienteColaborador.id}/aprobar`, {}, colaboradorToken);
      assertEqual(aprobarColaborador.response.status, 403, "Colaborador no puede aprobar");
      const rechazarColaborador = await requestJson(baseUrl, "POST", `/stock/ajustes-pendientes/${pendienteColaborador.id}/rechazar`, {}, colaboradorToken);
      assertEqual(rechazarColaborador.response.status, 403, "Colaborador no puede rechazar");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testReconciliarAjustesPendientesStock() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const adminToken = await login(baseUrl, "admin", "admin123");
      await requestJson(baseUrl, "POST", "/usuarios", {
        nombre: "Colaborador Reconciliar",
        usuario: "colaborador_reconciliar",
        password: "colaborador123",
        confirmar_password: "colaborador123",
        rol: "colaborador",
        activo: true
      }, adminToken);
      await requestJson(baseUrl, "POST", "/usuarios", {
        nombre: "Colaborador Ajeno",
        usuario: "colaborador_ajeno",
        password: "colaborador123",
        confirmar_password: "colaborador123",
        rol: "colaborador",
        activo: true
      }, adminToken);

      const colaboradorToken = await login(baseUrl, "colaborador_reconciliar", "colaborador123");
      const ajenoToken = await login(baseUrl, "colaborador_ajeno", "colaborador123");

      const pendiente = await crearAjustePendienteStock(baseUrl, colaboradorToken, {
        producto_id: 11,
        tipo_movimiento: "ingreso",
        cantidad: 1,
        motivo: "TEST reconciliar pendiente"
      });
      const aprobado = await crearAjustePendienteStock(baseUrl, colaboradorToken, {
        producto_id: 11,
        tipo_movimiento: "ingreso",
        cantidad: 2,
        motivo: "TEST reconciliar aprobado"
      });
      const corregido = await crearAjustePendienteStock(baseUrl, colaboradorToken, {
        producto_id: 11,
        tipo_movimiento: "ingreso",
        cantidad: 3,
        motivo: "TEST reconciliar corregido"
      });
      const rechazado = await crearAjustePendienteStock(baseUrl, colaboradorToken, {
        producto_id: 11,
        tipo_movimiento: "ingreso",
        cantidad: 4,
        motivo: "TEST reconciliar rechazado"
      });
      const ajeno = await crearAjustePendienteStock(baseUrl, ajenoToken, {
        producto_id: 11,
        tipo_movimiento: "ingreso",
        cantidad: 5,
        motivo: "TEST reconciliar ajeno"
      });

      await requestJson(baseUrl, "POST", `/stock/ajustes-pendientes/${aprobado.id}/aprobar`, {}, adminToken);
      await requestJson(baseUrl, "POST", `/stock/ajustes-pendientes/${corregido.id}/aprobar`, {
        cantidad_aprobada: 6,
        observaciones_admin: "Corrijo para reconciliar"
      }, adminToken);
      await requestJson(baseUrl, "POST", `/stock/ajustes-pendientes/${rechazado.id}/rechazar`, {
        observaciones_admin: "No corresponde reconciliar"
      }, adminToken);

      const ids = [pendiente.id, aprobado.id, corregido.id, rechazado.id, ajeno.id, 999999];
      const propios = await reconciliarAjustesPendientesStock(baseUrl, colaboradorToken, ids);
      const estadosPropios = new Map(propios.map((ajuste) => [Number(ajuste.id), ajuste.estado]));

      assertEqual(estadosPropios.get(pendiente.id) === "pendiente" ? 1 : 0, 1, "Reconciliar debe devolver pendiente propio");
      assertEqual(estadosPropios.get(aprobado.id) === "aprobado" ? 1 : 0, 1, "Reconciliar debe devolver aprobado propio");
      assertEqual(estadosPropios.get(corregido.id) === "corregido" ? 1 : 0, 1, "Reconciliar debe devolver corregido propio");
      assertEqual(estadosPropios.get(rechazado.id) === "rechazado" ? 1 : 0, 1, "Reconciliar debe devolver rechazado propio");
      if (estadosPropios.has(ajeno.id)) throw new Error("Colaborador no debe reconciliar ajustes de otro usuario");
      if (estadosPropios.has(999999)) throw new Error("Reconciliar no debe devolver IDs inexistentes");

      const admin = await reconciliarAjustesPendientesStock(baseUrl, adminToken, ids);
      const estadosAdmin = new Map(admin.map((ajuste) => [Number(ajuste.id), ajuste.estado]));
      assertEqual(estadosAdmin.get(ajeno.id) === "pendiente" ? 1 : 0, 1, "Admin debe reconciliar ajustes de otros usuarios");

      const locales = propios.map((ajuste) => ({ id: ajuste.id, producto_id: ajuste.producto_id, estado: ajuste.estado }));
      const localesPendientes = locales.filter((ajuste) => String(ajuste.estado) === "pendiente");
      assertEqual(localesPendientes.length, 1, "Frontend debe conservar solo pendientes al filtrar la respuesta reconciliada");
      assertEqual(localesPendientes[0].id, pendiente.id, "Frontend debe conservar el ID pendiente correcto");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testResolverAjustePendienteConVenta() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);

  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const adminToken = await login(baseUrl, "admin", "admin123");
      await requestJson(baseUrl, "POST", "/usuarios", {
        nombre: "Colaborador Resolver",
        usuario: "colaborador_resolver",
        password: "colaborador123",
        confirmar_password: "colaborador123",
        rol: "colaborador",
        activo: true
      }, adminToken);
      const colaboradorToken = await login(baseUrl, "colaborador_resolver", "colaborador123");
      const clienteCC = await requestJson(baseUrl, "POST", "/clientes", {
        nombre: "Cliente Resolver CC",
        dni_cuit: `resolver-${Date.now()}`,
        tipo_cliente: "cliente",
        habilita_cuenta_corriente: true,
        activo: true
      }, adminToken);
      if (!clienteCC.response.ok) throw new Error(`No se pudo crear cliente CC resolver: ${clienteCC.data?.message || clienteCC.response.status}`);
      await abrirCaja(baseUrl, adminToken, 1000);

      const ajusteCobrar = await crearAjustePendienteStock(baseUrl, colaboradorToken, {
        producto_id: 11,
        tipo_movimiento: "egreso",
        cantidad: 3,
        motivo: "TEST resolver parcial"
      });
      const resumenAntesResolver = await requestJson(baseUrl, "GET", "/stock/ajustes-pendientes/resumen", null, adminToken);
      if (!resumenAntesResolver.response.ok) throw new Error(`Resumen antes de resolver fallo: ${resumenAntesResolver.data?.message || resumenAntesResolver.response.status}`);
      assertEqual(resumenAntesResolver.data.pendientes, 1, "Ajuste creado debe contar como pendiente accionable");
      assertEqual(resumenAntesResolver.data.pendientes_accionables, 1, "Ajuste creado debe contar como pendiente accionable explicito");
      const listadoAccionableAntes = await requestJson(baseUrl, "GET", "/stock/ajustes-pendientes?estado=pendiente&solo_accionables=1", null, adminToken);
      if (!listadoAccionableAntes.response.ok) throw new Error(`Listado accionable antes de resolver fallo: ${listadoAccionableAntes.data?.message || listadoAccionableAntes.response.status}`);
      if (!listadoAccionableAntes.data.some((a) => Number(a.id) === Number(ajusteCobrar.id))) {
        throw new Error("Ajuste creado debe aparecer en listado solo_accionables");
      }
      const stockAntesParcial = (await getProduct(baseUrl, adminToken, 11)).stock;
      const ventaCobrar = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        items: [{ producto_id: 11, nombre_producto: "Coca Cola 1250", cantidad: 1, precio_unitario: 100 }]
      }), adminToken);
      if (!ventaCobrar.response.ok) throw new Error(`Venta normal para resolver fallo: ${ventaCobrar.data?.message || ventaCobrar.response.status}`);
      assertEqual((await getProduct(baseUrl, adminToken, 11)).stock, stockAntesParcial - 1, "Resolver parcial debe descontar stock por cantidad vendida");
      const movimientosAntesResolver = await getMovimientosStock(baseUrl, adminToken, 11);
      const resolverCobrar = await requestJson(baseUrl, "POST", `/stock/ajustes-pendientes/${ajusteCobrar.id}/resolver`, {
        venta_id: ventaCobrar.data.venta_id,
        tipo_resolucion: "cobrar",
        usuario: "admin"
      }, adminToken);
      if (!resolverCobrar.response.ok) throw new Error(`Resolver ajuste cobrar fallo: ${resolverCobrar.data?.message || resolverCobrar.response.status}`);
      assertEqual(resolverCobrar.data.ajuste.venta_id, ventaCobrar.data.venta_id, "Resolver debe guardar venta_id");
      if (resolverCobrar.data.ajuste.tipo_resolucion !== "cobrar") throw new Error("Resolver debe guardar tipo_resolucion cobrar");
      if (resolverCobrar.data.ajuste.estado !== "pendiente") throw new Error("Resolver no debe cambiar estado persistido del ajuste");
      assertEqual(resolverCobrar.data.ajuste.cantidad_resuelta, 1, "Resolver parcial debe guardar cantidad_resuelta");
      assertEqual(resolverCobrar.data.ajuste.cantidad_pendiente_resolucion, 2, "Resolver parcial debe guardar cantidad pendiente restante");
      assertEqual(resolverCobrar.data.ajuste.resolucion_parcial, 1, "Resolver parcial debe marcar resolucion_parcial");
      const resumenDespuesResolver = await requestJson(baseUrl, "GET", "/stock/ajustes-pendientes/resumen", null, adminToken);
      if (!resumenDespuesResolver.response.ok) throw new Error(`Resumen despues de resolver fallo: ${resumenDespuesResolver.data?.message || resumenDespuesResolver.response.status}`);
      assertEqual(resumenDespuesResolver.data.pendientes, 1, "Resolver parcial debe conservar el ajuste como pendiente accionable");
      assertEqual(resumenDespuesResolver.data.pendientes_accionables, 1, "Resolver parcial debe conservar el ajuste como pendiente accionable explicito");
      assertEqual(resumenDespuesResolver.data.resueltos_por_venta, 0, "Resolver parcial no debe contar como resuelto completo por venta");
      const listadoNormalDespues = await requestJson(baseUrl, "GET", "/stock/ajustes-pendientes?estado=pendiente", null, adminToken);
      if (!listadoNormalDespues.response.ok) throw new Error(`Listado normal despues de resolver fallo: ${listadoNormalDespues.data?.message || listadoNormalDespues.response.status}`);
      if (!listadoNormalDespues.data.some((a) => Number(a.id) === Number(ajusteCobrar.id))) {
        throw new Error("Ajuste resuelto por venta debe seguir en listado normal estado=pendiente");
      }
      const listadoAccionableDespues = await requestJson(baseUrl, "GET", "/stock/ajustes-pendientes?estado=pendiente&solo_accionables=1", null, adminToken);
      if (!listadoAccionableDespues.response.ok) throw new Error(`Listado accionable despues de resolver fallo: ${listadoAccionableDespues.data?.message || listadoAccionableDespues.response.status}`);
      if (!listadoAccionableDespues.data.some((a) => Number(a.id) === Number(ajusteCobrar.id))) {
        throw new Error("Ajuste resuelto parcialmente debe seguir en listado solo_accionables");
      }
      const movimientosDespuesResolver = await getMovimientosStock(baseUrl, adminToken, 11);
      assertEqual(movimientosDespuesResolver.length, movimientosAntesResolver.length, "Resolver ajuste no debe insertar movimientos_stock");

      const dobleResolver = await requestJson(baseUrl, "POST", `/stock/ajustes-pendientes/${ajusteCobrar.id}/resolver`, {
        venta_id: ventaCobrar.data.venta_id,
        tipo_resolucion: "cobrar"
      }, adminToken);
      assertEqual(dobleResolver.response.status, 409, "Resolver dos veces debe fallar");

      const ajusteCompleto = await crearAjustePendienteStock(baseUrl, colaboradorToken, {
        producto_id: 11,
        tipo_movimiento: "egreso",
        cantidad: 3,
        motivo: "TEST resolver completo"
      });
      const ventaCompleta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        items: [{ producto_id: 11, nombre_producto: "Coca Cola 1250", cantidad: 3, precio_unitario: 100 }]
      }), adminToken);
      if (!ventaCompleta.response.ok) throw new Error(`Venta completa para resolver fallo: ${ventaCompleta.data?.message || ventaCompleta.response.status}`);
      const resolverCompleto = await requestJson(baseUrl, "POST", `/stock/ajustes-pendientes/${ajusteCompleto.id}/resolver`, {
        venta_id: ventaCompleta.data.venta_id,
        tipo_resolucion: "cobrar",
        usuario: "admin"
      }, adminToken);
      if (!resolverCompleto.response.ok) throw new Error(`Resolver ajuste completo fallo: ${resolverCompleto.data?.message || resolverCompleto.response.status}`);
      assertEqual(resolverCompleto.data.ajuste.cantidad_resuelta, 3, "Resolver completo debe guardar cantidad_resuelta total");
      assertEqual(resolverCompleto.data.ajuste.cantidad_pendiente_resolucion, 0, "Resolver completo no debe dejar cantidad pendiente");
      assertEqual(resolverCompleto.data.ajuste.resolucion_parcial, 0, "Resolver completo no debe marcar parcial");
      const listadoAccionableCompleto = await requestJson(baseUrl, "GET", "/stock/ajustes-pendientes?estado=pendiente&solo_accionables=1", null, adminToken);
      if (!listadoAccionableCompleto.response.ok) throw new Error(`Listado accionable completo fallo: ${listadoAccionableCompleto.data?.message || listadoAccionableCompleto.response.status}`);
      if (listadoAccionableCompleto.data.some((a) => Number(a.id) === Number(ajusteCompleto.id))) {
        throw new Error("Ajuste resuelto completo no debe aparecer en listado solo_accionables");
      }

      const ajusteCuenta = await crearAjustePendienteStock(baseUrl, colaboradorToken, {
        producto_id: 11,
        tipo_movimiento: "egreso",
        cantidad: 1,
        motivo: "TEST resolver cuenta corriente"
      });
      const ventaCuenta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        es_cuenta_corriente: true,
        cliente_id: clienteCC.data.cliente.id
      }), adminToken);
      if (!ventaCuenta.response.ok) throw new Error(`Venta cuenta corriente para resolver fallo: ${ventaCuenta.data?.message || ventaCuenta.response.status}`);
      const resolverCuenta = await requestJson(baseUrl, "POST", `/stock/ajustes-pendientes/${ajusteCuenta.id}/resolver`, {
        venta_id: ventaCuenta.data.venta_id,
        tipo_resolucion: "cuenta_corriente",
        usuario: "admin"
      }, adminToken);
      if (!resolverCuenta.response.ok) throw new Error(`Resolver ajuste cuenta corriente fallo: ${resolverCuenta.data?.message || resolverCuenta.response.status}`);
      assertEqual(resolverCuenta.data.ajuste.venta_id, ventaCuenta.data.venta_id, "Resolver CC debe guardar venta_id");
      if (resolverCuenta.data.ajuste.tipo_resolucion !== "cuenta_corriente") throw new Error("Resolver debe guardar tipo_resolucion cuenta_corriente");

      const rechazarResuelto = await requestJson(baseUrl, "POST", `/stock/ajustes-pendientes/${ajusteCobrar.id}/rechazar`, {
        observaciones_admin: "Rechazo administrativo posterior"
      }, adminToken);
      if (!rechazarResuelto.response.ok) throw new Error(`Rechazar ajuste resuelto por venta debe seguir funcionando: ${rechazarResuelto.data?.message || rechazarResuelto.response.status}`);
      if (rechazarResuelto.data.ajuste.estado !== "rechazado") throw new Error("Rechazar debe conservar flujo administrativo existente");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testAjusteVentaRecetaConVentaIdEsAccionable() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);

  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const adminToken = await login(baseUrl, "admin", "admin123");

      const ensureResumen = await requestJson(baseUrl, "GET", "/stock/ajustes-pendientes/resumen", null, adminToken);
      if (!ensureResumen.response.ok) throw new Error(`Ensure resumen ajustes fallo: ${ensureResumen.data?.message || ensureResumen.response.status}`);

      const { lastID: ventaId } = await runSql(
        dbPath,
        `INSERT INTO ventas
         (fecha, hora, usuario, total, tipo, estado, metodo_pago, tipo_cobro, monto_efectivo, monto_debito, es_cuenta_corriente, saldo_pendiente)
         VALUES ('2024-01-20', '12:00:00', 'test', 100, 'normal', 'cobrada', 'efectivo', 'efectivo', 100, 0, 0, 0)`
      );
      const { lastID: detalleVentaId } = await runSql(
        dbPath,
        `INSERT INTO detalle_ventas (venta_id, producto_id, nombre_producto, cantidad, precio_unitario, subtotal)
         VALUES (?, 4, 'TEST Receta sin stock', 1, 100, 100)`,
        [ventaId]
      );
      const { lastID: ajusteId } = await runSql(
        dbPath,
        `INSERT INTO stock_ajustes_pendientes
         (producto_id, componente_id, tipo_movimiento, cantidad, cantidad_teorica,
          motivo, observaciones, proveedor_id, stock_actual_snapshot, estado,
          solicitado_por, solicitado_rol, fecha, hora, created_at, caja_id,
          venta_id, detalle_venta_id, producto_vendido_id, producto_vendido_nombre_snapshot, origen)
         VALUES (11, 11, 'egreso', 2, 2, 'TEST venta receta accionable', '', NULL, 80, 'pendiente',
                 'test', 'admin', '2024-01-20', '12:01:00', datetime('now'), NULL,
                 ?, ?, 4, 'TEST Receta sin stock', 'venta_receta')`,
        [ventaId, detalleVentaId]
      );

      const listadoAccionable = await requestJson(baseUrl, "GET", "/stock/ajustes-pendientes?estado=pendiente&solo_accionables=1", null, adminToken);
      if (!listadoAccionable.response.ok) throw new Error(`Listado venta_receta accionable fallo: ${listadoAccionable.data?.message || listadoAccionable.response.status}`);
      const ajuste = listadoAccionable.data.find((item) => Number(item.id) === Number(ajusteId));
      if (!ajuste) throw new Error("Ajuste venta_receta con venta_id debe aparecer en solo_accionables=1");
      if (ajuste.origen !== "venta_receta") throw new Error(`Ajuste debe conservar origen venta_receta. Actual=${ajuste.origen}`);
      assertEqual(ajuste.venta_id, ventaId, "Ajuste venta_receta debe conservar venta_id como origen");
      assertEqual(ajuste.detalle_venta_id, detalleVentaId, "Ajuste venta_receta debe conservar detalle_venta_id");
      assertEqual(ajuste.producto_vendido_id, 4, "Ajuste venta_receta debe conservar producto_vendido_id");
      assertApprox(ajuste.cantidad_teorica, 2, "Ajuste venta_receta debe exponer cantidad_teorica");

      const resumen = await requestJson(baseUrl, "GET", "/stock/ajustes-pendientes/resumen", null, adminToken);
      if (!resumen.response.ok) throw new Error(`Resumen venta_receta accionable fallo: ${resumen.data?.message || resumen.response.status}`);
      assertEqual(resumen.data.pendientes, 1, "Ajuste venta_receta debe contar como pendiente real");
      assertEqual(resumen.data.pendientes_accionables, 1, "Ajuste venta_receta debe contar como pendiente accionable");
      assertEqual(resumen.data.resueltos_por_venta, 0, "Ajuste venta_receta no debe contar como resuelto_por_venta por tener venta_id");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testResolverAjustePendienteConCuentaLocal() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);

  try {
    await prepareDb(dbPath, [
      ...resetOperationalDataStatements(),
      [
        `INSERT INTO configuracion_global (clave, valor, seccion, actualizado_en)
         VALUES ('cuenta_local_activa', 'false', 'cuentas_corrientes', datetime('now'))
         ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, seccion = excluded.seccion, actualizado_en = excluded.actualizado_en`
      ],
      [
        `INSERT INTO configuracion_global (clave, valor, seccion, actualizado_en)
         VALUES ('cuenta_local_nombre', '"Guernica Local"', 'cuentas_corrientes', datetime('now'))
         ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, seccion = excluded.seccion, actualizado_en = excluded.actualizado_en`
      ],
      [
        `INSERT INTO configuracion_global (clave, valor, seccion, actualizado_en)
         VALUES ('cuenta_local_produccion_activa', 'true', 'cuentas_corrientes', datetime('now'))
         ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, seccion = excluded.seccion, actualizado_en = excluded.actualizado_en`
      ],
      [
        `INSERT INTO configuracion_global (clave, valor, seccion, actualizado_en)
         VALUES ('cuenta_local_interno_cortesia_activa', 'true', 'cuentas_corrientes', datetime('now'))
         ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, seccion = excluded.seccion, actualizado_en = excluded.actualizado_en`
      ]
    ]);

    await withServer(dbPath, async (baseUrl) => {
      const adminToken = await login(baseUrl, "admin", "admin123");
      await requestJson(baseUrl, "POST", "/usuarios", {
        nombre: "Colaborador Cuenta Local",
        usuario: "colaborador_cuenta_local",
        password: "colaborador123",
        confirmar_password: "colaborador123",
        rol: "colaborador",
        activo: true
      }, adminToken);
      const colaboradorToken = await login(baseUrl, "colaborador_cuenta_local", "colaborador123");

      const ajusteInactivo = await crearAjustePendienteStock(baseUrl, colaboradorToken, {
        producto_id: 11,
        tipo_movimiento: "egreso",
        cantidad: 1,
        motivo: "TEST cuenta local inactiva"
      });
      const inactivo = await requestJson(baseUrl, "POST", `/stock/ajustes-pendientes/${ajusteInactivo.id}/cuenta-local`, {
        integracion: "interno_cortesia",
        responsable: "Test",
        observacion: "Debe rechazar"
      }, adminToken);
      assertEqual(inactivo.response.status, 400, "Cuenta Local inactiva debe rechazar");

      await runSql(dbPath,
        `UPDATE configuracion_global SET valor = 'true', actualizado_en = datetime('now') WHERE clave = 'cuenta_local_activa'`
      );
      await runSql(dbPath,
        `UPDATE configuracion_global SET valor = 'false', actualizado_en = datetime('now') WHERE clave = 'cuenta_local_produccion_activa'`
      );

      const ajusteProduccionOff = await crearAjustePendienteStock(baseUrl, colaboradorToken, {
        producto_id: 11,
        tipo_movimiento: "egreso",
        cantidad: 1,
        motivo: "TEST produccion off"
      });
      const produccionOff = await requestJson(baseUrl, "POST", `/stock/ajustes-pendientes/${ajusteProduccionOff.id}/cuenta-local`, {
        integracion: "produccion",
        responsable: "Produccion",
        observacion: "Debe rechazar"
      }, adminToken);
      assertEqual(produccionOff.response.status, 400, "Integracion deshabilitada debe rechazar");

      await runSql(dbPath,
        `UPDATE configuracion_global SET valor = 'true', actualizado_en = datetime('now') WHERE clave = 'cuenta_local_produccion_activa'`
      );

      const categoriaRecetaId = await crearCategoria(baseUrl, adminToken, "Cuenta Local Recetas");
      const recetaId = await crearProducto(baseUrl, adminToken, {
        nombre: "Receta sin stock Cuenta Local",
        categoria_id: categoriaRecetaId,
        tipo: "compuesto",
        maneja_stock: false,
        rendimiento_receta: 1,
        stock: 0
      });
      const ajusteReceta = await crearAjustePendienteStock(baseUrl, colaboradorToken, {
        producto_id: recetaId,
        tipo_movimiento: "egreso",
        cantidad: 1,
        motivo: "TEST receta sin stock"
      });
      const receta = await requestJson(baseUrl, "POST", `/stock/ajustes-pendientes/${ajusteReceta.id}/cuenta-local`, {
        integracion: "interno_cortesia",
        responsable: "Test",
        observacion: "Debe rechazar receta"
      }, adminToken);
      assertEqual(receta.response.status, 400, "Receta sin stock fisico debe rechazar Cuenta Local");

      const ventasAntes = await allSql(dbPath, "SELECT COUNT(*) AS total, COALESCE(SUM(saldo_pendiente), 0) AS saldo FROM ventas");
      const pagosCcAntes = await allSql(dbPath, "SELECT COUNT(*) AS total FROM pagos_cuenta_corriente");
      const stockAntes = (await getProduct(baseUrl, adminToken, 11)).stock;
      const movimientosAntes = await getMovimientosStock(baseUrl, adminToken, 11);

      const ajusteCuentaLocal = await crearAjustePendienteStock(baseUrl, colaboradorToken, {
        producto_id: 11,
        tipo_movimiento: "egreso",
        cantidad: 3,
        motivo: "TEST cuenta local ok"
      });
      const resolver = await requestJson(baseUrl, "POST", `/stock/ajustes-pendientes/${ajusteCuentaLocal.id}/cuenta-local`, {
        integracion: "interno_cortesia",
        responsable: "Mostrador",
        observacion: "Consumo interno test"
      }, adminToken);
      if (!resolver.response.ok) throw new Error(`Resolver Cuenta Local fallo: ${resolver.data?.message || resolver.response.status}`);

      assertEqual((await getProduct(baseUrl, adminToken, 11)).stock, stockAntes - 3, "Cuenta Local debe descontar stock fisico");
      if (resolver.data.ajuste.tipo_resolucion !== "cuenta_local") throw new Error("Cuenta Local debe guardar tipo_resolucion");
      if (resolver.data.ajuste.estado !== "aprobado") throw new Error("Cuenta Local debe aprobar el ajuste fisico");
      assertEqual(resolver.data.ajuste.cantidad_aprobada, 3, "Cuenta Local debe guardar cantidad_aprobada");
      if (resolver.data.ajuste.tipo_movimiento_aprobado !== "egreso") throw new Error("Cuenta Local debe guardar egreso aprobado");
      if (!resolver.data.ajuste.movimiento_stock_id) throw new Error("Cuenta Local debe crear movimiento_stock");
      if (resolver.data.ajuste.cuenta_local_integracion !== "interno_cortesia") throw new Error("Cuenta Local debe guardar integracion");
      if (resolver.data.ajuste.cuenta_local_nombre_snapshot !== "Guernica Local") throw new Error("Cuenta Local debe guardar nombre snapshot");

      const movimientosDespues = await getMovimientosStock(baseUrl, adminToken, 11);
      assertEqual(movimientosDespues.length, movimientosAntes.length + 1, "Cuenta Local debe registrar movimiento stock");

      const ventasDespues = await allSql(dbPath, "SELECT COUNT(*) AS total, COALESCE(SUM(saldo_pendiente), 0) AS saldo FROM ventas");
      const pagosCcDespues = await allSql(dbPath, "SELECT COUNT(*) AS total FROM pagos_cuenta_corriente");
      assertEqual(ventasDespues[0].total, ventasAntes[0].total, "Cuenta Local no debe crear venta");
      assertEqual(pagosCcDespues[0].total, pagosCcAntes[0].total, "Cuenta Local no debe crear pago cuenta corriente");
      assertEqual(Number(ventasDespues[0].saldo || 0), Number(ventasAntes[0].saldo || 0), "Cuenta Local no debe modificar saldo pendiente");

      const accionables = await requestJson(baseUrl, "GET", "/stock/ajustes-pendientes?estado=pendiente&solo_accionables=1", null, adminToken);
      if (!accionables.response.ok) throw new Error(`Listado accionable Cuenta Local fallo: ${accionables.data?.message || accionables.response.status}`);
      if (accionables.data.some((a) => Number(a.id) === Number(ajusteCuentaLocal.id))) {
        throw new Error("Cuenta Local no debe quedar como pendiente accionable");
      }
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testClientesTipoClienteClasificacion() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const sufijo = Date.now().toString().slice(-8);

      const negocio = await requestJson(baseUrl, "POST", "/clientes", {
        nombre: "Cliente Tipo Negocio",
        dni_cuit: `TCN-${sufijo}`,
        tipo_cliente: "negocio",
        tipo_cuenta_corriente: "personal",
        tipo_persona: "fisica",
        habilita_cuenta_corriente: true,
        activo: true
      }, token);
      if (!negocio.response.ok) throw new Error(`Crear cliente negocio fallo: ${negocio.data?.message || negocio.response.status}`);
      if (negocio.data.cliente.tipo_cliente !== "negocio") throw new Error(`El alta debe guardar tipo_cliente negocio. Actual=${negocio.data.cliente.tipo_cliente}`);
      if (negocio.data.cliente.tipo_cuenta_corriente !== "personal") throw new Error(`El alta debe guardar tipo_cuenta_corriente personal. Actual=${negocio.data.cliente.tipo_cuenta_corriente}`);

      const detalleNegocio = await requestJson(baseUrl, "GET", `/clientes/${negocio.data.cliente.id}`, null, token);
      if (!detalleNegocio.response.ok) throw new Error(`GET /clientes/:id fallo: ${detalleNegocio.data?.message || detalleNegocio.response.status}`);
      if (detalleNegocio.data.tipo_cliente !== "negocio") throw new Error(`GET /clientes/:id debe devolver tipo_cliente. Actual=${detalleNegocio.data.tipo_cliente}`);
      if (detalleNegocio.data.tipo_cuenta_corriente !== "personal") throw new Error(`GET /clientes/:id debe devolver tipo_cuenta_corriente. Actual=${detalleNegocio.data.tipo_cuenta_corriente}`);

      const actualizado = await requestJson(baseUrl, "PUT", `/clientes/${negocio.data.cliente.id}`, {
        ...detalleNegocio.data,
        tipo_cliente: "colaborador",
        tipo_cuenta_corriente: "cortesia"
      }, token);
      if (!actualizado.response.ok) throw new Error(`Editar cliente tipo colaborador fallo: ${actualizado.data?.message || actualizado.response.status}`);
      if (actualizado.data.cliente.tipo_cliente !== "colaborador") throw new Error(`La edicion debe guardar tipo_cliente colaborador. Actual=${actualizado.data.cliente.tipo_cliente}`);
      if (actualizado.data.cliente.tipo_cuenta_corriente !== "cortesia") throw new Error(`La edicion debe guardar tipo_cuenta_corriente cortesia. Actual=${actualizado.data.cliente.tipo_cuenta_corriente}`);

      const sinTipo = await requestJson(baseUrl, "POST", "/clientes", {
        nombre: "Cliente Sin Tipo",
        dni_cuit: `TCS-${sufijo}`,
        tipo_persona: "fisica",
        habilita_cuenta_corriente: true,
        activo: true
      }, token);
      if (!sinTipo.response.ok) throw new Error(`Crear cliente sin tipo_cliente fallo: ${sinTipo.data?.message || sinTipo.response.status}`);
      if (sinTipo.data.cliente.tipo_cliente !== "cliente") throw new Error(`Cliente sin tipo_cliente debe quedar como cliente. Actual=${sinTipo.data.cliente.tipo_cliente}`);
      if (sinTipo.data.cliente.tipo_cuenta_corriente !== "cliente") throw new Error(`Cliente sin tipo_cuenta_corriente debe quedar como cliente. Actual=${sinTipo.data.cliente.tipo_cuenta_corriente}`);

      const invalido = await requestJson(baseUrl, "POST", "/clientes", {
        nombre: "Cliente Tipo Invalido",
        dni_cuit: `TCI-${sufijo}`,
        tipo_cliente: "vip",
        tipo_cuenta_corriente: "externa",
        tipo_persona: "fisica",
        habilita_cuenta_corriente: true,
        activo: true
      }, token);
      if (!invalido.response.ok) throw new Error(`Crear cliente con tipo invalido fallo: ${invalido.data?.message || invalido.response.status}`);
      if (invalido.data.cliente.tipo_cliente !== "cliente") throw new Error(`Tipo_cliente invalido debe normalizarse a cliente. Actual=${invalido.data.cliente.tipo_cliente}`);
      if (invalido.data.cliente.tipo_cuenta_corriente !== "cliente") throw new Error(`Tipo_cuenta_corriente invalido debe normalizarse a cliente. Actual=${invalido.data.cliente.tipo_cuenta_corriente}`);

      const listado = await requestJson(baseUrl, "GET", "/clientes?include_inactive=1", null, token);
      if (!listado.response.ok) throw new Error(`GET /clientes fallo: ${listado.data?.message || listado.response.status}`);
      const listadoActualizado = listado.data.find((cliente) => Number(cliente.id) === Number(negocio.data.cliente.id));
      if (listadoActualizado.tipo_cliente !== "colaborador") throw new Error(`GET /clientes debe devolver tipo_cliente actualizado. Actual=${listadoActualizado.tipo_cliente}`);
      if (listadoActualizado.tipo_cuenta_corriente !== "cortesia") throw new Error(`GET /clientes debe devolver tipo_cuenta_corriente actualizado. Actual=${listadoActualizado.tipo_cuenta_corriente}`);
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testClientesHistorialProductosComprados() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const sufijo = Date.now().toString().slice(-8);

      const cliente = await requestJson(baseUrl, "POST", "/clientes", {
        nombre: "Cliente Historial Productos",
        dni_cuit: `HPC-${sufijo}`,
        tipo_persona: "fisica",
        habilita_cuenta_corriente: true,
        activo: true
      }, token);
      if (!cliente.response.ok) throw new Error(`Crear cliente historial fallo: ${cliente.data?.message || cliente.response.status}`);
      const clienteId = cliente.data.cliente.id;

      const categoriaId = await crearCategoria(baseUrl, token, `TEST Cliente Historial ${sufijo}`);
      const productoBId = await crearProducto(baseUrl, token, {
        nombre: `TEST Producto Cliente ${sufijo}`,
        codigo: `CLI-${sufijo}`,
        categoria: `TEST Cliente Historial ${sufijo}`,
        categoria_id: categoriaId,
        precio_venta: 50,
        stock: 20,
        maneja_stock: true
      });

      const venta1 = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({ cliente_id: clienteId }), token);
      const venta2 = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({ cliente_id: clienteId }), token);
      const ventaProductoB = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test",
        tipo: "normal",
        tipo_cobro: "efectivo",
        cliente_id: clienteId,
        items: [{ producto_id: productoBId, nombre_producto: `TEST Producto Cliente ${sufijo}`, cantidad: 1, precio_unitario: 50 }]
      }, token);
      if (!venta1.response.ok || !venta2.response.ok || !ventaProductoB.response.ok) {
        throw new Error("No se pudieron crear ventas para historial de productos del cliente");
      }

      await runSql(dbPath, "UPDATE ventas SET fecha = ? WHERE id = ?", ["2026-01-01", venta1.data.venta_id]);
      await runSql(dbPath, "UPDATE ventas SET fecha = ? WHERE id = ?", ["2026-01-03", venta2.data.venta_id]);
      await runSql(dbPath, "UPDATE ventas SET fecha = ? WHERE id = ?", ["2026-01-05", ventaProductoB.data.venta_id]);

      const ventaAnulada = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test",
        tipo: "normal",
        tipo_cobro: "efectivo",
        cliente_id: clienteId,
        items: [{ producto_id: productoBId, nombre_producto: `TEST Producto Cliente ${sufijo}`, cantidad: 3, precio_unitario: 50 }]
      }, token);
      if (!ventaAnulada.response.ok) throw new Error(`Crear venta a anular fallo: ${ventaAnulada.data?.message || ventaAnulada.response.status}`);
      await runSql(dbPath, "UPDATE ventas SET fecha = ?, estado = 'anulado' WHERE id = ?", ["2026-01-06", ventaAnulada.data.venta_id]);

      const ventaTecnica = await runSql(
        dbPath,
        `INSERT INTO ventas
         (fecha, hora, usuario, total, tipo, estado, identificador_pendiente, metodo_pago, tipo_cobro, monto_efectivo, monto_debito, cliente_id, es_cuenta_corriente, saldo_pendiente, caja_id, cuenta_cobro_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["2026-01-07", "12:00", "test", 999, "test_modificadores", "anulado", null, "efectivo", "efectivo", 999, 0, clienteId, 0, 0, null, null]
      );
      await runSql(
        dbPath,
        `INSERT INTO detalle_ventas (venta_id, producto_id, nombre_producto, cantidad, precio_unitario, subtotal)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [ventaTecnica.lastID, 11, "Coca Cola 1250", 9, 111, 999]
      );

      const historial = await requestJson(baseUrl, "GET", `/clientes/${clienteId}/productos?limite=50`, null, token);
      if (!historial.response.ok) throw new Error(`GET productos cliente fallo: ${historial.data?.message || historial.response.status}`);
      assertEqual(historial.data.cliente_id, clienteId, "El historial debe devolver cliente_id");
      assertEqual(historial.data.productos.length, 2, "El historial debe agrupar solo productos reales no anulados ni test");

      const [primero, segundo] = historial.data.productos;
      assertEqual(primero.producto_id, productoBId, "El historial debe ordenar por ultima_compra DESC");
      if (primero.nombre_producto !== `TEST Producto Cliente ${sufijo}`) throw new Error("El historial debe incluir el nombre del producto distinto comprado");
      assertApprox(primero.cantidad_total, 1, "Producto distinto debe sumar cantidad real");
      assertApprox(primero.total_comprado, 50, "Producto distinto debe sumar total real");
      assertEqual(primero.veces_comprado, 1, "Producto distinto debe contar una venta");
      if (primero.ultima_compra !== "2026-01-05") throw new Error(`Ultima compra producto distinto incorrecta: ${primero.ultima_compra}`);

      assertEqual(segundo.producto_id, 11, "El historial debe incluir Coca como segundo producto");
      assertApprox(segundo.cantidad_total, 4, "Varias compras del mismo producto deben sumar cantidades");
      assertApprox(segundo.total_comprado, 400, "Varias compras del mismo producto deben sumar subtotales");
      assertEqual(segundo.veces_comprado, 2, "Varias compras del mismo producto deben contar ventas distintas");
      if (segundo.ultima_compra !== "2026-01-03") throw new Error(`Ultima compra Coca incorrecta: ${segundo.ultima_compra}`);

      const limitado = await requestJson(baseUrl, "GET", `/clientes/${clienteId}/productos?limite=1`, null, token);
      if (!limitado.response.ok) throw new Error(`GET productos cliente limitado fallo: ${limitado.data?.message || limitado.response.status}`);
      assertEqual(limitado.data.productos.length, 1, "El limite debe restringir la cantidad de productos");
      assertEqual(limitado.data.productos[0].producto_id, productoBId, "El limite debe conservar el orden por ultima_compra");

      const inexistente = await requestJson(baseUrl, "GET", "/clientes/999999/productos", null, token);
      assertEqual(inexistente.response.status, 404, "Cliente inexistente debe devolver 404");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testClientesDeudaActualizadaComparacionSegura() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const sufijo = Date.now().toString().slice(-8);

      const cliente = await requestJson(baseUrl, "POST", "/clientes", {
        nombre: "Cliente Deuda Actualizada",
        dni_cuit: `CDA-${sufijo}`,
        tipo_persona: "fisica",
        habilita_cuenta_corriente: true,
        activo: true
      }, token);
      if (!cliente.response.ok) throw new Error(`Crear cliente deuda actualizada fallo: ${cliente.data?.message || cliente.response.status}`);
      const clienteId = cliente.data.cliente.id;

      const categoriaId = await crearCategoria(baseUrl, token, `TEST Deuda Actualizada ${sufijo}`);
      const productoInactivoId = await crearProducto(baseUrl, token, {
        nombre: `TEST Producto Inactivo Deuda ${sufijo}`,
        codigo: `PIDA-${sufijo}`,
        categoria: `TEST Deuda Actualizada ${sufijo}`,
        categoria_id: categoriaId,
        precio_venta: 200,
        stock: 10,
        maneja_stock: true,
        activo: false
      });
      await runSql(dbPath, "UPDATE productos SET precio_venta = 150, activo = 1 WHERE id = 11");
      await runSql(dbPath, "UPDATE productos SET precio_venta = 200, activo = 0 WHERE id = ?", [productoInactivoId]);

      const insertarVentaCuenta = async ({ fecha, estado = "cuenta_corriente_pendiente", total, saldo, productoId, nombre, cantidad, precio, subtotal }) => {
        const venta = await runSql(
          dbPath,
          `INSERT INTO ventas
           (fecha, hora, usuario, total, tipo, estado, identificador_pendiente, metodo_pago, tipo_cobro, monto_efectivo, monto_debito, cliente_id, es_cuenta_corriente, saldo_pendiente, caja_id, cuenta_cobro_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [fecha, "12:00", "test", total, "normal", estado, null, null, null, 0, 0, clienteId, 1, saldo, null, null]
        );
        await runSql(
          dbPath,
          `INSERT INTO detalle_ventas (venta_id, producto_id, nombre_producto, cantidad, precio_unitario, subtotal)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [venta.lastID, productoId, nombre, cantidad, precio, subtotal]
        );
        return venta.lastID;
      };

      await insertarVentaCuenta({
        fecha: "2026-02-01",
        total: 200,
        saldo: 200,
        productoId: 11,
        nombre: "Coca Cola 1250",
        cantidad: 2,
        precio: 100,
        subtotal: 200
      });
      await insertarVentaCuenta({
        fecha: "2026-02-02",
        total: 80,
        saldo: 80,
        productoId: productoInactivoId,
        nombre: `TEST Producto Inactivo Deuda ${sufijo}`,
        cantidad: 1,
        precio: 80,
        subtotal: 80
      });
      await insertarVentaCuenta({
        fecha: "2026-02-03",
        estado: "anulado",
        total: 100,
        saldo: 100,
        productoId: 11,
        nombre: "Coca Cola 1250",
        cantidad: 1,
        precio: 100,
        subtotal: 100
      });
      await insertarVentaCuenta({
        fecha: "2026-02-04",
        estado: "cobrada",
        total: 100,
        saldo: 0,
        productoId: 11,
        nombre: "Coca Cola 1250",
        cantidad: 1,
        precio: 100,
        subtotal: 100
      });

      const comparacion = await requestJson(baseUrl, "GET", `/clientes/${clienteId}/deuda-actualizada`, null, token);
      if (!comparacion.response.ok) throw new Error(`GET deuda actualizada fallo: ${comparacion.data?.message || comparacion.response.status}`);
      assertEqual(comparacion.data.cliente_id, clienteId, "La comparacion debe devolver cliente_id");
      assertApprox(comparacion.data.deuda_historica, 280, "La deuda historica debe sumar solo saldos pendientes no anulados");
      assertApprox(comparacion.data.deuda_actualizada, 380, "La deuda actualizada debe usar precio actual solo de productos activos");
      assertApprox(comparacion.data.diferencia, 100, "La diferencia debe ser actualizada menos historica");
      assertEqual(comparacion.data.productos_afectados.length, 1, "Solo el producto activo con precio cambiado debe figurar como afectado");
      assertEqual(comparacion.data.productos_afectados[0].producto_id, 11, "El producto afectado debe ser el activo actualizado");

      const inexistente = await requestJson(baseUrl, "GET", "/clientes/999999/deuda-actualizada", null, token);
      assertEqual(inexistente.response.status, 404, "Cliente inexistente debe devolver 404 en deuda actualizada");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testClientesAplicarRecalculoDeudaControlado() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const sufijo = Date.now().toString().slice(-8);

      const crearClienteRecalculo = async (nombre) => {
        const cliente = await requestJson(baseUrl, "POST", "/clientes", {
          nombre,
          dni_cuit: `${nombre.replace(/\s+/g, "-")}-${sufijo}-${Math.random().toString(16).slice(2, 6)}`,
          tipo_persona: "fisica",
          habilita_cuenta_corriente: true,
          activo: true
        }, token);
        if (!cliente.response.ok) throw new Error(`Crear cliente recalculo fallo: ${cliente.data?.message || cliente.response.status}`);
        return cliente.data.cliente.id;
      };

      const categoriaId = await crearCategoria(baseUrl, token, `TEST Recalculo Deuda ${sufijo}`);
      const productoActivoId = await crearProducto(baseUrl, token, {
        nombre: `TEST Producto Activo Recalculo ${sufijo}`,
        codigo: `PAR-${sufijo}`,
        categoria: `TEST Recalculo Deuda ${sufijo}`,
        categoria_id: categoriaId,
        precio_venta: 100,
        stock: 10,
        maneja_stock: false,
        activo: true
      });
      const productoInactivoId = await crearProducto(baseUrl, token, {
        nombre: `TEST Producto Inactivo Recalculo ${sufijo}`,
        codigo: `PIR-${sufijo}`,
        categoria: `TEST Recalculo Deuda ${sufijo}`,
        categoria_id: categoriaId,
        precio_venta: 80,
        stock: 10,
        maneja_stock: false,
        activo: false
      });
      await runSql(dbPath, "UPDATE productos SET precio_venta = 150, activo = 1 WHERE id = ?", [productoActivoId]);
      await runSql(dbPath, "UPDATE productos SET precio_venta = 200, activo = 0 WHERE id = ?", [productoInactivoId]);

      const insertarVentaCuenta = async ({ clienteId, fecha, estado = "cuenta_corriente_pendiente", tipo = "normal", total, saldo, productoId, nombre, cantidad, precio, subtotal }) => {
        const venta = await runSql(
          dbPath,
          `INSERT INTO ventas
           (fecha, hora, usuario, total, tipo, estado, identificador_pendiente, metodo_pago, tipo_cobro, monto_efectivo, monto_debito, cliente_id, es_cuenta_corriente, saldo_pendiente, caja_id, cuenta_cobro_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [fecha, "12:00", "test", total, tipo, estado, null, "cuenta_corriente", "cuenta_corriente", 0, 0, clienteId, 1, saldo, null, null]
        );
        await runSql(
          dbPath,
          `INSERT INTO detalle_ventas (venta_id, producto_id, nombre_producto, cantidad, precio_unitario, subtotal)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [venta.lastID, productoId, nombre, cantidad, precio, subtotal]
        );
        return venta.lastID;
      };

      const clienteId = await crearClienteRecalculo("Cliente Recalculo Aplicar");
      const ventaActivaId = await insertarVentaCuenta({
        clienteId,
        fecha: "2026-03-01",
        total: 200,
        saldo: 200,
        productoId: productoActivoId,
        nombre: `TEST Producto Activo Recalculo ${sufijo}`,
        cantidad: 2,
        precio: 100,
        subtotal: 200
      });
      const ventaInactivaId = await insertarVentaCuenta({
        clienteId,
        fecha: "2026-03-02",
        total: 80,
        saldo: 80,
        productoId: productoInactivoId,
        nombre: `TEST Producto Inactivo Recalculo ${sufijo}`,
        cantidad: 1,
        precio: 80,
        subtotal: 80
      });
      const ventaAnuladaId = await insertarVentaCuenta({
        clienteId,
        fecha: "2026-03-03",
        estado: "anulado",
        total: 100,
        saldo: 100,
        productoId: productoActivoId,
        nombre: `TEST Producto Activo Recalculo ${sufijo}`,
        cantidad: 1,
        precio: 100,
        subtotal: 100
      });
      const ventaPagadaId = await insertarVentaCuenta({
        clienteId,
        fecha: "2026-03-04",
        estado: "cobrada",
        total: 100,
        saldo: 0,
        productoId: productoActivoId,
        nombre: `TEST Producto Activo Recalculo ${sufijo}`,
        cantidad: 1,
        precio: 100,
        subtotal: 100
      });

      const flagOff = await requestJson(baseUrl, "POST", `/clientes/${clienteId}/recalcular-deuda`, {
        clave_autorizacion: "1234",
        motivo: "Test flag off"
      }, token);
      assertEqual(flagOff.response.status, 403, "Debe rechazar recalculo si el flag esta desactivado");

      await runSql(
        dbPath,
        `INSERT INTO configuracion_global (clave, valor, seccion, actualizado_en)
         VALUES ('cuenta_corriente_actualizar_fiado_por_precio_actual', 'true', 'cuentas_corrientes', datetime('now'))
         ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, seccion = excluded.seccion, actualizado_en = excluded.actualizado_en`
      );

      const claveMal = await requestJson(baseUrl, "POST", `/clientes/${clienteId}/recalcular-deuda`, {
        clave_autorizacion: "0000",
        motivo: "Test clave mal"
      }, token);
      assertEqual(claveMal.response.status, 403, "Debe rechazar clave maestra incorrecta");

      const inexistente = await requestJson(baseUrl, "POST", "/clientes/999999/recalcular-deuda", {
        clave_autorizacion: "1234",
        motivo: "Test inexistente"
      }, token);
      assertEqual(inexistente.response.status, 404, "Cliente inexistente debe devolver 404 al recalcular");

      const clienteSinDiferenciaId = await crearClienteRecalculo("Cliente Recalculo Sin Diferencia");
      const ventaSinDiferenciaId = await insertarVentaCuenta({
        clienteId: clienteSinDiferenciaId,
        fecha: "2026-03-05",
        total: 150,
        saldo: 150,
        productoId: productoActivoId,
        nombre: `TEST Producto Activo Recalculo ${sufijo}`,
        cantidad: 1,
        precio: 150,
        subtotal: 150
      });
      const sinDiferencia = await requestJson(baseUrl, "POST", `/clientes/${clienteSinDiferenciaId}/recalcular-deuda`, {
        clave_autorizacion: "1234",
        motivo: "Sin diferencia"
      }, token);
      if (!sinDiferencia.response.ok) throw new Error(`Recalculo sin diferencia fallo: ${sinDiferencia.data?.message || sinDiferencia.response.status}`);
      assertEqual(sinDiferencia.data.aplicado, false, "Si diferencia = 0 no debe aplicar cambios");
      const ventaSinDifRow = (await allSql(dbPath, "SELECT saldo_pendiente FROM ventas WHERE id = ?", [ventaSinDiferenciaId]))[0];
      assertApprox(ventaSinDifRow.saldo_pendiente, 150, "Si diferencia = 0 no modifica saldo");

      const detalleAntes = (await allSql(dbPath, "SELECT precio_unitario, subtotal FROM detalle_ventas WHERE venta_id = ?", [ventaActivaId]))[0];
      const aplicado = await requestJson(baseUrl, "POST", `/clientes/${clienteId}/recalcular-deuda`, {
        clave_autorizacion: "1234",
        motivo: "Actualizacion por precio vigente"
      }, token);
      if (!aplicado.response.ok) throw new Error(`Aplicar recalculo fallo: ${aplicado.data?.message || aplicado.response.status}`);
      assertEqual(aplicado.data.aplicado, true, "Debe aplicar recalculo con flag y clave correcta");
      assertApprox(aplicado.data.deuda_historica, 280, "Auditoria debe guardar deuda historica");
      assertApprox(aplicado.data.deuda_actualizada, 380, "Auditoria debe guardar deuda actualizada");
      assertApprox(aplicado.data.diferencia, 100, "Auditoria debe guardar diferencia");

      const ventas = await allSql(dbPath, "SELECT id, saldo_pendiente FROM ventas WHERE id IN (?, ?, ?, ?) ORDER BY id", [ventaActivaId, ventaInactivaId, ventaAnuladaId, ventaPagadaId]);
      const porId = Object.fromEntries(ventas.map((venta) => [Number(venta.id), Number(venta.saldo_pendiente)]));
      assertApprox(porId[ventaActivaId], 300, "Producto activo con precio actualizado debe recalcular saldo");
      assertApprox(porId[ventaInactivaId], 80, "Producto inactivo conserva precio historico");
      assertApprox(porId[ventaAnuladaId], 100, "Venta anulada no se modifica");
      assertApprox(porId[ventaPagadaId], 0, "Venta pagada completamente no se modifica");

      const auditorias = await allSql(dbPath, "SELECT * FROM recalculos_cuenta_corriente WHERE cliente_id = ?", [clienteId]);
      assertEqual(auditorias.length, 1, "Debe registrar auditoria del recalculo");
      const detalleAuditoria = JSON.parse(auditorias[0].detalle_json);
      assertEqual(Array.isArray(detalleAuditoria.ventas), true, "Auditoria debe guardar detalle de ventas");

      const detalleDespues = (await allSql(dbPath, "SELECT precio_unitario, subtotal FROM detalle_ventas WHERE venta_id = ?", [ventaActivaId]))[0];
      assertApprox(detalleDespues.precio_unitario, detalleAntes.precio_unitario, "No debe modificar precio_unitario historico");
      assertApprox(detalleDespues.subtotal, detalleAntes.subtotal, "No debe modificar subtotal historico");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testVentaContadoImpactaStockYCaja() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const apertura = await abrirCaja(baseUrl, token, 1000);

      const venta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      if (!venta.response.ok) throw new Error(`Venta contado fallo: ${venta.data?.message || venta.response.status}`);
      assertEqual(venta.data.total, 200, "La venta contado debe totalizar 200");
      assertEqual((await getProduct(baseUrl, token, 11)).stock, 78, "La venta contado debe descontar stock");

      const movimientos = await getMovimientosStock(baseUrl, token, 11);
      const movimientoVenta = movimientos.find((mov) => mov.tipo_movimiento === "venta" && Number(mov.cantidad) === 2);
      if (!movimientoVenta) throw new Error("La venta simple debe registrar un movimiento_stock tipo venta por cantidad 2");
      assertEqual(movimientoVenta.stock_anterior, 80, "El movimiento de venta debe partir del stock inicial");
      assertEqual(movimientoVenta.stock_nuevo, 78, "El movimiento de venta debe registrar stock nuevo correcto");

      const detalle = await getVentaDetalle(baseUrl, token, venta.data.venta_id);
      assertEqual(detalle.venta.caja_id, apertura.id, "La venta contado debe quedar asociada a la caja abierta");
      assertEqual(detalle.items.length, 1, "La venta simple sin modificadores debe guardar una sola linea en detalle_ventas");
      assertEqual(detalle.items[0].producto_id, 11, "La venta simple debe conservar producto_id en detalle_ventas");
      assertApprox(detalle.items[0].subtotal, 200, "La venta simple debe conservar subtotal historico en detalle_ventas");

      const resumen = await getCajaResumen(baseUrl, token);
      assertEqual(resumen.resumen.total_efectivo, 200, "La caja debe sumar efectivo de venta contado");
      assertEqual(resumen.resumen.total_ventas, 200, "La caja debe sumar total de ventas");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testPendienteNoImpactaCajaHastaCobro() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      const pendiente = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo: "pendiente",
        identificador_pendiente: "Mesa Test",
        tipo_cobro: undefined
      }), token);
      if (!pendiente.response.ok) throw new Error(`Ticket pendiente fallo: ${pendiente.data?.message || pendiente.response.status}`);
      assertEqual((await getProduct(baseUrl, token, 11)).stock, 78, "El pendiente debe reservar/descontar stock");

      const resumenAntes = await getCajaResumen(baseUrl, token);
      assertEqual(resumenAntes.resumen.total_ventas, 0, "El pendiente sin cobrar no debe impactar ventas de caja");
      assertEqual(resumenAntes.resumen.total_efectivo, 0, "El pendiente sin cobrar no debe impactar efectivo");

      const cobro = await requestJson(baseUrl, "POST", `/ventas/${pendiente.data.venta_id}/cobrar`, {
        tipo_cobro: "efectivo"
      }, token);
      if (!cobro.response.ok) throw new Error(`Cobro pendiente fallo: ${cobro.data?.message || cobro.response.status}`);
      assertEqual((await getProduct(baseUrl, token, 11)).stock, 78, "Cobrar pendiente no debe volver a descontar stock");

      const resumenDespues = await getCajaResumen(baseUrl, token);
      assertEqual(resumenDespues.resumen.total_ventas, 200, "El pendiente cobrado debe impactar ventas de caja");
      assertEqual(resumenDespues.resumen.total_efectivo, 200, "El pendiente cobrado debe impactar efectivo");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testAnularPendienteReponeStock() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      const pendiente = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo: "pendiente",
        identificador_pendiente: "Mesa Anular",
        tipo_cobro: undefined
      }), token);
      if (!pendiente.response.ok) throw new Error(`Ticket pendiente para anular fallo: ${pendiente.data?.message || pendiente.response.status}`);
      assertEqual((await getProduct(baseUrl, token, 11)).stock, 78, "El pendiente a anular debe descontar stock al guardarse");

      const anulacion = await requestJson(baseUrl, "POST", `/ventas/${pendiente.data.venta_id}/anular`, {
        authorization_code: "1234"
      }, token);
      if (!anulacion.response.ok) throw new Error(`Anulacion pendiente fallo: ${anulacion.data?.message || anulacion.response.status}`);
      assertEqual((await getProduct(baseUrl, token, 11)).stock, 80, "Anular pendiente debe reponer stock");

      const ventas = await getVentas(baseUrl, token);
      const ventaAnulada = ventas.find((item) => Number(item.id) === Number(pendiente.data.venta_id));
      if (ventaAnulada?.estado !== "anulado") {
        throw new Error(`El pendiente anulado debe quedar en estado anulado. Estado=${ventaAnulada?.estado}`);
      }
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testAnularVentaCobradaReponeStock() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      const venta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      if (!venta.response.ok) throw new Error(`Venta para anular fallo: ${venta.data?.message || venta.response.status}`);
      assertEqual((await getProduct(baseUrl, token, 11)).stock, 78, "La venta debe descontar stock antes de anular");

      const anulacion = await requestJson(baseUrl, "POST", `/ventas/${venta.data.venta_id}/anular-cobrada`, {
        authorization_code: "1234"
      }, token);
      if (!anulacion.response.ok) throw new Error(`Anulacion cobrada fallo: ${anulacion.data?.message || anulacion.response.status}`);
      assertEqual((await getProduct(baseUrl, token, 11)).stock, 80, "La anulacion cobrada debe reponer stock");

      const ventas = await getVentas(baseUrl, token);
      const ventaAnulada = ventas.find((item) => Number(item.id) === Number(venta.data.venta_id));
      if (ventaAnulada?.estado !== "anulado") {
        throw new Error(`La venta anulada debe quedar en estado anulado. Estado=${ventaAnulada?.estado}`);
      }
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testProductoCompuestoGeneraAjusteTeorico() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, [
      ...resetOperationalDataStatements(),
      ["UPDATE productos SET stock = 80, maneja_stock = 1, usa_costos_varios = 0, tipo = 'simple', es_combo = 0 WHERE id = 11"],
      ["INSERT INTO categorias (nombre, margen_porcentaje, activo, maneja_stock, usa_costos_varios) VALUES ('TEST Compuestos', 0, 1, 1, 0)"]
    ]);

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      const categoriaIdResult = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath);
        db.get("SELECT id FROM categorias WHERE nombre = 'TEST Compuestos' ORDER BY id DESC LIMIT 1", [], (error, row) => {
          db.close();
          if (error) reject(error);
          else resolve(row?.id);
        });
      });

      const compuesto = await requestJson(baseUrl, "POST", "/productos_compuestos", {
        nombre: "TEST Combo Coca x3",
        categoria: "TEST Compuestos",
        categoria_id: categoriaIdResult,
        precio_venta: 400,
        componentes: [{ producto_id: 11, cantidad: 3 }],
        costos_extra: [],
        usuario: "test"
      }, token);
      if (!compuesto.response.ok) throw new Error(`Crear compuesto fallo: ${compuesto.data?.message || compuesto.response.status}`);

      const productoCompuestoAntes = await getProduct(baseUrl, token, compuesto.data.id);
      assertEqual(productoCompuestoAntes.stock_fisico, 0, "El compuesto creado no debe tener stock fisico propio");

      const venta = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test",
        tipo: "normal",
        tipo_cobro: "efectivo",
        items: [{
          producto_id: compuesto.data.id,
          nombre_producto: "TEST Combo Coca x3",
          cantidad: 2,
          precio_unitario: 400
        }]
      }, token);
      if (!venta.response.ok) throw new Error(`Venta de compuesto fallo: ${venta.data?.message || venta.response.status}`);

      assertEqual((await getProduct(baseUrl, token, 11)).stock, 80, "Vender compuesto sin stock no debe descontar componente fisico");
      const ajustes = await getAjustesPendientesStock(baseUrl, token, "pendiente");
      const ajuste = ajustes.find((item) => Number(item.venta_id) === Number(venta.data.venta_id) && item.origen === "venta_receta");
      if (!ajuste) throw new Error("Vender compuesto sin stock debe generar ajuste teorico pendiente");
      assertEqual(ajuste.producto_id, 11, "Ajuste teorico debe apuntar al componente fisico");
      assertApprox(ajuste.cantidad_teorica, 6, "Ajuste teorico debe guardar consumo de 6 unidades");
      const productoCompuestoDespues = await getProduct(baseUrl, token, compuesto.data.id);
      assertEqual(productoCompuestoDespues.stock_fisico, 0, "Vender compuesto no debe romper stock propio del compuesto");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testProveedorGuardaImpactoContable() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const proveedor = await crearProveedor(baseUrl, token, {
        tipo_impacto: "costo_fijo_operativo"
      });

      assertEqual(proveedor.activo, 1, "El proveedor debe quedar activo");
      if (proveedor.tipo_impacto !== "costo_fijo_operativo") {
        throw new Error(`El proveedor debe guardar tipo_impacto costo_fijo_operativo. Actual=${proveedor.tipo_impacto}`);
      }
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testPagoRegistradoImpactaCaja() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const apertura = await abrirCaja(baseUrl, token, 1000);
      const proveedor = await crearProveedor(baseUrl, token, {
        tipo_impacto: "costo_variable_mercaderia"
      });

      const pago = await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST pago registrado caja",
        monto_total: 300,
        tipo_pago: "efectivo",
        estado: "registrado"
      });

      assertEqual(pago.caja_id, apertura.id, "El pago registrado debe quedar asociado a la caja abierta");
      assertEqual(pago.monto_efectivo, 300, "El pago efectivo debe guardar monto_efectivo");
      assertEqual(pago.monto_debito, 0, "El pago efectivo no debe guardar monto_debito");

      const resumen = await getCajaResumen(baseUrl, token);
      assertEqual(resumen.resumen.total_pagos_efectivo, 300, "La caja debe registrar egreso efectivo por pago");
      assertEqual(resumen.resumen.total_pagos_general, 300, "La caja debe sumar total de pagos registrados");
      assertEqual(resumen.resumen.total_general, -300, "La caja debe reflejar el egreso en total_general");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testPagoPendienteNoImpactaCaja() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const proveedor = await crearProveedor(baseUrl, token);

      const pago = await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST pago pendiente",
        monto_total: 450,
        tipo_pago: "efectivo",
        estado: "pendiente"
      });

      if (pago.estado !== "pendiente") {
        throw new Error(`El pago pendiente debe quedar pendiente. Estado=${pago.estado}`);
      }
      assertEqual(pago.caja_id || 0, 0, "El pago pendiente no debe asociarse a caja");
      assertEqual(pago.monto_efectivo, 0, "El pago pendiente no debe guardar egreso efectivo");
      assertEqual(pago.monto_debito, 0, "El pago pendiente no debe guardar egreso debito");

      const resumen = await getCajaResumen(baseUrl, token);
      assertEqual(resumen.resumen.total_pagos_general, 0, "El pago pendiente no debe impactar pagos de caja");
      assertEqual(resumen.resumen.total_general, 0, "El pago pendiente no debe alterar total_general de caja");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testPagoMixtoGuardaMontosYCaja() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const proveedor = await crearProveedor(baseUrl, token);
      const cuentaDebito = await crearCuentaCobro(baseUrl, token, {
        nombre: "TEST cuenta debito pago mixto",
        tipo_pago_codigo: "debito"
      });

      const pago = await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST pago mixto",
        monto_total: 500,
        tipo_pago: "mixto",
        monto_efectivo: 200,
        monto_debito: 300,
        estado: "registrado",
        cuenta_cobro_id: cuentaDebito.id
      });

      assertEqual(pago.monto_total, 500, "El pago mixto debe guardar monto_total");
      assertEqual(pago.monto_efectivo, 200, "El pago mixto debe guardar monto_efectivo");
      assertEqual(pago.monto_debito, 300, "El pago mixto debe guardar monto_debito");

      const resumen = await getCajaResumen(baseUrl, token);
      assertEqual(resumen.resumen.total_pagos_efectivo, 200, "La caja debe sumar parte efectivo del pago mixto");
      assertEqual(resumen.resumen.total_pagos_debito, 300, "La caja debe sumar parte debito del pago mixto");
      assertEqual(resumen.resumen.total_pagos_general, 500, "La caja debe sumar total del pago mixto");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testPagoCalculaIvaCreditoFiscal() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const proveedor = await crearProveedor(baseUrl, token, {
        condicion_iva: "responsable_inscripto",
        tipo_comprobante: "factura_a",
        iva_alicuota: 21
      });
      const cuentaTransferencia = await crearCuentaCobro(baseUrl, token, {
        nombre: "TEST cuenta transferencia IVA",
        tipo_pago_codigo: "transferencia"
      });

      const pago = await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST IVA credito fiscal",
        monto_total: 1210,
        tipo_pago: "transferencia",
        estado: "registrado",
        cuenta_cobro_id: cuentaTransferencia.id
      });

      assertApprox(pago.iva_credito_fiscal, 210, "El pago debe calcular IVA credito fiscal segun logica actual");

      const pagos = await getPagos(baseUrl, token);
      const pagoListado = pagos.find((item) => Number(item.id) === Number(pago.id));
      if (!pagoListado) throw new Error("El pago con IVA debe aparecer en listado de pagos");
      assertApprox(pagoListado.iva_credito_fiscal, 210, "El listado de pagos debe exponer IVA credito fiscal calculado");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testTipoPagoEfectivoPrevioTiposPago() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const proveedor = await crearProveedor(baseUrl, token);

      const pago = await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST tipo_pago efectivo previo",
        monto_total: 120,
        tipo_pago: "efectivo",
        estado: "registrado"
      });

      if (pago.tipo_pago !== "efectivo") {
        throw new Error(`Pago efectivo debe guardar tipo_pago efectivo. Actual=${pago.tipo_pago}`);
      }
      assertEqual(pago.monto_efectivo, 120, "Pago efectivo debe guardar monto_efectivo");
      assertEqual(pago.monto_debito, 0, "Pago efectivo no debe guardar monto_debito");

      const resumen = await getCajaResumen(baseUrl, token);
      assertEqual(resumen.resumen.total_pagos_efectivo, 120, "Pago efectivo debe impactar egreso efectivo en caja");
      assertEqual(resumen.resumen.total_pagos_general, 120, "Pago efectivo debe impactar total pagos en caja");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testTiposPagoEndpointDefaultsCompatibles() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const { response, data } = await requestJson(baseUrl, "GET", "/tipos_pago", null, token);
      if (!response.ok) throw new Error(`GET /tipos_pago fallo: ${data?.message || response.status}`);
      if (!Array.isArray(data)) throw new Error("GET /tipos_pago debe devolver un array");

      const codigos = data.map((tipo) => tipo.codigo);
      ["efectivo", "debito", "transferencia", "mixto"].forEach((codigo) => {
        if (!codigos.includes(codigo)) {
          throw new Error(`GET /tipos_pago debe incluir ${codigo}. Actual=${JSON.stringify(codigos)}`);
        }
      });

      const efectivo = data.find((tipo) => tipo.codigo === "efectivo");
      const mixto = data.find((tipo) => tipo.codigo === "mixto");
      assertEqual(efectivo.impacta_caja, 1, "Tipo efectivo debe impactar caja");
      assertEqual(efectivo.impacta_digital, 0, "Tipo efectivo no debe impactar digital");
      assertEqual(mixto.permite_mixto, 1, "Tipo mixto debe permitir mixto");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testTipoPagoDebitoPrevioTiposPago() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const proveedor = await crearProveedor(baseUrl, token);
      const cuentaDebito = await crearCuentaCobro(baseUrl, token, {
        nombre: "TEST cuenta debito previo",
        tipo_pago_codigo: "debito"
      });

      const pago = await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST tipo_pago debito previo",
        monto_total: 230,
        tipo_pago: "debito",
        estado: "registrado",
        cuenta_cobro_id: cuentaDebito.id
      });

      if (pago.tipo_pago !== "debito") {
        throw new Error(`Pago debito debe guardar tipo_pago debito. Actual=${pago.tipo_pago}`);
      }
      assertEqual(pago.monto_efectivo, 0, "Pago debito no debe guardar monto_efectivo");
      assertEqual(pago.monto_debito, 230, "Pago debito debe guardar monto_debito");

      const resumen = await getCajaResumen(baseUrl, token);
      assertEqual(resumen.resumen.total_pagos_debito, 230, "Pago debito debe impactar egreso digital en caja");
      assertEqual(resumen.resumen.total_pagos_general, 230, "Pago debito debe impactar total pagos en caja");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testTipoPagoTransferenciaPrevioTiposPago() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const proveedor = await crearProveedor(baseUrl, token);
      const cuentaTransferencia = await crearCuentaCobro(baseUrl, token, {
        nombre: "TEST cuenta transferencia previo",
        tipo_pago_codigo: "transferencia"
      });

      const pago = await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST tipo_pago transferencia previo",
        monto_total: 340,
        tipo_pago: "transferencia",
        estado: "registrado",
        cuenta_cobro_id: cuentaTransferencia.id
      });

      if (pago.tipo_pago !== "transferencia") {
        throw new Error(`Pago transferencia debe guardar tipo_pago transferencia. Actual=${pago.tipo_pago}`);
      }
      assertEqual(pago.monto_efectivo, 0, "Pago transferencia no debe guardar monto_efectivo");
      assertEqual(pago.monto_debito, 340, "Pago transferencia debe guardar monto_debito como campo digital actual");

      const resumen = await getCajaResumen(baseUrl, token);
      assertEqual(resumen.resumen.total_pagos_debito, 340, "Pago transferencia debe impactar egreso digital en caja");
      assertEqual(resumen.resumen.total_pagos_general, 340, "Pago transferencia no debe romper total pagos en caja");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testTipoPagoMixtoPrevioTiposPago() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const proveedor = await crearProveedor(baseUrl, token);
      const cuentaDebito = await crearCuentaCobro(baseUrl, token, {
        nombre: "TEST cuenta debito mixto previo",
        tipo_pago_codigo: "debito"
      });

      const pago = await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST tipo_pago mixto previo",
        monto_total: 450,
        tipo_pago: "mixto",
        monto_efectivo: 150,
        monto_debito: 300,
        estado: "registrado",
        cuenta_cobro_id: cuentaDebito.id
      });

      if (pago.tipo_pago !== "mixto") {
        throw new Error(`Pago mixto debe guardar tipo_pago mixto. Actual=${pago.tipo_pago}`);
      }
      assertEqual(pago.monto_efectivo + pago.monto_debito, pago.monto_total, "Pago mixto debe guardar suma igual al total");
      assertEqual(pago.monto_efectivo, 150, "Pago mixto debe guardar monto_efectivo");
      assertEqual(pago.monto_debito, 300, "Pago mixto debe guardar monto_debito");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testTipoPagoPendientePrevioTiposPago() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const proveedor = await crearProveedor(baseUrl, token);

      const pago = await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST tipo_pago pendiente previo",
        monto_total: 560,
        tipo_pago: "efectivo",
        estado: "pendiente"
      });

      assertEqual(pago.caja_id || 0, 0, "Pago pendiente previo tipos_pago no debe tener caja_id");
      assertEqual(pago.monto_efectivo, 0, "Pago pendiente previo tipos_pago no debe guardar monto_efectivo");
      assertEqual(pago.monto_debito, 0, "Pago pendiente previo tipos_pago no debe guardar monto_debito");

      const resumen = await getCajaResumen(baseUrl, token);
      assertEqual(resumen.resumen.total_pagos_general, 0, "Pago pendiente previo tipos_pago no debe impactar caja");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testCierreConservaTipoPagoStringEnPagosSnapshot() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const proveedor = await crearProveedor(baseUrl, token);
      const cuentaDebito = await crearCuentaCobro(baseUrl, token, {
        nombre: "TEST cuenta snapshot debito",
        tipo_pago_codigo: "debito"
      });
      const cuentaTransferencia = await crearCuentaCobro(baseUrl, token, {
        nombre: "TEST cuenta snapshot transferencia",
        tipo_pago_codigo: "transferencia"
      });

      await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST snapshot efectivo",
        monto_total: 100,
        tipo_pago: "efectivo",
        estado: "registrado"
      });
      await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST snapshot debito",
        monto_total: 200,
        tipo_pago: "debito",
        estado: "registrado",
        cuenta_cobro_id: cuentaDebito.id
      });
      await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST snapshot transferencia",
        monto_total: 300,
        tipo_pago: "transferencia",
        estado: "registrado",
        cuenta_cobro_id: cuentaTransferencia.id
      });

      const cierre = await cerrarCaja(baseUrl, token, 900, 900, 0);
      const detalle = await getCierreDetalle(baseUrl, token, cierre.id);
      const tiposSnapshot = detalle.pagos_snapshot.map((pago) => pago.tipo_cobro).sort();

      if (tiposSnapshot.join(",") !== "debito,efectivo,transferencia") {
        throw new Error(`pagos_snapshot debe conservar metodo de pago como tipo_cobro string. Actual=${JSON.stringify(detalle.pagos_snapshot)}`);
      }
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testPagoHeredaCategoriaPagoDesdeImpactoProveedor() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const proveedor = await crearProveedor(baseUrl, token, {
        tipo_impacto: "inversion"
      });

      const pago = await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        categoria_pago: "costo_fijo_operativo",
        concepto: "TEST hereda impacto proveedor",
        monto_total: 670,
        tipo_pago: "efectivo",
        estado: "registrado"
      });

      if (pago.categoria_pago !== "inversion") {
        throw new Error(`Pago debe heredar categoria_pago desde proveedor.tipo_impacto. Esperado=inversion, actual=${pago.categoria_pago}`);
      }
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testCierreGuardaSnapshotsParseables() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      const venta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      if (!venta.response.ok) throw new Error(`Venta para cierre fallo: ${venta.data?.message || venta.response.status}`);

      const cierre = await cerrarCaja(baseUrl, token, 1200, 1000, 200);
      const detalle = await getCierreDetalle(baseUrl, token, cierre.id);

      if (detalle.estado !== "cerrada") {
        throw new Error(`El cierre debe quedar en estado cerrada. Estado=${detalle.estado}`);
      }
      if (!detalle.resumen_snapshot || typeof detalle.resumen_snapshot !== "object") {
        throw new Error("El cierre debe guardar resumen_snapshot parseable");
      }
      if (!Array.isArray(detalle.ventas_snapshot)) {
        throw new Error("El cierre debe guardar ventas_snapshot parseable como array");
      }
      if (!Array.isArray(detalle.pagos_snapshot)) {
        throw new Error("El cierre debe guardar pagos_snapshot parseable como array");
      }

      assertEqual(detalle.resumen_snapshot.total_ventas, 200, "El snapshot de cierre debe conservar total de ventas");
      assertEqual(detalle.ventas_snapshot.length, 1, "El snapshot de cierre debe conservar la venta registrada");
      assertEqual(detalle.pagos_snapshot.length, 0, "El snapshot de cierre debe conservar pagos vacios si no hubo pagos");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testCierreInmutableAnteVentaPosterior() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      const ventaInicial = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      if (!ventaInicial.response.ok) throw new Error(`Venta inicial para cierre fallo: ${ventaInicial.data?.message || ventaInicial.response.status}`);

      const cierre = await cerrarCaja(baseUrl, token, 1200, 1000, 200);
      const detalleAntes = await getCierreDetalle(baseUrl, token, cierre.id);
      const resumenAntes = JSON.stringify(detalleAntes.resumen_snapshot);
      const ventasAntes = JSON.stringify(detalleAntes.ventas_snapshot);
      const pagosAntes = JSON.stringify(detalleAntes.pagos_snapshot);

      await abrirCaja(baseUrl, token, 500);
      const ventaPosterior = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        usuario: "test posterior"
      }), token);
      if (!ventaPosterior.response.ok) throw new Error(`Venta posterior al cierre fallo: ${ventaPosterior.data?.message || ventaPosterior.response.status}`);

      const detalleDespues = await getCierreDetalle(baseUrl, token, cierre.id);
      if (JSON.stringify(detalleDespues.resumen_snapshot) !== resumenAntes) {
        throw new Error("El resumen_snapshot del cierre anterior cambio luego de una venta posterior");
      }
      if (JSON.stringify(detalleDespues.ventas_snapshot) !== ventasAntes) {
        throw new Error("El ventas_snapshot del cierre anterior cambio luego de una venta posterior");
      }
      if (JSON.stringify(detalleDespues.pagos_snapshot) !== pagosAntes) {
        throw new Error("El pagos_snapshot del cierre anterior cambio luego de una venta posterior");
      }
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testCierreInmutableAntePagoPosterior() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const proveedorInicial = await crearProveedor(baseUrl, token);

      const venta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      if (!venta.response.ok) throw new Error(`Venta para cierre con pago fallo: ${venta.data?.message || venta.response.status}`);

      await registrarPago(baseUrl, token, {
        proveedor_id: proveedorInicial.id,
        concepto: "TEST pago antes de cierre",
        monto_total: 300,
        tipo_pago: "efectivo",
        estado: "registrado"
      });

      const cierre = await cerrarCaja(baseUrl, token, 900, 900, 0);
      const detalleAntes = await getCierreDetalle(baseUrl, token, cierre.id);
      const resumenAntes = JSON.stringify(detalleAntes.resumen_snapshot);
      const ventasAntes = JSON.stringify(detalleAntes.ventas_snapshot);
      const pagosAntes = JSON.stringify(detalleAntes.pagos_snapshot);
      assertEqual(detalleAntes.pagos_snapshot.length, 1, "El cierre inicial debe guardar el pago previo");

      await abrirCaja(baseUrl, token, 1000);
      const proveedorPosterior = await crearProveedor(baseUrl, token);
      await registrarPago(baseUrl, token, {
        proveedor_id: proveedorPosterior.id,
        concepto: "TEST pago posterior al cierre",
        monto_total: 150,
        tipo_pago: "efectivo",
        estado: "registrado"
      });

      const detalleDespues = await getCierreDetalle(baseUrl, token, cierre.id);
      if (JSON.stringify(detalleDespues.resumen_snapshot) !== resumenAntes) {
        throw new Error("El resumen_snapshot del cierre anterior cambio luego de un pago posterior");
      }
      if (JSON.stringify(detalleDespues.ventas_snapshot) !== ventasAntes) {
        throw new Error("El ventas_snapshot del cierre anterior cambio luego de un pago posterior");
      }
      if (JSON.stringify(detalleDespues.pagos_snapshot) !== pagosAntes) {
        throw new Error("El pagos_snapshot del cierre anterior cambio luego de un pago posterior");
      }
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testCajaCerradaNoRecibeOperacionPosterior() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      const ventaInicial = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      if (!ventaInicial.response.ok) throw new Error(`Venta antes de cerrar caja fallo: ${ventaInicial.data?.message || ventaInicial.response.status}`);

      const cajaCerrada = await cerrarCaja(baseUrl, token, 1200, 1000, 200);
      assertEqual(cajaCerrada.estado === "cerrada" ? 1 : 0, 1, "La caja debe quedar cerrada");

      const cajaNueva = await abrirCaja(baseUrl, token, 500);
      const ventaPosterior = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        usuario: "test caja nueva"
      }), token);
      if (!ventaPosterior.response.ok) throw new Error(`Venta posterior con caja nueva fallo: ${ventaPosterior.data?.message || ventaPosterior.response.status}`);

      const detalleVentaPosterior = await getVentaDetalle(baseUrl, token, ventaPosterior.data.venta_id);
      assertEqual(detalleVentaPosterior.venta.caja_id, cajaNueva.id, "La operacion posterior debe asociarse a la caja nueva");
      if (Number(detalleVentaPosterior.venta.caja_id) === Number(cajaCerrada.id)) {
        throw new Error("La operacion posterior no debe asociarse a la caja cerrada");
      }
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testSimpleConRendimientoDescuentaStockFisicoUnaVez() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const categoriaId = await crearCategoria(baseUrl, token, "TEST Rendimiento Simple");
      const productoId = await crearProducto(baseUrl, token, {
        nombre: "TEST Simple con rendimiento",
        categoria: "TEST Rendimiento Simple",
        categoria_id: categoriaId,
        stock: 10,
        rendimiento_receta: 5
      });
      await runSql(dbPath, "UPDATE productos SET rendimiento_receta = 5 WHERE id = ?", [productoId]);

      const productoAntes = await getProduct(baseUrl, token, productoId);
      assertEqual(productoAntes.rendimiento_receta, 5, "El producto simple de prueba debe tener rendimiento_receta cargado");

      const venta = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test",
        tipo: "normal",
        tipo_cobro: "efectivo",
        items: [{
          producto_id: productoId,
          nombre_producto: "TEST Simple con rendimiento",
          cantidad: 2,
          precio_unitario: 100
        }]
      }, token);
      if (!venta.response.ok) throw new Error(`Venta simple con rendimiento fallo: ${venta.data?.message || venta.response.status}`);

      assertEqual((await getProduct(baseUrl, token, productoId)).stock, 8, "Producto simple con rendimiento debe descontar solo stock fisico vendido");
      const movimientos = await getMovimientosStock(baseUrl, token, productoId);
      const movimientoVenta = movimientos.find((mov) => mov.tipo_movimiento === "venta" && Number(mov.stock_anterior) === 10);
      if (!movimientoVenta) throw new Error("La venta simple con rendimiento debe registrar movimiento_stock de venta");
      assertEqual(movimientoVenta.cantidad, 2, "Rendimiento_receta no debe duplicar cantidad descontada en producto simple");
      assertEqual(movimientoVenta.stock_nuevo, 8, "Rendimiento_receta no debe alterar stock_nuevo de producto simple");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testCompuestoConComponenteFraccionadoDescuentaCantidadUsada() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const categoriaId = await crearCategoria(baseUrl, token, "TEST Fraccionados");
      const componenteId = await crearProducto(baseUrl, token, {
        nombre: "TEST Harina fraccionada",
        categoria: "TEST Fraccionados",
        categoria_id: categoriaId,
        stock: 10,
        unidad_medida: "kg",
        precio_compra: 20,
        precio_venta: 50
      });
      const compuestoId = await crearProductoCompuesto(baseUrl, token, {
        nombre: "TEST Compuesto fraccionado",
        categoria: "TEST Fraccionados",
        categoria_id: categoriaId,
        precio_venta: 200,
        componentes: [{ producto_id: componenteId, cantidad: 1.25 }],
        costos_extra: []
      });

      const venta = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test",
        tipo: "normal",
        tipo_cobro: "efectivo",
        items: [{
          producto_id: compuestoId,
          nombre_producto: "TEST Compuesto fraccionado",
          cantidad: 2,
          precio_unitario: 200
        }]
      }, token);
      if (!venta.response.ok) throw new Error(`Venta compuesto fraccionado fallo: ${venta.data?.message || venta.response.status}`);

      assertApprox((await getProduct(baseUrl, token, componenteId)).stock, 10, "Vender compuesto sin stock no debe descontar componente fraccionado");
      const ajustes = await getAjustesPendientesStock(baseUrl, token, "pendiente");
      const ajuste = ajustes.find((item) => Number(item.venta_id) === Number(venta.data.venta_id) && item.origen === "venta_receta");
      if (!ajuste) throw new Error("Vender compuesto fraccionado debe generar ajuste teorico pendiente");
      assertApprox(ajuste.cantidad_teorica, 2.5, "Ajuste teorico debe conservar cantidad fraccionada usada");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testCompuestoConStockPropioNoDuplicaDescuento() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const categoriaId = await crearCategoria(baseUrl, token, "TEST Compuesto Stock Propio");
      const componenteId = await crearProducto(baseUrl, token, {
        nombre: "TEST Ingrediente stock propio",
        categoria: "TEST Compuesto Stock Propio",
        categoria_id: categoriaId,
        stock: 20
      });
      const compuestoId = await crearProducto(baseUrl, token, {
        nombre: "TEST Compuesto con stock propio",
        categoria: "TEST Compuesto Stock Propio",
        categoria_id: categoriaId,
        tipo: "compuesto",
        maneja_stock: true,
        stock: 5,
        precio_venta: 300,
        componentes: [{ producto_id: componenteId, cantidad: 2 }],
        costos_extra: []
      });

      const compuestoCreado = await getProduct(baseUrl, token, compuestoId);
      assertEqual(compuestoCreado.stock, 5, "Crear compuesto con stock propio debe conservar stock");
      assertEqual(compuestoCreado.stock_fisico, 5, "GET /productos debe exponer stock_fisico de compuesto con stock propio");
      assertEqual(compuestoCreado.stock_vendible_calculado, 5, "GET /productos debe usar stock propio como vendible");

      const editar = await requestJson(baseUrl, "PUT", `/productos/${compuestoId}`, {
        nombre: "TEST Compuesto con stock propio",
        categoria: "TEST Compuesto Stock Propio",
        categoria_id: categoriaId,
        tipo: "compuesto",
        maneja_stock: true,
        stock: 5,
        precio_compra: 10,
        precio_venta: 300,
        activo: true,
        componentes: [{ producto_id: componenteId, cantidad: 2 }],
        costos_extra: []
      }, token);
      if (!editar.response.ok) throw new Error(`Editar compuesto con stock propio fallo: ${editar.data?.message || editar.response.status}`);
      const compuestoEditado = await getProduct(baseUrl, token, compuestoId);
      assertEqual(compuestoEditado.stock, 5, "Editar compuesto con stock propio debe conservar stock");
      assertEqual(compuestoEditado.stock_fisico, 5, "Editar compuesto con stock propio debe conservar stock_fisico");

      const recetaConSemielaboradoId = await crearProducto(baseUrl, token, {
        nombre: "TEST Receta usa semielaborado",
        categoria: "TEST Compuesto Stock Propio",
        categoria_id: categoriaId,
        tipo: "compuesto",
        maneja_stock: false,
        stock: 0,
        precio_venta: 200,
        componentes: [{ producto_id: compuestoId, cantidad: 2 }],
        costos_extra: []
      });
      const recetaConSemielaborado = await getProduct(baseUrl, token, recetaConSemielaboradoId);
      assertEqual(recetaConSemielaborado.stock_disponible, 2, "Receta debe calcular disponibilidad usando stock propio del semielaborado");

      const venta = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test",
        tipo: "normal",
        tipo_cobro: "efectivo",
        items: [{
          producto_id: compuestoId,
          nombre_producto: "TEST Compuesto con stock propio",
          cantidad: 1,
          precio_unitario: 300
        }]
      }, token);
      if (!venta.response.ok) throw new Error(`Venta compuesto con stock propio fallo: ${venta.data?.message || venta.response.status}`);

      assertEqual((await getProduct(baseUrl, token, compuestoId)).stock, 4, "Compuesto con stock propio debe descontar su stock fisico");
      assertEqual((await getProduct(baseUrl, token, componenteId)).stock, 20, "Vender compuesto con stock propio no debe duplicar descuento en componentes");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testAnularVentaCompuestaCancelaAjusteTeorico() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const categoriaId = await crearCategoria(baseUrl, token, "TEST Anular Compuesto");
      const componenteId = await crearProducto(baseUrl, token, {
        nombre: "TEST Ingrediente anular compuesto",
        categoria: "TEST Anular Compuesto",
        categoria_id: categoriaId,
        stock: 20
      });
      const compuestoId = await crearProductoCompuesto(baseUrl, token, {
        nombre: "TEST Compuesto anular",
        categoria: "TEST Anular Compuesto",
        categoria_id: categoriaId,
        precio_venta: 250,
        componentes: [{ producto_id: componenteId, cantidad: 4 }],
        costos_extra: []
      });

      const venta = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test",
        tipo: "normal",
        tipo_cobro: "efectivo",
        items: [{
          producto_id: compuestoId,
          nombre_producto: "TEST Compuesto anular",
          cantidad: 2,
          precio_unitario: 250
        }]
      }, token);
      if (!venta.response.ok) throw new Error(`Venta compuesto para anular fallo: ${venta.data?.message || venta.response.status}`);
      assertEqual((await getProduct(baseUrl, token, componenteId)).stock, 20, "Venta compuesta sin stock no debe descontar componente antes de aprobar ajuste");

      const anulacion = await requestJson(baseUrl, "POST", `/ventas/${venta.data.venta_id}/anular-cobrada`, {
        authorization_code: "1234"
      }, token);
      if (!anulacion.response.ok) throw new Error(`Anulacion venta compuesta fallo: ${anulacion.data?.message || anulacion.response.status}`);
      assertEqual((await getProduct(baseUrl, token, componenteId)).stock, 20, "Anular venta compuesta con ajuste pendiente no debe mover stock");
      const rechazados = await getAjustesPendientesStock(baseUrl, token, "rechazado");
      if (!rechazados.some((item) => Number(item.venta_id) === Number(venta.data.venta_id) && item.origen === "venta_receta")) {
        throw new Error("Anular venta compuesta debe cancelar ajuste teorico pendiente");
      }
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testResumenReporteDevuelveClaves() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const { response, data } = await requestJson(baseUrl, "GET", "/reportes/resumen", null, token);
      if (!response.ok) throw new Error(`GET /reportes/resumen fallo: ${data?.message || response.status}`);
      const claves = ["ventas_totales", "pagos_totales", "balance_general", "iva_credito_fiscal", "ticket_promedio", "total_ventas", "total_pagos", "ventas_efectivo", "ventas_debito", "pagos_efectivo", "pagos_debito"];
      for (const clave of claves) {
        if (!(clave in data)) {
          throw new Error(`GET /reportes/resumen debe devolver clave '${clave}'. Respuesta=${JSON.stringify(data)}`);
        }
      }
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testResumenReporteExcluyeVentasAnuladas() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      const ventaOk = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      if (!ventaOk.response.ok) throw new Error(`Venta cobrada fallo: ${ventaOk.data?.message || ventaOk.response.status}`);

      const ventaAnular = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      if (!ventaAnular.response.ok) throw new Error(`Venta a anular fallo: ${ventaAnular.data?.message || ventaAnular.response.status}`);

      const anulacion = await requestJson(baseUrl, "POST", `/ventas/${ventaAnular.data.venta_id}/anular-cobrada`, {
        authorization_code: "1234"
      }, token);
      if (!anulacion.response.ok) throw new Error(`Anulacion fallo: ${anulacion.data?.message || anulacion.response.status}`);

      const { response, data } = await requestJson(baseUrl, "GET", "/reportes/resumen", null, token);
      if (!response.ok) throw new Error(`GET /reportes/resumen fallo: ${data?.message || response.status}`);

      assertApprox(data.ventas_totales, 200, "Resumen debe excluir ventas anuladas de ventas_totales");
      assertEqual(data.total_ventas, 1, "Resumen debe excluir ventas anuladas de total_ventas");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testResumenReporteExcluyePagosPendientes() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const proveedor = await crearProveedor(baseUrl, token);

      await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST pago registrado resumen",
        monto_total: 300,
        tipo_pago: "efectivo",
        estado: "registrado"
      });
      await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST pago pendiente resumen",
        monto_total: 400,
        tipo_pago: "efectivo",
        estado: "pendiente"
      });

      const { response, data } = await requestJson(baseUrl, "GET", "/reportes/resumen", null, token);
      if (!response.ok) throw new Error(`GET /reportes/resumen fallo: ${data?.message || response.status}`);

      assertApprox(data.pagos_totales, 300, "Resumen debe excluir pagos pendientes de pagos_totales");
      assertEqual(data.total_pagos, 1, "Resumen debe excluir pagos pendientes de total_pagos");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testResumenReporteCalculaBalanceGeneral() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const proveedor = await crearProveedor(baseUrl, token);

      const venta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      if (!venta.response.ok) throw new Error(`Venta para balance fallo: ${venta.data?.message || venta.response.status}`);

      await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST pago balance",
        monto_total: 80,
        tipo_pago: "efectivo",
        estado: "registrado"
      });

      const { response, data } = await requestJson(baseUrl, "GET", "/reportes/resumen", null, token);
      if (!response.ok) throw new Error(`GET /reportes/resumen fallo: ${data?.message || response.status}`);

      assertApprox(data.ventas_totales, 200, "balance: ventas_totales debe ser 200");
      assertApprox(data.pagos_totales, 80, "balance: pagos_totales debe ser 80");
      assertApprox(data.balance_general, 120, "balance_general debe ser ventas_totales - pagos_totales");
      assertApprox(data.balance_general, data.ventas_totales - data.pagos_totales, "balance_general debe coincidir con la resta de los totales devueltos");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testResumenReporteCalculaTicketPromedio() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      const v1 = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      if (!v1.response.ok) throw new Error(`Venta 1 ticket promedio fallo: ${v1.data?.message || v1.response.status}`);
      const v2 = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      if (!v2.response.ok) throw new Error(`Venta 2 ticket promedio fallo: ${v2.data?.message || v2.response.status}`);
      const v3 = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      if (!v3.response.ok) throw new Error(`Venta 3 ticket promedio fallo: ${v3.data?.message || v3.response.status}`);

      const { response, data } = await requestJson(baseUrl, "GET", "/reportes/resumen", null, token);
      if (!response.ok) throw new Error(`GET /reportes/resumen fallo: ${data?.message || response.status}`);

      assertEqual(data.total_ventas, 3, "Resumen debe contar 3 ventas en total_ventas");
      assertApprox(data.ventas_totales, 600, "Resumen debe sumar 600 en ventas_totales (3 x 200)");
      assertApprox(data.ticket_promedio, 200, "ticket_promedio debe ser ventas_totales / total_ventas = 200");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testResumenReporteRespetaFiltroFechas() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      const venta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      if (!venta.response.ok) throw new Error(`Venta filtro fechas fallo: ${venta.data?.message || venta.response.status}`);

      // Rango amplio: cubre cualquier fecha que el servidor pueda haber guardado
      const { response: r1, data: d1 } = await requestJson(baseUrl, "GET", "/reportes/resumen?desde=2000-01-01&hasta=2099-12-31", null, token);
      if (!r1.ok) throw new Error(`GET /reportes/resumen rango amplio fallo: ${d1?.message || r1.status}`);
      assertApprox(d1.ventas_totales, 200, "Resumen con rango amplio debe incluir la venta");
      assertEqual(d1.total_ventas, 1, "Resumen con rango amplio debe contar 1 venta");

      // Rango histórico sin datos: la venta creada es de hoy, no de 2010
      const { response: r2, data: d2 } = await requestJson(baseUrl, "GET", "/reportes/resumen?desde=2010-01-01&hasta=2010-12-31", null, token);
      if (!r2.ok) throw new Error(`GET /reportes/resumen rango historico fallo: ${d2?.message || r2.status}`);
      assertApprox(d2.ventas_totales, 0, "Resumen con rango historico debe excluir la venta de hoy");
      assertEqual(d2.total_ventas, 0, "Resumen con rango historico debe contar 0 ventas");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testReporteStockValorizaSoloStockFisico() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const sufijo = Date.now().toString().slice(-8);
      const categoriaId = await crearCategoria(baseUrl, token, `TEST Reporte Stock ${sufijo}`);

      const fisicoId = await crearProducto(baseUrl, token, {
        nombre: `TEST Stock Fisico ${sufijo}`,
        codigo: `RSF-${sufijo}`,
        categoria: `TEST Reporte Stock ${sufijo}`,
        categoria_id: categoriaId,
        precio_compra: 10,
        costo_final: 10,
        precio_venta: 20,
        stock: 5,
        maneja_stock: true,
        tipo: "simple"
      });

      const fraccionableId = await crearProducto(baseUrl, token, {
        nombre: `TEST Cafe Fraccionable ${sufijo}`,
        codigo: `RCF-${sufijo}`,
        categoria: `TEST Reporte Stock ${sufijo}`,
        categoria_id: categoriaId,
        precio_compra: 737.5,
        costo_final: 892.38,
        precio_venta: 2400,
        stock: 875,
        maneja_stock: true,
        tipo: "simple",
        unidad_medida: "fraccionado_gr",
        usa_costos_varios: true,
        costos_insumos: [{
          nombre: "Fraccion cafe",
          costo_total: 59000,
          cantidad_rinde: 1000,
          unidad: "gr",
          cantidad_usada: 12.5
        }]
      });

      const rendimientoId = await crearProductoCompuesto(baseUrl, token, {
        nombre: `TEST Rendimiento Sin Stock ${sufijo}`,
        categoria: `TEST Reporte Stock ${sufijo}`,
        categoria_id: categoriaId,
        precio_venta: 100,
        rendimiento_receta: 10,
        maneja_stock: false,
        componentes: [],
        costos_extra: []
      });

      await runSql(dbPath, "UPDATE productos SET stock = 999, precio_compra = 100, costo_final = 100, maneja_stock = 0, rendimiento_receta = 10 WHERE id = ?", [rendimientoId]);

      const { response, data } = await requestJson(baseUrl, "GET", `/reportes/stock?categoria=${categoriaId}`, null, token);
      if (!response.ok) throw new Error(`GET /reportes/stock fallo: ${data?.message || response.status}`);

      assertApprox(data.resumen.stock_valorizado_fisico, 51675, "Stock valorizado fisico debe sumar stock normal y fraccionable por costo_unitario");
      assertApprox(data.resumen.stock_valorizado_estimado, 51675, "Compat stock_valorizado_estimado debe representar capital fisico");
      assertApprox(data.resumen.valor_rendimiento_estimado, 99900, "Productos sin stock real deben ir a estimaciones por rendimiento");

      const fisico = data.productos.find((producto) => Number(producto.producto_id) === Number(fisicoId));
      const fraccionable = data.productos.find((producto) => Number(producto.producto_id) === Number(fraccionableId));
      const rendimiento = data.productos.find((producto) => Number(producto.producto_id) === Number(rendimientoId));
      if (!fisico || !fraccionable || !rendimiento) throw new Error("Reporte stock debe incluir los productos de prueba");
      assertApprox(fisico.stock_valorizado_fisico, 50, "Producto fisico debe tener valorizacion fisica");
      assertApprox(fraccionable.stock_valorizado_fisico, 51625, "Producto fraccionable debe valorizar stock fisico con costo_unitario");
      if (fraccionable.fuente_valorizacion_fisica !== "costo_unitario") {
        throw new Error(`Producto fraccionable debe exponer fuente costo_unitario. Esperado=costo_unitario, actual=${fraccionable.fuente_valorizacion_fisica}`);
      }
      assertApprox(rendimiento.stock_valorizado_fisico, 0, "Producto sin stock real no debe tener valorizacion fisica");
      assertApprox(rendimiento.valor_rendimiento_estimado, 99900, "Producto sin stock real debe quedar como estimacion separada");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testConfiguracionCodigoAutomaticoProductos() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const sufijo = Date.now().toString().slice(-8);
      const categoriaId = await crearCategoria(baseUrl, token, `TEST Codigo Auto ${sufijo}`);

      let result = await requestJson(baseUrl, "GET", "/configuracion", null, token);
      if (!result.response.ok) throw new Error(`GET /configuracion fallo: ${result.data?.message || result.response.status}`);
      if (result.data.config.stock_codigo_automatico !== true) {
        throw new Error(`stock_codigo_automatico debe venir activo por defecto. Actual=${result.data.config.stock_codigo_automatico}`);
      }

      result = await requestJson(baseUrl, "PUT", "/configuracion", { config: { stock_codigo_automatico: false } }, token);
      if (!result.response.ok) throw new Error(`PUT /configuracion stock_codigo_automatico=false fallo: ${result.data?.message || result.response.status}`);
      if (result.data.config.stock_codigo_automatico !== false) {
        throw new Error("stock_codigo_automatico=false debe persistir en la respuesta de guardado");
      }

      result = await requestJson(baseUrl, "GET", "/configuracion", null, token);
      if (!result.response.ok) throw new Error(`GET /configuracion recarga fallo: ${result.data?.message || result.response.status}`);
      if (result.data.config.stock_codigo_automatico !== false) {
        throw new Error("stock_codigo_automatico=false debe rehidratar al recargar configuracion");
      }

      const sinCodigoId = await crearProducto(baseUrl, token, {
        nombre: `TEST Sin Codigo Auto ${sufijo}`,
        categoria: `TEST Codigo Auto ${sufijo}`,
        categoria_id: categoriaId,
        codigo: "",
        stock: 1
      });
      const sinCodigo = await getProduct(baseUrl, token, sinCodigoId);
      if (String(sinCodigo.codigo || "") !== "") {
        throw new Error(`Con stock_codigo_automatico=false no debe generar codigo. Actual=${sinCodigo.codigo}`);
      }

      result = await requestJson(baseUrl, "PUT", "/configuracion", { config: { stock_codigo_automatico: true } }, token);
      if (!result.response.ok) throw new Error(`PUT /configuracion stock_codigo_automatico=true fallo: ${result.data?.message || result.response.status}`);

      const conCodigoId = await crearProducto(baseUrl, token, {
        nombre: `TEST Con Codigo Auto ${sufijo}`,
        categoria: `TEST Codigo Auto ${sufijo}`,
        categoria_id: categoriaId,
        codigo: "",
        stock: 1
      });
      const conCodigo = await getProduct(baseUrl, token, conCodigoId);
      if (!String(conCodigo.codigo || "").trim()) {
        throw new Error("Con stock_codigo_automatico=true debe generar codigo al crear sin codigo manual");
      }
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testMovimientoManualRegistraStockAnteriorYNuevo() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const result = await requestJson(baseUrl, "POST", "/productos/11/movimientos-stock", {
        tipo_movimiento: "ingreso",
        cantidad: 7,
        motivo: "TEST movimiento manual stock",
        usuario: "test"
      }, token);
      if (!result.response.ok) throw new Error(`Movimiento manual stock fallo: ${result.data?.message || result.response.status}`);

      assertEqual((await getProduct(baseUrl, token, 11)).stock, 87, "Ingreso manual debe actualizar stock fisico");
      const movimientos = await getMovimientosStock(baseUrl, token, 11);
      const movimientoManual = movimientos.find((mov) => mov.motivo === "TEST movimiento manual stock");
      if (!movimientoManual) throw new Error("Ingreso manual debe registrar movimiento_stock");
      assertEqual(movimientoManual.cantidad, 7, "Movimiento manual debe guardar cantidad");
      assertEqual(movimientoManual.stock_anterior, 80, "Movimiento manual debe guardar stock_anterior");
      assertEqual(movimientoManual.stock_nuevo, 87, "Movimiento manual debe guardar stock_nuevo");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testProductosMasVendidosDevuelveClaves() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      const venta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      if (!venta.response.ok) throw new Error(`Venta fallo: ${venta.data?.message || venta.response.status}`);

      const { response, data } = await requestJson(baseUrl, "GET", "/reportes/productos-mas-vendidos", null, token);
      if (!response.ok) throw new Error(`GET /reportes/productos-mas-vendidos fallo: ${data?.message || response.status}`);
      if (!Array.isArray(data)) throw new Error("GET /reportes/productos-mas-vendidos debe devolver un array");
      if (!data.length) throw new Error("GET /reportes/productos-mas-vendidos debe devolver al menos un item");

      const item = data[0];
      for (const clave of ["producto_id", "nombre", "cantidad_total", "total_vendido"]) {
        if (!(clave in item)) {
          throw new Error(`Cada item debe tener clave '${clave}'. Item=${JSON.stringify(item)}`);
        }
      }
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testProductosMasVendidosExcluyeVentasAnuladas() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      const ventaOk = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      if (!ventaOk.response.ok) throw new Error(`Venta cobrada fallo: ${ventaOk.data?.message || ventaOk.response.status}`);

      const ventaAnular = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      if (!ventaAnular.response.ok) throw new Error(`Venta a anular fallo: ${ventaAnular.data?.message || ventaAnular.response.status}`);

      const anulacion = await requestJson(baseUrl, "POST", `/ventas/${ventaAnular.data.venta_id}/anular-cobrada`, {
        authorization_code: "1234"
      }, token);
      if (!anulacion.response.ok) throw new Error(`Anulacion fallo: ${anulacion.data?.message || anulacion.response.status}`);

      const { response, data } = await requestJson(baseUrl, "GET", "/reportes/productos-mas-vendidos", null, token);
      if (!response.ok) throw new Error(`GET /reportes/productos-mas-vendidos fallo: ${data?.message || response.status}`);

      const item = data.find((d) => Number(d.producto_id) === 11);
      if (!item) throw new Error("El producto 11 debe aparecer en el reporte tras la venta no anulada");
      assertApprox(item.cantidad_total, 2, "Productos mas vendidos debe excluir ventas anuladas de cantidad_total");
      assertApprox(item.total_vendido, 200, "Productos mas vendidos debe excluir ventas anuladas de total_vendido");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testProductosMasVendidosOrdenaPorCantidad() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      const categoriaId = await crearCategoria(baseUrl, token, "TEST Orden Productos");
      const productoSecundarioId = await crearProducto(baseUrl, token, {
        nombre: "TEST Producto Secundario Orden",
        categoria: "TEST Orden Productos",
        categoria_id: categoriaId,
        stock: 50,
        precio_venta: 50
      });

      // Producto 11: 4 unidades en total (2 ventas × 2)
      await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);

      // Producto secundario: 1 unidad
      const ventaSecundaria = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test",
        tipo: "normal",
        tipo_cobro: "efectivo",
        items: [{ producto_id: productoSecundarioId, nombre_producto: "TEST Producto Secundario Orden", cantidad: 1, precio_unitario: 50 }]
      }, token);
      if (!ventaSecundaria.response.ok) throw new Error(`Venta secundaria fallo: ${ventaSecundaria.data?.message || ventaSecundaria.response.status}`);

      const { response, data } = await requestJson(baseUrl, "GET", "/reportes/productos-mas-vendidos", null, token);
      if (!response.ok) throw new Error(`GET /reportes/productos-mas-vendidos fallo: ${data?.message || response.status}`);
      if (data.length < 2) throw new Error(`Reporte debe devolver al menos 2 productos. Actual=${data.length}`);

      if (Number(data[0].cantidad_total) < Number(data[1].cantidad_total)) {
        throw new Error(`Reporte debe ordenar por cantidad_total DESC. Primero=${data[0].cantidad_total}, Segundo=${data[1].cantidad_total}`);
      }
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testProductosMasVendidosRespetaFiltroFechas() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      const venta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      if (!venta.response.ok) throw new Error(`Venta fallo: ${venta.data?.message || venta.response.status}`);

      // Rango amplio: incluye la venta de hoy
      const { response: r1, data: d1 } = await requestJson(baseUrl, "GET", "/reportes/productos-mas-vendidos?desde=2000-01-01&hasta=2099-12-31", null, token);
      if (!r1.ok) throw new Error(`GET rango amplio fallo: ${d1?.message || r1.status}`);
      if (!d1.length) throw new Error("Rango amplio debe devolver al menos un producto vendido");

      // Rango historico sin datos: excluye la venta de hoy
      const { response: r2, data: d2 } = await requestJson(baseUrl, "GET", "/reportes/productos-mas-vendidos?desde=2010-01-01&hasta=2010-12-31", null, token);
      if (!r2.ok) throw new Error(`GET rango historico fallo: ${d2?.message || r2.status}`);
      if (d2.length !== 0) throw new Error(`Rango historico debe devolver array vacio. Actual=${JSON.stringify(d2)}`);
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testProductosMasVendidosRespetaLimite() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      const categoriaId = await crearCategoria(baseUrl, token, "TEST Limite Productos");
      const productoExtraId = await crearProducto(baseUrl, token, {
        nombre: "TEST Producto Limite Extra",
        categoria: "TEST Limite Productos",
        categoria_id: categoriaId,
        stock: 50,
        precio_venta: 50
      });

      // 2 productos distintos con ventas
      await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      const ventaExtra = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test",
        tipo: "normal",
        tipo_cobro: "efectivo",
        items: [{ producto_id: productoExtraId, nombre_producto: "TEST Producto Limite Extra", cantidad: 1, precio_unitario: 50 }]
      }, token);
      if (!ventaExtra.response.ok) throw new Error(`Venta extra fallo: ${ventaExtra.data?.message || ventaExtra.response.status}`);

      // limite=1 debe devolver exactamente 1 resultado
      const { response: r1, data: d1 } = await requestJson(baseUrl, "GET", "/reportes/productos-mas-vendidos?limite=1", null, token);
      if (!r1.ok) throw new Error(`GET limite=1 fallo: ${d1?.message || r1.status}`);
      assertEqual(d1.length, 1, "Con limite=1 el endpoint debe devolver exactamente 1 producto");

      // limite=100 debe devolver todos (ambos productos)
      const { response: r2, data: d2 } = await requestJson(baseUrl, "GET", "/reportes/productos-mas-vendidos?limite=100", null, token);
      if (!r2.ok) throw new Error(`GET limite=100 fallo: ${d2?.message || r2.status}`);
      if (d2.length < 2) throw new Error(`Con limite=100 debe devolver todos los productos vendidos. Actual=${d2.length}`);
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testModificadoresEtapa0SchemaYReporteNeutro() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      const tablas = await allSql(
        dbPath,
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name IN (
             'modificadores',
             'producto_modificadores',
             'modificador_componentes',
             'detalle_venta_modificadores',
             'detalle_venta_componentes_snapshot'
           )`
      );
      assertEqual(tablas.length, 5, "Etapa 0 debe asegurar las cinco tablas de modificadores");

      await runSql(
        dbPath,
        "INSERT INTO modificadores (codigo, nombre, tipo, precio_extra, activo, orden) VALUES (?, ?, ?, ?, 1, 1)",
        ["extra_queso_test", "Extra queso TEST", "agregar", 500]
      );
      await runSql(
        dbPath,
        "INSERT INTO producto_modificadores (producto_id, modificador_id, activo) VALUES (?, (SELECT id FROM modificadores WHERE codigo = ?), 1)",
        [11, "extra_queso_test"]
      );

      const venta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      if (!venta.response.ok) throw new Error(`Venta con tablas de modificadores neutras fallo: ${venta.data?.message || venta.response.status}`);

      const { response, data } = await requestJson(baseUrl, "GET", "/reportes/productos-mas-vendidos?limite=100", null, token);
      if (!response.ok) throw new Error(`GET /reportes/productos-mas-vendidos fallo: ${data?.message || response.status}`);
      if (data.some((item) => String(item.nombre || "").includes("Extra queso TEST"))) {
        throw new Error(`Los modificadores no deben aparecer como productos vendidos. Reporte=${JSON.stringify(data)}`);
      }
      const producto = data.find((item) => Number(item.producto_id) === 11);
      if (!producto) throw new Error("El producto vendido debe seguir apareciendo en productos mas vendidos");
      assertApprox(producto.total_vendido, 200, "La tabla de modificadores sin uso no debe alterar total_vendido");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testCuentaCorrienteConservaDetalleHistoricoSinModificadores() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      const clienteResult = await requestJson(baseUrl, "POST", "/clientes", {
        nombre: "Cliente CC Modificadores Etapa 0",
        dni_cuit: `30${Date.now().toString().slice(-8)}`,
        tipo_persona: "fisica",
        habilita_cuenta_corriente: true,
        activo: true
      }, token);
      if (!clienteResult.response.ok) throw new Error(`Crear cliente cuenta corriente fallo: ${clienteResult.data?.message || clienteResult.response.status}`);

      const venta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        es_cuenta_corriente: true,
        cliente_id: clienteResult.data.cliente.id,
        tipo_cobro: undefined
      }), token);
      if (!venta.response.ok) throw new Error(`Venta cuenta corriente sin modificadores fallo: ${venta.data?.message || venta.response.status}`);

      await runSql(dbPath, "UPDATE productos SET precio_venta = 999 WHERE id = 11");

      const detalle = await getVentaDetalle(baseUrl, token, venta.data.venta_id);
      assertApprox(detalle.venta.total, 200, "Cuenta corriente debe conservar total historico de la venta creada");
      assertApprox(detalle.items[0].precio_unitario, 100, "Cuenta corriente debe conservar precio_unitario historico en detalle_ventas");
      assertApprox(detalle.items[0].subtotal, 200, "Cuenta corriente debe conservar subtotal historico en detalle_ventas");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testComboActualGeneraAjusteTeoricoSinModificadores() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, [
      ...resetOperationalDataStatements(),
      ["UPDATE productos SET stock = 80, maneja_stock = 1, usa_costos_varios = 0, tipo = 'simple', es_combo = 0 WHERE id = 11"]
    ]);
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const categoriaId = await crearCategoria(baseUrl, token, "TEST Combo Etapa 0");

      const combo = await requestJson(baseUrl, "POST", "/productos", {
        nombre: "TEST Combo Etapa 0",
        categoria: "TEST Combo Etapa 0",
        categoria_id: categoriaId,
        tipo: "compuesto",
        componentes: [{ producto_id: 11, cantidad: 2 }],
        costos_extra: [],
        precio_compra: 100,
        precio_venta: 250,
        stock: 0,
        maneja_stock: false,
        activo: true,
        iva_porcentaje: 0,
        precio_compra_incluye_iva: false,
        redondeo: 0,
        unidad_medida: "un",
        es_combo: true,
        usuario: "test"
      }, token);
      if (!combo.response.ok) throw new Error(`Crear combo etapa 0 fallo: ${combo.data?.message || combo.response.status}`);

      const venta = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test",
        tipo: "normal",
        tipo_cobro: "efectivo",
        items: [{ producto_id: combo.data.id, nombre_producto: "TEST Combo Etapa 0", cantidad: 1, precio_unitario: 250 }]
      }, token);
      if (!venta.response.ok) throw new Error(`Venta combo etapa 0 fallo: ${venta.data?.message || venta.response.status}`);

      assertEqual((await getProduct(baseUrl, token, 11)).stock, 80, "Combo sin stock no debe descontar componentes al vender");
      const ajustes = await getAjustesPendientesStock(baseUrl, token, "pendiente");
      const ajuste = ajustes.find((item) => Number(item.venta_id) === Number(venta.data.venta_id) && item.origen === "venta_receta");
      if (!ajuste) throw new Error("Combo sin stock debe generar ajuste teorico pendiente");
      assertApprox(ajuste.cantidad_teorica, 2, "Ajuste teorico de combo debe guardar consumo de componentes");
      const detalle = await getVentaDetalle(baseUrl, token, venta.data.venta_id);
      assertEqual(detalle.items.length, 1, "Combo debe quedar como una sola linea de detalle_ventas");
      assertEqual(detalle.items[0].producto_id, combo.data.id, "Detalle debe registrar el producto combo, no sus componentes como lineas vendidas");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testModificadoresEtapa1BackendAislado() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const categoriaId = await crearCategoria(baseUrl, token, "TEST Mods Etapa 1");
      const componenteId = await crearProducto(baseUrl, token, {
        nombre: "TEST Queso Extra Mod",
        categoria: "TEST Mods Etapa 1",
        categoria_id: categoriaId,
        stock: 30,
        precio_venta: 10
      });
      const suffix = Date.now().toString().slice(-8);

      const libre = await requestJson(baseUrl, "POST", "/productos/11/modificadores", {
        codigo: `libre_${suffix}`,
        nombre: "TEST Libre Mod",
        tipo: "libre",
        precio_extra: 25,
        orden: 1
      }, token);
      if (!libre.response.ok) throw new Error(`Crear modificador libre fallo: ${libre.data?.message || libre.response.status}`);

      const observacion = await requestJson(baseUrl, "POST", "/productos/11/modificadores", {
        codigo: `obs_${suffix}`,
        nombre: "TEST Observacion Mod",
        tipo: "observacion",
        precio_extra: 99,
        observacion_cocina: "Sin cebolla",
        orden: 2
      }, token);
      if (!observacion.response.ok) throw new Error(`Crear modificador observacion fallo: ${observacion.data?.message || observacion.response.status}`);

      const agregar = await requestJson(baseUrl, "POST", "/productos/11/modificadores", {
        codigo: `agregar_${suffix}`,
        nombre: "TEST Agregar Queso Mod",
        tipo: "agregar",
        precio_extra: 40,
        componentes: [{ producto_id: componenteId, cantidad: 3 }],
        orden: 3
      }, token);
      if (!agregar.response.ok) throw new Error(`Crear modificador agregar fallo: ${agregar.data?.message || agregar.response.status}`);

      const listado = await requestJson(baseUrl, "GET", "/productos/11/modificadores", null, token);
      if (!listado.response.ok) throw new Error(`GET modificadores fallo: ${listado.data?.message || listado.response.status}`);
      if (listado.data.length < 3) throw new Error(`GET modificadores debe devolver los modificadores creados. Actual=${JSON.stringify(listado.data)}`);
      const agregarListado = listado.data.find((item) => item.codigo === `agregar_${suffix}`);
      if (!agregarListado?.componentes?.length) {
        throw new Error(`Modificador agregar debe devolver componentes. Actual=${JSON.stringify(agregarListado)}`);
      }

      const stockBaseAntes = (await getProduct(baseUrl, token, 11)).stock;
      const stockComponenteAntes = (await getProduct(baseUrl, token, componenteId)).stock;
      const prueba = await requestJson(baseUrl, "POST", "/ventas/test-modificadores", {
        usuario: "test",
        item: {
          producto_id: 11,
          nombre_producto: "Coca Cola 1250",
          cantidad: 1,
          precio_unitario: 100,
          modificadores: [
            { modificador_id: libre.data.modificador.id },
            { modificador_id: observacion.data.modificador.id },
            { modificador_id: agregar.data.modificador.id }
          ]
        }
      }, token);
      if (!prueba.response.ok) throw new Error(`Venta test modificadores fallo: ${prueba.data?.message || prueba.response.status}`);

      assertApprox(prueba.data.total, 165, "Modificador libre y agregar deben sumar precio; observacion no suma");
      assertEqual((await getProduct(baseUrl, token, 11)).stock, stockBaseAntes, "Venta test modificadores no debe mover stock del producto base");
      assertEqual((await getProduct(baseUrl, token, componenteId)).stock, stockComponenteAntes, "Venta test modificadores no debe mover stock del componente extra");

      const ventasDespuesTest = await getVentas(baseUrl, token);
      if (ventasDespuesTest.some((venta) => Number(venta.id) === Number(prueba.data.venta_id) || venta.tipo === "test_modificadores")) {
        throw new Error(`GET /ventas no debe listar ventas tecnicas test_modificadores. Ventas=${JSON.stringify(ventasDespuesTest)}`);
      }
      const detalleListado = await requestJson(baseUrl, "GET", "/detalle-ventas", null, token);
      if (!detalleListado.response.ok) throw new Error(`GET /detalle-ventas fallo: ${detalleListado.data?.message || detalleListado.response.status}`);
      if (detalleListado.data.some((detalle) => Number(detalle.venta_id) === Number(prueba.data.venta_id))) {
        throw new Error(`GET /detalle-ventas no debe listar detalles de ventas tecnicas. Detalles=${JSON.stringify(detalleListado.data)}`);
      }

      const modsSnapshot = await allSql(
        dbPath,
        "SELECT * FROM detalle_venta_modificadores WHERE detalle_venta_id = ? ORDER BY id ASC",
        [prueba.data.detalle_venta_id]
      );
      assertEqual(modsSnapshot.length, 3, "Venta test debe guardar snapshot de los modificadores");
      const obsSnapshot = modsSnapshot.find((item) => item.tipo === "observacion");
      if (!obsSnapshot || Number(obsSnapshot.precio_extra) !== 0) {
        throw new Error(`Modificador observacion debe quedar en historial sin precio. Actual=${JSON.stringify(obsSnapshot)}`);
      }

      const componentesSnapshot = await allSql(
        dbPath,
        "SELECT * FROM detalle_venta_componentes_snapshot WHERE detalle_venta_id = ? ORDER BY id ASC",
        [prueba.data.detalle_venta_id]
      );
      assertEqual(componentesSnapshot.length, 1, "Modificador agregar debe preparar snapshot de componente extra");
      assertEqual(componentesSnapshot[0].producto_id, componenteId, "Snapshot de componente debe referenciar el ingrediente extra");
      assertApprox(componentesSnapshot[0].cantidad, 3, "Snapshot de componente debe guardar cantidad extra total");
      if (!prueba.data.stock_delta.componentes.length) {
        throw new Error("getStockDeltaVentaItem debe exponer componentes extra preparados");
      }

      const ventaNormal = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      if (!ventaNormal.response.ok) throw new Error(`Venta normal post modificadores fallo: ${ventaNormal.data?.message || ventaNormal.response.status}`);
      assertEqual((await getProduct(baseUrl, token, 11)).stock, stockBaseAntes - 2, "Venta normal sin modificadores debe seguir descontando igual");
      const ventasConNormal = await getVentas(baseUrl, token);
      if (!ventasConNormal.some((venta) => Number(venta.id) === Number(ventaNormal.data.venta_id))) {
        throw new Error("GET /ventas debe seguir listando ventas reales normales");
      }

      const reporte = await requestJson(baseUrl, "GET", "/reportes/productos-mas-vendidos?limite=100", null, token);
      if (!reporte.response.ok) throw new Error(`GET reporte modificadores fallo: ${reporte.data?.message || reporte.response.status}`);
      if (reporte.data.some((item) => String(item.nombre || "").includes("TEST Libre Mod") || String(item.nombre || "").includes("TEST Agregar Queso Mod"))) {
        throw new Error(`Productos mas vendidos no debe incluir modificadores como productos. Reporte=${JSON.stringify(reporte.data)}`);
      }
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testModificadoresEtapa2AVentasNormales() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const categoriaId = await crearCategoria(baseUrl, token, "TEST Mods Etapa 2A");
      const componenteId = await crearProducto(baseUrl, token, {
        nombre: "TEST Componente Extra Etapa 2A",
        categoria: "TEST Mods Etapa 2A",
        categoria_id: categoriaId,
        stock: 30,
        precio_venta: 10
      });
      const suffix = Date.now().toString().slice(-8);

      const ventaSinMods = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      if (!ventaSinMods.response.ok) throw new Error(`Venta normal sin modificadores fallo: ${ventaSinMods.data?.message || ventaSinMods.response.status}`);
      assertEqual((await getProduct(baseUrl, token, 11)).stock, 78, "Venta normal sin modificadores debe seguir descontando igual");
      const detalleSinMods = await getVentaDetalle(baseUrl, token, ventaSinMods.data.venta_id);
      assertEqual(detalleSinMods.items.length, 1, "Venta sin modificadores debe guardar una sola linea de detalle_ventas");
      assertApprox(detalleSinMods.items[0].subtotal, 200, "Venta sin modificadores debe conservar subtotal historico");

      const libre = await requestJson(baseUrl, "POST", "/productos/11/modificadores", {
        codigo: `etapa2a_libre_${suffix}`,
        nombre: "TEST Etapa 2A Libre",
        tipo: "libre",
        precio_extra: 25,
        orden: 1
      }, token);
      if (!libre.response.ok) throw new Error(`Crear modificador libre etapa 2A fallo: ${libre.data?.message || libre.response.status}`);

      const observacion = await requestJson(baseUrl, "POST", "/productos/11/modificadores", {
        codigo: `etapa2a_obs_${suffix}`,
        nombre: "TEST Etapa 2A Observacion",
        tipo: "observacion",
        precio_extra: 99,
        observacion_cocina: "Sin cebolla",
        orden: 2
      }, token);
      if (!observacion.response.ok) throw new Error(`Crear modificador observacion etapa 2A fallo: ${observacion.data?.message || observacion.response.status}`);

      const agregar = await requestJson(baseUrl, "POST", "/productos/11/modificadores", {
        codigo: `etapa2a_agregar_${suffix}`,
        nombre: "TEST Etapa 2A Agregar",
        tipo: "agregar",
        precio_extra: 40,
        componentes: [{ producto_id: componenteId, cantidad: 3 }],
        orden: 3
      }, token);
      if (!agregar.response.ok) throw new Error(`Crear modificador agregar etapa 2A fallo: ${agregar.data?.message || agregar.response.status}`);

      const ventaConMods = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test",
        tipo: "normal",
        tipo_cobro: "efectivo",
        items: [{
          producto_id: 11,
          nombre_producto: "Coca Cola 1250",
          cantidad: 1,
          precio_unitario: 100,
          modificadores: [
            { modificador_id: libre.data.modificador.id, cantidad: 1 },
            { modificador_id: observacion.data.modificador.id, cantidad: 1 },
            { modificador_id: agregar.data.modificador.id, cantidad: 1 }
          ]
        }]
      }, token);
      if (!ventaConMods.response.ok) throw new Error(`Venta normal con modificadores fallo: ${ventaConMods.data?.message || ventaConMods.response.status}`);
      assertApprox(ventaConMods.data.total, 165, "Venta con modificadores debe sumar libre y agregar, no observacion");
      assertEqual((await getProduct(baseUrl, token, 11)).stock, 77, "Venta con modificadores debe descontar solo stock base una vez");
      assertEqual((await getProduct(baseUrl, token, componenteId)).stock, 27, "Modificador agregar debe descontar componente extra desde snapshot");

      const detalleConMods = await getVentaDetalle(baseUrl, token, ventaConMods.data.venta_id);
      assertEqual(detalleConMods.items.length, 1, "Modificadores no deben insertarse como productos vendidos");
      assertEqual(detalleConMods.items[0].producto_id, 11, "Detalle debe conservar el producto base vendido");
      assertApprox(detalleConMods.items[0].precio_unitario, 165, "Detalle debe guardar precio unitario final con modificadores");
      assertApprox(detalleConMods.items[0].subtotal, 165, "Detalle debe guardar total final con modificadores");

      const modsSnapshot = await allSql(
        dbPath,
        "SELECT * FROM detalle_venta_modificadores WHERE detalle_venta_id = ? ORDER BY id ASC",
        [detalleConMods.items[0].id]
      );
      assertEqual(modsSnapshot.length, 3, "Detalle con modificadores debe guardar los tres modificadores asociados");
      const obsSnapshot = modsSnapshot.find((item) => item.tipo === "observacion");
      if (!obsSnapshot || Number(obsSnapshot.precio_extra) !== 0) {
        throw new Error(`Observacion debe guardarse en historial sin mover precio. Actual=${JSON.stringify(obsSnapshot)}`);
      }

      const componentesSnapshot = await allSql(
        dbPath,
        "SELECT * FROM detalle_venta_componentes_snapshot WHERE detalle_venta_id = ? ORDER BY id ASC",
        [detalleConMods.items[0].id]
      );
      assertEqual(componentesSnapshot.length, 1, "Detalle con modificador agregar debe guardar snapshot de componente");
      assertEqual(componentesSnapshot[0].producto_id, componenteId, "Snapshot debe asociar el componente extra correcto");
      assertApprox(componentesSnapshot[0].cantidad, 3, "Snapshot debe guardar cantidad extra total");

      const resumenCaja = await getCajaResumen(baseUrl, token);
      assertApprox(resumenCaja.resumen.total_ventas, 365, "Caja debe incluir el precio extra en el total de venta");

      const reporte = await requestJson(baseUrl, "GET", "/reportes/productos-mas-vendidos?limite=100", null, token);
      if (!reporte.response.ok) throw new Error(`Reporte productos mas vendidos etapa 2A fallo: ${reporte.data?.message || reporte.response.status}`);
      if (reporte.data.some((item) => String(item.nombre || "").includes("TEST Etapa 2A"))) {
        throw new Error(`Modificadores no deben aparecer como productos vendidos. Reporte=${JSON.stringify(reporte.data)}`);
      }
      const productoBase = reporte.data.find((item) => Number(item.producto_id) === 11);
      if (!productoBase) throw new Error("Producto base debe aparecer en productos mas vendidos");
      assertApprox(productoBase.cantidad_total, 3, "Productos mas vendidos debe contar solo cantidades del producto base");
      assertApprox(productoBase.total_vendido, 365, "Productos mas vendidos debe incluir el total final con precio extra");

      const modificadorOtroProducto = await requestJson(baseUrl, "POST", `/productos/${componenteId}/modificadores`, {
        codigo: `etapa2a_otro_${suffix}`,
        nombre: "TEST Etapa 2A Otro Producto",
        tipo: "libre",
        precio_extra: 5
      }, token);
      if (!modificadorOtroProducto.response.ok) throw new Error(`Crear modificador de otro producto fallo: ${modificadorOtroProducto.data?.message || modificadorOtroProducto.response.status}`);

      const ventaInvalida = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test",
        tipo: "normal",
        tipo_cobro: "efectivo",
        items: [{
          producto_id: 11,
          nombre_producto: "Coca Cola 1250",
          cantidad: 1,
          precio_unitario: 100,
          modificadores: [{ modificador_id: modificadorOtroProducto.data.modificador.id, cantidad: 1 }]
        }]
      }, token);
      assertEqual(ventaInvalida.response.status, 400, "Modificador no asociado al producto vendido debe fallar");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testModificadoresEtapa2AProteccionesAuditoria() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const categoriaId = await crearCategoria(baseUrl, token, "TEST Mods Auditoria 2A");
      const componenteId = await crearProducto(baseUrl, token, {
        nombre: "TEST Componente Auditoria 2A",
        categoria: "TEST Mods Auditoria 2A",
        categoria_id: categoriaId,
        stock: 30,
        precio_venta: 10
      });
      const suffix = Date.now().toString().slice(-8);

      const agregar = await requestJson(baseUrl, "POST", "/productos/11/modificadores", {
        codigo: `aud2a_agregar_${suffix}`,
        nombre: "TEST Auditoria 2A Agregar",
        tipo: "agregar",
        precio_extra: 40,
        componentes: [{ producto_id: componenteId, cantidad: 3 }]
      }, token);
      if (!agregar.response.ok) throw new Error(`Crear modificador agregar auditoria 2A fallo: ${agregar.data?.message || agregar.response.status}`);

      const venta = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test",
        tipo: "normal",
        tipo_cobro: "efectivo",
        items: [{
          producto_id: 11,
          nombre_producto: "Coca Cola 1250",
          cantidad: 1,
          precio_unitario: 100,
          modificadores: [{ modificador_id: agregar.data.modificador.id, cantidad: 1 }]
        }]
      }, token);
      if (!venta.response.ok) throw new Error(`Venta auditoria 2A con modificador agregar fallo: ${venta.data?.message || venta.response.status}`);
      assertEqual((await getProduct(baseUrl, token, 11)).stock, 79, "Venta con agregar debe descontar stock base una vez");
      assertEqual((await getProduct(baseUrl, token, componenteId)).stock, 27, "Venta con agregar debe descontar componente extra");

      await runSql(dbPath, "UPDATE modificador_componentes SET cantidad = 99 WHERE modificador_id = ?", [agregar.data.modificador.id]);
      await runSql(dbPath, "UPDATE modificadores SET precio_extra = 999 WHERE id = ?", [agregar.data.modificador.id]);

      const anular = await requestJson(baseUrl, "POST", `/ventas/${venta.data.venta_id}/anular-cobrada`, {
        authorization_code: "1234"
      }, token);
      if (!anular.response.ok) throw new Error(`Anular venta auditoria 2A fallo: ${anular.data?.message || anular.response.status}`);
      assertEqual((await getProduct(baseUrl, token, 11)).stock, 80, "Anular venta con agregar debe reponer stock base");
      assertEqual((await getProduct(baseUrl, token, componenteId)).stock, 30, "Anular debe reponer componente desde snapshot historico sin recalcular configuracion actual");

      const agregarCantidad = await requestJson(baseUrl, "POST", "/productos/11/modificadores", {
        codigo: `aud2a_agregar_cantidad_${suffix}`,
        nombre: "TEST Auditoria 2A Agregar Cantidad",
        tipo: "agregar",
        precio_extra: 15,
        componentes: [{ producto_id: componenteId, cantidad: 2 }]
      }, token);
      if (!agregarCantidad.response.ok) throw new Error(`Crear modificador cantidad=2 auditoria 2A fallo: ${agregarCantidad.data?.message || agregarCantidad.response.status}`);

      const ventaCantidadDos = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test",
        tipo: "normal",
        tipo_cobro: "efectivo",
        items: [{
          producto_id: 11,
          nombre_producto: "Coca Cola 1250",
          cantidad: 1,
          precio_unitario: 100,
          modificadores: [{ modificador_id: agregarCantidad.data.modificador.id, cantidad: 2 }]
        }]
      }, token);
      if (!ventaCantidadDos.response.ok) throw new Error(`Venta auditoria 2A cantidad=2 fallo: ${ventaCantidadDos.data?.message || ventaCantidadDos.response.status}`);
      assertApprox(ventaCantidadDos.data.total, 130, "Modificador cantidad=2 debe sumar precio multiplicado");
      assertEqual((await getProduct(baseUrl, token, 11)).stock, 79, "Modificador cantidad=2 debe descontar stock base una vez");
      assertEqual((await getProduct(baseUrl, token, componenteId)).stock, 26, "Modificador cantidad=2 debe descontar componente extra multiplicado");

      const inactivo = await requestJson(baseUrl, "POST", "/productos/11/modificadores", {
        codigo: `aud2a_inactivo_${suffix}`,
        nombre: "TEST Auditoria 2A Inactivo",
        tipo: "libre",
        precio_extra: 5
      }, token);
      if (!inactivo.response.ok) throw new Error(`Crear modificador inactivo auditoria 2A fallo: ${inactivo.data?.message || inactivo.response.status}`);
      await runSql(dbPath, "UPDATE modificadores SET activo = 0 WHERE id = ?", [inactivo.data.modificador.id]);
      const ventaInactiva = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test",
        tipo: "normal",
        tipo_cobro: "efectivo",
        items: [{
          producto_id: 11,
          nombre_producto: "Coca Cola 1250",
          cantidad: 1,
          precio_unitario: 100,
          modificadores: [{ modificador_id: inactivo.data.modificador.id, cantidad: 1 }]
        }]
      }, token);
      assertEqual(ventaInactiva.response.status, 400, "Modificador inactivo debe fallar en POST /ventas");

      for (const tipoNoHabilitado of ["multiplicar", "reemplazar"]) {
        const modNoHabilitado = await requestJson(baseUrl, "POST", "/productos/11/modificadores", {
          codigo: `aud2a_${tipoNoHabilitado}_${suffix}`,
          nombre: `TEST Auditoria 2A ${tipoNoHabilitado}`,
          tipo: tipoNoHabilitado,
          precio_extra: 5
        }, token);
        if (!modNoHabilitado.response.ok) {
          throw new Error(`Crear modificador ${tipoNoHabilitado} auditoria 2A fallo: ${modNoHabilitado.data?.message || modNoHabilitado.response.status}`);
        }

        const ventaNoHabilitada = await requestJson(baseUrl, "POST", "/ventas", {
          usuario: "test",
          tipo: "normal",
          tipo_cobro: "efectivo",
          items: [{
            producto_id: 11,
            nombre_producto: "Coca Cola 1250",
            cantidad: 1,
            precio_unitario: 100,
            modificadores: [{ modificador_id: modNoHabilitado.data.modificador.id, cantidad: 1 }]
          }]
        }, token);
        assertEqual(ventaNoHabilitada.response.status, 400, `Modificador ${tipoNoHabilitado} no debe estar habilitado en Etapa 2A`);
      }
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testModificadoresEtapa2BPendientesNuevas() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const categoriaId = await crearCategoria(baseUrl, token, "TEST Mods Etapa 2B");
      const componenteId = await crearProducto(baseUrl, token, {
        nombre: "TEST Componente Etapa 2B",
        categoria: "TEST Mods Etapa 2B",
        categoria_id: categoriaId,
        stock: 30,
        precio_venta: 10
      });
      const suffix = Date.now().toString().slice(-8);

      const pendienteSinMods = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo: "pendiente",
        identificador_pendiente: `PEND-SIN-MODS-${suffix}`,
        tipo_cobro: undefined
      }), token);
      if (!pendienteSinMods.response.ok) throw new Error(`Pendiente sin modificadores fallo: ${pendienteSinMods.data?.message || pendienteSinMods.response.status}`);
      assertEqual((await getProduct(baseUrl, token, 11)).stock, 78, "Pendiente sin modificadores debe seguir descontando stock base al guardar");
      const resumenSinMods = await getCajaResumen(baseUrl, token);
      assertEqual(resumenSinMods.resumen.total_ventas, 0, "Pendiente sin modificadores no debe impactar caja hasta cobrar");

      const libre = await requestJson(baseUrl, "POST", "/productos/11/modificadores", {
        codigo: `etapa2b_libre_${suffix}`,
        nombre: "TEST Etapa 2B Libre",
        tipo: "libre",
        precio_extra: 25
      }, token);
      if (!libre.response.ok) throw new Error(`Crear modificador libre etapa 2B fallo: ${libre.data?.message || libre.response.status}`);

      const observacion = await requestJson(baseUrl, "POST", "/productos/11/modificadores", {
        codigo: `etapa2b_obs_${suffix}`,
        nombre: "TEST Etapa 2B Observacion",
        tipo: "observacion",
        precio_extra: 99,
        observacion_cocina: "Sin cebolla"
      }, token);
      if (!observacion.response.ok) throw new Error(`Crear modificador observacion etapa 2B fallo: ${observacion.data?.message || observacion.response.status}`);

      const agregar = await requestJson(baseUrl, "POST", "/productos/11/modificadores", {
        codigo: `etapa2b_agregar_${suffix}`,
        nombre: "TEST Etapa 2B Agregar",
        tipo: "agregar",
        precio_extra: 40,
        componentes: [{ producto_id: componenteId, cantidad: 3 }]
      }, token);
      if (!agregar.response.ok) throw new Error(`Crear modificador agregar etapa 2B fallo: ${agregar.data?.message || agregar.response.status}`);

      const pendienteConMods = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test",
        tipo: "pendiente",
        identificador_pendiente: `PEND-MODS-${suffix}`,
        items: [{
          producto_id: 11,
          nombre_producto: "Coca Cola 1250",
          cantidad: 1,
          precio_unitario: 100,
          modificadores: [
            { modificador_id: libre.data.modificador.id, cantidad: 1 },
            { modificador_id: observacion.data.modificador.id, cantidad: 1 },
            { modificador_id: agregar.data.modificador.id, cantidad: 1 }
          ]
        }]
      }, token);
      if (!pendienteConMods.response.ok) throw new Error(`Pendiente con modificadores fallo: ${pendienteConMods.data?.message || pendienteConMods.response.status}`);
      assertApprox(pendienteConMods.data.total, 165, "Pendiente con modificadores debe sumar libre y agregar, no observacion");
      assertEqual((await getProduct(baseUrl, token, 11)).stock, 77, "Pendiente con modificadores debe descontar stock base al guardar");
      assertEqual((await getProduct(baseUrl, token, componenteId)).stock, 27, "Pendiente con modificador agregar debe descontar componente extra al guardar");

      const detallePendiente = await getVentaDetalle(baseUrl, token, pendienteConMods.data.venta_id);
      assertEqual(detallePendiente.venta.estado === "pendiente" ? 1 : 0, 1, "Venta con modificadores debe quedar pendiente");
      assertEqual(detallePendiente.items.length, 1, "Modificadores de pendiente no deben ser lineas de detalle_ventas");
      assertApprox(detallePendiente.items[0].precio_unitario, 165, "Detalle de pendiente debe guardar precio final con modificadores");

      const modsSnapshot = await allSql(
        dbPath,
        "SELECT * FROM detalle_venta_modificadores WHERE detalle_venta_id = ? ORDER BY id ASC",
        [detallePendiente.items[0].id]
      );
      assertEqual(modsSnapshot.length, 3, "Pendiente con modificadores debe guardar snapshot de modificadores");
      const obsSnapshot = modsSnapshot.find((item) => item.tipo === "observacion");
      if (!obsSnapshot || Number(obsSnapshot.precio_extra) !== 0) {
        throw new Error(`Observacion en pendiente debe guardarse sin precio. Actual=${JSON.stringify(obsSnapshot)}`);
      }

      const componentesSnapshot = await allSql(
        dbPath,
        "SELECT * FROM detalle_venta_componentes_snapshot WHERE detalle_venta_id = ? ORDER BY id ASC",
        [detallePendiente.items[0].id]
      );
      assertEqual(componentesSnapshot.length, 1, "Pendiente con agregar debe guardar snapshot de componente extra");
      assertEqual(componentesSnapshot[0].producto_id, componenteId, "Snapshot de pendiente debe asociar componente extra");
      assertApprox(componentesSnapshot[0].cantidad, 3, "Snapshot de pendiente debe guardar cantidad extra total");

      const cobrar = await requestJson(baseUrl, "POST", `/ventas/${pendienteConMods.data.venta_id}/cobrar`, {
        tipo_cobro: "efectivo"
      }, token);
      if (!cobrar.response.ok) throw new Error(`Cobrar pendiente con modificadores fallo: ${cobrar.data?.message || cobrar.response.status}`);
      assertEqual((await getProduct(baseUrl, token, 11)).stock, 77, "Cobrar pendiente con modificadores no debe descontar stock base otra vez");
      assertEqual((await getProduct(baseUrl, token, componenteId)).stock, 27, "Cobrar pendiente con modificadores no debe descontar componente extra otra vez");
      const resumenCobrado = await getCajaResumen(baseUrl, token);
      assertApprox(resumenCobrado.resumen.total_ventas, 165, "Caja debe tomar total final con modificadores al cobrar pendiente");
      assertApprox(resumenCobrado.resumen.total_efectivo, 165, "Caja debe tomar efectivo final con modificadores al cobrar pendiente");

      const reporte = await requestJson(baseUrl, "GET", "/reportes/productos-mas-vendidos?limite=100", null, token);
      if (!reporte.response.ok) throw new Error(`Reporte productos mas vendidos etapa 2B fallo: ${reporte.data?.message || reporte.response.status}`);
      if (reporte.data.some((item) => String(item.nombre || "").includes("TEST Etapa 2B"))) {
        throw new Error(`Modificadores de pendiente no deben aparecer como productos vendidos. Reporte=${JSON.stringify(reporte.data)}`);
      }

      const pendienteAAnular = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test",
        tipo: "pendiente",
        identificador_pendiente: `PEND-ANULAR-MODS-${suffix}`,
        items: [{
          producto_id: 11,
          nombre_producto: "Coca Cola 1250",
          cantidad: 1,
          precio_unitario: 100,
          modificadores: [{ modificador_id: agregar.data.modificador.id, cantidad: 1 }]
        }]
      }, token);
      if (!pendienteAAnular.response.ok) throw new Error(`Pendiente a anular con modificador fallo: ${pendienteAAnular.data?.message || pendienteAAnular.response.status}`);
      assertEqual((await getProduct(baseUrl, token, 11)).stock, 76, "Pendiente a anular debe descontar stock base antes de anular");
      assertEqual((await getProduct(baseUrl, token, componenteId)).stock, 24, "Pendiente a anular debe descontar extra antes de anular");
      await runSql(dbPath, "UPDATE modificador_componentes SET cantidad = 99 WHERE modificador_id = ?", [agregar.data.modificador.id]);
      const anularPendiente = await requestJson(baseUrl, "POST", `/ventas/${pendienteAAnular.data.venta_id}/anular`, {
        authorization_code: "1234"
      }, token);
      if (!anularPendiente.response.ok) throw new Error(`Anular pendiente con modificador fallo: ${anularPendiente.data?.message || anularPendiente.response.status}`);
      assertEqual((await getProduct(baseUrl, token, 11)).stock, 77, "Anular pendiente con modificador debe reponer stock base");
      assertEqual((await getProduct(baseUrl, token, componenteId)).stock, 27, "Anular pendiente debe reponer extra desde snapshot sin recalcular configuracion actual");

      const modificadorOtroProducto = await requestJson(baseUrl, "POST", `/productos/${componenteId}/modificadores`, {
        codigo: `etapa2b_otro_${suffix}`,
        nombre: "TEST Etapa 2B Otro Producto",
        tipo: "libre",
        precio_extra: 5
      }, token);
      if (!modificadorOtroProducto.response.ok) throw new Error(`Crear modificador otro producto etapa 2B fallo: ${modificadorOtroProducto.data?.message || modificadorOtroProducto.response.status}`);
      const pendienteModInvalido = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test",
        tipo: "pendiente",
        identificador_pendiente: `PEND-MOD-INVALIDO-${suffix}`,
        items: [{
          producto_id: 11,
          nombre_producto: "Coca Cola 1250",
          cantidad: 1,
          precio_unitario: 100,
          modificadores: [{ modificador_id: modificadorOtroProducto.data.modificador.id, cantidad: 1 }]
        }]
      }, token);
      assertEqual(pendienteModInvalido.response.status, 400, "Modificador no asociado debe fallar en pendiente");

      const inactivo = await requestJson(baseUrl, "POST", "/productos/11/modificadores", {
        codigo: `etapa2b_inactivo_${suffix}`,
        nombre: "TEST Etapa 2B Inactivo",
        tipo: "libre",
        precio_extra: 5
      }, token);
      if (!inactivo.response.ok) throw new Error(`Crear modificador inactivo etapa 2B fallo: ${inactivo.data?.message || inactivo.response.status}`);
      await runSql(dbPath, "UPDATE modificadores SET activo = 0 WHERE id = ?", [inactivo.data.modificador.id]);
      const pendienteInactivo = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test",
        tipo: "pendiente",
        identificador_pendiente: `PEND-INACTIVO-${suffix}`,
        items: [{
          producto_id: 11,
          nombre_producto: "Coca Cola 1250",
          cantidad: 1,
          precio_unitario: 100,
          modificadores: [{ modificador_id: inactivo.data.modificador.id, cantidad: 1 }]
        }]
      }, token);
      assertEqual(pendienteInactivo.response.status, 400, "Modificador inactivo debe fallar en pendiente");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testModificadoresEtapa2CEdicionPendientes() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const categoriaId = await crearCategoria(baseUrl, token, "TEST Mods Etapa 2C");
      const componenteAId = await crearProducto(baseUrl, token, {
        nombre: "TEST Componente A Etapa 2C",
        categoria: "TEST Mods Etapa 2C",
        categoria_id: categoriaId,
        stock: 50,
        precio_venta: 10
      });
      const componenteBId = await crearProducto(baseUrl, token, {
        nombre: "TEST Componente B Etapa 2C",
        categoria: "TEST Mods Etapa 2C",
        categoria_id: categoriaId,
        stock: 60,
        precio_venta: 10
      });
      const suffix = Date.now().toString().slice(-8);

      const modA = await requestJson(baseUrl, "POST", "/productos/11/modificadores", {
        codigo: `etapa2c_a_${suffix}`,
        nombre: "TEST Etapa 2C Agregar A",
        tipo: "agregar",
        precio_extra: 10,
        componentes: [{ producto_id: componenteAId, cantidad: 2 }]
      }, token);
      if (!modA.response.ok) throw new Error(`Crear modificador A etapa 2C fallo: ${modA.data?.message || modA.response.status}`);

      const modB = await requestJson(baseUrl, "POST", "/productos/11/modificadores", {
        codigo: `etapa2c_b_${suffix}`,
        nombre: "TEST Etapa 2C Agregar B",
        tipo: "agregar",
        precio_extra: 20,
        componentes: [{ producto_id: componenteBId, cantidad: 5 }]
      }, token);
      if (!modB.response.ok) throw new Error(`Crear modificador B etapa 2C fallo: ${modB.data?.message || modB.response.status}`);

      const pendienteSinMods = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo: "pendiente",
        identificador_pendiente: `PEND-2C-SIN-${suffix}`,
        tipo_cobro: undefined
      }), token);
      if (!pendienteSinMods.response.ok) throw new Error(`Crear pendiente sin mods etapa 2C fallo: ${pendienteSinMods.data?.message || pendienteSinMods.response.status}`);
      const editarSinMods = await requestJson(baseUrl, "PUT", `/ventas/${pendienteSinMods.data.venta_id}/pendiente`, {
        identificador_pendiente: `PEND-2C-SIN-EDIT-${suffix}`,
        items: [{ producto_id: 11, nombre_producto: "Coca Cola 1250", cantidad: 3, precio_unitario: 100 }]
      }, token);
      if (!editarSinMods.response.ok) throw new Error(`Editar pendiente sin mods fallo: ${editarSinMods.data?.message || editarSinMods.response.status}`);
      assertEqual((await getProduct(baseUrl, token, 11)).stock, 77, "Editar pendiente sin modificadores debe seguir aplicando diff de stock base");
      assertApprox(editarSinMods.data.total, 300, "Editar pendiente sin modificadores debe recalcular total normal");

      const pendienteCantidad = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test",
        tipo: "pendiente",
        identificador_pendiente: `PEND-2C-CANT-${suffix}`,
        items: [{
          producto_id: 11,
          nombre_producto: "Coca Cola 1250",
          cantidad: 1,
          precio_unitario: 100,
          modificadores: [{ modificador_id: modA.data.modificador.id, cantidad: 1 }]
        }]
      }, token);
      if (!pendienteCantidad.response.ok) throw new Error(`Crear pendiente cantidad etapa 2C fallo: ${pendienteCantidad.data?.message || pendienteCantidad.response.status}`);
      assertEqual((await getProduct(baseUrl, token, 11)).stock, 76, "Pendiente con mod A debe descontar base inicial");
      assertEqual((await getProduct(baseUrl, token, componenteAId)).stock, 48, "Pendiente con mod A debe descontar extra inicial");

      const detalleViejoCantidad = await getVentaDetalle(baseUrl, token, pendienteCantidad.data.venta_id);
      const detalleViejoId = detalleViejoCantidad.items[0].id;
      const editarCantidad = await requestJson(baseUrl, "PUT", `/ventas/${pendienteCantidad.data.venta_id}/pendiente`, {
        identificador_pendiente: `PEND-2C-CANT-EDIT-${suffix}`,
        items: [{
          producto_id: 11,
          nombre_producto: "Coca Cola 1250",
          cantidad: 2,
          precio_unitario: 100,
          modificadores: [{ modificador_id: modA.data.modificador.id, cantidad: 1 }]
        }]
      }, token);
      if (!editarCantidad.response.ok) throw new Error(`Editar pendiente cantidad etapa 2C fallo: ${editarCantidad.data?.message || editarCantidad.response.status}`);
      assertApprox(editarCantidad.data.total, 220, "Editar pendiente debe recalcular total final con modificador");
      assertEqual((await getProduct(baseUrl, token, 11)).stock, 75, "Editar cantidad debe aplicar diff base nuevo-viejo");
      assertEqual((await getProduct(baseUrl, token, componenteAId)).stock, 46, "Editar cantidad debe aplicar diff extra desde snapshots");
      const snapshotsViejosCantidad = await allSql(
        dbPath,
        "SELECT COUNT(*) AS total FROM detalle_venta_modificadores WHERE detalle_venta_id = ?",
        [detalleViejoId]
      );
      assertEqual(snapshotsViejosCantidad[0].total, 0, "Editar pendiente no debe dejar snapshots viejos de modificadores colgados");
      const componentesViejosCantidad = await allSql(
        dbPath,
        "SELECT COUNT(*) AS total FROM detalle_venta_componentes_snapshot WHERE detalle_venta_id = ?",
        [detalleViejoId]
      );
      assertEqual(componentesViejosCantidad[0].total, 0, "Editar pendiente no debe dejar snapshots viejos de componentes colgados");

      const editarQuitar = await requestJson(baseUrl, "PUT", `/ventas/${pendienteCantidad.data.venta_id}/pendiente`, {
        identificador_pendiente: `PEND-2C-QUITAR-${suffix}`,
        items: [{ producto_id: 11, nombre_producto: "Coca Cola 1250", cantidad: 2, precio_unitario: 100 }]
      }, token);
      if (!editarQuitar.response.ok) throw new Error(`Editar pendiente quitando modificador fallo: ${editarQuitar.data?.message || editarQuitar.response.status}`);
      assertApprox(editarQuitar.data.total, 200, "Quitar modificador debe recalcular total sin extra");
      assertEqual((await getProduct(baseUrl, token, 11)).stock, 75, "Quitar modificador no debe cambiar stock base si cantidad no cambia");
      assertEqual((await getProduct(baseUrl, token, componenteAId)).stock, 50, "Quitar modificador debe reponer extra final anterior");

      const pendienteAgregar = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test",
        tipo: "pendiente",
        identificador_pendiente: `PEND-2C-AGREGAR-${suffix}`,
        items: [{ producto_id: 11, nombre_producto: "Coca Cola 1250", cantidad: 1, precio_unitario: 100 }]
      }, token);
      if (!pendienteAgregar.response.ok) throw new Error(`Crear pendiente para agregar mod fallo: ${pendienteAgregar.data?.message || pendienteAgregar.response.status}`);
      const editarAgregar = await requestJson(baseUrl, "PUT", `/ventas/${pendienteAgregar.data.venta_id}/pendiente`, {
        identificador_pendiente: `PEND-2C-AGREGAR-EDIT-${suffix}`,
        items: [{
          producto_id: 11,
          nombre_producto: "Coca Cola 1250",
          cantidad: 1,
          precio_unitario: 100,
          modificadores: [{ modificador_id: modA.data.modificador.id, cantidad: 1 }]
        }]
      }, token);
      if (!editarAgregar.response.ok) throw new Error(`Editar pendiente agregando modificador fallo: ${editarAgregar.data?.message || editarAgregar.response.status}`);
      assertApprox(editarAgregar.data.total, 110, "Agregar modificador en edicion debe sumar precio extra");
      assertEqual((await getProduct(baseUrl, token, componenteAId)).stock, 48, "Agregar modificador en edicion debe descontar extra");

      const pendienteCambio = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test",
        tipo: "pendiente",
        identificador_pendiente: `PEND-2C-CAMBIO-${suffix}`,
        items: [{
          producto_id: 11,
          nombre_producto: "Coca Cola 1250",
          cantidad: 1,
          precio_unitario: 100,
          modificadores: [{ modificador_id: modA.data.modificador.id, cantidad: 1 }]
        }]
      }, token);
      if (!pendienteCambio.response.ok) throw new Error(`Crear pendiente cambio mod fallo: ${pendienteCambio.data?.message || pendienteCambio.response.status}`);
      const editarCambio = await requestJson(baseUrl, "PUT", `/ventas/${pendienteCambio.data.venta_id}/pendiente`, {
        identificador_pendiente: `PEND-2C-CAMBIO-EDIT-${suffix}`,
        items: [{
          producto_id: 11,
          nombre_producto: "Coca Cola 1250",
          cantidad: 1,
          precio_unitario: 100,
          modificadores: [{ modificador_id: modB.data.modificador.id, cantidad: 1 }]
        }]
      }, token);
      if (!editarCambio.response.ok) throw new Error(`Editar pendiente cambiando modificador fallo: ${editarCambio.data?.message || editarCambio.response.status}`);
      assertApprox(editarCambio.data.total, 120, "Cambiar modificador debe recalcular precio final");
      assertEqual((await getProduct(baseUrl, token, componenteAId)).stock, 48, "Cambiar A por B debe reponer extra A");
      assertEqual((await getProduct(baseUrl, token, componenteBId)).stock, 55, "Cambiar A por B debe descontar extra B");

      const stockBaseAntesCobrar = (await getProduct(baseUrl, token, 11)).stock;
      const stockAAntesCobrar = (await getProduct(baseUrl, token, componenteAId)).stock;
      const stockBAntesCobrar = (await getProduct(baseUrl, token, componenteBId)).stock;
      const cobrar = await requestJson(baseUrl, "POST", `/ventas/${pendienteCambio.data.venta_id}/cobrar`, { tipo_cobro: "efectivo" }, token);
      if (!cobrar.response.ok) throw new Error(`Cobrar pendiente editada fallo: ${cobrar.data?.message || cobrar.response.status}`);
      assertEqual((await getProduct(baseUrl, token, 11)).stock, stockBaseAntesCobrar, "Cobrar pendiente editada no debe descontar base otra vez");
      assertEqual((await getProduct(baseUrl, token, componenteAId)).stock, stockAAntesCobrar, "Cobrar pendiente editada no debe tocar extra A");
      assertEqual((await getProduct(baseUrl, token, componenteBId)).stock, stockBAntesCobrar, "Cobrar pendiente editada no debe tocar extra B");

      const pendienteAnular = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test",
        tipo: "pendiente",
        identificador_pendiente: `PEND-2C-ANULAR-${suffix}`,
        items: [{ producto_id: 11, nombre_producto: "Coca Cola 1250", cantidad: 1, precio_unitario: 100 }]
      }, token);
      if (!pendienteAnular.response.ok) throw new Error(`Crear pendiente anular etapa 2C fallo: ${pendienteAnular.data?.message || pendienteAnular.response.status}`);
      const editarAnular = await requestJson(baseUrl, "PUT", `/ventas/${pendienteAnular.data.venta_id}/pendiente`, {
        identificador_pendiente: `PEND-2C-ANULAR-EDIT-${suffix}`,
        items: [{
          producto_id: 11,
          nombre_producto: "Coca Cola 1250",
          cantidad: 2,
          precio_unitario: 100,
          modificadores: [{ modificador_id: modB.data.modificador.id, cantidad: 1 }]
        }]
      }, token);
      if (!editarAnular.response.ok) throw new Error(`Editar pendiente para anular fallo: ${editarAnular.data?.message || editarAnular.response.status}`);
      const stockBaseAntesAnular = (await getProduct(baseUrl, token, 11)).stock;
      const stockBAntesAnular = (await getProduct(baseUrl, token, componenteBId)).stock;
      const anular = await requestJson(baseUrl, "POST", `/ventas/${pendienteAnular.data.venta_id}/anular`, { authorization_code: "1234" }, token);
      if (!anular.response.ok) throw new Error(`Anular pendiente editada fallo: ${anular.data?.message || anular.response.status}`);
      assertEqual((await getProduct(baseUrl, token, 11)).stock, stockBaseAntesAnular + 2, "Anular pendiente editada debe reponer stock base final");
      assertEqual((await getProduct(baseUrl, token, componenteBId)).stock, stockBAntesAnular + 10, "Anular pendiente editada debe reponer extra final desde snapshot nuevo");

      const modificadorOtroProducto = await requestJson(baseUrl, "POST", `/productos/${componenteAId}/modificadores`, {
        codigo: `etapa2c_otro_${suffix}`,
        nombre: "TEST Etapa 2C Otro Producto",
        tipo: "libre",
        precio_extra: 5
      }, token);
      if (!modificadorOtroProducto.response.ok) throw new Error(`Crear modificador otro producto etapa 2C fallo: ${modificadorOtroProducto.data?.message || modificadorOtroProducto.response.status}`);
      const editarInvalido = await requestJson(baseUrl, "PUT", `/ventas/${pendienteAgregar.data.venta_id}/pendiente`, {
        identificador_pendiente: `PEND-2C-INVALIDO-${suffix}`,
        items: [{
          producto_id: 11,
          nombre_producto: "Coca Cola 1250",
          cantidad: 1,
          precio_unitario: 100,
          modificadores: [{ modificador_id: modificadorOtroProducto.data.modificador.id, cantidad: 1 }]
        }]
      }, token);
      assertEqual(editarInvalido.response.status, 400, "Editar pendiente con modificador no asociado debe fallar");

      const inactivo = await requestJson(baseUrl, "POST", "/productos/11/modificadores", {
        codigo: `etapa2c_inactivo_${suffix}`,
        nombre: "TEST Etapa 2C Inactivo",
        tipo: "libre",
        precio_extra: 5
      }, token);
      if (!inactivo.response.ok) throw new Error(`Crear modificador inactivo etapa 2C fallo: ${inactivo.data?.message || inactivo.response.status}`);
      await runSql(dbPath, "UPDATE modificadores SET activo = 0 WHERE id = ?", [inactivo.data.modificador.id]);
      const editarInactivo = await requestJson(baseUrl, "PUT", `/ventas/${pendienteAgregar.data.venta_id}/pendiente`, {
        identificador_pendiente: `PEND-2C-INACTIVO-${suffix}`,
        items: [{
          producto_id: 11,
          nombre_producto: "Coca Cola 1250",
          cantidad: 1,
          precio_unitario: 100,
          modificadores: [{ modificador_id: inactivo.data.modificador.id, cantidad: 1 }]
        }]
      }, token);
      assertEqual(editarInactivo.response.status, 400, "Editar pendiente con modificador inactivo debe fallar");

      const reporte = await requestJson(baseUrl, "GET", "/reportes/productos-mas-vendidos?limite=100", null, token);
      if (!reporte.response.ok) throw new Error(`Reporte productos mas vendidos etapa 2C fallo: ${reporte.data?.message || reporte.response.status}`);
      if (reporte.data.some((item) => String(item.nombre || "").includes("TEST Etapa 2C"))) {
        throw new Error(`Productos mas vendidos no debe mostrar modificadores en etapa 2C. Reporte=${JSON.stringify(reporte.data)}`);
      }
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testModificadoresApiEdicionActivacionYSnapshots() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      const suffix = Date.now().toString().slice(-8);
      const categoriaId = await crearCategoria(baseUrl, token, `TEST Mods API ${suffix}`);
      const productoId = await crearProducto(baseUrl, token, {
        nombre: `TEST Producto Mods API ${suffix}`,
        categoria: `TEST Mods API ${suffix}`,
        categoria_id: categoriaId,
        stock: 20,
        precio_venta: 8000
      });
      const componenteId = await crearProducto(baseUrl, token, {
        nombre: `TEST Queso Mods API ${suffix}`,
        categoria: `TEST Mods API ${suffix}`,
        categoria_id: categoriaId,
        stock: 50,
        precio_venta: 100
      });

      const extraQueso = await requestJson(baseUrl, "POST", `/productos/${productoId}/modificadores`, {
        codigo: `api_extra_${suffix}`,
        nombre: "Extra queso",
        tipo: "libre",
        precio_extra: 1000,
        activo: true
      }, token);
      if (!extraQueso.response.ok) throw new Error(`Crear modificador API fallo: ${extraQueso.data?.message || extraQueso.response.status}`);
      const modId = extraQueso.data.modificador.id;

      const editar = await requestJson(baseUrl, "PUT", `/modificadores/${modId}`, {
        nombre: "Extra muzzarella",
        tipo: "agregar",
        precio_extra: 1200,
        activo: false,
        componentes: [{ producto_id: componenteId, cantidad: 2 }]
      }, token);
      if (!editar.response.ok) throw new Error(`PUT /modificadores/:id fallo: ${editar.data?.message || editar.response.status}`);

      const todosPostPut = await requestJson(baseUrl, "GET", `/productos/${productoId}/modificadores?todos=1`, null, token);
      if (!todosPostPut.response.ok) throw new Error(`GET modificadores todos post PUT fallo: ${todosPostPut.data?.message || todosPostPut.response.status}`);
      const editado = todosPostPut.data.find((m) => Number(m.id) === Number(modId));
      if (!editado) throw new Error(`GET todos debe devolver modificador editado. Data=${JSON.stringify(todosPostPut.data)}`);
      if (String(editado.nombre) !== "Extra muzzarella") {
        throw new Error(`PUT debe actualizar nombre de modificador. Actual=${JSON.stringify(editado)}`);
      }
      if (String(editado.tipo) !== "agregar") {
        throw new Error(`PUT debe actualizar tipo de modificador. Actual=${JSON.stringify(editado)}`);
      }
      assertApprox(editado.precio_extra, 1200, "PUT debe actualizar precio_extra");
      assertEqual(Number(editado.activo), 0, "PUT debe permitir dejar modificador inactivo");
      assertEqual(editado.componentes.length, 1, "PUT tipo agregar debe guardar componente");
      assertEqual(Number(editado.componentes[0].producto_id), Number(componenteId), "PUT debe guardar componente correcto");
      assertApprox(editado.componentes[0].cantidad, 2, "PUT debe guardar cantidad de componente");

      const normalPostPut = await requestJson(baseUrl, "GET", `/productos/${productoId}/modificadores`, null, token);
      if (!normalPostPut.response.ok) throw new Error(`GET modificadores activos post PUT fallo: ${normalPostPut.data?.message || normalPostPut.response.status}`);
      if (normalPostPut.data.some((m) => Number(m.id) === Number(modId))) {
        throw new Error("GET normal debe ocultar modificador desactivado por PUT");
      }

      const toggle = await requestJson(baseUrl, "POST", `/productos/${productoId}/modificadores`, {
        codigo: `api_toggle_${suffix}`,
        nombre: "TEST Toggle Mod",
        tipo: "libre",
        precio_extra: 300,
        activo: true
      }, token);
      if (!toggle.response.ok) throw new Error(`Crear modificador toggle fallo: ${toggle.data?.message || toggle.response.status}`);
      const toggleId = toggle.data.modificador.id;

      const desactivar = await requestJson(baseUrl, "PATCH", `/modificadores/${toggleId}/activo`, { activo: false }, token);
      if (!desactivar.response.ok) throw new Error(`PATCH desactivar modificador fallo: ${desactivar.data?.message || desactivar.response.status}`);
      const activosSinToggle = await requestJson(baseUrl, "GET", `/productos/${productoId}/modificadores`, null, token);
      if (activosSinToggle.data.some((m) => Number(m.id) === Number(toggleId))) {
        throw new Error("GET normal no debe devolver modificador desactivado por PATCH");
      }
      const todosConToggleInactivo = await requestJson(baseUrl, "GET", `/productos/${productoId}/modificadores?todos=1`, null, token);
      const toggleInactivo = todosConToggleInactivo.data.find((m) => Number(m.id) === Number(toggleId));
      if (!toggleInactivo || Number(toggleInactivo.activo) !== 0) {
        throw new Error(`GET todos debe incluir modificador inactivo con activo=0. Data=${JSON.stringify(todosConToggleInactivo.data)}`);
      }

      const reactivar = await requestJson(baseUrl, "PATCH", `/modificadores/${toggleId}/activo`, { activo: true }, token);
      if (!reactivar.response.ok) throw new Error(`PATCH reactivar modificador fallo: ${reactivar.data?.message || reactivar.response.status}`);
      const activosConToggle = await requestJson(baseUrl, "GET", `/productos/${productoId}/modificadores`, null, token);
      if (!activosConToggle.data.some((m) => Number(m.id) === Number(toggleId))) {
        throw new Error("GET normal debe volver a devolver modificador reactivado");
      }

      const activo = await requestJson(baseUrl, "POST", `/productos/${productoId}/modificadores`, {
        codigo: `api_activo_${suffix}`,
        nombre: "TEST Activo Mod",
        tipo: "libre",
        precio_extra: 100,
        activo: true
      }, token);
      const inactivo = await requestJson(baseUrl, "POST", `/productos/${productoId}/modificadores`, {
        codigo: `api_inactivo_${suffix}`,
        nombre: "TEST Inactivo Mod",
        tipo: "libre",
        precio_extra: 100,
        activo: true
      }, token);
      if (!activo.response.ok || !inactivo.response.ok) {
        throw new Error(`Crear modificadores activo/inactivo fallo: ${activo.data?.message || inactivo.data?.message}`);
      }
      await requestJson(baseUrl, "PATCH", `/modificadores/${inactivo.data.modificador.id}/activo`, { activo: false }, token);
      const getNormal = await requestJson(baseUrl, "GET", `/productos/${productoId}/modificadores`, null, token);
      const getTodos = await requestJson(baseUrl, "GET", `/productos/${productoId}/modificadores?todos=1`, null, token);
      if (getNormal.data.some((m) => Number(m.id) === Number(inactivo.data.modificador.id))) {
        throw new Error("GET normal debe ocultar inactivos");
      }
      if (!getNormal.data.some((m) => Number(m.id) === Number(activo.data.modificador.id))) {
        throw new Error("GET normal debe incluir activos");
      }
      if (!getTodos.data.some((m) => Number(m.id) === Number(inactivo.data.modificador.id)) ||
          !getTodos.data.some((m) => Number(m.id) === Number(activo.data.modificador.id))) {
        throw new Error("GET todos debe incluir activos e inactivos");
      }

      for (const tipoNoPermitido of ["multiplicar", "reemplazar"]) {
        const updateNoPermitido = await requestJson(baseUrl, "PUT", `/modificadores/${activo.data.modificador.id}`, {
          nombre: `TEST ${tipoNoPermitido}`,
          tipo: tipoNoPermitido,
          precio_extra: 999,
          activo: true
        }, token);
        assertEqual(updateNoPermitido.response.status, 400, `PUT con tipo ${tipoNoPermitido} debe fallar controlado`);
        const todosLuegoError = await requestJson(baseUrl, "GET", `/productos/${productoId}/modificadores?todos=1`, null, token);
        const modLuegoError = todosLuegoError.data.find((m) => Number(m.id) === Number(activo.data.modificador.id));
        if (!modLuegoError || ["multiplicar", "reemplazar"].includes(String(modLuegoError.tipo))) {
          throw new Error(`Tipo no permitido no debe quedar persistido. Mod=${JSON.stringify(modLuegoError)}`);
        }
      }

      const historico = await requestJson(baseUrl, "POST", `/productos/${productoId}/modificadores`, {
        codigo: `api_hist_${suffix}`,
        nombre: "Extra historico viejo",
        tipo: "agregar",
        precio_extra: 500,
        activo: true,
        componentes: [{ producto_id: componenteId, cantidad: 3 }]
      }, token);
      if (!historico.response.ok) throw new Error(`Crear modificador historico fallo: ${historico.data?.message || historico.response.status}`);
      const historicoId = historico.data.modificador.id;

      const venta = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test",
        tipo: "normal",
        tipo_cobro: "efectivo",
        items: [{
          producto_id: productoId,
          nombre_producto: `TEST Producto Mods API ${suffix}`,
          cantidad: 1,
          precio_unitario: 8000,
          modificadores: [{ modificador_id: historicoId, cantidad: 1 }]
        }]
      }, token);
      if (!venta.response.ok) throw new Error(`Venta con modificador historico fallo: ${venta.data?.message || venta.response.status}`);
      assertApprox(venta.data.total, 8500, "Venta historica debe usar precio_extra original");
      assertEqual((await getProduct(baseUrl, token, componenteId)).stock, 47, "Venta historica debe descontar componente original");

      const detalle = await getVentaDetalle(baseUrl, token, venta.data.venta_id);
      const detalleId = detalle.items[0].id;
      const snapshotModAntes = await allSql(
        dbPath,
        "SELECT * FROM detalle_venta_modificadores WHERE detalle_venta_id = ?",
        [detalleId]
      );
      assertEqual(snapshotModAntes.length, 1, "Venta historica debe guardar snapshot de modificador");

      const editarHistorico = await requestJson(baseUrl, "PUT", `/modificadores/${historicoId}`, {
        nombre: "Extra historico nuevo",
        tipo: "agregar",
        precio_extra: 2500,
        activo: true,
        componentes: [{ producto_id: componenteId, cantidad: 9 }]
      }, token);
      if (!editarHistorico.response.ok) throw new Error(`Editar modificador historico fallo: ${editarHistorico.data?.message || editarHistorico.response.status}`);

      const snapshotModDespues = await allSql(
        dbPath,
        "SELECT * FROM detalle_venta_modificadores WHERE detalle_venta_id = ?",
        [detalleId]
      );
      if (String(snapshotModDespues[0].nombre) !== "Extra historico viejo") {
        throw new Error(`Snapshot debe conservar nombre viejo tras editar modificador. Actual=${JSON.stringify(snapshotModDespues[0])}`);
      }
      assertApprox(snapshotModDespues[0].precio_extra, 500, "Snapshot debe conservar precio viejo tras editar modificador");

      const snapshotCompDespues = await allSql(
        dbPath,
        "SELECT * FROM detalle_venta_componentes_snapshot WHERE detalle_venta_id = ?",
        [detalleId]
      );
      assertEqual(snapshotCompDespues.length, 1, "Venta historica debe conservar snapshot de componente");
      assertApprox(snapshotCompDespues[0].cantidad, 3, "Snapshot de componente debe conservar cantidad vieja tras editar modificador");

      const anular = await requestJson(baseUrl, "POST", `/ventas/${venta.data.venta_id}/anular-cobrada`, {
        authorization_code: "1234"
      }, token);
      if (!anular.response.ok) throw new Error(`Anular venta historica fallo: ${anular.data?.message || anular.response.status}`);
      assertEqual((await getProduct(baseUrl, token, componenteId)).stock, 50, "Anular debe reponer componente usando snapshot viejo, no configuracion editada");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testProveedoresPagosDevuelveClaves() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const proveedor = await crearProveedor(baseUrl, token);

      await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST claves endpoint proveedores",
        monto_total: 200,
        tipo_pago: "efectivo",
        estado: "registrado"
      });

      const { response, data } = await requestJson(baseUrl, "GET", "/reportes/proveedores-pagos", null, token);
      if (!response.ok) throw new Error(`GET /reportes/proveedores-pagos fallo: ${data?.message || response.status}`);
      // Nuevo contrato: objeto consolidado { filtros, resumen, proveedores, pagos, por_impacto }
      if (Array.isArray(data) || typeof data !== "object" || data === null) throw new Error("GET /reportes/proveedores-pagos debe devolver un objeto consolidado, no un array");
      for (const clave of ["filtros", "resumen", "proveedores", "pagos", "por_impacto"]) {
        if (!(clave in data)) throw new Error(`Respuesta debe tener clave '${clave}'. Keys=${JSON.stringify(Object.keys(data))}`);
      }
      for (const clave of ["proveedores_total", "pagos_periodo", "total_pagado", "total_pendiente", "iva_credito_fiscal", "compras_periodo"]) {
        if (!(clave in data.resumen)) throw new Error(`resumen debe tener clave '${clave}'. Keys=${JSON.stringify(Object.keys(data.resumen))}`);
      }
      if (!Array.isArray(data.proveedores)) throw new Error("data.proveedores debe ser un array");
      if (!data.proveedores.length) throw new Error("GET /reportes/proveedores-pagos debe devolver al menos un proveedor en data.proveedores");

      const item = data.proveedores[0];
      for (const clave of ["proveedor_id", "proveedor_nombre", "tipo_impacto", "total_pagado", "total_pendiente", "iva_credito_fiscal", "cantidad_pagos"]) {
        if (!(clave in item)) {
          throw new Error(`Cada proveedor debe tener clave '${clave}'. Item=${JSON.stringify(item)}`);
        }
      }
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testProveedoresPagosSumaTotalPagado() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const proveedor = await crearProveedor(baseUrl, token);

      await registrarPago(baseUrl, token, { proveedor_id: proveedor.id, concepto: "TEST pagado 1", monto_total: 300, tipo_pago: "efectivo", estado: "registrado" });
      await registrarPago(baseUrl, token, { proveedor_id: proveedor.id, concepto: "TEST pagado 2", monto_total: 200, tipo_pago: "efectivo", estado: "registrado" });
      await registrarPago(baseUrl, token, { proveedor_id: proveedor.id, concepto: "TEST pendiente no suma", monto_total: 100, tipo_pago: "efectivo", estado: "pendiente" });

      const { response, data } = await requestJson(baseUrl, "GET", "/reportes/proveedores-pagos", null, token);
      if (!response.ok) throw new Error(`GET /reportes/proveedores-pagos fallo: ${data?.message || response.status}`);

      const item = data.proveedores.find((d) => Number(d.proveedor_id) === Number(proveedor.id));
      if (!item) throw new Error("El proveedor debe aparecer en el reporte de proveedores");
      assertApprox(item.total_pagado, 500, "total_pagado debe sumar solo pagos registrados (300 + 200 = 500)");
      assertEqual(item.cantidad_pagos, 3, "cantidad_pagos debe contar todos los pagos del proveedor (registrados + pendientes)");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testProveedoresPagosSumaTotalPendiente() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const proveedor = await crearProveedor(baseUrl, token);

      await registrarPago(baseUrl, token, { proveedor_id: proveedor.id, concepto: "TEST registrado", monto_total: 300, tipo_pago: "efectivo", estado: "registrado" });
      await registrarPago(baseUrl, token, { proveedor_id: proveedor.id, concepto: "TEST pendiente 1", monto_total: 150, tipo_pago: "efectivo", estado: "pendiente" });
      await registrarPago(baseUrl, token, { proveedor_id: proveedor.id, concepto: "TEST pendiente 2", monto_total: 250, tipo_pago: "efectivo", estado: "pendiente" });

      const { response, data } = await requestJson(baseUrl, "GET", "/reportes/proveedores-pagos", null, token);
      if (!response.ok) throw new Error(`GET /reportes/proveedores-pagos fallo: ${data?.message || response.status}`);

      const item = data.proveedores.find((d) => Number(d.proveedor_id) === Number(proveedor.id));
      if (!item) throw new Error("El proveedor debe aparecer en el reporte de proveedores");
      assertApprox(item.total_pendiente, 400, "total_pendiente debe sumar solo pagos pendientes (150 + 250 = 400)");
      assertApprox(item.total_pagado, 300, "total_pagado no debe incluir pagos pendientes");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testProveedoresPagosCalculaIvaSoloRegistrados() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const proveedor = await crearProveedor(baseUrl, token, {
        condicion_iva: "responsable_inscripto",
        tipo_comprobante: "factura_a",
        iva_alicuota: 21
      });

      // Pago registrado: monto 1210 → IVA = 1210 × 21 / 121 ≈ 210
      const cuentaTransferencia = await crearCuentaCobro(baseUrl, token, {
        nombre: "TEST cuenta transferencia proveedor IVA",
        tipo_pago_codigo: "transferencia"
      });
      await registrarPago(baseUrl, token, { proveedor_id: proveedor.id, concepto: "TEST IVA registrado", monto_total: 1210, tipo_pago: "transferencia", estado: "registrado", cuenta_cobro_id: cuentaTransferencia.id });
      // Pago pendiente: servidor almacena iva_credito_fiscal = 0 para pendientes
      await registrarPago(baseUrl, token, { proveedor_id: proveedor.id, concepto: "TEST IVA pendiente", monto_total: 2420, tipo_pago: "efectivo", estado: "pendiente" });

      const { response, data } = await requestJson(baseUrl, "GET", "/reportes/proveedores-pagos", null, token);
      if (!response.ok) throw new Error(`GET /reportes/proveedores-pagos fallo: ${data?.message || response.status}`);

      const item = data.proveedores.find((d) => Number(d.proveedor_id) === Number(proveedor.id));
      if (!item) throw new Error("El proveedor debe aparecer en el reporte");
      assertApprox(item.iva_credito_fiscal, 210, "iva_credito_fiscal debe calcularse solo sobre pagos registrados", 1);
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testProveedoresPagosRespetaFiltroFechas() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const proveedor = await crearProveedor(baseUrl, token);

      await registrarPago(baseUrl, token, { proveedor_id: proveedor.id, concepto: "TEST filtro fecha proveedor", monto_total: 300, tipo_pago: "efectivo", estado: "registrado" });

      // Rango amplio: incluye el pago de hoy
      const { response: r1, data: d1 } = await requestJson(baseUrl, "GET", "/reportes/proveedores-pagos?desde=2000-01-01&hasta=2099-12-31", null, token);
      if (!r1.ok) throw new Error(`GET rango amplio fallo: ${d1?.message || r1.status}`);
      const itemAmplio = d1.proveedores.find((d) => Number(d.proveedor_id) === Number(proveedor.id));
      if (!itemAmplio) throw new Error("Rango amplio debe incluir el proveedor con pagos de hoy");
      assertApprox(itemAmplio.total_pagado, 300, "Rango amplio debe incluir el pago registrado");

      // Rango histórico sin datos: el proveedor aparece (LEFT JOIN desde proveedores) pero con total_pagado=0
      const { response: r2, data: d2 } = await requestJson(baseUrl, "GET", "/reportes/proveedores-pagos?desde=2010-01-01&hasta=2010-12-31", null, token);
      if (!r2.ok) throw new Error(`GET rango historico fallo: ${d2?.message || r2.status}`);
      const itemHistorico = d2.proveedores.find((d) => Number(d.proveedor_id) === Number(proveedor.id));
      if (itemHistorico && Number(itemHistorico.total_pagado) !== 0) throw new Error(`Rango historico debe tener total_pagado=0 para el proveedor. Actual=${itemHistorico.total_pagado}`);
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testProveedoresPagosSinProveedor() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      await registrarPago(baseUrl, token, {
        concepto: "TEST pago sin proveedor agrupado",
        monto_total: 150,
        tipo_pago: "efectivo",
        estado: "registrado"
      });

      const { response, data } = await requestJson(baseUrl, "GET", "/reportes/proveedores-pagos", null, token);
      if (!response.ok) throw new Error(`GET /reportes/proveedores-pagos fallo: ${data?.message || response.status}`);

      // Pagos sin proveedor_id aparecen en data.pagos (no en data.proveedores, que es FROM proveedores)
      const sinProveedorPago = data.pagos.find((p) => p.proveedor_nombre === "Sin proveedor");
      if (!sinProveedorPago) throw new Error(`Pagos sin proveedor deben aparecer en data.pagos. Nombres=${JSON.stringify(data.pagos.map((p) => p.proveedor_nombre))}`);
      assertApprox(sinProveedorPago.monto_total, 150, "El pago sin proveedor debe tener el monto correcto en data.pagos");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testTipoPagoCreaNuevo() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");

      const { response, data } = await requestJson(baseUrl, "POST", "/tipos_pago", {
        codigo: "cheque_test",
        nombre: "Cheque TEST",
        orden: 99
      }, token);
      if (!response.ok) throw new Error(`POST /tipos_pago fallo: ${data?.message || response.status}`);

      const { response: r2, data: todos } = await requestJson(baseUrl, "GET", "/tipos_pago?todos=1", null, token);
      if (!r2.ok) throw new Error(`GET /tipos_pago?todos=1 fallo: ${todos?.message || r2.status}`);
      const nuevo = todos.find((t) => t.codigo === "cheque_test");
      if (!nuevo) throw new Error("El tipo de pago creado debe aparecer en GET /tipos_pago?todos=1");
      if (nuevo.nombre !== "Cheque TEST") throw new Error(`Nombre inesperado tras POST: ${nuevo.nombre}`);
      assertEqual(nuevo.orden, 99, "El tipo de pago debe guardar el orden indicado");
      assertEqual(nuevo.activo, 1, "El tipo de pago recien creado debe quedar activo");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testTipoPagoNoDuplicaCodigo() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");

      const payload = { codigo: "duplicado_test", nombre: "Duplicado TEST", orden: 50 };

      const { response: r1, data: d1 } = await requestJson(baseUrl, "POST", "/tipos_pago", payload, token);
      if (!r1.ok) throw new Error(`Primer POST /tipos_pago fallo: ${d1?.message || r1.status}`);

      const { response: r2, data: d2 } = await requestJson(baseUrl, "POST", "/tipos_pago", payload, token);
      if (r2.ok) throw new Error("POST /tipos_pago con codigo duplicado debe fallar");
      assertEqual(r2.status, 400, "POST con codigo duplicado debe devolver 400");
      if (!d2?.message) throw new Error("POST duplicado debe devolver mensaje de error descriptivo");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testTipoPagoModificaNombreYOrden() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");

      await requestJson(baseUrl, "POST", "/tipos_pago", { codigo: "editar_test", nombre: "Editar TEST inicial", orden: 50 }, token);

      const { data: todos } = await requestJson(baseUrl, "GET", "/tipos_pago?todos=1", null, token);
      const tipo = todos.find((t) => t.codigo === "editar_test");
      if (!tipo) throw new Error("El tipo de pago debe existir antes de editarlo");

      const { response, data } = await requestJson(baseUrl, "PUT", `/tipos_pago/${tipo.id}`, {
        nombre: "Editar TEST modificado",
        orden: 77
      }, token);
      if (!response.ok) throw new Error(`PUT /tipos_pago/${tipo.id} fallo: ${data?.message || response.status}`);

      const { data: todosPost } = await requestJson(baseUrl, "GET", "/tipos_pago?todos=1", null, token);
      const actualizado = todosPost.find((t) => t.codigo === "editar_test");
      if (!actualizado) throw new Error("El tipo de pago debe seguir existiendo tras el PUT");
      if (actualizado.nombre !== "Editar TEST modificado") throw new Error(`Nombre no fue actualizado. Actual=${actualizado.nombre}`);
      assertEqual(actualizado.orden, 77, "El orden debe actualizarse correctamente con PUT");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testTiposPagoRecargosYCuotasCrud() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");

      const { response: getResponse, data: activos } = await requestJson(baseUrl, "GET", "/tipos_pago", null, token);
      if (!getResponse.ok) throw new Error(`GET /tipos_pago fallo: ${activos?.message || getResponse.status}`);
      const efectivo = activos.find((tipo) => tipo.codigo === "efectivo");
      if (!efectivo) throw new Error("GET /tipos_pago debe devolver efectivo");
      ["usa_recargo", "porcentaje_recargo", "permite_cuotas", "cuotas_json"].forEach((campo) => {
        if (!Object.prototype.hasOwnProperty.call(efectivo, campo)) throw new Error(`GET /tipos_pago debe incluir ${campo}`);
      });
      assertEqual(efectivo.usa_recargo, 0, "Efectivo default no debe usar recargo");
      assertEqual(efectivo.permite_cuotas, 0, "Efectivo default no debe permitir cuotas");

      await requestJson(baseUrl, "POST", "/tipos_pago", {
        codigo: "credito_recargo_test",
        nombre: "Credito recargo TEST",
        orden: 52
      }, token);

      const { data: todos } = await requestJson(baseUrl, "GET", "/tipos_pago?todos=1", null, token);
      const tipo = todos.find((item) => item.codigo === "credito_recargo_test");
      if (!tipo) throw new Error("El tipo credito_recargo_test debe existir antes del PUT");

      const cuotasArray = [{ cuotas: 3, recargo: 10 }, { cuotas: 6, recargo: 18 }];
      const { response: putResponse, data: putData } = await requestJson(baseUrl, "PUT", `/tipos_pago/${tipo.id}`, {
        nombre: "Credito recargo TEST editado",
        orden: 53,
        usa_recargo: true,
        porcentaje_recargo: 12.5,
        permite_cuotas: true,
        cuotas_json: cuotasArray
      }, token);
      if (!putResponse.ok) throw new Error(`PUT recargo/cuotas fallo: ${putData?.message || putResponse.status}`);

      const { data: todosPost } = await requestJson(baseUrl, "GET", "/tipos_pago?todos=1", null, token);
      const actualizado = todosPost.find((item) => item.codigo === "credito_recargo_test");
      if (actualizado.nombre !== "Credito recargo TEST editado") {
        throw new Error(`PUT debe mantener edicion de nombre. Actual=${actualizado.nombre}`);
      }
      assertEqual(actualizado.orden, 53, "PUT debe mantener edicion de orden");
      assertEqual(actualizado.usa_recargo, 1, "PUT debe actualizar usa_recargo");
      assertApprox(actualizado.porcentaje_recargo, 12.5, "PUT debe actualizar porcentaje_recargo");
      assertEqual(actualizado.permite_cuotas, 1, "PUT debe actualizar permite_cuotas");
      const cuotas = actualizado.cuotas_json;
      if (!Array.isArray(cuotas)) throw new Error("GET /tipos_pago?todos=1 debe devolver cuotas_json como array");
      assertEqual(cuotas.length, 2, "PUT debe guardar cuotas_json con varias cuotas");
      assertApprox(cuotas.find((item) => item.cuotas === 3).recargo, 10, "PUT debe guardar recargo de cuota 3");
      assertApprox(cuotas.find((item) => item.cuotas === 6).recargo, 18, "PUT debe guardar recargo de cuota 6");

      const dbRow = (await allSql(dbPath, "SELECT cuotas_json FROM tipos_pago WHERE id = ?", [tipo.id]))[0];
      if (typeof dbRow.cuotas_json !== "string") throw new Error("La DB debe guardar cuotas_json como string JSON");
      assertEqual(JSON.parse(dbRow.cuotas_json).length, 2, "La DB debe persistir todas las cuotas");

      const putNombre = await requestJson(baseUrl, "PUT", `/tipos_pago/${tipo.id}`, {
        nombre: "Credito recargo TEST retocado",
        orden: 54,
        usa_recargo: true,
        porcentaje_recargo: 12.5,
        permite_cuotas: true,
        cuotas_json: cuotas
      }, token);
      if (!putNombre.response.ok) throw new Error(`PUT posterior con cuotas existentes fallo: ${putNombre.data?.message || putNombre.response.status}`);

      const { data: todosRetocado } = await requestJson(baseUrl, "GET", "/tipos_pago?todos=1", null, token);
      const retocado = todosRetocado.find((item) => item.codigo === "credito_recargo_test");
      assertEqual(retocado.cuotas_json.length, 2, "PUT posterior no debe borrar cuotas si se envian existentes");
      assertApprox(retocado.cuotas_json.find((item) => item.cuotas === 6).recargo, 18, "PUT posterior debe conservar cuota 6");

      const segundoPost = await requestJson(baseUrl, "POST", "/tipos_pago", {
        codigo: "qr_cuotas_test",
        nombre: "QR cuotas TEST",
        orden: 55
      }, token);
      if (!segundoPost.response.ok) throw new Error(`POST segundo tipo fallo: ${segundoPost.data?.message || segundoPost.response.status}`);
      const { data: todosSegundo } = await requestJson(baseUrl, "GET", "/tipos_pago?todos=1", null, token);
      const segundo = todosSegundo.find((item) => item.codigo === "qr_cuotas_test");
      const putSegundo = await requestJson(baseUrl, "PUT", `/tipos_pago/${segundo.id}`, {
        nombre: "QR cuotas TEST",
        orden: 55,
        usa_recargo: true,
        porcentaje_recargo: 0,
        permite_cuotas: true,
        cuotas_json: [{ cuotas: 2, recargo: 5 }, { cuotas: 4, recargo: 9 }]
      }, token);
      if (!putSegundo.response.ok) throw new Error(`PUT segundo tipo cuotas fallo: ${putSegundo.data?.message || putSegundo.response.status}`);

      const apagar = await requestJson(baseUrl, "PUT", `/tipos_pago/${tipo.id}`, {
        nombre: "Credito recargo TEST sin cuotas",
        orden: 56,
        usa_recargo: true,
        porcentaje_recargo: 12.5,
        permite_cuotas: false,
        cuotas_json: cuotas
      }, token);
      if (!apagar.response.ok) throw new Error(`PUT permite_cuotas=false fallo: ${apagar.data?.message || apagar.response.status}`);

      const { data: todosFinal } = await requestJson(baseUrl, "GET", "/tipos_pago?todos=1", null, token);
      const apagado = todosFinal.find((item) => item.codigo === "credito_recargo_test");
      const segundoFinal = todosFinal.find((item) => item.codigo === "qr_cuotas_test");
      assertEqual(apagado.permite_cuotas, 0, "PUT permite_cuotas=false debe apagar cuotas");
      assertEqual(apagado.cuotas_json.length, 0, "PUT permite_cuotas=false debe devolver cuotas_json vacio");
      assertEqual(segundoFinal.cuotas_json.length, 2, "Varios metodos deben conservar cuotas independientes");
      assertApprox(segundoFinal.cuotas_json.find((item) => item.cuotas === 4).recargo, 9, "Segundo metodo debe conservar su cuota 4");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testVentasAplicanRecargosMetodosPago() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      await requestJson(baseUrl, "POST", "/tipos_pago", {
        codigo: "credito_general_test",
        nombre: "Credito general TEST",
        orden: 54,
        usa_recargo: true,
        porcentaje_recargo: 10
      }, token);
      const cuentaDebito = await crearCuentaCobro(baseUrl, token, {
        nombre: "Terminal debito recargo TEST",
        tipo_pago_codigo: "debito"
      });
      const cuentaCredito = await crearCuentaCobro(baseUrl, token, {
        nombre: "Terminal credito recargo TEST",
        tipo_pago_codigo: "credito_general_test"
      });

      const efectivo = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({ tipo_cobro: "efectivo" }), token);
      if (!efectivo.response.ok) throw new Error(`Venta efectivo sin recargo fallo: ${efectivo.data?.message || efectivo.response.status}`);
      assertApprox(efectivo.data.total, 200, "Venta efectivo sin recargo conserva total");

      const debito = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "debito",
        cuenta_cobro_id: cuentaDebito.id
      }), token);
      if (!debito.response.ok) throw new Error(`Venta debito sin recargo fallo: ${debito.data?.message || debito.response.status}`);
      assertApprox(debito.data.total, 200, "Venta debito sin recargo conserva total");

      const credito = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "credito_general_test",
        cuenta_cobro_id: cuentaCredito.id,
        recargo_porcentaje: 99,
        recargo_monto: 999
      }), token);
      if (!credito.response.ok) throw new Error(`Venta credito con recargo fallo: ${credito.data?.message || credito.response.status}`);
      assertApprox(credito.data.subtotal, 200, "Venta credito debe informar subtotal base");
      assertApprox(credito.data.recargo_monto, 20, "Venta credito debe recalcular recargo backend");
      assertApprox(credito.data.total, 220, "Venta credito con recargo aumenta total");

      const detalle = await getVentaDetalle(baseUrl, token, credito.data.venta_id);
      assertApprox(detalle.venta.total, 220, "Venta credito debe guardar total final con recargo");
      assertApprox(detalle.venta.monto_debito, 220, "Venta credito debe guardar monto digital por total final");
      assertApprox(detalle.items[0].subtotal, 200, "Detalle venta conserva subtotal de productos sin duplicar recargo");

      const anulacion = await requestJson(baseUrl, "POST", `/ventas/${credito.data.venta_id}/anular-cobrada`, {
        authorization_code: "1234"
      }, token);
      if (!anulacion.response.ok) throw new Error(`Anulacion de venta con recargo fallo: ${anulacion.data?.message || anulacion.response.status}`);
      assertEqual((await getProduct(baseUrl, token, 11)).stock, 76, "Anulacion de venta con recargo debe reponer stock sin romper caja");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testRecargoPersistenteEnVentas() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 0);

      await requestJson(baseUrl, "POST", "/tipos_pago", {
        codigo: "credito_persist_test",
        nombre: "Credito persistencia TEST",
        orden: 57,
        usa_recargo: true,
        porcentaje_recargo: 10
      }, token);
      const cuentaCredito = await crearCuentaCobro(baseUrl, token, {
        nombre: "Terminal persist TEST",
        tipo_pago_codigo: "credito_persist_test"
      });

      // Test 1: venta efectivo sin recargo guarda 0/0
      const ventaEfectivo = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({ tipo_cobro: "efectivo" }), token);
      if (!ventaEfectivo.response.ok) throw new Error(`Venta efectivo persist fallo: ${ventaEfectivo.data?.message}`);
      const detalleEfectivo = await getVentaDetalle(baseUrl, token, ventaEfectivo.data.venta_id);
      assertApprox(detalleEfectivo.venta.recargo_porcentaje, 0, "persist: venta efectivo guarda recargo_porcentaje=0");
      assertApprox(detalleEfectivo.venta.recargo_monto, 0, "persist: venta efectivo guarda recargo_monto=0");
      assertApprox(detalleEfectivo.venta.total, 200, "persist: total efectivo no cambia");

      // Test 2: venta con recargo guarda porcentaje y monto
      const ventaCredito = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "credito_persist_test",
        cuenta_cobro_id: cuentaCredito.id
      }), token);
      if (!ventaCredito.response.ok) throw new Error(`Venta credito persist fallo: ${ventaCredito.data?.message}`);
      const detalleCredito = await getVentaDetalle(baseUrl, token, ventaCredito.data.venta_id);
      assertApprox(detalleCredito.venta.recargo_porcentaje, 10, "persist: venta credito guarda recargo_porcentaje=10");
      assertApprox(detalleCredito.venta.recargo_monto, 20, "persist: venta credito guarda recargo_monto=20");
      assertApprox(detalleCredito.venta.total, 220, "persist: total credito incluye recargo");

      // Test 3: pendiente se crea sin recargo
      const pendiente = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo: "pendiente",
        identificador_pendiente: "Mesa persist TEST"
      }), token);
      if (!pendiente.response.ok) throw new Error(`Pendiente persist fallo: ${pendiente.data?.message}`);
      const detallePend = await getVentaDetalle(baseUrl, token, pendiente.data.venta_id);
      assertApprox(detallePend.venta.recargo_porcentaje, 0, "persist: pendiente sin recargo hasta cobrar");
      assertApprox(detallePend.venta.recargo_monto, 0, "persist: pendiente monto_recargo=0 hasta cobrar");

      // Test 4: cobrar pendiente guarda recargo en ese momento
      await requestJson(baseUrl, "POST", `/ventas/${pendiente.data.venta_id}/cobrar`, {
        tipo_cobro: "credito_persist_test",
        cuenta_cobro_id: cuentaCredito.id
      }, token);
      const detalleCobrado = await getVentaDetalle(baseUrl, token, pendiente.data.venta_id);
      assertApprox(detalleCobrado.venta.recargo_porcentaje, 10, "persist: cobrar pendiente guarda recargo_porcentaje");
      assertApprox(detalleCobrado.venta.recargo_monto, 20, "persist: cobrar pendiente guarda recargo_monto=20");
      assertApprox(detalleCobrado.venta.total, 220, "persist: total cobrado incluye recargo");

      // Test 5: recargo no se duplica — total es subtotal + recargo una sola vez
      assertApprox(detalleCobrado.venta.total, 200 + detalleCobrado.venta.recargo_monto, "persist: total = subtotal + recargo_monto sin duplicar");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testVentasCuotasYPendientesNoDuplicanRecargo() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      await requestJson(baseUrl, "POST", "/tipos_pago", {
        codigo: "credito_cuotas_test",
        nombre: "Credito cuotas TEST",
        orden: 55,
        usa_recargo: true,
        porcentaje_recargo: 5,
        permite_cuotas: true,
        cuotas_json: JSON.stringify([{ cuotas: 1, recargo: 0 }, { cuotas: 3, recargo: 10 }, { cuotas: 6, recargo: 18 }])
      }, token);

      await requestJson(baseUrl, "POST", "/tipos_pago", {
        codigo: "credito_sin_cuotas_test",
        nombre: "Credito sin cuotas TEST",
        orden: 56,
        usa_recargo: true,
        porcentaje_recargo: 7,
        permite_cuotas: false,
        cuotas_json: JSON.stringify([{ cuotas: 6, recargo: 30 }])
      }, token);
      const cuentaCreditoCuotas = await crearCuentaCobro(baseUrl, token, {
        nombre: "Terminal credito cuotas TEST",
        tipo_pago_codigo: "credito_cuotas_test"
      });
      const cuentaCreditoSinCuotas = await crearCuentaCobro(baseUrl, token, {
        nombre: "Terminal credito sin cuotas TEST",
        tipo_pago_codigo: "credito_sin_cuotas_test"
      });

      const ventaCuotas = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "credito_cuotas_test",
        cuenta_cobro_id: cuentaCreditoCuotas.id,
        cuotas: 3
      }), token);
      if (!ventaCuotas.response.ok) throw new Error(`Venta credito cuotas fallo: ${ventaCuotas.data?.message || ventaCuotas.response.status}`);
      assertApprox(ventaCuotas.data.recargo_monto, 20, "Venta credito con cuotas debe aplicar recargo de la cuota");
      assertApprox(ventaCuotas.data.total, 220, "Venta credito con 3 cuotas debe totalizar 220");

      const ventaSinCuotas = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "credito_sin_cuotas_test",
        cuenta_cobro_id: cuentaCreditoSinCuotas.id,
        cuotas: 6
      }), token);
      if (!ventaSinCuotas.response.ok) throw new Error(`Venta tipo sin cuotas fallo: ${ventaSinCuotas.data?.message || ventaSinCuotas.response.status}`);
      assertApprox(ventaSinCuotas.data.recargo_monto, 14, "Tipo sin cuotas debe ignorar cuotas enviadas y usar recargo general");
      assertApprox(ventaSinCuotas.data.total, 214, "Tipo sin cuotas debe aplicar solo recargo general");

      const pendiente = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo: "pendiente",
        identificador_pendiente: "Mesa recargo TEST",
        tipo_cobro: undefined
      }), token);
      if (!pendiente.response.ok) throw new Error(`Pendiente con recargo fallo: ${pendiente.data?.message || pendiente.response.status}`);
      assertApprox(pendiente.data.total, 200, "Pendiente debe guardarse sin recargo hasta cobrar");

      const cobro = await requestJson(baseUrl, "POST", `/ventas/${pendiente.data.venta_id}/cobrar`, {
        tipo_cobro: "credito_cuotas_test",
        cuenta_cobro_id: cuentaCreditoCuotas.id,
        cuotas: 3
      }, token);
      if (!cobro.response.ok) throw new Error(`Cobro pendiente con recargo fallo: ${cobro.data?.message || cobro.response.status}`);

      const detallePendiente = await getVentaDetalle(baseUrl, token, pendiente.data.venta_id);
      assertApprox(detallePendiente.venta.total, 220, "Cobrar pendiente con cuotas aplica recargo una sola vez");
      assertApprox(detallePendiente.venta.monto_debito, 220, "Cobrar pendiente con cuotas registra monto final");
      assertEqual((await getProduct(baseUrl, token, 11)).stock, 74, "Cobrar pendiente con recargo no descuenta stock nuevamente");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testTipoPagoDesactiva() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");

      await requestJson(baseUrl, "POST", "/tipos_pago", { codigo: "desactivar_test", nombre: "Desactivar TEST", orden: 50 }, token);

      const { data: todos } = await requestJson(baseUrl, "GET", "/tipos_pago?todos=1", null, token);
      const tipo = todos.find((t) => t.codigo === "desactivar_test");
      if (!tipo) throw new Error("El tipo de pago debe existir para desactivarlo");

      const { response, data } = await requestJson(baseUrl, "PATCH", `/tipos_pago/${tipo.id}/activo`, { activo: false }, token);
      if (!response.ok) throw new Error(`PATCH activo=false fallo: ${data?.message || response.status}`);

      const { data: todosPost } = await requestJson(baseUrl, "GET", "/tipos_pago?todos=1", null, token);
      const desactivado = todosPost.find((t) => t.codigo === "desactivar_test");
      if (!desactivado) throw new Error("El tipo desactivado debe seguir en GET ?todos=1");
      assertEqual(desactivado.activo, 0, "El tipo desactivado debe tener activo=0");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testTipoPagoReactiva() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");

      await requestJson(baseUrl, "POST", "/tipos_pago", { codigo: "reactivar_test", nombre: "Reactivar TEST", orden: 50 }, token);

      const { data: todos } = await requestJson(baseUrl, "GET", "/tipos_pago?todos=1", null, token);
      const tipo = todos.find((t) => t.codigo === "reactivar_test");
      if (!tipo) throw new Error("El tipo de pago debe existir para reactivarlo");

      await requestJson(baseUrl, "PATCH", `/tipos_pago/${tipo.id}/activo`, { activo: false }, token);

      const { response, data } = await requestJson(baseUrl, "PATCH", `/tipos_pago/${tipo.id}/activo`, { activo: true }, token);
      if (!response.ok) throw new Error(`PATCH activo=true fallo: ${data?.message || response.status}`);

      const { data: todosPost } = await requestJson(baseUrl, "GET", "/tipos_pago?todos=1", null, token);
      const reactivado = todosPost.find((t) => t.codigo === "reactivar_test");
      if (!reactivado) throw new Error("El tipo reactivado debe aparecer en GET ?todos=1");
      assertEqual(reactivado.activo, 1, "El tipo reactivado debe tener activo=1");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testTipoPagoGetExcluyeInactivos() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");

      await requestJson(baseUrl, "POST", "/tipos_pago", { codigo: "excluir_inactivo_test", nombre: "Excluir inactivo TEST", orden: 50 }, token);

      const { data: todos } = await requestJson(baseUrl, "GET", "/tipos_pago?todos=1", null, token);
      const tipo = todos.find((t) => t.codigo === "excluir_inactivo_test");
      if (!tipo) throw new Error("El tipo de pago debe existir antes de desactivarlo");

      await requestJson(baseUrl, "PATCH", `/tipos_pago/${tipo.id}/activo`, { activo: false }, token);

      const { response, data: activos } = await requestJson(baseUrl, "GET", "/tipos_pago", null, token);
      if (!response.ok) throw new Error(`GET /tipos_pago fallo: ${activos?.message || response.status}`);
      const encontrado = activos.find((t) => t.codigo === "excluir_inactivo_test");
      if (encontrado) throw new Error("GET /tipos_pago sin ?todos=1 no debe devolver tipos inactivos");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testTipoPagoGetTodosIncluyeInactivos() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");

      await requestJson(baseUrl, "POST", "/tipos_pago", { codigo: "incluir_inactivo_test", nombre: "Incluir inactivo TEST", orden: 50 }, token);

      const { data: todos } = await requestJson(baseUrl, "GET", "/tipos_pago?todos=1", null, token);
      const tipo = todos.find((t) => t.codigo === "incluir_inactivo_test");
      if (!tipo) throw new Error("El tipo de pago debe existir antes de desactivarlo");

      await requestJson(baseUrl, "PATCH", `/tipos_pago/${tipo.id}/activo`, { activo: false }, token);

      const { response, data: todosPost } = await requestJson(baseUrl, "GET", "/tipos_pago?todos=1", null, token);
      if (!response.ok) throw new Error(`GET /tipos_pago?todos=1 fallo: ${response.status}`);
      const inactivo = todosPost.find((t) => t.codigo === "incluir_inactivo_test");
      if (!inactivo) throw new Error("GET /tipos_pago?todos=1 debe incluir tipos inactivos");
      assertEqual(inactivo.activo, 0, "El tipo inactivo debe tener activo=0 en GET ?todos=1");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testCuentasCobroEtapa2PagosYVentas() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      const cuentaEfectivo1 = await crearCuentaCobro(baseUrl, token, {
        nombre: "Caja mostrador TEST",
        tipo_pago_codigo: "efectivo",
        orden: 10
      });
      const cuentaEfectivo2 = await crearCuentaCobro(baseUrl, token, {
        nombre: "Caja salon TEST",
        tipo_pago_codigo: "efectivo",
        orden: 20
      });
      const cuentaDebito = await crearCuentaCobro(baseUrl, token, {
        nombre: "Terminal debito TEST",
        tipo_pago_codigo: "debito",
        orden: 30,
        terminal_id: "TERM-TEST"
      });
      const cuentaTransferencia = await crearCuentaCobro(baseUrl, token, {
        nombre: "Banco transferencia TEST",
        tipo_pago_codigo: "transferencia",
        orden: 31
      });
      await requestJson(baseUrl, "POST", "/tipos_pago", { codigo: "credito_digital_test", nombre: "Credito digital TEST", orden: 32 }, token);
      await requestJson(baseUrl, "POST", "/tipos_pago", { codigo: "qr_digital_test", nombre: "QR digital TEST", orden: 33 }, token);
      await requestJson(baseUrl, "POST", "/tipos_pago", { codigo: "billetera_digital_test", nombre: "Billetera digital TEST", orden: 34 }, token);
      const cuentaCredito = await crearCuentaCobro(baseUrl, token, {
        nombre: "Terminal credito TEST",
        tipo_pago_codigo: "credito_digital_test",
        orden: 35
      });
      const cuentaQr = await crearCuentaCobro(baseUrl, token, {
        nombre: "QR TEST",
        tipo_pago_codigo: "qr_digital_test",
        orden: 36
      });
      const cuentaBilletera = await crearCuentaCobro(baseUrl, token, {
        nombre: "Billetera TEST",
        tipo_pago_codigo: "billetera_digital_test",
        orden: 37
      });
      const cuentaDebitoInactiva = await crearCuentaCobro(baseUrl, token, {
        nombre: "Terminal debito inactiva TEST",
        tipo_pago_codigo: "debito",
        orden: 38
      });
      await requestJson(baseUrl, "PATCH", `/cuentas_cobro/${cuentaDebitoInactiva.id}/activo`, { activo: false }, token);

      const { response: cuentasResponse, data: cuentasEfectivo } = await requestJson(baseUrl, "GET", "/cuentas_cobro/tipo/efectivo", null, token);
      if (!cuentasResponse.ok) throw new Error(`GET /cuentas_cobro/tipo/efectivo fallo: ${cuentasEfectivo?.message || cuentasResponse.status}`);
      const cuentasEfectivoIds = cuentasEfectivo.map((cuenta) => Number(cuenta.id));
      if (!cuentasEfectivoIds.includes(Number(cuentaEfectivo1.id)) || !cuentasEfectivoIds.includes(Number(cuentaEfectivo2.id))) {
        throw new Error("Debe permitir varias cuentas_cobro para el mismo tipo_pago efectivo");
      }

      const proveedor = await crearProveedor(baseUrl, token);
      const pagoValido = await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST pago con cuenta cobro",
        monto_total: 120,
        tipo_pago: "efectivo",
        estado: "registrado",
        cuenta_cobro_id: cuentaEfectivo1.id
      });
      assertEqual(pagoValido.cuenta_cobro_id, cuentaEfectivo1.id, "Pago con cuenta_cobro_id valida debe quedar guardado");

      const pagoTipoIncorrecto = await requestJson(baseUrl, "POST", "/pagos", {
        proveedor_id: proveedor.id,
        concepto: "TEST pago cuenta tipo incorrecto",
        monto_total: 90,
        tipo_pago: "efectivo",
        estado: "registrado",
        cuenta_cobro_id: cuentaDebito.id
      }, token);
      if (pagoTipoIncorrecto.response.ok) throw new Error("Pago con cuenta_cobro_id de otro tipo_pago debe fallar");
      assertEqual(pagoTipoIncorrecto.response.status, 400, "Pago con cuenta_cobro_id de otro tipo_pago debe devolver 400");

      const pagoLegacy = await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST pago sin cuenta cobro",
        monto_total: 70,
        tipo_pago: "efectivo",
        estado: "registrado",
        cuenta_cobro_id: null
      });
      assertEqual(pagoLegacy.cuenta_cobro_id || 0, 0, "Pago con cuenta_cobro_id null debe seguir funcionando");

      const pagoDebitoSinCuenta = await requestJson(baseUrl, "POST", "/pagos", {
        proveedor_id: proveedor.id,
        concepto: "TEST pago debito sin cuenta",
        monto_total: 75,
        tipo_pago: "debito",
        estado: "registrado",
        cuenta_cobro_id: null
      }, token);
      if (pagoDebitoSinCuenta.response.ok) throw new Error("Pago debito sin cuenta_cobro_id debe fallar");
      assertEqual(pagoDebitoSinCuenta.response.status, 400, "Pago debito sin cuenta debe devolver 400");

      const pagoTransferenciaSinCuenta = await requestJson(baseUrl, "POST", "/pagos", {
        proveedor_id: proveedor.id,
        concepto: "TEST pago transferencia sin cuenta",
        monto_total: 80,
        tipo_pago: "transferencia",
        estado: "registrado",
        cuenta_cobro_id: null
      }, token);
      if (pagoTransferenciaSinCuenta.response.ok) throw new Error("Pago transferencia sin cuenta_cobro_id debe fallar");
      assertEqual(pagoTransferenciaSinCuenta.response.status, 400, "Pago transferencia sin cuenta debe devolver 400");

      const pagoCreditoSinCuenta = await requestJson(baseUrl, "POST", "/pagos", {
        proveedor_id: proveedor.id,
        concepto: "TEST pago credito sin cuenta",
        monto_total: 85,
        tipo_pago: "credito_digital_test",
        estado: "registrado",
        cuenta_cobro_id: null
      }, token);
      if (pagoCreditoSinCuenta.response.ok) throw new Error("Pago credito digital sin cuenta_cobro_id debe fallar");
      assertEqual(pagoCreditoSinCuenta.response.status, 400, "Pago credito digital sin cuenta debe devolver 400");

      const pagoDigitalConCuenta = await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST pago debito con cuenta",
        monto_total: 95,
        tipo_pago: "debito",
        estado: "registrado",
        cuenta_cobro_id: cuentaDebito.id
      });
      assertEqual(pagoDigitalConCuenta.cuenta_cobro_id, cuentaDebito.id, "Pago digital con cuenta valida debe quedar guardado");

      const pagoDigitalCuentaInactiva = await requestJson(baseUrl, "POST", "/pagos", {
        proveedor_id: proveedor.id,
        concepto: "TEST pago debito cuenta inactiva",
        monto_total: 65,
        tipo_pago: "debito",
        estado: "registrado",
        cuenta_cobro_id: cuentaDebitoInactiva.id
      }, token);
      if (pagoDigitalCuentaInactiva.response.ok) throw new Error("Pago digital con cuenta inactiva debe fallar");
      assertEqual(pagoDigitalCuentaInactiva.response.status, 400, "Pago digital con cuenta inactiva debe devolver 400");

      const pagoMixtoSinCuenta = await requestJson(baseUrl, "POST", "/pagos", {
        proveedor_id: proveedor.id,
        concepto: "TEST pago mixto sin cuenta",
        monto_total: 100,
        tipo_pago: "mixto",
        monto_efectivo: 40,
        monto_debito: 60,
        estado: "registrado",
        cuenta_cobro_id: null
      }, token);
      if (pagoMixtoSinCuenta.response.ok) throw new Error("Pago mixto con parte digital sin cuenta_cobro_id debe fallar");
      assertEqual(pagoMixtoSinCuenta.response.status, 400, "Pago mixto sin cuenta debe devolver 400");

      const ventaValida = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "debito",
        cuenta_cobro_id: cuentaDebito.id
      }), token);
      if (!ventaValida.response.ok) throw new Error(`Venta con cuenta_cobro_id valida fallo: ${ventaValida.data?.message || ventaValida.response.status}`);
      const detalleVentaValida = await getVentaDetalle(baseUrl, token, ventaValida.data.venta_id);
      assertEqual(detalleVentaValida.venta.cuenta_cobro_id, cuentaDebito.id, "Venta con cuenta_cobro_id valida debe quedar guardada");

      const ventaDebitoSinCuenta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "debito",
        cuenta_cobro_id: null
      }), token);
      if (ventaDebitoSinCuenta.response.ok) throw new Error("Venta debito sin cuenta_cobro_id debe fallar");
      assertEqual(ventaDebitoSinCuenta.response.status, 400, "Venta debito sin cuenta debe devolver 400");

      const ventaTransferenciaSinCuenta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "transferencia",
        cuenta_cobro_id: null
      }), token);
      if (ventaTransferenciaSinCuenta.response.ok) throw new Error("Venta transferencia sin cuenta_cobro_id debe fallar");
      assertEqual(ventaTransferenciaSinCuenta.response.status, 400, "Venta transferencia sin cuenta debe devolver 400");

      const ventaCreditoSinCuenta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "credito_digital_test",
        cuenta_cobro_id: null
      }), token);
      if (ventaCreditoSinCuenta.response.ok) throw new Error("Venta credito sin cuenta_cobro_id debe fallar");
      assertEqual(ventaCreditoSinCuenta.response.status, 400, "Venta credito sin cuenta debe devolver 400");

      const ventaQrSinCuenta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "qr_digital_test",
        cuenta_cobro_id: null
      }), token);
      if (ventaQrSinCuenta.response.ok) throw new Error("Venta QR sin cuenta_cobro_id debe fallar");
      assertEqual(ventaQrSinCuenta.response.status, 400, "Venta QR sin cuenta debe devolver 400");

      const ventaBilleteraSinCuenta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "billetera_digital_test",
        cuenta_cobro_id: null
      }), token);
      if (ventaBilleteraSinCuenta.response.ok) throw new Error("Venta billetera sin cuenta_cobro_id debe fallar");
      assertEqual(ventaBilleteraSinCuenta.response.status, 400, "Venta billetera sin cuenta debe devolver 400");

      const ventaCreditoConCuenta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "credito_digital_test",
        cuenta_cobro_id: cuentaCredito.id
      }), token);
      if (!ventaCreditoConCuenta.response.ok) throw new Error(`Venta credito con cuenta valida fallo: ${ventaCreditoConCuenta.data?.message || ventaCreditoConCuenta.response.status}`);

      const ventaTransferenciaConCuenta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "transferencia",
        cuenta_cobro_id: cuentaTransferencia.id
      }), token);
      if (!ventaTransferenciaConCuenta.response.ok) throw new Error(`Venta transferencia con cuenta valida fallo: ${ventaTransferenciaConCuenta.data?.message || ventaTransferenciaConCuenta.response.status}`);

      const ventaQrConCuenta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "qr_digital_test",
        cuenta_cobro_id: cuentaQr.id
      }), token);
      if (!ventaQrConCuenta.response.ok) throw new Error(`Venta QR con cuenta valida fallo: ${ventaQrConCuenta.data?.message || ventaQrConCuenta.response.status}`);

      const ventaBilleteraConCuenta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "billetera_digital_test",
        cuenta_cobro_id: cuentaBilletera.id
      }), token);
      if (!ventaBilleteraConCuenta.response.ok) throw new Error(`Venta billetera con cuenta valida fallo: ${ventaBilleteraConCuenta.data?.message || ventaBilleteraConCuenta.response.status}`);

      const ventaDebitoCuentaInactiva = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "debito",
        cuenta_cobro_id: cuentaDebitoInactiva.id
      }), token);
      if (ventaDebitoCuentaInactiva.response.ok) throw new Error("Venta digital con cuenta inactiva debe fallar");
      assertEqual(ventaDebitoCuentaInactiva.response.status, 400, "Venta digital con cuenta inactiva debe devolver 400");

      const ventaMixtaSinCuenta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "mixto",
        monto_efectivo: 80,
        monto_debito: 120,
        cuenta_cobro_id: null
      }), token);
      if (ventaMixtaSinCuenta.response.ok) throw new Error("Venta mixta con parte digital sin cuenta debe fallar");
      assertEqual(ventaMixtaSinCuenta.response.status, 400, "Venta mixta digital sin cuenta debe devolver 400");

      const ventaMixtaConCuenta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "mixto",
        monto_efectivo: 80,
        monto_debito: 120,
        cuenta_cobro_id: cuentaDebito.id
      }), token);
      if (!ventaMixtaConCuenta.response.ok) throw new Error(`Venta mixta con cuenta valida fallo: ${ventaMixtaConCuenta.data?.message || ventaMixtaConCuenta.response.status}`);

      const ventaTipoIncorrecto = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "efectivo",
        cuenta_cobro_id: cuentaDebito.id
      }), token);
      if (ventaTipoIncorrecto.response.ok) throw new Error("Venta con cuenta_cobro_id de otro tipo_cobro debe fallar");
      assertEqual(ventaTipoIncorrecto.response.status, 400, "Venta con cuenta_cobro_id de otro tipo_cobro debe devolver 400");

      const ventaLegacy = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "efectivo",
        cuenta_cobro_id: null
      }), token);
      if (!ventaLegacy.response.ok) throw new Error(`Venta con cuenta_cobro_id null fallo: ${ventaLegacy.data?.message || ventaLegacy.response.status}`);
      const detalleVentaLegacy = await getVentaDetalle(baseUrl, token, ventaLegacy.data.venta_id);
      assertEqual(detalleVentaLegacy.venta.cuenta_cobro_id || 0, 0, "Venta con cuenta_cobro_id null debe seguir funcionando");

      const cliente = await requestJson(baseUrl, "POST", "/clientes", {
        nombre: "Cliente CC cuenta cobro TEST",
        dni_cuit: "20999999123",
        telefono: "111",
        habilita_cuenta_corriente: true
      }, token);
      if (!cliente.response.ok) throw new Error(`No se pudo crear cliente CC: ${cliente.data?.message || cliente.response.status}`);
      const ventaCuentaCorriente = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        es_cuenta_corriente: true,
        cliente_id: cliente.data.cliente.id,
        tipo_cobro: undefined,
        cuenta_cobro_id: null
      }), token);
      if (!ventaCuentaCorriente.response.ok) throw new Error(`Venta cuenta corriente sin cuenta fallo: ${ventaCuentaCorriente.data?.message || ventaCuentaCorriente.response.status}`);
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testConfiguracionCuentasCobroValidacionesOperativas() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const destinoDigital = await crearCuentaDestino(baseUrl, token, {
        nombre: "TEST destino digital validacion",
        tipo_destino: "billetera"
      });
      const destinoInactivo = await crearCuentaDestino(baseUrl, token, {
        nombre: "TEST destino inactivo validacion",
        tipo_destino: "banco"
      });
      await requestJson(baseUrl, "PATCH", `/cuentas_destino/${destinoInactivo.id}/activo`, { activo: false }, token);

      const digitalSinDestino = await requestJson(baseUrl, "POST", "/cuentas_cobro", {
        nombre: "TEST debito sin destino",
        tipo_pago_codigo: "debito",
        tipo_cuenta: "terminal",
        proveedor_integracion: "interno",
        activo: true
      }, token);
      if (digitalSinDestino.response.ok) throw new Error("Crear canal digital sin cuenta_destino_id debe fallar");
      assertEqual(digitalSinDestino.response.status, 400, "Canal digital sin destino debe devolver 400");

      const digitalValido = await requestJson(baseUrl, "POST", "/cuentas_cobro", {
        nombre: "TEST debito con destino",
        tipo_pago_codigo: "debito",
        tipo_cuenta: "terminal",
        proveedor_integracion: "interno",
        cuenta_destino_id: destinoDigital.id,
        activo: true
      }, token);
      if (!digitalValido.response.ok) throw new Error(`Crear canal digital con destino valido fallo: ${digitalValido.data?.message || digitalValido.response.status}`);
      assertEqual(digitalValido.data.cuenta.cuenta_destino_id, destinoDigital.id, "Canal digital valido debe guardar cuenta_destino_id");

      const pointSinTerminal = await requestJson(baseUrl, "POST", "/cuentas_cobro", {
        nombre: "TEST Point sin terminal",
        tipo_pago_codigo: "debito",
        tipo_cuenta: "terminal",
        proveedor_integracion: "mercadopago_point",
        cuenta_destino_id: destinoDigital.id,
        activo: true
      }, token);
      if (pointSinTerminal.response.ok) throw new Error("Crear canal mercadopago_point sin terminal_id debe fallar");
      assertEqual(pointSinTerminal.response.status, 400, "Point sin terminal debe devolver 400");

      const pointValido = await requestJson(baseUrl, "POST", "/cuentas_cobro", {
        nombre: "TEST Point sin store pos",
        tipo_pago_codigo: "debito",
        tipo_cuenta: "terminal",
        proveedor_integracion: "mercadopago_point",
        terminal_id: "POINT-TEST",
        cuenta_destino_id: destinoDigital.id,
        activo: true
      }, token);
      if (!pointValido.response.ok) throw new Error(`Crear Point con terminal y sin store/pos debe pasar: ${pointValido.data?.message || pointValido.response.status}`);

      const efectivoInterno = await requestJson(baseUrl, "POST", "/cuentas_cobro", {
        nombre: "TEST efectivo interno sin terminal",
        tipo_pago_codigo: "efectivo",
        tipo_cuenta: "caja",
        proveedor_integracion: "interno",
        activo: true
      }, token);
      if (!efectivoInterno.response.ok) throw new Error(`Crear canal efectivo interno sin terminal debe pasar: ${efectivoInterno.data?.message || efectivoInterno.response.status}`);

      const digitalDestinoInactivo = await requestJson(baseUrl, "POST", "/cuentas_cobro", {
        nombre: "TEST debito destino inactivo",
        tipo_pago_codigo: "debito",
        tipo_cuenta: "terminal",
        proveedor_integracion: "interno",
        cuenta_destino_id: destinoInactivo.id,
        activo: true
      }, token);
      if (digitalDestinoInactivo.response.ok) throw new Error("Crear canal digital con cuenta destino inactiva debe fallar");
      assertEqual(digitalDestinoInactivo.response.status, 400, "Destino inactivo debe devolver 400");

      await runSql(
        dbPath,
        `INSERT INTO cuentas_cobro
         (nombre, tipo_pago_codigo, tipo_cuenta, proveedor_integracion, activo, orden, terminal_id, store_id, pos_id, cuenta_destino_id, created_at, updated_at)
         VALUES (?, 'debito', 'terminal', 'interno', 1, 999, '0', '0', '0', NULL, datetime('now'), datetime('now'))`,
        ["TEST legacy sin destino no migrar"]
      );
      const cuentas = await requestJson(baseUrl, "GET", "/cuentas_cobro?todos=1", null, token);
      if (!cuentas.response.ok) throw new Error(`GET cuentas_cobro fallo: ${cuentas.data?.message || cuentas.response.status}`);
      const legacy = cuentas.data.find((cuenta) => cuenta.nombre === "TEST legacy sin destino no migrar");
      if (!legacy) throw new Error("Cuenta legacy insertada debe seguir existiendo");
      assertEqual(legacy.cuenta_destino_id || 0, 0, "Cuenta legacy no debe migrarse automaticamente");
      assertEqual(legacy.terminal_id, "0", "Valor legacy terminal_id=0 no debe borrarse automaticamente");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testMercadoPagoPointIntentosInfraestructura() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      const cuentaDestinoMp = await crearCuentaDestino(baseUrl, token, {
        nombre: "Mercado Pago Point Destino TEST",
        tipo_destino: "billetera",
        orden: 90
      });
      const cuentaPoint = await crearCuentaCobro(baseUrl, token, {
        nombre: "Point Mostrador TEST",
        tipo_pago_codigo: "debito",
        proveedor_integracion: "mercadopago_point",
        terminal_id: "NEWLAND_N950__TEST123",
        store_id: "STORE-TEST",
        pos_id: "POS-TEST",
        cuenta_destino_id: cuentaDestinoMp.id
      });
      const cuentaNoPoint = await crearCuentaCobro(baseUrl, token, {
        nombre: "Debito comun TEST",
        tipo_pago_codigo: "debito",
        proveedor_integracion: "interno",
        terminal_id: "TERM-COMUN"
      });
      const cuentaPointSinTerminalInsert = await runSql(
        dbPath,
        `INSERT INTO cuentas_cobro
         (nombre, tipo_pago_codigo, tipo_cuenta, proveedor_integracion, activo, orden, terminal_id, cuenta_destino_id, created_at, updated_at)
         VALUES (?, 'debito', 'terminal', 'mercadopago_point', 1, 99, '', ?, datetime('now'), datetime('now'))`,
        ["Point sin terminal TEST", cuentaDestinoMp.id]
      );
      const cuentaPointSinTerminal = { id: cuentaPointSinTerminalInsert.lastID };

      const stockAntes = (await getProduct(baseUrl, token, 11)).stock;
      const resumenAntes = await getCajaResumen(baseUrl, token);

      const crear = await requestJson(baseUrl, "POST", "/integraciones/mercadopago-point/intentos", {
        cuenta_cobro_id: cuentaPoint.id,
        monto_total: 321.45
      }, token);
      if (!crear.response.ok) throw new Error(`Crear intento Point fallo: ${crear.data?.message || crear.response.status}`);
      const intento = crear.data.intento;
      assertEqual(intento.cuenta_cobro_id, cuentaPoint.id, "Intento debe guardar cuenta_cobro_id");
      assertEqual(intento.cuenta_destino_id, cuentaDestinoMp.id, "Intento debe heredar cuenta_destino_id");
      assertApprox(intento.monto_total, 321.45, "Intento debe guardar monto_total");
      if (intento.estado !== "pendiente_mp") throw new Error(`Intento debe iniciar pendiente_mp. Actual=${intento.estado}`);
      if (!String(intento.external_reference || "").startsWith("MPPOINT-")) throw new Error("Intento debe generar external_reference");
      if (!intento.idempotency_key) throw new Error("Intento debe generar idempotency_key");
      if (intento.mp_order_id || intento.mp_payment_id) throw new Error("MP-A no debe guardar ids reales de Mercado Pago");

      const obtenido = await requestJson(baseUrl, "GET", `/integraciones/mercadopago-point/intentos/${intento.id}`, null, token);
      if (!obtenido.response.ok) throw new Error(`GET intento Point fallo: ${obtenido.data?.message || obtenido.response.status}`);
      assertEqual(obtenido.data.id, intento.id, "GET intento debe devolver el intento creado");

      const segundo = await requestJson(baseUrl, "POST", "/integraciones/mercadopago-point/intentos", {
        cuenta_cobro_id: cuentaPoint.id,
        monto_total: 99
      }, token);
      if (!segundo.response.ok) throw new Error(`Crear segundo intento Point fallo: ${segundo.data?.message || segundo.response.status}`);
      if (segundo.data.intento.external_reference === intento.external_reference) throw new Error("external_reference debe ser unico");
      if (segundo.data.intento.idempotency_key === intento.idempotency_key) throw new Error("idempotency_key debe ser unico");

      const listado = await requestJson(baseUrl, "GET", "/integraciones/mercadopago-point/intentos?estado=pendiente_mp", null, token);
      if (!listado.response.ok) throw new Error(`GET listado intentos Point fallo: ${listado.data?.message || listado.response.status}`);
      if (!Array.isArray(listado.data) || listado.data.length < 2) throw new Error("Listado por estado debe incluir intentos pendientes");

      const intentoNoPoint = await requestJson(baseUrl, "POST", "/integraciones/mercadopago-point/intentos", {
        cuenta_cobro_id: cuentaNoPoint.id,
        monto_total: 10
      }, token);
      if (intentoNoPoint.response.ok) throw new Error("Cuenta no mercadopago_point debe fallar");
      assertEqual(intentoNoPoint.response.status, 400, "Cuenta no mercadopago_point debe devolver 400");

      const intentoSinTerminal = await requestJson(baseUrl, "POST", "/integraciones/mercadopago-point/intentos", {
        cuenta_cobro_id: cuentaPointSinTerminal.id,
        monto_total: 10
      }, token);
      if (intentoSinTerminal.response.ok) throw new Error("Cuenta Point sin terminal_id debe fallar");
      assertEqual(intentoSinTerminal.response.status, 400, "Cuenta Point sin terminal_id debe devolver 400");

      const intentoMontoInvalido = await requestJson(baseUrl, "POST", "/integraciones/mercadopago-point/intentos", {
        cuenta_cobro_id: cuentaPoint.id,
        monto_total: 0
      }, token);
      if (intentoMontoInvalido.response.ok) throw new Error("Intento Point con monto 0 debe fallar");
      assertEqual(intentoMontoInvalido.response.status, 400, "Monto 0 debe devolver 400");

      const ventas = await getVentas(baseUrl, token);
      if (ventas.length !== 0) throw new Error("Crear intentos Point MP-A no debe crear ni cobrar ventas");
      assertEqual((await getProduct(baseUrl, token, 11)).stock, stockAntes, "Crear intentos Point no debe tocar stock");
      const resumenDespues = await getCajaResumen(baseUrl, token);
      assertEqual(resumenDespues.resumen.total_ventas, resumenAntes.resumen.total_ventas, "Crear intentos Point no debe tocar caja/ventas");
      assertEqual(resumenDespues.resumen.total_efectivo, resumenAntes.resumen.total_efectivo, "Crear intentos Point no debe tocar caja/efectivo");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testCuentasDestinoEtapa3AInfraestructura() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      const tablas = await allSql(dbPath, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cuentas_destino'");
      assertEqual(tablas.length, 1, "Debe crear tabla cuentas_destino");

      const columnasCobro = await allSql(dbPath, "PRAGMA table_info(cuentas_cobro)");
      if (!columnasCobro.some((col) => col.name === "cuenta_destino_id")) {
        throw new Error("cuentas_cobro debe tener columna nullable cuenta_destino_id");
      }

      const defaults = await requestJson(baseUrl, "GET", "/cuentas_destino?todos=1", null, token);
      if (!defaults.response.ok) throw new Error(`GET /cuentas_destino?todos=1 fallo: ${defaults.data?.message || defaults.response.status}`);
      if (!defaults.data.some((cuenta) => cuenta.nombre === "Caja efectivo")) throw new Error("Debe crear default Caja efectivo");
      if (!defaults.data.some((cuenta) => cuenta.nombre === "Mercado Pago")) throw new Error("Debe crear default Mercado Pago");

      const banco = await crearCuentaDestino(baseUrl, token, {
        nombre: "Banco Galicia destino TEST",
        tipo_destino: "banco",
        alias: "galicia.test",
        cbu_cvu: "0000000000000000000001",
        orden: 30
      });
      assertEqual(banco.tipo_destino === "banco" ? 1 : 0, 1, "POST /cuentas_destino debe guardar tipo_destino");

      const update = await requestJson(baseUrl, "PUT", `/cuentas_destino/${banco.id}`, {
        nombre: "Banco Galicia destino TEST editado",
        tipo_destino: "banco",
        alias: "galicia.editado",
        cbu_cvu: "0000000000000000000002",
        activo: true,
        orden: 31
      }, token);
      if (!update.response.ok) throw new Error(`PUT /cuentas_destino fallo: ${update.data?.message || update.response.status}`);
      assertEqual(update.data.cuenta.orden, 31, "PUT /cuentas_destino debe actualizar orden");

      const toggle = await requestJson(baseUrl, "PATCH", `/cuentas_destino/${banco.id}/activo`, { activo: false }, token);
      if (!toggle.response.ok) throw new Error(`PATCH /cuentas_destino activo fallo: ${toggle.data?.message || toggle.response.status}`);
      assertEqual(toggle.data.cuenta.activo, 0, "PATCH /cuentas_destino debe desactivar");
      await requestJson(baseUrl, "PATCH", `/cuentas_destino/${banco.id}/activo`, { activo: true }, token);

      const cuentaCobro = await crearCuentaCobro(baseUrl, token, {
        nombre: "Terminal con destino TEST",
        tipo_pago_codigo: "debito",
        cuenta_destino_id: banco.id,
        terminal_id: "DEST-TERM"
      });
      assertEqual(cuentaCobro.cuenta_destino_id, banco.id, "cuentas_cobro debe guardar cuenta_destino_id");

      const cuentasCobro = await requestJson(baseUrl, "GET", "/cuentas_cobro?todos=1", null, token);
      if (!cuentasCobro.response.ok) throw new Error(`GET /cuentas_cobro?todos=1 fallo: ${cuentasCobro.data?.message || cuentasCobro.response.status}`);
      const cuentaListada = cuentasCobro.data.find((cuenta) => Number(cuenta.id) === Number(cuentaCobro.id));
      assertEqual(cuentaListada.cuenta_destino_id, banco.id, "GET cuentas_cobro debe devolver cuenta_destino_id");
      if (cuentaListada.cuenta_destino_nombre !== "Banco Galicia destino TEST editado") {
        throw new Error(`GET cuentas_cobro debe devolver nombre de cuenta destino. Actual=${cuentaListada.cuenta_destino_nombre}`);
      }

      const cuentaLegacy = await crearCuentaCobro(baseUrl, token, {
        nombre: "Canal legacy sin destino TEST",
        tipo_pago_codigo: "efectivo",
        cuenta_destino_id: null
      });
      assertEqual(cuentaLegacy.cuenta_destino_id || 0, 0, "Canal sin cuenta_destino_id debe seguir funcionando");

      const ventaLegacy = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "efectivo",
        cuenta_cobro_id: null
      }), token);
      if (!ventaLegacy.response.ok) throw new Error(`Venta legacy sin cuenta destino fallo: ${ventaLegacy.data?.message || ventaLegacy.response.status}`);
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testCajaResumenPorCuentaDestino() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const apertura = await abrirCaja(baseUrl, token, 1000);
      const mercadoPago = await crearCuentaDestino(baseUrl, token, {
        nombre: "Mercado Pago destino resumen TEST",
        tipo_destino: "billetera",
        alias: "mp.destino.test",
        orden: 10
      });
      const point = await crearCuentaCobro(baseUrl, token, {
        nombre: "Point barra destino TEST",
        tipo_pago_codigo: "debito",
        tipo_cuenta: "terminal",
        cuenta_destino_id: mercadoPago.id,
        orden: 10
      });
      const qr = await crearCuentaCobro(baseUrl, token, {
        nombre: "QR mostrador destino TEST",
        tipo_pago_codigo: "transferencia",
        tipo_cuenta: "qr",
        cuenta_destino_id: mercadoPago.id,
        orden: 20
      });
      const legacySinDestino = await crearCuentaCobro(baseUrl, token, {
        nombre: "Canal sin destino resumen TEST",
        tipo_pago_codigo: "efectivo",
        tipo_cuenta: "caja",
        cuenta_destino_id: null,
        orden: 30
      });
      const proveedor = await crearProveedor(baseUrl, token);

      const ventaPoint = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "debito",
        cuenta_cobro_id: point.id
      }), token);
      if (!ventaPoint.response.ok) throw new Error(`Venta Point destino fallo: ${ventaPoint.data?.message || ventaPoint.response.status}`);

      const ventaQr = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "transferencia",
        cuenta_cobro_id: qr.id
      }), token);
      if (!ventaQr.response.ok) throw new Error(`Venta QR destino fallo: ${ventaQr.data?.message || ventaQr.response.status}`);

      const ventaCanalSinDestino = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "efectivo",
        cuenta_cobro_id: legacySinDestino.id
      }), token);
      if (!ventaCanalSinDestino.response.ok) throw new Error(`Venta canal sin destino fallo: ${ventaCanalSinDestino.data?.message || ventaCanalSinDestino.response.status}`);

      const ventaSinCuenta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "efectivo",
        cuenta_cobro_id: null
      }), token);
      if (!ventaSinCuenta.response.ok) throw new Error(`Venta sin cuenta destino fallo: ${ventaSinCuenta.data?.message || ventaSinCuenta.response.status}`);

      const ventaAnular = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "debito",
        cuenta_cobro_id: point.id
      }), token);
      if (!ventaAnular.response.ok) throw new Error(`Venta a anular destino fallo: ${ventaAnular.data?.message || ventaAnular.response.status}`);
      const anulacion = await requestJson(baseUrl, "POST", `/ventas/${ventaAnular.data.venta_id}/anular-cobrada`, {
        authorization_code: "1234"
      }, token);
      if (!anulacion.response.ok) throw new Error(`Anulacion destino fallo: ${anulacion.data?.message || anulacion.response.status}`);

      await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST egreso Mercado Pago destino",
        monto_total: 50,
        tipo_pago: "debito",
        estado: "registrado",
        cuenta_cobro_id: point.id
      });
      await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST egreso sin cuenta destino",
        monto_total: 20,
        tipo_pago: "efectivo",
        estado: "registrado",
        cuenta_cobro_id: null
      });
      await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST pendiente no impacta destino",
        monto_total: 70,
        tipo_pago: "debito",
        estado: "pendiente",
        cuenta_cobro_id: point.id
      });

      const resumenAbierta = await getCajaResumenCuentasDestino(baseUrl, token);
      assertEqual(resumenAbierta.caja.id, apertura.id, "Resumen por cuenta destino sin caja_id debe usar caja abierta");
      const mp = resumenAbierta.cuentas.find((cuenta) => cuenta.cuenta_destino_id === mercadoPago.id);
      const sinDestino = resumenAbierta.cuentas.find((cuenta) => cuenta.sin_cuenta_destino);

      if (!mp || !sinDestino) {
        throw new Error(`Resumen por cuenta destino debe incluir Mercado Pago y Sin cuenta destino. Actual=${JSON.stringify(resumenAbierta.cuentas)}`);
      }

      assertApprox(mp.ingresos, 400, "Dos canales asociados a Mercado Pago deben agrupar ingresos");
      assertApprox(mp.egresos, 50, "Pago por canal Mercado Pago debe restar en Mercado Pago");
      assertApprox(mp.balance, 350, "Balance Mercado Pago debe ser ingresos - egresos");
      assertEqual(mp.ventas, 2, "Venta anulada no debe contar en cuenta destino");
      assertEqual(mp.pagos, 1, "Pago pendiente no debe contar en cuenta destino");
      if (!mp.canales.includes("Point barra destino TEST") || !mp.canales.includes("QR mostrador destino TEST")) {
        throw new Error(`Cuenta destino debe listar canales usados. Actual=${JSON.stringify(mp.canales)}`);
      }

      assertApprox(sinDestino.ingresos, 400, "Canal sin destino y movimiento sin cuenta deben agruparse en Sin cuenta destino");
      assertApprox(sinDestino.egresos, 20, "Movimiento sin cuenta_cobro_id debe restar en Sin cuenta destino");
      assertApprox(sinDestino.balance, 380, "Balance Sin cuenta destino debe ser ingresos - egresos");
      assertEqual(sinDestino.ventas, 2, "Sin cuenta destino debe contar ventas de canal legacy y sin cuenta");
      assertEqual(sinDestino.pagos, 1, "Sin cuenta destino debe contar pagos sin cuenta");

      const ultimo = resumenAbierta.cuentas[resumenAbierta.cuentas.length - 1];
      if (!ultimo.sin_cuenta_destino) {
        throw new Error(`Sin cuenta destino debe ordenarse al final. Actual=${JSON.stringify(resumenAbierta.cuentas)}`);
      }

      const cajaCerrada = await cerrarCaja(baseUrl, token, 3000, 0, 0);
      const resumenCerrada = await getCajaResumenCuentasDestino(baseUrl, token);
      assertEqual(resumenCerrada.caja.id, cajaCerrada.id, "Resumen por cuenta destino sin caja abierta debe usar ultima caja cerrada");
      const mpCerrada = resumenCerrada.cuentas.find((cuenta) => cuenta.cuenta_destino_id === mercadoPago.id);
      assertApprox(mpCerrada?.balance, 350, "Resumen por cuenta destino de ultima caja cerrada debe conservar balance");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testConciliacionManualPorCuentaDestino() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const apertura = await abrirCaja(baseUrl, token, 1000);
      const mercadoPago = await crearCuentaDestino(baseUrl, token, {
        nombre: "Mercado Pago conciliacion destino TEST",
        tipo_destino: "billetera",
        orden: 10
      });
      const banco = await crearCuentaDestino(baseUrl, token, {
        nombre: "Banco conciliacion destino TEST",
        tipo_destino: "banco",
        orden: 20
      });
      const cuentaMp = await crearCuentaCobro(baseUrl, token, {
        nombre: "Point conciliacion destino TEST",
        tipo_pago_codigo: "debito",
        cuenta_destino_id: mercadoPago.id
      });
      const cuentaBanco = await crearCuentaCobro(baseUrl, token, {
        nombre: "Transferencia conciliacion destino TEST",
        tipo_pago_codigo: "transferencia",
        cuenta_destino_id: banco.id
      });

      const ventaMp = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "debito",
        cuenta_cobro_id: cuentaMp.id
      }), token);
      if (!ventaMp.response.ok) throw new Error(`Venta MP conciliacion destino fallo: ${ventaMp.data?.message || ventaMp.response.status}`);
      const ventaBanco = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "transferencia",
        cuenta_cobro_id: cuentaBanco.id
      }), token);
      if (!ventaBanco.response.ok) throw new Error(`Venta banco conciliacion destino fallo: ${ventaBanco.data?.message || ventaBanco.response.status}`);

      const resumenAntes = await getCajaResumenCuentasDestino(baseUrl, token, apertura.id);
      const mpAntes = resumenAntes.cuentas.find((cuenta) => cuenta.cuenta_destino_id === mercadoPago.id);
      assertApprox(mpAntes?.balance, 200, "Resumen esperado destino antes de conciliar");

      const positiva = await guardarConciliacionCuentaDestino(baseUrl, token, {
        caja_id: apertura.id,
        cuenta_destino_id: mercadoPago.id,
        monto_sistema: 200,
        monto_real: 250,
        observaciones: "positiva"
      });
      assertApprox(positiva.conciliacion.diferencia, 50, "Conciliacion destino debe calcular diferencia positiva");
      assertEqual(positiva.conciliacion.estado === "diferencia" ? 1 : 0, 1, "Diferencia positiva debe quedar en estado diferencia");

      const negativa = await guardarConciliacionCuentaDestino(baseUrl, token, {
        caja_id: apertura.id,
        cuenta_destino_id: mercadoPago.id,
        monto_sistema: 200,
        monto_real: 175,
        observaciones: "negativa update"
      });
      assertEqual(negativa.conciliacion.id, positiva.conciliacion.id, "Conciliacion destino debe actualizar la existente");
      assertApprox(negativa.conciliacion.diferencia, -25, "Conciliacion destino debe calcular diferencia negativa");

      const cero = await guardarConciliacionCuentaDestino(baseUrl, token, {
        caja_id: apertura.id,
        cuenta_destino_id: banco.id,
        monto_sistema: 200,
        monto_real: 200,
        observaciones: "cero"
      });
      assertApprox(cero.conciliacion.diferencia, 0, "Conciliacion destino debe calcular diferencia cero");
      assertEqual(cero.conciliacion.estado === "conciliado" ? 1 : 0, 1, "Diferencia cero debe quedar conciliada");

      const getPorCaja = await getCajaConciliacionesCuentasDestino(baseUrl, token, apertura.id);
      assertEqual(getPorCaja.caja.id, apertura.id, "GET conciliaciones destino por caja debe devolver caja solicitada");
      if (getPorCaja.conciliaciones.length !== 2) {
        throw new Error(`GET conciliaciones destino debe devolver dos registros. Actual=${JSON.stringify(getPorCaja.conciliaciones)}`);
      }

      const resumenDespues = await getCajaResumenCuentasDestino(baseUrl, token, apertura.id);
      const mpDespues = resumenDespues.cuentas.find((cuenta) => cuenta.cuenta_destino_id === mercadoPago.id);
      assertApprox(mpDespues?.balance, 200, "Conciliacion destino no debe alterar resumen esperado");

      const getAbierta = await getCajaConciliacionesCuentasDestino(baseUrl, token);
      assertEqual(getAbierta.caja.id, apertura.id, "GET conciliaciones destino sin caja_id debe usar caja abierta");

      const cajaCerrada = await cerrarCaja(baseUrl, token, 1000, 0, 0);
      const getCerrada = await getCajaConciliacionesCuentasDestino(baseUrl, token);
      assertEqual(getCerrada.caja.id, cajaCerrada.id, "GET conciliaciones destino sin caja abierta debe usar ultima caja cerrada");
      if (!getCerrada.conciliaciones.some((item) => Number(item.cuenta_destino_id) === Number(mercadoPago.id))) {
        throw new Error("GET conciliaciones destino de ultima caja cerrada debe conservar conciliacion Mercado Pago");
      }
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testCajaResumenPorCuentaCobro() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const apertura = await abrirCaja(baseUrl, token, 1000);
      const cuentaEfectivo = await crearCuentaCobro(baseUrl, token, {
        nombre: "Caja efectivo resumen TEST",
        tipo_pago_codigo: "efectivo",
        orden: 10
      });
      const cuentaDebito = await crearCuentaCobro(baseUrl, token, {
        nombre: "Terminal debito resumen TEST",
        tipo_pago_codigo: "debito",
        orden: 20
      });
      const proveedor = await crearProveedor(baseUrl, token);

      const ventaEfectivo = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "efectivo",
        cuenta_cobro_id: cuentaEfectivo.id
      }), token);
      if (!ventaEfectivo.response.ok) throw new Error(`Venta efectivo con cuenta fallo: ${ventaEfectivo.data?.message || ventaEfectivo.response.status}`);

      const ventaDebito = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "debito",
        cuenta_cobro_id: cuentaDebito.id
      }), token);
      if (!ventaDebito.response.ok) throw new Error(`Venta debito con cuenta fallo: ${ventaDebito.data?.message || ventaDebito.response.status}`);

      const ventaSinCuenta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "efectivo",
        cuenta_cobro_id: null
      }), token);
      if (!ventaSinCuenta.response.ok) throw new Error(`Venta sin cuenta fallo: ${ventaSinCuenta.data?.message || ventaSinCuenta.response.status}`);

      const ventaAnular = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "efectivo",
        cuenta_cobro_id: cuentaEfectivo.id
      }), token);
      if (!ventaAnular.response.ok) throw new Error(`Venta a anular fallo: ${ventaAnular.data?.message || ventaAnular.response.status}`);
      const anulacion = await requestJson(baseUrl, "POST", `/ventas/${ventaAnular.data.venta_id}/anular-cobrada`, {
        authorization_code: "1234"
      }, token);
      if (!anulacion.response.ok) throw new Error(`Anulacion de venta con cuenta fallo: ${anulacion.data?.message || anulacion.response.status}`);

      await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST egreso cuenta efectivo",
        monto_total: 50,
        tipo_pago: "efectivo",
        estado: "registrado",
        cuenta_cobro_id: cuentaEfectivo.id
      });
      await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST egreso cuenta debito",
        monto_total: 30,
        tipo_pago: "debito",
        estado: "registrado",
        cuenta_cobro_id: cuentaDebito.id
      });
      await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST egreso sin cuenta",
        monto_total: 20,
        tipo_pago: "efectivo",
        estado: "registrado",
        cuenta_cobro_id: null
      });
      await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST pendiente no impacta cuenta",
        monto_total: 40,
        tipo_pago: "efectivo",
        estado: "pendiente",
        cuenta_cobro_id: cuentaEfectivo.id
      });

      const resumenAbierta = await getCajaResumenCuentas(baseUrl, token);
      assertEqual(resumenAbierta.caja.id, apertura.id, "Resumen por cuenta sin caja_id debe usar caja abierta");
      const porNombre = Object.fromEntries(resumenAbierta.cuentas.map((cuenta) => [cuenta.cuenta_nombre, cuenta]));
      const efectivo = porNombre["Caja efectivo resumen TEST"];
      const debito = porNombre["Terminal debito resumen TEST"];
      const sinCuenta = porNombre["Sin cuenta"];

      if (!efectivo || !debito || !sinCuenta) {
        throw new Error(`Resumen por cuenta debe incluir ambas cuentas y Sin cuenta. Actual=${JSON.stringify(resumenAbierta.cuentas)}`);
      }

      assertApprox(efectivo.ingresos, 200, "Venta con cuenta_cobro debe sumar ingreso correcto");
      assertApprox(efectivo.egresos, 50, "Pago registrado con cuenta_cobro debe sumar egreso correcto");
      assertApprox(efectivo.balance, 150, "Balance cuenta efectivo debe ser ingresos - egresos");
      assertEqual(efectivo.ventas, 1, "Venta anulada no debe contar como venta por cuenta");
      assertEqual(efectivo.pagos, 1, "Pago pendiente no debe contar como pago por cuenta");

      assertApprox(debito.ingresos, 200, "Varias cuentas deben separar ingresos");
      assertApprox(debito.egresos, 30, "Varias cuentas deben separar egresos");
      assertApprox(debito.balance, 170, "Balance cuenta debito debe ser ingresos - egresos");

      assertApprox(sinCuenta.ingresos, 200, "Movimientos sin cuenta deben sumar ingresos en Sin cuenta");
      assertApprox(sinCuenta.egresos, 20, "Movimientos sin cuenta deben sumar egresos en Sin cuenta");
      assertApprox(sinCuenta.balance, 180, "Balance Sin cuenta debe ser ingresos - egresos");

      if (resumenAbierta.cuentas[0].cuenta_nombre !== "Sin cuenta") {
        throw new Error(`Resumen debe ordenarse por mayor balance DESC. Primero=${resumenAbierta.cuentas[0].cuenta_nombre}`);
      }

      const cajaCerrada = await cerrarCaja(baseUrl, token, 2000, 0, 0);
      const resumenCerrada = await getCajaResumenCuentas(baseUrl, token);
      assertEqual(resumenCerrada.caja.id, cajaCerrada.id, "Resumen por cuenta sin caja abierta debe usar ultima caja cerrada");
      const efectivoCerrada = resumenCerrada.cuentas.find((cuenta) => cuenta.cuenta_nombre === "Caja efectivo resumen TEST");
      assertApprox(efectivoCerrada?.balance, 150, "Resumen por cuenta de ultima caja cerrada debe conservar balance");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testConciliacionManualPorCuentaCobro() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const apertura = await abrirCaja(baseUrl, token, 1000);
      const cuentaEfectivo = await crearCuentaCobro(baseUrl, token, {
        nombre: "Caja efectivo conciliacion TEST",
        tipo_pago_codigo: "efectivo",
        orden: 10
      });
      const cuentaDebito = await crearCuentaCobro(baseUrl, token, {
        nombre: "Terminal debito conciliacion TEST",
        tipo_pago_codigo: "debito",
        orden: 20
      });

      for (const payload of [
        { tipo_cobro: "efectivo", cuenta_cobro_id: cuentaEfectivo.id },
        { tipo_cobro: "debito", cuenta_cobro_id: cuentaDebito.id },
        { tipo_cobro: "efectivo", cuenta_cobro_id: null }
      ]) {
        const venta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(payload), token);
        if (!venta.response.ok) throw new Error(`Venta para conciliacion fallo: ${venta.data?.message || venta.response.status}`);
      }

      const resumenAntes = await getCajaResumenCuentas(baseUrl, token);
      assertEqual(resumenAntes.caja.id, apertura.id, "Conciliaciones sin caja_id deben tomar caja abierta");
      const efectivo = resumenAntes.cuentas.find((cuenta) => cuenta.cuenta_nombre === "Caja efectivo conciliacion TEST");
      const debito = resumenAntes.cuentas.find((cuenta) => cuenta.cuenta_nombre === "Terminal debito conciliacion TEST");
      const sinCuenta = resumenAntes.cuentas.find((cuenta) => cuenta.cuenta_nombre === "Sin cuenta");

      if (!efectivo || !debito || !sinCuenta) {
        throw new Error(`Resumen para conciliacion incompleto: ${JSON.stringify(resumenAntes.cuentas)}`);
      }

      const creada = await guardarConciliacionCuenta(baseUrl, token, {
        cuenta_cobro_id: cuentaEfectivo.id,
        monto_sistema: efectivo.balance,
        monto_real: efectivo.balance,
        observaciones: "TEST conciliacion nueva",
        usuario: "test"
      });
      assertEqual(creada.caja.id, apertura.id, "POST conciliacion sin caja_id debe usar caja abierta");
      assertApprox(creada.conciliacion.diferencia, 0, "Diferencia cero debe guardarse en 0");
      if (creada.conciliacion.estado !== "conciliado") {
        throw new Error(`Diferencia cero debe quedar conciliado. Actual=${creada.conciliacion.estado}`);
      }

      const actualizada = await guardarConciliacionCuenta(baseUrl, token, {
        caja_id: apertura.id,
        cuenta_cobro_id: cuentaEfectivo.id,
        monto_sistema: efectivo.balance,
        monto_real: efectivo.balance + 50,
        observaciones: "TEST diferencia positiva",
        usuario: "test"
      });
      assertEqual(actualizada.conciliacion.id, creada.conciliacion.id, "Guardar dos veces misma caja/cuenta debe actualizar conciliacion existente");
      assertApprox(actualizada.conciliacion.diferencia, 50, "Diferencia positiva debe calcularse como real - sistema");
      if (actualizada.conciliacion.estado !== "diferencia") {
        throw new Error(`Diferencia positiva debe quedar en estado diferencia. Actual=${actualizada.conciliacion.estado}`);
      }

      const negativa = await guardarConciliacionCuenta(baseUrl, token, {
        caja_id: apertura.id,
        cuenta_cobro_id: cuentaDebito.id,
        monto_sistema: debito.balance,
        monto_real: debito.balance - 30,
        observaciones: "TEST diferencia negativa",
        usuario: "test"
      });
      assertApprox(negativa.conciliacion.diferencia, -30, "Diferencia negativa debe calcularse como real - sistema");

      const ceroSinCuenta = await guardarConciliacionCuenta(baseUrl, token, {
        caja_id: apertura.id,
        cuenta_cobro_id: null,
        monto_sistema: sinCuenta.balance,
        monto_real: sinCuenta.balance,
        observaciones: "TEST sin cuenta conciliado",
        usuario: "test"
      });
      if (ceroSinCuenta.conciliacion.estado !== "conciliado") {
        throw new Error(`Conciliacion Sin cuenta sin diferencia debe quedar conciliado. Actual=${ceroSinCuenta.conciliacion.estado}`);
      }

      const conciliaciones = await getCajaConciliacionesCuentas(baseUrl, token, apertura.id);
      assertEqual(conciliaciones.caja.id, apertura.id, "GET conciliaciones debe devolver la caja solicitada");
      if (conciliaciones.conciliaciones.length !== 3) {
        throw new Error(`GET conciliaciones debe devolver tres conciliaciones. Actual=${JSON.stringify(conciliaciones.conciliaciones)}`);
      }

      const resumenDespues = await getCajaResumenCuentas(baseUrl, token, apertura.id);
      assertApprox(
        resumenDespues.cuentas.find((cuenta) => cuenta.cuenta_nombre === "Caja efectivo conciliacion TEST")?.balance,
        efectivo.balance,
        "Conciliar no debe alterar resumen original"
      );

      const cajaCerrada = await cerrarCaja(baseUrl, token, 2000, 0, 0);
      const conciliacionesCerrada = await getCajaConciliacionesCuentas(baseUrl, token);
      assertEqual(conciliacionesCerrada.caja.id, cajaCerrada.id, "GET conciliaciones sin caja abierta debe usar ultima caja cerrada");

      const updateCerrada = await guardarConciliacionCuenta(baseUrl, token, {
        cuenta_cobro_id: cuentaEfectivo.id,
        monto_sistema: efectivo.balance,
        monto_real: efectivo.balance + 25,
        observaciones: "TEST actualiza caja cerrada",
        usuario: "test"
      });
      assertEqual(updateCerrada.caja.id, cajaCerrada.id, "POST conciliacion sin caja abierta debe usar ultima caja cerrada");
      assertEqual(updateCerrada.conciliacion.id, actualizada.conciliacion.id, "Actualizar ultima caja cerrada debe reutilizar conciliacion existente");
      assertApprox(updateCerrada.conciliacion.diferencia, 25, "Conciliacion sobre ultima caja cerrada debe recalcular diferencia");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testReporteCuentasCobro() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      const cuentaEfectivo = await crearCuentaCobro(baseUrl, token, {
        nombre: "Reporte cuenta efectivo TEST",
        tipo_pago_codigo: "efectivo",
        orden: 10
      });
      const cuentaDebito = await crearCuentaCobro(baseUrl, token, {
        nombre: "Reporte terminal debito TEST",
        tipo_pago_codigo: "debito",
        orden: 20
      });
      const proveedor = await crearProveedor(baseUrl, token);

      const ventaEfectivo = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "efectivo",
        cuenta_cobro_id: cuentaEfectivo.id
      }), token);
      if (!ventaEfectivo.response.ok) throw new Error(`Venta efectivo reporte cuentas fallo: ${ventaEfectivo.data?.message || ventaEfectivo.response.status}`);

      const ventaDebito = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "debito",
        cuenta_cobro_id: cuentaDebito.id
      }), token);
      if (!ventaDebito.response.ok) throw new Error(`Venta debito reporte cuentas fallo: ${ventaDebito.data?.message || ventaDebito.response.status}`);

      const ventaSinCuenta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "efectivo",
        cuenta_cobro_id: null
      }), token);
      if (!ventaSinCuenta.response.ok) throw new Error(`Venta sin cuenta reporte cuentas fallo: ${ventaSinCuenta.data?.message || ventaSinCuenta.response.status}`);

      const ventaAnulada = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload({
        tipo_cobro: "efectivo",
        cuenta_cobro_id: cuentaEfectivo.id
      }), token);
      if (!ventaAnulada.response.ok) throw new Error(`Venta anulada reporte cuentas fallo: ${ventaAnulada.data?.message || ventaAnulada.response.status}`);
      const anular = await requestJson(baseUrl, "POST", `/ventas/${ventaAnulada.data.venta_id}/anular-cobrada`, {
        authorization_code: "1234"
      }, token);
      if (!anular.response.ok) throw new Error(`Anular venta reporte cuentas fallo: ${anular.data?.message || anular.response.status}`);

      await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST egreso reporte efectivo",
        monto_total: 50,
        tipo_pago: "efectivo",
        estado: "registrado",
        cuenta_cobro_id: cuentaEfectivo.id
      });
      await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST egreso reporte debito",
        monto_total: 30,
        tipo_pago: "debito",
        estado: "registrado",
        cuenta_cobro_id: cuentaDebito.id
      });
      await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST egreso reporte sin cuenta",
        monto_total: 20,
        tipo_pago: "efectivo",
        estado: "registrado",
        cuenta_cobro_id: null
      });
      await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST pendiente no impacta reporte cuenta",
        monto_total: 70,
        tipo_pago: "efectivo",
        estado: "pendiente",
        cuenta_cobro_id: cuentaEfectivo.id
      });

      const resumenCaja = await getCajaResumenCuentas(baseUrl, token);
      const efectivo = resumenCaja.cuentas.find((cuenta) => cuenta.cuenta_nombre === "Reporte cuenta efectivo TEST");
      const debito = resumenCaja.cuentas.find((cuenta) => cuenta.cuenta_nombre === "Reporte terminal debito TEST");
      const sinCuenta = resumenCaja.cuentas.find((cuenta) => cuenta.cuenta_nombre === "Sin cuenta");
      if (!efectivo || !debito || !sinCuenta) throw new Error(`Resumen caja previo incompleto: ${JSON.stringify(resumenCaja.cuentas)}`);

      await guardarConciliacionCuenta(baseUrl, token, {
        cuenta_cobro_id: cuentaEfectivo.id,
        monto_sistema: efectivo.balance,
        monto_real: efectivo.balance + 10,
        observaciones: "TEST reporte diferencia",
        usuario: "test"
      });
      await guardarConciliacionCuenta(baseUrl, token, {
        cuenta_cobro_id: cuentaDebito.id,
        monto_sistema: debito.balance,
        monto_real: debito.balance,
        observaciones: "TEST reporte conciliado",
        usuario: "test"
      });

      const { response, data } = await requestJson(baseUrl, "GET", "/reportes/cuentas-cobro?desde=2000-01-01&hasta=2099-12-31", null, token);
      if (!response.ok) throw new Error(`GET /reportes/cuentas-cobro fallo: ${data?.message || response.status}`);
      if (!Array.isArray(data)) throw new Error("GET /reportes/cuentas-cobro debe devolver un array");

      const porNombre = Object.fromEntries(data.map((cuenta) => [cuenta.cuenta_nombre, cuenta]));
      const repEfectivo = porNombre["Reporte cuenta efectivo TEST"];
      const repDebito = porNombre["Reporte terminal debito TEST"];
      const repSinCuenta = porNombre["Sin cuenta"];
      if (!repEfectivo || !repDebito || !repSinCuenta) {
        throw new Error(`Reporte debe incluir cuentas y Sin cuenta. Actual=${JSON.stringify(data)}`);
      }

      assertApprox(repEfectivo.ingresos, 200, "Reporte debe devolver ingresos por cuenta");
      assertApprox(repEfectivo.egresos, 50, "Reporte debe devolver egresos por cuenta");
      assertApprox(repEfectivo.balance, 150, "Reporte debe calcular balance ingresos - egresos");
      assertEqual(repEfectivo.ventas, 1, "Reporte debe excluir ventas anuladas");
      assertEqual(repEfectivo.pagos, 1, "Reporte debe excluir pagos pendientes");
      assertApprox(repEfectivo.diferencias, 10, "Reporte debe sumar diferencias conciliadas en valor absoluto");
      if (repEfectivo.estado_conciliacion !== "diferencia") {
        throw new Error(`Cuenta con diferencia debe quedar diferencia. Actual=${repEfectivo.estado_conciliacion}`);
      }

      assertApprox(repDebito.ingresos, 200, "Reporte debe separar ingresos por terminal");
      assertApprox(repDebito.egresos, 30, "Reporte debe separar egresos por terminal");
      assertApprox(repDebito.balance, 170, "Reporte debe calcular balance por terminal");
      if (repDebito.estado_conciliacion !== "conciliado") {
        throw new Error(`Cuenta conciliada debe quedar conciliado. Actual=${repDebito.estado_conciliacion}`);
      }

      assertApprox(repSinCuenta.ingresos, 200, "Reporte debe incluir ingresos Sin cuenta");
      assertApprox(repSinCuenta.egresos, 20, "Reporte debe incluir egresos Sin cuenta");
      assertApprox(repSinCuenta.balance, 180, "Reporte debe calcular balance Sin cuenta");
      if (repSinCuenta.estado_conciliacion !== "pendiente") {
        throw new Error(`Sin conciliacion debe quedar pendiente. Actual=${repSinCuenta.estado_conciliacion}`);
      }

      if (data[0].cuenta_nombre !== "Sin cuenta") {
        throw new Error(`Reporte debe ordenar por balance DESC. Primero=${data[0].cuenta_nombre}`);
      }

      const filtrado = await requestJson(baseUrl, "GET", "/reportes/cuentas-cobro?desde=2010-01-01&hasta=2010-12-31", null, token);
      if (!filtrado.response.ok) throw new Error(`GET /reportes/cuentas-cobro filtrado fallo: ${filtrado.data?.message || filtrado.response.status}`);
      if (filtrado.data.length !== 0) {
        throw new Error(`Reporte debe respetar filtros de fecha. Actual=${JSON.stringify(filtrado.data)}`);
      }
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testVentasPorDiaDevuelveClaves() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      const venta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      if (!venta.response.ok) throw new Error(`Venta fallo: ${venta.data?.message || venta.response.status}`);

      const { response, data } = await requestJson(baseUrl, "GET", "/reportes/ventas-por-dia", null, token);
      if (!response.ok) throw new Error(`GET /reportes/ventas-por-dia fallo: ${data?.message || response.status}`);
      if (!Array.isArray(data)) throw new Error("GET /reportes/ventas-por-dia debe devolver un array");
      if (!data.length) throw new Error("GET /reportes/ventas-por-dia debe devolver al menos un item");

      const item = data[0];
      for (const clave of ["fecha", "total", "cantidad_ventas"]) {
        if (!(clave in item)) {
          throw new Error(`Cada item debe tener clave '${clave}'. Item=${JSON.stringify(item)}`);
        }
      }
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testVentasPorDiaExcluyeAnuladas() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      const ventaOk = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      if (!ventaOk.response.ok) throw new Error(`Venta cobrada fallo: ${ventaOk.data?.message || ventaOk.response.status}`);

      const ventaAnular = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      if (!ventaAnular.response.ok) throw new Error(`Venta a anular fallo: ${ventaAnular.data?.message || ventaAnular.response.status}`);

      const anulacion = await requestJson(baseUrl, "POST", `/ventas/${ventaAnular.data.venta_id}/anular-cobrada`, {
        authorization_code: "1234"
      }, token);
      if (!anulacion.response.ok) throw new Error(`Anulacion fallo: ${anulacion.data?.message || anulacion.response.status}`);

      const { response, data } = await requestJson(baseUrl, "GET", "/reportes/ventas-por-dia", null, token);
      if (!response.ok) throw new Error(`GET /reportes/ventas-por-dia fallo: ${data?.message || response.status}`);
      if (!data.length) throw new Error("Debe devolver al menos una entrada");

      const hoy = data[0];
      assertApprox(hoy.total, 200, "Ventas por dia debe excluir ventas anuladas del total");
      assertEqual(hoy.cantidad_ventas, 1, "Ventas por dia debe excluir ventas anuladas de cantidad_ventas");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testVentasPorDiaAgrupaVentas() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      // Dos ventas del mismo dia (hoy)
      const v1 = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      if (!v1.response.ok) throw new Error(`Venta 1 fallo: ${v1.data?.message || v1.response.status}`);
      const v2 = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      if (!v2.response.ok) throw new Error(`Venta 2 fallo: ${v2.data?.message || v2.response.status}`);

      const { response, data } = await requestJson(baseUrl, "GET", "/reportes/ventas-por-dia", null, token);
      if (!response.ok) throw new Error(`GET /reportes/ventas-por-dia fallo: ${data?.message || response.status}`);

      const entrada = data.find((d) => Number(d.cantidad_ventas) >= 2);
      if (!entrada) throw new Error(`Las 2 ventas del mismo dia deben agruparse en una sola entrada. Respuesta=${JSON.stringify(data)}`);
      assertApprox(entrada.total, 400, "El total agrupado debe sumar ambas ventas (200 + 200 = 400)");
      assertEqual(entrada.cantidad_ventas, 2, "cantidad_ventas debe contar ambas ventas del dia");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testVentasPorDiaRespetaFiltroFechas() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);

      const venta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      if (!venta.response.ok) throw new Error(`Venta fallo: ${venta.data?.message || venta.response.status}`);

      // Rango amplio: incluye la venta de hoy
      const { response: r1, data: d1 } = await requestJson(baseUrl, "GET", "/reportes/ventas-por-dia?desde=2000-01-01&hasta=2099-12-31", null, token);
      if (!r1.ok) throw new Error(`GET rango amplio fallo: ${d1?.message || r1.status}`);
      if (!d1.length) throw new Error("Rango amplio debe devolver al menos una entrada con la venta de hoy");

      // Rango historico sin datos
      const { response: r2, data: d2 } = await requestJson(baseUrl, "GET", "/reportes/ventas-por-dia?desde=2010-01-01&hasta=2010-12-31", null, token);
      if (!r2.ok) throw new Error(`GET rango historico fallo: ${d2?.message || r2.status}`);
      if (d2.length !== 0) throw new Error(`Rango historico debe devolver array vacio. Actual=${JSON.stringify(d2)}`);
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testVentasPorDiaOrdenaAscendente() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, [
      ...resetOperationalDataStatements(),
      // Insertar 3 ventas con fechas conocidas en orden no ascendente
      ["INSERT INTO ventas (fecha, hora, usuario, total, tipo, estado, tipo_cobro, monto_efectivo, monto_debito, es_cuenta_corriente, saldo_pendiente) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ["2024-01-05", "12:00:00", "test", 300, "normal", "cobrada", "efectivo", 300, 0, 0, 0]],
      ["INSERT INTO ventas (fecha, hora, usuario, total, tipo, estado, tipo_cobro, monto_efectivo, monto_debito, es_cuenta_corriente, saldo_pendiente) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ["2024-01-01", "10:00:00", "test", 100, "normal", "cobrada", "efectivo", 100, 0, 0, 0]],
      ["INSERT INTO ventas (fecha, hora, usuario, total, tipo, estado, tipo_cobro, monto_efectivo, monto_debito, es_cuenta_corriente, saldo_pendiente) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ["2024-01-03", "11:00:00", "test", 200, "normal", "cobrada", "efectivo", 200, 0, 0, 0]]
    ]);
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");

      const { response, data } = await requestJson(baseUrl, "GET", "/reportes/ventas-por-dia?desde=2024-01-01&hasta=2024-01-31", null, token);
      if (!response.ok) throw new Error(`GET ventas-por-dia fallo: ${data?.message || response.status}`);
      if (data.length < 3) throw new Error(`Debe devolver 3 entradas para las 3 fechas distintas. Actual=${data.length}`);

      for (let i = 1; i < data.length; i++) {
        if (data[i].fecha < data[i - 1].fecha) {
          throw new Error(`Ventas por dia no estan ordenadas ASC. ${data[i - 1].fecha} > ${data[i].fecha}`);
        }
      }
      if (data[0].fecha !== "2024-01-01") throw new Error(`Primera entrada debe ser 2024-01-01. Actual=${data[0].fecha}`);
      if (data[data.length - 1].fecha !== "2024-01-05") throw new Error(`Ultima entrada debe ser 2024-01-05. Actual=${data[data.length - 1].fecha}`);
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

function compuestoBasePayload(categoriaId, componenteId, rinde, extras = []) {
  return {
    categoria_id: categoriaId,
    categoria: "TEST",
    tipo: "compuesto",
    componentes: [{ producto_id: componenteId, cantidad: 2 }],
    costos_extra: extras,
    rendimiento_receta: rinde,
    maneja_stock: false,
    stock: 0, stock_minimo: 0, alerta_stock_minimo: false,
    precio_venta: 300, precio_compra: 0, redondeo: 0,
    iva_porcentaje: 0, precio_compra_incluye_iva: true,
    unidad_medida: "un", codigo_barras: "", imagen_url: "",
    activo: true, usuario: "test",
    usa_costos_varios: false, es_combo: false, aplica_para_combo: false,
    descripcion: "", observaciones: ""
  };
}

async function testCompuestoCostoRendimientoControl() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const categoriaId = await crearCategoria(baseUrl, token, "TEST Costo Control");
      const componenteId = await crearProducto(baseUrl, token, {
        nombre: "TEST Ingrediente Control",
        categoria: "TEST Costo Control",
        categoria_id: categoriaId,
        precio_compra: 100,
        iva_porcentaje: 0,
        precio_compra_incluye_iva: false,
        precio_venta: 150,
        stock: 1000,
        maneja_stock: true
      });

      // rinde=1: cantidad stored = 2, costo = 100*2 = 200
      const { response, data } = await requestJson(baseUrl, "POST", "/productos", {
        nombre: "TEST Compuesto Rinde 1",
        ...compuestoBasePayload(categoriaId, componenteId, 1)
      }, token);
      if (!response.ok) throw new Error(`POST compuesto control fallo: ${data?.message || response.status}`);

      const { response: r2, data: comp } = await requestJson(baseUrl, "GET", `/productos_compuestos/${data.id}`, null, token);
      if (!r2.ok) throw new Error(`GET /productos_compuestos control fallo: ${comp?.message}`);
      assertApprox(comp.costo_final, 200, "Control rinde=1: costo_final debe ser 200", 1);
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testCompuestoCostoRendimiento5() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const categoriaId = await crearCategoria(baseUrl, token, "TEST Costo Rinde5");
      const componenteId = await crearProducto(baseUrl, token, {
        nombre: "TEST Ingrediente Rinde5",
        categoria: "TEST Costo Rinde5",
        categoria_id: categoriaId,
        precio_compra: 100,
        iva_porcentaje: 0,
        precio_compra_incluye_iva: false,
        precio_venta: 150,
        stock: 1000,
        maneja_stock: true
      });

      // rinde=5: frontend envía cantidad = cantidadUso/rinde = 10/5 = 2
      // costo correcto = 100*2 + 0/5 = 200
      const payload = { nombre: "TEST Compuesto Rinde 5", ...compuestoBasePayload(categoriaId, componenteId, 5) };
      const { response, data } = await requestJson(baseUrl, "POST", "/productos", payload, token);
      if (!response.ok) throw new Error(`POST compuesto rinde=5 fallo: ${data?.message || response.status}`);
      const compuestoId = data.id;

      // GET /productos_compuestos/:id (calcularCostoProductoCompuesto desde BD)
      const { response: r2, data: comp } = await requestJson(baseUrl, "GET", `/productos_compuestos/${compuestoId}`, null, token);
      if (!r2.ok) throw new Error(`GET /productos_compuestos/${compuestoId} fallo`);
      assertApprox(comp.costo_final, 200, "Rinde=5: GET /productos_compuestos debe devolver costo_final=200 (no 40)", 1);

      // GET /productos (costoCompuestoMemoria inline)
      const { response: r3, data: lista } = await requestJson(baseUrl, "GET", "/productos", null, token);
      if (!r3.ok) throw new Error("GET /productos fallo");
      const enListado = lista.find((p) => Number(p.id) === Number(compuestoId));
      if (!enListado) throw new Error("Compuesto rinde=5 no encontrado en GET /productos");
      assertApprox(enListado.costo_final, 200, "Rinde=5: GET /productos costo_final debe ser 200 (no 40)", 1);

      // PUT /productos/:id (calcularCostoProductoCompuestoPayload con rinde=5)
      const { response: r4 } = await requestJson(baseUrl, "PUT", `/productos/${compuestoId}`, payload, token);
      if (!r4.ok) throw new Error(`PUT compuesto rinde=5 fallo: ${r4.status}`);

      const { data: compPut } = await requestJson(baseUrl, "GET", `/productos_compuestos/${compuestoId}`, null, token);
      assertApprox(compPut.costo_final, 200, "Rinde=5: PUT + GET debe persistir costo_final=200", 1);
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testCompuestoCostoExtrasConRendimiento() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const categoriaId = await crearCategoria(baseUrl, token, "TEST Extras Rinde5");
      const componenteId = await crearProducto(baseUrl, token, {
        nombre: "TEST Ingrediente Extras",
        categoria: "TEST Extras Rinde5",
        categoria_id: categoriaId,
        precio_compra: 100,
        iva_porcentaje: 0,
        precio_compra_incluye_iva: false,
        precio_venta: 150,
        stock: 1000,
        maneja_stock: true
      });

      // componentes: 100*2 = 200, extras: monto=50, rinde=5
      // correcto = 200 + 50/5 = 200 + 10 = 210
      const payload = {
        nombre: "TEST Compuesto Extras Rinde5",
        ...compuestoBasePayload(categoriaId, componenteId, 5, [{ descripcion: "Envase TEST", monto: 50 }])
      };
      const { response, data } = await requestJson(baseUrl, "POST", "/productos", payload, token);
      if (!response.ok) throw new Error(`POST compuesto extras fallo: ${data?.message || response.status}`);
      const compuestoId = data.id;

      const { response: r2, data: comp } = await requestJson(baseUrl, "GET", `/productos_compuestos/${compuestoId}`, null, token);
      if (!r2.ok) throw new Error(`GET /productos_compuestos con extras fallo`);
      assertApprox(comp.costo_final, 210, "Extras rinde=5: costo = 200 + 10 = 210 (no 50)", 1);

      const { response: r3, data: lista } = await requestJson(baseUrl, "GET", "/productos", null, token);
      if (!r3.ok) throw new Error("GET /productos con extras fallo");
      const enListado = lista.find((p) => Number(p.id) === Number(compuestoId));
      if (!enListado) throw new Error("Compuesto con extras no encontrado en GET /productos");
      assertApprox(enListado.costo_final, 210, "Extras rinde=5: GET /productos costo_final = 210 (no 50)", 1);
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testCompuestoUsaCostoUnitarioDeComponenteFraccionado() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const categoriaId = await crearCategoria(baseUrl, token, "TEST Fraccionado Compuesto");

      // Componente fraccionado: costo_total=1800 por 1000 unidades → costo_unitario=1.8/un
      // costo_final guardado = costo_aplicado = 1.8 * 100 = 180 (NO es 1.8 por unidad)
      const { response: rf, data: fracc } = await requestJson(baseUrl, "POST", "/productos", {
        nombre: "TEST Componente Fraccionado",
        categoria_id: categoriaId,
        categoria: "TEST Fraccionado Compuesto",
        tipo: "simple",
        usa_costos_varios: true,
        costos_insumos: [{ nombre: "Fraccion 1", costo_total: 1800, cantidad_rinde: 1000, cantidad_usada: 100, unidad: "un" }],
        precio_compra: 0,
        iva_porcentaje: 0, precio_compra_incluye_iva: true,
        precio_venta: 200, stock: 1000, maneja_stock: true,
        redondeo: 0, unidad_medida: "un", codigo_barras: "", imagen_url: "",
        activo: true, usuario: "test",
        es_combo: false, aplica_para_combo: false, descripcion: "", observaciones: ""
      }, token);
      if (!rf.ok) throw new Error(`POST fraccionado fallo: ${fracc?.message || rf.status}`);
      const fraccionadoId = fracc.id;

      // Compuesto usa 80 unidades del fraccionado, rinde=1
      // Frontend envía cantidad = cantidadUso * factor / rinde = 80 * 1 / 1 = 80
      // costo correcto = 1.8 * 80 = 144 (no costo_final(180) * 80 = 14400)
      const { response, data } = await requestJson(baseUrl, "POST", "/productos", {
        nombre: "TEST Compuesto Fraccionado",
        categoria_id: categoriaId,
        categoria: "TEST Fraccionado Compuesto",
        tipo: "compuesto",
        componentes: [{ producto_id: fraccionadoId, cantidad: 80 }],
        costos_extra: [],
        rendimiento_receta: 1,
        maneja_stock: false,
        stock: 0, stock_minimo: 0, alerta_stock_minimo: false,
        precio_venta: 300, precio_compra: 0, redondeo: 0,
        iva_porcentaje: 0, precio_compra_incluye_iva: true,
        unidad_medida: "un", codigo_barras: "", imagen_url: "",
        activo: true, usuario: "test",
        usa_costos_varios: false, es_combo: false, aplica_para_combo: false,
        descripcion: "", observaciones: ""
      }, token);
      if (!response.ok) throw new Error(`POST compuesto fallo: ${data?.message || response.status}`);
      const compuestoId = data.id;

      // GET /productos_compuestos usa getCostoConsumoUnitarioProducto → siempre correcto
      const { data: comp } = await requestJson(baseUrl, "GET", `/productos_compuestos/${compuestoId}`, null, token);
      assertApprox(comp.costo_final, 144, "calcularCostoProductoCompuesto fraccionado: debe usar costo_unitario (1.8*80=144)", 1);

      // GET /productos usa costoCompuestoMemoria → era el bug (180*80=14400), debe ser 144
      const { response: r3, data: lista } = await requestJson(baseUrl, "GET", "/productos", null, token);
      if (!r3.ok) throw new Error("GET /productos fallo");
      const enListado = lista.find((p) => Number(p.id) === Number(compuestoId));
      if (!enListado) throw new Error("Compuesto fraccionado no encontrado en GET /productos");
      assertApprox(enListado.costo_final, 144, "costoCompuestoMemoria fraccionado: debe usar costo_consumo_unitario (1.8*80=144), no costo_final (180*80=14400)", 1);
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

// ─── Helpers de setup para tests de "quitar" ────────────────────────────────

async function setupQuitarTest(dbPath, baseUrl, token, cantidadReceta, cantidadQuitar) {
  await abrirCaja(baseUrl, token, 1000);
  const categoriaId = await crearCategoria(baseUrl, token, "TEST Quitar Cat");
  const componenteId = await crearProducto(baseUrl, token, {
    nombre: "TEST Ingrediente Quitar",
    categoria: "TEST Quitar Cat",
    categoria_id: categoriaId,
    stock: 100,
    maneja_stock: true,
    precio_venta: 10
  });
  const compuestoId = await crearProductoCompuesto(baseUrl, token, {
    nombre: "TEST Plato Con Quitar",
    categoria: "TEST Quitar Cat",
    categoria_id: categoriaId,
    precio_venta: 500,
    componentes: [{ producto_id: componenteId, cantidad: cantidadReceta }]
  });
  const { response, data } = await requestJson(baseUrl, "POST", `/productos/${compuestoId}/modificadores`, {
    nombre: "Sin ingrediente",
    tipo: "quitar",
    precio_extra: 0,
    activo: true,
    componentes: [{ producto_id: componenteId, cantidad: cantidadQuitar }]
  }, token);
  if (!response.ok) throw new Error(`No se pudo crear modificador quitar: ${data?.message || response.status}`);
  return { componenteId, compuestoId, modId: data.modificador.id };
}

async function venderConQuitar(baseUrl, token, compuestoId, modId) {
  return requestJson(baseUrl, "POST", "/ventas", {
    usuario: "test",
    tipo: "normal",
    tipo_cobro: "efectivo",
    items: [{
      producto_id: compuestoId,
      nombre_producto: "TEST Plato Con Quitar",
      cantidad: 1,
      precio_unitario: 500,
      modificadores: [{ modificador_id: modId, cantidad: 1 }]
    }]
  }, token);
}

// ─── Tests de modificador tipo "quitar" ─────────────────────────────────────

async function testModificadorQuitarSeCreaEnCompuesto() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const { componenteId, compuestoId, modId } = await setupQuitarTest(dbPath, baseUrl, token, 30, 15);
      const mod = (await requestJson(baseUrl, "GET", `/productos/${compuestoId}/modificadores?todos=1`, null, token)).data;
      const encontrado = mod.find((m) => Number(m.id) === Number(modId));
      if (!encontrado) throw new Error("Modificador quitar no aparece en GET /productos/:id/modificadores");
      if (encontrado.tipo !== "quitar") throw new Error(`Tipo debe ser quitar. Actual=${encontrado.tipo}`);
      assertEqual(encontrado.componentes.length, 1, "Modificador quitar debe tener 1 componente");
      assertEqual(Number(encontrado.componentes[0].producto_id), componenteId, "Componente del quitar debe ser el ingrediente");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testModificadorQuitarVentaCompuestoDescuentaMenos() {
  // receta=30, quitar=15 → A deducido: 30(receta) - 15(snapshot quitar) = 15 neto
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const { componenteId, compuestoId, modId } = await setupQuitarTest(dbPath, baseUrl, token, 30, 15);
      const stockInicial = (await getProduct(baseUrl, token, componenteId)).stock;

      const venta = await venderConQuitar(baseUrl, token, compuestoId, modId);
      if (!venta.response.ok) throw new Error(`Venta compuesto con quitar fallo: ${venta.data?.message || venta.response.status}`);

      const stockFinal = (await getProduct(baseUrl, token, componenteId)).stock;
      // Receta descuenta 30, snapshot quitar restaura 15 → neto = -15
      assertEqual(stockFinal, stockInicial, "Venta compuesto con quitar no debe descontar stock fisico");
      const ajustes = await getAjustesPendientesStock(baseUrl, token, "pendiente");
      const ajuste = ajustes.find((item) => Number(item.venta_id) === Number(venta.data.venta_id) && item.origen === "venta_receta");
      if (!ajuste) throw new Error("Venta compuesto con quitar debe generar ajuste teorico");
      assertApprox(ajuste.cantidad_teorica, 15, "Venta compuesto con quitar 15/30 debe generar consumo teorico neto 15");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testModificadorQuitarComponenteNoEnRecetaFalla400() {
  // Quitar un componente que no es parte de la receta base → 400
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const categoriaId = await crearCategoria(baseUrl, token, "TEST Quitar NoReceta");

      const componenteEnReceta = await crearProducto(baseUrl, token, {
        nombre: "TEST Comp En Receta",
        categoria: "TEST Quitar NoReceta",
        categoria_id: categoriaId,
        stock: 100,
        maneja_stock: true,
        precio_venta: 10
      });
      const componenteFueraReceta = await crearProducto(baseUrl, token, {
        nombre: "TEST Comp Fuera Receta",
        categoria: "TEST Quitar NoReceta",
        categoria_id: categoriaId,
        stock: 100,
        maneja_stock: true,
        precio_venta: 5
      });
      const compuestoId = await crearProductoCompuesto(baseUrl, token, {
        nombre: "TEST Compuesto NoReceta",
        categoria: "TEST Quitar NoReceta",
        categoria_id: categoriaId,
        precio_venta: 500,
        componentes: [{ producto_id: componenteEnReceta, cantidad: 20 }]
      });

      // Crear modificador "quitar" sobre el componente que NO está en la receta
      const { response: rMod, data: dMod } = await requestJson(baseUrl, "POST", `/productos/${compuestoId}/modificadores`, {
        nombre: "Sin comp fuera",
        tipo: "quitar",
        precio_extra: 0,
        activo: true,
        componentes: [{ producto_id: componenteFueraReceta, cantidad: 5 }]
      }, token);
      if (!rMod.ok) throw new Error(`No se pudo crear modificador para test: ${dMod?.message}`);
      const modId = dMod.modificador.id;

      // Intentar vender con ese modificador → debe fallar 400
      const venta = await venderConQuitar(baseUrl, token, compuestoId, modId);
      assertEqual(venta.response.status, 400, "Quitar componente no en receta debe fallar con 400");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testModificadorQuitarCantidadSuperiorBaseCapea() {
  // quitar=50 > receta=30 → capea a 30; componente queda sin descontar (neto=0)
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const { componenteId, compuestoId, modId } = await setupQuitarTest(dbPath, baseUrl, token, 30, 50);
      const stockInicial = (await getProduct(baseUrl, token, componenteId)).stock;

      const venta = await venderConQuitar(baseUrl, token, compuestoId, modId);
      if (!venta.response.ok) throw new Error(`Venta con quitar > base fallo: ${venta.data?.message || venta.response.status}`);

      const stockFinal = (await getProduct(baseUrl, token, componenteId)).stock;
      // Receta descuenta 30, snapshot quitar restaura min(50,30)=30 → neto=0
      assertEqual(stockFinal, stockInicial, "Quitar mayor a base debe capear: componente no se descuenta ni genera stock positivo");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testModificadorQuitarAnulacionReponeExacto() {
  // receta=30, quitar=15 → venta neto -15; anulación debe reponer exactamente +15
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const { componenteId, compuestoId, modId } = await setupQuitarTest(dbPath, baseUrl, token, 30, 15);
      const stockInicial = (await getProduct(baseUrl, token, componenteId)).stock;

      const venta = await venderConQuitar(baseUrl, token, compuestoId, modId);
      if (!venta.response.ok) throw new Error(`Venta con quitar fallo: ${venta.data?.message || venta.response.status}`);
      assertEqual((await getProduct(baseUrl, token, componenteId)).stock, stockInicial, "Venta con quitar no debe descontar stock fisico");

      const anulacion = await requestJson(baseUrl, "POST", `/ventas/${venta.data.venta_id}/anular-cobrada`, {
        authorization_code: "1234"
      }, token);
      if (!anulacion.response.ok) throw new Error(`Anulacion con quitar fallo: ${anulacion.data?.message || anulacion.response.status}`);

      const stockFinal = (await getProduct(baseUrl, token, componenteId)).stock;
      assertEqual(stockFinal, stockInicial, "Anulación de venta con quitar debe reponer exactamente lo descontado");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testModificadorQuitarPendienteDescuentaMenos() {
  // receta=30, quitar=15 → pendiente guarda snapshot; al cobrar no re-aplica
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const { componenteId, compuestoId, modId } = await setupQuitarTest(dbPath, baseUrl, token, 30, 15);
      const stockInicial = (await getProduct(baseUrl, token, componenteId)).stock;

      // Guardar pendiente: receta descuenta 30, snapshot quitar restaura 15 → neto -15
      const pendiente = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test",
        tipo: "pendiente",
        identificador_pendiente: "Mesa Quitar Test",
        items: [{
          producto_id: compuestoId,
          nombre_producto: "TEST Plato Con Quitar",
          cantidad: 1,
          precio_unitario: 500,
          modificadores: [{ modificador_id: modId, cantidad: 1 }]
        }]
      }, token);
      if (!pendiente.response.ok) throw new Error(`Pendiente con quitar fallo: ${pendiente.data?.message || pendiente.response.status}`);
      assertEqual((await getProduct(baseUrl, token, componenteId)).stock, stockInicial, "Pendiente con quitar no debe descontar stock fisico al guardar");
      const ajustes = await getAjustesPendientesStock(baseUrl, token, "pendiente");
      const ajuste = ajustes.find((item) => Number(item.venta_id) === Number(pendiente.data.venta_id) && item.origen === "venta_receta");
      if (!ajuste) throw new Error("Pendiente con quitar debe generar ajuste teorico");
      assertApprox(ajuste.cantidad_teorica, 15, "Pendiente con quitar debe guardar consumo teorico neto 15");

      // Cobrar el pendiente NO debe volver a aplicar snapshots de quitar
      const cobro = await requestJson(baseUrl, "POST", `/ventas/${pendiente.data.venta_id}/cobrar`, {
        tipo_cobro: "efectivo"
      }, token);
      if (!cobro.response.ok) throw new Error(`Cobrar pendiente con quitar fallo: ${cobro.data?.message || cobro.response.status}`);
      assertEqual((await getProduct(baseUrl, token, componenteId)).stock, stockInicial, "Cobrar pendiente con quitar no debe descontar stock fisico");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

// ── Saldos operativos por cuenta destino — Etapa 1 ────────────────────────────

async function testSaldosOperativosLegacySigueFuncionando() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const apertura = await abrirCaja(baseUrl, token, 0);
      const dest = await crearCuentaDestino(baseUrl, token, { nombre: "Destino Legacy", tipo_destino: "billetera", orden: 1 });

      const r = await guardarConciliacionCuentaDestino(baseUrl, token, {
        caja_id: apertura.id,
        cuenta_destino_id: dest.id,
        monto_sistema: 300,
        monto_real: 250
      });
      // sin saldo_inicial, diferencia = monto_real - (0 + monto_sistema) = -50
      assertApprox(r.conciliacion.diferencia, -50, "Legacy: diferencia = monto_real - monto_sistema");
      assertEqual(r.conciliacion.saldo_inicial != null ? 1 : 0, 1, "Legacy: saldo_inicial existe en respuesta");
      assertApprox(r.conciliacion.saldo_inicial, 0, "Legacy: saldo_inicial default 0");
      assertApprox(r.conciliacion.saldo_arrastrado, 0, "Legacy: saldo_arrastrado 0 sin decision");
      assertEqual(r.conciliacion.decision_cierre, null, "Legacy: decision_cierre null");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testSaldosOperativosConSaldoInicial() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const apertura = await abrirCaja(baseUrl, token, 0);
      const dest = await crearCuentaDestino(baseUrl, token, { nombre: "Destino SaldoInicial", tipo_destino: "billetera", orden: 1 });

      const r = await guardarConciliacionCuentaDestino(baseUrl, token, {
        caja_id: apertura.id,
        cuenta_destino_id: dest.id,
        saldo_inicial: 500,
        monto_sistema: 200,
        monto_real: 800
      });
      // saldo_esperado = 500 + 200 = 700; diferencia = 800 - 700 = 100
      assertApprox(r.conciliacion.saldo_inicial, 500, "saldo_inicial se guarda");
      assertApprox(r.conciliacion.diferencia, 100, "diferencia = monto_real - (saldo_inicial + monto_sistema)");
      assertEqual(r.conciliacion.estado === "diferencia" ? 1 : 0, 1, "estado diferencia cuando hay diferencia");

      // cero exacto
      const r2 = await guardarConciliacionCuentaDestino(baseUrl, token, {
        caja_id: apertura.id,
        cuenta_destino_id: dest.id,
        saldo_inicial: 500,
        monto_sistema: 200,
        monto_real: 700
      });
      assertApprox(r2.conciliacion.diferencia, 0, "diferencia cero cuando monto_real = saldo_inicial + monto_sistema");
      assertEqual(r2.conciliacion.estado === "conciliado" ? 1 : 0, 1, "estado conciliado con diferencia cero");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testSaldosOperativosArrastrar() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const apertura = await abrirCaja(baseUrl, token, 0);
      const dest = await crearCuentaDestino(baseUrl, token, { nombre: "Destino Arrastrar", tipo_destino: "billetera", orden: 1 });

      const { response: rArrastrar, data: dArrastrar } = await requestJson(baseUrl, "POST", "/caja/conciliaciones/cuentas-destino", {
        caja_id: apertura.id,
        cuenta_destino_id: dest.id,
        saldo_inicial: 100,
        monto_sistema: 200,
        monto_real: 350,
        decision_cierre: "arrastrar"
      }, token);
      if (!rArrastrar.ok) throw new Error(`Arrastrar guard fallo HTTP ${rArrastrar.status}: ${dArrastrar?.message}`);
      const r = dArrastrar;
      const dc = r.conciliacion.decision_cierre;
      if (dc !== "arrastrar") throw new Error(`decision_cierre arrastrar guardada. Esperado=arrastrar, actual=${JSON.stringify(dc)} type=${typeof dc}`);
      assertApprox(r.conciliacion.saldo_arrastrado, 350, "arrastrar: saldo_arrastrado = monto_real");
      assertApprox(r.conciliacion.monto_retiro, 0, "arrastrar: monto_retiro queda 0");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testSaldosOperativosRetirar() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const apertura = await abrirCaja(baseUrl, token, 0);
      const dest = await crearCuentaDestino(baseUrl, token, { nombre: "Destino Retirar", tipo_destino: "billetera", orden: 1 });

      const { response: rRetirar, data: dRetirar } = await requestJson(baseUrl, "POST", "/caja/conciliaciones/cuentas-destino", {
        caja_id: apertura.id,
        cuenta_destino_id: dest.id,
        saldo_inicial: 0,
        monto_sistema: 500,
        monto_real: 500,
        decision_cierre: "retirar",
        monto_retiro: 200
      }, token);
      if (!rRetirar.ok) throw new Error(`Retirar guard fallo HTTP ${rRetirar.status}: ${dRetirar?.message}`);
      const r = dRetirar;
      const dcR = r.conciliacion.decision_cierre;
      if (dcR !== "retirar") throw new Error(`decision_cierre retirar guardada. actual=${JSON.stringify(dcR)}`);
      assertApprox(r.conciliacion.monto_retiro, 200, "monto_retiro guardado");
      assertApprox(r.conciliacion.saldo_arrastrado, 300, "retirar: saldo_arrastrado = monto_real - monto_retiro");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testSaldosOperativosRetirarMasDeMonto() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const apertura = await abrirCaja(baseUrl, token, 0);
      const dest = await crearCuentaDestino(baseUrl, token, { nombre: "Destino RetirarFalla", tipo_destino: "billetera", orden: 1 });

      const { response, data } = await requestJson(baseUrl, "POST", "/caja/conciliaciones/cuentas-destino", {
        caja_id: apertura.id,
        cuenta_destino_id: dest.id,
        monto_sistema: 300,
        monto_real: 100,
        decision_cierre: "retirar",
        monto_retiro: 150
      }, token);
      if (response.ok) throw new Error("Retirar mas de monto_real debe fallar con error");
      if (response.status !== 400) throw new Error(`Retirar mas de monto_real debe devolver 400, recibido: ${response.status}`);
      if (!String(data?.message || "").includes("monto_retiro")) {
        throw new Error(`Mensaje de error debe mencionar monto_retiro, recibido: ${data?.message}`);
      }
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testSaldosOperativosUltimoSaldoArrastrado() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const dest = await crearCuentaDestino(baseUrl, token, { nombre: "Destino UltimoSaldo", tipo_destino: "billetera", orden: 1 });

      // sin caja cerrada → helper devuelve null
      const sinCaja = await getUltimoSaldoArrastrado(baseUrl, token, dest.id);
      assertEqual(sinCaja.saldo, null, "Sin caja cerrada, ultimo saldo arrastrado es null");

      // abrir, conciliar con arrastrar, cerrar
      const apertura = await abrirCaja(baseUrl, token, 0);
      await guardarConciliacionCuentaDestino(baseUrl, token, {
        caja_id: apertura.id,
        cuenta_destino_id: dest.id,
        saldo_inicial: 0,
        monto_sistema: 400,
        monto_real: 450,
        decision_cierre: "arrastrar"
      });
      await cerrarCaja(baseUrl, token, 0, 0, 0);

      const conCaja = await getUltimoSaldoArrastrado(baseUrl, token, dest.id);
      if (!conCaja.saldo) throw new Error("Debe devolver saldo no null despues de cerrar caja con conciliacion");
      assertApprox(conCaja.saldo.saldo_arrastrado, 450, "ultimo saldo arrastrado = monto_real cuando decision=arrastrar");
      const dcHelper = conCaja.saldo.decision_cierre;
      if (dcHelper !== "arrastrar") throw new Error(`decision_cierre correcta en helper. actual=${JSON.stringify(dcHelper)}`);
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testSaldosOperativosCuentaNullNoRompe() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const apertura = await abrirCaja(baseUrl, token, 0);

      // conciliacion global (cuenta_destino_id = null) con nuevos campos
      const r = await guardarConciliacionCuentaDestino(baseUrl, token, {
        caja_id: apertura.id,
        cuenta_destino_id: null,
        saldo_inicial: 1000,
        monto_sistema: 500,
        monto_real: 1600,
        decision_cierre: "retirar",
        monto_retiro: 100
      });
      assertApprox(r.conciliacion.saldo_inicial, 1000, "cuenta null: saldo_inicial guardado");
      // diferencia = 1600 - (1000 + 500) = 100
      assertApprox(r.conciliacion.diferencia, 100, "cuenta null: diferencia correcta con saldo_inicial");
      assertApprox(r.conciliacion.saldo_arrastrado, 1500, "cuenta null: saldo_arrastrado = monto_real - retiro");

      // helper con null
      await cerrarCaja(baseUrl, token, 0, 0, 0);
      const ultimo = await getUltimoSaldoArrastrado(baseUrl, token, null);
      assertApprox(ultimo.saldo?.saldo_arrastrado, 1500, "helper cuenta null devuelve ultimo saldo arrastrado");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

// ── Fórmula saldo_esperado_final = saldo_inicial + movimiento_neto ─────────────

async function testSaldosFormulaSaldoEsperadoFinal() {
  // saldo_inicial=1000, monto_sistema=300 (representa 500 ingresos − 200 egresos)
  // saldo_esperado_final = 1000 + 300 = 1300
  // saldo_real=1250 → diferencia = 1250 − 1300 = −50
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const apertura = await abrirCaja(baseUrl, token, 0);
      const dest = await crearCuentaDestino(baseUrl, token, { nombre: "Dest Formula Test", tipo_destino: "billetera", orden: 1 });
      const r = await guardarConciliacionCuentaDestino(baseUrl, token, {
        caja_id: apertura.id,
        cuenta_destino_id: dest.id,
        saldo_inicial: 1000,
        monto_sistema: 300,
        monto_real: 1250
      });
      assertApprox(r.conciliacion.saldo_inicial, 1000, "formula: saldo_inicial guardado");
      // saldo_esperado = 1000 + 300 = 1300
      assertApprox(r.conciliacion.diferencia, -50, "formula: diferencia = monto_real - (saldo_inicial + monto_sistema) = 1250-1300=-50");
      assertEqual(r.conciliacion.estado === "diferencia" ? 1 : 0, 1, "formula: estado diferencia cuando hay diferencia negativa");
      // con saldo_inicial = 0: saldo_esperado = solo movimiento
      const r2 = await guardarConciliacionCuentaDestino(baseUrl, token, {
        caja_id: apertura.id,
        cuenta_destino_id: dest.id,
        saldo_inicial: 0,
        monto_sistema: 300,
        monto_real: 300
      });
      assertApprox(r2.conciliacion.diferencia, 0, "formula: sin saldo_inicial, diferencia=0 cuando real==movimiento");
      assertEqual(r2.conciliacion.estado === "conciliado" ? 1 : 0, 1, "formula: conciliado cuando sin saldo_inicial y real==movimiento");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testSaldosArrastreNoCambiaDiferencia() {
  // La decision de arrastre no debe alterar la diferencia = real - (saldo_inicial + sistema)
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const apertura = await abrirCaja(baseUrl, token, 0);
      const dest = await crearCuentaDestino(baseUrl, token, { nombre: "Dest Arrastre Diff", tipo_destino: "billetera", orden: 1 });
      const { response, data } = await requestJson(baseUrl, "POST", "/caja/conciliaciones/cuentas-destino", {
        caja_id: apertura.id,
        cuenta_destino_id: dest.id,
        saldo_inicial: 500,
        monto_sistema: 200,
        monto_real: 600,
        decision_cierre: "arrastrar"
      }, token);
      if (!response.ok) throw new Error(`Arrastre diff fallo: ${data?.message}`);
      // diferencia = 600 - (500+200) = -100 independiente del arrastre
      assertApprox(data.conciliacion.diferencia, -100, "arrastre no cambia diferencia: real−(ini+sistema)=600-700=-100");
      assertApprox(data.conciliacion.saldo_arrastrado, 600, "arrastre: saldo_arrastrado = monto_real");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testSaldosRetirarDesdeSaldoRealNoEsperado() {
  // saldo_arrastrado = saldo_real - monto_retiro (NO saldo_esperado - monto_retiro)
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const apertura = await abrirCaja(baseUrl, token, 0);
      const dest = await crearCuentaDestino(baseUrl, token, { nombre: "Dest Retirar Real", tipo_destino: "billetera", orden: 1 });
      const { response, data } = await requestJson(baseUrl, "POST", "/caja/conciliaciones/cuentas-destino", {
        caja_id: apertura.id,
        cuenta_destino_id: dest.id,
        saldo_inicial: 1000,
        monto_sistema: 200,
        monto_real: 800,
        decision_cierre: "retirar",
        monto_retiro: 300
      }, token);
      if (!response.ok) throw new Error(`Retirar real fallo: ${data?.message}`);
      // saldo_esperado = 1200, diferencia = 800 - 1200 = -400
      // saldo_arrastrado = saldo_real - retiro = 800 - 300 = 500 (NO 1200-300=900)
      assertApprox(data.conciliacion.diferencia, -400, "retirar: diferencia usa saldo_real vs saldo_esperado");
      assertApprox(data.conciliacion.saldo_arrastrado, 500, "retirar: saldo_arrastrado = saldo_real - retiro");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

// ──────────────────────────────────────────────────────────────────────────────

async function testModificadorQuitarEdicionPendienteDiffCorrecto() {
  // Cubre el diff de stock en edición de pendiente con quitar:
  // pendiente sin quitar → edit +quitar → edit -quitar → cobrar
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      // receta=30 del componente, quitar=15
      const { componenteId, compuestoId, modId } = await setupQuitarTest(dbPath, baseUrl, token, 30, 15);
      const stockInicial = (await getProduct(baseUrl, token, componenteId)).stock;

      // 1. Pendiente SIN quitar → receta descuenta 30
      const pendiente = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test",
        tipo: "pendiente",
        identificador_pendiente: "Mesa Edit Quitar",
        items: [{
          producto_id: compuestoId,
          nombre_producto: "TEST Plato Con Quitar",
          cantidad: 1,
          precio_unitario: 500,
          modificadores: []
        }]
      }, token);
      if (!pendiente.response.ok) throw new Error(`Pendiente inicial fallo: ${pendiente.data?.message}`);
      const ventaId = pendiente.data.venta_id;
      assertEqual((await getProduct(baseUrl, token, componenteId)).stock, stockInicial,
        "Pendiente sin quitar no debe descontar stock fisico");
      let ajustes = await getAjustesPendientesStock(baseUrl, token, "pendiente");
      let ajuste = ajustes.find((item) => Number(item.venta_id) === Number(ventaId) && item.origen === "venta_receta");
      if (!ajuste) throw new Error("Pendiente sin quitar debe crear ajuste teorico");
      assertApprox(ajuste.cantidad_teorica, 30, "Pendiente sin quitar debe guardar consumo teorico 30");

      // 2. Editar AGREGANDO quitar 15 → diff snapshot old=[], new=[quitar 15] → restaura 15
      const edit1 = await requestJson(baseUrl, "PUT", `/ventas/${ventaId}/pendiente`, {
        identificador_pendiente: "Mesa Edit Quitar",
        items: [{
          producto_id: compuestoId,
          nombre_producto: "TEST Plato Con Quitar",
          cantidad: 1,
          precio_unitario: 500,
          modificadores: [{ modificador_id: modId, cantidad: 1 }]
        }]
      }, token);
      if (!edit1.response.ok) throw new Error(`Edicion agregando quitar fallo: ${edit1.data?.message}`);
      assertEqual((await getProduct(baseUrl, token, componenteId)).stock, stockInicial,
        "Editar pendiente agregando quitar no debe mover stock fisico");
      ajustes = await getAjustesPendientesStock(baseUrl, token, "pendiente");
      ajuste = ajustes.find((item) => Number(item.venta_id) === Number(ventaId) && item.origen === "venta_receta");
      if (!ajuste) throw new Error("Editar pendiente con quitar debe regenerar ajuste teorico");
      assertApprox(ajuste.cantidad_teorica, 15, "Editar pendiente con quitar debe dejar consumo teorico neto 15");

      // 3. Editar QUITANDO el modificador → diff old=[quitar 15], new=[] → deducta 15 de vuelta
      const edit2 = await requestJson(baseUrl, "PUT", `/ventas/${ventaId}/pendiente`, {
        identificador_pendiente: "Mesa Edit Quitar",
        items: [{
          producto_id: compuestoId,
          nombre_producto: "TEST Plato Con Quitar",
          cantidad: 1,
          precio_unitario: 500,
          modificadores: []
        }]
      }, token);
      if (!edit2.response.ok) throw new Error(`Edicion quitando quitar fallo: ${edit2.data?.message}`);
      assertEqual((await getProduct(baseUrl, token, componenteId)).stock, stockInicial,
        "Editar pendiente quitando el modificador no debe mover stock fisico");
      ajustes = await getAjustesPendientesStock(baseUrl, token, "pendiente");
      ajuste = ajustes.find((item) => Number(item.venta_id) === Number(ventaId) && item.origen === "venta_receta");
      if (!ajuste) throw new Error("Editar pendiente quitando modificador debe regenerar ajuste teorico");
      assertApprox(ajuste.cantidad_teorica, 30, "Editar pendiente quitando modificador debe volver a consumo teorico 30");

      // 4. Cobrar pendiente (composición final sin quitar) → no re-aplica stock extra
      const cobro = await requestJson(baseUrl, "POST", `/ventas/${ventaId}/cobrar`, {
        tipo_cobro: "efectivo"
      }, token);
      if (!cobro.response.ok) throw new Error(`Cobrar pendiente fallo: ${cobro.data?.message}`);
      assertEqual((await getProduct(baseUrl, token, componenteId)).stock, stockInicial,
        "Cobrar pendiente no debe descontar stock fisico");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testResumenAjustesPendientes() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());

    await withServer(dbPath, async (baseUrl) => {
      const adminToken = await login(baseUrl, "admin", "admin123");
      await requestJson(baseUrl, "POST", "/usuarios", {
        nombre: "Colaborador Resumen",
        usuario: "colaborador_resumen",
        password: "colaborador123",
        confirmar_password: "colaborador123",
        rol: "colaborador",
        activo: true
      }, adminToken);
      const colaboradorToken = await login(baseUrl, "colaborador_resumen", "colaborador123");

      // Sin pendientes devuelve 0
      const { response: r0, data: d0 } = await requestJson(baseUrl, "GET", "/stock/ajustes-pendientes/resumen", null, adminToken);
      if (!r0.ok) throw new Error(`Resumen inicial fallo: ${d0?.message || r0.status}`);
      assertEqual(d0.pendientes, 0, "Sin pendientes, pendientes debe ser 0");
      assertEqual(d0.aprobados_hoy, 0, "Sin pendientes, aprobados_hoy debe ser 0");
      assertEqual(d0.rechazados_hoy, 0, "Sin pendientes, rechazados_hoy debe ser 0");

      // Crear ajuste pendiente y verificar que NO modifica stock ni inserta movimiento
      const productoAntes = await getProduct(baseUrl, adminToken, 11);
      const movimientosAntes = await getMovimientosStock(baseUrl, adminToken, 11);
      const ajuste1 = await crearAjustePendienteStock(baseUrl, colaboradorToken, {
        producto_id: 11,
        tipo_movimiento: "ingreso",
        cantidad: 3,
        motivo: "TEST resumen pendiente"
      });
      const productoDespues = await getProduct(baseUrl, adminToken, 11);
      assertEqual(productoDespues.stock, productoAntes.stock, "Crear pendiente no debe modificar productos.stock");
      const movimientosDespues = await getMovimientosStock(baseUrl, adminToken, 11);
      assertEqual(movimientosDespues.length, movimientosAntes.length, "Crear pendiente no debe insertar movimientos_stock");

      // Resumen debe reflejar 1 pendiente
      const { response: r1, data: d1 } = await requestJson(baseUrl, "GET", "/stock/ajustes-pendientes/resumen", null, adminToken);
      if (!r1.ok) throw new Error(`Resumen tras crear fallo: ${d1?.message || r1.status}`);
      assertEqual(d1.pendientes, 1, "Debe contar 1 pendiente");

      // Crear segundo ajuste
      const ajuste2 = await crearAjustePendienteStock(baseUrl, colaboradorToken, {
        producto_id: 11,
        tipo_movimiento: "egreso",
        cantidad: 1,
        motivo: "TEST resumen pendiente 2"
      });
      const { data: d2 } = await requestJson(baseUrl, "GET", "/stock/ajustes-pendientes/resumen", null, adminToken);
      assertEqual(d2.pendientes, 2, "Debe contar 2 pendientes");

      // Aprobar ajuste1 => aprobados_hoy sube
      await requestJson(baseUrl, "POST", `/stock/ajustes-pendientes/${ajuste1.id}/aprobar`, {
        observaciones_admin: "OK test resumen"
      }, adminToken);
      const { data: d3 } = await requestJson(baseUrl, "GET", "/stock/ajustes-pendientes/resumen", null, adminToken);
      assertEqual(d3.pendientes, 1, "Pendientes baja a 1 tras aprobar");
      assertEqual(d3.aprobados_hoy, 1, "aprobados_hoy debe contar el aprobado de hoy");

      // Rechazar ajuste2 => rechazados_hoy sube
      await requestJson(baseUrl, "POST", `/stock/ajustes-pendientes/${ajuste2.id}/rechazar`, {
        observaciones_admin: "No corresponde test"
      }, adminToken);
      const { data: d4 } = await requestJson(baseUrl, "GET", "/stock/ajustes-pendientes/resumen", null, adminToken);
      assertEqual(d4.pendientes, 0, "Pendientes baja a 0 tras rechazar");
      assertEqual(d4.aprobados_hoy, 1, "aprobados_hoy se conserva");
      assertEqual(d4.rechazados_hoy, 1, "rechazados_hoy debe contar el rechazado de hoy");

      // Colaborador sin permiso no puede consultar el resumen
      const { response: rForbidden } = await requestJson(baseUrl, "GET", "/stock/ajustes-pendientes/resumen", null, colaboradorToken);
      assertEqual(rForbidden.status, 403, "Colaborador no debe consultar resumen de ajustes");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testTiendaIngredientesVisibles() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const adminToken = await login(baseUrl, "admin", "admin123");
      const stockInicial = (await getProduct(baseUrl, adminToken, 11)).stock;

      // Admin agrega ingredientes visibles al producto 11 (precio_venta=100)
      const { response: rIng1, data: dIng1 } = await requestJson(
        baseUrl, "POST", "/productos/11/ingredientes-visibles",
        { nombre: "Cebolla", incluido_por_defecto: true, permite_quitar: true, permite_extra: false, precio_extra: 0, orden: 1 },
        adminToken
      );
      if (!rIng1.ok) throw new Error(`No se pudo crear ingrediente Cebolla: ${dIng1?.message}`);
      const ingCebollaId = dIng1.id;

      const { response: rIng2, data: dIng2 } = await requestJson(
        baseUrl, "POST", "/productos/11/ingredientes-visibles",
        { nombre: "Queso extra", incluido_por_defecto: false, permite_quitar: false, permite_extra: true, precio_extra: 250, orden: 2 },
        adminToken
      );
      if (!rIng2.ok) throw new Error(`No se pudo crear ingrediente Queso extra: ${dIng2?.message}`);
      const ingQuesoId = dIng2.id;

      // GET /tienda/publica/productos muestra tiene_ingredientes_visibles=true
      const { data: prodData } = await requestJson(baseUrl, "GET", "/tienda/publica/productos");
      const todosProds = Array.isArray(prodData) ? prodData : (prodData.productos || []);
      const prod = todosProds.find(p => p.id === 11);
      if (!prod) throw new Error("Producto 11 no encontrado en tienda publica");
      if (!prod.tiene_ingredientes_visibles) throw new Error("tiene_ingredientes_visibles debe ser true");

      // GET /tienda/publica/productos/:id/ingredientes devuelve lista
      const { response: rIngsPublic, data: ingsPublic } = await requestJson(baseUrl, "GET", "/tienda/publica/productos/11/ingredientes");
      if (!rIngsPublic.ok) throw new Error(`Error al cargar ingredientes publicos: ${rIngsPublic.status}`);
      if (!Array.isArray(ingsPublic) || ingsPublic.length !== 2) throw new Error(`Ingredientes publicos debe tener 2, actual=${ingsPublic.length}`);
      const cebolla = ingsPublic.find(i => i.id === ingCebollaId);
      if (!cebolla || !cebolla.permite_quitar || cebolla.permite_extra) throw new Error("Cebolla con propiedades incorrectas");

      // Pedido con quitar ingrediente → precio sin cambio (quitar no suma)
      const { response: rPed1, data: dPed1 } = await requestJson(baseUrl, "POST", "/tienda/publica/pedidos", {
        cliente_nombre: "Test Quitar",
        items: [{ producto_id: 11, cantidad: 1, modificadores: [], ingredientes: [{ ingrediente_id: ingCebollaId, tipo: "quitar" }] }]
      });
      if (!rPed1.ok) throw new Error(`Pedido con quitar fallo: ${dPed1?.message}`);
      if (Math.abs(dPed1.total_estimado - 100) > 0.01) throw new Error(`total con quitar debe ser 100, actual=${dPed1.total_estimado}`);

      const { data: listaP1 } = await requestJson(baseUrl, "GET", "/tienda/pedidos", null, adminToken);
      const ped1 = listaP1.find(p => p.codigo_publico === dPed1.codigo_publico);
      const { data: detP1 } = await requestJson(baseUrl, "GET", `/tienda/pedidos/${ped1.id}`, null, adminToken);
      const item1 = detP1.items[0];
      if (Math.abs(item1.precio_unitario_snapshot - 100) > 0.01) throw new Error(`precio_unitario con quitar debe ser 100, actual=${item1.precio_unitario_snapshot}`);
      if (!Array.isArray(item1.ingredientes) || item1.ingredientes.length !== 1) throw new Error("Ingrediente quitar no almacenado en item");
      if (item1.ingredientes[0].tipo !== "quitar") throw new Error(`tipo incorrecto: ${item1.ingredientes[0].tipo}`);
      if (item1.ingredientes[0].nombre !== "Cebolla") throw new Error(`nombre snapshot incorrecto: ${item1.ingredientes[0].nombre}`);
      if (item1.ingredientes[0].precio_extra !== 0) throw new Error(`precio_extra quitar debe ser 0, actual=${item1.ingredientes[0].precio_extra}`);
      if (!Array.isArray(item1.modificadores) || item1.modificadores.length !== 0) throw new Error("modificadores debe estar vacio en pedido con ingredientes");

      // Pedido con extra ingrediente con precio → precio bakeado desde DB (no confiar en frontend)
      const { response: rPed2, data: dPed2 } = await requestJson(baseUrl, "POST", "/tienda/publica/pedidos", {
        cliente_nombre: "Test Extra",
        items: [{ producto_id: 11, cantidad: 2, modificadores: [], ingredientes: [{ ingrediente_id: ingQuesoId, tipo: "extra" }] }]
      });
      if (!rPed2.ok) throw new Error(`Pedido con extra fallo: ${dPed2?.message}`);
      const totalEsperado = Number(((100 + 250) * 2).toFixed(2));
      if (Math.abs(dPed2.total_estimado - totalEsperado) > 0.01) throw new Error(`total con extra incorrecto: ${dPed2.total_estimado} vs ${totalEsperado}`);

      const { data: listaP2 } = await requestJson(baseUrl, "GET", "/tienda/pedidos", null, adminToken);
      const ped2 = listaP2.find(p => p.codigo_publico === dPed2.codigo_publico);
      const { data: detP2 } = await requestJson(baseUrl, "GET", `/tienda/pedidos/${ped2.id}`, null, adminToken);
      const item2 = detP2.items[0];
      if (Math.abs(item2.precio_unitario_snapshot - 350) > 0.01) throw new Error(`precio_unitario con extra debe ser 350, actual=${item2.precio_unitario_snapshot}`);
      if (!Array.isArray(item2.ingredientes) || item2.ingredientes.length !== 1) throw new Error("Ingrediente extra no almacenado");
      if (item2.ingredientes[0].precio_extra !== 250) throw new Error(`precio_extra snapshot incorrecto: ${item2.ingredientes[0].precio_extra}`);

      // ingrediente_id inválido → 400
      const { response: rInvalid } = await requestJson(baseUrl, "POST", "/tienda/publica/pedidos", {
        cliente_nombre: "Test Invalid",
        items: [{ producto_id: 11, cantidad: 1, modificadores: [], ingredientes: [{ ingrediente_id: 99999, tipo: "extra" }] }]
      });
      if (rInvalid.status !== 400) throw new Error(`Ingrediente inválido debe dar 400, actual=${rInvalid.status}`);

      // tipo quitar en ingrediente que no permite_quitar → 400
      const { response: rNoPermite } = await requestJson(baseUrl, "POST", "/tienda/publica/pedidos", {
        cliente_nombre: "Test No Permite",
        items: [{ producto_id: 11, cantidad: 1, modificadores: [], ingredientes: [{ ingrediente_id: ingQuesoId, tipo: "quitar" }] }]
      });
      if (rNoPermite.status !== 400) throw new Error(`Quitar en no-permite_quitar debe dar 400, actual=${rNoPermite.status}`);

      // tipo extra en ingrediente que no permite_extra → 400
      const { response: rNoExtra } = await requestJson(baseUrl, "POST", "/tienda/publica/pedidos", {
        cliente_nombre: "Test No Extra",
        items: [{ producto_id: 11, cantidad: 1, modificadores: [], ingredientes: [{ ingrediente_id: ingCebollaId, tipo: "extra" }] }]
      });
      if (rNoExtra.status !== 400) throw new Error(`Extra en no-permite_extra debe dar 400, actual=${rNoExtra.status}`);

      // tipo inválido → 400
      const { response: rTipoInvalido } = await requestJson(baseUrl, "POST", "/tienda/publica/pedidos", {
        cliente_nombre: "Test Tipo",
        items: [{ producto_id: 11, cantidad: 1, modificadores: [], ingredientes: [{ ingrediente_id: ingCebollaId, tipo: "invalido" }] }]
      });
      if (rTipoInvalido.status !== 400) throw new Error(`tipo inválido debe dar 400, actual=${rTipoInvalido.status}`);

      // Stock no cambia por pedidos tienda (solo ventas descuentan stock)
      const stockTras = (await getProduct(baseUrl, adminToken, 11)).stock;
      if (stockTras !== stockInicial) throw new Error(`Stock no debe cambiar por pedidos tienda: ${stockTras} vs ${stockInicial}`);

      // Admin CRUD: GET con todos=1 muestra ambos
      const { response: rListaAdmin, data: listaAdmin } = await requestJson(
        baseUrl, "GET", "/productos/11/ingredientes-visibles?todos=1", null, adminToken
      );
      if (!rListaAdmin.ok) throw new Error(`Error al listar ingredientes admin: ${rListaAdmin.status}`);
      if (!Array.isArray(listaAdmin) || listaAdmin.length !== 2) throw new Error(`Lista admin debe tener 2, actual=${listaAdmin.length}`);

      // Admin CRUD: PUT actualiza ingrediente
      const { response: rUpdate, data: dUpdate } = await requestJson(
        baseUrl, "PUT", `/productos/11/ingredientes-visibles/${ingCebollaId}`,
        { nombre: "Cebolla actualizada", incluido_por_defecto: true, permite_quitar: true, permite_extra: false, precio_extra: 0, orden: 1, activo: true },
        adminToken
      );
      if (!rUpdate.ok) throw new Error(`Error al actualizar ingrediente: ${dUpdate?.message}`);
      if (dUpdate.nombre !== "Cebolla actualizada") throw new Error(`Nombre actualizado incorrecto: ${dUpdate.nombre}`);

      // Admin CRUD: DELETE (soft) — elimina cebolla
      const { response: rDel } = await requestJson(
        baseUrl, "DELETE", `/productos/11/ingredientes-visibles/${ingCebollaId}`, null, adminToken
      );
      if (!rDel.ok) throw new Error(`Error al eliminar ingrediente: ${rDel.status}`);

      // Después de eliminar: GET sin todos → 1 (queso activo)
      const { data: listaTras } = await requestJson(baseUrl, "GET", "/productos/11/ingredientes-visibles", null, adminToken);
      if (!Array.isArray(listaTras) || listaTras.length !== 1) throw new Error(`Lista tras eliminar debe tener 1, actual=${listaTras?.length}`);
      // Con todos=1 → 2 (uno inactivo)
      const { data: listaTodosTras } = await requestJson(baseUrl, "GET", "/productos/11/ingredientes-visibles?todos=1", null, adminToken);
      if (!Array.isArray(listaTodosTras) || listaTodosTras.length !== 2) throw new Error(`Lista todos tras eliminar debe tener 2, actual=${listaTodosTras?.length}`);
      const cebollaElim = listaTodosTras.find(i => i.id === ingCebollaId);
      if (!cebollaElim || cebollaElim.activo) throw new Error("Cebolla debe estar inactiva tras DELETE");

      // Con cebolla inactiva, tiene_ingredientes_visibles sigue true (queso activo)
      const { data: prodData2 } = await requestJson(baseUrl, "GET", "/tienda/publica/productos");
      const todosProds2 = Array.isArray(prodData2) ? prodData2 : (prodData2.productos || []);
      const prod2 = todosProds2.find(p => p.id === 11);
      if (!prod2.tiene_ingredientes_visibles) throw new Error("tiene_ingredientes_visibles debe seguir true con queso activo");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testTiendaConvertirVenta() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const adminToken = await login(baseUrl, "admin", "admin123");

      // Crear usuarios de prueba
      await requestJson(baseUrl, "POST", "/usuarios", {
        nombre: "Encargado Test",
        usuario: "encargado_tienda",
        password: "encargado123",
        confirmar_password: "encargado123",
        rol: "encargado",
        activo: true
      }, adminToken);
      await requestJson(baseUrl, "POST", "/usuarios", {
        nombre: "Colaborador Test",
        usuario: "colaborador_tienda",
        password: "colaborador123",
        confirmar_password: "colaborador123",
        rol: "colaborador",
        activo: true
      }, adminToken);
      const encargadoToken = await login(baseUrl, "encargado_tienda", "encargado123");
      const colaboradorToken = await login(baseUrl, "colaborador_tienda", "colaborador123");

      const stockInicial = (await getProduct(baseUrl, adminToken, 11)).stock;

      // Crear pedido via endpoint público (sin auth)
      const { response: rPedido, data: dPedido } = await requestJson(baseUrl, "POST", "/tienda/publica/pedidos", {
        cliente_nombre: "Test Convert",
        items: [{ producto_id: 11, cantidad: 2, modificadores: [] }]
      });
      if (!rPedido.ok) throw new Error(`No se pudo crear pedido público: ${dPedido?.message || rPedido.status}`);
      const codigoPublico = dPedido.codigo_publico;

      // Obtener id del pedido recién creado
      const { data: listaPedidos } = await requestJson(baseUrl, "GET", "/tienda/pedidos", null, adminToken);
      const pedido = listaPedidos.find(p => p.codigo_publico === codigoPublico);
      if (!pedido) throw new Error("Pedido creado no aparece en listado interno");
      const pedidoId = pedido.id;

      // Test: no se puede convertir en estado 'recibido'
      const { response: rConvRecibido } = await requestJson(baseUrl, "POST", `/tienda/pedidos/${pedidoId}/convertir-venta`, {}, adminToken);
      if (rConvRecibido.status !== 409) throw new Error(`Convertir pedido recibido debe devolver 409, actual=${rConvRecibido.status}`);

      // Avanzar a 'listo': aceptar → listo
      const { response: rAcep } = await requestJson(baseUrl, "POST", `/tienda/pedidos/${pedidoId}/aceptar`, {}, adminToken);
      if (!rAcep.ok) throw new Error("No se pudo aceptar el pedido");
      const { response: rListo } = await requestJson(baseUrl, "POST", `/tienda/pedidos/${pedidoId}/listo`, {}, adminToken);
      if (!rListo.ok) throw new Error("No se pudo marcar listo el pedido");

      // Test: colaborador no puede convertir
      const { response: rColabConv } = await requestJson(baseUrl, "POST", `/tienda/pedidos/${pedidoId}/convertir-venta`, {}, colaboradorToken);
      if (rColabConv.status !== 403) throw new Error(`Colaborador no puede convertir: esperado 403, actual=${rColabConv.status}`);

      // Test: admin convierte exitosamente
      const { response: rConv, data: dConv } = await requestJson(baseUrl, "POST", `/tienda/pedidos/${pedidoId}/convertir-venta`, {}, adminToken);
      if (!rConv.ok) throw new Error(`Convertir fallo: ${dConv?.message || rConv.status}`);
      if (!dConv.ok) throw new Error("Respuesta no incluye ok: true");
      if (!dConv.venta_id) throw new Error("Respuesta no incluye venta_id");
      if (dConv.codigo_publico !== codigoPublico) throw new Error(`codigo_publico incorrecto: ${dConv.codigo_publico} vs ${codigoPublico}`);

      // Verificar que la venta creada existe como pendiente con identificador_pendiente = codigo_publico
      const { data: ventas } = await requestJson(baseUrl, "GET", "/ventas/pendientes", null, adminToken);
      const ventaCreada = ventas.find(v => v.id === dConv.venta_id);
      if (!ventaCreada) throw new Error("Venta pendiente no encontrada tras convertir");
      if (ventaCreada.tipo !== "pendiente") throw new Error(`tipo incorrecto: ${ventaCreada.tipo}`);
      if (ventaCreada.estado !== "pendiente") throw new Error(`estado incorrecto: ${ventaCreada.estado}`);
      if (ventaCreada.identificador_pendiente !== codigoPublico) throw new Error(`identificador_pendiente incorrecto: ${ventaCreada.identificador_pendiente}`);

      // Verificar que el pedido tienda quedó en estado convertido_venta con venta_id
      const { data: detallePedido } = await requestJson(baseUrl, "GET", `/tienda/pedidos/${pedidoId}`, null, adminToken);
      if (detallePedido.estado !== "convertido_venta") throw new Error(`estado pedido incorrecto: ${detallePedido.estado}`);
      assertEqual(Number(detallePedido.venta_id), dConv.venta_id, "Pedido tienda conserva venta_id");

      // Test: no se puede convertir dos veces
      const { response: rDoble } = await requestJson(baseUrl, "POST", `/tienda/pedidos/${pedidoId}/convertir-venta`, {}, adminToken);
      if (rDoble.status !== 409) throw new Error(`Convertir dos veces debe devolver 409, actual=${rDoble.status}`);

      // Verificar descuento de stock: debe ser exactamente 1 descuento (cantidad=2)
      const stockTras = (await getProduct(baseUrl, adminToken, 11)).stock;
      assertEqual(stockTras, stockInicial - 2, "Stock descontado exactamente 1 vez (cantidad=2)");

      // Test: encargado puede convertir un segundo pedido
      const { response: rPedido2, data: dPedido2 } = await requestJson(baseUrl, "POST", "/tienda/publica/pedidos", {
        cliente_nombre: "Test Encargado",
        items: [{ producto_id: 11, cantidad: 1, modificadores: [] }]
      });
      if (!rPedido2.ok) throw new Error(`No se pudo crear segundo pedido: ${dPedido2?.message}`);
      const { data: lista2 } = await requestJson(baseUrl, "GET", "/tienda/pedidos", null, encargadoToken);
      const pedido2 = lista2.find(p => p.codigo_publico === dPedido2.codigo_publico);
      await requestJson(baseUrl, "POST", `/tienda/pedidos/${pedido2.id}/aceptar`, {}, encargadoToken);
      await requestJson(baseUrl, "POST", `/tienda/pedidos/${pedido2.id}/listo`, {}, encargadoToken);
      const { response: rConv2 } = await requestJson(baseUrl, "POST", `/tienda/pedidos/${pedido2.id}/convertir-venta`, {}, encargadoToken);
      if (!rConv2.ok) throw new Error(`Encargado no pudo convertir pedido listo: ${rConv2.status}`);
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testCompuestosLegacyGetStockFisicoManejaStock1() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const catId = await crearCategoria(baseUrl, token, "TEST LegacyMS1");
      const ingId = await crearProducto(baseUrl, token, {
        nombre: "TEST Ing LegacyMS1", categoria: "TEST LegacyMS1", categoria_id: catId,
        stock: 100, maneja_stock: true
      });
      const compId = await crearProducto(baseUrl, token, {
        nombre: "TEST Comp LegacyMS1", categoria: "TEST LegacyMS1", categoria_id: catId,
        tipo: "compuesto", maneja_stock: true, stock: 7, precio_venta: 300,
        componentes: [{ producto_id: ingId, cantidad: 1 }], costos_extra: []
      });
      const { response, data } = await requestJson(baseUrl, "GET", `/productos_compuestos/${compId}`, null, token);
      if (!response.ok) throw new Error(`GET /productos_compuestos maneja_stock=1 fallo: ${data?.message}`);
      assertEqual(data.stock, 7, "Legacy GET maneja_stock=1: stock debe ser el fisico real (7)");
      assertEqual(data.stock_fisico, 7, "Legacy GET maneja_stock=1: stock_fisico debe ser 7");
      assertEqual(data.stock_disponible, 7, "Legacy GET maneja_stock=1: stock_disponible debe usar stock fisico, no componentes");
      assertEqual(data.stock_vendible_calculado, 7, "Legacy GET maneja_stock=1: stock_vendible_calculado debe ser 7");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testCompuestosLegacyGetStockPorComponentesManejaStock0() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const catId = await crearCategoria(baseUrl, token, "TEST LegacyMS0");
      const ingId = await crearProducto(baseUrl, token, {
        nombre: "TEST Ing LegacyMS0", categoria: "TEST LegacyMS0", categoria_id: catId,
        stock: 10, maneja_stock: true
      });
      const compId = await crearProducto(baseUrl, token, {
        nombre: "TEST Comp LegacyMS0", categoria: "TEST LegacyMS0", categoria_id: catId,
        tipo: "compuesto", maneja_stock: false, stock: 0, precio_venta: 200,
        componentes: [{ producto_id: ingId, cantidad: 2 }], costos_extra: []
      });
      const { response, data } = await requestJson(baseUrl, "GET", `/productos_compuestos/${compId}`, null, token);
      if (!response.ok) throw new Error(`GET /productos_compuestos maneja_stock=0 fallo: ${data?.message}`);
      assertEqual(data.stock, 0, "Legacy GET maneja_stock=0: stock debe ser 0 (sin stock propio)");
      assertEqual(data.stock_fisico, 0, "Legacy GET maneja_stock=0: stock_fisico debe ser 0");
      // 10 unidades de ingrediente / 2 por porcion = 5 porciones disponibles
      assertEqual(data.stock_disponible, 5, "Legacy GET maneja_stock=0: stock_disponible debe calcularse por componentes (10/2=5)");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testCompuestosLegacyEndpointSDManejaStock1() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const catId = await crearCategoria(baseUrl, token, "TEST LegacySD1");
      const ingId = await crearProducto(baseUrl, token, {
        nombre: "TEST Ing LegacySD1", categoria: "TEST LegacySD1", categoria_id: catId,
        stock: 100, maneja_stock: true
      });
      const compId = await crearProducto(baseUrl, token, {
        nombre: "TEST Comp LegacySD1", categoria: "TEST LegacySD1", categoria_id: catId,
        tipo: "compuesto", maneja_stock: true, stock: 9, precio_venta: 300,
        componentes: [{ producto_id: ingId, cantidad: 1 }], costos_extra: []
      });
      const { response, data } = await requestJson(baseUrl, "GET", `/productos_compuestos/${compId}/stock_disponible`, null, token);
      if (!response.ok) throw new Error(`/stock_disponible maneja_stock=1 fallo: ${data?.message}`);
      assertEqual(data.stock_disponible, 9, "Legacy /stock_disponible maneja_stock=1: debe devolver stock fisico (9)");
      assertEqual(data.stock_vendible_calculado, 9, "Legacy /stock_disponible maneja_stock=1: stock_vendible_calculado debe ser 9");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testCompuestosLegacyEndpointSDManejaStock0() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const catId = await crearCategoria(baseUrl, token, "TEST LegacySD0");
      const ingId = await crearProducto(baseUrl, token, {
        nombre: "TEST Ing LegacySD0", categoria: "TEST LegacySD0", categoria_id: catId,
        stock: 15, maneja_stock: true
      });
      const compId = await crearProducto(baseUrl, token, {
        nombre: "TEST Comp LegacySD0", categoria: "TEST LegacySD0", categoria_id: catId,
        tipo: "compuesto", maneja_stock: false, stock: 0, precio_venta: 200,
        componentes: [{ producto_id: ingId, cantidad: 3 }], costos_extra: []
      });
      const { response, data } = await requestJson(baseUrl, "GET", `/productos_compuestos/${compId}/stock_disponible`, null, token);
      if (!response.ok) throw new Error(`/stock_disponible maneja_stock=0 fallo: ${data?.message}`);
      // 15 / 3 = 5 porciones
      assertEqual(data.stock_disponible, 5, "Legacy /stock_disponible maneja_stock=0: debe calcularse por componentes (15/3=5)");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testBatchLegacyLimitadoAManeja0RendimientoMayor1() {
  // compuesto + maneja_stock=1 + rendimiento>1 = semielaborado con stock propio, NO batch legacy
  // compuesto + maneja_stock=0 + rendimiento>1 = batch legacy (calcula por componentes * rendimiento)
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const catId = await crearCategoria(baseUrl, token, "TEST BatchLegacy");
      const ingId = await crearProducto(baseUrl, token, {
        nombre: "TEST Ing BatchLegacy", categoria: "TEST BatchLegacy", categoria_id: catId,
        stock: 100, maneja_stock: true
      });
      const semiId = await crearProducto(baseUrl, token, {
        nombre: "TEST Semi BatchLegacy", categoria: "TEST BatchLegacy", categoria_id: catId,
        tipo: "compuesto", maneja_stock: true, stock: 3, rendimiento_receta: 5, precio_venta: 300,
        componentes: [{ producto_id: ingId, cantidad: 2 }], costos_extra: []
      });
      const batchId = await crearProducto(baseUrl, token, {
        nombre: "TEST Batch BatchLegacy", categoria: "TEST BatchLegacy", categoria_id: catId,
        tipo: "compuesto", maneja_stock: false, stock: 0, rendimiento_receta: 5, precio_venta: 200,
        componentes: [{ producto_id: ingId, cantidad: 2 }], costos_extra: []
      });
      const { data: semiData } = await requestJson(baseUrl, "GET", `/productos_compuestos/${semiId}`, null, token);
      assertEqual(semiData.stock, 3, "Batch legacy: semielaborado maneja_stock=1 stock debe ser fisico (3), no 0");
      assertEqual(semiData.stock_fisico, 3, "Batch legacy: semielaborado maneja_stock=1 stock_fisico debe ser 3");
      const { data: batchData } = await requestJson(baseUrl, "GET", `/productos_compuestos/${batchId}`, null, token);
      assertEqual(batchData.stock, 0, "Batch legacy: receta maneja_stock=0 stock debe ser 0");
      // 100 stock / 2 por batch = 50 batches * rendimiento 5 = 250
      assertEqual(batchData.stock_disponible, 250, "Batch legacy: receta maneja_stock=0 stock_disponible debe ser 250 (100/2*5)");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testProduccionExcluyeCombos() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const catId = await crearCategoria(baseUrl, token, "TEST ProdExcluyeCombo");
      const ingId = await crearProducto(baseUrl, token, {
        nombre: "TEST Ing ProdExcluye", categoria: "TEST ProdExcluyeCombo", categoria_id: catId,
        stock: 100, maneja_stock: true
      });
      // Compuesto normal con stock propio: debe aparecer en producibles
      const compId = await crearProducto(baseUrl, token, {
        nombre: "TEST Comp Producible", categoria: "TEST ProdExcluyeCombo", categoria_id: catId,
        tipo: "compuesto", maneja_stock: true, stock: 5, precio_venta: 300,
        componentes: [{ producto_id: ingId, cantidad: 1 }], costos_extra: []
      });
      // Combo real: no debe aparecer en producibles
      const comboId = await crearProducto(baseUrl, token, {
        nombre: "TEST Combo Promo", categoria: "TEST ProdExcluyeCombo", categoria_id: catId,
        tipo: "simple", es_combo: true, maneja_stock: false, stock: 0, precio_venta: 200
      });
      const { response, data } = await requestJson(baseUrl, "GET", "/produccion/productos", null, token);
      if (!response.ok) throw new Error(`GET /produccion/productos fallo: ${data?.message}`);
      const ids = data.map((p) => Number(p.id));
      if (!ids.includes(Number(compId))) throw new Error("Compuesto normal debe aparecer en producibles");
      if (ids.includes(Number(comboId))) throw new Error("Combo (es_combo=1) NO debe aparecer en producibles");
      // Intentar registrar produccion de combo: debe fallar 400
      const { response: rProd } = await requestJson(baseUrl, "POST", "/produccion", {
        producto_id: comboId, cantidad_producida: 1, responsable: "test"
      }, token);
      if (rProd.ok) throw new Error("POST /produccion de combo debio fallar con 400");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

function setConfigStockNegativo(valor) {
  return [
    `INSERT INTO configuracion_global (clave, valor, seccion, actualizado_en)
     VALUES ('stock_permitir_negativo', '${valor ? "true" : "false"}', 'stock', datetime('now'))
     ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, seccion = excluded.seccion, actualizado_en = excluded.actualizado_en`
  ];
}
function habilitarStockNegativo() { return setConfigStockNegativo(true); }
function deshabilitarStockNegativo() { return setConfigStockNegativo(false); }

async function testStockNegativoNoCreaPendienteSiConfigFalse() {
  // Con stock_permitir_negativo=false (default), la venta falla y no crea ajuste pendiente
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, [...resetOperationalDataStatements(), deshabilitarStockNegativo()]);
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const catId = await crearCategoria(baseUrl, token, "TEST SNConfigFalse");
      const pid = await crearProducto(baseUrl, token, {
        nombre: "TEST Prod SNFalse", categoria: "TEST SNConfigFalse", categoria_id: catId,
        stock: 3, maneja_stock: true, precio_venta: 100
      });
      // Intentar vender 5 unidades con stock=3 — debe fallar
      const { response } = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test", tipo: "normal", tipo_cobro: "efectivo",
        items: [{ producto_id: pid, nombre_producto: "TEST Prod SNFalse", cantidad: 5, precio_unitario: 100 }]
      }, token);
      if (response.ok) throw new Error("La venta no debio registrarse con stock insuficiente y config=false");
      const ajustesPendientes = await allSql(dbPath,
        `SELECT id FROM stock_ajustes_pendientes WHERE producto_id = ? AND origen = 'stock_negativo_venta'`, [pid]
      );
      assertEqual(ajustesPendientes.length, 0, "Config false: no debe crearse ajuste pendiente por stock negativo");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testStockNegativoCreaPendienteConConfigTrue() {
  // Con stock_permitir_negativo=true, la venta se registra y crea ajuste pendiente
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, [...resetOperationalDataStatements(), habilitarStockNegativo()]);
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const catId = await crearCategoria(baseUrl, token, "TEST SNConfigTrue");
      const pid = await crearProducto(baseUrl, token, {
        nombre: "TEST Prod SNTrue", categoria: "TEST SNConfigTrue", categoria_id: catId,
        stock: 3, maneja_stock: true, precio_venta: 100
      });
      // Vender 6 con stock=3 → stock queda -3
      const { response, data } = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test", tipo: "normal", tipo_cobro: "efectivo",
        items: [{ producto_id: pid, nombre_producto: "TEST Prod SNTrue", cantidad: 6, precio_unitario: 100 }]
      }, token);
      if (!response.ok) throw new Error(`Venta con stock_permitir_negativo=true fallo: ${data?.message}`);
      const ventaId = data.venta_id;
      // Verificar stock negativo
      const prodActual = await allSql(dbPath, "SELECT stock FROM productos WHERE id = ?", [pid]);
      assertApprox(prodActual[0].stock, -3, "Stock debe ser -3 tras la venta", 0.01);
      // Verificar ajuste pendiente creado
      const ajustes = await allSql(dbPath,
        `SELECT cantidad, tipo_movimiento, venta_id, estado FROM stock_ajustes_pendientes
         WHERE producto_id = ? AND origen = 'stock_negativo_venta'`, [pid]
      );
      assertEqual(ajustes.length, 1, "Debe existir exactamente un ajuste pendiente por stock negativo");
      if (ajustes[0].tipo_movimiento !== "ingreso") throw new Error(`Ajuste stock negativo debe ser tipo ingreso, actual=${ajustes[0].tipo_movimiento}`);
      assertApprox(ajustes[0].cantidad, 3, "Ajuste debe registrar el deficit (3)", 0.01);
      assertEqual(Number(ajustes[0].venta_id), Number(ventaId), "Ajuste debe vincular al venta_id correcto");
      if (ajustes[0].estado !== "pendiente") throw new Error(`Ajuste debe estar pendiente, actual=${ajustes[0].estado}`);
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testStockExactoNoCreaPendiente() {
  // Venta exacta hasta stock=0 no crea ajuste pendiente
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, [...resetOperationalDataStatements(), habilitarStockNegativo()]);
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const catId = await crearCategoria(baseUrl, token, "TEST SNExacto");
      const pid = await crearProducto(baseUrl, token, {
        nombre: "TEST Prod SNExacto", categoria: "TEST SNExacto", categoria_id: catId,
        stock: 5, maneja_stock: true, precio_venta: 100
      });
      // Vender exactamente el stock disponible (5 = 5)
      const { response, data } = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test", tipo: "normal", tipo_cobro: "efectivo",
        items: [{ producto_id: pid, nombre_producto: "TEST Prod SNExacto", cantidad: 5, precio_unitario: 100 }]
      }, token);
      if (!response.ok) throw new Error(`Venta exacta fallo: ${data?.message}`);
      const ajustes = await allSql(dbPath,
        `SELECT id FROM stock_ajustes_pendientes WHERE producto_id = ? AND origen = 'stock_negativo_venta'`, [pid]
      );
      assertEqual(ajustes.length, 0, "Stock exacto en 0 no debe crear ajuste pendiente");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testStockNegativoNoDuplicaPendiente() {
  // Dos ventas del mismo producto, ambas dejan stock negativo → dos ajustes, uno por venta
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, [...resetOperationalDataStatements(), habilitarStockNegativo()]);
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await abrirCaja(baseUrl, token, 1000);
      const catId = await crearCategoria(baseUrl, token, "TEST SNDuplicado");
      const pid = await crearProducto(baseUrl, token, {
        nombre: "TEST Prod SNDup", categoria: "TEST SNDuplicado", categoria_id: catId,
        stock: 2, maneja_stock: true, precio_venta: 100
      });
      // Venta 1: vende 5 con stock=2 → stock -3
      const { response: r1 } = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test", tipo: "normal", tipo_cobro: "efectivo",
        items: [{ producto_id: pid, nombre_producto: "TEST Prod SNDup", cantidad: 5, precio_unitario: 100 }]
      }, token);
      if (!r1.ok) throw new Error("Venta 1 fallo");
      // Venta 2: vende 2 más con stock=-3 → stock -5
      const { response: r2 } = await requestJson(baseUrl, "POST", "/ventas", {
        usuario: "test", tipo: "normal", tipo_cobro: "efectivo",
        items: [{ producto_id: pid, nombre_producto: "TEST Prod SNDup", cantidad: 2, precio_unitario: 100 }]
      }, token);
      if (!r2.ok) throw new Error("Venta 2 fallo");
      const ajustes = await allSql(dbPath,
        `SELECT id, venta_id FROM stock_ajustes_pendientes
         WHERE producto_id = ? AND origen = 'stock_negativo_venta' ORDER BY id ASC`, [pid]
      );
      // Debe haber exactamente 2 ajustes, uno por cada venta (no duplicados por misma venta)
      assertEqual(ajustes.length, 2, "Deben existir 2 ajustes pendientes, uno por cada venta con stock negativo");
      if (Number(ajustes[0].venta_id) === Number(ajustes[1].venta_id)) {
        throw new Error("Los dos ajustes no deben pertenecer a la misma venta");
      }
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testUsaReglasPersonalizadas() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const suf = Date.now();
      // 1. Sin usa_reglas_personalizadas → default 0
      const { data: d1, response: r1 } = await requestJson(baseUrl, "POST", "/clientes", {
        nombre: "TEST ReglasDefault", dni_cuit: `rp-def-${suf}`, activo: true
      }, token);
      if (!r1.ok) throw new Error(`Crear cliente default fallo: ${d1?.message}`);
      if (Number(d1.cliente?.usa_reglas_personalizadas) !== 0) throw new Error(`Default debe ser 0, actual=${d1.cliente?.usa_reglas_personalizadas}`);
      // 2. Con usa_reglas_personalizadas=1 → persiste
      const { data: d2, response: r2 } = await requestJson(baseUrl, "POST", "/clientes", {
        nombre: "TEST ReglasCustom", dni_cuit: `rp-cus-${suf}`, activo: true, usa_reglas_personalizadas: true
      }, token);
      if (!r2.ok) throw new Error(`Crear cliente custom fallo: ${d2?.message}`);
      if (Number(d2.cliente?.usa_reglas_personalizadas) !== 1) throw new Error(`usa_reglas_personalizadas=1 debe persistir, actual=${d2.cliente?.usa_reglas_personalizadas}`);
      // 3. Editar y cambiar a 0 → persiste
      const { data: d3, response: r3 } = await requestJson(baseUrl, "PUT", `/clientes/${d2.cliente?.id}`, {
        nombre: "TEST ReglasCustom", dni_cuit: `rp-cus-${suf}`, activo: true, usa_reglas_personalizadas: false
      }, token);
      if (!r3.ok) throw new Error(`Update a 0 fallo: ${d3?.message}`);
      if (Number(d3.cliente?.usa_reglas_personalizadas) !== 0) throw new Error(`Update a 0 debe persistir, actual=${d3.cliente?.usa_reglas_personalizadas}`);
      // 4. Valor inválido → normaliza a 0
      const { data: d4, response: r4 } = await requestJson(baseUrl, "POST", "/clientes", {
        nombre: "TEST ReglasInvalido", dni_cuit: `rp-inv-${suf}`, activo: true, usa_reglas_personalizadas: "invalido"
      }, token);
      if (!r4.ok) throw new Error(`Crear con valor inválido fallo: ${d4?.message}`);
      if (Number(d4.cliente?.usa_reglas_personalizadas) !== 0) throw new Error(`Valor inválido debe normalizar a 0, actual=${d4.cliente?.usa_reglas_personalizadas}`);
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testRequiereAutorizacion() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      await requestJson(baseUrl, "POST", "/usuarios", {
        nombre: "Colab Req Auth", usuario: "colab_req_auth",
        password: "colab123", confirmar_password: "colab123",
        rol: "colaborador", activo: true
      }, token);
      const colaboradorToken = await login(baseUrl, "colab_req_auth", "colab123");
      const suf = Date.now();
      // Cliente con requiere_autorizacion=1
      const { data: dReq } = await requestJson(baseUrl, "POST", "/clientes", {
        nombre: "TEST RequiereAuth", dni_cuit: `req-auth-${suf}`,
        habilita_cuenta_corriente: true, activo: true,
        requiere_autorizacion: true, limite_fiado: 0
      }, token);
      const reqId = dReq.cliente?.id;
      // Cliente sin requiere_autorizacion=0
      const { data: dNoReq } = await requestJson(baseUrl, "POST", "/clientes", {
        nombre: "TEST NoRequiereAuth", dni_cuit: `no-req-${suf}`,
        habilita_cuenta_corriente: true, activo: true,
        requiere_autorizacion: false, limite_fiado: 0
      }, token);
      const noReqId = dNoReq.cliente?.id;
      // Test 1: requiere_autorizacion=1 + colaborador → 403
      const { response: r1 } = await requestJson(baseUrl, "POST", `/clientes/${reqId}/venta-cuenta`, {
        total: 50, concepto: "Test req auth colab", autorizar_excedido: false
      }, colaboradorToken);
      if (r1.status !== 403) throw new Error(`Colaborador con requiere_autorizacion=1 debe dar 403, dio ${r1.status}`);
      // Test 2: requiere_autorizacion=1 + admin → OK
      const { response: r2 } = await requestJson(baseUrl, "POST", `/clientes/${reqId}/venta-cuenta`, {
        total: 50, concepto: "Test req auth admin", autorizar_excedido: false
      }, token);
      if (!r2.ok) throw new Error(`Admin con requiere_autorizacion=1 debe OK, dio ${r2.status}`);
      // Test 3: requiere_autorizacion=0 + colaborador → OK (sin limitaciones de auth)
      const { response: r3 } = await requestJson(baseUrl, "POST", `/clientes/${noReqId}/venta-cuenta`, {
        total: 50, concepto: "Test no req colab", autorizar_excedido: false
      }, colaboradorToken);
      if (!r3.ok) throw new Error(`Colaborador sin requiere_autorizacion debe OK, dio ${r3.status}`);
      // Test 4: requiere_autorizacion=0 + colaborador + autorizar_excedido=true → 403 sigue igual (rol check)
      const { response: r4 } = await requestJson(baseUrl, "POST", `/clientes/${noReqId}/venta-cuenta`, {
        total: 50, concepto: "Test colab autorizar excedido", autorizar_excedido: true
      }, colaboradorToken);
      if (r4.status !== 403) throw new Error(`Colaborador con autorizar_excedido=true debe seguir dando 403, dio ${r4.status}`);
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testPermiteExcedente() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      // Crear colaborador para test de rol
      await requestJson(baseUrl, "POST", "/usuarios", {
        nombre: "Colab Excedente Test", usuario: "colab_exc_test",
        password: "colab123", confirmar_password: "colab123",
        rol: "colaborador", activo: true
      }, token);
      const colaboradorToken = await login(baseUrl, "colab_exc_test", "colab123");
      const suf = Date.now();
      // Test 1: permite_excedente=0, supera límite, sin autorización → 409
      const { data: d1 } = await requestJson(baseUrl, "POST", "/clientes", {
        nombre: "TEST ExcNO", dni_cuit: `exc-no-${suf}`,
        habilita_cuenta_corriente: true, activo: true, permite_excedente: false, limite_fiado: 100
      }, token);
      const { response: rv1 } = await requestJson(baseUrl, "POST", `/clientes/${d1.cliente?.id}/venta-cuenta`, {
        total: 200, concepto: "Test sin excedente", autorizar_excedido: false
      }, token);
      if (rv1.status !== 409) throw new Error(`Sin permite_excedente y sin autorizar debe dar 409, dio ${rv1.status}`);
      // Test 2: permite_excedente=1, supera límite, sin autorización → OK
      const { data: d2 } = await requestJson(baseUrl, "POST", "/clientes", {
        nombre: "TEST ExcSI", dni_cuit: `exc-si-${suf}`,
        habilita_cuenta_corriente: true, activo: true, permite_excedente: true, limite_fiado: 100
      }, token);
      const { response: rv2 } = await requestJson(baseUrl, "POST", `/clientes/${d2.cliente?.id}/venta-cuenta`, {
        total: 200, concepto: "Test con excedente", autorizar_excedido: false
      }, token);
      if (!rv2.ok) throw new Error(`Con permite_excedente=1 y sin autorizar debe OK, dio ${rv2.status}`);
      // Test 3: permite_excedente=0, colaborador + autorizar_excedido=true → 403
      const { response: rv3 } = await requestJson(baseUrl, "POST", `/clientes/${d1.cliente?.id}/venta-cuenta`, {
        total: 50, concepto: "Test colab autorizar", autorizar_excedido: true
      }, colaboradorToken);
      if (rv3.status !== 403) throw new Error(`Colaborador con autorizar_excedido=true debe dar 403, dio ${rv3.status}`);
      // Test 4: permite_excedente=0, admin + autorizar_excedido=true → OK (no 403 por rol)
      const { response: rv4 } = await requestJson(baseUrl, "POST", `/clientes/${d1.cliente?.id}/venta-cuenta`, {
        total: 50, concepto: "Test admin autorizar", autorizar_excedido: true
      }, token);
      if (rv4.status === 403) throw new Error(`Admin con autorizar_excedido=true no debe dar 403 por rol`);
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testPerfilCliente() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const suf = Date.now();
      // 1. perfil_cliente=normal → persiste correctamente
      const { response: r1, data: d1 } = await requestJson(baseUrl, "POST", "/clientes", {
        nombre: "TEST Perfil Normal", dni_cuit: `pnorm-${suf}`, activo: true, perfil_cliente: "normal"
      }, token);
      if (!r1.ok) throw new Error(`Perfil normal fallo: ${d1?.message}`);
      if (d1.cliente?.perfil_cliente !== "normal") throw new Error(`Esperado perfil=normal, actual=${d1.cliente?.perfil_cliente}`);
      // 2. perfil_cliente=empleado → persiste correctamente
      const { response: r2, data: d2 } = await requestJson(baseUrl, "POST", "/clientes", {
        nombre: "TEST Perfil Empleado", dni_cuit: `pemp-${suf}`, activo: true, perfil_cliente: "empleado"
      }, token);
      if (!r2.ok) throw new Error(`Perfil empleado fallo: ${d2?.message}`);
      if (d2.cliente?.perfil_cliente !== "empleado") throw new Error(`Esperado perfil=empleado, actual=${d2.cliente?.perfil_cliente}`);
      // 3. perfil_cliente=empresa → persiste correctamente
      const { response: r3, data: d3 } = await requestJson(baseUrl, "POST", "/clientes", {
        nombre: "TEST Perfil Empresa", dni_cuit: `pempresa-${suf}`, activo: true, perfil_cliente: "empresa"
      }, token);
      if (!r3.ok) throw new Error(`Perfil empresa fallo: ${d3?.message}`);
      if (d3.cliente?.perfil_cliente !== "empresa") throw new Error(`Esperado perfil=empresa, actual=${d3.cliente?.perfil_cliente}`);
      // 4. actualizar perfil → guarda correctamente
      const clienteId = d1.cliente?.id;
      const { response: r4, data: d4 } = await requestJson(baseUrl, "PUT", `/clientes/${clienteId}`, {
        nombre: "TEST Perfil Normal", dni_cuit: `pnorm-${suf}`, activo: true, perfil_cliente: "empresa"
      }, token);
      if (!r4.ok) throw new Error(`Update perfil fallo: ${d4?.message}`);
      if (d4.cliente?.perfil_cliente !== "empresa") throw new Error(`Update perfil: esperado empresa, actual=${d4.cliente?.perfil_cliente}`);
      // 5. valor inválido → normaliza a "normal"
      const { response: r5, data: d5 } = await requestJson(baseUrl, "POST", "/clientes", {
        nombre: "TEST Perfil Invalido", dni_cuit: `pinv-${suf}`, activo: true, perfil_cliente: "invalido_xyz"
      }, token);
      if (!r5.ok) throw new Error(`Perfil inválido fallo crear: ${d5?.message}`);
      if (d5.cliente?.perfil_cliente !== "normal") throw new Error(`Valor inválido debe normalizar a normal, actual=${d5.cliente?.perfil_cliente}`);
      // GET /clientes devuelve perfil_cliente
      const { data: lista } = await requestJson(baseUrl, "GET", "/clientes?include_inactive=1", null, token);
      const clienteEnLista = (lista || []).find(c => Number(c.id) === Number(d2.cliente?.id));
      if (!clienteEnLista) throw new Error("Cliente empleado no encontrado en listado");
      if (clienteEnLista.perfil_cliente !== "empleado") throw new Error(`GET /clientes debe devolver perfil_cliente=empleado, actual=${clienteEnLista.perfil_cliente}`);
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testDniCuitUnico() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const dni = `20300111222-${Date.now()}`;
      // Primer cliente con ese DNI → debe crear OK
      const { response: r1, data: d1 } = await requestJson(baseUrl, "POST", "/clientes", {
        nombre: "Cliente DNI Test A", dni_cuit: dni, activo: true
      }, token);
      if (!r1.ok) throw new Error(`Primer cliente con DNI debe crearse OK, dio ${r1.status}: ${d1?.message}`);
      // Segundo cliente con mismo DNI → debe fallar (409)
      const { response: r2 } = await requestJson(baseUrl, "POST", "/clientes", {
        nombre: "Cliente DNI Test B", dni_cuit: dni, activo: true
      }, token);
      if (r2.status !== 409) throw new Error(`Segundo cliente con mismo DNI debe dar 409, dio ${r2.status}`);
      // Múltiples clientes sin DNI deben permitirse
      const { response: rA } = await requestJson(baseUrl, "POST", "/clientes", {
        nombre: "Cliente Sin DNI A", dni_cuit: "", activo: true
      }, token);
      const { response: rB } = await requestJson(baseUrl, "POST", "/clientes", {
        nombre: "Cliente Sin DNI B", dni_cuit: "", activo: true
      }, token);
      // Sin DNI vacío puede rechazarse por obligatorio — solo verificamos que no es error de unicidad (409)
      if (rA.status === 409) throw new Error("Cliente sin DNI no debe fallar por unicidad");
      if (rB.status === 409) throw new Error("Segundo cliente sin DNI no debe fallar por unicidad");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testClienteSuspendido() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      // Crear cliente activo normal
      const { data: cd } = await requestJson(baseUrl, "POST", "/clientes", {
        nombre: "Cliente Suspendido Test", dni_cuit: `susp-${Date.now()}`,
        habilita_cuenta_corriente: true, activo: true, suspendido: false
      }, token);
      const clienteId = cd.cliente?.id;
      if (!clienteId) throw new Error("No se pudo crear cliente para test suspendido");
      // GET /clientes devuelve suspendido
      const { data: lista } = await requestJson(baseUrl, "GET", "/clientes?include_inactive=1", null, token);
      const clienteEnLista = lista.find(c => Number(c.id) === Number(clienteId));
      if (!clienteEnLista) throw new Error("Cliente no encontrado en lista");
      if (clienteEnLista.suspendido === undefined) throw new Error("Campo suspendido ausente en GET /clientes");
      assertEqual(Number(clienteEnLista.suspendido), 0, "Cliente no suspendido debe tener suspendido=0");
      // Suspender el cliente
      const { response: rEdit, data: editData } = await requestJson(baseUrl, "PUT", `/clientes/${clienteId}`, {
        nombre: "Cliente Suspendido Test", dni_cuit: `susp-${clienteId}`,
        habilita_cuenta_corriente: true, activo: true, suspendido: true
      }, token);
      if (!rEdit.ok) throw new Error(`PUT /clientes suspender fallo: ${editData?.message}`);
      assertEqual(Number(editData.cliente?.suspendido), 1, "Cliente editado debe tener suspendido=1");
      // Venta a cuenta con cliente suspendido → debe dar 403
      const { response: rVenta } = await requestJson(baseUrl, "POST", `/clientes/${clienteId}/venta-cuenta`, {
        total: 50, concepto: "Test suspendido", autorizar_excedido: false
      }, token);
      if (rVenta.status !== 403) throw new Error(`Venta a cuenta con cliente suspendido debe dar 403, dio ${rVenta.status}`);
      // Verificar estado frontend: suspendido=1 → "Suspendida"
      const html = fs.readFileSync(path.join(ROOT, "frontend", "clientes.html"), "utf8");
      if (!html.includes('"Suspendida"')) throw new Error("Estado 'Suspendida' no encontrado en clientes.html");
      if (!html.includes('n(c.suspendido)===1')) throw new Error("Condición suspendido===1 no encontrada en estadoCliente");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testEstadoPorVencerFrontend() {
  // Test file-based: verifica la lógica de "Por vencer" en el código fuente
  const html = fs.readFileSync(path.join(ROOT, "frontend", "clientes.html"), "utf8");
  if (!html.includes('"Por vencer"')) throw new Error("Estado 'Por vencer' no encontrado en clientes.html");
  if (!html.includes("dias*.7")) throw new Error("Regla del 70% (dias*.7) no encontrada en estadoCliente");
  if (!html.includes("antig<dias")) throw new Error("Condición antig<dias (antes del vencimiento) no encontrada");
  if (!html.includes('|| e === "Por vencer" ? "warn"')) throw new Error("estadoClass no asigna 'warn' a 'Por vencer'");
  // Simular la lógica JS directamente en Node para verificar umbrales
  const n=v=>Number(v||0);
  const antiguedad=(primera_deuda)=>{if(!primera_deuda)return 0;return Math.floor((Date.now()-new Date(primera_deuda).getTime())/(86400000))};
  const estadoCliente=(c)=>{
    if(n(c.activo)!==1)return "Inactivo";
    if(n(c.deuda_actual)<=0)return "Sin deuda";
    const dias=n(c.dias_vencimiento||30);
    const antig=c._antig??0; // usamos _antig para simular
    if(antig>=dias*.7&&antig<dias)return "Por vencer";
    if(antig>dias)return "Vencido";
    return "OK";
  };
  // dias=30, antig=21 (70%) → Por vencer
  if(estadoCliente({activo:1,deuda_actual:100,dias_vencimiento:30,_antig:21})!=="Por vencer")
    throw new Error("antig=21, dias=30 debe dar 'Por vencer'");
  // dias=30, antig=30 NO es vencido (>30 lo es), antig=31 sí
  if(estadoCliente({activo:1,deuda_actual:100,dias_vencimiento:30,_antig:31})!=="Vencido")
    throw new Error("antig=31, dias=30 debe dar 'Vencido'");
  // dias=30, antig=29 → Por vencer (>=21 y <30)
  if(estadoCliente({activo:1,deuda_actual:100,dias_vencimiento:30,_antig:29})!=="Por vencer")
    throw new Error("antig=29, dias=30 debe dar 'Por vencer'");
  // dias=30, antig=10 (antes del 70%) → OK
  if(estadoCliente({activo:1,deuda_actual:100,dias_vencimiento:30,_antig:10})!=="OK")
    throw new Error("antig=10, dias=30 debe dar 'OK' (no llega al 70%)");
}

async function testAutorizarExcedenteRequiereRolSuperior() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const adminToken = await login(baseUrl, "admin", "admin123");
      // Crear colaborador
      await requestJson(baseUrl, "POST", "/usuarios", {
        nombre: "Colab CC Test", usuario: "colab_cc_test",
        password: "colab123", confirmar_password: "colab123",
        rol: "colaborador", activo: true
      }, adminToken);
      const colaboradorToken = await login(baseUrl, "colab_cc_test", "colab123");
      // Crear cliente con límite de $100
      const { data: cd } = await requestJson(baseUrl, "POST", "/clientes", {
        nombre: "Cliente Limite Test", dni_cuit: `lim-${Date.now()}`,
        limite_fiado: 100, habilita_cuenta_corriente: true, activo: true
      }, adminToken);
      const clienteId = cd.cliente?.id;
      if (!clienteId) throw new Error("No se pudo crear cliente para test de excedente");
      // Colaborador + autorizar_excedido=true → debe dar 403
      const { response: r403 } = await requestJson(baseUrl, "POST", `/clientes/${clienteId}/venta-cuenta`, {
        total: 200, concepto: "Test excedente colab", autorizar_excedido: true
      }, colaboradorToken);
      if (r403.status !== 403) throw new Error(`Colaborador con autorizar_excedido=true debe dar 403, dio ${r403.status}`);
      // Admin + autorizar_excedido=true → NO debe dar 403 por rol
      const { response: rAdmin } = await requestJson(baseUrl, "POST", `/clientes/${clienteId}/venta-cuenta`, {
        total: 200, concepto: "Test excedente admin", autorizar_excedido: true
      }, adminToken);
      if (rAdmin.status === 403) throw new Error(`Admin con autorizar_excedido=true NO debe dar 403 por rol`);
      // Colaborador sin autorizar + dentro del límite → no debe dar 403
      const { response: rDentro } = await requestJson(baseUrl, "POST", `/clientes/${clienteId}/venta-cuenta`, {
        total: 50, concepto: "Test dentro limite", autorizar_excedido: false
      }, colaboradorToken);
      if (rDentro.status === 403) throw new Error("Colaborador sin autorizar_excedido no debe dar 403");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testGuardarComponentesDuplicadosSumaYDedup() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const catId = await crearCategoria(baseUrl, token, "TEST DedupComp");
      const ingId = await crearProducto(baseUrl, token, {
        nombre: "TEST Ing DedupComp", categoria: "TEST DedupComp", categoria_id: catId,
        stock: 100, maneja_stock: true
      });
      // mismo producto_id dos veces: 2 + 3 = 5
      const compId = await crearProducto(baseUrl, token, {
        nombre: "TEST Comp DedupComp", categoria: "TEST DedupComp", categoria_id: catId,
        tipo: "compuesto", maneja_stock: false, stock: 0, precio_venta: 200,
        componentes: [{ producto_id: ingId, cantidad: 2 }, { producto_id: ingId, cantidad: 3 }],
        costos_extra: []
      });
      const { response, data } = await requestJson(baseUrl, "GET", `/productos_compuestos/${compId}`, null, token);
      if (!response.ok) throw new Error(`GET /productos_compuestos fallo: ${data?.message}`);
      assertEqual(data.componentes.length, 1, "Dedup: POST con duplicados debe guardar una sola fila");
      assertApprox(data.componentes[0].cantidad, 5, "Dedup: cantidad debe sumar los duplicados (2+3=5)", 0.01);
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testConsolidacionComponentesDuplicadosExistentes() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, resetOperationalDataStatements());
    let compId, ingId;
    // Fase 1: crear producto via API
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const catId = await crearCategoria(baseUrl, token, "TEST ConsExist");
      ingId = await crearProducto(baseUrl, token, {
        nombre: "TEST Ing ConsExist", categoria: "TEST ConsExist", categoria_id: catId,
        stock: 100, maneja_stock: true
      });
      compId = await crearProducto(baseUrl, token, {
        nombre: "TEST Comp ConsExist", categoria: "TEST ConsExist", categoria_id: catId,
        tipo: "compuesto", maneja_stock: false, stock: 0, precio_venta: 200,
        componentes: [{ producto_id: ingId, cantidad: 2 }], costos_extra: []
      });
    });
    // Fase 2: insertar duplicado directamente en DB (simula deuda historica)
    await runSql(dbPath,
      `INSERT INTO producto_componentes (producto_compuesto_id, producto_id, cantidad) VALUES (?, ?, ?)`,
      [compId, ingId, 3]
    );
    const antes = await allSql(dbPath,
      `SELECT id FROM producto_componentes WHERE producto_compuesto_id = ? AND producto_id = ?`,
      [compId, ingId]
    );
    if (antes.length !== 2) throw new Error(`Setup: se esperaban 2 filas duplicadas, hay ${antes.length}`);
    // Fase 3: reiniciar servidor — consolidarComponentesDuplicados corre en startup
    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const { response, data } = await requestJson(baseUrl, "GET", `/productos_compuestos/${compId}`, null, token);
      if (!response.ok) throw new Error(`GET fallo: ${data?.message}`);
      assertEqual(data.componentes.length, 1, "Consolidacion startup: debe haber 1 componente tras limpiar duplicados");
      assertApprox(data.componentes[0].cantidad, 5, "Consolidacion startup: cantidad debe ser suma (2+3=5)", 0.01);
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testTipoAyudaSinUnidadesHardcodeado() {
  const html = fs.readFileSync(path.join(ROOT, "frontend", "productos.html"), "utf8");
  if (html.includes("||0} unidades</strong>")) {
    throw new Error("tipoAyuda todavia tiene 'unidades' hardcodeado en actualizarResumenFraccionado");
  }
}

async function testLogsTemporalesRemovidos() {
  const html = fs.readFileSync(path.join(ROOT, "frontend", "productos.html"), "utf8");
  if (html.includes('console.count("cargarFormulario")')) throw new Error("Log temporal console.count no fue removido");
  if (html.includes('"COMPONENTES API"')) throw new Error("Log temporal COMPONENTES API no fue removido");
  if (html.includes('"ADD COMPONENTE"')) throw new Error("Log temporal ADD COMPONENTE no fue removido");
}

(async () => {
  await testRecetaSinStockBloqueaMovimientoManual();
  await testRecetaSinStockComoComponenteNoDescuentaDirecto();
  await testVentaRecetaSinStockGeneraAjustePendiente();
  await testAnularRecetaSinStockCancelaPendienteSinReponerAprobado();
  await testPermisosColaborador();
  await testFinanzasResumenBackendV1();
  await testProduccionV1DominioSeparado();
  await testConsumoTeoricoAgrupadoPorInsumo();
  await testAjustesPendientesStockInfraestructura();
  await testAjustePendienteRequiereStockVer();
  await testAjustesPendientesAprobacionYRechazo();
  await testReconciliarAjustesPendientesStock();
  await testResolverAjustePendienteConVenta();
  await testAjusteVentaRecetaConVentaIdEsAccionable();
  await testResolverAjustePendienteConCuentaLocal();
  await testResumenAjustesPendientes();
  await testClientesTipoClienteClasificacion();
  await testClientesHistorialProductosComprados();
  await testClientesDeudaActualizadaComparacionSegura();
  await testClientesAplicarRecalculoDeudaControlado();
  await testVentaContadoImpactaStockYCaja();
  await testPendienteNoImpactaCajaHastaCobro();
  await testAnularPendienteReponeStock();
  await testAnularVentaCobradaReponeStock();
  await testProductoCompuestoGeneraAjusteTeorico();
  await testProveedorGuardaImpactoContable();
  await testPagoRegistradoImpactaCaja();
  await testPagoPendienteNoImpactaCaja();
  await testPagoMixtoGuardaMontosYCaja();
  await testPagoCalculaIvaCreditoFiscal();
  await testTipoPagoEfectivoPrevioTiposPago();
  await testTiposPagoEndpointDefaultsCompatibles();
  await testTipoPagoDebitoPrevioTiposPago();
  await testTipoPagoTransferenciaPrevioTiposPago();
  await testTipoPagoMixtoPrevioTiposPago();
  await testTipoPagoPendientePrevioTiposPago();
  await testCierreConservaTipoPagoStringEnPagosSnapshot();
  await testPagoHeredaCategoriaPagoDesdeImpactoProveedor();
  await testCierreGuardaSnapshotsParseables();
  await testCierreInmutableAnteVentaPosterior();
  await testCierreInmutableAntePagoPosterior();
  await testCajaCerradaNoRecibeOperacionPosterior();
  await testSimpleConRendimientoDescuentaStockFisicoUnaVez();
  await testCompuestoConComponenteFraccionadoDescuentaCantidadUsada();
  await testCompuestoConStockPropioNoDuplicaDescuento();
  await testAnularVentaCompuestaCancelaAjusteTeorico();
  await testMovimientoManualRegistraStockAnteriorYNuevo();
  await testResumenReporteDevuelveClaves();
  await testResumenReporteExcluyeVentasAnuladas();
  await testResumenReporteExcluyePagosPendientes();
  await testResumenReporteCalculaBalanceGeneral();
  await testResumenReporteCalculaTicketPromedio();
  await testResumenReporteRespetaFiltroFechas();
  await testReporteStockValorizaSoloStockFisico();
  await testConfiguracionCodigoAutomaticoProductos();
  await testProductosMasVendidosDevuelveClaves();
  await testProductosMasVendidosExcluyeVentasAnuladas();
  await testProductosMasVendidosOrdenaPorCantidad();
  await testProductosMasVendidosRespetaFiltroFechas();
  await testProductosMasVendidosRespetaLimite();
  await testModificadoresEtapa0SchemaYReporteNeutro();
  await testCuentaCorrienteConservaDetalleHistoricoSinModificadores();
  await testComboActualGeneraAjusteTeoricoSinModificadores();
  await testModificadoresEtapa1BackendAislado();
  await testModificadoresEtapa2AVentasNormales();
  await testModificadoresEtapa2AProteccionesAuditoria();
  await testModificadoresEtapa2BPendientesNuevas();
  await testModificadoresEtapa2CEdicionPendientes();
  await testModificadoresApiEdicionActivacionYSnapshots();
  await testProveedoresPagosDevuelveClaves();
  await testProveedoresPagosSumaTotalPagado();
  await testProveedoresPagosSumaTotalPendiente();
  await testProveedoresPagosCalculaIvaSoloRegistrados();
  await testProveedoresPagosRespetaFiltroFechas();
  await testProveedoresPagosSinProveedor();
  await testTipoPagoCreaNuevo();
  await testTipoPagoNoDuplicaCodigo();
  await testTipoPagoModificaNombreYOrden();
  await testTiposPagoRecargosYCuotasCrud();
  await testVentasAplicanRecargosMetodosPago();
  await testVentasCuotasYPendientesNoDuplicanRecargo();
  await testRecargoPersistenteEnVentas();
  await testTipoPagoDesactiva();
  await testTipoPagoReactiva();
  await testTipoPagoGetExcluyeInactivos();
  await testTipoPagoGetTodosIncluyeInactivos();
  await testCuentasCobroEtapa2PagosYVentas();
  await testConfiguracionCuentasCobroValidacionesOperativas();
  await testMercadoPagoPointIntentosInfraestructura();
  await testCuentasDestinoEtapa3AInfraestructura();
  await testCajaResumenPorCuentaDestino();
  await testConciliacionManualPorCuentaDestino();
  await testCajaResumenPorCuentaCobro();
  await testConciliacionManualPorCuentaCobro();
  await testReporteCuentasCobro();
  await testVentasPorDiaDevuelveClaves();
  await testVentasPorDiaExcluyeAnuladas();
  await testVentasPorDiaAgrupaVentas();
  await testVentasPorDiaRespetaFiltroFechas();
  await testVentasPorDiaOrdenaAscendente();
  await testCompuestoCostoRendimientoControl();
  await testCompuestoCostoRendimiento5();
  await testCompuestoCostoExtrasConRendimiento();
  await testCompuestoUsaCostoUnitarioDeComponenteFraccionado();
  await testModificadorQuitarSeCreaEnCompuesto();
  await testModificadorQuitarVentaCompuestoDescuentaMenos();
  await testModificadorQuitarComponenteNoEnRecetaFalla400();
  await testModificadorQuitarCantidadSuperiorBaseCapea();
  await testModificadorQuitarAnulacionReponeExacto();
  await testModificadorQuitarPendienteDescuentaMenos();
  await testModificadorQuitarEdicionPendienteDiffCorrecto();
  await testSaldosOperativosLegacySigueFuncionando();
  await testSaldosOperativosConSaldoInicial();
  await testSaldosOperativosArrastrar();
  await testSaldosOperativosRetirar();
  await testSaldosOperativosRetirarMasDeMonto();
  await testSaldosOperativosUltimoSaldoArrastrado();
  await testSaldosOperativosCuentaNullNoRompe();
  await testSaldosFormulaSaldoEsperadoFinal();
  await testSaldosArrastreNoCambiaDiferencia();
  await testSaldosRetirarDesdeSaldoRealNoEsperado();
  await testTiendaIngredientesVisibles();
  await testTiendaConvertirVenta();
  await testCompuestosLegacyGetStockFisicoManejaStock1();
  await testCompuestosLegacyGetStockPorComponentesManejaStock0();
  await testCompuestosLegacyEndpointSDManejaStock1();
  await testCompuestosLegacyEndpointSDManejaStock0();
  await testBatchLegacyLimitadoAManeja0RendimientoMayor1();
  await testProduccionExcluyeCombos();
  await testUsaReglasPersonalizadas();
  await testRequiereAutorizacion();
  await testPermiteExcedente();
  await testPerfilCliente();
  await testDniCuitUnico();
  await testClienteSuspendido();
  await testEstadoPorVencerFrontend();
  await testAutorizarExcedenteRequiereRolSuperior();
  await testStockNegativoNoCreaPendienteSiConfigFalse();
  await testStockNegativoCreaPendienteConConfigTrue();
  await testStockExactoNoCreaPendiente();
  await testStockNegativoNoDuplicaPendiente();
  await testGuardarComponentesDuplicadosSumaYDedup();
  await testConsolidacionComponentesDuplicadosExistentes();
  await testTipoAyudaSinUnidadesHardcodeado();
  await testLogsTemporalesRemovidos();
  console.log("OK stock, ventas, caja y permisos basicos");
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
