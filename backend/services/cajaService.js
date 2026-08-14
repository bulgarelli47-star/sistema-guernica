const { allQuery, getQuery, runQuery } = require("../db");

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

async function ensureColumn(tableName, columnName, definition) {
  const columns = await allQuery(`PRAGMA table_info(${tableName})`);
  const exists = columns.some((column) => column.name === columnName);

  if (!exists) {
    await runQuery(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

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
  await ensureColumn("caja_arqueos", "modelo_arqueo_version", "INTEGER");
  await ensureColumn("caja_arqueos", "cambio_retenido", "REAL");
  await ensureColumn("caja_arqueos", "monto_extraido", "REAL");
  await ensureColumn("caja_arqueos", "cuenta_origen_id", "INTEGER");
  await ensureColumn("caja_arqueos", "cuenta_reserva_id", "INTEGER");
  await ensureColumn("caja_arqueos", "idempotency_key", "TEXT");
  const idempotencyIndex = await allQuery("PRAGMA index_info(idx_caja_arqueos_modelo1_idempotency)");
  if (idempotencyIndex.length && idempotencyIndex.map((column) => column.name).join(",") !== "caja_id,idempotency_key") {
    await runQuery("DROP INDEX IF EXISTS idx_caja_arqueos_modelo1_idempotency");
  }
  await runQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_caja_arqueos_modelo1_idempotency
    ON caja_arqueos(caja_id, idempotency_key)
    WHERE modelo_arqueo_version = 1 AND idempotency_key IS NOT NULL
  `);
}

async function ensureCajaTrasladosInternosTable() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS caja_traslados_internos (
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
  await runQuery("CREATE INDEX IF NOT EXISTS idx_caja_traslados_caja ON caja_traslados_internos(caja_id)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_caja_traslados_arqueo ON caja_traslados_internos(arqueo_id)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_caja_traslados_origen ON caja_traslados_internos(cuenta_origen_id)");
  await runQuery("CREATE INDEX IF NOT EXISTS idx_caja_traslados_destino ON caja_traslados_internos(cuenta_destino_id)");
  await runQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_caja_traslados_arqueo_extraccion_activa
    ON caja_traslados_internos(arqueo_id, tipo)
    WHERE arqueo_id IS NOT NULL AND tipo = 'arqueo_extraccion' AND estado = 'activo'
  `);
}

async function ensureCajaDenominacionesArqueoTable() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS caja_arqueo_denominaciones (
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
  await runQuery("CREATE INDEX IF NOT EXISTS idx_caja_arqueo_denominaciones_orden ON caja_arqueo_denominaciones(orden)");
  await runQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_caja_arqueo_denominaciones_activa
    ON caja_arqueo_denominaciones(denominacion)
    WHERE activo = 1
  `);

  for (const regla of CAJA_DENOMINACIONES_ARQUEO_DEFAULTS) {
    const existente = await getQuery(
      "SELECT id FROM caja_arqueo_denominaciones WHERE denominacion = ?",
      [regla.denominacion]
    );
    if (!existente) {
      await runQuery(
        `INSERT INTO caja_arqueo_denominaciones
         (denominacion, modo, tamano_grupo, activo, orden, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, datetime('now'), datetime('now'))`,
        [regla.denominacion, regla.modo, regla.tamano_grupo, regla.orden]
      );
    }
  }
}

async function getReglasDenominacionesArqueoActivas() {
  await ensureCajaDenominacionesArqueoTable();
  return allQuery(
    `SELECT denominacion, modo, tamano_grupo, activo, orden
     FROM caja_arqueo_denominaciones
     WHERE activo = 1
     ORDER BY orden ASC, denominacion ASC`
  );
}

async function ensureConciliacionesCuentasCobroTable() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS conciliaciones_cuentas_cobro (
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
  await runQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_conciliaciones_cuentas_sin_cuenta
    ON conciliaciones_cuentas_cobro(caja_id)
    WHERE cuenta_cobro_id IS NULL
  `);
}

async function ensureConciliacionesCuentasDestinoTable() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS conciliaciones_cuentas_destino (
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
      UNIQUE(caja_id, cuenta_destino_id)
    )
  `);
  await runQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_conciliaciones_destino_sin_cuenta
    ON conciliaciones_cuentas_destino(caja_id)
    WHERE cuenta_destino_id IS NULL
  `);
  await ensureColumn("conciliaciones_cuentas_destino", "saldo_inicial", "REAL NOT NULL DEFAULT 0");
  await ensureColumn("conciliaciones_cuentas_destino", "decision_cierre", "TEXT");
  await ensureColumn("conciliaciones_cuentas_destino", "monto_retiro", "REAL NOT NULL DEFAULT 0");
  await ensureColumn("conciliaciones_cuentas_destino", "saldo_arrastrado", "REAL NOT NULL DEFAULT 0");
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

function normalizarReglaDenominacionArqueo(regla = {}) {
  return {
    denominacion: Number(regla.denominacion),
    modo: String(regla.modo || "").trim().toLowerCase(),
    tamano_grupo: regla.tamano_grupo === undefined || regla.tamano_grupo === null || regla.tamano_grupo === ""
      ? null
      : Number(regla.tamano_grupo),
    orden: Number(regla.orden) || 0,
    activo: regla.activo === undefined ? 1 : Number(regla.activo)
  };
}

function validarReglaDenominacionArqueo(regla) {
  if (!Number.isInteger(regla.denominacion) || regla.denominacion <= 0) {
    throw new Error("Denominacion invalida");
  }
  if (!["conservar_todo", "extraer_todo", "agrupar"].includes(regla.modo)) {
    throw new Error(`Modo invalido para denominacion ${regla.denominacion}`);
  }
  if ((regla.modo === "conservar_todo" || regla.modo === "extraer_todo") && regla.tamano_grupo !== null) {
    throw new Error(`La denominacion ${regla.denominacion} no debe tener tamano_grupo`);
  }
  if (regla.modo === "agrupar" && (!Number.isInteger(regla.tamano_grupo) || regla.tamano_grupo <= 0)) {
    throw new Error(`La denominacion ${regla.denominacion} requiere tamano_grupo valido`);
  }
}

function calcularDistribucionArqueo(conteo = {}, reglas = []) {
  const reglasActivas = [];
  const reglasPorDenominacion = new Map();

  reglas.forEach((item) => {
    const regla = normalizarReglaDenominacionArqueo(item);
    if (regla.activo !== 1) return;
    validarReglaDenominacionArqueo(regla);
    if (reglasPorDenominacion.has(regla.denominacion)) {
      throw new Error(`Denominacion activa duplicada: ${regla.denominacion}`);
    }
    reglasPorDenominacion.set(regla.denominacion, regla);
    reglasActivas.push(regla);
  });

  const detalle = [];
  let efectivoContado = 0;
  let cambioRetenido = 0;
  let montoExtraido = 0;

  Object.entries(conteo || {}).forEach(([denominacionKey, cantidadRaw]) => {
    const denominacion = Number(denominacionKey);
    const cantidad = Number(cantidadRaw);
    if (!Number.isInteger(denominacion) || denominacion <= 0) {
      throw new Error(`Denominacion invalida: ${denominacionKey}`);
    }
    if (!Number.isInteger(cantidad) || cantidad < 0) {
      throw new Error(`Cantidad invalida para denominacion ${denominacion}`);
    }
    if (!reglasPorDenominacion.has(denominacion)) {
      throw new Error(`Denominacion sin configuracion activa: ${denominacion}`);
    }
  });

  reglasActivas
    .sort((a, b) => a.orden - b.orden || a.denominacion - b.denominacion)
    .forEach((regla) => {
      const cantidad = Number(conteo[String(regla.denominacion)] ?? conteo[regla.denominacion] ?? 0);
      if (!Number.isInteger(cantidad) || cantidad < 0) {
        throw new Error(`Cantidad invalida para denominacion ${regla.denominacion}`);
      }

      const montoTotal = regla.denominacion * cantidad;
      let retenido = 0;
      let extraido = 0;
      let gruposExtraidos = 0;

      if (regla.modo === "conservar_todo") {
        retenido = montoTotal;
      } else if (regla.modo === "extraer_todo") {
        extraido = montoTotal;
      } else {
        gruposExtraidos = Math.floor(cantidad / regla.tamano_grupo);
        const cantidadExtraida = gruposExtraidos * regla.tamano_grupo;
        extraido = cantidadExtraida * regla.denominacion;
        retenido = (cantidad - cantidadExtraida) * regla.denominacion;
      }

      efectivoContado += montoTotal;
      cambioRetenido += retenido;
      montoExtraido += extraido;
      detalle.push({
        denominacion: regla.denominacion,
        cantidad,
        modo: regla.modo,
        tamano_grupo: regla.tamano_grupo,
        grupos_extraidos: gruposExtraidos,
        monto_total: Number(montoTotal.toFixed(2)),
        cambio_retenido: Number(retenido.toFixed(2)),
        monto_extraido: Number(extraido.toFixed(2))
      });
    });

  return {
    efectivo_contado: Number(efectivoContado.toFixed(2)),
    cambio_retenido: Number(cambioRetenido.toFixed(2)),
    monto_extraido: Number(montoExtraido.toFixed(2)),
    detalle
  };
}

function normalizarTrasladoInterno(payload = {}) {
  return {
    caja_id: Number(payload.caja_id) || null,
    arqueo_id: payload.arqueo_id === undefined || payload.arqueo_id === null || payload.arqueo_id === ""
      ? null
      : Number(payload.arqueo_id) || null,
    cuenta_origen_id: Number(payload.cuenta_origen_id) || null,
    cuenta_destino_id: Number(payload.cuenta_destino_id) || null,
    monto: Number(Number(payload.monto || 0).toFixed(2)),
    tipo: String(payload.tipo || "").trim().toLowerCase(),
    estado: String(payload.estado || "activo").trim().toLowerCase(),
    fecha: String(payload.fecha || "").trim(),
    hora: String(payload.hora || "").trim(),
    usuario: String(payload.usuario || "admin").trim() || "admin",
    observaciones: String(payload.observaciones || "").trim()
  };
}

function validarTrasladoInterno(data = {}, contexto = {}) {
  const traslado = normalizarTrasladoInterno(data);
  const origen = contexto.origen || null;
  const destino = contexto.destino || null;
  const arqueo = contexto.arqueo || null;

  if (!traslado.caja_id) return { ok: false, message: "Caja invalida" };
  if (!traslado.cuenta_origen_id) return { ok: false, message: "Cuenta origen invalida" };
  if (!traslado.cuenta_destino_id) return { ok: false, message: "Cuenta destino invalida" };
  if (traslado.cuenta_origen_id === traslado.cuenta_destino_id) {
    return { ok: false, message: "La cuenta origen y destino deben ser distintas" };
  }
  if (!Number.isFinite(traslado.monto) || traslado.monto <= 0) {
    return { ok: false, message: "El monto del traslado debe ser mayor a cero" };
  }
  if (!traslado.tipo) return { ok: false, message: "Tipo de traslado obligatorio" };
  if (!["activo", "anulado"].includes(traslado.estado)) {
    return { ok: false, message: "Estado de traslado invalido" };
  }
  if (!origen || Number(origen.id) !== traslado.cuenta_origen_id || Number(origen.activo) !== 1) {
    return { ok: false, message: "Cuenta origen inexistente o inactiva" };
  }
  if (!destino || Number(destino.id) !== traslado.cuenta_destino_id || Number(destino.activo) !== 1) {
    return { ok: false, message: "Cuenta destino inexistente o inactiva" };
  }
  if (String(origen.tipo_destino || "").toLowerCase() !== "efectivo" ||
      String(destino.tipo_destino || "").toLowerCase() !== "efectivo") {
    return { ok: false, message: "Los traslados internos de efectivo requieren cuentas destino tipo efectivo" };
  }
  if (traslado.arqueo_id !== null) {
    if (!arqueo || Number(arqueo.id) !== traslado.arqueo_id) {
      return { ok: false, message: "Arqueo inexistente" };
    }
    if (Number(arqueo.caja_id) !== traslado.caja_id) {
      return { ok: false, message: "El traslado no pertenece a la misma caja del arqueo" };
    }
  }

  return { ok: true, traslado };
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

  // CC 3.0A: agrupa por group_id y obtiene efectivo/debito reales de pagos_cc_cobros.
  // group_id IS NULL → cobros legacy sin CC 3.0A, se sirven como filas individuales.
  const pagosCuentaCorriente = await allQuery(
    `SELECT
       MIN(pcc.id)            AS id,
       pcc.fecha,
       pcc.hora,
       pcc.caja_id,
       pcc.cliente_id,
       SUM(pcc.monto_pagado)  AS total,
       COALESCE(
         (SELECT SUM(pccx.monto) FROM pagos_cc_cobros pccx
          WHERE pccx.group_id = pcc.group_id AND pccx.tipo_cobro = 'efectivo'), 0
       ) AS monto_efectivo,
       COALESCE(
         (SELECT SUM(pccx.monto) FROM pagos_cc_cobros pccx
          WHERE pccx.group_id = pcc.group_id AND pccx.tipo_cobro != 'efectivo'), 0
       ) AS monto_debito,
       COALESCE(
         (SELECT CASE WHEN COUNT(DISTINCT pccx.tipo_cobro) > 1 THEN 'mixto'
                      ELSE MIN(pccx.tipo_cobro) END
          FROM pagos_cc_cobros pccx WHERE pccx.group_id = pcc.group_id),
         MIN(pcc.tipo_cobro)
       ) AS tipo_cobro,
       'cobrada'              AS estado,
       c.nombre               AS cliente_nombre,
       'cuenta_corriente'     AS tipo
     FROM pagos_cuenta_corriente pcc
     LEFT JOIN clientes c ON c.id = pcc.cliente_id
     WHERE pcc.caja_id = ? AND pcc.group_id IS NOT NULL
     GROUP BY pcc.group_id, pcc.fecha, pcc.hora, pcc.caja_id, pcc.cliente_id, c.nombre

     UNION ALL

     SELECT
       pcc.id,
       pcc.fecha,
       pcc.hora,
       pcc.caja_id,
       pcc.cliente_id,
       pcc.monto_pagado AS total,
       pcc.monto_efectivo,
       pcc.monto_debito,
       pcc.tipo_cobro,
       'cobrada'          AS estado,
       c.nombre           AS cliente_nombre,
       'cuenta_corriente' AS tipo
     FROM pagos_cuenta_corriente pcc
     LEFT JOIN clientes c ON c.id = pcc.cliente_id
     WHERE pcc.caja_id = ? AND pcc.group_id IS NULL`,
    [cajaId, cajaId]
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

function mapearProductosDetalle(rows) {
  return rows.map((producto) => {
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
  });
}

const TIPOS_SIN_DETALLE = new Set([
  "cobro_cuenta_corriente",
  "pago_proveedor",
  "caja_movimiento_ingreso",
  "caja_movimiento_egreso"
]);

async function buildCajaSnapshot(cajaId) {
  const operaciones = await getOperacionesCaja(cajaId);

  const ventaIds = operaciones
    .filter((op) => !TIPOS_SIN_DETALLE.has(op.tipo_operacion))
    .map((op) => op.id);

  if (!ventaIds.length) {
    return operaciones.map((op) => ({ ...op, productos: [] }));
  }

  const detalles = await allQuery(
    `SELECT dv.venta_id, dv.producto_id, dv.nombre_producto, dv.cantidad, dv.precio_unitario, dv.subtotal,
            p.costo_final, p.precio_compra
     FROM detalle_ventas dv
     LEFT JOIN productos p ON p.id = dv.producto_id
     WHERE dv.venta_id IN (${ventaIds.map(() => "?").join(",")})
     ORDER BY dv.venta_id, dv.id ASC`,
    ventaIds
  );

  const detalleMap = new Map();
  for (const d of detalles) {
    if (!detalleMap.has(d.venta_id)) detalleMap.set(d.venta_id, []);
    detalleMap.get(d.venta_id).push(d);
  }

  return operaciones.map((operacion) => ({
    ...operacion,
    productos: TIPOS_SIN_DETALLE.has(operacion.tipo_operacion)
      ? []
      : mapearProductosDetalle(detalleMap.get(operacion.id) || [])
  }));
}

function mapResumenCuenta(row) {
  const ingresos = Number(row.ingresos || 0);
  const egresos = Number(row.egresos || 0);
  return {
    cuenta_cobro_id: row.cuenta_cobro_id == null ? null : Number(row.cuenta_cobro_id),
    cuenta_nombre: row.cuenta_nombre || "Sin cuenta",
    ingresos: Number(ingresos.toFixed(2)),
    egresos: Number(egresos.toFixed(2)),
    balance: Number((ingresos - egresos).toFixed(2)),
    ventas: Number(row.ventas || 0),
    pagos: Number(row.pagos || 0)
  };
}

async function getResumenPorCuentaCobro({ cajaId } = {}) {
  if (!cajaId) {
    return [];
  }

  // Cobros V2: usa venta_cobros (con cuenta_cobro_id real por cobro) cuando existan;
  // fallback a v.cuenta_cobro_id / v.total para ventas sin venta_cobros.
  const rows = await allQuery(
    `WITH
       vb AS (
         SELECT id, total, cuenta_cobro_id
         FROM ventas
         WHERE caja_id = ? AND estado = 'cobrada'
       ),
       ingresos_v2 AS (
         -- ventas CON venta_cobros: usar cuenta y monto por cobro real
         SELECT vc.cuenta_cobro_id, vc.monto, vc.venta_id, vc.cuenta_cobro_nombre_snapshot
           FROM venta_cobros vc JOIN vb ON vb.id = vc.venta_id
           WHERE vc.estado = 'confirmado'
         UNION ALL
         -- ventas SIN venta_cobros: fallback legacy
         SELECT vb.cuenta_cobro_id, vb.total, vb.id, NULL
           FROM vb WHERE NOT EXISTS (SELECT 1 FROM venta_cobros vc WHERE vc.venta_id = vb.id)
       ),
       movimientos AS (
         SELECT
           i.cuenta_cobro_id AS cuenta_cobro_id,
           COALESCE(i.cuenta_cobro_nombre_snapshot, cc.nombre, 'Sin cuenta') AS cuenta_nombre,
           SUM(COALESCE(i.monto, 0)) AS ingresos,
           0 AS egresos,
           COUNT(DISTINCT i.venta_id) AS ventas,
           0 AS pagos
         FROM ingresos_v2 i
         LEFT JOIN cuentas_cobro cc ON cc.id = i.cuenta_cobro_id
         GROUP BY i.cuenta_cobro_id, COALESCE(i.cuenta_cobro_nombre_snapshot, cc.nombre, 'Sin cuenta')

         UNION ALL

         SELECT
           p.cuenta_cobro_id AS cuenta_cobro_id,
           COALESCE(cc.nombre, 'Sin cuenta') AS cuenta_nombre,
           0 AS ingresos,
           SUM(COALESCE(p.monto_total, 0)) AS egresos,
           0 AS ventas,
           COUNT(*) AS pagos
         FROM pagos p
         LEFT JOIN cuentas_cobro cc ON cc.id = p.cuenta_cobro_id
         WHERE p.caja_id = ?
           AND p.estado = 'registrado'
         GROUP BY p.cuenta_cobro_id, COALESCE(cc.nombre, 'Sin cuenta')

         UNION ALL

         -- cobros de deuda CC 3.0A por canal/terminal
         SELECT
           pcc.cuenta_cobro_id AS cuenta_cobro_id,
           COALESCE(pcc.cuenta_cobro_nombre_snapshot, cc.nombre, 'Sin cuenta') AS cuenta_nombre,
           SUM(COALESCE(pcc.monto, 0)) AS ingresos,
           0 AS egresos,
           0 AS ventas,
           0 AS pagos
         FROM pagos_cc_cobros pcc
         LEFT JOIN cuentas_cobro cc ON cc.id = pcc.cuenta_cobro_id
         WHERE pcc.caja_id = ?
         GROUP BY pcc.cuenta_cobro_id, COALESCE(pcc.cuenta_cobro_nombre_snapshot, cc.nombre, 'Sin cuenta')
       )
     SELECT
       cuenta_cobro_id,
       cuenta_nombre,
       SUM(ingresos) AS ingresos,
       SUM(egresos) AS egresos,
       SUM(ventas) AS ventas,
       SUM(pagos) AS pagos
     FROM movimientos
     GROUP BY cuenta_cobro_id, cuenta_nombre
     ORDER BY (SUM(ingresos) - SUM(egresos)) DESC, cuenta_nombre ASC`,
    [cajaId, cajaId, cajaId]
  );

  return rows.map(mapResumenCuenta);
}

function mapResumenCuentaDestino(row) {
  const ingresos = Number(row.ingresos || 0);
  const egresos = Number(row.egresos || 0);
  const sinCuentaDestino = Number(row.sin_cuenta_destino || 0) === 1;
  const canales = String(row.canales || "")
    .split("|")
    .map((canal) => canal.trim())
    .filter(Boolean);

  return {
    cuenta_destino_id: sinCuentaDestino || row.cuenta_destino_id == null ? null : Number(row.cuenta_destino_id),
    cuenta_destino_nombre: sinCuentaDestino ? "Sin cuenta destino" : (row.cuenta_destino_nombre || "Sin cuenta destino"),
    tipo_destino: sinCuentaDestino ? "sin_cuenta" : (row.tipo_destino || "otro"),
    ingresos: Number(ingresos.toFixed(2)),
    egresos: Number(egresos.toFixed(2)),
    balance: Number((ingresos - egresos).toFixed(2)),
    ventas: Number(row.ventas || 0),
    pagos: Number(row.pagos || 0),
    canales,
    sin_cuenta_destino: sinCuentaDestino
  };
}

async function getResumenPorCuentaDestino({ cajaId } = {}) {
  if (!cajaId) {
    return [];
  }

  const rows = await allQuery(
    `WITH movimientos AS (
       -- ventas V2: canal y monto real de venta_cobros
       SELECT
         COALESCE(vc.cuenta_destino_id_snapshot, cd.id) AS cuenta_destino_id,
         COALESCE(vc.cuenta_destino_nombre_snapshot, cd.nombre) AS cuenta_destino_nombre,
         cd.tipo_destino AS tipo_destino,
         CASE WHEN COALESCE(vc.cuenta_destino_id_snapshot, cd.id) IS NULL THEN 1 ELSE 0 END AS sin_cuenta_destino,
         COALESCE(vc.cuenta_cobro_nombre_snapshot, cc.nombre) AS canal_nombre,
         SUM(COALESCE(vc.monto, 0)) AS ingresos,
         0 AS egresos,
         COUNT(DISTINCT vc.venta_id) AS ventas,
         0 AS pagos
       FROM ventas v
       JOIN venta_cobros vc ON vc.venta_id = v.id AND vc.estado = 'confirmado'
       LEFT JOIN cuentas_cobro cc ON cc.id = vc.cuenta_cobro_id
       LEFT JOIN cuentas_destino cd ON cd.id = cc.cuenta_destino_id
       WHERE v.caja_id = ?
         AND v.estado = 'cobrada'
         AND COALESCE(v.estado, '') != 'anulado'
         AND COALESCE(v.es_cuenta_corriente, 0) = 0
       GROUP BY COALESCE(vc.cuenta_destino_id_snapshot, cd.id), COALESCE(vc.cuenta_destino_nombre_snapshot, cd.nombre), cd.tipo_destino, CASE WHEN COALESCE(vc.cuenta_destino_id_snapshot, cd.id) IS NULL THEN 1 ELSE 0 END, COALESCE(vc.cuenta_cobro_nombre_snapshot, cc.nombre)

       UNION ALL

       -- ventas legacy: sin venta_cobros, canal y total de ventas
       SELECT
         cd.id AS cuenta_destino_id,
         cd.nombre AS cuenta_destino_nombre,
         cd.tipo_destino AS tipo_destino,
         CASE WHEN cd.id IS NULL THEN 1 ELSE 0 END AS sin_cuenta_destino,
         cc.nombre AS canal_nombre,
         SUM(COALESCE(v.total, 0)) AS ingresos,
         0 AS egresos,
         COUNT(*) AS ventas,
         0 AS pagos
       FROM ventas v
       LEFT JOIN cuentas_cobro cc ON cc.id = v.cuenta_cobro_id
       LEFT JOIN cuentas_destino cd ON cd.id = cc.cuenta_destino_id
       WHERE v.caja_id = ?
         AND v.estado = 'cobrada'
         AND COALESCE(v.estado, '') != 'anulado'
         AND COALESCE(v.es_cuenta_corriente, 0) = 0
         AND NOT EXISTS (SELECT 1 FROM venta_cobros vc WHERE vc.venta_id = v.id)
       GROUP BY cd.id, cd.nombre, cd.tipo_destino, CASE WHEN cd.id IS NULL THEN 1 ELSE 0 END, cc.nombre

       UNION ALL

       SELECT
         cd.id AS cuenta_destino_id,
         cd.nombre AS cuenta_destino_nombre,
         cd.tipo_destino AS tipo_destino,
         CASE WHEN cd.id IS NULL THEN 1 ELSE 0 END AS sin_cuenta_destino,
         cc.nombre AS canal_nombre,
         0 AS ingresos,
         SUM(COALESCE(p.monto_total, 0)) AS egresos,
         0 AS ventas,
         COUNT(*) AS pagos
       FROM pagos p
       LEFT JOIN cuentas_cobro cc ON cc.id = p.cuenta_cobro_id
       LEFT JOIN cuentas_destino cd ON cd.id = cc.cuenta_destino_id
       WHERE p.caja_id = ?
         AND p.estado = 'registrado'
       GROUP BY cd.id, cd.nombre, cd.tipo_destino, CASE WHEN cd.id IS NULL THEN 1 ELSE 0 END, cc.nombre

       UNION ALL

       -- cobros de deuda CC 3.0A por canal/destino
       SELECT
         COALESCE(pcc.cuenta_destino_id_snapshot, cd.id) AS cuenta_destino_id,
         COALESCE(pcc.cuenta_destino_nombre_snapshot, cd.nombre) AS cuenta_destino_nombre,
         cd.tipo_destino AS tipo_destino,
         CASE WHEN COALESCE(pcc.cuenta_destino_id_snapshot, cd.id) IS NULL THEN 1 ELSE 0 END AS sin_cuenta_destino,
         COALESCE(pcc.cuenta_cobro_nombre_snapshot, cc.nombre) AS canal_nombre,
         SUM(COALESCE(pcc.monto, 0)) AS ingresos,
         0 AS egresos,
         0 AS ventas,
         0 AS pagos
       FROM pagos_cc_cobros pcc
       LEFT JOIN cuentas_cobro cc ON cc.id = pcc.cuenta_cobro_id
       LEFT JOIN cuentas_destino cd ON cd.id = cc.cuenta_destino_id
       WHERE pcc.caja_id = ?
       GROUP BY COALESCE(pcc.cuenta_destino_id_snapshot, cd.id), COALESCE(pcc.cuenta_destino_nombre_snapshot, cd.nombre), cd.tipo_destino, CASE WHEN COALESCE(pcc.cuenta_destino_id_snapshot, cd.id) IS NULL THEN 1 ELSE 0 END, COALESCE(pcc.cuenta_cobro_nombre_snapshot, cc.nombre)
     ),
     agrupado AS (
       SELECT
         cuenta_destino_id,
         cuenta_destino_nombre,
         tipo_destino,
         sin_cuenta_destino,
         SUM(ingresos) AS ingresos,
         SUM(egresos) AS egresos,
         SUM(ventas) AS ventas,
         SUM(pagos) AS pagos
       FROM movimientos
       GROUP BY cuenta_destino_id, cuenta_destino_nombre, tipo_destino, sin_cuenta_destino
     ),
     canales AS (
       SELECT
         cuenta_destino_id,
         sin_cuenta_destino,
         GROUP_CONCAT(canal_nombre, '|') AS canales
       FROM (
         SELECT DISTINCT cuenta_destino_id, sin_cuenta_destino, canal_nombre
         FROM movimientos
         WHERE canal_nombre IS NOT NULL AND canal_nombre != ''
       )
       GROUP BY cuenta_destino_id, sin_cuenta_destino
     )
     SELECT
       a.cuenta_destino_id,
       a.cuenta_destino_nombre,
       a.tipo_destino,
       a.sin_cuenta_destino,
       a.ingresos,
       a.egresos,
       a.ventas,
       a.pagos,
       COALESCE(c.canales, '') AS canales
     FROM agrupado a
     LEFT JOIN canales c
       ON (c.cuenta_destino_id = a.cuenta_destino_id OR (c.cuenta_destino_id IS NULL AND a.cuenta_destino_id IS NULL))
      AND c.sin_cuenta_destino = a.sin_cuenta_destino
     ORDER BY CASE WHEN a.sin_cuenta_destino = 1 THEN 1 ELSE 0 END ASC, (a.ingresos - a.egresos) DESC, a.cuenta_destino_nombre ASC`,
    [cajaId, cajaId, cajaId, cajaId]
  );

  const conMovimientos = rows.map(mapResumenCuentaDestino);

  // IDs de cuentas destino reales ya cubiertas por movimientos
  const idsConMovimientos = new Set(
    conMovimientos
      .filter((r) => !r.sin_cuenta_destino && r.cuenta_destino_id != null)
      .map((r) => r.cuenta_destino_id)
  );

  // Cuentas destino activas sin movimientos en este turno → aparecen al final con montos en cero
  const cuentasActivas = await allQuery(
    `SELECT id, nombre, tipo_destino FROM cuentas_destino WHERE activo = 1 ORDER BY orden ASC, nombre ASC`
  );

  const sinMovimientos = cuentasActivas
    .filter((cd) => !idsConMovimientos.has(Number(cd.id)))
    .map((cd) => ({
      cuenta_destino_id: Number(cd.id),
      cuenta_destino_nombre: cd.nombre || "Sin nombre",
      tipo_destino: cd.tipo_destino || "otro",
      ingresos: 0,
      egresos: 0,
      balance: 0,
      ventas: 0,
      pagos: 0,
      canales: [],
      sin_cuenta_destino: false
    }));

  return [...conMovimientos, ...sinMovimientos].sort((a, b) => {
    if (a.sin_cuenta_destino !== b.sin_cuenta_destino) {
      return a.sin_cuenta_destino ? 1 : -1;
    }
    const balanceDiff = Number(b.balance || 0) - Number(a.balance || 0);
    if (Math.abs(balanceDiff) > 0.01) return balanceDiff;
    return String(a.cuenta_destino_nombre || "").localeCompare(String(b.cuenta_destino_nombre || ""), "es");
  });
}

async function getConciliacionesCuentaCobro({ cajaId } = {}) {
  if (!cajaId) {
    return [];
  }
  await ensureConciliacionesCuentasCobroTable();
  return allQuery(
    `SELECT c.*, cc.nombre AS cuenta_nombre
     FROM conciliaciones_cuentas_cobro c
     LEFT JOIN cuentas_cobro cc ON cc.id = c.cuenta_cobro_id
     WHERE c.caja_id = ?
     ORDER BY c.id ASC`,
    [cajaId]
  );
}

async function guardarConciliacionCuentaCobro({
  cajaId,
  cuentaCobroId = null,
  montoSistema = 0,
  montoReal = 0,
  observaciones = "",
  usuario = "admin",
  fecha,
  hora
} = {}) {
  await ensureConciliacionesCuentasCobroTable();
  const caja = Number(cajaId) || 0;
  if (!caja) {
    const error = new Error("Caja invalida");
    error.statusCode = 400;
    throw error;
  }
  const cuenta = cuentaCobroId === null || cuentaCobroId === undefined || cuentaCobroId === "" ? null : Number(cuentaCobroId);
  const sistema = Number(Number(montoSistema || 0).toFixed(2));
  const real = Number(Number(montoReal || 0).toFixed(2));
  const diferencia = Number((real - sistema).toFixed(2));
  const estado = Math.abs(diferencia) < 0.01 ? "conciliado" : "diferencia";
  const obs = String(observaciones || "").trim();
  const user = String(usuario || "admin").trim() || "admin";
  const fechaFinal = fecha || new Date().toISOString().slice(0, 10);
  const horaFinal = hora || new Date().toTimeString().slice(0, 8);

  const existente = cuenta == null
    ? await getQuery(
        "SELECT id FROM conciliaciones_cuentas_cobro WHERE caja_id = ? AND cuenta_cobro_id IS NULL",
        [caja]
      )
    : await getQuery(
        "SELECT id FROM conciliaciones_cuentas_cobro WHERE caja_id = ? AND cuenta_cobro_id = ?",
        [caja, cuenta]
      );

  if (existente) {
    await runQuery(
      `UPDATE conciliaciones_cuentas_cobro
       SET monto_sistema = ?, monto_real = ?, diferencia = ?, estado = ?, observaciones = ?, fecha = ?, hora = ?, usuario = ?
       WHERE id = ?`,
      [sistema, real, diferencia, estado, obs, fechaFinal, horaFinal, user, existente.id]
    );
    return getQuery("SELECT * FROM conciliaciones_cuentas_cobro WHERE id = ?", [existente.id]);
  }

  const result = await runQuery(
    `INSERT INTO conciliaciones_cuentas_cobro
     (caja_id, cuenta_cobro_id, monto_sistema, monto_real, diferencia, estado, observaciones, fecha, hora, usuario)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [caja, cuenta, sistema, real, diferencia, estado, obs, fechaFinal, horaFinal, user]
  );
  return getQuery("SELECT * FROM conciliaciones_cuentas_cobro WHERE id = ?", [result.lastID]);
}

async function getConciliacionesCuentaDestino({ cajaId } = {}) {
  if (!cajaId) {
    return [];
  }
  await ensureConciliacionesCuentasDestinoTable();
  return allQuery(
    `SELECT c.*, cd.nombre AS cuenta_destino_nombre, cd.tipo_destino
     FROM conciliaciones_cuentas_destino c
     LEFT JOIN cuentas_destino cd ON cd.id = c.cuenta_destino_id
     WHERE c.caja_id = ?
     ORDER BY c.id ASC`,
    [cajaId]
  );
}

const DECISIONES_CIERRE_VALIDAS = new Set(["arrastrar", "retirar", "fijar"]);

async function guardarConciliacionCuentaDestino({
  cajaId,
  cuentaDestinoId = null,
  montoSistema = 0,
  montoReal = 0,
  saldoInicial = 0,
  decisionCierre = null,
  montoRetiro = 0,
  saldoArrastrado: saldoArrastradoParam = 0,
  observaciones = "",
  usuario = "admin",
  fecha,
  hora
} = {}) {
  await ensureConciliacionesCuentasDestinoTable();
  const caja = Number(cajaId) || 0;
  if (!caja) {
    const error = new Error("Caja invalida");
    error.statusCode = 400;
    throw error;
  }

  const cuenta = cuentaDestinoId === null || cuentaDestinoId === undefined || cuentaDestinoId === "" ? null : Number(cuentaDestinoId);
  if (cuenta !== null && !Number.isFinite(cuenta)) {
    const error = new Error("Cuenta destino invalida");
    error.statusCode = 400;
    throw error;
  }

  const inicio = Number(Number(saldoInicial || 0).toFixed(2));
  const sistema = Number(Number(montoSistema || 0).toFixed(2));
  const real = Number(Number(montoReal || 0).toFixed(2));
  const retiro = Number(Number(montoRetiro || 0).toFixed(2));
  // diferencia = monto_real - saldo_esperado; saldo_esperado = saldo_inicial + monto_sistema
  // cuando saldo_inicial=0 (legacy), equivale al cálculo anterior
  const saldoEsperado = Number((inicio + sistema).toFixed(2));
  const diferencia = Number((real - saldoEsperado).toFixed(2));
  const estado = Math.abs(diferencia) < 0.01 ? "conciliado" : "diferencia";

  const decision = decisionCierre ? String(decisionCierre).trim().toLowerCase() : null;
  if (decision !== null && !DECISIONES_CIERRE_VALIDAS.has(decision)) {
    const error = new Error("decision_cierre debe ser: arrastrar, retirar, fijar o null");
    error.statusCode = 400;
    throw error;
  }

  let arrastrado = 0;
  if (decision === "arrastrar") {
    arrastrado = real;
  } else if (decision === "retirar") {
    if (retiro > real) {
      const error = new Error("monto_retiro no puede superar monto_real");
      error.statusCode = 400;
      throw error;
    }
    arrastrado = Number((real - retiro).toFixed(2));
  } else if (decision === "fijar") {
    arrastrado = Number(Number(saldoArrastradoParam || 0).toFixed(2));
  }

  const obs = String(observaciones || "").trim();
  const user = String(usuario || "admin").trim() || "admin";
  const fechaFinal = fecha || new Date().toISOString().slice(0, 10);
  const horaFinal = hora || new Date().toTimeString().slice(0, 8);

  const existente = cuenta == null
    ? await getQuery(
        "SELECT id FROM conciliaciones_cuentas_destino WHERE caja_id = ? AND cuenta_destino_id IS NULL",
        [caja]
      )
    : await getQuery(
        "SELECT id FROM conciliaciones_cuentas_destino WHERE caja_id = ? AND cuenta_destino_id = ?",
        [caja, cuenta]
      );

  if (existente) {
    await runQuery(
      `UPDATE conciliaciones_cuentas_destino
       SET monto_sistema = ?, monto_real = ?, saldo_inicial = ?, diferencia = ?, estado = ?,
           decision_cierre = ?, monto_retiro = ?, saldo_arrastrado = ?,
           observaciones = ?, fecha = ?, hora = ?, usuario = ?
       WHERE id = ?`,
      [sistema, real, inicio, diferencia, estado, decision, retiro, arrastrado, obs, fechaFinal, horaFinal, user, existente.id]
    );
    return getQuery("SELECT * FROM conciliaciones_cuentas_destino WHERE id = ?", [existente.id]);
  }

  const result = await runQuery(
    `INSERT INTO conciliaciones_cuentas_destino
     (caja_id, cuenta_destino_id, monto_sistema, monto_real, saldo_inicial, diferencia, estado,
      decision_cierre, monto_retiro, saldo_arrastrado, observaciones, fecha, hora, usuario)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [caja, cuenta, sistema, real, inicio, diferencia, estado, decision, retiro, arrastrado, obs, fechaFinal, horaFinal, user]
  );
  return getQuery("SELECT * FROM conciliaciones_cuentas_destino WHERE id = ?", [result.lastID]);
}

async function getUltimoSaldoArrastradoPorCuenta(cuentaDestinoId) {
  await ensureConciliacionesCuentasDestinoTable();
  const cuenta = cuentaDestinoId === null || cuentaDestinoId === undefined || cuentaDestinoId === ""
    ? null
    : Number(cuentaDestinoId);

  const row = cuenta == null
    ? await getQuery(
        `SELECT ccd.saldo_arrastrado, ccd.decision_cierre
         FROM conciliaciones_cuentas_destino ccd
         JOIN caja_aperturas ca ON ca.id = ccd.caja_id
         WHERE ccd.cuenta_destino_id IS NULL AND ca.estado = 'cerrada'
         ORDER BY ca.id DESC LIMIT 1`
      )
    : await getQuery(
        `SELECT ccd.saldo_arrastrado, ccd.decision_cierre
         FROM conciliaciones_cuentas_destino ccd
         JOIN caja_aperturas ca ON ca.id = ccd.caja_id
         WHERE ccd.cuenta_destino_id = ? AND ca.estado = 'cerrada'
         ORDER BY ca.id DESC LIMIT 1`,
        [cuenta]
      );

  if (!row) return null;
  return {
    saldo_arrastrado: Number(row.saldo_arrastrado || 0),
    decision_cierre: row.decision_cierre || null
  };
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
        movimiento.tipo_operacion === "venta_pendiente_cobrada";
      const esCuentaCorriente = movimiento.tipo_operacion === "venta_cuenta_corriente";
      const tipoCobro = String(movimiento.tipo_cobro || "").toLowerCase();

      if (esPago || esEgresoManual) {
        acc.total_pagos_efectivo += efectivo;
        acc.total_pagos_debito += debito;
        acc.total_pagos_general += Number((efectivo + debito).toFixed(2));
      } else if (esIngresoManual) {
        acc.total_efectivo += efectivo;
      } else if (esCuentaCorriente) {
        // venta a cuenta no es ingreso real de caja — el cobro real llega como cobro_cuenta_corriente
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
  const resumenPorCuenta = await getResumenPorCuentaCobro({ cajaId: apertura.id });
  const esperadoPorCuenta = new Map(
    resumenPorCuenta.map((cuenta) => [
      cuenta.cuenta_cobro_id == null ? "sin-cuenta" : String(cuenta.cuenta_cobro_id),
      cuenta
    ])
  );
  const cuentasDetalle = cuentas.map((cuenta, index) => {
    const cuentaCobroId = cuenta.cuenta_cobro_id == null || cuenta.cuenta_cobro_id === ""
      ? null
      : Number(cuenta.cuenta_cobro_id);
    const cuentaKey = cuentaCobroId == null ? "sin-cuenta" : String(cuentaCobroId);
    const cuentaSistema = esperadoPorCuenta.get(cuentaKey);
    const nombre = String(cuenta.nombre || cuenta.cuenta_nombre || cuentaSistema?.cuenta_nombre || `Cuenta ${index + 1}`).trim() || `Cuenta ${index + 1}`;
    const saldoInicial = Number(cuenta.saldo_inicial || 0);
    const saldoActual = Number(cuenta.saldo_actual || 0);
    const montoSistema = Number(
      cuenta.monto_sistema ?? cuenta.balance ?? cuentaSistema?.balance ?? 0
    );
    return {
      cuenta_cobro_id: cuentaCobroId,
      nombre,
      monto_sistema: Number(montoSistema.toFixed(2)),
      saldo_inicial: Number(saldoInicial.toFixed(2)),
      saldo_actual: Number(saldoActual.toFixed(2)),
      recaudacion_real: Number((saldoActual - saldoInicial).toFixed(2))
    };
  });
  const digitalReal = Number(
    cuentasDetalle.reduce((acc, cuenta) => acc + Number(cuenta.recaudacion_real || 0), 0).toFixed(2)
  );
  const tieneCuentasCobro = cuentasDetalle.some((cuenta) => cuenta.cuenta_cobro_id !== null) ||
    resumenPorCuenta.length > 0;
  const digitalEsperado = tieneCuentasCobro
    ? Number((cuentasDetalle.length ? cuentasDetalle : resumenPorCuenta)
        .reduce((acc, cuenta) => acc + Number(cuenta.monto_sistema ?? cuenta.balance ?? 0), 0)
        .toFixed(2))
    : Number((
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

module.exports = {
  buildCajaArqueoData,
  buildCajaResumen,
  buildCajaResumenConSaldoMp,
  buildCajaSnapshot,
  calcularDistribucionArqueo,
  CAJA_DENOMINACIONES_ARQUEO_DEFAULTS,
  getResumenPorCuentaCobro,
  buildConteoBilletes,
  ensureCajaArqueosTable,
  ensureCajaDenominacionesArqueoTable,
  ensureCajaTrasladosInternosTable,
  ensureCajaMovimientosTable,
  ensureConciliacionesCuentasCobroTable,
  ensureConciliacionesCuentasDestinoTable,
  getCajaAbiertaActual,
  getCajaAperturaHoy,
  getCajaParaArqueos,
  getOperacionesCaja,
  getPagosCaja,
  getReglasDenominacionesArqueoActivas,
  getUltimaCajaRegistrada,
  getConciliacionesCuentaCobro,
  getConciliacionesCuentaDestino,
  getResumenPorCuentaDestino,
  guardarConciliacionCuentaCobro,
  guardarConciliacionCuentaDestino,
  getUltimoSaldoArrastradoPorCuenta,
  mapCajaArqueo,
  normalizarTrasladoInterno,
  validarTrasladoInterno,
  parseJsonOrFallback
};
