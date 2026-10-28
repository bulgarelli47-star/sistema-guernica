'use strict';

// Pure policy only. The caller must attest tenant ownership and publication coverage.
// Record IDs order registrations, not necessarily the historical publications.
function resolveCcPrice(input) {
  const unknown = reason => Object.freeze({ status: 'INDETERMINATE', price: null, source: null, reason });
  const number = value => {
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
    // SQLite history stores TEXT. Accept decimal notation only, without coercive syntax.
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  if (!input || typeof input !== 'object') return unknown('INVALID_INPUT');
  const { productId, product, history, evidence } = input;
  if (!Number.isSafeInteger(productId) || productId <= 0) return unknown('INVALID_PRODUCT_ID');
  if (!evidence || evidence.tenantOwnershipVerified !== true) return unknown('OWNERSHIP_NOT_VERIFIED');
  let current = null;
  if (product !== null) {
    if (!product || product.id !== productId || typeof product.active !== 'boolean' || typeof product.deleted !== 'boolean') return unknown('INVALID_PRODUCT');
    // Current product prices have a numeric contract; history TEXT is handled separately.
    if (typeof product.price !== 'number' || (current = number(product.price)) === null) return unknown('INVALID_CURRENT_PRICE');
    if (product.active && !product.deleted && current > 0) {
      return Object.freeze({ status: 'RESOLVED', price: current, source: 'CURRENT_PRODUCT', validity: 'VERIFIED_CURRENT_POSITIVE' });
    }
  }
  if (!Array.isArray(history) || history.length === 0) return unknown('NO_PUBLICATION_HISTORY');
  if (evidence.completePublicationHistory !== true || evidence.publicationOrderVerified !== true) return unknown('INSUFFICIENT_PUBLICATION_EVIDENCE');
  const rows = [...history].sort((a, b) => (a && a.id) - (b && b.id));
  let previous = null, lastPositive = null, sourceRecordId = null, lastId = 0;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!row || !Number.isSafeInteger(row.id) || row.id <= lastId || row.productId !== productId) return unknown('AMBIGUOUS_RECORD_ID_OR_PRODUCT');
    if (row.field !== 'precio_venta') return unknown('UNEXPECTED_HISTORY_FIELD');
    const next = number(row.newValue);
    if (next === null) return unknown('INVALID_HISTORY_PRICE');
    if (index === 0) {
      if (row.oldValue !== null || row.kind !== 'creation') return unknown('MISSING_CREATION_ANCHOR');
    } else {
      const old = number(row.oldValue);
      if (old === null || old !== previous || row.kind !== 'change') return unknown('BROKEN_HISTORY_CHAIN');
    }
    if (next > 0) { lastPositive = next; sourceRecordId = row.id; }
    previous = next;
    lastId = row.id;
  }
  if (product !== null && current !== previous) return unknown('CURRENT_HISTORY_CONTRADICTION');
  if (lastPositive === null) return unknown('NO_POSITIVE_PUBLICATION');
  return Object.freeze({ status: 'RESOLVED', price: lastPositive, source: 'PUBLICATION_HISTORY', sourceRecordId, validity: 'CALLER_ATTESTED_COMPLETE_ORDERED_CHAIN' });
}

module.exports = Object.freeze({ resolveCcPrice });
