'use strict';
const assert = require('node:assert/strict');
const { resolveCcPrice } = require('../backend/services/ccPriceResolver');
let count = 0;
function fixture(prices, options = {}) {
  return { productId: 7, product: { id: 7, active: true, deleted: false, price: prices.at(-1) },
    history: prices.map((price, i) => ({ id: i + 1, productId: 7, field: 'precio_venta', kind: i ? 'change' : 'creation', oldValue: i ? String(prices[i - 1]) : null, newValue: String(price) })),
    evidence: { tenantOwnershipVerified: true, completePublicationHistory: true, publicationOrderVerified: true }, ...options };
}
function test(name, fn) { fn(); count++; console.log('PASS ' + name); }
function resolved(input, price) { const result = resolveCcPrice(input); assert.equal(result.status, 'RESOLVED'); assert.equal(result.price, price); }
function unknown(input) { const result = resolveCcPrice(input); assert.equal(result.status, 'INDETERMINATE'); assert.equal(result.price, null); assert.equal(result.source, null); }
for (const prices of [[100,150],[150,100],[100,150,0],[150,100,0],[150,200,0]]) {
  test(prices.join(' -> '), () => resolved(fixture(prices), prices.filter(p => p > 0).at(-1)));
}
test('inactive uses last positive, not original', () => { const f = fixture([100,200]); f.product.active = false; resolved(f,200); });
test('logically deleted uses history', () => { const f = fixture([100,200,0]); f.product.deleted = true; f.product.active = false; resolved(f,200); });
test('physically absent with attested identity/history', () => resolved(fixture([150,100,0], {product:null}),100));
test('missing history', () => unknown(fixture([0], {history:undefined})));
test('empty history', () => unknown(fixture([0], {history:[]})));
test('incomplete coverage', () => { const f=fixture([150,0]); f.evidence.completePublicationHistory=false; unknown(f); });
test('missing creation anchor', () => { const f=fixture([150,200,0]); f.history.shift(); unknown(f); });
test('contradictory continuity', () => { const f=fixture([150,200,0]); f.history[1].oldValue='100'; unknown(f); });
test('duplicate record IDs', () => { const f=fixture([150,0]); f.history[1].id=1; unknown(f); });
test('registration order alone insufficient', () => { const f=fixture([150,0]); f.evidence.publicationOrderVerified=false; unknown(f); });
test('input order is normalized without mutation', () => { const f=fixture([150,100,0]); f.history.reverse(); const before=JSON.stringify(f); resolved(f,100); assert.equal(JSON.stringify(f),before); });
test('current/history contradiction', () => { const f=fixture([150,0]); f.product.price=20; f.product.active=false; unknown(f); });
test('zero since creation', () => unknown(fixture([0])));
for (const value of ['', ' ', '150x', '0x96', '1e2', '-1', 'NaN', null, false, Infinity, NaN]) {
  test('invalid history value '+String(value), () => { const f=fixture([150,0]); f.history[0].newValue=value; unknown(f); });
}
test('numeric-string current price rejected', () => { const f=fixture([150]); f.product.price='150'; unknown(f); });
test('other product history rejected', () => { const f=fixture([150,0]); f.history[0].productId=8; unknown(f); });
test('ownership unverified', () => { const f=fixture([150]); f.evidence.tenantOwnershipVerified=false; unknown(f); });
test('positive current needs no historical invention', () => resolved(fixture([150],{history:[]}),150));
test('original sale price is not fallback', () => { const f=fixture([0],{history:[]}); f.originalSalePrice=150; unknown(f); });
console.log(JSON.stringify({total:count,passed:count,failed:0,sqlite:false,services:false}));
