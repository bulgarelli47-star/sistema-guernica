const express = require("express");
const path = require("path");
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const AUTHORIZATION_CANCEL_CODE = "1234";
const loginAttempts = new Map();
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

const dbPath = path.join(__dirname, "../database/guernica.db");
const db = new sqlite3.Database(dbPath);

async function ensureCajaMovimientosTable() {
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
}

async function ensureCajaArqueosTable() {
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
  await ensureColumn("caja_arqueos", "registrado_cierre", "INTEGER NOT NULL DEFAULT 1");
}

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
  await ensureColumn("productos", "tipo", "TEXT NOT NULL DEFAULT 'simple'");
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
    "UPDATE productos SET stock = 0, maneja_stock = 0, stock_minimo = 0, alerta_stock_minimo = 0 WHERE tipo = 'compuesto'"
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

const CONFIGURACION_DEFAULTS = {
  negocio_nombre_comercial: { seccion: "negocio", valor: "Guernica Bar" },
  negocio_razon_social: { seccion: "negocio", valor: "" },
  negocio_cuit: { seccion: "negocio", valor: "" },
  negocio_condicion_fiscal: { seccion: "negocio", valor: "Responsable inscripto" },
  negocio_direccion: { seccion: "negocio", valor: "" },
  negocio_telefono: { seccion: "negocio", valor: "" },
  negocio_email: { seccion: "negocio", valor: "" },
  negocio_logo_url: { seccion: "negocio", valor: "" },
  negocio_regimen_monotributo: { seccion: "negocio", valor: false },
  negocio_regimen_responsable_inscripto: { seccion: "negocio", valor: true },
  pago_efectivo_activo: { seccion: "metodos_pago", valor: true },
  pago_debito_activo: { seccion: "metodos_pago", valor: true },
  pago_credito_activo: { seccion: "metodos_pago", valor: true },
  pago_transferencia_activo: { seccion: "metodos_pago", valor: true },
  pago_billetera_activo: { seccion: "metodos_pago", valor: true },
  pago_cuenta_corriente_activo: { seccion: "metodos_pago", valor: true },
  pago_cuentas_billeteras: { seccion: "metodos_pago", valor: '[{"nombre":"Cuenta principal","saldo_inicial":0,"impacta":"debito_transferencia"}]' },
  cuenta_caja_principal: { seccion: "cuentas", valor: "Caja principal" },
  cuenta_banco_principal: { seccion: "cuentas", valor: "" },
  cuenta_billetera_principal: { seccion: "cuentas", valor: "" },
  cuenta_saldo_inicial: { seccion: "cuentas", valor: 0 },
  pago_tipos_disponibles: { seccion: "pagos", valor: "proveedor,gasto,impuesto,sueldo" },
  stock_manejo_activo: { seccion: "stock", valor: true },
  stock_unidad_default: { seccion: "stock", valor: "unidad" },
  stock_permitir_negativo: { seccion: "stock", valor: false },
  stock_alerta_minimo: { seccion: "stock", valor: true },
  stock_valor_alerta: { seccion: "stock", valor: 5 },
  iva_porcentaje_default: { seccion: "stock", valor: 21 },
  iva_precios_incluyen: { seccion: "stock", valor: true },
  iva_mostrar_reportes: { seccion: "stock", valor: true },
  iva_regimen: { seccion: "impuestos", valor: "Responsable inscripto" },
  imp_iibb_3_activo: { seccion: "stock", valor: true },
  imp_iibb_5_activo: { seccion: "stock", valor: true },
  imp_iva_reducido_105_activo: { seccion: "stock", valor: true },
  imp_iva_21_activo: { seccion: "stock", valor: true },
  imp_iva_aumentado_27_activo: { seccion: "stock", valor: true },
  redondeo_tipo: { seccion: "stock", valor: "0" },
  cuentas_habilitar_default: { seccion: "cuentas_corrientes", valor: true },
  cuentas_dias_vencimiento: { seccion: "cuentas_corrientes", valor: 30 },
  cuentas_permitir_exceder: { seccion: "cuentas_corrientes", valor: false },
  cuentas_interes_mora: { seccion: "cuentas_corrientes", valor: 0 },
  cuentas_interes_mora_activo: { seccion: "cuentas_corrientes", valor: false },
  cuentas_desactivar_por_vencimiento: { seccion: "cuentas_corrientes", valor: true },
  cuentas_dias_a_costo: { seccion: "cuentas_corrientes", valor: 90 },
  cuentas_limite_global_activo: { seccion: "cuentas_corrientes", valor: false },
  cuentas_limite_global_monto: { seccion: "cuentas_corrientes", valor: 0 },
  permiso_ajuste_stock: { seccion: "usuarios_permisos", valor: "admin" },
  permiso_ver_costos: { seccion: "usuarios_permisos", valor: "admin" },
  permiso_cierre_caja: { seccion: "usuarios_permisos", valor: "admin" },
  permiso_eliminar_registros: { seccion: "usuarios_permisos", valor: "admin" },
  permisos_acciones_roles: { seccion: "usuarios_permisos", valor: '{"ver_stock":{"admin":true,"encargado":true,"operador":true,"caja":false},"sumar_stock":{"admin":true,"encargado":true,"operador":false,"caja":false},"ver_acciones":{"admin":true,"encargado":true,"operador":false,"caja":false},"ver_costos":{"admin":true,"encargado":true,"operador":false,"caja":false},"caja":{"admin":true,"encargado":true,"operador":false,"caja":true},"registros":{"admin":true,"encargado":true,"operador":false,"caja":false},"anular_ticket":{"admin":true,"encargado":true,"operador":false,"caja":false},"editar_ticket":{"admin":true,"encargado":true,"operador":true,"caja":true}}' },
  modulo_inicio_admin: { seccion: "usuarios_permisos", valor: true },
  modulo_ventas_admin: { seccion: "usuarios_permisos", valor: true },
  modulo_caja_admin: { seccion: "usuarios_permisos", valor: true },
  modulo_pagos_admin: { seccion: "usuarios_permisos", valor: true },
  modulo_stock_admin: { seccion: "usuarios_permisos", valor: true },
  modulo_clientes_admin: { seccion: "usuarios_permisos", valor: true },
  modulo_proveedores_admin: { seccion: "usuarios_permisos", valor: true },
  modulo_reportes_admin: { seccion: "usuarios_permisos", valor: true },
  modulo_usuarios_admin: { seccion: "usuarios_permisos", valor: true },
  modulo_configuracion_admin: { seccion: "usuarios_permisos", valor: true },
  modulo_inicio_encargado: { seccion: "usuarios_permisos", valor: true },
  modulo_ventas_encargado: { seccion: "usuarios_permisos", valor: true },
  modulo_caja_encargado: { seccion: "usuarios_permisos", valor: true },
  modulo_pagos_encargado: { seccion: "usuarios_permisos", valor: true },
  modulo_stock_encargado: { seccion: "usuarios_permisos", valor: true },
  modulo_clientes_encargado: { seccion: "usuarios_permisos", valor: true },
  modulo_proveedores_encargado: { seccion: "usuarios_permisos", valor: true },
  modulo_reportes_encargado: { seccion: "usuarios_permisos", valor: true },
  modulo_usuarios_encargado: { seccion: "usuarios_permisos", valor: false },
  modulo_configuracion_encargado: { seccion: "usuarios_permisos", valor: false },
  modulo_inicio_operador: { seccion: "usuarios_permisos", valor: true },
  modulo_ventas_operador: { seccion: "usuarios_permisos", valor: true },
  modulo_caja_operador: { seccion: "usuarios_permisos", valor: false },
  modulo_pagos_operador: { seccion: "usuarios_permisos", valor: false },
  modulo_stock_operador: { seccion: "usuarios_permisos", valor: true },
  modulo_clientes_operador: { seccion: "usuarios_permisos", valor: true },
  modulo_proveedores_operador: { seccion: "usuarios_permisos", valor: false },
  modulo_reportes_operador: { seccion: "usuarios_permisos", valor: false },
  modulo_usuarios_operador: { seccion: "usuarios_permisos", valor: false },
  modulo_configuracion_operador: { seccion: "usuarios_permisos", valor: false },
  modulo_inicio_caja: { seccion: "usuarios_permisos", valor: true },
  modulo_ventas_caja: { seccion: "usuarios_permisos", valor: true },
  modulo_caja_caja: { seccion: "usuarios_permisos", valor: true },
  modulo_pagos_caja: { seccion: "usuarios_permisos", valor: false },
  modulo_stock_caja: { seccion: "usuarios_permisos", valor: false },
  modulo_clientes_caja: { seccion: "usuarios_permisos", valor: true },
  modulo_proveedores_caja: { seccion: "usuarios_permisos", valor: false },
  modulo_reportes_caja: { seccion: "usuarios_permisos", valor: false },
  modulo_usuarios_caja: { seccion: "usuarios_permisos", valor: false },
  modulo_configuracion_caja: { seccion: "usuarios_permisos", valor: false },
  proveedor_tipos_habilitados: { seccion: "proveedores", valor: "servicio,directo,reventa,gastos fijos,gastos variables,colaboradores,personales" },
  proveedor_tipos_perdida: { seccion: "proveedores", valor: "servicio,gastos fijos,gastos variables,colaboradores,personales" },
  proveedor_masa_monetaria_activa: { seccion: "proveedores", valor: true },
  alerta_pago_registrado: { seccion: "alertas", valor: true },
  alerta_venta_realizada: { seccion: "alertas", valor: true },
  alerta_ticket_anulado: { seccion: "alertas", valor: true },
  alerta_ticket_pendiente: { seccion: "alertas", valor: true },
  alerta_stock_bajo: { seccion: "alertas", valor: true },
  alerta_caja_diferencia: { seccion: "alertas", valor: true },
  dashboard_tipo_admin: { seccion: "usuarios_permisos", valor: "complejo" },
  dashboard_tipo_encargado: { seccion: "usuarios_permisos", valor: "complejo" },
  dashboard_tipo_operador: { seccion: "usuarios_permisos", valor: "simple" },
  dashboard_tipo_caja: { seccion: "usuarios_permisos", valor: "simple" },
  dashboard_pizarra_categorias: { seccion: "usuarios_permisos", valor: "cafeteria,cafe,menu,desayuno,merienda" },
  dashboard_pizarra_productos: { seccion: "usuarios_permisos", valor: "" },
  ticket_nombre: { seccion: "tickets", valor: "Guernica Bar" },
  ticket_impresora_activa: { seccion: "tickets", valor: true },
  ticket_mostrar_logo: { seccion: "tickets", valor: true },
  ticket_mostrar_datos_fiscales: { seccion: "tickets", valor: true },
  ticket_mostrar_items: { seccion: "tickets", valor: true },
  ticket_mensaje_final: { seccion: "tickets", valor: "Gracias por su compra" },
  reporte_formato_default: { seccion: "reportes", valor: "excel" },
  reporte_incluir_graficos: { seccion: "reportes", valor: true },
  reporte_nombre_automatico: { seccion: "reportes", valor: true },
  reporte_separador_decimal: { seccion: "reportes", valor: "," },
  reporte_backup_generado_en: { seccion: "reportes", valor: "" },
  reporte_backup_ultimo_nombre: { seccion: "reportes", valor: "" },
  seguridad_backup_auto: { seccion: "seguridad", valor: false },
  seguridad_backup_frecuencia: { seccion: "seguridad", valor: "diario" },
  seguridad_ultimo_backup: { seccion: "seguridad", valor: "" }
};

function serializarConfigValor(valor) {
  return JSON.stringify(valor);
}

function parsearConfigValor(valor) {
  try {
    return JSON.parse(valor);
  } catch {
    return valor;
  }
}

async function getConfiguracionGlobal() {
  const rows = await allQuery("SELECT clave, valor FROM configuracion_global");
  const config = Object.fromEntries(
    Object.entries(CONFIGURACION_DEFAULTS).map(([clave, item]) => [clave, item.valor])
  );

  rows.forEach((row) => {
    if (Object.prototype.hasOwnProperty.call(CONFIGURACION_DEFAULTS, row.clave)) {
      config[row.clave] = parsearConfigValor(row.valor);
    }
  });

  if (config.redondeo_tipo === "sin_redondeo") {
    config.redondeo_tipo = "0";
  }

  [
    "pago_cuentas_billeteras",
    "pago_tipos_disponibles",
    "proveedor_tipos_habilitados",
    "proveedor_tipos_perdida",
    "permisos_acciones_roles"
  ].forEach((clave) => {
    if (config[clave] === "") {
      config[clave] = CONFIGURACION_DEFAULTS[clave].valor;
    }
  });

  return config;
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

function normalizarInsumosCostos(insumos = []) {
  if (!Array.isArray(insumos)) return [];
  return insumos
    .map((item) => {
      const nombre = String(item.nombre || "").trim();
      const costoTotal = Number(item.costo_total) || 0;
      const cantidadRinde = Number(item.cantidad_rinde) || 0;
      const cantidadUsada = Number(item.cantidad_usada) || 1;
      const costoUnitario = cantidadRinde > 0 ? costoTotal / cantidadRinde : 0;
      const costoAplicado = costoUnitario * cantidadUsada;
      return {
        nombre,
        costo_total: Number(costoTotal.toFixed(2)),
        cantidad_rinde: Number(cantidadRinde.toFixed(4)),
        unidad: String(item.unidad || "un").trim() || "un",
        cantidad_usada: Number(cantidadUsada.toFixed(4)),
        costo_unitario: Number(costoUnitario.toFixed(4)),
        costo_aplicado: Number(costoAplicado.toFixed(2))
      };
    })
    .filter((item) => item.nombre && item.cantidad_rinde > 0);
}

function calcularCostoPorRendimiento(insumos = []) {
  return Number(normalizarInsumosCostos(insumos).reduce((acc, item) => acc + item.costo_aplicado, 0).toFixed(2));
}

function calcularStockPorRendimiento(insumos = []) {
  return Number(normalizarInsumosCostos(insumos).reduce((acc, item) => acc + Number(item.cantidad_rinde || 0), 0).toFixed(4));
}

async function guardarInsumosProducto(productoId, insumos = []) {
  const normalizados = normalizarInsumosCostos(insumos);
  await runQuery("DELETE FROM producto_costos_insumos WHERE producto_id = ?", [productoId]);
  for (const item of normalizados) {
    await runQuery(
      `INSERT INTO producto_costos_insumos
       (producto_id, nombre, costo_total, cantidad_rinde, unidad, cantidad_usada, costo_unitario, costo_aplicado)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [productoId, item.nombre, item.costo_total, item.cantidad_rinde, item.unidad, item.cantidad_usada, item.costo_unitario, item.costo_aplicado]
    );
  }
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

function normalizarTipoProducto(tipo) {
  return String(tipo || "simple").toLowerCase() === "compuesto" ? "compuesto" : "simple";
}

function esProductoReceta(producto = {}) {
  return normalizarTipoProducto(producto.tipo) === "compuesto";
}

function normalizarComponentesProducto(componentes = []) {
  if (!Array.isArray(componentes)) {
    return [];
  }

  return componentes
    .map((item) => ({
      producto_id: Number(item.producto_id ?? item.id),
      cantidad: Number(item.cantidad) || 0
    }))
    .filter((item) => item.producto_id > 0 && item.cantidad > 0);
}

function normalizarCostosExtraProducto(costosExtra = []) {
  if (!Array.isArray(costosExtra)) {
    return [];
  }

  return costosExtra
    .map((item) => ({
      descripcion: String(item.descripcion || "").trim(),
      monto: Number(item.monto) || 0
    }))
    .filter((item) => item.descripcion && item.monto !== 0);
}

async function guardarProductoCompuestoConfig(productoCompuestoId, componentes = [], costosExtra = []) {
  await runQuery("DELETE FROM producto_componentes WHERE producto_compuesto_id = ?", [productoCompuestoId]);
  await runQuery("DELETE FROM producto_costos_extra WHERE producto_compuesto_id = ?", [productoCompuestoId]);

  for (const componente of normalizarComponentesProducto(componentes)) {
    if (Number(componente.producto_id) === Number(productoCompuestoId)) {
      continue;
    }

    await runQuery(
      `INSERT INTO producto_componentes (producto_compuesto_id, producto_id, cantidad)
       VALUES (?, ?, ?)`,
      [productoCompuestoId, componente.producto_id, componente.cantidad]
    );
  }

  for (const costo of normalizarCostosExtraProducto(costosExtra)) {
    await runQuery(
      `INSERT INTO producto_costos_extra (producto_compuesto_id, descripcion, monto)
       VALUES (?, ?, ?)`,
      [productoCompuestoId, costo.descripcion, costo.monto]
    );
  }
}

async function getComponentesProductoCompuesto(productoCompuestoId) {
  return allQuery(
    `SELECT pc.id, pc.producto_compuesto_id, pc.producto_id, pc.cantidad,
            p.nombre AS producto_nombre, p.stock, p.maneja_stock, p.tipo, p.es_combo,
            p.unidad_medida, p.precio_compra, p.costo_final
     FROM producto_componentes pc
     INNER JOIN productos p ON p.id = pc.producto_id
     WHERE pc.producto_compuesto_id = ?
     ORDER BY pc.id ASC`,
    [productoCompuestoId]
  );
}

async function getCostosExtraProductoCompuesto(productoCompuestoId) {
  return allQuery(
    `SELECT id, producto_compuesto_id, descripcion, monto
     FROM producto_costos_extra
     WHERE producto_compuesto_id = ?
     ORDER BY id ASC`,
    [productoCompuestoId]
  );
}

async function calcularStockDisponibleCompuesto(productoCompuestoId, visited = new Set()) {
  const compuestoId = Number(productoCompuestoId);
  if (!compuestoId || visited.has(compuestoId)) {
    return 0;
  }
  visited.add(compuestoId);

  const componentes = await getComponentesProductoCompuesto(productoCompuestoId);

  if (!componentes.length) {
    return 0;
  }

  const disponibilidades = [];
  for (const item of componentes) {
    const cantidad = Number(item.cantidad || 0);
    if (cantidad <= 0) {
      continue;
    }

    const stockBase = esProductoReceta(item)
      ? await calcularStockDisponibleCompuesto(item.producto_id, new Set(visited))
      : Number(item.stock || 0);
    disponibilidades.push(stockBase / cantidad);
  }

  return disponibilidades.length ? Math.max(0, Math.floor(Math.min(...disponibilidades))) : 0;
}

async function getCostoConsumoUnitarioProducto(productoId, productoRow = null) {
  const costos = await allQuery(
    "SELECT costo_unitario FROM producto_costos_insumos WHERE producto_id = ?",
    [productoId]
  );

  if (costos.length) {
    const total = costos.reduce((acc, item) => acc + Number(item.costo_unitario || 0), 0);
    return Number(total.toFixed(4));
  }

  const producto = productoRow || await getQuery(
    "SELECT precio_compra, costo_final FROM productos WHERE id = ?",
    [productoId]
  );
  return Number(Number(producto?.costo_final || producto?.precio_compra || 0).toFixed(4));
}

async function calcularStockVendibleFraccionado(productoId, stockActual = 0) {
  const costos = await normalizarInsumosCostos(await allQuery(
    "SELECT * FROM producto_costos_insumos WHERE producto_id = ? ORDER BY id ASC",
    [productoId]
  ));
  const consumoUnidad = costos.reduce((acc, item) => acc + Number(item.cantidad_usada || 0), 0);
  if (consumoUnidad <= 0) {
    return Math.max(0, Math.floor(Number(stockActual) || 0));
  }
  return Math.max(0, Math.floor((Number(stockActual) || 0) / consumoUnidad));
}

async function calcularCostoProductoCompuesto(productoCompuestoId) {
  const [componentes, costosExtra] = await Promise.all([
    getComponentesProductoCompuesto(productoCompuestoId),
    getCostosExtraProductoCompuesto(productoCompuestoId)
  ]);

  let costoComponentes = 0;
  for (const item of componentes) {
    const costoUnitarioConsumo = await getCostoConsumoUnitarioProducto(item.producto_id, item);
    costoComponentes += costoUnitarioConsumo * Number(item.cantidad || 0);
  }
  const extras = costosExtra.reduce((acc, item) => acc + Number(item.monto || 0), 0);
  return Number((costoComponentes + extras).toFixed(2));
}

async function calcularCostoProductoCompuestoPayload(componentes = [], costosExtra = []) {
  const componentesNormalizados = normalizarComponentesProducto(componentes);
  let costoComponentes = 0;

  for (const componente of componentesNormalizados) {
    const costoUnitarioConsumo = await getCostoConsumoUnitarioProducto(componente.producto_id);
    costoComponentes += costoUnitarioConsumo * componente.cantidad;
  }

  const extras = normalizarCostosExtraProducto(costosExtra)
    .reduce((acc, item) => acc + Number(item.monto || 0), 0);
  return Number((costoComponentes + extras).toFixed(2));
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
    const suma = Number((efectivo + debito).toFixed(2));

    if (suma !== totalRounded) {
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

async function getCajaAperturaHoy(fecha) {
  return getQuery(
    `SELECT *
     FROM caja_aperturas
     WHERE fecha = ?
     ORDER BY id DESC
     LIMIT 1`,
    [fecha]
  );
}

async function getCajaAbiertaActual() {
  return getQuery(
    `SELECT *
     FROM caja_aperturas
     WHERE estado = 'abierta'
     ORDER BY id DESC
     LIMIT 1`
  );
}

async function getUltimaCajaRegistrada() {
  return getQuery(
    `SELECT *
     FROM caja_aperturas
     ORDER BY id DESC
     LIMIT 1`
  );
}

function parseJsonOrFallback(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function buildConteoBilletes(conteo = {}) {
  const denominaciones = [10, 20, 50, 100, 200, 500, 1000, 2000, 10000, 20000];
  const detalle = {};
  let total = 0;

  denominaciones.forEach((denominacion) => {
    const cantidad = Number(conteo[String(denominacion)] ?? conteo[denominacion]) || 0;
    detalle[String(denominacion)] = cantidad;

    if (denominacion < 500) {
      total += denominacion * cantidad;
      return;
    }

    if (denominacion === 500) {
      total += (cantidad % 2 === 1 ? 500 : 0) + Math.floor(cantidad / 2) * 1000;
      return;
    }

    total += denominacion * cantidad;
  });

  return {
    detalle,
    total: Number(total.toFixed(2))
  };
}

async function getOperacionesCaja(cajaId) {
  if (!cajaId) {
    return [];
  }

  await ensureCajaMovimientosTable();

  const ventas = await allQuery(
    `SELECT v.id, v.fecha, v.hora, v.total, v.tipo_cobro, v.monto_efectivo, v.monto_debito,
            v.cliente_id, v.estado, v.es_cuenta_corriente, c.nombre AS cliente_nombre, v.tipo, v.caja_id
     FROM ventas v
     LEFT JOIN clientes c ON c.id = v.cliente_id
     WHERE (v.caja_id = ? OR EXISTS (
       SELECT 1
       FROM pagos_cuenta_corriente pcc
       WHERE pcc.venta_id = v.id AND pcc.caja_id = ?
     ))
       AND (v.estado = 'cobrada' OR (v.es_cuenta_corriente = 1 AND v.estado = 'cuenta_corriente_pendiente'))
       AND (v.tipo = 'normal' OR v.tipo = 'pendiente')
     ORDER BY v.hora DESC, v.id DESC`,
    [cajaId, cajaId]
  );

  const pagosCuentaCorriente = await allQuery(
    `SELECT pcc.id, pcc.fecha, pcc.hora, pcc.monto_pagado AS total, pcc.tipo_cobro,
            pcc.monto_efectivo, pcc.monto_debito, pcc.cliente_id, pcc.caja_id,
            'cobrada' AS estado, c.nombre AS cliente_nombre,
            'cuenta_corriente' AS tipo
     FROM pagos_cuenta_corriente pcc
     LEFT JOIN clientes c ON c.id = pcc.cliente_id
     WHERE pcc.caja_id = ?
     ORDER BY pcc.hora DESC, pcc.id DESC`,
    [cajaId]
  );

  const pagosEgresos = await getPagosCaja(cajaId);
  const movimientosManuales = await allQuery(
    `SELECT id, caja_id, tipo, concepto, monto AS total, usuario, fecha, hora,
            'efectivo' AS tipo_cobro,
            CASE WHEN tipo = 'ingreso' THEN monto ELSE 0 END AS monto_efectivo,
            0 AS monto_debito
     FROM caja_movimientos
     WHERE caja_id = ?
     ORDER BY hora DESC, id DESC`,
    [cajaId]
  );

  const operaciones = [
    ...ventas.map((venta) => ({
      ...venta,
      tipo_operacion: Number(venta.es_cuenta_corriente) === 1
        ? "venta_cuenta_corriente"
        : venta.tipo === "pendiente"
          ? "venta_pendiente_cobrada"
          : "venta_normal"
    })),
    ...pagosCuentaCorriente.map((pago) => ({
      ...pago,
      tipo_operacion: "cobro_cuenta_corriente"
    })),
    ...pagosEgresos.map((pago) => ({
      ...pago,
      cliente_nombre: null,
      tipo_operacion: "pago_proveedor"
    })),
    ...movimientosManuales.map((movimiento) => ({
      ...movimiento,
      cliente_nombre: null,
      proveedor_nombre: null,
      tipo_operacion: movimiento.tipo === "ingreso"
        ? "caja_movimiento_ingreso"
        : "caja_movimiento_egreso",
      monto_efectivo: Number(movimiento.total || 0),
      monto_debito: 0
    }))
  ];

  operaciones.sort((a, b) => {
    const timeA = `${a.fecha} ${a.hora} ${String(a.id).padStart(8, "0")}`;
    const timeB = `${b.fecha} ${b.hora} ${String(b.id).padStart(8, "0")}`;
    return timeA < timeB ? 1 : -1;
  });

  return operaciones;
}

async function getPagosCaja(cajaId) {
  if (!cajaId) {
    return [];
  }

  const pagosEgresos = await allQuery(
    `SELECT p.id, p.fecha, p.hora, p.monto_total AS total, p.tipo_pago AS tipo_cobro,
            p.monto_efectivo, p.monto_debito, p.proveedor_id, p.caja_id,
            'registrado' AS estado, pr.nombre AS proveedor_nombre, p.concepto,
            'egreso' AS tipo
     FROM pagos p
     LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
     WHERE p.caja_id = ?
     ORDER BY p.hora DESC, p.id DESC`,
    [cajaId]
  );
  return pagosEgresos.map((pago) => ({
    ...pago,
    tipo_operacion: "pago_proveedor"
  }));
}

async function attachOperacionDetalle(operacion) {
  if (
    !operacion ||
    operacion.tipo_operacion === "cobro_cuenta_corriente" ||
    operacion.tipo_operacion === "pago_proveedor" ||
    operacion.tipo_operacion === "caja_movimiento_ingreso" ||
    operacion.tipo_operacion === "caja_movimiento_egreso"
  ) {
    return {
      ...operacion,
      productos: []
    };
  }

  const productos = await allQuery(
    `SELECT dv.producto_id, dv.nombre_producto, dv.cantidad, dv.precio_unitario, dv.subtotal,
            p.costo_final, p.precio_compra
     FROM detalle_ventas dv
     LEFT JOIN productos p ON p.id = dv.producto_id
     WHERE venta_id = ?
     ORDER BY dv.id ASC`,
    [operacion.id]
  );

  return {
    ...operacion,
    productos: productos.map((producto) => {
      const cantidad = Number(producto.cantidad || 0);
      const subtotal = Number(producto.subtotal || 0);
      const costoFinal = Number(producto.costo_final || 0);
      const precioCompra = Number(producto.precio_compra || 0);
      const costoBase = costoFinal > 0 ? costoFinal : precioCompra > 0 ? precioCompra : null;
      const sinCostoInformado = !producto.producto_id || costoBase == null;
      const costoItem = sinCostoInformado ? null : Number((costoBase * cantidad).toFixed(2));
      const gananciaEstimada = sinCostoInformado ? null : Number((subtotal - costoItem).toFixed(2));

      return {
        producto_id: producto.producto_id,
        nombre_producto: producto.nombre_producto,
        cantidad,
        precio_venta: Number(producto.precio_unitario || 0),
        subtotal,
        costo_final_usado: costoBase,
        costo_item: costoItem,
        ganancia_estimada: gananciaEstimada,
        sin_costo_informado: sinCostoInformado
      };
    })
  };
}

async function buildCajaSnapshot(cajaId) {
  const operaciones = await getOperacionesCaja(cajaId);
  const operacionesDetalladas = [];

  for (const operacion of operaciones) {
    operacionesDetalladas.push(await attachOperacionDetalle(operacion));
  }

  return operacionesDetalladas;
}

function buildCajaResumen(ventas) {
  const resumen = ventas.reduce(
    (acc, movimiento) => {
      const efectivo = Number(movimiento.monto_efectivo || 0);
      const debito = Number(movimiento.monto_debito || 0);
      const esPago = movimiento.tipo_operacion === "pago_proveedor";
      const esIngresoManual = movimiento.tipo_operacion === "caja_movimiento_ingreso";
      const esEgresoManual = movimiento.tipo_operacion === "caja_movimiento_egreso";
      const esVenta = movimiento.tipo_operacion === "venta_normal" ||
        movimiento.tipo_operacion === "venta_pendiente_cobrada" ||
        movimiento.tipo_operacion === "venta_cuenta_corriente";
      const esCuentaCorrientePendiente = movimiento.tipo_operacion === "venta_cuenta_corriente";
      const tipoCobro = String(movimiento.tipo_cobro || "").toLowerCase();

      if (esPago || esEgresoManual) {
        acc.total_pagos_efectivo += efectivo;
        acc.total_pagos_debito += debito;
        acc.total_pagos_general += Number((efectivo + debito).toFixed(2));
      } else if (esIngresoManual) {
        acc.total_efectivo += efectivo;
      } else if (esCuentaCorrientePendiente) {
        acc.total_cuenta_corriente += Number(movimiento.total || 0);
      } else {
        acc.total_efectivo += efectivo;
        acc.total_debito += debito;

        if (tipoCobro === "transferencia") {
          acc.total_transferencia += debito;
        } else if (tipoCobro === "debito") {
          acc.total_debito_tarjeta += debito;
        } else if (tipoCobro === "mixto") {
          acc.total_debito_tarjeta += debito;
          acc.operaciones_mixtas += 1;
        }
      }

      if (esVenta) {
        acc.total_ventas += Number(movimiento.total || 0);

        if (Array.isArray(movimiento.productos)) {
          movimiento.productos.forEach((producto) => {
            if (producto.sin_costo_informado) {
              acc.total_ventas_manual_sin_costo += Number(producto.subtotal || 0);
              return;
            }

            acc.costo_estimado_vendido += Number(producto.costo_item || 0);
            acc.ganancia_bruta_estimada += Number(producto.ganancia_estimada || 0);
          });
        }
      }

      acc.total_general = Number(
        (acc.total_efectivo + acc.total_debito - acc.total_pagos_general).toFixed(2)
      );
      acc.resultado_estimado_dia = Number(
        (acc.ganancia_bruta_estimada - acc.total_pagos_general).toFixed(2)
      );
      return acc;
    },
    {
      total_efectivo: 0,
      total_debito: 0,
      total_debito_tarjeta: 0,
      total_transferencia: 0,
      total_cuenta_corriente: 0,
      total_pagos_efectivo: 0,
      total_pagos_debito: 0,
      total_pagos_general: 0,
      operaciones_mixtas: 0,
      total_general: 0,
      total_ventas: 0,
      costo_estimado_vendido: 0,
      ganancia_bruta_estimada: 0,
      total_ventas_manual_sin_costo: 0,
      resultado_estimado_dia: 0,
      saldo_inicial_mp: 0,
      saldo_mp_estimado: 0
    }
  );

  resumen.total_efectivo = Number(resumen.total_efectivo.toFixed(2));
  resumen.total_debito = Number(resumen.total_debito.toFixed(2));
  resumen.total_debito_tarjeta = Number(resumen.total_debito_tarjeta.toFixed(2));
  resumen.total_transferencia = Number(resumen.total_transferencia.toFixed(2));
  resumen.total_cuenta_corriente = Number(resumen.total_cuenta_corriente.toFixed(2));
  resumen.total_pagos_efectivo = Number(resumen.total_pagos_efectivo.toFixed(2));
  resumen.total_pagos_debito = Number(resumen.total_pagos_debito.toFixed(2));
  resumen.total_pagos_general = Number(resumen.total_pagos_general.toFixed(2));
  resumen.total_general = Number(resumen.total_general.toFixed(2));
  resumen.total_ventas = Number(resumen.total_ventas.toFixed(2));
  resumen.costo_estimado_vendido = Number(resumen.costo_estimado_vendido.toFixed(2));
  resumen.ganancia_bruta_estimada = Number(resumen.ganancia_bruta_estimada.toFixed(2));
  resumen.total_ventas_manual_sin_costo = Number(resumen.total_ventas_manual_sin_costo.toFixed(2));
  resumen.resultado_estimado_dia = Number(resumen.resultado_estimado_dia.toFixed(2));
  return resumen;
}

function buildCajaResumenConSaldoMp(ventas, apertura) {
  const resumen = buildCajaResumen(ventas);
  const saldoInicialMp = Number(apertura?.saldo_inicial_mp || 0);

  return {
    ...resumen,
    saldo_inicial_mp: Number(saldoInicialMp.toFixed(2)),
    saldo_mp_estimado: Number(
      (saldoInicialMp + Number(resumen.total_debito || 0) - Number(resumen.total_pagos_debito || 0)).toFixed(2)
    ),
    total_dinero_digital: Number(resumen.total_debito.toFixed(2))
  };
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

async function descontarStockPropioProducto(productoId, producto, deltaCantidad) {
  if (Number(producto.maneja_stock) !== 1) {
    return;
  }

  const costos = await normalizarInsumosCostos(await allQuery(
    "SELECT * FROM producto_costos_insumos WHERE producto_id = ? ORDER BY id ASC",
    [productoId]
  ));
  const cantidadDescontar = costos.length
    ? costos.reduce((acc, item) => acc + Number(item.cantidad_usada || 0), 0) * Number(deltaCantidad || 0)
    : Number(deltaCantidad || 0);

  await runQuery(
    "UPDATE productos SET stock = stock - ? WHERE id = ?",
    [cantidadDescontar, productoId]
  );
}

async function applyStockChange(productoId, deltaCantidad, options = {}) {
  if (!productoId || deltaCantidad === 0) {
    return;
  }

  const visited = options.visited || new Set();
  const productoKey = Number(productoId);
  if (visited.has(productoKey)) {
    return;
  }
  visited.add(productoKey);

  const producto = await getQuery(
    "SELECT id, maneja_stock, tipo, es_combo FROM productos WHERE id = ?",
    [productoId]
  );

  if (!producto) {
    return;
  }

  if (esProductoReceta(producto)) {
    const componentes = await getComponentesProductoCompuesto(producto.id);

    if (!componentes.length) {
      return;
    }

    for (const componente of componentes) {
      await applyStockChange(
        componente.producto_id,
        Number(deltaCantidad || 0) * Number(componente.cantidad || 0),
        { comoComponente: true, visited: new Set(visited) }
      );
    }

    return;
  }

  await descontarStockPropioProducto(productoId, producto, deltaCantidad);
}

async function applyStockForNewItems(items) {
  for (const item of items) {
    await applyStockChange(item.producto_id, item.cantidad);
  }
}

async function applyStockDiff(oldItems, newItems) {
  const deltaByProduct = new Map();

  for (const item of oldItems) {
    if (!item.producto_id) {
      continue;
    }

    const current = deltaByProduct.get(item.producto_id) || 0;
    deltaByProduct.set(item.producto_id, current - Number(item.cantidad || 0));
  }

  for (const item of newItems) {
    if (!item.producto_id) {
      continue;
    }

    const current = deltaByProduct.get(item.producto_id) || 0;
    deltaByProduct.set(item.producto_id, current + Number(item.cantidad || 0));
  }

  for (const [productoId, delta] of deltaByProduct.entries()) {
    await applyStockChange(productoId, delta);
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

app.post("/login", (req, res) => {
  const usuario = String(req.body?.usuario || "").trim();
  const password = String(req.body?.password || "");
  const remember = Boolean(req.body?.remember);
  const attemptKey = `${req.ip || "local"}:${usuario.toLowerCase()}`;
  const attempt = loginAttempts.get(attemptKey);

  if (!usuario || !password) {
    return res.status(400).json({ message: "Usuario y contrasena son obligatorios" });
  }

  db.get(
    "SELECT * FROM usuarios WHERE usuario = ?",
    [usuario],
    async (err, user) => {
      if (err) {
        console.error("Error DB login:", err.message);
        return res.status(500).json({ message: "Error en el servidor" });
      }

      if (!user) {
        registrarIntentoFallido(attemptKey);
        return res.status(401).json({ message: "Usuario no encontrado" });
      }

      if (Number(user.activo) !== 1) {
        registrarIntentoFallido(attemptKey);
        return res.status(403).json({ message: "Usuario inactivo" });
      }

      const valid = await bcrypt.compare(password, user.password);

      if (!valid) {
        registrarIntentoFallido(attemptKey);
        const updatedAttempt = loginAttempts.get(attemptKey);
        if (updatedAttempt?.lockedUntil && updatedAttempt.lockedUntil > Date.now()) {
          const minutes = Math.ceil((updatedAttempt.lockedUntil - Date.now()) / 60000);
          return res.status(429).json({ message: `Demasiados intentos fallidos. Reintentar en ${minutes} min.` });
        }
        return res.status(401).json({ message: "Contrasena incorrecta" });
      }

      loginAttempts.delete(attemptKey);
      const expiresInMs = remember ? 7 * 24 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000;
      db.run("UPDATE usuarios SET ultimo_acceso = ? WHERE id = ?", [new Date().toISOString(), user.id], (updateErr) => {
        if (updateErr) {
          console.error("Error actualizando ultimo acceso:", updateErr.message);
        }
      });

      return res.json({
        message: "Login correcto",
        token: crypto.randomBytes(32).toString("hex"),
        expires_at: new Date(Date.now() + expiresInMs).toISOString(),
        remember,
        user: {
          id: user.id,
          nombre: user.nombre,
          usuario: user.usuario,
          rol: user.rol,
          email: user.email || "",
          telefono: user.telefono || "",
          foto_url: user.foto_url || ""
        }
      });
    }
  );
});

function registrarIntentoFallido(key) {
  const current = loginAttempts.get(key) || { count: 0, lockedUntil: 0 };
  const count = current.lockedUntil && current.lockedUntil < Date.now() ? 1 : current.count + 1;
  loginAttempts.set(key, {
    count,
    lockedUntil: count >= MAX_LOGIN_ATTEMPTS ? Date.now() + LOGIN_LOCK_MS : 0
  });
}

function parseUsuarioPayload(body, includePassword = false) {
  const data = {
    nombre: String(body?.nombre || "").trim(),
    usuario: String(body?.usuario || "").trim(),
    rol: String(body?.rol || "operador").trim().toLowerCase(),
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
    rol: row.rol,
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
  const rol = String(req.query.rol || "").trim().toLowerCase();
  const params = [];
  const where = [];

  if (estado === "activos") where.push("activo = 1");
  if (estado === "inactivos") where.push("activo = 0");
  if (rol) {
    where.push("rol = ?");
    params.push(rol);
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
    console.error("Error al listar usuarios:", error.message);
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
    console.error("Error al obtener usuario:", error.message);
    return res.status(500).json({ message: "Error al obtener usuario" });
  }
});

app.post("/usuarios", async (req, res) => {
  const data = parseUsuarioPayload(req.body, true);

  if (!data.nombre || !data.usuario || !data.password || !data.confirmar_password || !data.rol) {
    return res.status(400).json({ message: "Nombre, usuario, contrasena y rol son obligatorios" });
  }

  if (data.password.length < 6) {
    return res.status(400).json({ message: "La contrasena debe tener al menos 6 caracteres" });
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
    console.error("Error al crear usuario:", error.message);
    return res.status(500).json({ message: "Error al crear usuario" });
  }
});

app.put("/usuarios/:id", async (req, res) => {
  const usuarioId = Number(req.params.id);
  const data = parseUsuarioPayload(req.body);

  if (!data.nombre || !data.usuario || !data.rol) {
    return res.status(400).json({ message: "Nombre, usuario y rol son obligatorios" });
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
    console.error("Error al actualizar usuario:", error.message);
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
    console.error("Error al cambiar estado del usuario:", error.message);
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

  if (password.length < 6) {
    return res.status(400).json({ message: "La contrasena debe tener al menos 6 caracteres" });
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
    console.error("Error al cambiar contrasena:", error.message);
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
    console.error("Error al guardar foto de usuario:", error.message);
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
    console.error("Error al actualizar perfil:", error.message);
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
    console.error("Error al eliminar usuario:", error.message);
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
    console.error("Error al guardar imagen de producto:", err.message);
    return res.status(500).json({ message: "Error al guardar imagen" });
  }
});

// Crear producto
app.post("/productos", async (req, res) => {
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
    const recetaSinStockFisico = tipoProducto === "compuesto";
    const costoBase = tipoProducto === "compuesto"
      ? await calcularCostoProductoCompuestoPayload(componentes, costos_extra)
      : usaCostos ? calcularCostoPorRendimiento(costos_insumos) : Number(precio_compra) || 0;
    const costoFinal = calcularCostoFinal(costoBase, iva_porcentaje, precio_compra_incluye_iva ? 1 : 0);
    const precioVentaFinal = Number(precio_venta) || calcularPrecioSugerido(
      costoFinal,
      categoriaData?.margen_porcentaje || 0,
      redondeo
    );
    const codigoFinal = String(codigo || "").trim() || await generarCodigoProducto(Number(categoria_id));

    const result = await runQuery(
      `INSERT INTO productos
      (nombre, categoria, precio_compra, precio_venta, stock, maneja_stock, proveedor_principal, proveedor_id, activo, observaciones, imagen_url, iva_porcentaje, precio_compra_incluye_iva, costo_final, categoria_id, redondeo,
       codigo, descripcion, stock_minimo, unidad_medida, codigo_barras, marca, presentacion, ubicacion, vencimiento, alerta_stock_minimo, usa_costos_varios, precio_referencial_proveedor, agregar_proveedor_info, es_combo, tipo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        tipoProducto
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
    console.error("Error al guardar producto:", err.message);
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
    const enriquecidos = [];

    for (const row of rows) {
      const costoConsumoUnitario = await getCostoConsumoUnitarioProducto(row.id, row);

      if (normalizarTipoProducto(row.tipo) === "compuesto") {
        const [stockDisponible, costoCompuesto] = await Promise.all([
          calcularStockDisponibleCompuesto(row.id),
          calcularCostoProductoCompuesto(row.id)
        ]);
        enriquecidos.push({
          ...row,
          stock_fisico: 0,
          stock_disponible: stockDisponible,
          stock_vendible_calculado: stockDisponible,
          precio_compra: costoCompuesto,
          costo_final: costoCompuesto,
          costo_teorico: costoCompuesto,
          costo_consumo_unitario: costoCompuesto,
          precio_sugerido: calcularPrecioSugerido(costoCompuesto, row.margen_porcentaje, row.redondeo)
        });
        continue;
      }

      const stockDisponibleCombo = Number(row.es_combo) === 1 ? await calcularStockDisponibleCompuesto(row.id) : undefined;
      const stockVendibleFraccionado = Number(row.es_combo) !== 1 && Number(row.usa_costos_varios) === 1 && Number(row.maneja_stock) === 1
        ? await calcularStockVendibleFraccionado(row.id, row.stock)
        : undefined;
      const stockVendibleCalculado = Number(row.es_combo) === 1
        ? stockDisponibleCombo
        : Number(row.usa_costos_varios) === 1 && Number(row.maneja_stock) === 1
          ? stockVendibleFraccionado
          : Number(row.stock || 0);
      enriquecidos.push({
        ...row,
        stock_fisico: Number(row.es_combo) === 1 ? 0 : Number(row.stock || 0),
        stock_disponible: stockDisponibleCombo,
        stock_vendible_calculado: stockVendibleCalculado,
        costo_teorico: Number(row.costo_final || row.precio_compra || 0),
        costo_consumo_unitario: costoConsumoUnitario,
        precio_sugerido: calcularPrecioSugerido(row.costo_final, row.margen_porcentaje, row.redondeo)
      });
    }

    return res.json(enriquecidos);
  } catch (err) {
    console.error("Error al listar productos:", err.message);
    return res.status(500).json({ message: "Error al obtener productos" });
  }
});

// Editar producto
app.put("/productos/:id", async (req, res) => {
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

  try {
    const existente = await getQuery("SELECT * FROM productos WHERE id = ?", [productoId]);

    if (!existente) {
      return res.status(404).json({ message: "Producto no encontrado" });
    }

    const categoriaData = categoria_id
      ? await getQuery("SELECT margen_porcentaje, maneja_stock, usa_costos_varios FROM categorias WHERE id = ?", [Number(categoria_id)])
      : null;
    if (!categoriaData) {
      return res.status(400).json({ message: "La categoria seleccionada no existe" });
    }
    const tipoProducto = normalizarTipoProducto(tipo);
    const usaCostos = tipoProducto === "simple" && (usa_costos_varios || categoriaData?.usa_costos_varios);
    const stockProducto = Number(stock) || 0;
    const recetaSinStockFisico = tipoProducto === "compuesto";
    const costoBase = tipoProducto === "compuesto"
      ? await calcularCostoProductoCompuestoPayload(componentes, costos_extra)
      : usaCostos ? calcularCostoPorRendimiento(costos_insumos) : Number(precio_compra) || 0;
    const costoFinal = calcularCostoFinal(costoBase, iva_porcentaje, precio_compra_incluye_iva ? 1 : 0);
    const precioVentaFinal = Number(precio_venta) || calcularPrecioSugerido(
      costoFinal,
      categoriaData?.margen_porcentaje || 0,
      redondeo
    );

    await runQuery(
      `UPDATE productos
       SET nombre = ?, categoria = ?, precio_compra = ?, precio_venta = ?, stock = ?,
           maneja_stock = ?, proveedor_principal = ?, proveedor_id = ?, activo = ?,
           observaciones = ?, imagen_url = ?, iva_porcentaje = ?, precio_compra_incluye_iva = ?,
           costo_final = ?, categoria_id = ?, redondeo = ?, codigo = ?, descripcion = ?, stock_minimo = ?,
           unidad_medida = ?, codigo_barras = ?, marca = ?, presentacion = ?, ubicacion = ?, vencimiento = ?,
           alerta_stock_minimo = ?, usa_costos_varios = ?, precio_referencial_proveedor = ?, agregar_proveedor_info = ?, es_combo = ?, tipo = ?
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
        tipoProducto,
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

    const actualizado = await getQuery("SELECT * FROM productos WHERE id = ?", [productoId]);
    await registrarCambiosProducto(productoId, existente, actualizado, usuario || "admin", "edicion");

    return res.json({ message: "Producto actualizado correctamente" });
  } catch (error) {
    console.error("Error al actualizar producto:", error.message);
    return res.status(500).json({ message: "Error al actualizar producto" });
  }
});

app.patch("/productos/:id/inactivar", async (req, res) => {
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
    console.error("Error al inactivar producto:", error.message);
    return res.status(500).json({ message: "Error al inactivar producto" });
  }
});

app.patch("/productos/:id/combo", async (req, res) => {
  const productoId = Number(req.params.id);
  const esCombo = req.body?.es_combo ? 1 : 0;

  try {
    const existente = await getQuery("SELECT * FROM productos WHERE id = ?", [productoId]);

    if (!existente) {
      return res.status(404).json({ message: "Producto no encontrado" });
    }

    await runQuery("UPDATE productos SET es_combo = ? WHERE id = ?", [esCombo, productoId]);
    const actualizado = await getQuery("SELECT * FROM productos WHERE id = ?", [productoId]);
    await registrarCambiosProducto(productoId, existente, actualizado, "admin", "combo");
    return res.json({ message: esCombo ? "Producto marcado como combo" : "Producto quitado de combos" });
  } catch (error) {
    console.error("Error al actualizar combo del producto:", error.message);
    return res.status(500).json({ message: "Error al actualizar combo del producto" });
  }
});

app.post("/productos_compuestos", async (req, res) => {
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
      console.error("Error rollback producto compuesto:", rollbackError.message);
    }

    console.error("Error al guardar producto compuesto:", error.message);
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
    console.error("Error al obtener producto compuesto:", error.message);
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
    console.error("Error al calcular stock disponible:", error.message);
    return res.status(500).json({ message: "Error al calcular stock disponible" });
  }
});

app.patch("/productos/aumento-masivo", async (req, res) => {
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
    console.error("Error al aplicar aumento masivo:", error.message);
    return res.status(500).json({ message: "Error al aplicar aumento masivo" });
  }
});

app.patch("/productos/:id/reactivar", async (req, res) => {
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
    console.error("Error al reactivar producto:", error.message);
    return res.status(500).json({ message: "Error al reactivar producto" });
  }
});

app.delete("/productos/:id", async (req, res) => {
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

    const tieneMovimientos = Number(usoEnDetalle?.total || 0) > 0;

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
    console.error("Error al eliminar producto:", error.message);
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
    console.error("Error al listar categorias:", error.message);
    return res.status(500).json({ message: "Error al obtener categorias" });
  }
});

app.post("/categorias", async (req, res) => {
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
    console.error("Error al crear categoria:", error.message);
    return res.status(500).json({ message: "Error al crear categoria" });
  }
});

app.put("/categorias/:id", async (req, res) => {
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
    console.error("Error al actualizar categoria:", error.message);
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
    console.error("Error al obtener costos por rendimiento:", error.message);
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
    console.error("Error al obtener proveedores del producto:", error.message);
    return res.status(500).json({ message: "Error al obtener proveedores del producto" });
  }
});

app.post("/productos/:id/proveedores", async (req, res) => {
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
    console.error("Error al asociar proveedor al producto:", error.message);
    return res.status(500).json({ message: "Error al asociar proveedor al producto" });
  }
});

app.post("/productos/:id/movimientos-stock", async (req, res) => {
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
    const esStockCalculado = normalizarTipoProducto(producto.tipo) === "compuesto";
    if (esStockCalculado) {
      return res.status(400).json({ message: "Este producto no posee stock propio. Ajusta sus ingredientes." });
    }

    const stockAnterior = Number(producto.stock || 0);
    const tiposPositivos = ["ingreso", "ajuste positivo", "devolucion"];
    const stockNuevo = tiposPositivos.includes(tipoMovimiento.toLowerCase())
      ? stockAnterior + cantidad
      : stockAnterior - cantidad;

    await runQuery("BEGIN TRANSACTION");
    await runQuery(
      `INSERT INTO movimientos_stock
      (producto_id, tipo_movimiento, cantidad, stock_anterior, stock_nuevo, motivo, proveedor_id, usuario, fecha, hora)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [productoId, tipoMovimiento, cantidad, stockAnterior, stockNuevo, motivo, proveedorId, usuario, fecha, hora]
    );
    await runQuery("UPDATE productos SET stock = ? WHERE id = ?", [stockNuevo, productoId]);
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
    console.error("Error al registrar movimiento de stock:", error.message);
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
    console.error("Error al obtener movimientos de stock:", error.message);
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
    console.error("Error al obtener historial del producto:", error.message);
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
    console.error("Error al listar proveedores:", error.message);
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
    console.error("Error al obtener movimientos del proveedor:", error.message);
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
    console.error("Error al crear proveedor:", error.message);
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
    console.error("Error al actualizar proveedor:", error.message);
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
    console.error("Error al cambiar estado del proveedor:", error.message);
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
    console.error("Error al eliminar proveedor:", error.message);
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
    console.error("Error al listar pagos:", error.message);
    return res.status(500).json({ message: "Error al obtener pagos" });
  }
});

// Registrar pago
app.post("/pagos", async (req, res) => {
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
    console.error("Error al registrar pago:", error.message);
    return res.status(500).json({ message: "Error al registrar pago" });
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
      console.error("Error rollback venta:", rollbackError.message);
    }

    console.error("Error al registrar venta:", error.message);
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
    console.error("Error al obtener cuenta corriente:", error.message);
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
    console.error("Error al obtener movimientos de cuenta corriente:", error.message);
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
      console.error("Error rollback venta a cuenta:", rollbackError.message);
    }
    console.error("Error al registrar venta a cuenta:", error.message);
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
      console.error("Error rollback pago cuenta corriente:", rollbackError.message);
    }

    console.error("Error al pagar cuenta corriente:", error.message);
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
    console.error("Error al obtener resumen de caja:", error.message);
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
    console.error("Error al obtener apertura de caja:", error.message);
    return res.status(500).json({ message: "Error al obtener apertura de caja" });
  }
});

// Registrar apertura de caja
app.post("/caja/apertura", async (req, res) => {
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
    console.error("Error al registrar apertura de caja:", error.message);
    return res.status(500).json({ message: "Error al registrar apertura de caja" });
  }
});

app.post("/caja/movimientos", async (req, res) => {
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
    console.error("Error al registrar movimiento de caja:", error.message);
    return res.status(500).json({ message: "Error al registrar movimiento de caja" });
  }
});

// Cerrar caja
app.post("/caja/cierre", async (req, res) => {
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

    const cajaCerrada = await getQuery(
      "SELECT * FROM caja_aperturas WHERE id = ?",
      [apertura.id]
    );

    return res.json({
      message: "Caja cerrada correctamente",
      caja: cajaCerrada
    });
  } catch (error) {
    console.error("Error al cerrar caja:", error.message);
    return res.status(500).json({ message: "Error al cerrar caja" });
  }
});

function mapCajaArqueo(arqueo) {
  return {
    ...arqueo,
    conteo_detalle: parseJsonOrFallback(arqueo.conteo_detalle, {}),
    cuentas_detalle: parseJsonOrFallback(arqueo.cuentas_detalle, []),
    resumen_snapshot: parseJsonOrFallback(arqueo.resumen_snapshot, null)
  };
}

async function getCajaParaArqueos() {
  return await getCajaAbiertaActual() || await getUltimaCajaRegistrada();
}

async function buildCajaArqueoData(apertura, body = {}) {
  const usuario = String(body.usuario || "admin").trim() || "admin";
  const observaciones = String(body.observaciones || "").trim();
  const conteo = body.conteo || {};
  const cuentas = Array.isArray(body.cuentas) ? body.cuentas : [];
  const operaciones = await buildCajaSnapshot(apertura.id);
  const resumen = buildCajaResumenConSaldoMp(operaciones, apertura);
  const efectivoEsperado = Number(
    (
      Number(apertura.monto_apertura || 0) +
      Number(resumen.total_efectivo || 0) -
      Number(resumen.total_pagos_efectivo || 0)
    ).toFixed(2)
  );
  const conteoResultado = buildConteoBilletes(conteo);
  const efectivoContado = Number(conteoResultado.total || 0);
  const diferenciaEfectivo = Number((efectivoContado - efectivoEsperado).toFixed(2));
  const cuentasDetalle = cuentas.map((cuenta, index) => {
    const nombre = String(cuenta.nombre || `Cuenta ${index + 1}`).trim() || `Cuenta ${index + 1}`;
    const saldoInicial = Number(cuenta.saldo_inicial || 0);
    const saldoActual = Number(cuenta.saldo_actual || 0);
    return {
      nombre,
      saldo_inicial: Number(saldoInicial.toFixed(2)),
      saldo_actual: Number(saldoActual.toFixed(2)),
      recaudacion_real: Number((saldoActual - saldoInicial).toFixed(2))
    };
  });
  const digitalReal = Number(
    cuentasDetalle.reduce((acc, cuenta) => acc + Number(cuenta.recaudacion_real || 0), 0).toFixed(2)
  );
  const digitalEsperado = Number((
    Number(resumen.total_debito_tarjeta ?? resumen.total_debito ?? 0) +
    Number(resumen.total_transferencia || 0)
  ).toFixed(2));
  const diferenciaDigital = Number((digitalReal - digitalEsperado).toFixed(2));
  const resultadoFinal = Number((diferenciaEfectivo + diferenciaDigital).toFixed(2));
  const estado = resultadoFinal >= 0 ? "Sobra" : "Falta";

  return {
    usuario,
    observaciones,
    efectivoEsperado,
    efectivoContado,
    diferenciaEfectivo,
    digitalEsperado,
    digitalReal,
    diferenciaDigital,
    resultadoFinal,
    estado,
    conteoDetalle: conteoResultado.detalle,
    cuentasDetalle,
    resumen
  };
}

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
    console.error("Error al obtener arqueos:", error.message);
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
    console.error("Error al obtener detalle del arqueo:", error.message);
    return res.status(500).json({ message: "Error al obtener detalle del arqueo" });
  }
});

// Registrar arqueo de caja
app.post("/caja/arqueos", async (req, res) => {
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
    console.error("Error al registrar arqueo:", error.message);
    return res.status(500).json({ message: "Error al registrar arqueo" });
  }
});

// Editar arqueo de caja
app.put("/caja/arqueos/:id", async (req, res) => {
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
    console.error("Error al editar arqueo:", error.message);
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
    console.error("Error al obtener historial de cierres:", error.message);
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
    console.error("Error al obtener detalle del cierre:", error.message);
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
    console.error("Error al listar pendientes:", error.message);
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
    const clientes = await allQuery(
      `${includeInactive ? "SELECT * FROM clientes" : "SELECT * FROM clientes WHERE activo = 1"} ORDER BY nombre ASC`
    );
    const conMetricas = [];
    for (const cliente of clientes) {
      conMetricas.push({ ...cliente, ...(await buildClienteCuentaResumen(cliente.id)) });
    }
    return res.json(conMetricas);
  } catch (error) {
    console.error("Error al listar clientes:", error.message);
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
    console.error("Error al guardar foto de cliente:", error.message);
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
    console.error("Error al guardar logo:", error.message);
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
    console.error("Error al crear cliente:", error.message);
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
    console.error("Error al actualizar cliente:", error.message);
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
    console.error("Error al cambiar estado del cliente:", error.message);
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
    console.error("Error al eliminar cliente:", error.message);
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
    console.error("Error al obtener historial del cliente:", error.message);
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
    console.error("Error al obtener detalle de venta:", error.message);
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
      console.error("Error rollback pendiente:", rollbackError.message);
    }

    console.error("Error al actualizar ticket pendiente:", error.message);
    return res.status(500).json({ message: "Error al actualizar ticket pendiente" });
  }
});

// Cobrar ticket pendiente
app.post("/ventas/:id/cobrar", async (req, res) => {
  const ventaId = req.params.id;
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

    return res.json({ message: "Ticket pendiente cobrado" });
  } catch (error) {
    console.error("Error al cobrar ticket pendiente:", error.message);
    return res.status(500).json({ message: "Error al cobrar ticket pendiente" });
  }
});

// Anular ticket pendiente
app.post("/ventas/:id/anular", async (req, res) => {
  const ventaId = req.params.id;
  const authorizationCode = String(req.body.authorization_code || "").trim();

  if (authorizationCode !== AUTHORIZATION_CANCEL_CODE) {
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
      console.error("Error rollback anulacion:", rollbackError.message);
    }

    console.error("Error al anular ticket pendiente:", error.message);
    return res.status(500).json({ message: "Error al anular ticket pendiente" });
  }
});

app.patch("/ventas/:id/cobro", async (req, res) => {
  const ventaId = Number(req.params.id);

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
    console.error("Error al actualizar cobro:", error.message);
    return res.status(500).json({ message: "Error al actualizar cobro" });
  }
});

app.post("/ventas/:id/anular-cobrada", async (req, res) => {
  const ventaId = Number(req.params.id);
  const authorizationCode = String(req.body.authorization_code || "").trim();

  if (authorizationCode !== AUTHORIZATION_CANCEL_CODE) {
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

    await runQuery("COMMIT");

    return res.json({ message: `Ticket anulado ${ventaId}` });
  } catch (error) {
    try {
      await runQuery("ROLLBACK");
    } catch (rollbackError) {
      console.error("Error rollback anulacion cobrada:", rollbackError.message);
    }

    console.error("Error al anular ticket cobrado:", error.message);
    return res.status(500).json({ message: "Error al anular ticket cobrado" });
  }
});

// Consultar ventas
app.get("/ventas", async (req, res) => {
  try {
    const ventas = await allQuery("SELECT * FROM ventas ORDER BY id DESC");
    return res.json(ventas);
  } catch (error) {
    console.error("Error al listar ventas:", error.message);
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
    console.error("Error al listar detalle de ventas:", error.message);
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
    console.error("Error al obtener configuracion:", error.message);
    return res.status(500).json({ message: "Error al obtener configuracion" });
  }
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
      console.error("Error rollback configuracion:", rollbackError.message);
    }

    console.error("Error al guardar configuracion:", error.message);
    return res.status(500).json({ message: "Error al guardar configuracion" });
  }
});

// Producto de prueba
app.get("/test-producto", (req, res) => {
  db.run(
    `INSERT INTO productos
    (nombre, categoria, precio_compra, precio_venta, stock, maneja_stock, proveedor_principal, activo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["Producto Prueba", "Test", 100, 200, 5, 1, "Proveedor Test", 1],
    function (err) {
      if (err) {
        console.error("Error test-producto:", err.message);
        return res.status(500).send("Error al insertar producto de prueba");
      }

      return res.send(`Producto de prueba insertado con ID ${this.lastID}`);
    }
  );
});

Promise.all([
  ensureUsuariosSchema(),
  ensureCajaMovimientosTable(),
  ensureProveedoresSchema(),
  ensureProductosSchema(),
  ensureClientesSchema(),
  ensureConfiguracionSchema()
])
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Servidor corriendo en http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Error al preparar la base de datos:", error.message);
    process.exit(1);
  });
