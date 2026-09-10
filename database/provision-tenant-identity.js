// MT-1D.2A: operacion EXPLICITA de provisioning de tenant_identity. Distinta de runtime
// (MT-1D.2B, todavia no implementado): esta herramienta puede escribir la business DB, pero
// SOLO cuando un operador la invoca deliberadamente (CLI o llamada directa) -- nunca desde
// backend/server.js, nunca durante una request comercial, nunca de forma implicita.
//
// NO hace require() de database/init-db.js a proposito: ese modulo abre `new
// sqlite3.Database(GUERNICA_DB_PATH || .../guernica.db)` como side-effect al cargar el archivo
// (linea 5-6 de init-db.js), lo que abriria/crearia la business DB real con solo importarlo.
// Por eso el CREATE TABLE de tenant_identity se replica aca como constante certificada,
// idéntica a la de database/init-db.js, en vez de reutilizar ese modulo.
//
// Si reutiliza database/init-control-db.js (sin efectos secundarios al cargar: todo su codigo
// de arranque vive detras de `if (require.main === module)`), exclusivamente para abrir el
// Control DB en modo LECTURA y resolver el path canonico de una empresa -- nunca para escribir
// alli, y nunca acepta un empresaId sin verificar: el binding siempre se resuelve por slug
// contra la fila real.
const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { resolveEmpresaDbPath } = require("./init-control-db");

// Definicion CERTIFICADA e identica a la de database/init-db.js (ver comentario de cabecera:
// nunca se importa ese archivo para evitar su side-effect de apertura). Si esa definicion
// cambia alguna vez, esta constante debe actualizarse en el mismo commit.
const TENANT_IDENTITY_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS tenant_identity (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        empresa_control_id INTEGER NOT NULL CHECK(typeof(empresa_control_id) = 'integer' AND empresa_control_id > 0),
        tenant_slug TEXT NOT NULL CHECK(typeof(tenant_slug) = 'text' AND length(tenant_slug) > 0 AND tenant_slug = trim(tenant_slug)),
        creado_en TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `;

function crearError(code, message, detalle = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, detalle);
  return error;
}

// Callback explicito en ambas aperturas: sin el, un fallo de apertura de sqlite3 emite un
// evento 'error' sin listener y tumba el proceso entero en vez de rechazar la promesa (mismo
// riesgo ya documentado en centralAuthResolver.js/userControlBridge.js/reconcile-shadow-users.js).
function abrirControlDbSoloLectura(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (error) => {
      if (error) { reject(error); return; }
      resolve(db);
    });
  });
}

// NUNCA OPEN_CREATE: una business DB inexistente debe fallar, jamas materializarse como
// archivo SQLite vacio por un path mal escrito.
function abrirBusinessDbEscritura(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (error) => {
      if (error) { reject(error); return; }
      db.run("PRAGMA foreign_keys = ON", (pragmaError) => {
        if (pragmaError) { db.close(() => reject(pragmaError)); return; }
        resolve(db);
      });
    });
  });
}

function closeDb(db) {
  return new Promise((resolve, reject) => {
    db.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function runQuery(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
}

function getQuery(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) reject(error);
      else resolve(row);
    });
  });
}

function allQuery(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

function esIdentityFilaValida(row) {
  if (!row) return false;
  return Number.isInteger(row.id) && row.id === 1
    && Number.isInteger(row.empresa_control_id) && row.empresa_control_id > 0
    && typeof row.tenant_slug === "string"
    && row.tenant_slug.length > 0
    && row.tenant_slug === row.tenant_slug.trim();
}

async function tablaTenantIdentityExiste(db) {
  const row = await getQuery(
    db,
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name = 'tenant_identity'"
  );
  if (row) {
    // SQLite omite IF NOT EXISTS en sqlite_master. Normalizar solamente espacios
    // fuera de literales permite comparar el DDL certificado sin perder sus CHECK.
    const normalizarSchema = (sql) => String(sql || "")
      .replace(/'(?:''|[^'])*'|\s+/g, (token) => token.startsWith("'") ? token : " ")
      .trim()
      .replace(/^CREATE TABLE IF NOT EXISTS /i, "CREATE TABLE ");
    if (normalizarSchema(row.sql) !== normalizarSchema(TENANT_IDENTITY_SCHEMA_SQL)) {
      throw crearError("TENANT_IDENTITY_INVALID", "tenant_identity existe pero su schema no es el certificado");
    }
  }
  return !!row;
}

// Punto de entrada unico. Los tres inputs son obligatorios: nunca se asume 'guernica',
// 'atlas_control.db' ni 'guernica.db' si el caller no los provee explicitamente. Falta de
// cualquiera de los tres falla ANTES de abrir ninguna DB.
async function provisionarTenantIdentity(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw crearError("INVALID_ARGUMENT", "provisionarTenantIdentity: se requiere un objeto de inputs");
  }
  const { controlDbPath, empresaSlug, businessDbPath } = options;
  if (typeof controlDbPath !== "string" || !controlDbPath.trim()) {
    throw crearError("INVALID_ARGUMENT", "provisionarTenantIdentity: falta controlDbPath");
  }
  const slugIngresado = String(empresaSlug || "").trim();
  if (!slugIngresado) {
    throw crearError("INVALID_ARGUMENT", "provisionarTenantIdentity: falta empresaSlug");
  }
  if (typeof businessDbPath !== "string" || !businessDbPath.trim()) {
    throw crearError("INVALID_ARGUMENT", "provisionarTenantIdentity: falta businessDbPath");
  }

  if (!fs.existsSync(controlDbPath)) {
    throw crearError("CONTROL_DB_NOT_FOUND", `Control DB no encontrado: ${controlDbPath}`);
  }

  let controlDb;
  try {
    controlDb = await abrirControlDbSoloLectura(controlDbPath);
  } catch (error) {
    throw crearError("DB_ERROR", `No se pudo abrir Control DB: ${error.message}`);
  }

  let empresa;
  try {
    // Resolucion EXCLUSIVAMENTE por slug: el caller nunca provee ni puede forzar un empresaId.
    // No se filtra por `activa` aca -- P7 (MTF1): una empresa inactiva SI puede provisionarse
    // (preparar su identidad de antemano), el runtime boot gate (MT-1D.2B, no implementado en
    // este slice) es quien debe negarle servir trafico por estar inactiva.
    const empresaRow = await getQuery(
      controlDb,
      "SELECT id, slug, db_path, activa FROM empresas WHERE slug = ?",
      [slugIngresado]
    );
    if (!empresaRow) {
      throw crearError("EMPRESA_NOT_FOUND", `Empresa '${slugIngresado}' no existe en el control plane`);
    }
    empresa = {
      id: empresaRow.id,
      slug: empresaRow.slug,
      dbPath: empresaRow.db_path,
      activa: Number(empresaRow.activa) === 1
    };
  } finally {
    await closeDb(controlDb);
  }

  // Path binding ANTES de tocar la business DB en escritura. Reutiliza resolveEmpresaDbPath
  // (database/init-control-db.js) como UNICA autoridad de canonicalizacion/anti-traversal --
  // nunca se reimplementa esa logica aca.
  let registryPathResuelto;
  try {
    registryPathResuelto = resolveEmpresaDbPath(empresa.dbPath);
  } catch (error) {
    throw crearError("BUSINESS_DB_PATH_MISMATCH", `db_path registrado invalido: ${error.message}`);
  }
  const businessPathResuelto = path.resolve(businessDbPath);
  if (registryPathResuelto !== businessPathResuelto) {
    throw crearError(
      "BUSINESS_DB_PATH_MISMATCH",
      "El businessDbPath provisto no coincide con el db_path registrado para esta empresa",
      { registryPath: registryPathResuelto, businessDbPath: businessPathResuelto }
    );
  }

  if (!fs.existsSync(businessDbPath)) {
    throw crearError("BUSINESS_DB_NOT_FOUND", `Business DB no encontrada: ${businessDbPath}`);
  }

  let businessDb;
  try {
    businessDb = await abrirBusinessDbEscritura(businessDbPath);
  } catch (error) {
    throw crearError("DB_ERROR", `No se pudo abrir Business DB: ${error.message}`);
  }

  let transactionStarted = false;
  try {
    await runQuery(businessDb, "BEGIN IMMEDIATE");
    transactionStarted = true;

    const existeTabla = await tablaTenantIdentityExiste(businessDb);

    if (!existeTabla) {
      // P1 (schema missing): crear unicamente tenant_identity con el schema certificado, luego
      // sembrar la fila singleton. Ninguna otra tabla se toca.
      await runQuery(businessDb, TENANT_IDENTITY_SCHEMA_SQL);
      await runQuery(
        businessDb,
        "INSERT INTO tenant_identity (id, empresa_control_id, tenant_slug) VALUES (1, ?, ?)",
        [empresa.id, empresa.slug]
      );
      await runQuery(businessDb, "COMMIT");
      transactionStarted = false;
      return { status: "PROVISIONED", empresaId: empresa.id, empresaSlug: empresa.slug, businessDbPath: businessPathResuelto };
    }

    let filas;
    try {
      filas = await allQuery(businessDb, "SELECT id, empresa_control_id, tenant_slug FROM tenant_identity");
    } catch (queryError) {
      await runQuery(businessDb, "ROLLBACK");
      transactionStarted = false;
      throw crearError("TENANT_IDENTITY_INVALID", `tenant_identity existe pero su schema es incompatible: ${queryError.message}`);
    }

    if (filas.length === 0) {
      // P1 (tabla existente pero vacia): mismo seed, tabla ya certificada por su propia
      // definicion previa -- no se recrea.
      await runQuery(
        businessDb,
        "INSERT INTO tenant_identity (id, empresa_control_id, tenant_slug) VALUES (1, ?, ?)",
        [empresa.id, empresa.slug]
      );
      await runQuery(businessDb, "COMMIT");
      transactionStarted = false;
      return { status: "PROVISIONED", empresaId: empresa.id, empresaSlug: empresa.slug, businessDbPath: businessPathResuelto };
    }

    if (filas.length > 1) {
      await runQuery(businessDb, "ROLLBACK");
      transactionStarted = false;
      throw crearError("TENANT_IDENTITY_INVALID", "tenant_identity contiene mas de una fila (schema no certificado)");
    }

    const existente = filas[0];
    if (!esIdentityFilaValida(existente)) {
      await runQuery(businessDb, "ROLLBACK");
      transactionStarted = false;
      throw crearError("TENANT_IDENTITY_INVALID", "tenant_identity contiene una fila malformada", { existente });
    }

    if (existente.empresa_control_id === empresa.id && existente.tenant_slug === empresa.slug) {
      // P2: idempotente. NUNCA UPDATE/DELETE/REPLACE -- nada que escribir.
      await runQuery(businessDb, "ROLLBACK");
      transactionStarted = false;
      return { status: "ALREADY_PROVISIONED", empresaId: empresa.id, empresaSlug: empresa.slug, businessDbPath: businessPathResuelto };
    }

    // P3/P4: mismatch de empresa_control_id y/o tenant_slug. Nunca overwrite/repair.
    await runQuery(businessDb, "ROLLBACK");
    transactionStarted = false;
    throw crearError(
      "TENANT_IDENTITY_MISMATCH",
      "tenant_identity existente no coincide con el binding esperado del control plane",
      {
        existente: { empresaControlId: existente.empresa_control_id, tenantSlug: existente.tenant_slug },
        esperado: { empresaControlId: empresa.id, tenantSlug: empresa.slug }
      }
    );
  } catch (error) {
    if (transactionStarted) {
      try { await runQuery(businessDb, "ROLLBACK"); } catch (rollbackError) { error.rollbackError = rollbackError; }
    }
    throw error;
  } finally {
    await closeDb(businessDb);
  }
}

module.exports = {
  provisionarTenantIdentity,
  TENANT_IDENTITY_SCHEMA_SQL
};

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const flags = {};
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === "--control-db") { flags.controlDbPath = args[i + 1]; i += 1; }
      else if (arg === "--empresa") { flags.empresaSlug = args[i + 1]; i += 1; }
      else if (arg === "--business-db") { flags.businessDbPath = args[i + 1]; i += 1; }
    }

    if (!flags.controlDbPath || !flags.empresaSlug || !flags.businessDbPath) {
      console.error("Uso: node database/provision-tenant-identity.js --control-db <path> --empresa <slug> --business-db <path>");
      process.exit(1);
    }

    try {
      const resultado = await provisionarTenantIdentity(flags);
      console.log(`[provision-tenant-identity] ${resultado.status} empresaId=${resultado.empresaId} empresaSlug=${resultado.empresaSlug}`);
      process.exit(0);
    } catch (error) {
      console.error(`[provision-tenant-identity] FALLO code=${error.code || "UNKNOWN"} message=${error.message}`);
      process.exit(1);
    }
  })();
}
