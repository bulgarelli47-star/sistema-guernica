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
      await abrirCaja(baseUrl, token, 1000);

      const venta = await requestJson(baseUrl, "POST", "/ventas", ventaSimplePayload(), token);
      if (!venta.response.ok) throw new Error(`Venta contado fallo: ${venta.data?.message || venta.response.status}`);
      assertEqual(venta.data.total, 200, "La venta contado debe totalizar 200");
      assertEqual((await getProduct(baseUrl, token, 11)).stock, 78, "La venta contado debe descontar stock");

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

      const resumenDespues = await getCajaResumen(baseUrl, token);
      assertEqual(resumenDespues.resumen.total_ventas, 200, "El pendiente cobrado debe impactar ventas de caja");
      assertEqual(resumenDespues.resumen.total_efectivo, 200, "El pendiente cobrado debe impactar efectivo");
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

(async () => {
  await testBatchManual();
  await testBatchComoComponente();
  await testPermisosColaborador();
  await testVentaContadoImpactaStockYCaja();
  await testPendienteNoImpactaCajaHastaCobro();
  await testAnularVentaCobradaReponeStock();
  console.log("OK stock, ventas, caja y permisos basicos");
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
