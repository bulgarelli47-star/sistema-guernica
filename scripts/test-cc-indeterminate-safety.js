'use strict';
// Extract actual handlers; all dependencies are simulated. No HTTP or SQLite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
function snapshot(overrides = {}) {
  return { venta: { id: 1, cliente_id: 7, es_cuenta_corriente: 1,
    estado: 'cuenta_corriente_pendiente', saldo_pendiente: 150, total_venta_original: 150 },
    saldo_actual: 200, total_actual: 200, total_pagado: 0, items: [],
    price_status: 'RESOLVED', ...overrides };
}
async function invoke(method, route, options = {}) {
  const marker = `app.${method}("${route}",`;
  const start = source.indexOf(marker);
  assert(start >= 0);
  const end = source.indexOf('\napp.', start + marker.length);
  let handler, code = 200, body, tx = false, saved;
  const writes = [], events = [];
  const state = { saldo: 150, estado: 'cuenta_corriente_pendiente', payments: [] };
  const snap = options.snapshot || snapshot();
  const context = {
    // Idempotency orchestration is simulated here; its real SQLite contract has a separate suite.
    require: id => {
      assert.equal(id, './services/ccPaymentIdempotencyService');
      return { createCcPaymentIdempotency: () => ({
        reserve: async intent => {
          require('../backend/services/ccPaymentIdempotencyService').normalizeIntent(JSON.parse(JSON.stringify(intent)));
          return {state:'RESERVADA'};
        },
        beforeEffects: async () => ({state:'RESERVADA'}),
        confirm: async () => ({state:'CONFIRMADA'})
      }) };
    },
    getTenantContext: () => ({tenantHandle:{}}),
    requirePermiso: async () => true,
    app: { [method]: (name, fn) => { assert.equal(name, route); handler = fn; } },
    getVentaCuentaCorrienteSnapshot: async () => { events.push('observe'); if (options.observeError) throw Error('observer'); return snap; },
    refreshCuentaCorrienteSaldo: () => { throw Error('Mutating refresh forbidden'); },
    getCajaAbiertaActual: async () => { events.push('caja'); return options.noCaja ? null : { id: 3 }; },
    getQuery: async sql => sql.includes('FROM clientes') ? (options.missingClient ? null : { id: 7 }) : { saldo_pendiente: options.changedBalance ? 140 : state.saldo },
    allQuery: async sql => {
      assert(sql.includes("saldo_pendiente = 0 AND estado = 'cuenta_corriente_pendiente'"));
      return [{ id: 1, fecha: 'synthetic', total_historico: 150 }];
    },
    resolveCobroData: amount => options.invalidCobro ? null : { tipo_cobro: 'efectivo', monto_efectivo: amount, monto_debito: 0 },
    getNowParts: () => ({ fecha: 'synthetic', hora: 'synthetic' }),
    logError: () => {},
    runQuery: async (sql, params) => {
      writes.push(sql);
      if (sql === 'BEGIN IMMEDIATE') { assert(!tx); tx = true; saved = JSON.parse(JSON.stringify(state)); return; }
      assert(tx);
      if (sql === 'ROLLBACK') { Object.assign(state, saved); tx = false; return; }
      if (sql === 'COMMIT') { tx = false; return; }
      if (sql.includes('UPDATE ventas')) { assert.equal(params.at(-1), 150); state.saldo = params[0]; state.estado = params[1]; return { changes: 1 }; }
      assert(sql.includes('INSERT INTO pagos_cuenta_corriente'));
      if (options.paymentError) throw Error('payment');
      state.payments.push(params[4]);
      return { lastID: 1 };
    }
  };
  vm.runInNewContext(source.slice(start, end), context);
  const res = { status(n) { code = n; return res; }, json(value) { body = value; return value; } };
  await handler({ params: { id: '1' }, usuario:{id:1}, get: () => 'cc-indeterminate-safety-0001', body: { monto_pagado: options.amount ?? 50, tipo_cobro: 'efectivo' } }, res);
  assert.equal(tx, false);
  return { code, body, writes, events, state };
}
const get = options => invoke('get', '/clientes/:id/cuenta-corriente', options);
const pay = options => invoke('post', '/ventas/:id/pagar-cuenta-corriente', options);
(async () => {
  let total = 0;
  async function test(name, fn) { await fn(); total++; console.log('PASS ' + name); }
  await test('GET determinable balance without writes', async () => {
    const r = await get(); assert.equal(r.body.saldo_pendiente, 200); assert.equal(r.body.ventas_pendientes[0].saldo_verificado, true); assert.equal(r.writes.length, 0);
  });
  for (const saldo of [150, 0]) await test('GET indeterminate preserved balance ' + saldo, async () => {
    const s = snapshot({ price_status: 'INDETERMINATE', saldo_actual: saldo, total_actual: null, price_issues: [{ reason: 'INSUFFICIENT_HISTORY' }] });
    s.venta.saldo_pendiente = saldo;
    const r = await get({ snapshot: s }); assert.equal(r.body.saldo_pendiente, saldo); assert.equal(r.body.ventas_pendientes.length, 1);
    assert.equal(r.body.price_status, 'INDETERMINATE'); assert.equal(r.body.ventas_pendientes[0].price_issues[0].reason, 'INSUFFICIENT_HISTORY'); assert.equal(r.body.ventas_pendientes[0].saldo_verificado, false); assert.equal(r.writes.length, 0);
  });
  await test('indeterminate payment blocked before caja and writes', async () => {
    const r = await pay({ snapshot: snapshot({ price_status: 'INDETERMINATE', saldo_actual: 150 }) });
    assert.equal(r.code, 409); assert.equal(r.body.code, 'CC_PRICE_INDETERMINATE'); assert.deepEqual(r.events, ['observe']); assert.deepEqual(r.writes, ['BEGIN IMMEDIATE','ROLLBACK']); assert.equal(r.state.payments.length, 0); assert.equal(r.state.saldo, 150);
  });
  await test('valid payment uses verified value atomically', async () => {
    const r = await pay(); assert.equal(r.code, 200); assert.equal(r.state.saldo, 150); assert.deepEqual(r.state.payments, [50]); assert.equal(r.writes[0], 'BEGIN IMMEDIATE'); assert.equal(r.writes.at(-1), 'COMMIT');
  });
  await test('full real payment marks paid', async () => {
    const r = await pay({ amount: 200 }); assert.equal(r.state.saldo, 0); assert.equal(r.state.estado, 'cobrada'); assert.deepEqual(r.state.payments, [200]);
  });
  await test('paid debt cannot be reopened or charged', async () => {
    const s = snapshot({ price_status: 'NOT_APPLICABLE', saldo_actual: 0 }); s.venta.estado = 'cobrada'; s.venta.saldo_pendiente = 0;
    const r = await pay({ snapshot: s }); assert.equal(r.code, 404); assert.deepEqual(r.writes, ['BEGIN IMMEDIATE','ROLLBACK']);
  });
  for (const options of [{ amount: 0 }, { amount: 201 }, { invalidCobro: true }, { noCaja: true }]) await test('invalid payment no writes ' + JSON.stringify(options), async () => {
    const r = await pay(options); assert.equal(r.code, 400); assert(r.writes.every(sql=>['BEGIN IMMEDIATE','ROLLBACK'].includes(sql))); assert.equal(r.state.payments.length, 0);
  });
  await test('concurrent balance change rejected without partial mutation', async () => {
    const r = await pay({ changedBalance: true }); assert.equal(r.code, 409); assert.equal(r.writes.at(-1), 'ROLLBACK'); assert.equal(r.state.saldo, 150); assert.equal(r.state.payments.length, 0);
  });
  await test('payment persistence error rolls back balance', async () => {
    const r = await pay({ paymentError: true }); assert.equal(r.code, 500); assert.equal(r.state.saldo, 150); assert.equal(r.state.payments.length, 0); assert.equal(r.writes.at(-1), 'ROLLBACK');
  });
  await test('GET observer error has no writes', async () => { const r = await get({ observeError: true }); assert.equal(r.code, 500); assert.equal(r.writes.length, 0); });
  console.log(JSON.stringify({ total, passed: total, failed: 0, sqlite: false, http: false }));
})().catch(error => { console.error(error); process.exitCode = 1; });
