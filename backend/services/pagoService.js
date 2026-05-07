const { resolveCobroData } = require("./ventaService");

function resolvePagoData(total, tipoPago, montoEfectivo, montoDebito) {
  return resolveCobroData(total, tipoPago, montoEfectivo, montoDebito);
}

module.exports = {
  resolvePagoData
};
