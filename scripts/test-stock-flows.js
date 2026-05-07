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

async function prepareDb(dbPath, statements) {
  for (const [sql, params = []] of statements) {
    await runSql(dbPath, sql, params);
  }
}

function resetOperationalDataStatements() {
  return [
    ["DELETE FROM caja_arqueos"],
    ["DELETE FROM caja_movimientos"],
    ["DELETE FROM caja_aperturas"],
    ["DELETE FROM pagos_cuenta_corriente"],
    ["DELETE FROM detalle_ventas"],
    ["DELETE FROM ventas"],
    ["DELETE FROM pagos"],
    ["UPDATE productos SET stock = 80, precio_venta = 100, costo_final = 50, precio_compra = 50 WHERE id = 11"],
    [
      `INSERT INTO configuracion_global (clave, valor, seccion, actualizado_en)
       VALUES ('autorizacion_clave_maestra', '"1234"', 'usuarios_permisos', datetime('now'))
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

async function getMovimientosStock(baseUrl, token, productoId) {
  const { response, data } = await requestJson(baseUrl, "GET", `/productos/${productoId}/movimientos-stock`, null, token);
  if (!response.ok) throw new Error(`No se pudo obtener movimientos de stock: ${response.status}`);
  return data;
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

async function testBatchManual() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, [
      ["UPDATE productos SET stock = 5000 WHERE id = 3"],
      ["UPDATE productos SET stock = 22 WHERE id = 4"]
    ]);

    await withServer(dbPath, async (baseUrl) => {
      const token = await login(baseUrl, "admin", "admin123");
      const beforeTomate = (await getProduct(baseUrl, token, 3)).stock;
      const beforeSalsa = (await getProduct(baseUrl, token, 4)).stock;
      const result = await requestJson(baseUrl, "POST", "/productos/4/movimientos-stock", {
        tipo_movimiento: "egreso",
        cantidad: beforeSalsa,
        motivo: "TEST batch counter manual",
        usuario: "test"
      }, token);

      if (!result.response.ok) throw new Error(`Egreso batch counter fallo: ${result.data?.message || result.response.status}`);
      assertEqual((await getProduct(baseUrl, token, 4)).stock, 25, "Salsa lista debe reponer a 25");
      assertEqual((await getProduct(baseUrl, token, 3)).stock, beforeTomate - 2000, "Tomate perita debe consumir 2000gr");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

async function testBatchComoComponente() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await prepareDb(dbPath, [
      ["UPDATE productos SET stock = 5000 WHERE id IN (3, 6)"],
      ["UPDATE productos SET stock = 1 WHERE id IN (4, 7)"],
      ["UPDATE productos SET stock = 71 WHERE id = 9"]
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
      assertEqual((await getProduct(baseUrl, token, 4)).stock, 25, "Salsa lista componente debe reponer batch");
      assertEqual((await getProduct(baseUrl, token, 7)).stock, 100, "Pre Pizza componente debe reponer batch");
      assertEqual((await getProduct(baseUrl, token, 3)).stock, 3000, "Tomate perita debe consumir 2000gr");
      assertEqual((await getProduct(baseUrl, token, 6)).stock, 4800, "Muzzarella Cremac debe consumir 200gr");
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
      await requestJson(baseUrl, "POST", "/usuarios", {
        nombre: "Colaborador Test",
        usuario: "colaborador_test",
        password: "colaborador123",
        confirmar_password: "colaborador123",
        rol: "colaborador",
        activo: true
      }, adminToken);

      const colaboradorToken = await login(baseUrl, "colaborador_test", "colaborador123");
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

async function testProductoCompuestoDescuentaComponentes() {
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

      assertEqual((await getProduct(baseUrl, token, 11)).stock, 74, "Vender 2 compuestos debe descontar 6 unidades del componente");
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

      const pago = await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST pago mixto",
        monto_total: 500,
        tipo_pago: "mixto",
        monto_efectivo: 200,
        monto_debito: 300,
        estado: "registrado"
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

      const pago = await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST IVA credito fiscal",
        monto_total: 1210,
        tipo_pago: "transferencia",
        estado: "registrado"
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

      const pago = await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST tipo_pago debito previo",
        monto_total: 230,
        tipo_pago: "debito",
        estado: "registrado"
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

      const pago = await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST tipo_pago transferencia previo",
        monto_total: 340,
        tipo_pago: "transferencia",
        estado: "registrado"
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

      const pago = await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST tipo_pago mixto previo",
        monto_total: 450,
        tipo_pago: "mixto",
        monto_efectivo: 150,
        monto_debito: 300,
        estado: "registrado"
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
        estado: "registrado"
      });
      await registrarPago(baseUrl, token, {
        proveedor_id: proveedor.id,
        concepto: "TEST snapshot transferencia",
        monto_total: 300,
        tipo_pago: "transferencia",
        estado: "registrado"
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

      assertApprox((await getProduct(baseUrl, token, componenteId)).stock, 7.5, "Vender compuesto debe descontar solo cantidad usada del componente fraccionado");
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

async function testAnularVentaCompuestaReponeComponente() {
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
      assertEqual((await getProduct(baseUrl, token, componenteId)).stock, 12, "Venta compuesta debe descontar componente antes de anular");

      const anulacion = await requestJson(baseUrl, "POST", `/ventas/${venta.data.venta_id}/anular-cobrada`, {
        authorization_code: "1234"
      }, token);
      if (!anulacion.response.ok) throw new Error(`Anulacion venta compuesta fallo: ${anulacion.data?.message || anulacion.response.status}`);
      assertEqual((await getProduct(baseUrl, token, componenteId)).stock, 20, "Anular venta compuesta debe reponer stock del componente");
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

(async () => {
  await testBatchManual();
  await testBatchComoComponente();
  await testPermisosColaborador();
  await testVentaContadoImpactaStockYCaja();
  await testPendienteNoImpactaCajaHastaCobro();
  await testAnularPendienteReponeStock();
  await testAnularVentaCobradaReponeStock();
  await testProductoCompuestoDescuentaComponentes();
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
  await testAnularVentaCompuestaReponeComponente();
  await testMovimientoManualRegistraStockAnteriorYNuevo();
  await testResumenReporteDevuelveClaves();
  await testResumenReporteExcluyeVentasAnuladas();
  await testResumenReporteExcluyePagosPendientes();
  await testResumenReporteCalculaBalanceGeneral();
  await testResumenReporteCalculaTicketPromedio();
  await testResumenReporteRespetaFiltroFechas();
  await testProductosMasVendidosDevuelveClaves();
  await testProductosMasVendidosExcluyeVentasAnuladas();
  await testProductosMasVendidosOrdenaPorCantidad();
  await testProductosMasVendidosRespetaFiltroFechas();
  await testProductosMasVendidosRespetaLimite();
  console.log("OK stock, ventas, caja y permisos basicos");
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
