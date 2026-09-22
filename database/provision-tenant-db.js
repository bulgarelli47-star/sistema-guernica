// MT-1E5D: provisioner operator-only de una empresa NUEVA. Compone las primitivas ya publicadas
// (Control reserve/activate estricto, fresh baseline builder, identity same-connection, verifiers
// same-connection) en una SAGA de dos DBs separadas: Control (SQLite propio) y business (SQLite
// nuevo, propio de esta empresa). No hay transaccion distribuida real entre ambas -- el diseno
// evita cualquier ventana insegura ordenando el flujo asi:
//
//   CONTROL reserve (activa=0, durablemente committed)
//     -> BUSINESS create+CURRENT (una unica transaccion, BEGIN IMMEDIATE..COMMIT)
//       -> CONTROL activate (activa=1)
//
// Nunca al reves: activar Control ANTES de que la business DB este CURRENT dejaria una empresa
// activa con una business DB a medio construir. Este orden es el requisito central del checkpoint.
//
// NO usa init-db.js (CLI local/dev, con su propio seed demo y su propia apertura de conexion como
// side-effect de modulo). NO usa el bridge/adopter/migrator (esos operan sobre un tenant LEGACY que
// ya tiene datos reales; un tenant nuevo no tiene nada que adoptar/migrar mientras el catalogo
// productivo sea exactamente [001]).
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();
const {
  resolveEmpresaDbPath,
  runQuery,
  getQuery,
  closeDb: closeControlDb,
  reservarEmpresaParaProvisioning,
  activarEmpresaReservada
} = require("./init-control-db");
const { crearBaseline001EnConexion } = require("./business-schema-baseline");
const { provisionarTenantIdentityEnConexion } = require("./provision-tenant-identity");
const { verificarLegacyBaselineEnConexion } = require("../backend/legacyBaselineVerifier");
const { verificarBusinessSchemaVersionEnConexion } = require("../backend/businessSchemaVersion");
const { verificarTenantDbIdentityEnConexion } = require("../backend/tenantDbIdentity");
const { BUSINESS_MIGRATIONS } = require("./business-migrations");

function crearError(code, message, detalle = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, detalle);
  return error;
}

// Nunca OPEN_CREATE para Control: un Control DB inexistente debe fallar, jamas materializarse.
function abrirControlDbEscritura(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (error) => {
      if (error) { reject(error); return; }
      resolve(db);
    });
  });
}

// Nunca OPEN_CREATE para lectura de una business DB EXISTENTE (retry/activo/colision): un archivo
// ausente debe fallar, no materializarse.
function abrirBusinessDbSoloLectura(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (error) => {
      if (error) { reject(error); return; }
      resolve(db);
    });
  });
}

// MT-1E5D.1: unica conexion de escritura para una business DB que YA SABEMOS que existe (nunca usa
// OPEN_CREATE) -- usada tanto por la owner real (justo despues de crearla atomicamente, ver
// intentarClaimarCreacionAtomica) como por un follower concurrente que necesita BEGIN IMMEDIATE
// para esperar a que la owner real termine antes de inspeccionar contenido.
function abrirBusinessDbEscrituraExistente(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (error) => {
      if (error) { reject(error); return; }
      resolve(db);
    });
  });
}

// MT-1E5D.1: UNICA senal de ownership real en todo el modulo -- deliberadamente NUNCA derivada de
// contenido/schema/CURRENT state (eso fue el bug que este recovery corrige). fs.open con flag "wx"
// mapea a O_CREAT|O_EXCL a nivel de sistema operativo: exito significa, sin ninguna ventana TOCTOU
// posible, que ESTA invocation transiciono el archivo de inexistente a existente -- el SO garantiza
// que dos llamadas concurrentes nunca pueden tener exito ambas. Fallo con EEXIST significa que el
// archivo YA existia antes de esta llamada, sin importar que tan vacio este por dentro: nunca somos
// la owner en ese caso. Este es el UNICO lugar de todo el modulo que materializa un archivo nuevo.
function intentarClaimarCreacionAtomica(dbPath) {
  return new Promise((resolve, reject) => {
    fs.open(dbPath, "wx", (error, fd) => {
      if (error) {
        if (error.code === "EEXIST") { resolve(false); return; }
        reject(error);
        return;
      }
      fs.close(fd, (closeError) => {
        if (closeError) { reject(closeError); return; }
        resolve(true);
      });
    });
  });
}

function cerrarDbSilencioso(db) {
  return new Promise((resolve) => {
    if (!db) { resolve(); return; }
    db.close(() => resolve());
  });
}

// Solo se invoca cuando intentarClaimarCreacionAtomica ya establecio ownership real (fs.open "wx"
// exitoso) -- nunca por inspeccion de contenido/schema. Limpia unicamente los sidecars de ESE path
// exacto, nunca un glob.
function limpiarArchivosOwned(dbPath) {
  for (const sufijo of ["", "-wal", "-shm", "-journal"]) {
    try { fs.rmSync(dbPath + sufijo, { force: true }); } catch (_error) { /* best-effort */ }
  }
}

function mapearEmpresaControlRow(row) {
  return { id: row.id, slug: row.slug, nombre: row.nombre, dbPath: row.db_path, activa: Number(row.activa) === 1 };
}

// MT-1F5C1: valida la FORMA completa del catalogo (baseline 001 + cero o mas migraciones reales en
// orden) en vez de exigir length===1 -- el provisioner ahora aplica TODA migracion posterior al
// baseline dentro de la MISMA transaccion de creacion (ver construirBusinessFrescaComoOwner). Fail
// closed ante cualquier forma inesperada: nunca provisiona con logica incompleta.
function asegurarCatalogoSoportado() {
  const primero = BUSINESS_MIGRATIONS[0];
  const primeraValida = BUSINESS_MIGRATIONS.length >= 1
    && primero
    && primero.sequence === 1
    && primero.kind === "BASELINE"
    && typeof primero.migrationId === "string"
    && primero.migrationId.length > 0;
  if (!primeraValida) {
    throw crearError(
      "MIGRATION_CATALOG_UNSUPPORTED",
      "provisionarTenantDb: la primera entrada del catalogo debe ser sequence=1, kind=BASELINE, migrationId valido"
    );
  }
  for (let i = 1; i < BUSINESS_MIGRATIONS.length; i += 1) {
    const entrada = BUSINESS_MIGRATIONS[i];
    const entradaValida = entrada
      && entrada.sequence === i + 1
      && entrada.kind === "MIGRATION"
      && typeof entrada.migrationId === "string"
      && entrada.migrationId.length > 0
      && typeof entrada.up === "function";
    if (!entradaValida) {
      throw crearError(
        "MIGRATION_CATALOG_UNSUPPORTED",
        `provisionarTenantDb: entrada de catalogo invalida en posicion ${i} -- se esperaba sequence=${i + 1}, kind=MIGRATION, up(db) callable`
      );
    }
  }
  return primero.migrationId;
}

// Verifica que una business DB YA EXISTENTE (retry inactivo, o colision activa) sea EXACTAMENTE la
// esperada: baseline ready, identity exacta, schema CURRENT. Conexion de solo lectura -- nunca muta
// nada. Cualquier discrepancia falla cerrado (nunca repara, nunca overwrite).
async function verificarBusinessExistenteExacta(businessPathResuelto, { empresaId, empresaSlug }) {
  if (!fs.existsSync(businessPathResuelto)) {
    throw crearError("BUSINESS_DB_NOT_FOUND", `Business DB no encontrada: ${businessPathResuelto}`);
  }
  let businessDb;
  try {
    businessDb = await abrirBusinessDbSoloLectura(businessPathResuelto);
  } catch (error) {
    throw crearError("BUSINESS_DB_ERROR", `No se pudo abrir Business DB: ${error.message}`);
  }
  try {
    const baseline = await verificarLegacyBaselineEnConexion(businessDb);
    if (!baseline.ready) {
      throw crearError("BUSINESS_DB_NOT_CURRENT", "La business DB existente no pasa la verificacion de baseline", { failures: baseline.failures });
    }
    const identidad = await verificarTenantDbIdentityEnConexion(businessDb, { empresaId, empresaSlug });
    if (!identidad.ok) {
      if (identidad.errorCode === "TENANT_DB_IDENTITY_MISMATCH") {
        throw crearError("TENANT_DB_IDENTITY_MISMATCH", identidad.message, { identity: identidad.identity });
      }
      throw crearError("BUSINESS_DB_NOT_CURRENT", `La identity de la business DB existente no es valida (${identidad.errorCode}): ${identidad.message}`);
    }
    const schema = await verificarBusinessSchemaVersionEnConexion(businessDb);
    if (schema.state !== "CURRENT") {
      throw crearError("BUSINESS_DB_NOT_CURRENT", `La business DB existente no esta CURRENT (state=${schema.state})`);
    }
  } finally {
    await cerrarDbSilencioso(businessDb);
  }
}

// Camino comun a los dos retries (inactivo+CURRENT y activo+CURRENT): verificar exactitud y decidir
// el status final. `yaActiva` distingue si Control ya estaba activo (ALREADY_PROVISIONED, sin tocar
// nada) o si todavia esta inactivo y falta activar (ACTIVATED_EXISTING_CURRENT).
async function resolverRetrySobreBusinessExistente({ controlDb, empresa, businessPathResuelto, empresaSlug, yaActiva }) {
  await verificarBusinessExistenteExacta(businessPathResuelto, { empresaId: empresa.id, empresaSlug });

  if (yaActiva) {
    return {
      status: "ALREADY_PROVISIONED",
      empresaId: empresa.id,
      empresaSlug,
      businessDbPath: businessPathResuelto,
      schemaState: "CURRENT"
    };
  }

  const activacion = await activarEmpresaReservada(controlDb, { empresaId: empresa.id, slug: empresaSlug, dbPath: empresa.dbPath });
  return {
    status: "ACTIVATED_EXISTING_CURRENT",
    empresaId: empresa.id,
    empresaSlug,
    businessDbPath: businessPathResuelto,
    schemaState: "CURRENT",
    activation: activacion.status
  };
}

// MT-1E5D.1 (recovery): usado EXCLUSIVAMENTE para el camino "empresa recien reservada, inactiva"
// (RESERVED/ALREADY_RESERVED) -- nunca para la colision activa, que jamas debe poder materializar
// un archivo (ver verificarBusinessExistenteExacta/resolverRetrySobreBusinessExistente mas abajo,
// intactos). Ownership se decide ANTES de tocar sqlite3 en absoluto, via el claim atomico de
// filesystem (ver intentarClaimarCreacionAtomica) -- nunca via contenido/schema, que es lo que este
// recovery corrige. Owner real -> fresh build. No-owner -> verificacion bajo BEGIN IMMEDIATE (fuerza
// a esperar a que cualquier owner concurrente termine antes de inspeccionar, nunca observa un
// estado a medias).
async function crearOResolverBusinessInactiva({ controlDb, empresa, businessPathResuelto, empresaSlug, migrationId }) {
  let esOwnerCreador;
  try {
    esOwnerCreador = await intentarClaimarCreacionAtomica(businessPathResuelto);
  } catch (error) {
    throw crearError("BUSINESS_DB_ERROR", `No se pudo verificar existencia atomica de la Business DB: ${error.message}`);
  }

  if (esOwnerCreador) {
    return await construirBusinessFrescaComoOwner({ controlDb, empresa, businessPathResuelto, empresaSlug, migrationId });
  }

  return await verificarYActivarSobreBusinessExistenteConLock({ controlDb, empresa, businessPathResuelto, empresaSlug, yaActiva: false });
}

// Solo se invoca cuando intentarClaimarCreacionAtomica ya probo, sin ninguna ventana TOCTOU, que
// ESTA invocation transiciono el archivo de inexistente a existente. UNA sola transaccion (BEGIN
// IMMEDIATE..COMMIT) cubre: fresh builder, identity, baseline verify, history [001], identity
// verify, schema verify. Activation ocurre DESPUES del COMMIT exitoso, nunca antes.
async function construirBusinessFrescaComoOwner({ controlDb, empresa, businessPathResuelto, empresaSlug, migrationId }) {
  let businessDb;
  try {
    businessDb = await abrirBusinessDbEscrituraExistente(businessPathResuelto);
  } catch (error) {
    limpiarArchivosOwned(businessPathResuelto);
    throw crearError("BUSINESS_DB_ERROR", `No se pudo abrir la Business DB recien creada: ${error.message}`);
  }

  let transactionStarted = false;
  try {
    try {
      await runQuery(businessDb, "PRAGMA busy_timeout = 5000");
      await runQuery(businessDb, "BEGIN IMMEDIATE");
      transactionStarted = true;
    } catch (error) {
      const codigo = error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED" ? "BUSINESS_DB_BUSY" : "BUSINESS_DB_ERROR";
      throw crearError(codigo, error.message);
    }

    await crearBaseline001EnConexion(businessDb);
    await provisionarTenantIdentityEnConexion(businessDb, { empresaId: empresa.id, empresaSlug });

    const baseline = await verificarLegacyBaselineEnConexion(businessDb);
    if (!baseline.ready) {
      throw crearError("BASELINE_VERIFY_FAILED", "El baseline recien construido no paso la verificacion", { failures: baseline.failures });
    }

    await runQuery(
      businessDb,
      `CREATE TABLE atlas_schema_migrations (
        sequence INTEGER NOT NULL UNIQUE CHECK(sequence >= 1),
        migration_id TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      )`
    );
    await runQuery(
      businessDb,
      "INSERT INTO atlas_schema_migrations (sequence, migration_id, applied_at) VALUES (1, ?, datetime('now'))",
      [migrationId]
    );

    // MT-1F5C1: toda migration real posterior al baseline se aplica AQUI, dentro de la MISMA
    // transaccion de creacion -- una tenant DB nueva nace directamente CURRENT contra el catalogo
    // completo, nunca BEHIND. Nunca invoca database/migrate-tenant-db.js (herramienta separada,
    // pensada para DBs YA EXISTENTES).
    for (let i = 1; i < BUSINESS_MIGRATIONS.length; i += 1) {
      const migracion = BUSINESS_MIGRATIONS[i];
      await migracion.up(businessDb);
      await runQuery(
        businessDb,
        "INSERT INTO atlas_schema_migrations (sequence, migration_id, applied_at) VALUES (?, ?, datetime('now'))",
        [migracion.sequence, migracion.migrationId]
      );
    }

    const identidad = await verificarTenantDbIdentityEnConexion(businessDb, { empresaId: empresa.id, empresaSlug });
    if (!identidad.ok) {
      throw crearError(identidad.errorCode, identidad.message);
    }

    const schema = await verificarBusinessSchemaVersionEnConexion(businessDb);
    if (schema.state !== "CURRENT") {
      throw crearError("SCHEMA_HISTORY_FAILED", `El schema no quedo CURRENT tras escribir history (state=${schema.state})`);
    }

    await runQuery(businessDb, "COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try { await runQuery(businessDb, "ROLLBACK"); } catch (rollbackError) { error.rollbackError = rollbackError; }
    }
    await cerrarDbSilencioso(businessDb);
    // Owned con certeza absoluta: el claim atomico (fs.open "wx") ya establecio, antes de que sqlite3
    // siquiera tocara el archivo, que ESTA invocation lo transiciono de inexistente a existente.
    limpiarArchivosOwned(businessPathResuelto);
    throw error;
  }

  await cerrarDbSilencioso(businessDb);

  // Business ya CURRENT y committed. Solo ahora se activa Control -- un fallo aqui NUNCA debe
  // borrar ni tocar la business DB ya committed.
  try {
    await activarEmpresaReservada(controlDb, { empresaId: empresa.id, slug: empresaSlug, dbPath: empresa.dbPath });
  } catch (activationError) {
    throw crearError(
      "CONTROL_ACTIVATION_FAILED",
      `La business DB quedo CURRENT pero la activacion en Control fallo: ${activationError.message}`,
      { cause: activationError, empresaId: empresa.id, empresaSlug, businessDbPath: businessPathResuelto }
    );
  }

  return {
    status: "PROVISIONED",
    empresaId: empresa.id,
    empresaSlug,
    businessDbPath: businessPathResuelto,
    schemaState: "CURRENT"
  };
}

// Se invoca cuando intentarClaimarCreacionAtomica ya probo que ESTA invocation NUNCA es la owner
// (el archivo ya existia antes de nuestra llamada, sin importar que tan vacio este). BEGIN IMMEDIATE
// aqui es deliberado: fuerza a esta invocation a esperar (busy_timeout) a que cualquier owner
// concurrente termine su propia transaccion antes de poder inspeccionar contenido -- nunca observa
// un estado a medias. Conexion de solo lectura logica: jamas escribe (ROLLBACK siempre al final,
// nunca COMMIT). Si el contenido resulta genuinamente vacio/no-CURRENT bajo este lock, es una DB
// preexistente rota o una saga previa incompleta -- nunca esta invocation la creo, nunca se limpia.
async function verificarYActivarSobreBusinessExistenteConLock({ controlDb, empresa, businessPathResuelto, empresaSlug, yaActiva }) {
  let businessDb;
  try {
    businessDb = await abrirBusinessDbEscrituraExistente(businessPathResuelto);
  } catch (error) {
    throw crearError("BUSINESS_DB_ERROR", `No se pudo abrir Business DB: ${error.message}`);
  }

  let transactionStarted = false;
  try {
    await runQuery(businessDb, "PRAGMA busy_timeout = 5000");
    await runQuery(businessDb, "BEGIN IMMEDIATE");
    transactionStarted = true;
  } catch (error) {
    await cerrarDbSilencioso(businessDb);
    const codigo = error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED" ? "BUSINESS_DB_BUSY" : "BUSINESS_DB_ERROR";
    throw crearError(codigo, error.message);
  }

  try {
    const baseline = await verificarLegacyBaselineEnConexion(businessDb);
    if (!baseline.ready) {
      throw crearError("BUSINESS_DB_NOT_CURRENT", "La business DB existente no pasa la verificacion de baseline", { failures: baseline.failures });
    }
    const identidad = await verificarTenantDbIdentityEnConexion(businessDb, { empresaId: empresa.id, empresaSlug });
    if (!identidad.ok) {
      if (identidad.errorCode === "TENANT_DB_IDENTITY_MISMATCH") {
        throw crearError("TENANT_DB_IDENTITY_MISMATCH", identidad.message, { identity: identidad.identity });
      }
      throw crearError("BUSINESS_DB_NOT_CURRENT", `La identity de la business DB existente no es valida (${identidad.errorCode}): ${identidad.message}`);
    }
    const schema = await verificarBusinessSchemaVersionEnConexion(businessDb);
    if (schema.state !== "CURRENT") {
      throw crearError("BUSINESS_DB_NOT_CURRENT", `La business DB existente no esta CURRENT (state=${schema.state})`);
    }
  } finally {
    if (transactionStarted) {
      try { await runQuery(businessDb, "ROLLBACK"); } catch (_error) { /* no-op, no se escribio nada */ }
    }
    await cerrarDbSilencioso(businessDb);
  }

  if (yaActiva) {
    return {
      status: "ALREADY_PROVISIONED",
      empresaId: empresa.id,
      empresaSlug,
      businessDbPath: businessPathResuelto,
      schemaState: "CURRENT"
    };
  }

  const activacion = await activarEmpresaReservada(controlDb, { empresaId: empresa.id, slug: empresaSlug, dbPath: empresa.dbPath });
  return {
    status: "ACTIVATED_EXISTING_CURRENT",
    empresaId: empresa.id,
    empresaSlug,
    businessDbPath: businessPathResuelto,
    schemaState: "CURRENT",
    activation: activacion.status
  };
}

async function ejecutarProvisioning({ controlDbPath, empresaSlug, empresaNombre, businessDbPath }) {
  const migrationId = asegurarCatalogoSoportado();

  let businessPathResuelto;
  try {
    businessPathResuelto = resolveEmpresaDbPath(businessDbPath);
  } catch (error) {
    throw crearError("INVALID_ARGUMENT", `provisionarTenantDb: businessDbPath invalido: ${error.message}`);
  }

  if (!fs.existsSync(controlDbPath)) {
    throw crearError("CONTROL_DB_NOT_FOUND", `Control DB no encontrado: ${controlDbPath}`);
  }

  let controlDb;
  try {
    controlDb = await abrirControlDbEscritura(controlDbPath);
  } catch (error) {
    throw crearError("CONTROL_DB_ERROR", `No se pudo abrir Control DB: ${error.message}`);
  }

  try {
    // ===== FASE 1: CONTROL RESERVATION (siempre primero, siempre durable antes de tocar business) =====
    let empresa;
    try {
      const reserva = await reservarEmpresaParaProvisioning(controlDb, {
        slug: empresaSlug,
        nombre: empresaNombre,
        dbPath: businessDbPath
      });
      empresa = reserva.empresa;
    } catch (reservaError) {
      if (reservaError.code === "COMPANY_ALREADY_ACTIVE") {
        // Colision activa: nunca asumir exito -- leer la fila real y verificar slug/nombre/path
        // exactos antes de siquiera considerar ALREADY_PROVISIONED.
        const fila = await getQuery(controlDb, "SELECT id, slug, nombre, db_path, activa FROM empresas WHERE slug = ?", [empresaSlug]);
        if (!fila) throw reservaError;
        const empresaActiva = mapearEmpresaControlRow(fila);

        if (empresaActiva.nombre !== empresaNombre) {
          throw crearError("COMPANY_RESERVATION_MISMATCH", "La empresa activa existente no coincide con el nombre solicitado", { existente: empresaActiva });
        }
        let pathRegistradoResuelto;
        try {
          pathRegistradoResuelto = resolveEmpresaDbPath(empresaActiva.dbPath);
        } catch (error) {
          throw crearError("BUSINESS_DB_PATH_MISMATCH", `db_path registrado invalido: ${error.message}`);
        }
        if (pathRegistradoResuelto !== businessPathResuelto) {
          throw crearError(
            "BUSINESS_DB_PATH_MISMATCH",
            "El businessDbPath provisto no coincide con el db_path registrado para esta empresa activa",
            { registryPath: pathRegistradoResuelto, businessDbPath: businessPathResuelto }
          );
        }

        return await resolverRetrySobreBusinessExistente({
          controlDb, empresa: empresaActiva, businessPathResuelto, empresaSlug, yaActiva: true
        });
      }
      if (reservaError.code === "COMPANY_RESERVATION_MISMATCH") {
        // Re-diagnosticar: si el campo que difiere es especificamente el path, usar el codigo mas
        // preciso ya establecido por otras herramientas (BUSINESS_DB_PATH_MISMATCH) en vez del
        // generico COMPANY_RESERVATION_MISMATCH.
        const fila = await getQuery(controlDb, "SELECT id, slug, nombre, db_path, activa FROM empresas WHERE slug = ?", [empresaSlug]);
        if (fila && fila.db_path !== businessDbPath) {
          throw crearError(
            "BUSINESS_DB_PATH_MISMATCH",
            "El businessDbPath provisto no coincide con el db_path registrado para esta reserva existente",
            { registryPath: fila.db_path, businessDbPath }
          );
        }
        throw reservaError;
      }
      throw reservaError;
    }

    // empresa.activa === false en este punto siempre (RESERVED o ALREADY_RESERVED). La decision
    // fresh-vs-existente se toma DENTRO de crearOResolverBusinessInactiva, bajo el lock exclusivo
    // de BEGIN IMMEDIATE -- nunca antes via fs.existsSync (ver comentario de esa funcion).
    return await crearOResolverBusinessInactiva({ controlDb, empresa, businessPathResuelto, empresaSlug, migrationId });
  } finally {
    await closeControlDb(controlDb).catch(() => {});
  }
}

// Wrapper sincrono: valida inputs ANTES de cualquier I/O y recien despues devuelve la promesa
// interna. Ningun default a paths reales, ningun fallback a variables de entorno, ningun
// empresaId de entrada -- el id siempre sale de la reservation de Control.
function provisionarTenantDb(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw crearError("INVALID_ARGUMENT", "provisionarTenantDb: se requiere un objeto de inputs");
  }
  const { controlDbPath, empresaSlug, empresaNombre, businessDbPath } = options;
  if (typeof controlDbPath !== "string" || !controlDbPath.trim()) {
    throw crearError("INVALID_ARGUMENT", "provisionarTenantDb: falta controlDbPath");
  }
  const slug = typeof empresaSlug === "string" ? empresaSlug : "";
  if (!slug || slug !== slug.trim()) {
    throw crearError("INVALID_ARGUMENT", "provisionarTenantDb: falta empresaSlug valido");
  }
  if (typeof empresaNombre !== "string" || !empresaNombre.trim()) {
    throw crearError("INVALID_ARGUMENT", "provisionarTenantDb: falta empresaNombre");
  }
  if (typeof businessDbPath !== "string" || !businessDbPath.trim()) {
    throw crearError("INVALID_ARGUMENT", "provisionarTenantDb: falta businessDbPath");
  }

  return ejecutarProvisioning({ controlDbPath, empresaSlug: slug, empresaNombre, businessDbPath });
}

module.exports = {
  provisionarTenantDb
};
