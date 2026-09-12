// MT-1E2C3B: catalogo rico de migraciones de business DB -- unica fuente de verdad. Modulo PURO:
// sin I/O, sin env, sin apertura de DB, sin side effects -- solo define y exporta el catalogo.
// "001_legacy_runtime_baseline" es kind:"BASELINE" (certifica el estado legacy ya existente, no lo
// transforma -- por eso no tiene up()). Toda entrada futura con sequence>1 debe ser kind:"MIGRATION"
// y tener up(db) obligatoria. Deliberadamente SIN 002: ver MT-1E2C3B.0 -- no existe hoy ninguna
// transformacion de schema/data posterior al baseline 001 (las ensure* de backend/server.js
// pertenecen conceptualmente a 001 y ya estan certificadas alli). PROHIBIDO agregar una migration
// sin transformacion contractual real (no "002_noop", no "002_engine_ready", no milestones de
// ingenieria) -- migration history describe cambios reales.
const BUSINESS_MIGRATIONS = Object.freeze([
  Object.freeze({
    sequence: 1,
    migrationId: "001_legacy_runtime_baseline",
    kind: "BASELINE"
  })
]);

module.exports = {
  BUSINESS_MIGRATIONS
};
