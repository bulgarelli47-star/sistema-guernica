const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const dbPath = path.join(__dirname, "database", "guernica.db");
const db = new sqlite3.Database(dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

async function reset() {
  console.log("\n=== RESET DE DATOS ===\n");

  await run("PRAGMA foreign_keys = OFF");

  const tablas = [
    "detalle_ventas",
    "ventas",
    "movimientos_stock",
    "historial_productos",
    "pagos_cuenta_corriente",
    "pagos",
    "caja_arqueos",
    "caja_movimientos",
    "caja_aperturas",
    "producto_componentes",
    "producto_costos_extra",
    "producto_costos_insumos",
    "producto_proveedores",
    "productos",
    "clientes",
    "proveedores",
    "categorias",
    "configuracion_global",
  ];

  for (const tabla of tablas) {
    await run(`DELETE FROM ${tabla}`);
    console.log(`✓ ${tabla}`);
  }

  const placeholders = tablas.map(() => "?").join(",");
  await run(
    `DELETE FROM sqlite_sequence WHERE name IN (${placeholders})`,
    tablas
  );
  console.log("✓ IDs reseteados a 1");

  await run(
    `INSERT INTO clientes (nombre, telefono, direccion, alias, observaciones, limite_fiado, activo)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ["Consumidor Final", "", "", "", "", 0, 1]
  );
  await run(
    `INSERT INTO clientes (nombre, telefono, direccion, alias, observaciones, limite_fiado, activo)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ["Juan Perez", "1111111111", "", "", "", 0, 1]
  );
  console.log("✓ Clientes por defecto restaurados");

  await run("PRAGMA foreign_keys = ON");

  console.log("\n✅ Listo. Levantá el servidor y cargá los datos nuevos.\n");
  db.close();
}

reset().catch((err) => {
  console.error("\n❌ Error:", err.message);
  db.close();
  process.exit(1);
});
