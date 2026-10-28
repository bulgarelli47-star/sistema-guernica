'use strict';
// Pure async-boundary simulation: no SQLite import, connection, file or HTTP.
const assert = require('node:assert/strict');
const { AsyncResource } = require('node:async_hooks');
const context = require('../backend/tenantRequestContext');
const { createCcPriceReader } = require('../backend/services/ccPriceData');

const events = [];
function label(handle) { return handle ? handle.empresaSlug : null; }
function fixture(resource, slug, empresaId, price, options = {}) {
  let handle;
  const calls = [];
  const db = {
    run() { throw Error('Writes forbidden'); },
    get() { throw Error('Unexpected get'); },
    all(sql, params, callback) {
      assert.strictEqual(context.getTenantHandle(), handle, 'query dispatched on its own tenant');
      assert.deepEqual(params, [7]);
      calls.push(sql);
      let returned = false;
      setImmediate(() => resource.runInAsyncScope(() => {
        assert(returned, 'callback must be genuinely deferred');
        events.push({ stage: 'raw-callback', tenant: slug, active: label(context.getTenantHandle()) });
        assert.equal(context.getTenantHandle(), null, 'external resource deliberately has no request context');
        const rows = sql.includes('FROM productos')
          ? [{ id: 7, precio_venta: price, activo: 1, eliminado: 0 }]
          : [];
        callback(options.error || null, rows);
        assert.equal(context.getTenantHandle(), null, 'bound scope must not leak into native caller');
      }));
      returned = true;
    }
  };
  handle = Object.freeze({ empresaId, empresaSlug: slug, canonicalPath: 'synthetic-only-' + slug, db });
  function active() {
    const actual = context.getTenantHandle();
    events.push({ stage: 'assert-tenant', tenant: slug, active: label(actual), sameReference: actual === handle });
    return options.override?.() || actual;
  }
  return { handle, calls, reader: () => createCcPriceReader(handle, active) };
}

(async () => {
  assert.equal(context.getTenantHandle(), null);
  // Created OUTSIDE all request scopes: deferred callbacks cannot accidentally
  // pass merely because setImmediate inherited the submitting tenant.
  const external = new AsyncResource('CC_TEST_EXTERNAL_CALLBACK');
  let total = 0;
  async function test(name, fn) { await fn(); total++; console.log('PASS ' + name); }
  try {
    await test('A deferred callback restores captured tenant A and leaves caller unchanged', async () => {
      const a = fixture(external, 'synthetic-a', 1, 150);
      const result = await context.runWithTenantHandle(a.handle, async () => {
        events.push({ stage: 'request-entry', tenant: 'synthetic-a', active: label(context.getTenantHandle()) });
        const result = await a.reader()(7);
        assert.strictEqual(context.getTenantHandle(), a.handle);
        return result;
      });
      assert.equal(result.status, 'RESOLVED'); assert.equal(result.price, 150);
      assert.equal(a.calls.length, 2); assert.equal(context.getTenantHandle(), null);
    });
    await test('B overlapping tenants use distinct connections and distinct prices', async () => {
      const a = fixture(external, 'synthetic-a', 1, 100), b = fixture(external, 'synthetic-b', 2, 200);
      assert.notStrictEqual(a.handle.db, b.handle.db);
      const [ra, rb] = await Promise.all([
        context.runWithTenantHandle(a.handle, () => a.reader()(7)),
        context.runWithTenantHandle(b.handle, () => b.reader()(7))
      ]);
      assert.equal(ra.price, 100); assert.equal(rb.price, 200);
      assert.equal(a.calls.length, 2); assert.equal(b.calls.length, 2);
      assert.equal(context.getTenantHandle(), null);
    });
    await test('C absent active context rejects before any query', async () => {
      const a = fixture(external, 'synthetic-a', 1, 150);
      assert.throws(a.reader, { code: 'CC_TENANT_REQUIRED' }); assert.equal(a.calls.length, 0);
      assert.throws(() => createCcPriceReader(null, context.getTenantHandle), { code: 'CC_TENANT_REQUIRED' });
    });
    await test('D foreign handle at creation or reuse rejects without consulting either base', async () => {
      const a = fixture(external, 'synthetic-a', 1, 150), b = fixture(external, 'synthetic-b', 2, 200);
      const reader = context.runWithTenantHandle(a.handle, a.reader);
      await context.runWithTenantHandle(b.handle, async () => {
        assert.throws(a.reader, { code: 'CC_TENANT_REQUIRED' });
        await assert.rejects(reader(7), { code: 'CC_TENANT_REQUIRED' });
        assert.strictEqual(context.getTenantHandle(), b.handle);
      });
      assert.equal(a.calls.length, 0); assert.equal(b.calls.length, 0);
    });
    await test('E deferred driver error rejects unchanged and preserves request context', async () => {
      const error = Object.assign(Error('synthetic driver error'), { code: 'SQLITE_ERROR' });
      const a = fixture(external, 'synthetic-a', 1, 150, { error });
      await context.runWithTenantHandle(a.handle, async () => {
        await assert.rejects(a.reader()(7), actual => actual === error);
        assert.strictEqual(context.getTenantHandle(), a.handle);
      });
      assert.equal(a.calls.length, 1); assert.equal(context.getTenantHandle(), null);
    });
    await test('callback identity assertion remains effective after binding', async () => {
      let override;
      const a = fixture(external, 'synthetic-a', 1, 150, { override: () => override });
      const b = fixture(external, 'synthetic-b', 2, 200);
      await context.runWithTenantHandle(a.handle, async () => {
        const pending = a.reader()(7);
        override = b.handle;
        await assert.rejects(pending, { code: 'CC_TENANT_REQUIRED' });
        assert.strictEqual(context.getTenantHandle(), a.handle);
      });
      assert.equal(a.calls.length, 1); assert.equal(b.calls.length, 0);
    });
    console.log(JSON.stringify({ total, passed: total, failed: 0, sqlite: false, http: false, events }));
  } finally { external.emitDestroy(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
