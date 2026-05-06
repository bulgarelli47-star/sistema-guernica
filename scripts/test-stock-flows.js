const fs = require("fs");
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(baseUrl) {
  for (let i = 0; i < 40; i++) {
    try {
      const response = await fetch(`${baseUrl}/login`);
      if (response.ok) return;
    } catch {}
    await delay(150);
  }
  throw new Error("El servidor de prueba no arranco a tiempo");
}

async function withServer(dbPath, fn) {
  const port = 3200 + Math.floor(Math.random() * 1000);
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
  } finally {
    child.kill();
    await delay(200);
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

async function testPermisosOperador() {
  const dbPath = tempDbPath();
  fs.copyFileSync(SOURCE_DB, dbPath);
  try {
    await withServer(dbPath, async (baseUrl) => {
      const adminToken = await login(baseUrl, "admin", "admin123");
      await requestJson(baseUrl, "POST", "/usuarios", {
        nombre: "Operador Test",
        usuario: "operador_test",
        password: "operador123",
        confirmar_password: "operador123",
        rol: "operador",
        activo: true
      }, adminToken);

      const operadorToken = await login(baseUrl, "operador_test", "operador123");
      const lecturaProductos = await requestJson(baseUrl, "GET", "/productos", null, operadorToken);
      if (!lecturaProductos.response.ok) throw new Error("El operador debe poder leer productos");

      const stock = await requestJson(baseUrl, "POST", "/productos/3/movimientos-stock", {
        tipo_movimiento: "ingreso",
        cantidad: 1,
        motivo: "TEST operador bloqueado",
        usuario: "operador_test"
      }, operadorToken);
      assertEqual(stock.response.status, 403, "El operador no debe modificar stock");

      const config = await requestJson(baseUrl, "PUT", "/configuracion", {
        ticket_nombre: "No autorizado"
      }, operadorToken);
      assertEqual(config.response.status, 403, "El operador no debe modificar configuracion");
    });
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
}

(async () => {
  await testBatchManual();
  await testBatchComoComponente();
  await testPermisosOperador();
  console.log("OK stock batch counter y permisos basicos");
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
