'use strict';

const { createHash } = require('node:crypto');
const { AsyncResource } = require('node:async_hooks');
const { getTenantHandle } = require('../tenantRequestContext');
const coordinator = require('../tenantWriteCoordinator');

function fail(code) { throw Object.assign(new Error(code), { code }); }
function positiveId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('CC_OPERATION_INVALID_ID');
  return value;
}
function validateKey(key) {
  if (typeof key !== 'string' || key.trim() !== key || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(key)) fail('CC_OPERATION_INVALID_KEY');
  return key;
}
function object(value, keys) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).some(k => !keys.includes(k)) || Object.getOwnPropertySymbols(value).length ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !('value' in d))) fail('CC_OPERATION_INVALID_PAYLOAD');
}
// Deliberately conservative: preserve representation and order. No rounding, coercion,
// sorting of allocations/channels, monetary aliases, or inference of missing amounts.
function money(value, allowZero = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0) ||
      Object.is(value, -0) || !Number.isSafeInteger(Math.round(value * 100)) ||
      !/^\d+(?:\.\d{1,2})?$/.test(String(value))) fail('CC_OPERATION_INVALID_MONEY');
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function normalizeIntent(input) {
  object(input, ['key', 'type', 'targetId', 'version', 'payload']);
  validateKey(input.key); positiveId(input.targetId);
  if (input.version !== 1 || !['VENTA', 'CLIENTE'].includes(input.type)) fail('CC_OPERATION_INVALID_CONTRACT');
  const p = input.payload;
  if (input.type === 'VENTA') {
    object(p, ['monto_pagado', 'tipo_cobro', 'monto_efectivo', 'monto_debito']);
    money(p.monto_pagado);
    // resolveCobroData also accepts named non-cash channels beyond its special cases.
    if (typeof p.tipo_cobro !== 'string' || !p.tipo_cobro || p.tipo_cobro !== p.tipo_cobro.trim().toLowerCase()) fail('CC_OPERATION_INVALID_CHANNEL');
    for (const k of ['monto_efectivo', 'monto_debito']) if (Object.hasOwn(p, k)) money(p[k], true);
    if (p.tipo_cobro === 'mixto' && (!Object.hasOwn(p, 'monto_efectivo') || !Object.hasOwn(p, 'monto_debito'))) fail('CC_OPERATION_INVALID_PAYLOAD');
  } else {
    object(p, ['cobros', 'ventas', 'observacion']);
    if (!Array.isArray(p.cobros) || !p.cobros.length) fail('CC_OPERATION_INVALID_PAYLOAD');
    for (const c of p.cobros) {
      object(c, ['tipo_cobro', 'monto', 'cuenta_cobro_id']);
      if (!['efectivo', 'debito', 'credito', 'transferencia', 'qr'].includes(c.tipo_cobro)) fail('CC_OPERATION_INVALID_CHANNEL');
      money(c.monto);
      if (Object.hasOwn(c, 'cuenta_cobro_id') && c.cuenta_cobro_id !== null) positiveId(c.cuenta_cobro_id);
    }
    if (Object.hasOwn(p, 'ventas')) {
      if (!Array.isArray(p.ventas) || !p.ventas.length) fail('CC_OPERATION_INVALID_PAYLOAD');
      const ids = new Set();
      for (const v of p.ventas) {
        object(v, ['venta_id', 'monto']); positiveId(v.venta_id); money(v.monto);
        if (ids.has(v.venta_id)) fail('CC_OPERATION_INVALID_PAYLOAD'); ids.add(v.venta_id);
      }
    }
    if (Object.hasOwn(p, 'observacion') && p.observacion !== null && typeof p.observacion !== 'string') fail('CC_OPERATION_INVALID_PAYLOAD');
  }
  const json = canonical({ type: input.type, targetId: input.targetId, version: input.version, payload: p });
  return Object.freeze({ key: input.key, type: input.type, targetId: input.targetId, version: 1,
    json, fingerprint: createHash('sha256').update(json, 'utf8').digest('hex') });
}

// No connection creation, fallback, migrations, HTTP, or financial writes. Caller must
// provide the registry-verified frozen handle in the existing operation/tenant ALS.
function createCcPaymentIdempotency(handle) {
  function tenant() {
    if (!handle || !Object.isFrozen(handle) || getTenantHandle() !== handle ||
        !Number.isSafeInteger(handle.empresaId) || handle.empresaId <= 0 || !handle.db) fail('CC_TENANT_REQUIRED');
  }
  tenant();
  function operation(transaction) {
    tenant();
    const op = coordinator.obtenerOperacionActual();
    if (!op) fail('CC_OPERATION_CONTEXT_REQUIRED');
    const gate = coordinator.diagnosticoPuerta(handle.db);
    if (gate.recuperacionPendiente || (transaction && (gate.owner !== op.id || gate.modo !== coordinator.MODOS_PUERTA.TX))) fail('CC_OPERATION_TRANSACTION_REQUIRED');
    return gate;
  }
  function query(method, sql, params = []) {
    tenant();
    return coordinator.coordinarSentencia(handle.db, sql, () => new Promise((resolve, reject) => {
      handle.db[method](sql, params, AsyncResource.bind(function (error, row) {
        if (error) return reject(error);
        try { tenant(); resolve(method === 'run' ? { changes: this.changes } : row); } catch (e) { reject(e); }
      }));
    }), { timeoutMs: 10000 });
  }
  async function read(intent, inTransaction = false) {
    operation(inTransaction);
    const row = await query('get', 'SELECT * FROM cc_operaciones_cobro WHERE operacion_id = ?', [intent.key]);
    operation(inTransaction);
    if (!row) return null;
    if (row.tipo !== intent.type || row.objetivo_id !== intent.targetId || row.contrato_version !== intent.version ||
        row.huella !== intent.fingerprint || row.peticion_json !== intent.json) fail('CC_IDEMPOTENCY_CONFLICT');
    if (!['RESERVADA', 'CONFIRMADA'].includes(row.estado)) fail('CC_OPERATION_CORRUPT');
    return row;
  }
  function result(row, fresh = false) {
    return Object.freeze({ state: row.estado, fresh,
      response: row.estado === 'CONFIRMADA' ? Object.freeze({ status: row.respuesta_codigo, body: JSON.parse(row.resultado_json) }) : null });
  }
  async function reserve(input, actorId) {
    const intent = normalizeIntent(input); positiveId(actorId);
    const gate = operation(false);
    if (gate.modo === coordinator.MODOS_PUERTA.TX) fail('CC_OPERATION_NESTED_TRANSACTION');
    await query('run', 'BEGIN IMMEDIATE');
    let committed = false;
    try {
      let row = await read(intent, true);
      const fresh = !row;
      if (!row) {
        await query('run', `INSERT INTO cc_operaciones_cobro
          (operacion_id,tipo,objetivo_id,contrato_version,peticion_json,huella,estado,actor_id,reservada_en)
          VALUES (?,?,?,?,?,?,'RESERVADA',?,?)`,
        [intent.key,intent.type,intent.targetId,intent.version,intent.json,intent.fingerprint,actorId,new Date().toISOString()]);
        row = await read(intent, true);
      }
      const out = result(row, fresh);
      await query('run', 'COMMIT'); committed = true;
      return out;
    } catch (error) {
      // A failed COMMIT is not evidence of rollback. Preserve both errors; caller STOPs.
      if (!committed) {
        try { await query('run', 'ROLLBACK'); } catch (rollbackError) { error.rollbackError = rollbackError; error.uncertain = true; }
      }
      throw error;
    }
  }
  async function lookup(input) { const row = await read(normalizeIntent(input)); return row ? result(row) : null; }
  async function beforeEffects(input) {
    const row = await read(normalizeIntent(input), true);
    if (!row) fail('CC_OPERATION_RESERVATION_REQUIRED');
    return result(row);
  }
  async function confirm(input, confirmation) {
    const intent = normalizeIntent(input);
    const row = await read(intent, true);
    if (!row) fail('CC_OPERATION_RESERVATION_REQUIRED');
    if (row.estado === 'CONFIRMADA') return result(row); // immutable recovery; never new effects
    object(confirmation, ['status', 'body', 'paymentId', 'groupId']);
    if (!Number.isInteger(confirmation.status) || confirmation.status < 200 || confirmation.status > 299) fail('CC_OPERATION_INVALID_RESULT');
    const body = JSON.stringify(confirmation.body);
    if (typeof body !== 'string' || body !== JSON.stringify(JSON.parse(body))) fail('CC_OPERATION_INVALID_RESULT');
    let paymentId = null; let groupId = null;
    if (intent.type === 'VENTA') {
      paymentId = positiveId(confirmation.paymentId);
      if (confirmation.groupId != null) fail('CC_OPERATION_INVALID_REFERENCE');
      const payment = await query('get', 'SELECT venta_id, group_id FROM pagos_cuenta_corriente WHERE id = ?', [paymentId]);
      if (!payment || payment.venta_id !== intent.targetId || payment.group_id !== null) fail('CC_OPERATION_INVALID_REFERENCE');
    } else {
      groupId = confirmation.groupId;
      if (confirmation.paymentId != null || typeof groupId !== 'string' || !/^[a-f0-9]{32}$/.test(groupId)) fail('CC_OPERATION_INVALID_REFERENCE');
      const payment = await query('get', 'SELECT COUNT(*) AS count, SUM(CASE WHEN cliente_id = ? THEN 0 ELSE 1 END) AS foreign_count FROM pagos_cuenta_corriente WHERE group_id = ?', [intent.targetId, groupId]);
      if (!payment || typeof payment.count !== 'number' || payment.count <= 0 || payment.foreign_count !== 0) fail('CC_OPERATION_INVALID_REFERENCE');
    }
    operation(true);
    const updated = await query('run', `UPDATE cc_operaciones_cobro SET estado='CONFIRMADA', confirmada_en=?,
      respuesta_codigo=?, resultado_json=?, pago_legacy_id=?, group_id=? WHERE operacion_id=? AND estado='RESERVADA'`,
    [new Date().toISOString(),confirmation.status,body,paymentId,groupId,intent.key]);
    if (updated.changes !== 1) fail('CC_OPERATION_CONFIRMATION_FAILED');
    return result(await read(intent, true)); // caller alone owns COMMIT/ROLLBACK
  }
  return Object.freeze({ reserve, lookup, beforeEffects, confirm });
}

module.exports = Object.freeze({ validateKey, normalizeIntent, createCcPaymentIdempotency });
