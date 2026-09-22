// MT-1E2C3B: catalogo rico de migraciones de business DB -- unica fuente de verdad. Modulo PURO:
// sin I/O, sin env, sin apertura de DB, sin side effects al cargar -- solo define y exporta el
// catalogo. "001_legacy_runtime_baseline" es kind:"BASELINE" (certifica el estado legacy ya
// existente, no lo transforma -- por eso no tiene up()). Toda entrada con sequence>1 es
// kind:"MIGRATION" y tiene up(db) obligatoria. PROHIBIDO agregar una migration sin transformacion
// contractual real (no "00X_noop", no milestones de ingenieria) -- migration history describe
// cambios reales.
//
// MT-1F5C1: "002_tenant_integration_credentials" es la primera migration real (ver MT-1E2C3B.0,
// que documentaba la ausencia de 002 solo como estado de hecho, nunca como prohibicion permanente).
// Contrato de up(db): recibe una conexion sqlite3 YA ABIERTA y YA dentro de una transaccion
// controlada por el caller (provision-tenant-db.js o migrate-tenant-db.js) -- nunca abre su propia
// conexion, nunca ejecuta BEGIN/COMMIT/ROLLBACK, mismo contrato que database/business-schema-baseline.js.
// Crea EXCLUSIVAMENTE las dos tablas de configuracion/credencial de integraciones tenant-owned,
// siempre VACIAS -- jamas siembra un provider, jamas lee variables de entorno, jamas copia un
// credential existente. Ver MT-1F5C-D1/D1A/D1B/D1C para la autoridad de diseno completa.
function runQuery(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) { reject(error); return; }
      resolve(this);
    });
  });
}

async function up002TenantIntegrationCredentials(db) {
  await runQuery(
    db,
    `CREATE TABLE integraciones_tenant (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  );
  await runQuery(
    db,
    `CREATE TABLE integraciones_tenant_secretos (
      integracion_id INTEGER PRIMARY KEY NOT NULL,
      secret_encrypted TEXT NOT NULL,
      secret_meta_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(integracion_id) REFERENCES integraciones_tenant(id)
    )`
  );
}

const BUSINESS_MIGRATIONS = Object.freeze([
  Object.freeze({
    sequence: 1,
    migrationId: "001_legacy_runtime_baseline",
    kind: "BASELINE"
  }),
  Object.freeze({
    sequence: 2,
    migrationId: "002_tenant_integration_credentials",
    kind: "MIGRATION",
    up: up002TenantIntegrationCredentials
  })
]);

module.exports = {
  BUSINESS_MIGRATIONS
};
