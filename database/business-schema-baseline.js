// MT-1E4C: autoridad reusable unica para construir DESDE CERO el business schema del baseline
// 001 (legacy_runtime_baseline). Sintetizado a partir de la union de database/init-db.js y los
// ensure*Schema de backend/server.js (y sus servicios) -- represando el ESTADO FINAL deseado de
// cada tabla directamente (columnas ya integradas), nunca un CREATE parcial seguido de ALTER TABLE
// incremental. NO ejecuta backfills legacy (esos operan sobre datos que una DB fresca no tiene).
// NO crea tenant_identity (no pertenece al baseline 001 -- ver database/provision-tenant-identity.js,
// que es su autoridad separada). NO crea atlas_schema_migrations (eso es responsabilidad exclusiva
// de un futuro provisioner/adopter, nunca de este builder). NO siembra datos demo (admin, Consumidor
// Final, Juan Perez) -- esos quedan en database/init-db.js, fuera de esta transaccion.
//
// Contrato de conexion: recibe `db` ya abierto por el caller. NUNCA abre su propia conexion sqlite3,
// NUNCA ejecuta BEGIN/COMMIT/ROLLBACK -- el caller controla el limite transaccional completo. Esto
// permite que el mismo modulo sirva a database/init-db.js hoy y a un futuro provisioner de tenants
// nuevos, bajo politicas de transaccion distintas.
function runQuery(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) { reject(error); return; }
      resolve(this);
    });
  });
}

function getQuery(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) { reject(error); return; }
      resolve(row);
    });
  });
}

// Familias de defaults canonicos requeridos por el baseline (REQUIRED_RUNTIME_DEFAULT en
// backend/legacyBaselineVerifier.js). Valores identicos a los que backend/services/cajaService.js,
// backend/services/pagoService.js y backend/services/cuentaDestinoService.js siembran hoy via
// self-healing -- esta es la misma autoridad de datos, aplicada de forma explicita.
const CAJA_DENOMINACIONES_ARQUEO_DEFAULTS = [
  { denominacion: 10, modo: "conservar_todo", tamano_grupo: null, orden: 10 },
  { denominacion: 20, modo: "conservar_todo", tamano_grupo: null, orden: 20 },
  { denominacion: 50, modo: "conservar_todo", tamano_grupo: null, orden: 30 },
  { denominacion: 100, modo: "conservar_todo", tamano_grupo: null, orden: 40 },
  { denominacion: 200, modo: "conservar_todo", tamano_grupo: null, orden: 50 },
  { denominacion: 500, modo: "agrupar", tamano_grupo: 2, orden: 60 },
  { denominacion: 1000, modo: "extraer_todo", tamano_grupo: null, orden: 70 },
  { denominacion: 2000, modo: "extraer_todo", tamano_grupo: null, orden: 80 },
  { denominacion: 10000, modo: "extraer_todo", tamano_grupo: null, orden: 90 },
  { denominacion: 20000, modo: "extraer_todo", tamano_grupo: null, orden: 100 }
];

const TIPOS_PAGO_DEFAULTS = [
  { codigo: "efectivo", nombre: "Efectivo", activo: 1, impacta_caja: 1, impacta_digital: 0, permite_mixto: 0, requiere_caja_abierta: 1, orden: 10, usa_recargo: 0, porcentaje_recargo: 0, permite_cuotas: 0, cuotas_json: [] },
  { codigo: "debito", nombre: "Debito", activo: 1, impacta_caja: 0, impacta_digital: 1, permite_mixto: 0, requiere_caja_abierta: 1, orden: 20, usa_recargo: 0, porcentaje_recargo: 0, permite_cuotas: 0, cuotas_json: [] },
  { codigo: "transferencia", nombre: "Transferencia", activo: 1, impacta_caja: 0, impacta_digital: 1, permite_mixto: 0, requiere_caja_abierta: 1, orden: 30, usa_recargo: 0, porcentaje_recargo: 0, permite_cuotas: 0, cuotas_json: [] },
  { codigo: "mixto", nombre: "Mixto", activo: 1, impacta_caja: 1, impacta_digital: 1, permite_mixto: 1, requiere_caja_abierta: 1, orden: 40, usa_recargo: 0, porcentaje_recargo: 0, permite_cuotas: 0, cuotas_json: [] }
];

const CUENTAS_DESTINO_DEFAULTS = [
  { nombre: "Caja efectivo", tipo_destino: "efectivo", orden: 10 },
  { nombre: "Mercado Pago", tipo_destino: "billetera", orden: 20 }
];

async function crearBaseline001EnConexion(db) {
  // ---- Tablas base (union init-db.js + server.js ensure*, estado final) ----

  await runQuery(db, `
    CREATE TABLE usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      usuario TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      rol TEXT NOT NULL,
      activo INTEGER NOT NULL DEFAULT 1,
      email TEXT,
      telefono TEXT,
      foto_url TEXT,
      ultimo_acceso TEXT,
      creado_en TEXT,
      actualizado_en TEXT,
      intentos_fallidos INTEGER NOT NULL DEFAULT 0,
      bloqueado_hasta TEXT
    )
  `);

  await runQuery(db, `
    CREATE TABLE sesiones (
      token TEXT PRIMARY KEY,
      usuario_id INTEGER NOT NULL,
      nombre TEXT NOT NULL,
      rol TEXT NOT NULL,
      expira TEXT NOT NULL,
      auth_mode TEXT NOT NULL DEFAULT 'legacy',
      central_id INTEGER,
      membership_id INTEGER,
      empresa_id INTEGER
    )
  `);

  await runQuery(db, `
    CREATE TABLE categorias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      margen_porcentaje REAL NOT NULL DEFAULT 0,
      activo INTEGER NOT NULL DEFAULT 1,
      maneja_stock INTEGER NOT NULL DEFAULT 1,
      usa_costos_varios INTEGER NOT NULL DEFAULT 0
    )
  `);

  await runQuery(db, `
    CREATE TABLE productos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      categoria TEXT,
      precio_compra REAL NOT NULL DEFAULT 0,
      precio_venta REAL NOT NULL DEFAULT 0,
      stock REAL NOT NULL DEFAULT 0,
      maneja_stock INTEGER NOT NULL DEFAULT 1,
      proveedor_principal TEXT,
      activo INTEGER NOT NULL DEFAULT 1,
      proveedor_id INTEGER,
      eliminado INTEGER NOT NULL DEFAULT 0,
      observaciones TEXT,
      imagen_url TEXT,
      iva_porcentaje REAL NOT NULL DEFAULT 0,
      precio_compra_incluye_iva INTEGER NOT NULL DEFAULT 0,
      costo_final REAL NOT NULL DEFAULT 0,
      categoria_id INTEGER,
      redondeo INTEGER NOT NULL DEFAULT 0,
      codigo TEXT,
      descripcion TEXT,
      stock_minimo REAL NOT NULL DEFAULT 0,
      unidad_medida TEXT NOT NULL DEFAULT 'unidad',
      codigo_barras TEXT,
      marca TEXT,
      presentacion TEXT,
      ubicacion TEXT,
      vencimiento TEXT,
      alerta_stock_minimo INTEGER NOT NULL DEFAULT 1,
      usa_costos_varios INTEGER NOT NULL DEFAULT 0,
      precio_referencial_proveedor REAL NOT NULL DEFAULT 0,
      agregar_proveedor_info INTEGER NOT NULL DEFAULT 0,
      costo_economico REAL,
      iva_venta_tratamiento TEXT,
      iva_venta_alicuota REAL,
      modelo_fiscal TEXT NOT NULL DEFAULT 'legacy',
      precio_venta_modo TEXT NOT NULL DEFAULT 'manual',
      es_combo INTEGER NOT NULL DEFAULT 0,
      aplica_para_combo INTEGER NOT NULL DEFAULT 0,
      tipo TEXT NOT NULL DEFAULT 'simple',
      rendimiento_receta INTEGER NOT NULL DEFAULT 1
    )
  `);

  await runQuery(db, `
    CREATE TABLE producto_costos_insumos (
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

  await runQuery(db, `
    CREATE TABLE producto_componentes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      producto_compuesto_id INTEGER NOT NULL,
      producto_id INTEGER NOT NULL,
      cantidad REAL NOT NULL DEFAULT 1,
      FOREIGN KEY (producto_compuesto_id) REFERENCES productos(id),
      FOREIGN KEY (producto_id) REFERENCES productos(id)
    )
  `);

  await runQuery(db, `
    CREATE TABLE producto_costos_extra (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      producto_compuesto_id INTEGER NOT NULL,
      descripcion TEXT NOT NULL,
      monto REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (producto_compuesto_id) REFERENCES productos(id)
    )
  `);

  await runQuery(db, `
    CREATE TABLE producto_proveedores (
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

  await runQuery(db, `
    CREATE TABLE movimientos_stock (
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
      origen_tipo TEXT,
      origen_id INTEGER,
      idempotency_key TEXT,
      movimiento_stock_reversa_id INTEGER,
      FOREIGN KEY (producto_id) REFERENCES productos(id),
      FOREIGN KEY (proveedor_id) REFERENCES proveedores(id),
      FOREIGN KEY (movimiento_stock_reversa_id) REFERENCES movimientos_stock(id)
    )
  `);
  await runQuery(db, "CREATE INDEX idx_movimientos_stock_producto ON movimientos_stock(producto_id)");
  await runQuery(db, "CREATE INDEX idx_movimientos_stock_origen ON movimientos_stock(origen_tipo, origen_id)");
  await runQuery(db, "CREATE INDEX idx_movimientos_stock_reversa ON movimientos_stock(movimiento_stock_reversa_id)");
  await runQuery(db, `
    CREATE UNIQUE INDEX idx_movimientos_stock_manual_idempotency
    ON movimientos_stock(origen_tipo, idempotency_key)
    WHERE idempotency_key IS NOT NULL AND idempotency_key != ''
  `);

  await runQuery(db, `
    CREATE TABLE historial_productos (
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

  await runQuery(db, `
    CREATE TABLE combo_componentes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      combo_producto_id INTEGER NOT NULL,
      producto_id INTEGER NOT NULL,
      cantidad REAL NOT NULL DEFAULT 1,
      FOREIGN KEY (combo_producto_id) REFERENCES productos(id),
      FOREIGN KEY (producto_id) REFERENCES productos(id)
    )
  `);

  await runQuery(db, `
    CREATE TABLE clientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      tipo_cliente TEXT NOT NULL DEFAULT 'cliente',
      telefono TEXT,
      direccion TEXT,
      alias TEXT,
      observaciones TEXT,
      limite_fiado REAL NOT NULL DEFAULT 0,
      activo INTEGER NOT NULL DEFAULT 1,
      dni_cuit TEXT,
      tipo_persona TEXT NOT NULL DEFAULT 'fisica',
      tipo_cuenta_corriente TEXT NOT NULL DEFAULT 'normal',
      email TEXT,
      contacto TEXT,
      localidad TEXT,
      codigo_postal TEXT,
      dias_vencimiento INTEGER NOT NULL DEFAULT 30,
      dia_vencimiento_fijo INTEGER,
      moneda TEXT NOT NULL DEFAULT 'ARS',
      habilita_cuenta_corriente INTEGER NOT NULL DEFAULT 1,
      notas TEXT,
      foto_url TEXT,
      suspendido INTEGER NOT NULL DEFAULT 0,
      perfil_cliente TEXT NOT NULL DEFAULT 'normal',
      permite_excedente INTEGER NOT NULL DEFAULT 0,
      requiere_autorizacion INTEGER NOT NULL DEFAULT 0,
      usa_reglas_personalizadas INTEGER NOT NULL DEFAULT 0
    )
  `);
  await runQuery(db, "CREATE UNIQUE INDEX idx_clientes_dni_cuit_unique ON clientes(dni_cuit) WHERE dni_cuit IS NOT NULL AND TRIM(dni_cuit) != ''");

  await runQuery(db, `
    CREATE TABLE ventas (
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
      caja_id INTEGER,
      cuenta_cobro_id INTEGER,
      recargo_porcentaje REAL NOT NULL DEFAULT 0,
      recargo_monto REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (cliente_id) REFERENCES clientes(id)
    )
  `);
  await runQuery(db, "CREATE INDEX idx_ventas_estado ON ventas(estado)");
  await runQuery(db, "CREATE INDEX idx_ventas_cliente ON ventas(cliente_id)");
  await runQuery(db, "CREATE INDEX idx_ventas_caja ON ventas(caja_id)");

  await runQuery(db, `
    CREATE TABLE detalle_ventas (
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
  await runQuery(db, "CREATE INDEX idx_detalle_ventas_venta ON detalle_ventas(venta_id)");

  await runQuery(db, `
    CREATE TABLE modificadores (
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

  await runQuery(db, `
    CREATE TABLE producto_modificadores (
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
  await runQuery(db, "CREATE INDEX idx_producto_modificadores_producto ON producto_modificadores(producto_id)");

  await runQuery(db, `
    CREATE TABLE modificador_componentes (
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

  await runQuery(db, `
    CREATE TABLE detalle_venta_modificadores (
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
  await runQuery(db, "CREATE INDEX idx_detalle_venta_modificadores_detalle ON detalle_venta_modificadores(detalle_venta_id)");

  await runQuery(db, `
    CREATE TABLE detalle_venta_componentes_snapshot (
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
  await runQuery(db, "CREATE INDEX idx_detalle_venta_componentes_snapshot_detalle ON detalle_venta_componentes_snapshot(detalle_venta_id)");

  await runQuery(db, `
    CREATE TABLE detalle_venta_receta_snapshot (
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
  await runQuery(db, "CREATE INDEX idx_dvrs_venta ON detalle_venta_receta_snapshot(venta_id)");
  await runQuery(db, "CREATE INDEX idx_dvrs_detalle ON detalle_venta_receta_snapshot(detalle_venta_id)");
  await runQuery(db, "CREATE INDEX idx_dvrs_componente ON detalle_venta_receta_snapshot(componente_id)");

  await runQuery(db, `
    CREATE TABLE pagos_cuenta_corriente (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venta_id INTEGER NOT NULL,
      cliente_id INTEGER NOT NULL,
      fecha TEXT NOT NULL,
      hora TEXT NOT NULL,
      monto_pagado REAL NOT NULL DEFAULT 0,
      tipo_cobro TEXT NOT NULL,
      monto_efectivo REAL NOT NULL DEFAULT 0,
      monto_debito REAL NOT NULL DEFAULT 0,
      caja_id INTEGER,
      group_id TEXT,
      observacion TEXT,
      numero_comprobante TEXT,
      usuario_id INTEGER,
      usuario_nombre TEXT,
      revertido INTEGER NOT NULL DEFAULT 0,
      reversa_de_group_id TEXT,
      motivo_reversa TEXT,
      usuario_reversa_id INTEGER,
      usuario_reversa_nombre TEXT,
      fecha_reversa TEXT,
      hora_reversa TEXT,
      tipo_movimiento TEXT NOT NULL DEFAULT 'cobro',
      FOREIGN KEY (venta_id) REFERENCES ventas(id),
      FOREIGN KEY (cliente_id) REFERENCES clientes(id)
    )
  `);

  await runQuery(db, `
    CREATE TABLE recalculos_cuenta_corriente (
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

  await runQuery(db, `
    CREATE TABLE proveedores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      alias TEXT,
      telefono TEXT,
      cuit TEXT,
      observaciones TEXT,
      activo INTEGER NOT NULL DEFAULT 1,
      email TEXT,
      contacto TEXT,
      direccion TEXT,
      localidad TEXT,
      codigo_postal TEXT,
      tipo_persona TEXT NOT NULL DEFAULT 'juridica',
      maneja_cuenta_corriente INTEGER NOT NULL DEFAULT 0,
      limite_credito REAL NOT NULL DEFAULT 0,
      dias_vencimiento INTEGER NOT NULL DEFAULT 0,
      dia_vencimiento_fijo INTEGER,
      moneda TEXT NOT NULL DEFAULT 'ARS',
      tipo_impacto TEXT NOT NULL DEFAULT 'otro_no_computable',
      categoria_id INTEGER,
      categoria_especial TEXT,
      condicion_iva TEXT NOT NULL DEFAULT 'no_informado',
      tipo_comprobante TEXT NOT NULL DEFAULT 'otro',
      iva_alicuota REAL NOT NULL DEFAULT 21
    )
  `);

  await runQuery(db, `
    CREATE TABLE pagos (
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
      caja_id INTEGER,
      categoria_pago TEXT NOT NULL DEFAULT 'otro_no_computable',
      comprobante TEXT,
      numero_comprobante TEXT,
      cuenta_destino TEXT,
      referencia TEXT,
      observaciones TEXT,
      es_cuenta_corriente INTEGER NOT NULL DEFAULT 0,
      iva_credito_fiscal REAL NOT NULL DEFAULT 0,
      compra_id INTEGER,
      cuenta_destino_id_snapshot INTEGER,
      cuenta_cobro_id INTEGER,
      FOREIGN KEY (proveedor_id) REFERENCES proveedores(id)
    )
  `);
  await runQuery(db, "CREATE INDEX idx_pagos_compra ON pagos(compra_id)");

  await runQuery(db, `
    CREATE TABLE compras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proveedor_id INTEGER NOT NULL,
      fecha_compra TEXT NOT NULL,
      hora TEXT,
      concepto TEXT,
      tipo_impacto TEXT NOT NULL DEFAULT 'otro_no_computable',
      moneda TEXT NOT NULL DEFAULT 'ARS',
      total_compra REAL NOT NULL DEFAULT 0,
      saldo_pendiente REAL NOT NULL DEFAULT 0,
      estado TEXT NOT NULL DEFAULT 'pendiente',
      observaciones TEXT,
      usuario TEXT,
      created_at TEXT,
      updated_at TEXT,
      anulada_at TEXT,
      anulada_por TEXT,
      motivo_anulacion TEXT,
      FOREIGN KEY (proveedor_id) REFERENCES proveedores(id)
    )
  `);
  await runQuery(db, "CREATE INDEX idx_compras_proveedor_estado ON compras(proveedor_id, estado)");

  await runQuery(db, `
    CREATE TABLE compra_comprobantes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      compra_id INTEGER NOT NULL,
      tipo_comprobante TEXT NOT NULL,
      punto_venta TEXT,
      numero_comprobante TEXT,
      fecha_emision TEXT,
      fecha_recepcion TEXT,
      proveedor_nombre_snapshot TEXT,
      proveedor_cuit_snapshot TEXT,
      condicion_iva_proveedor_snapshot TEXT,
      moneda TEXT NOT NULL DEFAULT 'ARS',
      neto_gravado REAL,
      iva_total REAL,
      monto_exento REAL,
      monto_no_gravado REAL,
      otros_tributos REAL,
      total_comprobante REAL NOT NULL DEFAULT 0,
      estado TEXT NOT NULL DEFAULT 'registrado',
      observaciones TEXT,
      created_at TEXT,
      updated_at TEXT,
      anulado_at TEXT,
      anulado_por TEXT,
      motivo_anulacion TEXT,
      FOREIGN KEY (compra_id) REFERENCES compras(id)
    )
  `);
  await runQuery(db, "CREATE INDEX idx_compra_comprobantes_compra ON compra_comprobantes(compra_id)");

  await runQuery(db, `
    CREATE TABLE compra_comprobante_iva (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comprobante_id INTEGER NOT NULL,
      alicuota REAL NOT NULL,
      neto_gravado REAL NOT NULL DEFAULT 0,
      iva_monto REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (comprobante_id) REFERENCES compra_comprobantes(id)
    )
  `);
  await runQuery(db, "CREATE INDEX idx_compra_comprobante_iva_comprobante ON compra_comprobante_iva(comprobante_id)");
  await runQuery(db, "CREATE UNIQUE INDEX idx_compra_comprobante_iva_unique ON compra_comprobante_iva(comprobante_id, alicuota)");

  await runQuery(db, `
    CREATE TABLE compra_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      compra_id INTEGER NOT NULL,
      producto_id INTEGER,
      descripcion_snapshot TEXT NOT NULL,
      cantidad_comprada REAL NOT NULL,
      unidad_snapshot TEXT,
      costo_unitario REAL NOT NULL DEFAULT 0,
      subtotal REAL NOT NULL DEFAULT 0,
      afecta_stock INTEGER NOT NULL DEFAULT 0,
      observaciones TEXT,
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (compra_id) REFERENCES compras(id),
      FOREIGN KEY (producto_id) REFERENCES productos(id)
    )
  `);
  await runQuery(db, "CREATE INDEX idx_compra_items_compra ON compra_items(compra_id)");
  await runQuery(db, "CREATE INDEX idx_compra_items_producto ON compra_items(producto_id)");

  await runQuery(db, `
    CREATE TABLE compra_recepciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      compra_id INTEGER NOT NULL,
      fecha TEXT NOT NULL,
      hora TEXT,
      observaciones TEXT,
      usuario TEXT,
      estado TEXT NOT NULL DEFAULT 'registrada',
      idempotency_key TEXT,
      created_at TEXT,
      anulada_at TEXT,
      anulada_por TEXT,
      motivo_anulacion TEXT,
      FOREIGN KEY (compra_id) REFERENCES compras(id)
    )
  `);
  await runQuery(db, "CREATE INDEX idx_compra_recepciones_compra ON compra_recepciones(compra_id)");
  await runQuery(db, "CREATE UNIQUE INDEX idx_compra_recepciones_idempotency ON compra_recepciones(compra_id, idempotency_key)");

  await runQuery(db, `
    CREATE TABLE compra_recepcion_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recepcion_id INTEGER NOT NULL,
      compra_item_id INTEGER NOT NULL,
      producto_id INTEGER NOT NULL,
      cantidad_recibida REAL NOT NULL,
      unidad_snapshot TEXT,
      modo_stock TEXT NOT NULL DEFAULT 'generado',
      movimiento_stock_id INTEGER,
      movimiento_stock_vinculado_id INTEGER,
      movimiento_stock_reversa_id INTEGER,
      precio_proveedor_anterior_snapshot REAL,
      fecha_precio_proveedor_anterior_snapshot TEXT,
      costo_referencial_actualizado INTEGER NOT NULL DEFAULT 0,
      created_at TEXT,
      FOREIGN KEY (recepcion_id) REFERENCES compra_recepciones(id),
      FOREIGN KEY (compra_item_id) REFERENCES compra_items(id),
      FOREIGN KEY (producto_id) REFERENCES productos(id),
      FOREIGN KEY (movimiento_stock_id) REFERENCES movimientos_stock(id),
      FOREIGN KEY (movimiento_stock_vinculado_id) REFERENCES movimientos_stock(id),
      FOREIGN KEY (movimiento_stock_reversa_id) REFERENCES movimientos_stock(id)
    )
  `);
  await runQuery(db, "CREATE INDEX idx_compra_recepcion_items_recepcion ON compra_recepcion_items(recepcion_id)");
  await runQuery(db, "CREATE INDEX idx_compra_recepcion_items_item ON compra_recepcion_items(compra_item_id)");

  await runQuery(db, `
    CREATE TABLE producto_revisiones_pendientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo_revision TEXT NOT NULL DEFAULT 'costo_proveedor',
      estado TEXT NOT NULL DEFAULT 'pendiente',
      producto_id INTEGER NOT NULL,
      proveedor_id INTEGER NOT NULL,
      compra_id INTEGER NOT NULL,
      compra_item_id INTEGER NOT NULL,
      comprobante_id INTEGER,
      valor_actual REAL NOT NULL,
      valor_propuesto REAL NOT NULL,
      motivo TEXT,
      creado_at TEXT NOT NULL,
      creado_por TEXT,
      revisado_at TEXT,
      revisado_por TEXT,
      decision TEXT,
      UNIQUE (tipo_revision, compra_item_id),
      FOREIGN KEY (producto_id) REFERENCES productos(id),
      FOREIGN KEY (proveedor_id) REFERENCES proveedores(id),
      FOREIGN KEY (compra_id) REFERENCES compras(id),
      FOREIGN KEY (compra_item_id) REFERENCES compra_items(id),
      FOREIGN KEY (comprobante_id) REFERENCES compra_comprobantes(id)
    )
  `);
  await runQuery(db, "CREATE INDEX idx_producto_revisiones_pendientes_estado ON producto_revisiones_pendientes(estado)");
  await runQuery(db, "CREATE INDEX idx_producto_revisiones_pendientes_producto ON producto_revisiones_pendientes(producto_id)");

  await runQuery(db, `
    CREATE TABLE configuracion_global (
      clave TEXT PRIMARY KEY,
      valor TEXT NOT NULL,
      seccion TEXT NOT NULL,
      actualizado_en TEXT NOT NULL
    )
  `);

  await runQuery(db, `
    CREATE TABLE caja_aperturas (
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
      saldo_inicial_mp REAL NOT NULL DEFAULT 0,
      conteo_detalle TEXT,
      resumen_snapshot TEXT,
      ventas_snapshot TEXT,
      pagos_snapshot TEXT
    )
  `);

  await runQuery(db, `
    CREATE TABLE caja_movimientos (
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
  await runQuery(db, "CREATE INDEX idx_caja_movimientos_caja ON caja_movimientos(caja_id)");

  await runQuery(db, `
    CREATE TABLE caja_arqueos (
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
      resumen_snapshot TEXT,
      registrado_cierre INTEGER NOT NULL DEFAULT 1,
      modelo_arqueo_version INTEGER,
      cambio_retenido REAL,
      monto_extraido REAL,
      cuenta_origen_id INTEGER,
      cuenta_reserva_id INTEGER,
      idempotency_key TEXT
    )
  `);
  await runQuery(db, `
    CREATE UNIQUE INDEX idx_caja_arqueos_modelo1_idempotency
    ON caja_arqueos(caja_id, idempotency_key)
    WHERE modelo_arqueo_version = 1 AND idempotency_key IS NOT NULL
  `);

  await runQuery(db, `
    CREATE TABLE caja_traslados_internos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caja_id INTEGER NOT NULL,
      arqueo_id INTEGER,
      cuenta_origen_id INTEGER NOT NULL,
      cuenta_destino_id INTEGER NOT NULL,
      monto REAL NOT NULL,
      tipo TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'activo',
      fecha TEXT NOT NULL,
      hora TEXT NOT NULL,
      usuario TEXT NOT NULL DEFAULT 'admin',
      observaciones TEXT,
      created_at TEXT,
      anulada_at TEXT,
      anulada_por TEXT,
      motivo_anulacion TEXT,
      FOREIGN KEY (caja_id) REFERENCES caja_aperturas(id),
      FOREIGN KEY (arqueo_id) REFERENCES caja_arqueos(id),
      FOREIGN KEY (cuenta_origen_id) REFERENCES cuentas_destino(id),
      FOREIGN KEY (cuenta_destino_id) REFERENCES cuentas_destino(id)
    )
  `);
  await runQuery(db, "CREATE INDEX idx_caja_traslados_caja ON caja_traslados_internos(caja_id)");
  await runQuery(db, "CREATE INDEX idx_caja_traslados_arqueo ON caja_traslados_internos(arqueo_id)");
  await runQuery(db, "CREATE INDEX idx_caja_traslados_origen ON caja_traslados_internos(cuenta_origen_id)");
  await runQuery(db, "CREATE INDEX idx_caja_traslados_destino ON caja_traslados_internos(cuenta_destino_id)");
  await runQuery(db, `
    CREATE UNIQUE INDEX idx_caja_traslados_arqueo_extraccion_activa
    ON caja_traslados_internos(arqueo_id, tipo)
    WHERE arqueo_id IS NOT NULL AND tipo = 'arqueo_extraccion' AND estado = 'activo'
  `);

  await runQuery(db, `
    CREATE TABLE caja_arqueo_denominaciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      denominacion INTEGER NOT NULL,
      modo TEXT NOT NULL,
      tamano_grupo INTEGER,
      activo INTEGER NOT NULL DEFAULT 1,
      orden INTEGER NOT NULL DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    )
  `);
  await runQuery(db, "CREATE INDEX idx_caja_arqueo_denominaciones_orden ON caja_arqueo_denominaciones(orden)");
  await runQuery(db, `
    CREATE UNIQUE INDEX idx_caja_arqueo_denominaciones_activa
    ON caja_arqueo_denominaciones(denominacion)
    WHERE activo = 1
  `);

  await runQuery(db, `
    CREATE TABLE conciliaciones_cuentas_cobro (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caja_id INTEGER NOT NULL,
      cuenta_cobro_id INTEGER,
      monto_sistema REAL NOT NULL DEFAULT 0,
      monto_real REAL NOT NULL DEFAULT 0,
      diferencia REAL NOT NULL DEFAULT 0,
      estado TEXT NOT NULL,
      observaciones TEXT,
      fecha TEXT NOT NULL,
      hora TEXT NOT NULL,
      usuario TEXT NOT NULL DEFAULT 'admin',
      UNIQUE(caja_id, cuenta_cobro_id)
    )
  `);
  await runQuery(db, `
    CREATE UNIQUE INDEX idx_conciliaciones_cuentas_sin_cuenta
    ON conciliaciones_cuentas_cobro(caja_id)
    WHERE cuenta_cobro_id IS NULL
  `);

  await runQuery(db, `
    CREATE TABLE conciliaciones_cuentas_destino (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caja_id INTEGER NOT NULL,
      cuenta_destino_id INTEGER,
      monto_sistema REAL NOT NULL DEFAULT 0,
      monto_real REAL NOT NULL DEFAULT 0,
      diferencia REAL NOT NULL DEFAULT 0,
      estado TEXT NOT NULL,
      observaciones TEXT,
      fecha TEXT NOT NULL,
      hora TEXT NOT NULL,
      usuario TEXT NOT NULL DEFAULT 'admin',
      saldo_inicial REAL NOT NULL DEFAULT 0,
      decision_cierre TEXT,
      monto_retiro REAL NOT NULL DEFAULT 0,
      saldo_arrastrado REAL NOT NULL DEFAULT 0,
      confirmado_usuario INTEGER NOT NULL DEFAULT 0,
      UNIQUE(caja_id, cuenta_destino_id)
    )
  `);
  await runQuery(db, `
    CREATE UNIQUE INDEX idx_conciliaciones_destino_sin_cuenta
    ON conciliaciones_cuentas_destino(caja_id)
    WHERE cuenta_destino_id IS NULL
  `);

  await runQuery(db, `
    CREATE TABLE tipos_pago (
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

  await runQuery(db, `
    CREATE TABLE cuentas_destino (
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

  await runQuery(db, `
    CREATE TABLE cuentas_cobro (
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

  await runQuery(db, `
    CREATE TABLE venta_cobros (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      venta_id        INTEGER NOT NULL,
      tipo_cobro      TEXT NOT NULL,
      cuenta_cobro_id INTEGER,
      monto           REAL NOT NULL DEFAULT 0,
      estado          TEXT NOT NULL DEFAULT 'confirmado',
      created_at      TEXT,
      cuenta_cobro_nombre_snapshot   TEXT,
      cuenta_cobro_tipo_pago_snapshot TEXT,
      cuenta_destino_id_snapshot     INTEGER,
      cuenta_destino_nombre_snapshot TEXT,
      FOREIGN KEY (venta_id) REFERENCES ventas(id)
    )
  `);

  await runQuery(db, `
    CREATE TABLE pagos_cc_cobros (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id        TEXT NOT NULL,
      tipo_cobro      TEXT NOT NULL,
      cuenta_cobro_id INTEGER,
      monto           REAL NOT NULL,
      caja_id         INTEGER,
      fecha           TEXT,
      hora            TEXT,
      created_at      TEXT DEFAULT CURRENT_TIMESTAMP,
      cuenta_cobro_nombre_snapshot   TEXT,
      cuenta_cobro_tipo_pago_snapshot TEXT,
      cuenta_destino_id_snapshot     INTEGER,
      cuenta_destino_nombre_snapshot TEXT,
      observacion TEXT,
      numero_comprobante TEXT,
      usuario_id INTEGER,
      usuario_nombre TEXT,
      reversa_de_group_id TEXT,
      tipo_movimiento TEXT NOT NULL DEFAULT 'cobro'
    )
  `);

  await runQuery(db, `
    CREATE TABLE mercado_pago_intentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venta_id INTEGER,
      cuenta_cobro_id INTEGER NOT NULL,
      cuenta_destino_id INTEGER,
      mp_order_id TEXT,
      mp_payment_id TEXT,
      external_reference TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      terminal_id TEXT NOT NULL,
      store_id TEXT,
      pos_id TEXT,
      monto_total REAL NOT NULL,
      estado TEXT NOT NULL,
      status_detail TEXT,
      request_json TEXT,
      response_json TEXT,
      webhook_json TEXT,
      error_message TEXT,
      created_at TEXT,
      updated_at TEXT,
      aprobado_at TEXT,
      cancelado_at TEXT
    )
  `);
  await runQuery(db, "CREATE UNIQUE INDEX idx_mp_intentos_external_reference ON mercado_pago_intentos(external_reference)");
  await runQuery(db, "CREATE UNIQUE INDEX idx_mp_intentos_idempotency_key ON mercado_pago_intentos(idempotency_key)");
  await runQuery(db, "CREATE INDEX idx_mp_intentos_estado ON mercado_pago_intentos(estado)");
  await runQuery(db, "CREATE INDEX idx_mp_intentos_venta ON mercado_pago_intentos(venta_id)");

  await runQuery(db, `
    CREATE TABLE stock_ajustes_pendientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      producto_id INTEGER NOT NULL,
      tipo_movimiento TEXT NOT NULL,
      cantidad REAL NOT NULL,
      motivo TEXT,
      observaciones TEXT,
      proveedor_id INTEGER,
      stock_actual_snapshot REAL NOT NULL DEFAULT 0,
      estado TEXT NOT NULL DEFAULT 'pendiente',
      solicitado_por TEXT NOT NULL,
      solicitado_rol TEXT,
      fecha TEXT NOT NULL,
      hora TEXT NOT NULL,
      created_at TEXT,
      revisado_por TEXT,
      revisado_at TEXT,
      cantidad_aprobada REAL,
      tipo_movimiento_aprobado TEXT,
      observaciones_admin TEXT,
      movimiento_stock_id INTEGER,
      caja_id INTEGER,
      venta_id INTEGER,
      tipo_resolucion TEXT,
      fecha_resolucion TEXT,
      hora_resolucion TEXT,
      resuelto_por TEXT,
      cantidad_resuelta REAL DEFAULT 0,
      cantidad_pendiente_resolucion REAL DEFAULT 0,
      resolucion_parcial INTEGER DEFAULT 0,
      cuenta_local_integracion TEXT,
      cuenta_local_observacion TEXT,
      cuenta_local_responsable TEXT,
      cuenta_local_nombre_snapshot TEXT,
      cuenta_local_costo_estimado REAL DEFAULT 0,
      origen TEXT,
      detalle_venta_id INTEGER,
      producto_vendido_id INTEGER,
      producto_vendido_nombre_snapshot TEXT,
      componente_id INTEGER,
      cantidad_teorica REAL
    )
  `);
  await runQuery(db, "CREATE INDEX idx_stock_ajustes_pendientes_estado ON stock_ajustes_pendientes(estado)");
  await runQuery(db, "CREATE INDEX idx_stock_ajustes_pendientes_producto ON stock_ajustes_pendientes(producto_id)");
  await runQuery(db, "CREATE INDEX idx_stock_ajustes_pendientes_caja ON stock_ajustes_pendientes(caja_id)");
  await runQuery(db, "CREATE INDEX idx_stock_ajustes_pendientes_venta_origen ON stock_ajustes_pendientes(venta_id, origen)");

  await runQuery(db, `
    CREATE TABLE tienda_pedidos (
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
      venta_id INTEGER,
      motivo_rechazo TEXT
    )
  `);

  await runQuery(db, `
    CREATE TABLE tienda_pedido_items (
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

  await runQuery(db, `
    CREATE TABLE tienda_pedido_item_modificadores (
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

  await runQuery(db, `
    CREATE TABLE producto_ingredientes_visibles (
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
  await runQuery(db, "CREATE INDEX idx_piv_producto ON producto_ingredientes_visibles(producto_id)");

  await runQuery(db, `
    CREATE TABLE tienda_pedido_item_ingredientes (
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

  await runQuery(db, "CREATE INDEX idx_usuarios_usuario ON usuarios(usuario)");
  await runQuery(db, "CREATE INDEX idx_productos_codigo ON productos(codigo)");
  await runQuery(db, "CREATE INDEX idx_productos_activo ON productos(activo)");
  await runQuery(db, "CREATE UNIQUE INDEX idx_productos_codigo_unique ON productos(codigo) WHERE codigo IS NOT NULL AND codigo != '' AND eliminado = 0");
  await runQuery(db, "CREATE INDEX idx_venta_cobros_venta ON venta_cobros(venta_id)");
  await runQuery(db, "CREATE INDEX idx_venta_cobros_cuenta ON venta_cobros(cuenta_cobro_id)");

  // ---- Required defaults (REQUIRED_RUNTIME_DEFAULT del baseline) ----
  for (const regla of CAJA_DENOMINACIONES_ARQUEO_DEFAULTS) {
    await runQuery(
      db,
      `INSERT INTO caja_arqueo_denominaciones
       (denominacion, modo, tamano_grupo, activo, orden, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, datetime('now'), datetime('now'))`,
      [regla.denominacion, regla.modo, regla.tamano_grupo, regla.orden]
    );
  }

  for (const tipo of TIPOS_PAGO_DEFAULTS) {
    await runQuery(
      db,
      `INSERT INTO tipos_pago
       (codigo, nombre, activo, impacta_caja, impacta_digital, permite_mixto, requiere_caja_abierta, orden,
        usa_recargo, porcentaje_recargo, permite_cuotas, cuotas_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tipo.codigo, tipo.nombre, tipo.activo, tipo.impacta_caja, tipo.impacta_digital,
        tipo.permite_mixto, tipo.requiere_caja_abierta, tipo.orden,
        tipo.usa_recargo, tipo.porcentaje_recargo, tipo.permite_cuotas, JSON.stringify(tipo.cuotas_json)
      ]
    );
  }

  for (const cuenta of CUENTAS_DESTINO_DEFAULTS) {
    await runQuery(
      db,
      `INSERT INTO cuentas_destino
       (nombre, tipo_destino, alias, cbu_cvu, activo, orden, created_at, updated_at)
       VALUES (?, ?, '', '', 1, ?, datetime('now'), datetime('now'))`,
      [cuenta.nombre, cuenta.tipo_destino, cuenta.orden]
    );
  }
}

module.exports = {
  crearBaseline001EnConexion
};
