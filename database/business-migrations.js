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

// AUTH-SYNC-B2-P1A-SR: agrega la columna de generacion de credencial que requireAuth compara en
// cada request central para invalidar sesiones tras una rotacion de password (ver
// backend/centralAuthResolver.js). NULL permitido deliberadamente -- sesiones legacy y sesiones
// centrales emitidas ANTES de este slice deben aterrizar en NULL, nunca en 0 ni en ningun otro
// valor inferido: NULL es justamente la senal que hace que requireAuth las trate como
// CENTRAL_PASSWORD_ROTATED (invalidas) la primera vez que se revalidan, forzando un re-login unico
// sin necesidad de ningun backfill. Ninguna fila existente se toca aqui -- ALTER TABLE ADD COLUMN
// sin DEFAULT deja las filas preexistentes en NULL automaticamente.
async function up003SesionesPasswordVersion(db) {
  await runQuery(db, "ALTER TABLE sesiones ADD COLUMN password_version INTEGER");
}

// AUTH-SYNC-B2-S0b1: version de proyeccion CENTRAL -> TENANT de rol/activo de la membership
// (usuario_empresas.version de Control DB) ya aplicada sobre esta fila local. Es la base de la
// escritura monotonica de B2 (una generacion mas antigua nunca sobrescribe una mas reciente, ver
// B2-RS-C0-H1/H2). Columna ESPECIFICA de rol/activo -- nunca se reutiliza para password ni para la
// version general de la identidad central. NULL deliberado: las filas existentes nunca fueron
// proyectadas desde Control, y legacy nunca lee ni escribe esta columna (D4). Ninguna fila existente
// se toca: ALTER TABLE ADD COLUMN sin DEFAULT deja rol, activo, password y todo lo demas intacto.
async function up004UsuariosCentralRolActivoVersion(db) {
  await runQuery(db, "ALTER TABLE usuarios ADD COLUMN central_rol_activo_version INTEGER");
}

// The catalog caller owns the transaction. Never open a connection or commit here.
async function up005CcOperacionesCobro(db) {
  await runQuery(db, `CREATE TABLE cc_operaciones_cobro (
    operacion_id TEXT PRIMARY KEY NOT NULL CHECK(length(operacion_id) BETWEEN 16 AND 128),
    tipo TEXT NOT NULL CHECK(tipo IN ('VENTA', 'CLIENTE')),
    objetivo_id INTEGER NOT NULL CHECK(typeof(objetivo_id) = 'integer' AND objetivo_id > 0),
    contrato_version INTEGER NOT NULL CHECK(contrato_version = 1),
    peticion_json TEXT NOT NULL CHECK(json_valid(peticion_json)),
    huella TEXT NOT NULL CHECK(length(huella) = 64 AND huella NOT GLOB '*[^0-9a-f]*'),
    estado TEXT NOT NULL CHECK(estado IN ('RESERVADA', 'CONFIRMADA')),
    actor_id INTEGER NOT NULL CHECK(typeof(actor_id) = 'integer' AND actor_id > 0),
    reservada_en TEXT NOT NULL,
    confirmada_en TEXT,
    respuesta_codigo INTEGER,
    resultado_json TEXT CHECK(resultado_json IS NULL OR json_valid(resultado_json)),
    pago_legacy_id INTEGER UNIQUE REFERENCES pagos_cuenta_corriente(id),
    group_id TEXT UNIQUE,
    CHECK ((estado = 'RESERVADA' AND confirmada_en IS NULL AND respuesta_codigo IS NULL
      AND resultado_json IS NULL AND pago_legacy_id IS NULL AND group_id IS NULL)
    OR (estado = 'CONFIRMADA' AND confirmada_en IS NOT NULL
      AND respuesta_codigo IS NOT NULL AND typeof(respuesta_codigo) = 'integer'
      AND respuesta_codigo BETWEEN 200 AND 299 AND resultado_json IS NOT NULL
      AND ((tipo = 'VENTA' AND typeof(pago_legacy_id) = 'integer' AND pago_legacy_id > 0 AND group_id IS NULL)
        OR (tipo = 'CLIENTE' AND pago_legacy_id IS NULL AND group_id IS NOT NULL AND length(group_id) > 0))))
  )`);
  await runQuery(db, `CREATE TRIGGER cc_operaciones_cobro_inmutable
    BEFORE UPDATE ON cc_operaciones_cobro
    WHEN OLD.estado = 'CONFIRMADA' OR NEW.operacion_id IS NOT OLD.operacion_id
      OR NEW.tipo IS NOT OLD.tipo OR NEW.objetivo_id IS NOT OLD.objetivo_id
      OR NEW.contrato_version IS NOT OLD.contrato_version OR NEW.huella IS NOT OLD.huella
      OR NEW.peticion_json IS NOT OLD.peticion_json OR NEW.actor_id IS NOT OLD.actor_id
      OR NEW.reservada_en IS NOT OLD.reservada_en
    BEGIN SELECT RAISE(ABORT, 'CC_OPERATION_IMMUTABLE'); END`);
  await runQuery(db, `CREATE TRIGGER cc_operaciones_cobro_no_delete
    BEFORE DELETE ON cc_operaciones_cobro
    BEGIN SELECT RAISE(ABORT, 'CC_OPERATION_HISTORY_REQUIRED'); END`);
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
  }),
  Object.freeze({
    sequence: 3,
    migrationId: "003_sesiones_password_version",
    kind: "MIGRATION",
    up: up003SesionesPasswordVersion
  }),
  Object.freeze({
    sequence: 4,
    migrationId: "004_usuarios_central_rol_activo_version",
    kind: "MIGRATION",
    up: up004UsuariosCentralRolActivoVersion
  }),
  Object.freeze({
    sequence: 5,
    migrationId: "005_cc_operaciones_cobro",
    kind: "MIGRATION",
    up: up005CcOperacionesCobro
  })
]);

module.exports = {
  BUSINESS_MIGRATIONS
};
