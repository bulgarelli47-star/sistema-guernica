'use strict';
const { AsyncResource } = require('node:async_hooks');
const { resolveCcPrice } = require('./ccPriceResolver');

// Reads only the supplied tenant connection; never imports db.js or opens a connection.
function createCcPriceReader(handle, getActiveHandle) {
  function assertTenant() {
    if (!handle || !Object.isFrozen(handle) || !Number.isSafeInteger(handle.empresaId) || handle.empresaId <= 0 ||
        !handle.db || typeof handle.db.all !== 'function' || getActiveHandle() !== handle) {
      throw Object.assign(new Error('CC tenant connection not verified'), { code: 'CC_TENANT_REQUIRED' });
    }
  }
  assertTenant();
  function all(sql, params) {
    assertTenant();
    return new Promise((resolve, reject) => handle.db.all(sql, params, AsyncResource.bind((error, rows) => {
      if (error) return reject(error);
      try { assertTenant(); resolve(rows); } catch (e) { reject(e); }
    })));
  }
  return async function readPrice(productId) {
    if (!Number.isSafeInteger(productId) || productId <= 0) return { status: 'INDETERMINATE', price: null, source: null, reason: 'PRODUCT_ID_UNAVAILABLE' };
    const products = await all('SELECT id, precio_venta, activo, eliminado FROM productos WHERE id = ?', [productId]);
    const history = await all("SELECT id, producto_id, campo_modificado, valor_anterior, valor_nuevo, motivo FROM historial_productos WHERE producto_id = ? AND campo_modificado = 'precio_venta' ORDER BY id ASC", [productId]);
    if (products.length > 1 || products.some(p => p.id !== productId || ![0,1].includes(p.activo) || ![0,1].includes(p.eliminado)) || history.some(h => h.producto_id !== productId)) {
      throw Object.assign(new Error('CC tenant query identity mismatch'), { code: 'CC_PRICE_IDENTITY_MISMATCH' });
    }
    const p = products[0];
    return resolveCcPrice({ productId,
      product: p ? { id:p.id, price:p.precio_venta, active:p.activo === 1, deleted:p.eliminado === 1 } : null,
      history: history.map(h => ({id:h.id, productId:h.producto_id, field:h.campo_modificado, oldValue:h.valor_anterior, newValue:h.valor_nuevo, kind:h.valor_anterior === null && /^creacion(?: producto compuesto)?$/.test(h.motivo || '') ? 'creation' : 'change'})),
      // Existing schema cannot attest complete, atomically published history or its order.
      // Ordered IDs/continuous values alone must not manufacture these guarantees.
      evidence:{tenantOwnershipVerified:true, completePublicationHistory:false, publicationOrderVerified:false}
    });
  };
}
module.exports = Object.freeze({ createCcPriceReader });
