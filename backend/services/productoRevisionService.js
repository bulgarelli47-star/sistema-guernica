const { allQuery, getQuery, runQuery } = require("../db");

const MONTO_TOLERANCIA = 0.01;
const ESTADOS_VALIDOS = new Set(["pendiente", "aprobada", "rechazada"]);

function round2(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero)) return 0;
  return Math.round((numero + Number.EPSILON) * 100) / 100;
}

function normalizarTexto(valor) {
  return String(valor || "").trim();
}

function crearError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function esConstraintUnica(error) {
  return !!error && (error.code === "SQLITE_CONSTRAINT" || /UNIQUE constraint failed/i.test(error.message || ""));
}

function getFechaHoy() {
  return new Date().toISOString().slice(0, 10);
}

function mapRevision(row) {
  if (!row) return null;
  return {
    ...row,
    producto_id: Number(row.producto_id),
    proveedor_id: Number(row.proveedor_id),
    compra_id: Number(row.compra_id),
    compra_item_id: Number(row.compra_item_id),
    comprobante_id: row.comprobante_id === null || row.comprobante_id === undefined ? null : Number(row.comprobante_id),
    valor_actual: Number(row.valor_actual || 0),
    valor_propuesto: Number(row.valor_propuesto || 0)
  };
}

// Se invoca dentro de la MISMA transaccion que ya abrio POST /compras/:id/comprobantes,
// una vez persistido el comprobante. Compara compra_items.costo_unitario (evidencia de
// factura) contra producto_proveedores.precio_compra (costo vigente configurado) para cada
// item con producto de la Compra. Si difieren mas alla de la tolerancia monetaria, propone
// una revision pendiente -- nunca actualiza nada por si sola, nunca mueve stock, nunca crea
// la relacion producto-proveedor si no existe. Idempotente: como maximo una revision de
// tipo_revision=costo_proveedor por compra_item_id (UNIQUE en DB + chequeo previo).
async function generarRevisionesPendientesCostoProveedor(
  compraId,
  proveedorId,
  comprobanteId,
  usuario,
  { getQuery: get, runQuery: run, allQuery: all }
) {
  const items = await all(
    "SELECT id, producto_id, costo_unitario FROM compra_items WHERE compra_id = ? AND producto_id IS NOT NULL",
    [compraId]
  );
  const creadas = [];
  for (const item of items) {
    const relacion = await get(
      `SELECT id, precio_compra FROM producto_proveedores
       WHERE producto_id = ? AND proveedor_id = ?
       ORDER BY es_principal DESC, id DESC
       LIMIT 1`,
      [item.producto_id, proveedorId]
    );
    if (!relacion) continue; // sin relacion producto-proveedor: no crearla, sin revision accionable (V1)

    const valorActual = round2(relacion.precio_compra);
    const valorPropuesto = round2(item.costo_unitario);
    if (Math.abs(valorActual - valorPropuesto) <= MONTO_TOLERANCIA) continue; // sin diferencia real

    const existente = await get(
      "SELECT id FROM producto_revisiones_pendientes WHERE tipo_revision = 'costo_proveedor' AND compra_item_id = ?",
      [item.id]
    );
    if (existente) continue; // replay / segundo comprobante sobre la misma evidencia: no duplicar

    try {
      const result = await run(
        `INSERT INTO producto_revisiones_pendientes
         (tipo_revision, estado, producto_id, proveedor_id, compra_id, compra_item_id, comprobante_id,
          valor_actual, valor_propuesto, creado_at, creado_por)
         VALUES ('costo_proveedor', 'pendiente', ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
        [
          item.producto_id,
          proveedorId,
          compraId,
          item.id,
          comprobanteId,
          valorActual,
          valorPropuesto,
          normalizarTexto(usuario) || "admin"
        ]
      );
      creadas.push(result.lastID);
    } catch (error) {
      if (!esConstraintUnica(error)) throw error;
      // Defensa en profundidad: la restriccion UNIQUE(tipo_revision, compra_item_id) ya
      // evito la duplicacion aunque el chequeo previo no la haya detectado (carrera).
    }
  }
  return creadas;
}

async function listarRevisionesPendientesCostoProveedor({ estado } = {}) {
  const estadoNormalizado = normalizarTexto(estado).toLowerCase();
  const where = ["prp.tipo_revision = 'costo_proveedor'"];
  const params = [];
  if (ESTADOS_VALIDOS.has(estadoNormalizado)) {
    where.push("prp.estado = ?");
    params.push(estadoNormalizado);
  }
  const rows = await allQuery(
    `SELECT prp.*, p.nombre AS producto_nombre, pr.nombre AS proveedor_nombre
     FROM producto_revisiones_pendientes prp
     LEFT JOIN productos p ON p.id = prp.producto_id
     LEFT JOIN proveedores pr ON pr.id = prp.proveedor_id
     WHERE ${where.join(" AND ")}
     ORDER BY prp.id DESC`,
    params
  );
  return rows.map(mapRevision);
}

async function obtenerRevisionPendiente(id) {
  const row = await getQuery("SELECT * FROM producto_revisiones_pendientes WHERE id = ?", [Number(id)]);
  return mapRevision(row);
}

// Aprobar: unica operacion que efectivamente actualiza producto_proveedores.precio_compra.
// Nunca mueve stock, nunca crea movimientos_stock, nunca toca Caja/pagos/compra_items/
// comprobante/precio de venta. Bloquea si la Compra esta anulada, si ya no tiene ningun
// comprobante activo, o si el costo vigente cambio desde que nacio la revision (evita
// decidir sobre informacion obsoleta).
async function aprobarRevisionPendienteCostoProveedor(id, { usuario } = {}) {
  const revisionId = Number(id);
  await runQuery("BEGIN TRANSACTION");
  try {
    const revision = await getQuery("SELECT * FROM producto_revisiones_pendientes WHERE id = ?", [revisionId]);
    if (!revision) throw crearError("Revision pendiente no encontrada", 404);
    if (revision.tipo_revision !== "costo_proveedor") throw crearError("Tipo de revision invalido", 400);
    if (revision.estado !== "pendiente") throw crearError("La revision ya fue resuelta", 409);

    const compra = await getQuery("SELECT id, estado FROM compras WHERE id = ?", [revision.compra_id]);
    if (!compra) throw crearError("La compra de esta revision ya no existe", 404);
    if (String(compra.estado || "").toLowerCase() === "anulada") {
      throw crearError("La compra esta anulada: la revision ya no es accionable", 409);
    }

    const comprobanteActivo = await getQuery(
      "SELECT id FROM compra_comprobantes WHERE compra_id = ? AND estado = 'registrado' LIMIT 1",
      [revision.compra_id]
    );
    if (!comprobanteActivo) {
      throw crearError("La compra ya no tiene ningun comprobante activo: la revision ya no es accionable", 409);
    }

    const relacion = await getQuery(
      "SELECT id, precio_compra FROM producto_proveedores WHERE producto_id = ? AND proveedor_id = ?",
      [revision.producto_id, revision.proveedor_id]
    );
    if (!relacion) throw crearError("La relacion producto-proveedor de esta revision ya no existe", 409);

    const vigente = round2(relacion.precio_compra);
    const snapshotActual = round2(revision.valor_actual);
    if (Math.abs(vigente - snapshotActual) > MONTO_TOLERANCIA) {
      throw crearError("El costo vigente cambio desde que se genero la revision", 409);
    }

    await runQuery(
      "UPDATE producto_proveedores SET precio_compra = ?, fecha_actualizacion = ? WHERE id = ?",
      [round2(revision.valor_propuesto), getFechaHoy(), relacion.id]
    );

    await runQuery(
      `UPDATE producto_revisiones_pendientes
       SET estado = 'aprobada', decision = 'aprobada', revisado_at = datetime('now'), revisado_por = ?
       WHERE id = ? AND estado = 'pendiente'`,
      [normalizarTexto(usuario) || "admin", revisionId]
    );

    await runQuery("COMMIT");
    return obtenerRevisionPendiente(revisionId);
  } catch (error) {
    try {
      await runQuery("ROLLBACK");
    } catch {}
    throw error;
  }
}

// Rechazar: nunca toca producto_proveedores. Se permite incluso si la Compra fue anulada o
// perdio su comprobante activo (rechazar no tiene efecto colateral economico, sirve para
// limpiar revisiones que ya no aplican).
async function rechazarRevisionPendienteCostoProveedor(id, { usuario } = {}) {
  const revisionId = Number(id);
  await runQuery("BEGIN TRANSACTION");
  try {
    const revision = await getQuery("SELECT * FROM producto_revisiones_pendientes WHERE id = ?", [revisionId]);
    if (!revision) throw crearError("Revision pendiente no encontrada", 404);
    if (revision.tipo_revision !== "costo_proveedor") throw crearError("Tipo de revision invalido", 400);
    if (revision.estado !== "pendiente") throw crearError("La revision ya fue resuelta", 409);

    await runQuery(
      `UPDATE producto_revisiones_pendientes
       SET estado = 'rechazada', decision = 'rechazada', revisado_at = datetime('now'), revisado_por = ?
       WHERE id = ? AND estado = 'pendiente'`,
      [normalizarTexto(usuario) || "admin", revisionId]
    );

    await runQuery("COMMIT");
    return obtenerRevisionPendiente(revisionId);
  } catch (error) {
    try {
      await runQuery("ROLLBACK");
    } catch {}
    throw error;
  }
}

module.exports = {
  generarRevisionesPendientesCostoProveedor,
  listarRevisionesPendientesCostoProveedor,
  obtenerRevisionPendiente,
  aprobarRevisionPendienteCostoProveedor,
  rechazarRevisionPendienteCostoProveedor
};
