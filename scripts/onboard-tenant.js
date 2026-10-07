// ONBOARD-1: alta OPERADOR-ONLY, reproducible e idempotente de una empresa NUEVA con su primer admin.
// No es self-service. No crea ningun usuario por defecto ni password fija (nunca usa database/init-db.js).
//
// SAGA (no hay transaccion distribuida entre Control y Business DB):
//   A. provisionarTenantDb (database/provision-tenant-db.js, sin cambios): reserva Control (activa=0),
//      crea la Business DB CURRENT con tenant_identity y TODAS las migrations, verifica y recien entonces
//      activa la empresa. Una falla aca la recupera el propio provisioner en el retry.
//   B. Primer admin LOCAL en la Business DB, en BEGIN IMMEDIATE: si el username no existe se inserta con un
//      hash bcrypt nuevo; si existe se VERIFICA (nombre, rol admin, activo, email, telefono y password via
//      bcrypt.compare) y se reutiliza, o se falla cerrado con LOCAL_ADMIN_MISMATCH. Nunca se sobrescribe.
//      Una falla posterior jamas borra ni recrea la Business DB: el retry reutiliza el admin local.
//   C. Usuario GLOBAL + membership admin en UNA transaccion de Control (BEGIN IMMEDIATE ... COMMIT,
//      ROLLBACK completo ante error): la clave de idempotencia es el binding (empresa_id, usuario_local_id)
//      -- nunca username global, email ni nombre. Si el binding existe se verifica (rol admin, activos,
//      perfil y password contra password_hash) o se falla cerrado con MEMBERSHIP_MISMATCH; nunca se crea un
//      segundo usuario global. El usuario central nace con el MISMO hash que el local: convergidos al nacer,
//      con las versiones iniciales del schema y sin outbox (no hay transicion que sincronizar).
//   D. Readiness: el runtime registry real (resolveTenantHandle) resuelve la empresa, y el slug es ruteable
//      por Host (<slug>.atlasos.com.ar) segun backend/tenantHostContext.js.
//
// La password solo entra por la API programatica o por STDIN en la CLI (--admin-password-stdin). Jamas se
// loguea, se devuelve ni se persiste en texto plano; el resultado no incluye hashes ni rutas absolutas.
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const sqlite3 = require("sqlite3").verbose();
const { provisionarTenantDb } = require("../database/provision-tenant-db");
const {
  runQuery,
  getQuery,
  crearUsuarioCentral,
  crearMembership,
  getMembershipPorEmpresaYLocal
} = require("../database/init-control-db");
const { parseTenantHost } = require("../backend/tenantHostContext");
const { resolveTenantHandle, closeTenantHandle } = require("../backend/runtimeTenantRegistry");

const DOMINIO_TENANT = "atlasos.com.ar";
const STATUS_PROVISION_ACEPTADOS = new Set(["PROVISIONED", "ACTIVATED_EXISTING_CURRENT", "ALREADY_PROVISIONED"]);
const PASSWORD_MIN = 8; // misma politica que el producto (POST /usuarios, PATCH /usuarios/:id/password)
const BCRYPT_COST = 10;
const STATUS = Object.freeze({ ONBOARDED: "ONBOARDED", ALREADY_ONBOARDED: "ALREADY_ONBOARDED" });

function crearError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function textoOpcional(valor) {
  if (valor === undefined || valor === null) return null;
  const t = String(valor).trim();
  return t ? t : null;
}

function validarEntrada(opciones = {}) {
  const { controlDbPath, empresa = {}, admin = {} } = opciones;
  if (typeof controlDbPath !== "string" || !path.isAbsolute(controlDbPath)) {
    throw crearError("INVALID_ARGUMENT", "controlDbPath explicito y absoluto obligatorio");
  }
  if (!fs.existsSync(controlDbPath) || !fs.statSync(controlDbPath).isFile()) {
    throw crearError("CONTROL_DB_NOT_FOUND", "La Control DB no existe (onboarding nunca la crea)");
  }
  const slug = typeof empresa.slug === "string" ? empresa.slug : "";
  const host = parseTenantHost(`${slug}.${DOMINIO_TENANT}`);
  if (host.kind !== "TENANT" || host.tenantSlug !== slug) {
    throw crearError("SLUG_NO_RUTEABLE", "El slug no es ruteable por Host (minusculas, digitos y guiones; no reservado)");
  }
  const nombreEmpresa = textoOpcional(empresa.nombre);
  if (!nombreEmpresa) throw crearError("INVALID_ARGUMENT", "Falta el nombre de la empresa");
  if (typeof empresa.businessDbPath !== "string" || !empresa.businessDbPath.trim()) {
    throw crearError("INVALID_ARGUMENT", "Falta el business DB path registrado");
  }
  const nombreAdmin = textoOpcional(admin.nombre);
  if (!nombreAdmin) throw crearError("INVALID_ARGUMENT", "Falta el nombre del primer admin");
  const usuario = typeof admin.usuario === "string" ? admin.usuario.trim() : "";
  if (!usuario || /\s/.test(usuario) || usuario.length > 64) throw crearError("INVALID_ARGUMENT", "Username del primer admin invalido");
  if (typeof admin.password !== "string" || admin.password.length < PASSWORD_MIN) {
    throw crearError("INVALID_ARGUMENT", `La password del primer admin debe tener al menos ${PASSWORD_MIN} caracteres`);
  }
  return {
    controlDbPath,
    empresa: { slug, nombre: nombreEmpresa, businessDbPath: empresa.businessDbPath },
    admin: { nombre: nombreAdmin, usuario, password: admin.password, email: textoOpcional(admin.email), telefono: textoOpcional(admin.telefono) }
  };
}

// Apertura SIN OPEN_CREATE: nunca materializa una base por accidente.
function abrirExistente(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (error) => (error ? reject(error) : resolve(db)));
  });
}

function cerrar(db) {
  return new Promise((resolve) => (db ? db.close(() => resolve()) : resolve()));
}

async function enTransaccion(db, fn) {
  await runQuery(db, "PRAGMA busy_timeout = 5000");
  await runQuery(db, "BEGIN IMMEDIATE");
  try {
    const resultado = await fn();
    await runQuery(db, "COMMIT");
    return resultado;
  } catch (error) {
    try { await runQuery(db, "ROLLBACK"); } catch (_) { /* la transaccion ya no esta activa */ }
    throw error;
  }
}

function camposDistintos(pares) {
  return pares.filter(([, actual, esperado]) => actual !== esperado).map(([campo]) => campo);
}

// ---- Fase B: primer admin local ----
async function asegurarAdminLocal(businessDbPath, admin) {
  let db;
  try {
    db = await abrirExistente(businessDbPath);
  } catch (error) {
    throw crearError("BUSINESS_DB_ERROR", `No se pudo abrir la Business DB: ${error.code || "error"}`);
  }
  try {
    return await enTransaccion(db, async () => {
      const existente = await getQuery(db, "SELECT * FROM usuarios WHERE usuario = ?", [admin.usuario]);
      if (!existente) {
        const hash = await bcrypt.hash(admin.password, BCRYPT_COST);
        const r = await runQuery(db,
          `INSERT INTO usuarios (nombre, usuario, password, rol, activo, email, telefono, creado_en, actualizado_en)
           VALUES (?, ?, ?, 'admin', 1, ?, ?, datetime('now'), datetime('now'))`,
          [admin.nombre, admin.usuario, hash, admin.email, admin.telefono]);
        return { usuarioLocalId: r.lastID, hash, fase: "CREATED" };
      }
      const distintos = camposDistintos([
        ["nombre", existente.nombre, admin.nombre],
        ["rol", existente.rol, "admin"],
        ["activo", Number(existente.activo), 1],
        ["email", existente.email || null, admin.email],
        ["telefono", existente.telefono || null, admin.telefono]
      ]);
      if (!(await bcrypt.compare(admin.password, String(existente.password || "")))) distintos.push("password");
      if (distintos.length) throw crearError("LOCAL_ADMIN_MISMATCH", `El usuario local existente no coincide (${distintos.join(", ")})`);
      return { usuarioLocalId: existente.id, hash: existente.password, fase: "REUSED" };
    });
  } finally {
    await cerrar(db);
  }
}

// ---- Fase C: usuario global + membership admin, una sola transaccion de Control ----
async function asegurarAdminCentral(controlDbPath, { empresaId, empresaSlug }, admin, local, ganchos) {
  let db;
  try {
    db = await abrirExistente(controlDbPath);
    await runQuery(db, "PRAGMA foreign_keys = ON");
  } catch (error) {
    await cerrar(db);
    throw crearError("CONTROL_DB_ERROR", `No se pudo abrir la Control DB: ${error.code || "error"}`);
  }
  try {
    return await enTransaccion(db, async () => {
      const empresa = await getQuery(db, "SELECT id, slug, activa FROM empresas WHERE id = ?", [empresaId]);
      if (!empresa || empresa.slug !== empresaSlug || Number(empresa.activa) !== 1) {
        throw crearError("COMPANY_STATE_MISMATCH", "La empresa no esta activa con el slug esperado en Control");
      }
      const membership = await getMembershipPorEmpresaYLocal(db, { empresaId, usuarioLocalId: local.usuarioLocalId });
      if (membership) {
        const central = await getQuery(db, "SELECT * FROM usuarios WHERE id = ?", [membership.usuario_id]);
        const distintos = central ? camposDistintos([
          ["membership.rol", membership.rol, "admin"],
          ["membership.activo", Number(membership.activo), 1],
          ["central.activo", Number(central.activo), 1],
          ["central.nombre", central.nombre, admin.nombre],
          ["central.usuario_referencia", central.usuario_referencia, admin.usuario],
          ["central.email", central.email || null, admin.email],
          ["central.telefono", central.telefono || null, admin.telefono]
        ]) : ["central"];
        if (central && !(await bcrypt.compare(admin.password, String(central.password_hash || "")))) distintos.push("central.password");
        if (distintos.length) throw crearError("MEMBERSHIP_MISMATCH", `La membership existente no coincide (${distintos.join(", ")})`);
        return { usuarioCentralId: central.id, membershipId: membership.id, fase: "REUSED" };
      }
      const central = await crearUsuarioCentral(db, {
        nombre: admin.nombre,
        usuarioReferencia: admin.usuario,
        passwordHash: local.hash,
        email: admin.email,
        telefono: admin.telefono,
        activo: 1
      });
      if (ganchos && typeof ganchos.entreUsuarioYMembership === "function") await ganchos.entreUsuarioYMembership();
      const creada = await crearMembership(db, { usuarioId: central.id, empresaId, usuarioLocalId: local.usuarioLocalId, rol: "admin", activo: 1 });
      return { usuarioCentralId: central.id, membershipId: creada.id, fase: "CREATED" };
    });
  } finally {
    await cerrar(db);
  }
}

// ---- Fase D: readiness del runtime real ----
async function verificarRuntime(controlDbPath, empresaSlug) {
  const r = await resolveTenantHandle({ empresaSlug, controlDbPath });
  if (!r || r.ok !== true) throw crearError("RUNTIME_NOT_READY", `El runtime registry no resuelve la empresa (${r && r.errorCode})`);
  await closeTenantHandle(r.handle);
  return true;
}

async function onboardTenant(opciones = {}, dependencias = {}) {
  const entrada = validarEntrada(opciones);
  const ganchos = dependencias.ganchos || {};

  const provision = await provisionarTenantDb({
    controlDbPath: entrada.controlDbPath,
    empresaSlug: entrada.empresa.slug,
    empresaNombre: entrada.empresa.nombre,
    businessDbPath: entrada.empresa.businessDbPath
  });
  if (!provision || !STATUS_PROVISION_ACEPTADOS.has(provision.status) || provision.schemaState !== "CURRENT") {
    throw crearError("PROVISION_UNEXPECTED", "El provisioner no devolvio una Business DB CURRENT");
  }
  if (typeof ganchos.antesDeAdminLocal === "function") await ganchos.antesDeAdminLocal();

  const local = await asegurarAdminLocal(provision.businessDbPath, entrada.admin);
  if (typeof ganchos.antesDeControl === "function") await ganchos.antesDeControl();

  const control = await asegurarAdminCentral(
    entrada.controlDbPath,
    { empresaId: provision.empresaId, empresaSlug: provision.empresaSlug },
    entrada.admin,
    local,
    ganchos
  );
  const runtime = await verificarRuntime(entrada.controlDbPath, provision.empresaSlug);

  const nada = provision.status === "ALREADY_PROVISIONED" && local.fase === "REUSED" && control.fase === "REUSED";
  return {
    status: nada ? STATUS.ALREADY_ONBOARDED : STATUS.ONBOARDED,
    empresa: { id: provision.empresaId, slug: provision.empresaSlug, activa: true },
    tenant: { schemaState: provision.schemaState, identityOk: true, registeredDbPath: entrada.empresa.businessDbPath },
    admin: {
      usuarioLocalId: local.usuarioLocalId,
      usuarioCentralId: control.usuarioCentralId,
      membershipId: control.membershipId,
      usuario: entrada.admin.usuario,
      rol: "admin"
    },
    fases: { provision: provision.status, adminLocal: local.fase, control: control.fase },
    readiness: { runtime, firstLogin: "not_checked", hostRequired: `${provision.empresaSlug}.${DOMINIO_TENANT}` }
  };
}

// ---- CLI ----
const FLAGS = {
  "--control-db": "controlDbPath",
  "--slug": "slug",
  "--nombre": "nombre",
  "--db-path": "businessDbPath",
  "--admin-nombre": "adminNombre",
  "--admin-usuario": "adminUsuario",
  "--admin-email": "adminEmail",
  "--admin-telefono": "adminTelefono"
};

function parsearArgv(argv) {
  const args = {};
  let passwordStdin = false;
  for (let i = 0; i < argv.length; i++) {
    const [flag, valorInline] = argv[i].split(/=(.*)/s, 2);
    if (/password/i.test(flag) && flag !== "--admin-password-stdin") {
      throw crearError("PASSWORD_EN_ARGV_RECHAZADA", "La password nunca se acepta como argumento: usar --admin-password-stdin");
    }
    if (flag === "--admin-password-stdin") { passwordStdin = true; continue; }
    if (!FLAGS[flag]) throw crearError("INVALID_ARGUMENT", `Argumento desconocido: ${flag}`);
    args[FLAGS[flag]] = valorInline !== undefined ? valorInline : argv[++i];
  }
  if (!passwordStdin) throw crearError("INVALID_ARGUMENT", "Falta --admin-password-stdin (la password se lee de STDIN)");
  return args;
}

function leerStdin(stdin) {
  return new Promise((resolve, reject) => {
    let datos = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (d) => { datos += d; });
    stdin.on("end", () => resolve(datos.replace(/\r?\n$/, "")));
    stdin.on("error", reject);
  });
}

async function runCli(argv = process.argv.slice(2), stdin = process.stdin) {
  let args;
  try {
    args = parsearArgv(argv);
  } catch (error) {
    console.log(JSON.stringify({ ok: false, errorCode: error.code, message: error.message }));
    return 2;
  }
  try {
    const password = await leerStdin(stdin);
    const resultado = await onboardTenant({
      controlDbPath: args.controlDbPath,
      empresa: { slug: args.slug, nombre: args.nombre, businessDbPath: args.businessDbPath },
      admin: { nombre: args.adminNombre, usuario: args.adminUsuario, password, email: args.adminEmail, telefono: args.adminTelefono }
    });
    console.log(JSON.stringify({ ok: true, ...resultado }));
    return 0;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, errorCode: error.code || "ONBOARD_ERROR", message: error.message }));
    return 1;
  }
}

module.exports = { STATUS, onboardTenant, runCli };

if (require.main === module) {
  runCli().then((code) => { process.exitCode = code; });
}
