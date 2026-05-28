const { allQuery } = require("../db");

const PERMISOS_ACCIONES_DEFAULTS = {
  ventas_editar_ticket: { admin: true, encargado: true, colaborador: true },
  ventas_anular_ticket: { admin: true, encargado: true, colaborador: false },
  ventas_eliminar_pendiente: { admin: true, encargado: true, colaborador: false },
  stock_ver: { admin: true, encargado: true, colaborador: true },
  stock_crear_producto: { admin: true, encargado: true, colaborador: false },
  stock_editar_producto: { admin: true, encargado: true, colaborador: false },
  stock_ajustar: { admin: true, encargado: true, colaborador: false },
  stock_eliminar_producto: { admin: true, encargado: false, colaborador: false },
  stock_ver_costos: { admin: true, encargado: true, colaborador: false },
  caja_abrir: { admin: true, encargado: true, colaborador: true },
  caja_cerrar: { admin: true, encargado: true, colaborador: false },
  caja_registrar_arqueo: { admin: true, encargado: true, colaborador: true },
  caja_movimientos: { admin: true, encargado: true, colaborador: true },
  pagos_crear: { admin: true, encargado: true, colaborador: true },
  pagos_editar: { admin: true, encargado: true, colaborador: false },
  pagos_eliminar: { admin: true, encargado: false, colaborador: false },
  admin_usuarios: { admin: true, encargado: false, colaborador: false },
  admin_configuracion: { admin: true, encargado: false, colaborador: false },
  // Deprecated: mantener por compatibilidad hasta migrar la UI/configuracion.
  ver_stock: { admin: true, encargado: true, colaborador: true },
  sumar_stock: { admin: true, encargado: true, colaborador: false },
  ver_acciones: { admin: true, encargado: true, colaborador: false },
  ver_costos: { admin: true, encargado: true, colaborador: false },
  anular_ticket: { admin: true, encargado: true, colaborador: false },
  editar_ticket: { admin: true, encargado: true, colaborador: true },
  registros: { admin: true, encargado: true, colaborador: false },
  caja: { admin: true, encargado: true, colaborador: true }
};

const PERMISOS_LEGACY_ALIASES = {
  stock_ver: ["ver_stock"],
  stock_ajustar: ["sumar_stock"],
  stock_ver_costos: ["ver_costos"],
  ventas_anular_ticket: ["anular_ticket"],
  ventas_editar_ticket: ["editar_ticket"],
  ventas_eliminar_pendiente: ["anular_ticket"],
  caja_movimientos: ["registros", "caja"],
  caja_abrir: ["caja"],
  caja_cerrar: ["caja"],
  caja_registrar_arqueo: ["registros", "caja"]
};

const MAPEO_PERMISOS = {
  ver_stock: "stock_ver",
  sumar_stock: "stock_ajustar",
  ver_costos: "stock_ver_costos",
  anular_ticket: "ventas_anular_ticket",
  editar_ticket: "ventas_editar_ticket",
  registros: "caja_movimientos",
  caja: "caja_movimientos",
  crear_producto: "stock_crear_producto",
  editar_producto: "stock_editar_producto",
  ajustar_stock: "stock_ajustar",
  eliminar_producto: "stock_eliminar_producto",
  abrir_caja: "caja_abrir",
  cerrar_caja: "caja_cerrar",
  registrar_arqueo: "caja_registrar_arqueo",
  movimientos_caja: "caja_movimientos",
  crear_pago: "pagos_crear",
  editar_pago: "pagos_editar",
  eliminar_pago: "pagos_eliminar",
  usuarios: "admin_usuarios",
  configuracion: "admin_configuracion"
};

const CONFIGURACION_PUBLICA_KEYS = new Set([
  "negocio_nombre_comercial",
  "negocio_direccion",
  "negocio_telefono",
  "negocio_logo_url",
  "negocio_logo_escala",
  "pago_efectivo_activo",
  "pago_debito_activo",
  "pago_credito_activo",
  "pago_transferencia_activo",
  "pago_billetera_activo",
  "pago_cuenta_corriente_activo",
  "pago_tipos_disponibles",
  "stock_codigo_automatico",
  "stock_manejo_activo",
  "stock_alerta_minimo",
  "stock_valor_alerta",
  "cuenta_local_activa",
  "cuenta_local_nombre",
  "cuenta_local_produccion_activa",
  "cuenta_local_interno_cortesia_activa",
  "dashboard_tipo_admin",
  "dashboard_tipo_encargado",
  "dashboard_tipo_colaborador",
  "dashboard_pizarra_categorias",
  "dashboard_pizarra_productos",
  "ticket_nombre",
  "ticket_modo_encabezado",
  "ticket_logo_ancho",
  "ticket_impresora_activa",
  "ticket_mostrar_logo",
  "ticket_mostrar_items",
  "ticket_mensaje_final"
]);

const CONFIGURACION_DEFAULTS = {
  negocio_nombre_comercial: { seccion: "negocio", valor: "Guernica Bar" },
  negocio_razon_social: { seccion: "negocio", valor: "" },
  negocio_cuit: { seccion: "negocio", valor: "" },
  negocio_condicion_fiscal: { seccion: "negocio", valor: "Responsable inscripto" },
  negocio_direccion: { seccion: "negocio", valor: "" },
  negocio_telefono: { seccion: "negocio", valor: "" },
  negocio_email: { seccion: "negocio", valor: "" },
  negocio_logo_url: { seccion: "negocio", valor: "" },
  negocio_logo_escala: { seccion: "negocio", valor: 100 },
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
  stock_codigo_automatico: { seccion: "stock", valor: true },
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
  cuenta_corriente_actualizar_fiado_por_precio_actual: { seccion: "cuentas_corrientes", valor: false },
  cuentas_dias_vencimiento: { seccion: "cuentas_corrientes", valor: 30 },
  cuentas_permitir_exceder: { seccion: "cuentas_corrientes", valor: false },
  cuentas_interes_mora: { seccion: "cuentas_corrientes", valor: 0 },
  cuentas_interes_mora_activo: { seccion: "cuentas_corrientes", valor: false },
  cuentas_desactivar_por_vencimiento: { seccion: "cuentas_corrientes", valor: true },
  cuentas_dias_a_costo: { seccion: "cuentas_corrientes", valor: 90 },
  cuentas_limite_global_activo: { seccion: "cuentas_corrientes", valor: false },
  cuentas_limite_global_monto: { seccion: "cuentas_corrientes", valor: 0 },
  cuenta_local_activa: { seccion: "cuentas_corrientes", valor: false },
  cuenta_local_nombre: { seccion: "cuentas_corrientes", valor: "" },
  cuenta_local_produccion_activa: { seccion: "cuentas_corrientes", valor: true },
  cuenta_local_interno_cortesia_activa: { seccion: "cuentas_corrientes", valor: true },
  autorizacion_clave_maestra: { seccion: "usuarios_permisos", valor: "1234" },
  permiso_ajuste_stock: { seccion: "usuarios_permisos", valor: "admin" },
  permiso_ver_costos: { seccion: "usuarios_permisos", valor: "admin" },
  permiso_cierre_caja: { seccion: "usuarios_permisos", valor: "admin" },
  permiso_eliminar_registros: { seccion: "usuarios_permisos", valor: "admin" },
  permisos_acciones_roles: { seccion: "usuarios_permisos", valor: JSON.stringify(PERMISOS_ACCIONES_DEFAULTS) },
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
  modulo_inicio_colaborador: { seccion: "usuarios_permisos", valor: true },
  modulo_ventas_colaborador: { seccion: "usuarios_permisos", valor: true },
  modulo_caja_colaborador: { seccion: "usuarios_permisos", valor: true },
  modulo_pagos_colaborador: { seccion: "usuarios_permisos", valor: false },
  modulo_stock_colaborador: { seccion: "usuarios_permisos", valor: true },
  modulo_clientes_colaborador: { seccion: "usuarios_permisos", valor: true },
  modulo_proveedores_colaborador: { seccion: "usuarios_permisos", valor: false },
  modulo_reportes_colaborador: { seccion: "usuarios_permisos", valor: false },
  modulo_usuarios_colaborador: { seccion: "usuarios_permisos", valor: false },
  modulo_configuracion_colaborador: { seccion: "usuarios_permisos", valor: false },
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
  dashboard_tipo_colaborador: { seccion: "usuarios_permisos", valor: "simple" },
  dashboard_pizarra_categorias: { seccion: "usuarios_permisos", valor: "cafeteria,cafe,menu,desayuno,merienda" },
  dashboard_pizarra_productos: { seccion: "usuarios_permisos", valor: "" },
  ticket_nombre: { seccion: "tickets", valor: "Guernica Bar" },
  ticket_modo_encabezado: { seccion: "tickets", valor: "logo" },
  ticket_logo_ancho: { seccion: "tickets", valor: 65 },
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

function normalizarRolPermiso(rol) {
  const normalizado = String(rol || "").trim().toLowerCase().replace(/\s+/g, "_");
  return { operador: "colaborador", caja: "colaborador", cajero: "colaborador" }[normalizado] || normalizado;
}

function sanitizarConfiguracionParaRol(config, rol) {
  if (normalizarRolPermiso(rol) === "admin") return config;

  return Object.fromEntries(
    Object.entries(config || {}).filter(([clave]) => CONFIGURACION_PUBLICA_KEYS.has(clave) || clave.startsWith("modulo_"))
  );
}

function configBool(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function getPermisoConfig(permisos, accion) {
  return permisos?.[accion] || {};
}

function normalizarPermisosAccionesRoles(permisos) {
  const parsed = typeof permisos === "string" ? parsearConfigValor(permisos) : permisos;
  const defaults = parsearConfigValor(CONFIGURACION_DEFAULTS.permisos_acciones_roles.valor) || {};
  const resultado = {};

  Object.keys(defaults).forEach((accion) => {
    const actual = getPermisoConfig(parsed, accion);
    const aliasesLegacy = PERMISOS_LEGACY_ALIASES[accion] || [];
    resultado[accion] = {
      admin: actual.admin ?? aliasesLegacy.map((alias) => getPermisoConfig(parsed, alias).admin).find((valor) => valor !== undefined) ?? defaults[accion].admin ?? false,
      encargado: actual.encargado ?? aliasesLegacy.map((alias) => getPermisoConfig(parsed, alias).encargado).find((valor) => valor !== undefined) ?? defaults[accion].encargado ?? false,
      colaborador: actual.colaborador ?? aliasesLegacy.map((alias) => getPermisoConfig(parsed, alias).colaborador).find((valor) => valor !== undefined) ?? Boolean(actual.operador || actual.caja || aliasesLegacy.some((alias) => {
        const legacy = getPermisoConfig(parsed, alias);
        return legacy.operador || legacy.caja;
      }) || defaults[accion].colaborador)
    };
  });

  Object.keys(parsed || {}).forEach((accion) => {
    if (resultado[accion]) return;
    const actual = parsed?.[accion] || {};
    resultado[accion] = {
      admin: actual.admin ?? false,
      encargado: actual.encargado ?? false,
      colaborador: actual.colaborador ?? Boolean(actual.operador || actual.caja)
    };
  });

  return resultado;
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

  config.permisos_acciones_roles = normalizarPermisosAccionesRoles(config.permisos_acciones_roles);

  return config;
}

async function tienePermisoAccion(req, accion) {
  if (!req.usuario) return true;
  const rol = normalizarRolPermiso(req.usuario.rol);
  const accionNormalizada = MAPEO_PERMISOS[accion] || accion;
  const accionConocida = Object.prototype.hasOwnProperty.call(PERMISOS_ACCIONES_DEFAULTS, accionNormalizada);
  if (!accionConocida) return false;
  if (rol === "admin") return true;
  const config = await getConfiguracionGlobal();
  const permisos = config.permisos_acciones_roles || {};
  const valor = permisos?.[accionNormalizada]?.[rol];
  if (valor !== undefined) return configBool(valor);
  return configBool(PERMISOS_ACCIONES_DEFAULTS?.[accionNormalizada]?.[rol]);
}

async function puedeAccionUsuario(req, accion) {
  return tienePermisoAccion(req, accion);
}

async function requirePermiso(req, res, accion, mensaje) {
  if (await tienePermisoAccion(req, accion)) return true;
  res.status(403).json({ message: mensaje || "No tenes permisos para esta accion" });
  return false;
}

module.exports = {
  CONFIGURACION_DEFAULTS,
  PERMISOS_ACCIONES_DEFAULTS,
  MAPEO_PERMISOS,
  getConfiguracionGlobal,
  normalizarPermisosAccionesRoles,
  parsearConfigValor,
  serializarConfigValor,
  sanitizarConfiguracionParaRol,
  tienePermisoAccion,
  puedeAccionUsuario,
  requirePermiso
};
