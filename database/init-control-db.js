const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const ALLOWED_DB_DIR = __dirname;
const DEFAULT_DB_PATH = path.join(ALLOWED_DB_DIR, "atlas_control.db");

const GUERNICA_SEED = {
  slug: "guernica",
  nombre: "Guernica",
  dbPath: "guernica.db",
  activa: 1
};

function openDb(dbPath) {
  const db = new sqlite3.Database(dbPath);
  // Ambas tablas nuevas (usuarios, usuario_empresas) viven en este mismo archivo, asi que sus
  // FKs pueden ser reales -- pero sqlite3 no las aplica salvo que se active este pragma por
  // conexion. No afecta a "empresas" (no tiene columnas FK).
  db.run("PRAGMA foreign_keys = ON");
  return db;
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

function resolveEmpresaDbPath(candidatePath) {
  const resolved = path.resolve(ALLOWED_DB_DIR, candidatePath);
  const normalizedRoot = ALLOWED_DB_DIR + path.sep;
  if (resolved !== ALLOWED_DB_DIR && !resolved.startsWith(normalizedRoot)) {
    throw new Error(`Ruta de base de datos fuera del directorio permitido: ${candidatePath}`);
  }
  return resolved;
}

// AUTH-SYNC-B2-S0: evolucion segura de una tabla YA EXISTENTE -- ALTER TABLE ADD COLUMN es la unica
// forma de agregar `version` a una `usuarios`/`usuario_empresas` que ya tenia filas (CREATE TABLE IF
// NOT EXISTS es un no-op ahi). Ademas de chequear si la columna ya existe (para que correr esto
// repetidamente sea siempre seguro), rechaza explicitamente un esquema incompatible: si `version` ya
// existe pero con un tipo declarado distinto de INTEGER (p.ej. una columna homonima de otro origen),
// tira un error claro en vez de asumir en silencio que es la misma columna que este slice espera.
async function asegurarColumnaVersion(db, tabla) {
  const columnas = await allQuery(db, `PRAGMA table_info(${tabla})`);
  const existente = columnas.find((columna) => columna.name === "version");
  if (!existente) {
    await runQuery(db, `ALTER TABLE ${tabla} ADD COLUMN version INTEGER NOT NULL DEFAULT 0`);
    return;
  }
  if (String(existente.type || "").toUpperCase() !== "INTEGER") {
    throw new Error(
      `asegurarColumnaVersion: la tabla '${tabla}' ya tiene una columna 'version' con tipo incompatible ` +
      `('${existente.type}', se esperaba INTEGER) -- esquema incompatible, no se altera automaticamente`
    );
  }
}

// AUTH-SYNC-B2-S0-TX-FIX1: toda la evolucion de esquema corre dentro de UNA transaccion real
// (BEGIN IMMEDIATE/COMMIT/ROLLBACK), mismo patron ya establecido en este codebase para multiples
// sentencias sobre atlas_control.db que deben tener exito o fallar juntas (ver
// userControlBridge.js:syncUserCreate, reconcile-shadow-users.js:crearIdentidadYMembershipDesdeLocal/
// repararPasswordYAcceso). Antes de este fix, cada CREATE TABLE/ALTER TABLE/CREATE INDEX corria en
// autocommit individual: un fallo a mitad de la secuencia dejaba las sentencias previas persistidas
// permanentemente, sin reversion -- la unica garantia existente era que un REINTENTO posterior
// completaba lo faltante (idempotencia), nunca que el fallo en si dejara el archivo intacto. Ambas
// garantias son distintas: esta funcion ahora provee la segunda (rollback real), no solo la primera.
// transactionStarted arranca en false y solo pasa a true DESPUES de que BEGIN IMMEDIATE tuvo exito:
// si BEGIN IMMEDIATE mismo fallara (DB bloqueada, etc.), el catch no debe intentar un ROLLBACK sin
// transaccion abierta.
async function initControlSchema(db) {
  let transactionStarted = false;
  try {
    await runQuery(db, "BEGIN IMMEDIATE");
    transactionStarted = true;

    await runQuery(
      db,
      `CREATE TABLE IF NOT EXISTS empresas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        nombre TEXT NOT NULL,
        db_path TEXT NOT NULL,
        activa INTEGER NOT NULL DEFAULT 1,
        creado_en TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    );

    // MT-1B.1: identidad central en modo SHADOW. usuario_referencia/email NO son UNIQUE a
    // proposito -- dos empresas distintas pueden tener hoy un usuario local "juan" sin evidencia
    // de que sea la misma persona; nunca se fusiona por username/email en esta fase.
    await runQuery(
      db,
      `CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        usuario_referencia TEXT,
        password_hash TEXT NOT NULL,
        email TEXT,
        telefono TEXT,
        foto_url TEXT,
        activo INTEGER NOT NULL DEFAULT 1,
        ultimo_acceso TEXT,
        intentos_fallidos INTEGER NOT NULL DEFAULT 0,
        bloqueado_hasta TEXT,
        creado_en TEXT NOT NULL DEFAULT (datetime('now')),
        actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    );

    // rol vive aca (por empresa), no en usuarios central. usuario_local_id no tiene FK real
    // porque referencia una fila en OTRO archivo SQLite (la DB de esa empresa); usuario_id y
    // empresa_id si son FK reales, porque ambas tablas conviven en este mismo archivo.
    await runQuery(
      db,
      `CREATE TABLE IF NOT EXISTS usuario_empresas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
        empresa_id INTEGER NOT NULL REFERENCES empresas(id),
        usuario_local_id INTEGER NOT NULL,
        rol TEXT NOT NULL,
        activo INTEGER NOT NULL DEFAULT 1,
        creado_en TEXT NOT NULL DEFAULT (datetime('now')),
        actualizado_en TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (empresa_id, usuario_local_id),
        UNIQUE (usuario_id, empresa_id)
      )`
    );

    // AUTH-SYNC-B2-S0: version de identidad global y de membership, para CAS (compare-and-swap) en
    // los slices que escriben central-first (no implementado aun -- este slice SOLO instala el
    // esquema). ALTER TABLE ADD COLUMN es la unica forma segura de evolucionar una tabla que YA
    // EXISTE: "CREATE TABLE IF NOT EXISTS" de arriba es un no-op sobre una tabla ya creada sin esta
    // columna, tanto en la atlas_control.db real como en cualquier fixture de test ya bootstrapeada
    // con el esquema viejo. PRAGMA table_info se consulta antes de alterar para que correr
    // initControlSchema repetidamente (bootstrapControlDb ya lo hace en cada test) sea siempre
    // seguro, sobre una DB nueva o sobre una que ya tiene usuarios/memberships reales. Los valores
    // existentes quedan en 0 (estable, determinista) -- ningun UPDATE existente de autenticacion se
    // modifica en este slice, asi que nada incrementa esta columna todavia.
    await asegurarColumnaVersion(db, "usuarios");
    await asegurarColumnaVersion(db, "usuario_empresas");

    // AUTH-SYNC-B2-S0: outbox de sincronizacion pendiente hacia Business DB (AUTH-SYNC-B2-CONTRACT-
    // FREEZE seccion 1). Vive exclusivamente en este archivo -- nunca en Business DB -- porque quien
    // la genera es siempre la escritura central que ACABA de confirmarse: registrar el pendiente en
    // el lado que puede estar fallando (Business DB) fue exactamente la contradiccion que invalido el
    // diseno anterior (AUTH-SYNC-B2-DESIGN-HARDENING seccion 2, C/D). Nunca almacena el valor
    // objetivo (password_hash/rol/activo) -- solo referencia el (membership, tipo) que el
    // reconciliador debe releer al procesar, para que siempre sincronice el estado central VIGENTE en
    // ese momento, nunca un valor capturado que pudo quedar viejo. UNIQUE(membership_id,
    // tipo_operacion) es la regla anti-duplicados: una segunda operacion sobre el mismo (membership,
    // tipo) actualiza la fila existente con una version_objetivo mas nueva, nunca inserta una segunda
    // fila -- asi ninguna operacion se pierde por quedar tapada detras de otra ya encolada.
    // version_objetivo funciona ademas como la "generacion" de esa fila: el futuro cierre
    // (marcar estado='procesado') debe condicionar su UPDATE a "AND version_objetivo = <el valor
    // leido al empezar a procesar esa fila>" -- si una operacion mas nueva ya la actualizo mientras
    // tanto, ese UPDATE de cierre afecta 0 filas y la fila sigue pendiente con la generacion nueva,
    // nunca se pierde ni una operacion vieja puede cerrar una generacion posterior.
    await runQuery(
      db,
      `CREATE TABLE IF NOT EXISTS sync_pendiente (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
        empresa_id INTEGER NOT NULL REFERENCES empresas(id),
        membership_id INTEGER NOT NULL REFERENCES usuario_empresas(id),
        usuario_local_id INTEGER NOT NULL,
        tipo_operacion TEXT NOT NULL CHECK (tipo_operacion IN ('rol_activo','password')),
        version_objetivo INTEGER NOT NULL,
        estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','procesado')),
        creado_en TEXT NOT NULL DEFAULT (datetime('now')),
        procesado_en TEXT,
        UNIQUE (membership_id, tipo_operacion)
      )`
    );
    await runQuery(db, "CREATE INDEX IF NOT EXISTS idx_sync_pendiente_estado ON sync_pendiente(estado)");
    await runQuery(db, "CREATE INDEX IF NOT EXISTS idx_sync_pendiente_usuario ON sync_pendiente(usuario_id)");

    // AUTH-SYNC-B2-S0: idempotencia de solicitudes administrativas (CONTRACT-FREEZE seccion 4).
    // Garantia DISTINTA de version_objetivo/CAS: esto protege contra reintentos de la MISMA solicitud
    // HTTP (respuesta perdida, timeout de red), no contra escrituras basadas en datos viejos.
    // solicitud_huella es un hash de los campos NO sensibles de la solicitud (endpoint + destino +
    // expected_version + valores no secretos del payload, p.ej. rol/activo) -- para password NUNCA
    // incluye la contrasena ni su hash: el hash de bcrypt no es deterministico entre llamadas (salt
    // aleatorio), compararlo no detectaria "mismo contenido" de forma confiable, y persistir
    // cualquier derivado de la contrasena aca seria un dato sensible innecesario que el contrato
    // prohibe explicitamente. estado distingue una solicitud todavia en vuelo (registrada ANTES de
    // intentar la escritura central, para poder detectar un reintento concurrente mientras la primera
    // sigue en curso) de una ya confirmada con resultado disponible para devolver sin reejecutar nada.
    await runQuery(
      db,
      `CREATE TABLE IF NOT EXISTS operacion_idempotencia (
        clave TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL,
        usuario_id INTEGER REFERENCES usuarios(id),
        membership_id INTEGER REFERENCES usuario_empresas(id),
        solicitud_huella TEXT NOT NULL,
        estado TEXT NOT NULL DEFAULT 'en_progreso' CHECK (estado IN ('en_progreso','confirmada')),
        resultado_http INTEGER,
        resultado_json TEXT,
        creado_en TEXT NOT NULL DEFAULT (datetime('now')),
        confirmada_en TEXT
      )`
    );
    await runQuery(db, "CREATE INDEX IF NOT EXISTS idx_operacion_idempotencia_usuario ON operacion_idempotencia(usuario_id)");

    await runQuery(db, "COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        await runQuery(db, "ROLLBACK");
      } catch (rollbackError) {
        // No reemplazar el error original: se adjunta como contexto adicional, nunca se relanza en
        // su lugar. Mismo criterio ya establecido en userControlBridge.js/reconcile-shadow-users.js.
        error.rollbackError = rollbackError;
      }
    }
    throw error;
  }
}

async function crearUsuarioCentral(db, {
  nombre, usuarioReferencia, passwordHash, email, telefono, fotoUrl,
  activo = 1, ultimoAcceso, intentosFallidos = 0, bloqueadoHasta, creadoEn
}) {
  const result = await runQuery(
    db,
    `INSERT INTO usuarios
       (nombre, usuario_referencia, password_hash, email, telefono, foto_url,
        activo, ultimo_acceso, intentos_fallidos, bloqueado_hasta, creado_en, actualizado_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), datetime('now'))`,
    [
      nombre, usuarioReferencia || null, passwordHash, email || null, telefono || null, fotoUrl || null,
      activo ? 1 : 0, ultimoAcceso || null, intentosFallidos || 0, bloqueadoHasta || null, creadoEn || null
    ]
  );
  return getQuery(db, "SELECT * FROM usuarios WHERE id = ?", [result.lastID]);
}

async function actualizarUsuarioCentral(db, usuarioId, {
  nombre, usuarioReferencia, passwordHash, email, telefono, fotoUrl,
  activo, ultimoAcceso, intentosFallidos, bloqueadoHasta
}) {
  await runQuery(
    db,
    `UPDATE usuarios SET
       nombre = ?, usuario_referencia = ?, password_hash = ?, email = ?, telefono = ?, foto_url = ?,
       activo = ?, ultimo_acceso = ?, intentos_fallidos = ?, bloqueado_hasta = ?, actualizado_en = datetime('now')
     WHERE id = ?`,
    [
      nombre, usuarioReferencia || null, passwordHash, email || null, telefono || null, fotoUrl || null,
      activo ? 1 : 0, ultimoAcceso || null, intentosFallidos || 0, bloqueadoHasta || null, usuarioId
    ]
  );
  return getQuery(db, "SELECT * FROM usuarios WHERE id = ?", [usuarioId]);
}

async function crearMembership(db, { usuarioId, empresaId, usuarioLocalId, rol, activo = 1 }) {
  await runQuery(
    db,
    `INSERT INTO usuario_empresas (usuario_id, empresa_id, usuario_local_id, rol, activo)
     VALUES (?, ?, ?, ?, ?)`,
    [usuarioId, empresaId, usuarioLocalId, rol, activo ? 1 : 0]
  );
  return getQuery(db, "SELECT * FROM usuario_empresas WHERE empresa_id = ? AND usuario_local_id = ?", [empresaId, usuarioLocalId]);
}

async function actualizarMembership(db, membershipId, { rol, activo }) {
  await runQuery(
    db,
    `UPDATE usuario_empresas SET rol = ?, activo = ?, actualizado_en = datetime('now') WHERE id = ?`,
    [rol, activo ? 1 : 0, membershipId]
  );
  return getQuery(db, "SELECT * FROM usuario_empresas WHERE id = ?", [membershipId]);
}

// MT-1C.1B-CLOSE: update angosto para el bridge de PUT /usuarios/:id -- rol Y activo se
// sincronizan en UNA sola sentencia, para que la membership nunca pueda quedar en un estado
// intermedio (rol nuevo con activo viejo, o viceversa) si algo interrumpe al proceso entre dos
// UPDATE separados. NO toca usuario_id/empresa_id/usuario_local_id/creado_en.
async function actualizarAccesoMembership(db, membershipId, { rol, activo }) {
  const result = await runQuery(
    db,
    `UPDATE usuario_empresas SET rol = ?, activo = ?, actualizado_en = datetime('now') WHERE id = ?`,
    [rol, activo ? 1 : 0, membershipId]
  );
  if (result.changes !== 1) {
    throw new Error(`actualizarAccesoMembership: se esperaba actualizar exactamente 1 fila (membershipId=${membershipId}), se actualizaron ${result.changes}`);
  }
}

// MT-1C.1B: update angosto de un solo campo -- lo sigue usando PATCH /usuarios/:id/estado, que
// SOLO debe tocar activo (nunca rol) para no pisar el rol vigente con un valor stale.
async function actualizarActivoMembership(db, membershipId, activo) {
  const result = await runQuery(
    db,
    `UPDATE usuario_empresas SET activo = ?, actualizado_en = datetime('now') WHERE id = ?`,
    [activo ? 1 : 0, membershipId]
  );
  if (result.changes !== 1) {
    throw new Error(`actualizarActivoMembership: se esperaba actualizar exactamente 1 fila (membershipId=${membershipId}), se actualizaron ${result.changes}`);
  }
}

async function getMembershipPorEmpresaYLocal(db, { empresaId, usuarioLocalId }) {
  return getQuery(
    db,
    "SELECT * FROM usuario_empresas WHERE empresa_id = ? AND usuario_local_id = ?",
    [empresaId, usuarioLocalId]
  );
}

async function registrarEmpresa(db, { slug, nombre, dbPath, activa = 1 }) {
  resolveEmpresaDbPath(dbPath);
  await runQuery(
    db,
    `INSERT INTO empresas (slug, nombre, db_path, activa)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       nombre = excluded.nombre,
       db_path = excluded.db_path,
       activa = excluded.activa`,
    [slug, nombre, dbPath, activa ? 1 : 0]
  );
  return getQuery(db, "SELECT * FROM empresas WHERE slug = ?", [slug]);
}

async function seedGuernica(db) {
  return registrarEmpresa(db, GUERNICA_SEED);
}

// MT-1C.1A: update deliberadamente angosto para el bridge de password -- a diferencia de
// actualizarUsuarioCentral (que reescribe nombre/email/telefono/foto/activo/lockout juntos),
// esta funcion NUNCA debe poder vaciar ningun otro campo de la identidad central al sincronizar
// solo el hash.
async function actualizarPasswordUsuarioCentral(db, usuarioId, passwordHash) {
  const result = await runQuery(
    db,
    `UPDATE usuarios SET password_hash = ?, actualizado_en = datetime('now') WHERE id = ?`,
    [passwordHash, usuarioId]
  );
  if (result.changes !== 1) {
    throw new Error(`actualizarPasswordUsuarioCentral: se esperaba actualizar exactamente 1 fila (usuarioId=${usuarioId}), se actualizaron ${result.changes}`);
  }
}

async function bootstrapControlDb(dbPath = DEFAULT_DB_PATH, { seed = true } = {}) {
  const db = openDb(dbPath);
  await initControlSchema(db);
  if (seed) await seedGuernica(db);
  return db;
}

function crearErrorControl(code, message, detalle = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, detalle);
  return error;
}

function esErrorUniqueConstraint(error) {
  return !!error && (error.code === "SQLITE_CONSTRAINT" || /UNIQUE constraint failed/i.test(error.message || ""));
}

function mapearEmpresaRow(row) {
  return { id: row.id, slug: row.slug, nombre: row.nombre, dbPath: row.db_path, activa: Number(row.activa) === 1 };
}

// MT-1E5B: reserva ESTRICTA de una empresa nueva para provisioning -- deliberadamente separada de
// registrarEmpresa (que preserva su UPSERT legacy sin cambios, ver comentario de esa funcion). NUNCA
// hace ON CONFLICT DO UPDATE: un slug colisionando siempre se resuelve leyendo la fila real y
// comparando, jamas sobrescribiendo. Recibe `db` ya abierto por el caller -- no abre conexion propia,
// no BEGIN/COMMIT/ROLLBACK propio; el caller (futuro database/provision-tenant-db.js) controla la
// transaccion si la necesita.
async function reservarEmpresaParaProvisioning(db, { slug, nombre, dbPath } = {}) {
  if (!db) {
    throw crearErrorControl("INVALID_ARGUMENT", "reservarEmpresaParaProvisioning: falta db");
  }
  const slugValidado = typeof slug === "string" ? slug : "";
  if (!slugValidado || slugValidado !== slugValidado.trim()) {
    throw crearErrorControl("INVALID_ARGUMENT", "reservarEmpresaParaProvisioning: slug invalido");
  }
  if (typeof nombre !== "string" || !nombre.trim()) {
    throw crearErrorControl("INVALID_ARGUMENT", "reservarEmpresaParaProvisioning: falta nombre");
  }
  if (typeof dbPath !== "string" || !dbPath.trim()) {
    throw crearErrorControl("INVALID_ARGUMENT", "reservarEmpresaParaProvisioning: falta dbPath");
  }
  // Reutiliza EXACTAMENTE la misma autoridad de path que ya usa Control (resolveEmpresaDbPath) --
  // solo para validar/rechazar, nunca para transformar el valor almacenado: empresas.db_path guarda
  // el string tal como lo pasa el caller (igual que registrarEmpresa), nunca la ruta absoluta resuelta.
  try {
    resolveEmpresaDbPath(dbPath);
  } catch (error) {
    throw crearErrorControl("INVALID_ARGUMENT", `reservarEmpresaParaProvisioning: dbPath invalido: ${error.message}`);
  }

  let insertResult;
  try {
    insertResult = await runQuery(
      db,
      `INSERT INTO empresas (slug, nombre, db_path, activa) VALUES (?, ?, ?, 0)`,
      [slugValidado, nombre, dbPath]
    );
  } catch (error) {
    if (!esErrorUniqueConstraint(error)) throw error;

    // Slug ya existe: nunca reintentar el INSERT ni caer a un UPDATE. Leer la fila real y decidir
    // exclusivamente en base a su estado actual.
    const existente = await getQuery(
      db,
      "SELECT id, slug, nombre, db_path, activa FROM empresas WHERE slug = ?",
      [slugValidado]
    );
    if (!existente) throw error;

    if (Number(existente.activa) === 1) {
      throw crearErrorControl(
        "COMPANY_ALREADY_ACTIVE",
        `La empresa '${slugValidado}' ya existe y esta activa`,
        { empresa: mapearEmpresaRow(existente) }
      );
    }

    if (existente.nombre !== nombre || existente.db_path !== dbPath) {
      throw crearErrorControl(
        "COMPANY_RESERVATION_MISMATCH",
        `La reserva existente para '${slugValidado}' no coincide con los datos provistos`,
        { existente: mapearEmpresaRow(existente), esperado: { slug: slugValidado, nombre, dbPath } }
      );
    }

    return { status: "ALREADY_RESERVED", empresa: mapearEmpresaRow(existente) };
  }

  return {
    status: "RESERVED",
    empresa: { id: insertResult.lastID, slug: slugValidado, nombre, dbPath, activa: false }
  };
}

// MT-1E5B: activacion ESTRICTA de una reserva ya existente. UNICAMENTE toca la columna `activa` --
// nunca slug/nombre/db_path (a proposito, activation no acepta `nombre` como input siquiera). Mismo
// contrato de conexion/transaccion que reservarEmpresaParaProvisioning: recibe `db`, no abre ni
// controla nada propio.
async function activarEmpresaReservada(db, { empresaId, slug, dbPath } = {}) {
  if (!db) {
    throw crearErrorControl("INVALID_ARGUMENT", "activarEmpresaReservada: falta db");
  }
  const idValidado = Number.isInteger(empresaId) && empresaId > 0 ? empresaId : null;
  if (!idValidado) {
    throw crearErrorControl("INVALID_ARGUMENT", "activarEmpresaReservada: falta empresaId valido");
  }
  const slugValidado = typeof slug === "string" ? slug : "";
  if (!slugValidado || slugValidado !== slugValidado.trim()) {
    throw crearErrorControl("INVALID_ARGUMENT", "activarEmpresaReservada: slug invalido");
  }
  if (typeof dbPath !== "string" || !dbPath.trim()) {
    throw crearErrorControl("INVALID_ARGUMENT", "activarEmpresaReservada: falta dbPath");
  }

  const existente = await getQuery(
    db,
    "SELECT id, slug, nombre, db_path, activa FROM empresas WHERE id = ?",
    [idValidado]
  );
  if (!existente) {
    throw crearErrorControl("EMPRESA_NOT_FOUND", `activarEmpresaReservada: no existe empresa con id=${idValidado}`);
  }

  if (existente.slug !== slugValidado || existente.db_path !== dbPath) {
    throw crearErrorControl(
      "COMPANY_RESERVATION_MISMATCH",
      `activarEmpresaReservada: la empresa id=${idValidado} no coincide con slug/dbPath esperados`,
      { existente: mapearEmpresaRow(existente), esperado: { slug: slugValidado, dbPath } }
    );
  }

  if (Number(existente.activa) === 1) {
    return { status: "ALREADY_ACTIVE", empresa: mapearEmpresaRow(existente) };
  }

  // WHERE defensivo: incluye la identidad completa esperada (id + slug + db_path) mas activa=0, para
  // que un UPDATE concurrente/inesperado nunca pueda activar una fila que ya no coincide con lo
  // verificado arriba en esta misma conexion.
  const result = await runQuery(
    db,
    "UPDATE empresas SET activa = 1 WHERE id = ? AND slug = ? AND db_path = ? AND activa = 0",
    [idValidado, slugValidado, dbPath]
  );
  if (result.changes !== 1) {
    throw crearErrorControl(
      "COMPANY_RESERVATION_MISMATCH",
      `activarEmpresaReservada: no se pudo activar de forma defensiva (changes=${result.changes})`
    );
  }

  return {
    status: "ACTIVATED",
    empresa: { id: idValidado, slug: slugValidado, nombre: existente.nombre, dbPath, activa: true }
  };
}

module.exports = {
  ALLOWED_DB_DIR,
  DEFAULT_DB_PATH,
  GUERNICA_SEED,
  openDb,
  closeDb,
  runQuery,
  getQuery,
  allQuery,
  resolveEmpresaDbPath,
  initControlSchema,
  registrarEmpresa,
  reservarEmpresaParaProvisioning,
  activarEmpresaReservada,
  seedGuernica,
  bootstrapControlDb,
  crearUsuarioCentral,
  actualizarUsuarioCentral,
  actualizarPasswordUsuarioCentral,
  crearMembership,
  actualizarMembership,
  actualizarAccesoMembership,
  actualizarActivoMembership,
  getMembershipPorEmpresaYLocal
};

if (require.main === module) {
  bootstrapControlDb()
    .then(async (db) => {
      console.log("Control plane listo.");
      await closeDb(db);
    })
    .catch((error) => {
      console.error("Error inicializando control plane:", error.message);
      process.exit(1);
    });
}
