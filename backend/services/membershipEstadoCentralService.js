// AUTH-SYNC-B2-S1a: writer CENTRAL-FIRST de estado (activo) de UNA membership. Una sola transaccion
// de Control DB (BEGIN IMMEDIATE) que valida autoridad ADMIN efectiva del actor, aplica CAS por
// usuario_empresas.version y crea/reabre la lapida sync_pendiente(membership, 'rol_activo') con
// version_objetivo = la generacion confirmada -- ambas escrituras en el MISMO COMMIT. Nunca toca la
// business DB: la proyeccion pertenece al consumer (database/process-rol-activo-outbox.js, S0b3a) y
// al worker de recuperacion (database/run-rol-activo-worker.js, S0b3b).
//
// Autoridad: todo se lee de Control DB DENTRO de la transaccion. El caller solo aporta
// identificadores (actor central, empresa, membership destino) y la intencion (activo,
// expected_version); nunca roles, nombres ni permisos declarados.
//
// Acceso efectivo (mismo criterio que backend/centralAuthResolver.js / centralAuthSecurity.js):
// empresas.activa = 1 AND usuario_empresas.activo = 1 AND usuarios.activo = 1. bloqueado_hasta es un
// bloqueo TEMPORAL por intentos fallidos, no una inhabilitacion -- no se usa para decidir autoridad.
//
// Limites: solo escribe usuario_empresas.activo/version/actualizado_en de la membership destino y la
// fila rol_activo de sync_pendiente. Nunca usuarios (activo global, password, version de identidad),
// nunca rol, nunca sesiones, nunca filas 'password' de sync_pendiente, nunca otras empresas.
//
// Idempotencia: expected_version (CAS) impide escrituras duplicadas o basadas en una generacion
// vieja, pero NO es un replay HTTP idempotente (respuesta perdida tras commit, reutilizacion de una
// Idempotency-Key con otro contenido). Ese contrato queda para la integracion HTTP.
const fs = require("fs");
const sqlite3 = require("sqlite3");
const { DEFAULT_DB_PATH, closeDb, runQuery, getQuery, allQuery } = require("../../database/init-control-db");

const RESULTADOS_ESTADO_MEMBERSHIP = Object.freeze({
  CONFIRMADO: "CONFIRMADO",
  SIN_CAMBIOS: "SIN_CAMBIOS",
  NO_AUTORIZADO: "NO_AUTORIZADO",
  AUTOMODIFICACION: "AUTOMODIFICACION",
  ULTIMO_ADMIN_PROTEGIDO: "ULTIMO_ADMIN_PROTEGIDO",
  MEMBERSHIP_NO_ENCONTRADA: "MEMBERSHIP_NO_ENCONTRADA",
  EMPRESA_NO_DISPONIBLE: "EMPRESA_NO_DISPONIBLE",
  VERSION_CONFLICT: "VERSION_CONFLICT",
  ESQUEMA_INCOMPATIBLE: "ESQUEMA_INCOMPATIBLE",
  PARAMETROS_INVALIDOS: "PARAMETROS_INVALIDOS",
  ESTADO_INCONSISTENTE: "ESTADO_INCONSISTENTE",
  ERROR_TRANSITORIO: "ERROR_TRANSITORIO",
  FALLO_TRANSACCIONAL: "FALLO_TRANSACCIONAL"
});
const R = RESULTADOS_ESTADO_MEMBERSHIP;

const ROL_ADMIN = "admin";
const CODIGOS_SQLITE_TRANSITORIOS = new Set(["SQLITE_BUSY", "SQLITE_LOCKED"]);

function enteroPositivo(valor) {
  const n = typeof valor === "string" && valor.trim() !== "" ? Number(valor) : valor;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function enteroNoNegativo(valor) {
  const n = typeof valor === "string" && valor.trim() !== "" ? Number(valor) : valor;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function normalizarActivo(valor) {
  if (valor === true || valor === 1 || valor === "1") return 1;
  if (valor === false || valor === 0 || valor === "0") return 0;
  return null;
}

function rechazo(resultado, motivo, extra = {}) {
  return { ok: false, resultado, motivo, ...extra };
}

function esErrorTransitorio(error) {
  return Boolean(error && CODIGOS_SQLITE_TRANSITORIOS.has(error.code));
}

// OPEN_READWRITE sin OPEN_CREATE (nunca materializa un Control DB), foreign_keys activas y
// busy_timeout para que dos writers concurrentes se serialicen en BEGIN IMMEDIATE en vez de fallar.
function abrirControlDbEscritura(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (error) => {
      if (error) { reject(error); return; }
      db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;", (pragmaError) => {
        if (pragmaError) { db.close(() => reject(pragmaError)); return; }
        resolve(db);
      });
    });
  });
}

// Esquema minimo que este writer necesita: version en usuarios y usuario_empresas (S0) y
// sync_pendiente con las columnas de la lapida. Introspeccion pura, nunca migra.
async function verificarEsquema(db) {
  const columnas = async (tabla) => new Set((await allQuery(db, `PRAGMA table_info(${tabla})`)).map((c) => c.name));
  const usuarios = await columnas("usuarios");
  const memberships = await columnas("usuario_empresas");
  const empresas = await columnas("empresas");
  const pendientes = await columnas("sync_pendiente");
  const requeridas = [
    [usuarios, ["id", "activo", "version"]],
    [memberships, ["id", "usuario_id", "empresa_id", "usuario_local_id", "rol", "activo", "version", "actualizado_en"]],
    [empresas, ["id", "activa"]],
    [pendientes, ["usuario_id", "empresa_id", "membership_id", "usuario_local_id", "tipo_operacion", "version_objetivo", "estado", "procesado_en"]]
  ];
  return requeridas.every(([presentes, nombres]) => nombres.every((n) => presentes.has(n)));
}

// Administradores con acceso EFECTIVO en la empresa: membership admin activa + identidad global
// activa (la empresa ya se verifico activa). Se cuenta dentro de la transaccion del writer.
async function contarAdminsEfectivos(db, empresaId, { excluirMembershipId = null } = {}) {
  const fila = await getQuery(
    db,
    `SELECT COUNT(*) AS n
     FROM usuario_empresas ue
     JOIN usuarios u ON u.id = ue.usuario_id
     WHERE ue.empresa_id = ? AND ue.rol = ? AND ue.activo = 1 AND u.activo = 1
       AND (? IS NULL OR ue.id <> ?)`,
    [empresaId, ROL_ADMIN, excluirMembershipId, excluirMembershipId]
  );
  return Number(fila.n);
}

// Crea o reabre la lapida rol_activo de la membership con la generacion confirmada. Una fila
// existente con otra asociacion (identidad/empresa/usuario local) es una inconsistencia: se aborta.
async function registrarPendienteRolActivo(db, membership, versionObjetivo) {
  const reapertura = await runQuery(
    db,
    `UPDATE sync_pendiente
     SET version_objetivo = ?, estado = 'pendiente', procesado_en = NULL
     WHERE membership_id = ? AND tipo_operacion = 'rol_activo'
       AND usuario_id = ? AND empresa_id = ? AND usuario_local_id = ?`,
    [versionObjetivo, membership.id, membership.usuario_id, membership.empresa_id, membership.usuario_local_id]
  );
  if (reapertura.changes === 1) {
    return { accion: "REABIERTA" };
  }
  const existente = await getQuery(
    db,
    "SELECT id FROM sync_pendiente WHERE membership_id = ? AND tipo_operacion = 'rol_activo'",
    [membership.id]
  );
  if (existente) {
    return { accion: "INCONSISTENTE" };
  }
  await runQuery(
    db,
    `INSERT INTO sync_pendiente (usuario_id, empresa_id, membership_id, usuario_local_id, tipo_operacion, version_objetivo, estado)
     VALUES (?, ?, ?, ?, 'rol_activo', ?, 'pendiente')`,
    [membership.usuario_id, membership.empresa_id, membership.id, membership.usuario_local_id, versionObjetivo]
  );
  return { accion: "CREADA" };
}

async function cambiarEstadoMembershipCentral({
  actorUsuarioId, empresaId, membershipId, activo, expectedVersion, controlDbPath
} = {}) {
  const actorId = enteroPositivo(actorUsuarioId);
  const empresa = enteroPositivo(empresaId);
  const destinoId = enteroPositivo(membershipId);
  const activoNuevo = normalizarActivo(activo);
  const versionEsperada = enteroNoNegativo(expectedVersion);
  if (!actorId || !empresa || !destinoId || activoNuevo === null || versionEsperada === null) {
    return rechazo(R.PARAMETROS_INVALIDOS, "PARAMETROS_INVALIDOS");
  }
  const base = { membershipId: destinoId, empresaId: empresa };

  const dbPath = controlDbPath || DEFAULT_DB_PATH;
  if (!fs.existsSync(dbPath)) {
    return rechazo(R.ERROR_TRANSITORIO, "CONTROL_DB_AUSENTE", base);
  }
  let db;
  try {
    db = await abrirControlDbEscritura(dbPath);
  } catch (error) {
    return rechazo(R.ERROR_TRANSITORIO, "CONTROL_DB_INACCESIBLE", { ...base, codigo: error.code || null });
  }

  let transaccionAbierta = false;
  const terminarSinEscritura = async (resultado) => {
    await runQuery(db, "ROLLBACK");
    transaccionAbierta = false;
    return resultado;
  };
  try {
    await runQuery(db, "BEGIN IMMEDIATE");
    transaccionAbierta = true;

    if (!(await verificarEsquema(db))) {
      return await terminarSinEscritura(rechazo(R.ESQUEMA_INCOMPATIBLE, "ESQUEMA_CONTROL_INCOMPATIBLE", base));
    }

    // R2: empresa existente y activa.
    const empresaRow = await getQuery(db, "SELECT id, activa FROM empresas WHERE id = ?", [empresa]);
    if (!empresaRow || Number(empresaRow.activa) !== 1) {
      return await terminarSinEscritura(rechazo(R.EMPRESA_NO_DISPONIBLE, empresaRow ? "EMPRESA_INACTIVA" : "EMPRESA_INEXISTENTE", base));
    }

    // R1: actor existente y globalmente activo.
    const actor = await getQuery(db, "SELECT id, activo FROM usuarios WHERE id = ?", [actorId]);
    if (!actor) {
      return await terminarSinEscritura(rechazo(R.NO_AUTORIZADO, "ACTOR_INEXISTENTE", base));
    }
    if (Number(actor.activo) !== 1) {
      return await terminarSinEscritura(rechazo(R.NO_AUTORIZADO, "ACTOR_INACTIVO", base));
    }

    // R3: membership del actor en ESTA empresa, activa y con rol admin.
    const actorMembership = await getQuery(
      db,
      "SELECT id, rol, activo FROM usuario_empresas WHERE usuario_id = ? AND empresa_id = ?",
      [actorId, empresa]
    );
    if (!actorMembership) {
      return await terminarSinEscritura(rechazo(R.NO_AUTORIZADO, "ACTOR_SIN_MEMBERSHIP", base));
    }
    if (Number(actorMembership.activo) !== 1) {
      return await terminarSinEscritura(rechazo(R.NO_AUTORIZADO, "ACTOR_MEMBERSHIP_INACTIVA", base));
    }
    if (actorMembership.rol !== ROL_ADMIN) {
      return await terminarSinEscritura(rechazo(R.NO_AUTORIZADO, "ACTOR_NO_ADMIN", base));
    }

    // R4: destino de ESTA empresa. Inexistente y ajena se informan igual (sin enumerar otras empresas).
    const destino = await getQuery(
      db,
      "SELECT id, usuario_id, empresa_id, usuario_local_id, rol, activo, version FROM usuario_empresas WHERE id = ?",
      [destinoId]
    );
    if (!destino || Number(destino.empresa_id) !== empresa) {
      return await terminarSinEscritura(rechazo(R.MEMBERSHIP_NO_ENCONTRADA, "MEMBERSHIP_NO_ENCONTRADA", base));
    }

    // R5: nunca sobre la propia identidad (ni la propia membership).
    if (Number(destino.usuario_id) === actorId || Number(destino.id) === Number(actorMembership.id)) {
      return await terminarSinEscritura(rechazo(R.AUTOMODIFICACION, "AUTOMODIFICACION", base));
    }

    const versionActual = Number(destino.version);
    const activoActual = Number(destino.activo) === 1 ? 1 : 0;
    if (activoActual === activoNuevo) {
      return await terminarSinEscritura({
        ok: true, resultado: R.SIN_CAMBIOS, ...base, activo: activoActual, versionActual,
        versionEsperadaCoincide: versionActual === versionEsperada
      });
    }
    if (versionActual !== versionEsperada) {
      return await terminarSinEscritura(rechazo(R.VERSION_CONFLICT, "VERSION_CONFLICT", { ...base, versionActual }));
    }

    // R6: nunca dejar a la empresa sin administradores con acceso efectivo. Se cuenta DENTRO de la
    // transaccion, excluyendo al destino, despues de las validaciones de autoridad.
    if (activoNuevo === 0 && destino.rol === ROL_ADMIN) {
      const restantes = await contarAdminsEfectivos(db, empresa, { excluirMembershipId: destinoId });
      if (restantes < 1) {
        return await terminarSinEscritura(rechazo(R.ULTIMO_ADMIN_PROTEGIDO, "ULTIMO_ADMIN_PROTEGIDO", base));
      }
    }

    // R7 + CAS: unica escritura sobre la membership destino.
    const cas = await runQuery(
      db,
      `UPDATE usuario_empresas
       SET activo = ?, version = version + 1, actualizado_en = datetime('now')
       WHERE id = ? AND empresa_id = ? AND version = ?`,
      [activoNuevo, destinoId, empresa, versionEsperada]
    );
    if (cas.changes !== 1) {
      return await terminarSinEscritura(rechazo(R.VERSION_CONFLICT, "VERSION_CONFLICT", { ...base, versionActual }));
    }
    const versionNueva = versionEsperada + 1;

    // R10: pendiente durable en la MISMA transaccion.
    const pendiente = await registrarPendienteRolActivo(db, destino, versionNueva);
    if (pendiente.accion === "INCONSISTENTE") {
      return await terminarSinEscritura(rechazo(R.ESTADO_INCONSISTENTE, "LAPIDA_ASOCIACION_INCONSISTENTE", base));
    }
    const verificacion = await getQuery(
      db,
      "SELECT version_objetivo, estado FROM sync_pendiente WHERE membership_id = ? AND tipo_operacion = 'rol_activo'",
      [destinoId]
    );
    if (!verificacion || Number(verificacion.version_objetivo) !== versionNueva || verificacion.estado !== "pendiente") {
      return await terminarSinEscritura(rechazo(R.FALLO_TRANSACCIONAL, "PENDIENTE_NO_VERIFICADO", base));
    }

    await runQuery(db, "COMMIT");
    transaccionAbierta = false;
    return {
      ok: true,
      resultado: R.CONFIRMADO,
      ...base,
      usuarioLocalId: Number(destino.usuario_local_id),
      activo: activoNuevo,
      versionAnterior: versionEsperada,
      versionNueva,
      pendiente: { tipo: "rol_activo", versionObjetivo: versionNueva, estado: "pendiente", accion: pendiente.accion }
    };
  } catch (error) {
    let rollbackFallido = false;
    if (transaccionAbierta) {
      try { await runQuery(db, "ROLLBACK"); } catch (_) { rollbackFallido = true; }
      transaccionAbierta = false;
    }
    const transitorio = esErrorTransitorio(error);
    return rechazo(
      transitorio ? R.ERROR_TRANSITORIO : R.FALLO_TRANSACCIONAL,
      transitorio ? "CONTROL_DB_OCUPADA" : "FALLO_TRANSACCIONAL",
      { ...base, codigo: error.code || null, ...(rollbackFallido ? { rollbackFallido: true } : {}) }
    );
  } finally {
    await closeDb(db);
  }
}

module.exports = {
  RESULTADOS_ESTADO_MEMBERSHIP,
  contarAdminsEfectivos,
  cambiarEstadoMembershipCentral
};
