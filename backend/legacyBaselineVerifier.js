const fs = require("fs");
const sqlite3 = require("sqlite3");

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    return Object.freeze(value);
  }
  return value;
}

const SCHEMA_TABLE_ENTRIES = [
  { id: "TABLE:caja_arqueo_denominaciones", category: "SCHEMA_TABLE", table: "caja_arqueo_denominaciones" },
  { id: "TABLE:caja_arqueos", category: "SCHEMA_TABLE", table: "caja_arqueos" },
  { id: "TABLE:caja_movimientos", category: "SCHEMA_TABLE", table: "caja_movimientos" },
  { id: "TABLE:caja_traslados_internos", category: "SCHEMA_TABLE", table: "caja_traslados_internos" },
  { id: "TABLE:categorias", category: "SCHEMA_TABLE", table: "categorias" },
  { id: "TABLE:compra_comprobante_iva", category: "SCHEMA_TABLE", table: "compra_comprobante_iva" },
  { id: "TABLE:compra_comprobantes", category: "SCHEMA_TABLE", table: "compra_comprobantes" },
  { id: "TABLE:compra_items", category: "SCHEMA_TABLE", table: "compra_items" },
  { id: "TABLE:compra_recepcion_items", category: "SCHEMA_TABLE", table: "compra_recepcion_items" },
  { id: "TABLE:compra_recepciones", category: "SCHEMA_TABLE", table: "compra_recepciones" },
  { id: "TABLE:compras", category: "SCHEMA_TABLE", table: "compras" },
  { id: "TABLE:conciliaciones_cuentas_cobro", category: "SCHEMA_TABLE", table: "conciliaciones_cuentas_cobro" },
  { id: "TABLE:conciliaciones_cuentas_destino", category: "SCHEMA_TABLE", table: "conciliaciones_cuentas_destino" },
  { id: "TABLE:configuracion_global", category: "SCHEMA_TABLE", table: "configuracion_global" },
  { id: "TABLE:cuentas_cobro", category: "SCHEMA_TABLE", table: "cuentas_cobro" },
  { id: "TABLE:cuentas_destino", category: "SCHEMA_TABLE", table: "cuentas_destino" },
  { id: "TABLE:detalle_venta_componentes_snapshot", category: "SCHEMA_TABLE", table: "detalle_venta_componentes_snapshot" },
  { id: "TABLE:detalle_venta_modificadores", category: "SCHEMA_TABLE", table: "detalle_venta_modificadores" },
  { id: "TABLE:detalle_venta_receta_snapshot", category: "SCHEMA_TABLE", table: "detalle_venta_receta_snapshot" },
  { id: "TABLE:mercado_pago_intentos", category: "SCHEMA_TABLE", table: "mercado_pago_intentos" },
  { id: "TABLE:modificador_componentes", category: "SCHEMA_TABLE", table: "modificador_componentes" },
  { id: "TABLE:modificadores", category: "SCHEMA_TABLE", table: "modificadores" },
  { id: "TABLE:pagos_cc_cobros", category: "SCHEMA_TABLE", table: "pagos_cc_cobros" },
  { id: "TABLE:producto_componentes", category: "SCHEMA_TABLE", table: "producto_componentes" },
  { id: "TABLE:producto_costos_extra", category: "SCHEMA_TABLE", table: "producto_costos_extra" },
  { id: "TABLE:producto_costos_insumos", category: "SCHEMA_TABLE", table: "producto_costos_insumos" },
  { id: "TABLE:producto_ingredientes_visibles", category: "SCHEMA_TABLE", table: "producto_ingredientes_visibles" },
  { id: "TABLE:producto_modificadores", category: "SCHEMA_TABLE", table: "producto_modificadores" },
  { id: "TABLE:producto_revisiones_pendientes", category: "SCHEMA_TABLE", table: "producto_revisiones_pendientes" },
  { id: "TABLE:recalculos_cuenta_corriente", category: "SCHEMA_TABLE", table: "recalculos_cuenta_corriente" },
  { id: "TABLE:sesiones", category: "SCHEMA_TABLE", table: "sesiones" },
  { id: "TABLE:stock_ajustes_pendientes", category: "SCHEMA_TABLE", table: "stock_ajustes_pendientes" },
  { id: "TABLE:tienda_pedido_item_ingredientes", category: "SCHEMA_TABLE", table: "tienda_pedido_item_ingredientes" },
  { id: "TABLE:tienda_pedido_item_modificadores", category: "SCHEMA_TABLE", table: "tienda_pedido_item_modificadores" },
  { id: "TABLE:tienda_pedido_items", category: "SCHEMA_TABLE", table: "tienda_pedido_items" },
  { id: "TABLE:tienda_pedidos", category: "SCHEMA_TABLE", table: "tienda_pedidos" },
  { id: "TABLE:tipos_pago", category: "SCHEMA_TABLE", table: "tipos_pago" },
  { id: "TABLE:usuarios", category: "SCHEMA_TABLE", table: "usuarios" },
  { id: "TABLE:venta_cobros", category: "SCHEMA_TABLE", table: "venta_cobros" }
];

const SCHEMA_COLUMN_ENTRIES = [
  { id: "COLUMN:caja_arqueos.cambio_retenido", category: "SCHEMA_COLUMN", table: "caja_arqueos", column: "cambio_retenido" },
  { id: "COLUMN:caja_arqueos.cuenta_origen_id", category: "SCHEMA_COLUMN", table: "caja_arqueos", column: "cuenta_origen_id" },
  { id: "COLUMN:caja_arqueos.cuenta_reserva_id", category: "SCHEMA_COLUMN", table: "caja_arqueos", column: "cuenta_reserva_id" },
  { id: "COLUMN:caja_arqueos.idempotency_key", category: "SCHEMA_COLUMN", table: "caja_arqueos", column: "idempotency_key" },
  { id: "COLUMN:caja_arqueos.modelo_arqueo_version", category: "SCHEMA_COLUMN", table: "caja_arqueos", column: "modelo_arqueo_version" },
  { id: "COLUMN:caja_arqueos.monto_extraido", category: "SCHEMA_COLUMN", table: "caja_arqueos", column: "monto_extraido" },
  { id: "COLUMN:caja_arqueos.registrado_cierre", category: "SCHEMA_COLUMN", table: "caja_arqueos", column: "registrado_cierre" },
  { id: "COLUMN:categorias.maneja_stock", category: "SCHEMA_COLUMN", table: "categorias", column: "maneja_stock" },
  { id: "COLUMN:categorias.usa_costos_varios", category: "SCHEMA_COLUMN", table: "categorias", column: "usa_costos_varios" },
  { id: "COLUMN:clientes.codigo_postal", category: "SCHEMA_COLUMN", table: "clientes", column: "codigo_postal" },
  { id: "COLUMN:clientes.contacto", category: "SCHEMA_COLUMN", table: "clientes", column: "contacto" },
  { id: "COLUMN:clientes.dia_vencimiento_fijo", category: "SCHEMA_COLUMN", table: "clientes", column: "dia_vencimiento_fijo" },
  { id: "COLUMN:clientes.dias_vencimiento", category: "SCHEMA_COLUMN", table: "clientes", column: "dias_vencimiento" },
  { id: "COLUMN:clientes.dni_cuit", category: "SCHEMA_COLUMN", table: "clientes", column: "dni_cuit" },
  { id: "COLUMN:clientes.email", category: "SCHEMA_COLUMN", table: "clientes", column: "email" },
  { id: "COLUMN:clientes.foto_url", category: "SCHEMA_COLUMN", table: "clientes", column: "foto_url" },
  { id: "COLUMN:clientes.habilita_cuenta_corriente", category: "SCHEMA_COLUMN", table: "clientes", column: "habilita_cuenta_corriente" },
  { id: "COLUMN:clientes.localidad", category: "SCHEMA_COLUMN", table: "clientes", column: "localidad" },
  { id: "COLUMN:clientes.moneda", category: "SCHEMA_COLUMN", table: "clientes", column: "moneda" },
  { id: "COLUMN:clientes.notas", category: "SCHEMA_COLUMN", table: "clientes", column: "notas" },
  { id: "COLUMN:clientes.perfil_cliente", category: "SCHEMA_COLUMN", table: "clientes", column: "perfil_cliente" },
  { id: "COLUMN:clientes.permite_excedente", category: "SCHEMA_COLUMN", table: "clientes", column: "permite_excedente" },
  { id: "COLUMN:clientes.requiere_autorizacion", category: "SCHEMA_COLUMN", table: "clientes", column: "requiere_autorizacion" },
  { id: "COLUMN:clientes.suspendido", category: "SCHEMA_COLUMN", table: "clientes", column: "suspendido" },
  { id: "COLUMN:clientes.tipo_cliente", category: "SCHEMA_COLUMN", table: "clientes", column: "tipo_cliente" },
  { id: "COLUMN:clientes.tipo_cuenta_corriente", category: "SCHEMA_COLUMN", table: "clientes", column: "tipo_cuenta_corriente" },
  { id: "COLUMN:clientes.tipo_persona", category: "SCHEMA_COLUMN", table: "clientes", column: "tipo_persona" },
  { id: "COLUMN:clientes.usa_reglas_personalizadas", category: "SCHEMA_COLUMN", table: "clientes", column: "usa_reglas_personalizadas" },
  { id: "COLUMN:compra_comprobantes.anulado_at", category: "SCHEMA_COLUMN", table: "compra_comprobantes", column: "anulado_at" },
  { id: "COLUMN:compra_comprobantes.anulado_por", category: "SCHEMA_COLUMN", table: "compra_comprobantes", column: "anulado_por" },
  { id: "COLUMN:compra_comprobantes.motivo_anulacion", category: "SCHEMA_COLUMN", table: "compra_comprobantes", column: "motivo_anulacion" },
  { id: "COLUMN:compra_recepcion_items.costo_referencial_actualizado", category: "SCHEMA_COLUMN", table: "compra_recepcion_items", column: "costo_referencial_actualizado" },
  { id: "COLUMN:compra_recepcion_items.fecha_precio_proveedor_anterior_snapshot", category: "SCHEMA_COLUMN", table: "compra_recepcion_items", column: "fecha_precio_proveedor_anterior_snapshot" },
  { id: "COLUMN:compra_recepcion_items.modo_stock", category: "SCHEMA_COLUMN", table: "compra_recepcion_items", column: "modo_stock" },
  { id: "COLUMN:compra_recepcion_items.movimiento_stock_reversa_id", category: "SCHEMA_COLUMN", table: "compra_recepcion_items", column: "movimiento_stock_reversa_id" },
  { id: "COLUMN:compra_recepcion_items.movimiento_stock_vinculado_id", category: "SCHEMA_COLUMN", table: "compra_recepcion_items", column: "movimiento_stock_vinculado_id" },
  { id: "COLUMN:compra_recepcion_items.precio_proveedor_anterior_snapshot", category: "SCHEMA_COLUMN", table: "compra_recepcion_items", column: "precio_proveedor_anterior_snapshot" },
  { id: "COLUMN:compras.anulada_at", category: "SCHEMA_COLUMN", table: "compras", column: "anulada_at" },
  { id: "COLUMN:compras.anulada_por", category: "SCHEMA_COLUMN", table: "compras", column: "anulada_por" },
  { id: "COLUMN:compras.motivo_anulacion", category: "SCHEMA_COLUMN", table: "compras", column: "motivo_anulacion" },
  { id: "COLUMN:conciliaciones_cuentas_destino.confirmado_usuario", category: "SCHEMA_COLUMN", table: "conciliaciones_cuentas_destino", column: "confirmado_usuario" },
  { id: "COLUMN:conciliaciones_cuentas_destino.decision_cierre", category: "SCHEMA_COLUMN", table: "conciliaciones_cuentas_destino", column: "decision_cierre" },
  { id: "COLUMN:conciliaciones_cuentas_destino.monto_retiro", category: "SCHEMA_COLUMN", table: "conciliaciones_cuentas_destino", column: "monto_retiro" },
  { id: "COLUMN:conciliaciones_cuentas_destino.saldo_arrastrado", category: "SCHEMA_COLUMN", table: "conciliaciones_cuentas_destino", column: "saldo_arrastrado" },
  { id: "COLUMN:conciliaciones_cuentas_destino.saldo_inicial", category: "SCHEMA_COLUMN", table: "conciliaciones_cuentas_destino", column: "saldo_inicial" },
  { id: "COLUMN:cuentas_cobro.cuenta_destino_id", category: "SCHEMA_COLUMN", table: "cuentas_cobro", column: "cuenta_destino_id" },
  { id: "COLUMN:detalle_ventas.costo_economico_snapshot", category: "SCHEMA_COLUMN", table: "detalle_ventas", column: "costo_economico_snapshot" },
  { id: "COLUMN:detalle_ventas.iva_monto_snapshot", category: "SCHEMA_COLUMN", table: "detalle_ventas", column: "iva_monto_snapshot" },
  { id: "COLUMN:detalle_ventas.iva_venta_alicuota_snapshot", category: "SCHEMA_COLUMN", table: "detalle_ventas", column: "iva_venta_alicuota_snapshot" },
  { id: "COLUMN:detalle_ventas.iva_venta_tratamiento_snapshot", category: "SCHEMA_COLUMN", table: "detalle_ventas", column: "iva_venta_tratamiento_snapshot" },
  { id: "COLUMN:detalle_ventas.modelo_fiscal_snapshot", category: "SCHEMA_COLUMN", table: "detalle_ventas", column: "modelo_fiscal_snapshot" },
  { id: "COLUMN:detalle_ventas.subtotal_neto_snapshot", category: "SCHEMA_COLUMN", table: "detalle_ventas", column: "subtotal_neto_snapshot" },
  { id: "COLUMN:movimientos_stock.idempotency_key", category: "SCHEMA_COLUMN", table: "movimientos_stock", column: "idempotency_key" },
  { id: "COLUMN:movimientos_stock.movimiento_stock_reversa_id", category: "SCHEMA_COLUMN", table: "movimientos_stock", column: "movimiento_stock_reversa_id" },
  { id: "COLUMN:movimientos_stock.origen_id", category: "SCHEMA_COLUMN", table: "movimientos_stock", column: "origen_id" },
  { id: "COLUMN:movimientos_stock.origen_tipo", category: "SCHEMA_COLUMN", table: "movimientos_stock", column: "origen_tipo" },
  { id: "COLUMN:pagos_cc_cobros.cuenta_cobro_nombre_snapshot", category: "SCHEMA_COLUMN", table: "pagos_cc_cobros", column: "cuenta_cobro_nombre_snapshot" },
  { id: "COLUMN:pagos_cc_cobros.cuenta_cobro_tipo_pago_snapshot", category: "SCHEMA_COLUMN", table: "pagos_cc_cobros", column: "cuenta_cobro_tipo_pago_snapshot" },
  { id: "COLUMN:pagos_cc_cobros.cuenta_destino_id_snapshot", category: "SCHEMA_COLUMN", table: "pagos_cc_cobros", column: "cuenta_destino_id_snapshot" },
  { id: "COLUMN:pagos_cc_cobros.cuenta_destino_nombre_snapshot", category: "SCHEMA_COLUMN", table: "pagos_cc_cobros", column: "cuenta_destino_nombre_snapshot" },
  { id: "COLUMN:pagos_cc_cobros.numero_comprobante", category: "SCHEMA_COLUMN", table: "pagos_cc_cobros", column: "numero_comprobante" },
  { id: "COLUMN:pagos_cc_cobros.observacion", category: "SCHEMA_COLUMN", table: "pagos_cc_cobros", column: "observacion" },
  { id: "COLUMN:pagos_cc_cobros.reversa_de_group_id", category: "SCHEMA_COLUMN", table: "pagos_cc_cobros", column: "reversa_de_group_id" },
  { id: "COLUMN:pagos_cc_cobros.tipo_movimiento", category: "SCHEMA_COLUMN", table: "pagos_cc_cobros", column: "tipo_movimiento" },
  { id: "COLUMN:pagos_cc_cobros.usuario_id", category: "SCHEMA_COLUMN", table: "pagos_cc_cobros", column: "usuario_id" },
  { id: "COLUMN:pagos_cc_cobros.usuario_nombre", category: "SCHEMA_COLUMN", table: "pagos_cc_cobros", column: "usuario_nombre" },
  { id: "COLUMN:pagos_cuenta_corriente.fecha_reversa", category: "SCHEMA_COLUMN", table: "pagos_cuenta_corriente", column: "fecha_reversa" },
  { id: "COLUMN:pagos_cuenta_corriente.group_id", category: "SCHEMA_COLUMN", table: "pagos_cuenta_corriente", column: "group_id" },
  { id: "COLUMN:pagos_cuenta_corriente.hora_reversa", category: "SCHEMA_COLUMN", table: "pagos_cuenta_corriente", column: "hora_reversa" },
  { id: "COLUMN:pagos_cuenta_corriente.motivo_reversa", category: "SCHEMA_COLUMN", table: "pagos_cuenta_corriente", column: "motivo_reversa" },
  { id: "COLUMN:pagos_cuenta_corriente.numero_comprobante", category: "SCHEMA_COLUMN", table: "pagos_cuenta_corriente", column: "numero_comprobante" },
  { id: "COLUMN:pagos_cuenta_corriente.observacion", category: "SCHEMA_COLUMN", table: "pagos_cuenta_corriente", column: "observacion" },
  { id: "COLUMN:pagos_cuenta_corriente.reversa_de_group_id", category: "SCHEMA_COLUMN", table: "pagos_cuenta_corriente", column: "reversa_de_group_id" },
  { id: "COLUMN:pagos_cuenta_corriente.revertido", category: "SCHEMA_COLUMN", table: "pagos_cuenta_corriente", column: "revertido" },
  { id: "COLUMN:pagos_cuenta_corriente.tipo_movimiento", category: "SCHEMA_COLUMN", table: "pagos_cuenta_corriente", column: "tipo_movimiento" },
  { id: "COLUMN:pagos_cuenta_corriente.usuario_id", category: "SCHEMA_COLUMN", table: "pagos_cuenta_corriente", column: "usuario_id" },
  { id: "COLUMN:pagos_cuenta_corriente.usuario_nombre", category: "SCHEMA_COLUMN", table: "pagos_cuenta_corriente", column: "usuario_nombre" },
  { id: "COLUMN:pagos_cuenta_corriente.usuario_reversa_id", category: "SCHEMA_COLUMN", table: "pagos_cuenta_corriente", column: "usuario_reversa_id" },
  { id: "COLUMN:pagos_cuenta_corriente.usuario_reversa_nombre", category: "SCHEMA_COLUMN", table: "pagos_cuenta_corriente", column: "usuario_reversa_nombre" },
  { id: "COLUMN:pagos.compra_id", category: "SCHEMA_COLUMN", table: "pagos", column: "compra_id" },
  { id: "COLUMN:pagos.cuenta_cobro_id", category: "SCHEMA_COLUMN", table: "pagos", column: "cuenta_cobro_id" },
  { id: "COLUMN:pagos.cuenta_destino_id_snapshot", category: "SCHEMA_COLUMN", table: "pagos", column: "cuenta_destino_id_snapshot" },
  { id: "COLUMN:pagos.iva_credito_fiscal", category: "SCHEMA_COLUMN", table: "pagos", column: "iva_credito_fiscal" },
  { id: "COLUMN:productos.agregar_proveedor_info", category: "SCHEMA_COLUMN", table: "productos", column: "agregar_proveedor_info" },
  { id: "COLUMN:productos.alerta_stock_minimo", category: "SCHEMA_COLUMN", table: "productos", column: "alerta_stock_minimo" },
  { id: "COLUMN:productos.aplica_para_combo", category: "SCHEMA_COLUMN", table: "productos", column: "aplica_para_combo" },
  { id: "COLUMN:productos.codigo", category: "SCHEMA_COLUMN", table: "productos", column: "codigo" },
  { id: "COLUMN:productos.codigo_barras", category: "SCHEMA_COLUMN", table: "productos", column: "codigo_barras" },
  { id: "COLUMN:productos.costo_economico", category: "SCHEMA_COLUMN", table: "productos", column: "costo_economico" },
  { id: "COLUMN:productos.descripcion", category: "SCHEMA_COLUMN", table: "productos", column: "descripcion" },
  { id: "COLUMN:productos.es_combo", category: "SCHEMA_COLUMN", table: "productos", column: "es_combo" },
  { id: "COLUMN:productos.iva_venta_alicuota", category: "SCHEMA_COLUMN", table: "productos", column: "iva_venta_alicuota" },
  { id: "COLUMN:productos.iva_venta_tratamiento", category: "SCHEMA_COLUMN", table: "productos", column: "iva_venta_tratamiento" },
  { id: "COLUMN:productos.marca", category: "SCHEMA_COLUMN", table: "productos", column: "marca" },
  { id: "COLUMN:productos.modelo_fiscal", category: "SCHEMA_COLUMN", table: "productos", column: "modelo_fiscal" },
  { id: "COLUMN:productos.precio_referencial_proveedor", category: "SCHEMA_COLUMN", table: "productos", column: "precio_referencial_proveedor" },
  { id: "COLUMN:productos.precio_venta_modo", category: "SCHEMA_COLUMN", table: "productos", column: "precio_venta_modo" },
  { id: "COLUMN:productos.presentacion", category: "SCHEMA_COLUMN", table: "productos", column: "presentacion" },
  { id: "COLUMN:productos.rendimiento_receta", category: "SCHEMA_COLUMN", table: "productos", column: "rendimiento_receta" },
  { id: "COLUMN:productos.stock_minimo", category: "SCHEMA_COLUMN", table: "productos", column: "stock_minimo" },
  { id: "COLUMN:productos.tipo", category: "SCHEMA_COLUMN", table: "productos", column: "tipo" },
  { id: "COLUMN:productos.ubicacion", category: "SCHEMA_COLUMN", table: "productos", column: "ubicacion" },
  { id: "COLUMN:productos.unidad_medida", category: "SCHEMA_COLUMN", table: "productos", column: "unidad_medida" },
  { id: "COLUMN:productos.usa_costos_varios", category: "SCHEMA_COLUMN", table: "productos", column: "usa_costos_varios" },
  { id: "COLUMN:productos.vencimiento", category: "SCHEMA_COLUMN", table: "productos", column: "vencimiento" },
  { id: "COLUMN:proveedores.categoria_especial", category: "SCHEMA_COLUMN", table: "proveedores", column: "categoria_especial" },
  { id: "COLUMN:proveedores.categoria_id", category: "SCHEMA_COLUMN", table: "proveedores", column: "categoria_id" },
  { id: "COLUMN:proveedores.codigo_postal", category: "SCHEMA_COLUMN", table: "proveedores", column: "codigo_postal" },
  { id: "COLUMN:proveedores.condicion_iva", category: "SCHEMA_COLUMN", table: "proveedores", column: "condicion_iva" },
  { id: "COLUMN:proveedores.contacto", category: "SCHEMA_COLUMN", table: "proveedores", column: "contacto" },
  { id: "COLUMN:proveedores.dia_vencimiento_fijo", category: "SCHEMA_COLUMN", table: "proveedores", column: "dia_vencimiento_fijo" },
  { id: "COLUMN:proveedores.dias_vencimiento", category: "SCHEMA_COLUMN", table: "proveedores", column: "dias_vencimiento" },
  { id: "COLUMN:proveedores.direccion", category: "SCHEMA_COLUMN", table: "proveedores", column: "direccion" },
  { id: "COLUMN:proveedores.email", category: "SCHEMA_COLUMN", table: "proveedores", column: "email" },
  { id: "COLUMN:proveedores.iva_alicuota", category: "SCHEMA_COLUMN", table: "proveedores", column: "iva_alicuota" },
  { id: "COLUMN:proveedores.limite_credito", category: "SCHEMA_COLUMN", table: "proveedores", column: "limite_credito" },
  { id: "COLUMN:proveedores.localidad", category: "SCHEMA_COLUMN", table: "proveedores", column: "localidad" },
  { id: "COLUMN:proveedores.maneja_cuenta_corriente", category: "SCHEMA_COLUMN", table: "proveedores", column: "maneja_cuenta_corriente" },
  { id: "COLUMN:proveedores.moneda", category: "SCHEMA_COLUMN", table: "proveedores", column: "moneda" },
  { id: "COLUMN:proveedores.tipo_comprobante", category: "SCHEMA_COLUMN", table: "proveedores", column: "tipo_comprobante" },
  { id: "COLUMN:proveedores.tipo_impacto", category: "SCHEMA_COLUMN", table: "proveedores", column: "tipo_impacto" },
  { id: "COLUMN:proveedores.tipo_persona", category: "SCHEMA_COLUMN", table: "proveedores", column: "tipo_persona" },
  { id: "COLUMN:sesiones.auth_mode", category: "SCHEMA_COLUMN", table: "sesiones", column: "auth_mode" },
  { id: "COLUMN:sesiones.central_id", category: "SCHEMA_COLUMN", table: "sesiones", column: "central_id" },
  { id: "COLUMN:sesiones.empresa_id", category: "SCHEMA_COLUMN", table: "sesiones", column: "empresa_id" },
  { id: "COLUMN:sesiones.membership_id", category: "SCHEMA_COLUMN", table: "sesiones", column: "membership_id" },
  { id: "COLUMN:tienda_pedidos.motivo_rechazo", category: "SCHEMA_COLUMN", table: "tienda_pedidos", column: "motivo_rechazo" },
  { id: "COLUMN:tipos_pago.cuotas_json", category: "SCHEMA_COLUMN", table: "tipos_pago", column: "cuotas_json" },
  { id: "COLUMN:tipos_pago.permite_cuotas", category: "SCHEMA_COLUMN", table: "tipos_pago", column: "permite_cuotas" },
  { id: "COLUMN:tipos_pago.porcentaje_recargo", category: "SCHEMA_COLUMN", table: "tipos_pago", column: "porcentaje_recargo" },
  { id: "COLUMN:tipos_pago.usa_recargo", category: "SCHEMA_COLUMN", table: "tipos_pago", column: "usa_recargo" },
  { id: "COLUMN:usuarios.actualizado_en", category: "SCHEMA_COLUMN", table: "usuarios", column: "actualizado_en" },
  { id: "COLUMN:usuarios.bloqueado_hasta", category: "SCHEMA_COLUMN", table: "usuarios", column: "bloqueado_hasta" },
  { id: "COLUMN:usuarios.creado_en", category: "SCHEMA_COLUMN", table: "usuarios", column: "creado_en" },
  { id: "COLUMN:usuarios.email", category: "SCHEMA_COLUMN", table: "usuarios", column: "email" },
  { id: "COLUMN:usuarios.foto_url", category: "SCHEMA_COLUMN", table: "usuarios", column: "foto_url" },
  { id: "COLUMN:usuarios.intentos_fallidos", category: "SCHEMA_COLUMN", table: "usuarios", column: "intentos_fallidos" },
  { id: "COLUMN:usuarios.telefono", category: "SCHEMA_COLUMN", table: "usuarios", column: "telefono" },
  { id: "COLUMN:usuarios.ultimo_acceso", category: "SCHEMA_COLUMN", table: "usuarios", column: "ultimo_acceso" },
  { id: "COLUMN:venta_cobros.cuenta_cobro_nombre_snapshot", category: "SCHEMA_COLUMN", table: "venta_cobros", column: "cuenta_cobro_nombre_snapshot" },
  { id: "COLUMN:venta_cobros.cuenta_cobro_tipo_pago_snapshot", category: "SCHEMA_COLUMN", table: "venta_cobros", column: "cuenta_cobro_tipo_pago_snapshot" },
  { id: "COLUMN:venta_cobros.cuenta_destino_id_snapshot", category: "SCHEMA_COLUMN", table: "venta_cobros", column: "cuenta_destino_id_snapshot" },
  { id: "COLUMN:venta_cobros.cuenta_destino_nombre_snapshot", category: "SCHEMA_COLUMN", table: "venta_cobros", column: "cuenta_destino_nombre_snapshot" },
  { id: "COLUMN:ventas.cuenta_cobro_id", category: "SCHEMA_COLUMN", table: "ventas", column: "cuenta_cobro_id" },
  { id: "COLUMN:ventas.recargo_monto", category: "SCHEMA_COLUMN", table: "ventas", column: "recargo_monto" },
  { id: "COLUMN:ventas.recargo_porcentaje", category: "SCHEMA_COLUMN", table: "ventas", column: "recargo_porcentaje" },
  { id: "COLUMN:ventas.total_venta_original", category: "SCHEMA_COLUMN", table: "ventas", column: "total_venta_original" }
];

const SCHEMA_INDEX_ENTRIES = [
  { id: "INDEX:idx_caja_arqueo_denominaciones_activa", category: "SCHEMA_INDEX", indexName: "idx_caja_arqueo_denominaciones_activa", table: "caja_arqueo_denominaciones", columns: ["denominacion"], unique: true, partial: true, predicate: "activo = 1" },
  { id: "INDEX:idx_caja_arqueo_denominaciones_orden", category: "SCHEMA_INDEX", indexName: "idx_caja_arqueo_denominaciones_orden", table: "caja_arqueo_denominaciones", columns: ["orden"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_caja_arqueos_modelo1_idempotency", category: "SCHEMA_INDEX", indexName: "idx_caja_arqueos_modelo1_idempotency", table: "caja_arqueos", columns: ["caja_id","idempotency_key"], unique: true, partial: true, predicate: "modelo_arqueo_version = 1 AND idempotency_key IS NOT NULL" },
  { id: "INDEX:idx_caja_movimientos_caja", category: "SCHEMA_INDEX", indexName: "idx_caja_movimientos_caja", table: "caja_movimientos", columns: ["caja_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_caja_traslados_arqueo", category: "SCHEMA_INDEX", indexName: "idx_caja_traslados_arqueo", table: "caja_traslados_internos", columns: ["arqueo_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_caja_traslados_arqueo_extraccion_activa", category: "SCHEMA_INDEX", indexName: "idx_caja_traslados_arqueo_extraccion_activa", table: "caja_traslados_internos", columns: ["arqueo_id","tipo"], unique: true, partial: true, predicate: "arqueo_id IS NOT NULL AND tipo = 'arqueo_extraccion' AND estado = 'activo'" },
  { id: "INDEX:idx_caja_traslados_caja", category: "SCHEMA_INDEX", indexName: "idx_caja_traslados_caja", table: "caja_traslados_internos", columns: ["caja_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_caja_traslados_destino", category: "SCHEMA_INDEX", indexName: "idx_caja_traslados_destino", table: "caja_traslados_internos", columns: ["cuenta_destino_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_caja_traslados_origen", category: "SCHEMA_INDEX", indexName: "idx_caja_traslados_origen", table: "caja_traslados_internos", columns: ["cuenta_origen_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_clientes_dni_cuit_unique", category: "SCHEMA_INDEX", indexName: "idx_clientes_dni_cuit_unique", table: "clientes", columns: ["dni_cuit"], unique: true, partial: true, acceptedPredicates: Object.freeze(["dni_cuit IS NOT NULL AND dni_cuit != ''","dni_cuit IS NOT NULL AND TRIM(dni_cuit) != ''"]) },
  { id: "INDEX:idx_compra_comprobante_iva_comprobante", category: "SCHEMA_INDEX", indexName: "idx_compra_comprobante_iva_comprobante", table: "compra_comprobante_iva", columns: ["comprobante_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_compra_comprobante_iva_unique", category: "SCHEMA_INDEX", indexName: "idx_compra_comprobante_iva_unique", table: "compra_comprobante_iva", columns: ["comprobante_id","alicuota"], unique: true, partial: false, predicate: null },
  { id: "INDEX:idx_compra_comprobantes_compra", category: "SCHEMA_INDEX", indexName: "idx_compra_comprobantes_compra", table: "compra_comprobantes", columns: ["compra_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_compra_items_compra", category: "SCHEMA_INDEX", indexName: "idx_compra_items_compra", table: "compra_items", columns: ["compra_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_compra_items_producto", category: "SCHEMA_INDEX", indexName: "idx_compra_items_producto", table: "compra_items", columns: ["producto_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_compra_recepcion_items_item", category: "SCHEMA_INDEX", indexName: "idx_compra_recepcion_items_item", table: "compra_recepcion_items", columns: ["compra_item_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_compra_recepcion_items_recepcion", category: "SCHEMA_INDEX", indexName: "idx_compra_recepcion_items_recepcion", table: "compra_recepcion_items", columns: ["recepcion_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_compra_recepciones_compra", category: "SCHEMA_INDEX", indexName: "idx_compra_recepciones_compra", table: "compra_recepciones", columns: ["compra_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_compra_recepciones_idempotency", category: "SCHEMA_INDEX", indexName: "idx_compra_recepciones_idempotency", table: "compra_recepciones", columns: ["compra_id","idempotency_key"], unique: true, partial: false, predicate: null },
  { id: "INDEX:idx_compras_proveedor_estado", category: "SCHEMA_INDEX", indexName: "idx_compras_proveedor_estado", table: "compras", columns: ["proveedor_id","estado"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_conciliaciones_cuentas_sin_cuenta", category: "SCHEMA_INDEX", indexName: "idx_conciliaciones_cuentas_sin_cuenta", table: "conciliaciones_cuentas_cobro", columns: ["caja_id"], unique: true, partial: true, predicate: "cuenta_cobro_id IS NULL" },
  { id: "INDEX:idx_conciliaciones_destino_sin_cuenta", category: "SCHEMA_INDEX", indexName: "idx_conciliaciones_destino_sin_cuenta", table: "conciliaciones_cuentas_destino", columns: ["caja_id"], unique: true, partial: true, predicate: "cuenta_destino_id IS NULL" },
  { id: "INDEX:idx_detalle_venta_componentes_snapshot_detalle", category: "SCHEMA_INDEX", indexName: "idx_detalle_venta_componentes_snapshot_detalle", table: "detalle_venta_componentes_snapshot", columns: ["detalle_venta_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_detalle_venta_modificadores_detalle", category: "SCHEMA_INDEX", indexName: "idx_detalle_venta_modificadores_detalle", table: "detalle_venta_modificadores", columns: ["detalle_venta_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_detalle_ventas_venta", category: "SCHEMA_INDEX", indexName: "idx_detalle_ventas_venta", table: "detalle_ventas", columns: ["venta_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_dvrs_componente", category: "SCHEMA_INDEX", indexName: "idx_dvrs_componente", table: "detalle_venta_receta_snapshot", columns: ["componente_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_dvrs_detalle", category: "SCHEMA_INDEX", indexName: "idx_dvrs_detalle", table: "detalle_venta_receta_snapshot", columns: ["detalle_venta_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_dvrs_venta", category: "SCHEMA_INDEX", indexName: "idx_dvrs_venta", table: "detalle_venta_receta_snapshot", columns: ["venta_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_movimientos_stock_manual_idempotency", category: "SCHEMA_INDEX", indexName: "idx_movimientos_stock_manual_idempotency", table: "movimientos_stock", columns: ["origen_tipo","idempotency_key"], unique: true, partial: true, predicate: "idempotency_key IS NOT NULL AND idempotency_key != ''" },
  { id: "INDEX:idx_movimientos_stock_origen", category: "SCHEMA_INDEX", indexName: "idx_movimientos_stock_origen", table: "movimientos_stock", columns: ["origen_tipo","origen_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_movimientos_stock_producto", category: "SCHEMA_INDEX", indexName: "idx_movimientos_stock_producto", table: "movimientos_stock", columns: ["producto_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_movimientos_stock_reversa", category: "SCHEMA_INDEX", indexName: "idx_movimientos_stock_reversa", table: "movimientos_stock", columns: ["movimiento_stock_reversa_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_mp_intentos_estado", category: "SCHEMA_INDEX", indexName: "idx_mp_intentos_estado", table: "mercado_pago_intentos", columns: ["estado"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_mp_intentos_external_reference", category: "SCHEMA_INDEX", indexName: "idx_mp_intentos_external_reference", table: "mercado_pago_intentos", columns: ["external_reference"], unique: true, partial: false, predicate: null },
  { id: "INDEX:idx_mp_intentos_idempotency_key", category: "SCHEMA_INDEX", indexName: "idx_mp_intentos_idempotency_key", table: "mercado_pago_intentos", columns: ["idempotency_key"], unique: true, partial: false, predicate: null },
  { id: "INDEX:idx_mp_intentos_venta", category: "SCHEMA_INDEX", indexName: "idx_mp_intentos_venta", table: "mercado_pago_intentos", columns: ["venta_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_pagos_compra", category: "SCHEMA_INDEX", indexName: "idx_pagos_compra", table: "pagos", columns: ["compra_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_piv_producto", category: "SCHEMA_INDEX", indexName: "idx_piv_producto", table: "producto_ingredientes_visibles", columns: ["producto_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_producto_modificadores_producto", category: "SCHEMA_INDEX", indexName: "idx_producto_modificadores_producto", table: "producto_modificadores", columns: ["producto_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_producto_revisiones_pendientes_estado", category: "SCHEMA_INDEX", indexName: "idx_producto_revisiones_pendientes_estado", table: "producto_revisiones_pendientes", columns: ["estado"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_producto_revisiones_pendientes_producto", category: "SCHEMA_INDEX", indexName: "idx_producto_revisiones_pendientes_producto", table: "producto_revisiones_pendientes", columns: ["producto_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_productos_activo", category: "SCHEMA_INDEX", indexName: "idx_productos_activo", table: "productos", columns: ["activo"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_productos_codigo_unique", category: "SCHEMA_INDEX", indexName: "idx_productos_codigo_unique", table: "productos", columns: ["codigo"], unique: true, partial: true, predicate: "codigo IS NOT NULL AND codigo != '' AND eliminado = 0" },
  { id: "INDEX:idx_stock_ajustes_pendientes_caja", category: "SCHEMA_INDEX", indexName: "idx_stock_ajustes_pendientes_caja", table: "stock_ajustes_pendientes", columns: ["caja_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_stock_ajustes_pendientes_estado", category: "SCHEMA_INDEX", indexName: "idx_stock_ajustes_pendientes_estado", table: "stock_ajustes_pendientes", columns: ["estado"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_stock_ajustes_pendientes_producto", category: "SCHEMA_INDEX", indexName: "idx_stock_ajustes_pendientes_producto", table: "stock_ajustes_pendientes", columns: ["producto_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_stock_ajustes_pendientes_venta_origen", category: "SCHEMA_INDEX", indexName: "idx_stock_ajustes_pendientes_venta_origen", table: "stock_ajustes_pendientes", columns: ["venta_id","origen"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_usuarios_usuario", category: "SCHEMA_INDEX", indexName: "idx_usuarios_usuario", table: "usuarios", columns: ["usuario"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_venta_cobros_cuenta", category: "SCHEMA_INDEX", indexName: "idx_venta_cobros_cuenta", table: "venta_cobros", columns: ["cuenta_cobro_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_venta_cobros_venta", category: "SCHEMA_INDEX", indexName: "idx_venta_cobros_venta", table: "venta_cobros", columns: ["venta_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_ventas_caja", category: "SCHEMA_INDEX", indexName: "idx_ventas_caja", table: "ventas", columns: ["caja_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_ventas_cliente", category: "SCHEMA_INDEX", indexName: "idx_ventas_cliente", table: "ventas", columns: ["cliente_id"], unique: false, partial: false, predicate: null },
  { id: "INDEX:idx_ventas_estado", category: "SCHEMA_INDEX", indexName: "idx_ventas_estado", table: "ventas", columns: ["estado"], unique: false, partial: false, predicate: null }
];

const DATA_ENTRIES = [
  { id: "DATA:BASELINE_LEGACY_ROLES_PENDING_USUARIOS", category: "DATA_MIGRATION_COMPLETE", code: "BASELINE_LEGACY_ROLES_PENDING_USUARIOS", resource: "usuarios.rol", description: "Hay usuarios con roles legacy (operador/caja/cajero) sin migrar.", sql: "SELECT COUNT(*) AS c FROM usuarios WHERE rol IN ('operador','caja','cajero')" },
  { id: "DATA:BASELINE_LEGACY_ROLES_PENDING_SESIONES", category: "DATA_MIGRATION_COMPLETE", code: "BASELINE_LEGACY_ROLES_PENDING_SESIONES", resource: "sesiones.rol", description: "Hay sesiones con roles legacy (operador/caja/cajero) sin migrar.", sql: "SELECT COUNT(*) AS c FROM sesiones WHERE rol IN ('operador','caja','cajero')" },
  { id: "DATA:BASELINE_STOCK_PROVENANCE_COMPRA_PENDING", category: "DATA_MIGRATION_COMPLETE", code: "BASELINE_STOCK_PROVENANCE_COMPRA_PENDING", resource: "movimientos_stock.origen_tipo", description: "Hay movimientos de stock de recepción de compra sin origen_tipo asignado.", sql: "SELECT COUNT(*) AS c FROM movimientos_stock WHERE origen_tipo IS NULL AND EXISTS (SELECT 1 FROM compra_recepcion_items cri WHERE cri.movimiento_stock_id = movimientos_stock.id)" },
  { id: "DATA:BASELINE_STOCK_PROVENANCE_REVERSA_PENDING", category: "DATA_MIGRATION_COMPLETE", code: "BASELINE_STOCK_PROVENANCE_REVERSA_PENDING", resource: "movimientos_stock.origen_tipo", description: "Hay movimientos de stock de reversa de recepción sin origen_tipo asignado.", sql: "SELECT COUNT(*) AS c FROM movimientos_stock WHERE origen_tipo IS NULL AND EXISTS (SELECT 1 FROM compra_recepcion_items cri WHERE cri.movimiento_stock_reversa_id = movimientos_stock.id)" },
  { id: "DATA:BASELINE_PRODUCTO_COMPUESTO_STOCK_PENDING", category: "DATA_NORMALIZATION_COMPLETE", code: "BASELINE_PRODUCTO_COMPUESTO_STOCK_PENDING", resource: "productos.stock", description: "Hay productos compuestos sin manejo de stock con campos de stock sin normalizar.", sql: "SELECT COUNT(*) AS c FROM productos WHERE tipo='compuesto' AND maneja_stock=0 AND (stock != 0 OR stock_minimo != 0 OR alerta_stock_minimo != 0)" },
  { id: "DATA:BASELINE_PRODUCTO_PROVEEDOR_PENDING", category: "DATA_NORMALIZATION_COMPLETE", code: "BASELINE_PRODUCTO_PROVEEDOR_PENDING", resource: "producto_proveedores", description: "Hay productos con proveedor_id sin su vínculo correspondiente en producto_proveedores.", sql: "SELECT COUNT(*) AS c FROM productos p WHERE p.proveedor_id IS NOT NULL AND p.proveedor_id > 0 AND NOT EXISTS (SELECT 1 FROM producto_proveedores pp WHERE pp.producto_id = p.id AND pp.proveedor_id = p.proveedor_id)" },
  { id: "DATA:BASELINE_VENTA_COBROS_SNAPSHOT_PENDING", category: "DATA_MIGRATION_COMPLETE", code: "BASELINE_VENTA_COBROS_SNAPSHOT_PENDING", resource: "venta_cobros.cuenta_cobro_nombre_snapshot", description: "Hay filas de venta_cobros con cuenta de cobro sin snapshot de nombre.", sql: "SELECT COUNT(*) AS c FROM venta_cobros WHERE cuenta_cobro_nombre_snapshot IS NULL AND cuenta_cobro_id IS NOT NULL AND EXISTS (SELECT 1 FROM cuentas_cobro cc WHERE cc.id = venta_cobros.cuenta_cobro_id)" },
  { id: "DATA:BASELINE_PAGOS_CC_COBROS_SNAPSHOT_PENDING", category: "DATA_MIGRATION_COMPLETE", code: "BASELINE_PAGOS_CC_COBROS_SNAPSHOT_PENDING", resource: "pagos_cc_cobros.cuenta_cobro_nombre_snapshot", description: "Hay filas de pagos_cc_cobros con cuenta de cobro sin snapshot de nombre.", sql: "SELECT COUNT(*) AS c FROM pagos_cc_cobros WHERE cuenta_cobro_nombre_snapshot IS NULL AND cuenta_cobro_id IS NOT NULL AND EXISTS (SELECT 1 FROM cuentas_cobro cc WHERE cc.id = pagos_cc_cobros.cuenta_cobro_id)" },
  { id: "DATA:BASELINE_VENTA_COBROS_MIGRATION_PENDING", category: "DATA_MIGRATION_COMPLETE", code: "BASELINE_VENTA_COBROS_MIGRATION_PENDING", resource: "venta_cobros", description: "Hay ventas cobradas con tipo_cobro legacy sin su fila correspondiente en venta_cobros.", sql: "SELECT COUNT(*) AS c FROM ventas v WHERE v.estado='cobrada' AND LOWER(COALESCE(v.tipo_cobro,'')) != '' AND NOT EXISTS (SELECT 1 FROM venta_cobros vc WHERE vc.venta_id = v.id)" },
  { id: "DATA:BASELINE_COMPONENT_DUPLICATES_PENDING", category: "DATA_NORMALIZATION_COMPLETE", code: "BASELINE_COMPONENT_DUPLICATES_PENDING", resource: "producto_componentes", description: "Hay pares producto_compuesto_id/producto_id duplicados sin consolidar en producto_componentes.", sql: "SELECT COUNT(*) AS c FROM (SELECT producto_compuesto_id, producto_id FROM producto_componentes GROUP BY producto_compuesto_id, producto_id HAVING COUNT(*) > 1)" }
];

const DEFAULT_ENTRIES = [
  { id: "DEFAULT:DENOMINACIONES", category: "REQUIRED_RUNTIME_DEFAULT", family: "DENOMINACIONES", table: "caja_arqueo_denominaciones", identityExpr: "denominacion", resourcePrefix: "denominacion", canonicalValues: [10,20,50,100,200,500,1000,2000,10000,20000], description: "Falta la denominación canónica de arqueo de caja requerida por el baseline legacy." },
  { id: "DEFAULT:TIPOS_PAGO", category: "REQUIRED_RUNTIME_DEFAULT", family: "TIPOS_PAGO", table: "tipos_pago", identityExpr: "codigo", resourcePrefix: "tipo_pago", canonicalValues: ["efectivo","debito","transferencia","mixto"], description: "Falta el tipo de pago canónico requerido por el baseline legacy." },
  { id: "DEFAULT:CUENTAS_DESTINO", category: "REQUIRED_RUNTIME_DEFAULT", family: "CUENTAS_DESTINO", table: "cuentas_destino", identityExpr: "lower(nombre)", resourcePrefix: "cuenta_destino", canonicalValues: ["caja efectivo","mercado pago"], description: "Falta la cuenta destino canónica requerida por el baseline legacy." }
];

const LEGACY_BASELINE_INVARIANTS = deepFreeze([
  ...SCHEMA_TABLE_ENTRIES,
  ...SCHEMA_COLUMN_ENTRIES,
  ...SCHEMA_INDEX_ENTRIES,
  ...DATA_ENTRIES,
  ...DEFAULT_ENTRIES
]);

function allQuery(db, sql) {
  return new Promise((resolve, reject) => {
    db.all(sql, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function normalizarPredicado(texto) {
  const match = /\bWHERE\b([\s\S]*)$/i.exec(texto);
  if (!match) return null;
  return match[1].replace(/\s+/g, " ").trim();
}

function normalizarEsperado(texto) {
  if (texto === null || texto === undefined) return null;
  return String(texto).replace(/\s+/g, " ").trim();
}

async function evaluarTablasYColumnas(db, failures) {
  const tablasNecesarias = new Set([
    ...SCHEMA_TABLE_ENTRIES.map((e) => e.table),
    ...SCHEMA_COLUMN_ENTRIES.map((e) => e.table)
  ]);
  const columnasPorTabla = new Map();
  for (const tabla of tablasNecesarias) {
    try {
      const filas = await allQuery(db, `PRAGMA table_info(${tabla})`);
      columnasPorTabla.set(tabla, new Set(filas.map((f) => f.name)));
    } catch (error) {
      columnasPorTabla.set(tabla, new Set());
    }
  }

  const tablasFaltantes = new Set();
  for (const entry of SCHEMA_TABLE_ENTRIES) {
    const columnas = columnasPorTabla.get(entry.table);
    if (!columnas || columnas.size === 0) {
      tablasFaltantes.add(entry.table);
      failures.push({
        code: "BASELINE_TABLE_MISSING",
        category: "SCHEMA_TABLE",
        resource: entry.table,
        description: `Falta la tabla ${entry.table} requerida por el baseline legacy.`
      });
    }
  }

  for (const entry of SCHEMA_COLUMN_ENTRIES) {
    const columnas = columnasPorTabla.get(entry.table);
    if (!columnas || !columnas.has(entry.column)) {
      failures.push({
        code: "BASELINE_COLUMN_MISSING",
        category: "SCHEMA_COLUMN",
        resource: `${entry.table}.${entry.column}`,
        description: `Falta la columna ${entry.table}.${entry.column} requerida por el baseline legacy.`
      });
    }
  }

  return tablasFaltantes;
}

async function evaluarIndices(db, failures) {
  const tablasDeIndices = new Set(SCHEMA_INDEX_ENTRIES.map((e) => e.table));
  const indicesPorTabla = new Map();
  for (const tabla of tablasDeIndices) {
    try {
      const filas = await allQuery(db, `PRAGMA index_list(${tabla})`);
      indicesPorTabla.set(tabla, filas);
    } catch (error) {
      indicesPorTabla.set(tabla, []);
    }
  }

  for (const entry of SCHEMA_INDEX_ENTRIES) {
    const listaIndices = indicesPorTabla.get(entry.table) || [];
    const filaIndice = listaIndices.find((f) => f.name === entry.indexName);

    if (!filaIndice) {
      failures.push({
        code: "BASELINE_INDEX_MISSING",
        category: "SCHEMA_INDEX",
        resource: entry.indexName,
        description: `Falta el índice ${entry.indexName} requerido por el baseline legacy.`
      });
      continue;
    }

    let mismatch = false;

    const esUnique = !!filaIndice.unique;
    const esPartial = !!filaIndice.partial;
    if (esUnique !== entry.unique || esPartial !== entry.partial) {
      mismatch = true;
    }

    let columnasReales = [];
    if (!mismatch) {
      try {
        const infoFilas = await allQuery(db, `PRAGMA index_info(${entry.indexName})`);
        columnasReales = infoFilas
          .slice()
          .sort((a, b) => a.seqno - b.seqno)
          .map((f) => f.name);
      } catch (error) {
        mismatch = true;
      }
      if (!mismatch) {
        if (columnasReales.length !== entry.columns.length) {
          mismatch = true;
        } else {
          for (let i = 0; i < columnasReales.length; i++) {
            if (columnasReales[i] !== entry.columns[i]) {
              mismatch = true;
              break;
            }
          }
        }
      }
    }

    if (!mismatch && entry.partial) {
      try {
        const masterFilas = await allQuery(
          db,
          `SELECT sql FROM sqlite_master WHERE type='index' AND name='${entry.indexName}'`
        );
        const sqlReal = masterFilas.length ? masterFilas[0].sql : "";
        const predicadoReal = normalizarPredicado(sqlReal || "");
        if (Array.isArray(entry.acceptedPredicates)) {
          const aceptados = entry.acceptedPredicates.map((p) => normalizarEsperado(p));
          if (!aceptados.includes(predicadoReal)) {
            mismatch = true;
          }
        } else {
          const predicadoEsperado = normalizarEsperado(entry.predicate);
          if (predicadoReal !== predicadoEsperado) {
            mismatch = true;
          }
        }
      } catch (error) {
        mismatch = true;
      }
    }

    if (mismatch) {
      failures.push({
        code: "BASELINE_INDEX_MISMATCH",
        category: "SCHEMA_INDEX",
        resource: entry.indexName,
        description: `El índice ${entry.indexName} existe pero su contrato (columnas, unique, partial o predicado) no coincide con el baseline legacy.`
      });
    }
  }
}

async function evaluarDatos(db, failures) {
  for (const entry of DATA_ENTRIES) {
    try {
      const filas = await allQuery(db, entry.sql);
      const pendientes = filas && filas.length ? Number(filas[0].c) : 0;
      if (pendientes > 0) {
        failures.push({
          code: entry.code,
          category: entry.category,
          resource: entry.resource,
          description: entry.description
        });
      }
    } catch (error) {
      // Estructura ausente ya reportada como SCHEMA_TABLE/SCHEMA_COLUMN failure; se omite este check dependiente.
    }
  }
}

async function evaluarDefaults(db, failures) {
  for (const entry of DEFAULT_ENTRIES) {
    try {
      const filas = await allQuery(db, `SELECT ${entry.identityExpr} AS clave FROM ${entry.table}`);
      const presentes = new Set(filas.map((f) => f.clave));
      for (const valorCanonico of entry.canonicalValues) {
        if (!presentes.has(valorCanonico)) {
          failures.push({
            code: "BASELINE_DEFAULT_MISSING",
            category: "REQUIRED_RUNTIME_DEFAULT",
            resource: `${entry.resourcePrefix}:${valorCanonico}`,
            description: entry.description
          });
        }
      }
    } catch (error) {
      // Tabla de defaults ausente ya reportada como SCHEMA_TABLE failure; se omite este check dependiente.
    }
  }
}

function abrirSoloLectura(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(db);
    });
  });
}

function cerrarDb(db) {
  return new Promise((resolve) => {
    if (!db) {
      resolve();
      return;
    }
    db.close(() => resolve());
  });
}

// MT-1E2C2A: evaluacion pura sobre una conexion YA ABIERTA por el caller. No abre, no cierra,
// no inicia transaccion, no escribe -- deja la conexion exactamente como la recibio, usable
// despues de retornar. Es la MISMA logica (evaluarTablasYColumnas/evaluarIndices/evaluarDatos/
// evaluarDefaults sobre LEGACY_BASELINE_INVARIANTS) que ejecutarVerificacion ya corria entre su
// open y su close; se extrae para que MT-1E2C2B pueda invocarla dentro de un BEGIN IMMEDIATE
// sobre la misma business DB connection, sin abrir una segunda conexion como autoridad final.
async function verificarLegacyBaselineEnConexion(db) {
  const failures = [];
  await evaluarTablasYColumnas(db, failures);
  await evaluarIndices(db, failures);
  await evaluarDatos(db, failures);
  await evaluarDefaults(db, failures);
  return { ready: failures.length === 0, failures };
}

async function ejecutarVerificacion(dbPath) {
  if (!fs.existsSync(dbPath)) {
    return {
      ready: false,
      failures: [
        {
          code: "DB_NOT_FOUND",
          category: "TARGET",
          resource: "business_db",
          description: "La base de datos de negocio no existe."
        }
      ]
    };
  }

  let db;
  try {
    db = await abrirSoloLectura(dbPath);
    await allQuery(db, "PRAGMA schema_version");
  } catch (error) {
    await cerrarDb(db);
    return {
      ready: false,
      failures: [
        {
          code: "DB_ERROR",
          category: "TARGET",
          resource: "business_db",
          description: "No se pudo leer la base de datos de negocio como SQLite."
        }
      ]
    };
  }

  try {
    return await verificarLegacyBaselineEnConexion(db);
  } finally {
    await cerrarDb(db);
  }
}

function verificarLegacyBaseline(dbPath) {
  if (typeof dbPath !== "string" || dbPath.trim() === "") {
    const error = new Error("dbPath debe ser un string no vacío.");
    error.code = "INVALID_ARGUMENT";
    throw error;
  }
  return ejecutarVerificacion(dbPath);
}

module.exports = {
  LEGACY_BASELINE_INVARIANTS,
  verificarLegacyBaseline,
  verificarLegacyBaselineEnConexion
};
