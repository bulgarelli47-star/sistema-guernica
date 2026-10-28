'use strict';
// Actual extracted collection handler; simulated transactional DB and valuation.
// No SQLite, HTTP, application boot, or financial writes to disk.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
const marker = 'app.post("/clientes/:id/cobrar-deuda",';
const start = source.indexOf(marker);
assert(start >= 0);
const handlerSource = source.slice(start, source.indexOf('\napp.', start + marker.length));
async function simulate(options = {}) {
  let rows = [
    { id: 2, cliente_id: 7, es_cuenta_corriente: 1, estado: 'cuenta_corriente_pendiente', saldo_pendiente: 150, fecha: '2026-01-01', hora: '10:00:00' },
    { id: 1, cliente_id: 7, es_cuenta_corriente: 1, estado: 'cuenta_corriente_pendiente', saldo_pendiente: 200, fecha: '2026-01-02', hora: '10:00:00' }
  ];
  let payments = [], channels = [], tx = false, saved, handler, status = 200, response;
  const sqlEvents = [], mutations = [], valued = [], summaryTx = [];
  const copy = value => JSON.parse(JSON.stringify(value));
  const initial = copy(rows);
  const box = {
    // Orchestration is simulated here; the global idempotency suite uses real SQLite.
    require: id => {
      assert.equal(id, './services/ccPaymentIdempotencyService');
      return {createCcPaymentIdempotency: () => ({
        reserve: async intent => { require('../backend/services/ccPaymentIdempotencyService').normalizeIntent(copy(intent)); return {state:'RESERVADA'}; },
        beforeEffects: async () => ({state:'RESERVADA'}),
        confirm: async () => ({state:'CONFIRMADA'})
      })};
    },
    getTenantContext: () => ({tenantHandle:{}}),
    requirePermiso: async () => true,
    crypto,
    app: { post(route, fn) { assert.equal(route, '/clientes/:id/cobrar-deuda'); handler = fn; } },
    normalizarCobrosV2: cobros => cobros,
    validarCuentaCobroVenta: async () => ({ ok: true }),
    getCajaAbiertaActual: async () => ({ id: 9 }),
    getCuentaCobroSnapshot: async () => ({}),
    getNowParts: () => ({ fecha: '2026-10-26', hora: '10:00:00' }),
    logError: () => {},
    buildClienteCuentaResumen: async () => {
      summaryTx.push(tx);
      return { deuda_actual: rows.reduce((sum, row) => sum + row.saldo_pendiente, 0) };
    },
    getVentaCuentaCorrienteSnapshot: async id => {
      assert(tx, 'valuation must occur inside allocation transaction');
      assert.equal(mutations.length, 0, 'all affected valuations precede financial writes');
      valued.push(id);
      const venta = rows.find(row => row.id === id);
      if (!venta) return null;
      const indeterminate = (options.indeterminate || []).includes(id);
      return { venta: copy(venta), price_status: indeterminate ? 'INDETERMINATE' : 'RESOLVED',
        price_issues: indeterminate ? [{ reason: 'INSUFFICIENT_HISTORY' }] : [],
        saldo_actual: venta.saldo_pendiente + (options.priceMismatch === id ? 10 : 0) };
    },
    allQuery: async sql => {
      assert(tx); assert(sql.includes('ORDER BY fecha ASC, hora ASC, id ASC'));
      return copy(rows.filter(row => row.saldo_pendiente > 0).sort((a, b) =>
        a.fecha.localeCompare(b.fecha) || a.hora.localeCompare(b.hora) || a.id - b.id));
    },
    getQuery: async (sql, params) => {
      if (sql.includes('FROM clientes')) return { id: 7 };
      if (sql.includes('FROM cuentas_cobro')) return null;
      assert(tx);
      const row = rows.find(row => row.id === params[0]);
      if (options.changedBalance === params[0]) return { ...copy(row), saldo_pendiente: row.saldo_pendiente - 10 };
      return row ? copy(row) : null;
    },
    runQuery: async (sql, params) => {
      sqlEvents.push(sql);
      if (sql === 'BEGIN TRANSACTION') { assert(!tx); tx = true; saved = copy({ rows, payments, channels }); return; }
      assert(tx);
      if (sql === 'ROLLBACK') { ({ rows, payments, channels } = saved); tx = false; return; }
      if (sql === 'COMMIT') { tx = false; return; }
      mutations.push(sql);
      if (sql.includes('UPDATE ventas')) {
        const row = rows.find(row => row.id === params[2]);
        if (options.casFail) return { changes: 0 };
        row.saldo_pendiente = params[0]; row.estado = params[1]; return { changes: 1 };
      }
      if (sql.includes('INSERT INTO pagos_cuenta_corriente')) {
        if (options.paymentError) throw Error('synthetic payment failure');
        payments.push({ venta_id: params[0], amount: params[4], group: params[7] }); return { changes: 1 };
      }
      assert(sql.includes('INSERT INTO pagos_cc_cobros'));
      if (options.channelError) throw Error('synthetic channel failure');
      channels.push({ group: params[0], amount: params[3] }); return { changes: 1 };
    }
  };
  vm.runInNewContext(handlerSource, box);
  const body = { cobros: [{ tipo_cobro: 'efectivo', monto: options.amount ?? 50 }], ...(options.manual ? { ventas: options.manual } : {}) };
  const res = { status(value) { status = value; return res; }, json(value) { response = copy(value); return value; } };
  await handler({ params: { id: '7' }, usuario:{id:1}, get:()=> 'cc-client-safety-operation-0001', body }, res);
  assert(!tx, 'no transaction leak');
  return { status, response, rows, initial, payments, channels, valued, summaryTx, mutations, sqlEvents };
}
(async () => {
  let total = 0;
  async function test(name, fn) { await fn(); total++; console.log('PASS ' + name); }
  function noEffects(r) {
    assert.deepEqual(r.rows, r.initial); assert.equal(r.payments.length, 0); assert.equal(r.channels.length, 0);
    assert(!r.sqlEvents.includes('COMMIT'));
  }
  await test('FIFO determinable partial payment preserves oldest date before ID', async () => {
    const r = await simulate(); assert.equal(r.status, 200); assert.equal(r.response.aplicacion, 'fifo');
    assert.deepEqual(r.valued, [2]); assert.deepEqual(r.payments.map(p => [p.venta_id, p.amount]), [[2, 50]]);
    assert.deepEqual(r.summaryTx, [true]); assert.equal(r.rows[1].saldo_pendiente, 200);
  });
  await test('FIFO spans oldest then next with matching money and allocation', async () => {
    const r = await simulate({ amount: 180 }); assert.equal(r.status, 200); assert.deepEqual(r.valued, [2, 1]);
    assert.deepEqual(r.payments.map(p => [p.venta_id, p.amount]), [[2, 150], [1, 30]]);
    assert.equal(r.channels[0].amount, 180); assert.equal(r.rows[0].estado, 'cobrada'); assert.equal(r.rows[1].saldo_pendiente, 170);
  });
  for (const id of [2, 1]) await test('FIFO indeterminate affected sale ' + id + ' rejects before mutations', async () => {
    const r = await simulate({ amount: 180, indeterminate: [id] }); assert.equal(r.status, 409);
    assert.equal(r.response.code, 'CC_PRICE_INDETERMINATE'); assert.equal(r.mutations.length, 0); noEffects(r);
  });
  await test('FIFO does not price an unrelated later indeterminate sale', async () => {
    const r = await simulate({ indeterminate: [1] }); assert.equal(r.status, 200); assert.deepEqual(r.valued, [2]);
  });
  await test('manual selection preserves explicit allocation and ignores unrelated uncertainty', async () => {
    const r = await simulate({ manual: [{ venta_id: 1, monto: 50 }], indeterminate: [2] });
    assert.equal(r.status, 200); assert.equal(r.response.aplicacion, 'manual'); assert.deepEqual(r.valued, [1]);
    assert.deepEqual(r.payments.map(p => p.venta_id), [1]); assert.equal(r.rows[0].saldo_pendiente, 150);
  });
  await test('manual selected indeterminate sale rejects without mutations', async () => {
    const r = await simulate({ manual: [{ venta_id: 1, monto: 50 }], indeterminate: [1] });
    assert.equal(r.status, 409); assert.equal(r.response.code, 'CC_PRICE_INDETERMINATE'); assert.equal(r.mutations.length, 0); noEffects(r);
  });
  for (const manual of [false, true]) await test('balance changed before allocation rejects ' + (manual ? 'manual' : 'FIFO'), async () => {
    const r = await simulate({ changedBalance: 2, ...(manual ? { manual: [{ venta_id: 2, monto: 50 }] } : {}) });
    assert.equal(r.status, 409); assert.equal(r.response.code, 'CC_BALANCE_CHANGED'); assert.equal(r.mutations.length, 0); noEffects(r);
  });
  await test('verified valuation differing from stored balance requests review without revaluation', async () => {
    const r = await simulate({ priceMismatch: 2 }); assert.equal(r.status, 409); assert.equal(r.response.code, 'CC_BALANCE_REVIEW_REQUIRED');
    assert.equal(r.mutations.length, 0); noEffects(r);
  });
  await test('failed FIFO conditional update cannot commit money without allocation', async () => {
    const r = await simulate({ casFail: true }); assert.equal(r.status, 409); noEffects(r);
  });
  for (const error of ['paymentError', 'channelError']) await test(error + ' rolls back all simulated financial effects', async () => {
    const r = await simulate({ [error]: true }); assert.equal(r.status, 500); noEffects(r);
  });
  await test('invalid manual sum rejects before transaction and valuation', async () => {
    const r = await simulate({ manual: [{ venta_id: 1, monto: 60 }] }); assert.equal(r.status, 400); assert.equal(r.sqlEvents.length, 0); assert.equal(r.valued.length, 0); noEffects(r);
  });
  console.log(JSON.stringify({ total, passed: total, failed: 0, sqlite: false, http: false }));
})().catch(error => { console.error(error); process.exitCode = 1; });
