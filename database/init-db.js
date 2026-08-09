const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const bcrypt = require("bcrypt");

const dbPath = path.join(__dirname, "guernica.db");
const db = new sqlite3.Database(dbPath);

async function initDatabase() {
  try {
    console.log("Creando base de datos...");

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
    await ensureColumn("usuarios", "ultimo_acceso", "TEXT");
    await ensureColumn("usuarios", "creado_en", "TEXT");
    await ensureColumn("usuarios", "actualizado_en", "TEXT");

    await runQuery(`
      CREATE TABLE IF NOT EXISTS productos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        categoria TEXT,
        precio_compra REAL NOT NULL DEFAULT 0,
        precio_venta REAL NOT NULL DEFAULT 0,
        stock REAL NOT NULL DEFAULT 0,
        maneja_stock INTEGER NOT NULL DEFAULT 1,
        proveedor_principal TEXT,
        activo INTEGER NOT NULL DEFAULT 1
      )
    `);

    await ensureColumn("productos", "proveedor_id", "INTEGER");
    await ensureColumn("productos", "activo", "INTEGER NOT NULL DEFAULT 1");
    await ensureColumn("productos", "eliminado", "INTEGER NOT NULL DEFAULT 0");
    await ensureColumn("productos", "observaciones", "TEXT");
    await ensureColumn("productos", "imagen_url", "TEXT");
    await ensureColumn("productos", "iva_porcentaje", "REAL NOT NULL DEFAULT 0");
    await ensureColumn("productos", "precio_compra_incluye_iva", "INTEGER NOT NULL DEFAULT 0");
    await ensureColumn("productos", "costo_final", "REAL NOT NULL DEFAULT 0");
    await ensureColumn("productos", "categoria_id", "INTEGER");
    await ensureColumn("productos", "redondeo", "INTEGER NOT NULL DEFAULT 0");
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
    await ensureColumn("productos", "costo_economico", "REAL");
    await ensureColumn("productos", "iva_venta_tratamiento", "TEXT");
    await ensureColumn("productos", "iva_venta_alicuota", "REAL");
    await ensureColumn("productos", "modelo_fiscal", "TEXT NOT NULL DEFAULT 'legacy'");
    await ensureColumn("productos", "precio_venta_modo", "TEXT NOT NULL DEFAULT 'manual'");

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
      CREATE TABLE IF NOT EXISTS producto_proveedores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        producto_id INTEGER NOT NULL,
        proveedor_id INTEGER NOT NULL,
        precio_compra REAL NOT NULL DEFAULT 0,
        fecha_actualizacion TEXT NOT NULL,
        es_principal INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (producto_id) REFERENCES productos(id),
        FOREIGN KEY (proveedor_id) REFERENCES proveedores(id)
      )
    `);

    await runQuery(`
      CREATE TABLE IF NOT EXISTS movimientos_stock (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        producto_id INTEGER NOT NULL,
        tipo_movimiento TEXT NOT NULL,
        cantidad REAL NOT NULL DEFAULT 0,
        stock_anterior REAL NOT NULL DEFAULT 0,
        stock_nuevo REAL NOT NULL DEFAULT 0,
        motivo TEXT,
        proveedor_id INTEGER,
        usuario TEXT,
        fecha TEXT NOT NULL,
        hora TEXT NOT NULL,
        FOREIGN KEY (producto_id) REFERENCES productos(id),
        FOREIGN KEY (proveedor_id) REFERENCES proveedores(id)
      )
    `);

    await runQuery(`
      CREATE TABLE IF NOT EXISTS historial_productos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        producto_id INTEGER NOT NULL,
        campo_modificado TEXT NOT NULL,
        valor_anterior TEXT,
        valor_nuevo TEXT,
        usuario TEXT,
        fecha TEXT NOT NULL,
        hora TEXT NOT NULL,
        motivo TEXT,
        FOREIGN KEY (producto_id) REFERENCES productos(id)
      )
    `);

    await ensureColumn("productos", "es_combo", "INTEGER NOT NULL DEFAULT 0");
    await ensureColumn("productos", "aplica_para_combo", "INTEGER NOT NULL DEFAULT 0");
    await runQuery(`
      CREATE TABLE IF NOT EXISTS combo_componentes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        combo_producto_id INTEGER NOT NULL,
        producto_id INTEGER NOT NULL,
        cantidad REAL NOT NULL DEFAULT 1,
        FOREIGN KEY (combo_producto_id) REFERENCES productos(id),
        FOREIGN KEY (producto_id) REFERENCES productos(id)
      )
    `);

    await runQuery(`
      CREATE TABLE IF NOT EXISTS clientes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        tipo_cliente TEXT NOT NULL DEFAULT 'cliente',
        telefono TEXT,
        direccion TEXT,
        alias TEXT,
        observaciones TEXT,
        limite_fiado REAL NOT NULL DEFAULT 0,
        activo INTEGER NOT NULL DEFAULT 1
      )
    `);

    await runQuery(`
      CREATE TABLE IF NOT EXISTS ventas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fecha TEXT NOT NULL,
        hora TEXT NOT NULL,
        usuario TEXT NOT NULL,
        total REAL NOT NULL DEFAULT 0,
        tipo TEXT NOT NULL,
        estado TEXT NOT NULL,
        identificador_pendiente TEXT,
        metodo_pago TEXT,
        tipo_cobro TEXT,
        monto_efectivo REAL NOT NULL DEFAULT 0,
        monto_debito REAL NOT NULL DEFAULT 0,
        cliente_id INTEGER,
        es_cuenta_corriente INTEGER NOT NULL DEFAULT 0,
        saldo_pendiente REAL NOT NULL DEFAULT 0,
        total_venta_original REAL,
        FOREIGN KEY (cliente_id) REFERENCES clientes(id)
      )
    `);

    await ensureColumn("ventas", "identificador_pendiente", "TEXT");
    await ensureColumn("ventas", "metodo_pago", "TEXT");
    await ensureColumn("ventas", "tipo_cobro", "TEXT");
    await ensureColumn("ventas", "monto_efectivo", "REAL NOT NULL DEFAULT 0");
    await ensureColumn("ventas", "monto_debito", "REAL NOT NULL DEFAULT 0");
    await ensureColumn("ventas", "cliente_id", "INTEGER");
    await ensureColumn("ventas", "es_cuenta_corriente", "INTEGER NOT NULL DEFAULT 0");
    await ensureColumn("ventas", "saldo_pendiente", "REAL NOT NULL DEFAULT 0");
    await ensureColumn("ventas", "caja_id", "INTEGER");
    await ensureColumn("ventas", "total_venta_original", "REAL");
    await ensureColumn("clientes", "direccion", "TEXT");
    await ensureColumn("clientes", "alias", "TEXT");
    await ensureColumn("clientes", "observaciones", "TEXT");
    await ensureColumn("clientes", "limite_fiado", "REAL NOT NULL DEFAULT 0");
    await ensureColumn("clientes", "dni_cuit", "TEXT");
    await ensureColumn("clientes", "tipo_persona", "TEXT NOT NULL DEFAULT 'fisica'");
    await ensureColumn("clientes", "tipo_cliente", "TEXT NOT NULL DEFAULT 'cliente'");
    await ensureColumn("clientes", "email", "TEXT");
    await ensureColumn("clientes", "contacto", "TEXT");
    await ensureColumn("clientes", "localidad", "TEXT");
    await ensureColumn("clientes", "codigo_postal", "TEXT");
    await ensureColumn("clientes", "dias_vencimiento", "INTEGER NOT NULL DEFAULT 30");
    await ensureColumn("clientes", "dia_vencimiento_fijo", "INTEGER");
    await ensureColumn("clientes", "moneda", "TEXT NOT NULL DEFAULT 'ARS'");
    await ensureColumn("clientes", "habilita_cuenta_corriente", "INTEGER NOT NULL DEFAULT 1");
    await ensureColumn("clientes", "notas", "TEXT");
    await ensureColumn("clientes", "suspendido", "INTEGER NOT NULL DEFAULT 0");

    await runQuery(`
      CREATE TABLE IF NOT EXISTS detalle_ventas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        venta_id INTEGER NOT NULL,
        producto_id INTEGER,
        nombre_producto TEXT NOT NULL,
        cantidad REAL NOT NULL DEFAULT 0,
        precio_unitario REAL NOT NULL DEFAULT 0,
        subtotal REAL NOT NULL DEFAULT 0,
        modelo_fiscal_snapshot TEXT,
        costo_economico_snapshot REAL,
        iva_venta_tratamiento_snapshot TEXT,
        iva_venta_alicuota_snapshot REAL,
        subtotal_neto_snapshot REAL,
        iva_monto_snapshot REAL,
        FOREIGN KEY (venta_id) REFERENCES ventas(id)
      )
    `);
    await ensureColumn("detalle_ventas", "modelo_fiscal_snapshot", "TEXT");
    await ensureColumn("detalle_ventas", "costo_economico_snapshot", "REAL");
    await ensureColumn("detalle_ventas", "iva_venta_tratamiento_snapshot", "TEXT");
    await ensureColumn("detalle_ventas", "iva_venta_alicuota_snapshot", "REAL");
    await ensureColumn("detalle_ventas", "subtotal_neto_snapshot", "REAL");
    await ensureColumn("detalle_ventas", "iva_monto_snapshot", "REAL");

    // Modificadores: no son productos vendidos. Deben quedar pegados al detalle
    // de venta y guardar snapshot historico para anulaciones y reportes.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS modificadores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        codigo TEXT UNIQUE,
        nombre TEXT NOT NULL,
        tipo TEXT NOT NULL DEFAULT 'libre',
        precio_extra REAL NOT NULL DEFAULT 0,
        activo INTEGER NOT NULL DEFAULT 1,
        orden INTEGER NOT NULL DEFAULT 0,
        observacion_cocina TEXT,
        created_at TEXT,
        updated_at TEXT
      )
    `);

    await runQuery(`
      CREATE TABLE IF NOT EXISTS producto_modificadores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        producto_id INTEGER NOT NULL,
        modificador_id INTEGER NOT NULL,
        obligatorio INTEGER NOT NULL DEFAULT 0,
        max_usos INTEGER NOT NULL DEFAULT 1,
        orden INTEGER NOT NULL DEFAULT 0,
        activo INTEGER NOT NULL DEFAULT 1,
        UNIQUE(producto_id, modificador_id),
        FOREIGN KEY (producto_id) REFERENCES productos(id),
        FOREIGN KEY (modificador_id) REFERENCES modificadores(id)
      )
    `);

    await runQuery(`
      CREATE TABLE IF NOT EXISTS modificador_componentes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        modificador_id INTEGER NOT NULL,
        producto_id INTEGER,
        cantidad REAL NOT NULL DEFAULT 0,
        operacion TEXT NOT NULL DEFAULT 'agregar',
        metadata_json TEXT,
        FOREIGN KEY (modificador_id) REFERENCES modificadores(id),
        FOREIGN KEY (producto_id) REFERENCES productos(id)
      )
    `);

    await runQuery(`
      CREATE TABLE IF NOT EXISTS detalle_venta_modificadores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        detalle_venta_id INTEGER NOT NULL,
        modificador_id INTEGER,
        nombre TEXT NOT NULL,
        tipo TEXT NOT NULL,
        precio_extra REAL NOT NULL DEFAULT 0,
        cantidad REAL NOT NULL DEFAULT 1,
        metadata_json TEXT,
        FOREIGN KEY (detalle_venta_id) REFERENCES detalle_ventas(id),
        FOREIGN KEY (modificador_id) REFERENCES modificadores(id)
      )
    `);

    await runQuery(`
      CREATE TABLE IF NOT EXISTS detalle_venta_componentes_snapshot (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        detalle_venta_id INTEGER NOT NULL,
        producto_id INTEGER,
        nombre_producto TEXT,
        cantidad REAL NOT NULL DEFAULT 0,
        operacion TEXT NOT NULL DEFAULT 'base',
        origen TEXT NOT NULL DEFAULT 'producto',
        modificador_id INTEGER,
        metadata_json TEXT,
        FOREIGN KEY (detalle_venta_id) REFERENCES detalle_ventas(id),
        FOREIGN KEY (producto_id) REFERENCES productos(id),
        FOREIGN KEY (modificador_id) REFERENCES modificadores(id)
      )
    `);

    await runQuery("CREATE INDEX IF NOT EXISTS idx_producto_modificadores_producto ON producto_modificadores(producto_id)");
    await runQuery("CREATE INDEX IF NOT EXISTS idx_detalle_venta_modificadores_detalle ON detalle_venta_modificadores(detalle_venta_id)");
    await runQuery("CREATE INDEX IF NOT EXISTS idx_detalle_venta_componentes_snapshot_detalle ON detalle_venta_componentes_snapshot(detalle_venta_id)");

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

    await runQuery(`
      CREATE TABLE IF NOT EXISTS pagos_cuenta_corriente (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        venta_id INTEGER NOT NULL,
        cliente_id INTEGER NOT NULL,
        fecha TEXT NOT NULL,
        hora TEXT NOT NULL,
        monto_pagado REAL NOT NULL DEFAULT 0,
        tipo_cobro TEXT NOT NULL,
        monto_efectivo REAL NOT NULL DEFAULT 0,
        monto_debito REAL NOT NULL DEFAULT 0,
        FOREIGN KEY (venta_id) REFERENCES ventas(id),
        FOREIGN KEY (cliente_id) REFERENCES clientes(id)
      )
    `);

    await ensureColumn("pagos_cuenta_corriente", "caja_id", "INTEGER");

    await runQuery(`
      CREATE TABLE IF NOT EXISTS recalculos_cuenta_corriente (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cliente_id INTEGER NOT NULL,
        deuda_historica REAL NOT NULL DEFAULT 0,
        deuda_actualizada REAL NOT NULL DEFAULT 0,
        diferencia REAL NOT NULL DEFAULT 0,
        usuario TEXT,
        motivo TEXT,
        fecha TEXT NOT NULL,
        hora TEXT NOT NULL,
        detalle_json TEXT,
        FOREIGN KEY (cliente_id) REFERENCES clientes(id)
      )
    `);

    await runQuery(`
      CREATE TABLE IF NOT EXISTS proveedores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        alias TEXT,
        telefono TEXT,
        cuit TEXT,
        observaciones TEXT,
        activo INTEGER NOT NULL DEFAULT 1
      )
    `);

    await runQuery(`
      CREATE TABLE IF NOT EXISTS pagos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proveedor_id INTEGER,
        concepto TEXT NOT NULL,
        monto_total REAL NOT NULL DEFAULT 0,
        tipo_pago TEXT NOT NULL,
        monto_efectivo REAL NOT NULL DEFAULT 0,
        monto_debito REAL NOT NULL DEFAULT 0,
        fecha TEXT NOT NULL,
        hora TEXT NOT NULL,
        estado TEXT NOT NULL DEFAULT 'registrado',
        FOREIGN KEY (proveedor_id) REFERENCES proveedores(id)
      )
    `);

    await ensureColumn("proveedores", "alias", "TEXT");
    await ensureColumn("proveedores", "telefono", "TEXT");
    await ensureColumn("proveedores", "cuit", "TEXT");
    await ensureColumn("proveedores", "observaciones", "TEXT");
    await ensureColumn("proveedores", "activo", "INTEGER NOT NULL DEFAULT 1");
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
    await ensureColumn("pagos", "proveedor_id", "INTEGER");
    await ensureColumn("pagos", "concepto", "TEXT NOT NULL DEFAULT ''");
    await ensureColumn("pagos", "monto_total", "REAL NOT NULL DEFAULT 0");
    await ensureColumn("pagos", "tipo_pago", "TEXT NOT NULL DEFAULT 'efectivo'");
    await ensureColumn("pagos", "monto_efectivo", "REAL NOT NULL DEFAULT 0");
    await ensureColumn("pagos", "monto_debito", "REAL NOT NULL DEFAULT 0");
    await ensureColumn("pagos", "fecha", "TEXT");
    await ensureColumn("pagos", "hora", "TEXT");
    await ensureColumn("pagos", "estado", "TEXT NOT NULL DEFAULT 'registrado'");
    await ensureColumn("pagos", "caja_id", "INTEGER");
    await ensureColumn("pagos", "categoria_pago", "TEXT NOT NULL DEFAULT 'otro_no_computable'");
    await ensureColumn("pagos", "comprobante", "TEXT");
    await ensureColumn("pagos", "numero_comprobante", "TEXT");
    await ensureColumn("pagos", "cuenta_destino", "TEXT");
    await ensureColumn("pagos", "referencia", "TEXT");
    await ensureColumn("pagos", "observaciones", "TEXT");
    await ensureColumn("pagos", "es_cuenta_corriente", "INTEGER NOT NULL DEFAULT 0");
    await ensureColumn("pagos", "iva_credito_fiscal", "REAL NOT NULL DEFAULT 0");

    await runQuery(`
      CREATE TABLE IF NOT EXISTS configuracion_global (
        clave TEXT PRIMARY KEY,
        valor TEXT NOT NULL,
        seccion TEXT NOT NULL,
        actualizado_en TEXT NOT NULL
      )
    `);

    await runQuery(`
      CREATE TABLE IF NOT EXISTS caja_aperturas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fecha TEXT NOT NULL,
        hora TEXT NOT NULL,
        monto_apertura REAL NOT NULL DEFAULT 0,
        usuario TEXT NOT NULL,
        estado TEXT NOT NULL DEFAULT 'abierta',
        hora_cierre TEXT,
        efectivo_esperado REAL NOT NULL DEFAULT 0,
        efectivo_contado REAL NOT NULL DEFAULT 0,
        diferencia REAL NOT NULL DEFAULT 0,
        monto_caja_apertura REAL NOT NULL DEFAULT 0,
        monto_caja_fondo REAL NOT NULL DEFAULT 0,
        conteo_detalle TEXT,
        resumen_snapshot TEXT,
        ventas_snapshot TEXT
      )
    `);

    await ensureColumn("caja_aperturas", "hora_cierre", "TEXT");
    await ensureColumn("caja_aperturas", "efectivo_esperado", "REAL NOT NULL DEFAULT 0");
    await ensureColumn("caja_aperturas", "efectivo_contado", "REAL NOT NULL DEFAULT 0");
    await ensureColumn("caja_aperturas", "diferencia", "REAL NOT NULL DEFAULT 0");
    await ensureColumn("caja_aperturas", "monto_caja_apertura", "REAL NOT NULL DEFAULT 0");
    await ensureColumn("caja_aperturas", "monto_caja_fondo", "REAL NOT NULL DEFAULT 0");
    await ensureColumn("caja_aperturas", "saldo_inicial_mp", "REAL NOT NULL DEFAULT 0");
    await ensureColumn("caja_aperturas", "conteo_detalle", "TEXT");
    await ensureColumn("caja_aperturas", "resumen_snapshot", "TEXT");
    await ensureColumn("caja_aperturas", "ventas_snapshot", "TEXT");
    await ensureColumn("caja_aperturas", "pagos_snapshot", "TEXT");

    await runQuery(`
      CREATE TABLE IF NOT EXISTS caja_movimientos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        caja_id INTEGER NOT NULL,
        tipo TEXT NOT NULL,
        concepto TEXT NOT NULL,
        monto REAL NOT NULL,
        usuario TEXT NOT NULL DEFAULT 'admin',
        fecha TEXT NOT NULL,
        hora TEXT NOT NULL
      )
    `);

    await runQuery(`
      CREATE TABLE IF NOT EXISTS caja_arqueos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        caja_id INTEGER NOT NULL,
        fecha TEXT NOT NULL,
        hora TEXT NOT NULL,
        usuario TEXT NOT NULL DEFAULT 'admin',
        efectivo_esperado REAL NOT NULL DEFAULT 0,
        efectivo_contado REAL NOT NULL DEFAULT 0,
        diferencia_efectivo REAL NOT NULL DEFAULT 0,
        digital_esperado REAL NOT NULL DEFAULT 0,
        digital_real REAL NOT NULL DEFAULT 0,
        diferencia_digital REAL NOT NULL DEFAULT 0,
        resultado_final REAL NOT NULL DEFAULT 0,
        estado TEXT NOT NULL DEFAULT 'Sobra',
        observaciones TEXT,
        conteo_detalle TEXT,
        cuentas_detalle TEXT,
        resumen_snapshot TEXT
      )
    `);

    await runQuery("CREATE INDEX IF NOT EXISTS idx_usuarios_usuario ON usuarios(usuario)");
    await runQuery("CREATE INDEX IF NOT EXISTS idx_productos_codigo ON productos(codigo)");
    await runQuery("CREATE INDEX IF NOT EXISTS idx_productos_activo ON productos(activo)");
    await runQuery("CREATE INDEX IF NOT EXISTS idx_ventas_estado ON ventas(estado)");
    await runQuery("CREATE INDEX IF NOT EXISTS idx_ventas_cliente ON ventas(cliente_id)");
    await runQuery("CREATE INDEX IF NOT EXISTS idx_ventas_caja ON ventas(caja_id)");
    await runQuery("CREATE INDEX IF NOT EXISTS idx_detalle_ventas_venta ON detalle_ventas(venta_id)");
    await runQuery("CREATE INDEX IF NOT EXISTS idx_movimientos_stock_producto ON movimientos_stock(producto_id)");
    await runQuery("CREATE INDEX IF NOT EXISTS idx_caja_movimientos_caja ON caja_movimientos(caja_id)");
    await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_dni_cuit_unique ON clientes(dni_cuit) WHERE dni_cuit IS NOT NULL AND TRIM(dni_cuit) != ''");

    const existingUser = await getQuery(
      "SELECT * FROM usuarios WHERE usuario = ?",
      ["admin"]
    );

    const existingClient = await getQuery(
      "SELECT * FROM clientes WHERE nombre = ?",
      ["Consumidor Final"]
    );

    if (!existingUser) {
      const passwordHash = await bcrypt.hash("admin123", 10);

      await runQuery(
        `INSERT INTO usuarios (nombre, usuario, password, rol, activo, creado_en, actualizado_en)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["Administrador", "admin", passwordHash, "admin", 1, new Date().toISOString(), new Date().toISOString()]
      );

      console.log("Usuario admin creado.");
      console.log("Usuario: admin");
      console.log("Contrasena: admin123");
    } else {
      console.log("El usuario admin ya existe.");
    }

    if (!existingClient) {
      await runQuery(
        `INSERT INTO clientes (nombre, telefono, direccion, alias, observaciones, limite_fiado, activo)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["Consumidor Final", "", "", "", "", 0, 1]
      );

      await runQuery(
        `INSERT INTO clientes (nombre, telefono, direccion, alias, observaciones, limite_fiado, activo)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["Juan Perez", "1111111111", "", "", "", 0, 1]
      );
    }

    console.log("Base de datos lista.");
  } catch (error) {
    console.error("Error inicializando la base de datos:", error.message);
  } finally {
    db.close((err) => {
      if (err) {
        console.error("Error cerrando la base de datos:", err.message);
      }
    });
  }
}

function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) {
        reject(err);
        return;
      }

      resolve(this);
    });
  });
}

function getQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(row);
    });
  });
}

function allQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(rows);
    });
  });
}

async function ensureColumn(tableName, columnName, columnDefinition) {
  const columns = await allQuery(`PRAGMA table_info(${tableName})`);
  const exists = columns.some((column) => column.name === columnName);

  if (!exists) {
    await runQuery(
      `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`
    );
  }
}

async function dropColumnIfExists(tableName, columnName) {
  const columns = await allQuery(`PRAGMA table_info(${tableName})`);
  const exists = columns.some((column) => column.name === columnName);

  if (!exists) {
    return;
  }

  try {
    await runQuery(`ALTER TABLE ${tableName} DROP COLUMN ${columnName}`);
  } catch (error) {
    console.warn(`No se pudo eliminar la columna ${columnName} de ${tableName}: ${error.message}`);
  }
}

initDatabase();
