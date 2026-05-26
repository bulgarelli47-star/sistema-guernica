const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_DB = path.join(ROOT, "database", "guernica.db");
const dbPath = process.env.GUERNICA_DB_PATH
  ? path.resolve(process.env.GUERNICA_DB_PATH)
  : DEFAULT_DB;
const backupDir = process.env.GUERNICA_BACKUP_DIR
  ? path.resolve(process.env.GUERNICA_BACKUP_DIR)
  : path.join(ROOT, "backups");
const confirmReset = process.argv.includes("--confirm");

const tablesToClear = [
  "mercado_pago_intentos",
  "conciliaciones_cuentas_destino",
  "conciliaciones_cuentas_cobro",
  "caja_arqueos",
  "caja_movimientos",
  "pagos_cuenta_corriente",
  "detalle_venta_componentes_snapshot",
  "detalle_venta_modificadores",
  "detalle_ventas",
  "ventas",
  "pagos",
  "caja_aperturas",
  "recalculos_cuenta_corriente"
];

const tablesToPreserve = [
  "productos",
  "movimientos_stock",
  "stock_ajustes_pendientes",
  "historial_productos",
  "proveedores",
  "clientes",
  "configuracion_global",
  "usuarios",
  "sesiones",
  "tipos_pago",
  "cuentas_cobro",
  "cuentas_destino",
  "categorias",
  "modificadores",
  "modificador_componentes",
  "producto_modificadores",
  "producto_componentes",
  "producto_costos_extra",
  "producto_costos_insumos",
  "producto_proveedores"
];

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate())
  ].join("-")
    + "_"
    + [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join("-");
}

function openDb() {
  return new sqlite3.Database(dbPath);
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
}

function closeDb(db) {
  return new Promise((resolve, reject) => {
    db.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, "\"\"")}"`;
}

async function getExistingTables(db) {
  const rows = await all(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  return new Set(rows.map((row) => row.name));
}

async function countRows(db, tableNames) {
  const counts = {};
  for (const table of tableNames) {
    const row = await all(db, `SELECT COUNT(*) AS total FROM ${quoteIdent(table)}`);
    counts[table] = Number(row[0]?.total || 0);
  }
  return counts;
}

function printCounts(title, counts) {
  console.log(`\n${title}`);
  for (const [table, total] of Object.entries(counts)) {
    console.log(`- ${table}: ${total}`);
  }
}

function createBackup() {
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `guernica-reset-operativo-${timestamp()}.db`);
  fs.copyFileSync(dbPath, backupPath);
  return backupPath;
}

async function resetOperationalData(db, existingTables) {
  const existingToClear = tablesToClear.filter((table) => existingTables.has(table));

  await run(db, "PRAGMA foreign_keys = ON");
  await run(db, "BEGIN IMMEDIATE TRANSACTION");
  try {
    for (const table of existingToClear) {
      await run(db, `DELETE FROM ${quoteIdent(table)}`);
    }

    const placeholders = existingToClear.map(() => "?").join(", ");
    if (placeholders) {
      await run(db, `DELETE FROM sqlite_sequence WHERE name IN (${placeholders})`, existingToClear)
        .catch((error) => {
          if (!/no such table: sqlite_sequence/i.test(error.message)) {
            throw error;
          }
        });
    }

    await run(db, "COMMIT");
  } catch (error) {
    await run(db, "ROLLBACK").catch(() => {});
    throw error;
  }
}

async function main() {
  if (!fs.existsSync(dbPath)) {
    console.error(`No existe la base de datos: ${dbPath}`);
    process.exit(1);
  }

  const db = openDb();
  try {
    const existingTables = await getExistingTables(db);
    const existingToClear = tablesToClear.filter((table) => existingTables.has(table));
    const missingToClear = tablesToClear.filter((table) => !existingTables.has(table));
    const existingPreserved = tablesToPreserve.filter((table) => existingTables.has(table));

    console.log("Reset operativo TEST - Sistema Guernica");
    console.log(`Base: ${dbPath}`);
    console.log(`Modo: ${confirmReset ? "EJECUCION CONFIRMADA" : "DIAGNOSTICO / DRY RUN"}`);

    if (missingToClear.length) {
      console.log(`\nTablas operativas no encontradas y omitidas: ${missingToClear.join(", ")}`);
    }

    console.log("\nTablas que se limpiarian:");
    existingToClear.forEach((table) => console.log(`- ${table}`));

    console.log("\nTablas preservadas explicitamente:");
    existingPreserved.forEach((table) => console.log(`- ${table}`));

    const beforeCounts = await countRows(db, existingToClear);
    printCounts("Conteo antes", beforeCounts);

    if (!confirmReset) {
      console.log("\nNo se modifico la base. Para ejecutar:");
      console.log("node scripts/reset-operativo-test.js --confirm");
      return;
    }

    const backupPath = createBackup();
    console.log(`\nBackup creado: ${backupPath}`);

    await resetOperationalData(db, existingTables);
    const afterCounts = await countRows(db, existingToClear);
    printCounts("Conteo despues", afterCounts);

    console.log("\nReset operativo completado.");
    console.log("No se tocaron productos.stock, movimientos_stock, configuracion, usuarios, proveedores ni cuentas/canales.");
  } finally {
    await closeDb(db);
  }
}

main().catch((error) => {
  console.error("Reset operativo fallido:", error.message);
  process.exit(1);
});
