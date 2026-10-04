// AUTH-SYNC-B2-S0b2: primitiva de proyeccion CENTRAL -> TENANT de rol/activo de UNA membership,
// con escritura MONOTONICA (B2-RS-C0-H1/H2). Control DB es la unica fuente autorizada de empresa,
// membership, identidad central, usuario local destino, rol, activo y version; la business DB es aca
// exclusivamente destino de escritura (shadow), nunca fuente de verdad.
//
// Contrato de convergencia, con g = usuario_empresas.version (Control) y vL =
// usuarios.central_rol_activo_version (tenant, migracion 004):
//   A. vL NULL o vL < g        -> se aplican rol/activo/g           -> APLICADO
//   B. vL = g y valores iguales -> sin escritura                    -> YA_CONVERGIDO
//   C. vL = g y valores difieren -> se restablecen rol/activo de g   -> REPARADO
//   D. vL > g                  -> sin escritura (nunca retroceder)  -> GENERACION_OBSOLETA
// Cualquier validacion que no pueda completarse falla CERRADO -> NO_PROCESABLE, sin escribir nada.
//
// Limite deliberado (S0b3 es responsable del resto): esta primitiva NUNCA crea operaciones centrales,
// nunca escribe usuario_empresas, nunca crea/actualiza/cierra filas de sync_pendiente (ni lapidas),
// nunca toca password, nunca hace HTTP ni agenda nada. Solo LEE Control y escribe rol/activo/version
// de una fila local que ya existe.
//
// Solo proyecta memberships con autoridad central-first ya establecida -- la lapida
// sync_pendiente(membership_id, 'rol_activo'), en cualquier estado (mismo criterio que el
// reconciliador, database/reconcile-shadow-users.js). Sin lapida, la autoridad de esa membership sigue
// siendo la del contrato previo y proyectar desde Control introduciria una autoridad nueva: se
// rechaza como SIN_AUTORIDAD_CENTRAL.
const fs = require("fs");
const sqlite3 = require("sqlite3");
const { runQuery, getQuery, allQuery, closeDb, DEFAULT_DB_PATH } = require("./init-control-db");
const { abrirControlDbSoloLectura } = require("../backend/centralAuthResolver");
const { resolverTenantDbRegistrado } = require("../backend/tenantDbRegistry");
const { verificarTenantDbIdentityEnConexion } = require("../backend/tenantDbIdentity");
const { verificarBusinessSchemaVersionEnConexion } = require("../backend/businessSchemaVersion");

const RESULTADOS_PROYECCION = Object.freeze({
  APLICADO: "APLICADO",
  YA_CONVERGIDO: "YA_CONVERGIDO",
  REPARADO: "REPARADO",
  GENERACION_OBSOLETA: "GENERACION_OBSOLETA",
  NO_PROCESABLE: "NO_PROCESABLE"
});

const COLUMNA_VERSION_PROYECCION = "central_rol_activo_version";

function noProcesable(motivo, detalle = {}) {
  return { resultado: RESULTADOS_PROYECCION.NO_PROCESABLE, motivo, ...detalle };
}

function enteroPositivo(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Cuarta copia deliberada del detector de esquema S0 (ya existen copias independientes en
// reconcile-shadow-users.js, sync-shadow-users.js y process-central-outbox.js, por el mismo motivo de
// desacoplamiento). Importarlo desde process-central-outbox.js crearia una dependencia circular en
// cuanto S0b3 conecte este modulo al consumidor del outbox. Puramente introspectivo, nunca migra.
async function detectarSoporteEsquemaS0(controlDb) {
  const columnasUsuarios = await allQuery(controlDb, "PRAGMA table_info(usuarios)");
  const tieneVersionUsuarios = columnasUsuarios.some((columna) => columna.name === "version");
  const columnasMembership = await allQuery(controlDb, "PRAGMA table_info(usuario_empresas)");
  const tieneVersionMembership = columnasMembership.some((columna) => columna.name === "version");
  const tablasSyncPendiente = await allQuery(
    controlDb,
    "SELECT name FROM sqlite_master WHERE type='table' AND name='sync_pendiente'"
  );
  const tieneSyncPendiente = tablasSyncPendiente.length > 0;
  if (!tieneVersionUsuarios && !tieneVersionMembership && !tieneSyncPendiente) {
    return { soportaS0: false };
  }
  if (tieneVersionUsuarios && tieneVersionMembership && tieneSyncPendiente) {
    const columnasSyncPendiente = await allQuery(controlDb, "PRAGMA table_info(sync_pendiente)");
    const nombresSyncPendiente = new Set(columnasSyncPendiente.map((columna) => columna.name));
    const columnasEsperadas = ["membership_id", "tipo_operacion", "estado", "version_objetivo"];
    if (!columnasEsperadas.every((columna) => nombresSyncPendiente.has(columna))) {
      return { soportaS0: null, motivo: "SYNC_PENDIENTE_FORMA_INCOMPATIBLE" };
    }
    return { soportaS0: true };
  }
  return { soportaS0: null, motivo: "ESQUEMA_S0_PARCIAL" };
}

// Snapshot coherente de Control: una unica transaccion de LECTURA (conexion OPEN_READONLY) que lee
// esquema, membership + empresa, identidad central y lapida bajo el mismo SHARED lock -- rol, activo
// y version siempre pertenecen a la misma generacion.
async function leerSnapshotCentral(controlDbPath, membershipId) {
  const resolvedControlDbPath = controlDbPath || DEFAULT_DB_PATH;
  if (!fs.existsSync(resolvedControlDbPath)) {
    return noProcesable("CONTROL_DB_AUSENTE");
  }
  let controlDb;
  try {
    controlDb = await abrirControlDbSoloLectura(resolvedControlDbPath);
  } catch (error) {
    return noProcesable("CONTROL_DB_INACCESIBLE", { error: error.message });
  }
  let transaccionAbierta = false;
  try {
    await runQuery(controlDb, "BEGIN");
    transaccionAbierta = true;
    const deteccion = await detectarSoporteEsquemaS0(controlDb);
    if (deteccion.soportaS0 !== true) {
      return noProcesable("ESQUEMA_CONTROL_S0_INCOMPATIBLE", { detalle: deteccion.motivo || "PRE_S0" });
    }
    const fila = await getQuery(
      controlDb,
      `SELECT ue.id AS membership_id, ue.usuario_id, ue.empresa_id, ue.usuario_local_id,
              ue.rol, ue.activo, ue.version, e.slug AS empresa_slug
       FROM usuario_empresas ue
       JOIN empresas e ON e.id = ue.empresa_id
       WHERE ue.id = ?`,
      [membershipId]
    );
    if (!fila) {
      return noProcesable("MEMBERSHIP_INEXISTENTE", { membershipId });
    }
    const central = await getQuery(controlDb, "SELECT id FROM usuarios WHERE id = ?", [fila.usuario_id]);
    if (!central) {
      return noProcesable("IDENTIDAD_CENTRAL_INEXISTENTE", { membershipId });
    }
    const lapida = await getQuery(
      controlDb,
      "SELECT 1 AS x FROM sync_pendiente WHERE membership_id = ? AND tipo_operacion = 'rol_activo'",
      [membershipId]
    );
    await runQuery(controlDb, "COMMIT");
    transaccionAbierta = false;
    return {
      ok: true,
      tieneLapida: Boolean(lapida),
      snapshot: {
        membershipId: Number(fila.membership_id),
        usuarioCentralId: Number(fila.usuario_id),
        empresaId: Number(fila.empresa_id),
        empresaSlug: fila.empresa_slug,
        usuarioLocalId: Number(fila.usuario_local_id),
        rol: fila.rol,
        activo: fila.activo,
        version: fila.version
      }
    };
  } catch (error) {
    return noProcesable("CONTROL_DB_QUERY_ERROR", { error: error.message });
  } finally {
    if (transaccionAbierta) {
      try { await runQuery(controlDb, "ROLLBACK"); } catch (_) { /* conexion de solo lectura: nada que revertir */ }
    }
    await closeDb(controlDb);
  }
}

function snapshotValido(snapshot) {
  if (!snapshot) return false;
  const version = Number(snapshot.version);
  const activo = Number(snapshot.activo);
  return enteroPositivo(snapshot.usuarioLocalId) !== null
    && typeof snapshot.rol === "string" && snapshot.rol.trim().length > 0
    && (activo === 0 || activo === 1)
    && Number.isInteger(version) && version >= 0;
}

// Escritura monotonica pura sobre una conexion de business DB YA ABIERTA y YA dentro de una
// transaccion controlada por el caller (mismo contrato que las migraciones: nunca BEGIN/COMMIT aca).
// La sentencia condicional es atomica en SQLite y es la unica garantia de "nunca retroceder": aun si
// la clasificacion previa quedara desactualizada, una generacion mas antigua jamas cumple el WHERE.
// IS / IS NOT son las comparaciones NULL-safe de SQLite.
async function aplicarProyeccionMonotonica(businessDb, snapshot) {
  if (!snapshotValido(snapshot)) {
    return noProcesable("SNAPSHOT_INVALIDO");
  }
  const g = Number(snapshot.version);
  const rol = snapshot.rol;
  const activo = Number(snapshot.activo);
  const usuarioLocalId = Number(snapshot.usuarioLocalId);

  const local = await getQuery(
    businessDb,
    `SELECT id, rol, activo, ${COLUMNA_VERSION_PROYECCION} AS version_local FROM usuarios WHERE id = ?`,
    [usuarioLocalId]
  );
  if (!local) {
    return noProcesable("USUARIO_LOCAL_INEXISTENTE", { usuarioLocalId });
  }
  const vL = local.version_local === null || local.version_local === undefined ? null : Number(local.version_local);
  const detalle = { usuarioLocalId, versionCentral: g, versionLocalAntes: vL };

  if (vL !== null && vL > g) {
    return { resultado: RESULTADOS_PROYECCION.GENERACION_OBSOLETA, ...detalle, versionLocalDespues: vL };
  }
  const valoresIguales = local.rol === rol && Number(local.activo) === activo;
  if (vL === g && valoresIguales) {
    return { resultado: RESULTADOS_PROYECCION.YA_CONVERGIDO, ...detalle, versionLocalDespues: vL };
  }

  const escritura = await runQuery(
    businessDb,
    `UPDATE usuarios
     SET rol = ?, activo = ?, ${COLUMNA_VERSION_PROYECCION} = ?
     WHERE id = ?
       AND (${COLUMNA_VERSION_PROYECCION} IS NULL
            OR ${COLUMNA_VERSION_PROYECCION} < ?
            OR (${COLUMNA_VERSION_PROYECCION} = ? AND (rol IS NOT ? OR activo IS NOT ?)))`,
    [rol, activo, g, usuarioLocalId, g, g, rol, activo]
  );
  if (escritura.changes !== 1) {
    // La clasificacion esperaba escribir pero la condicion atomica no se cumplio: nunca se informa
    // exito sin escritura efectiva.
    return noProcesable("ESCRITURA_NO_APLICADA", detalle);
  }
  const resultado = vL === g ? RESULTADOS_PROYECCION.REPARADO : RESULTADOS_PROYECCION.APLICADO;
  return { resultado, ...detalle, versionLocalDespues: g };
}

function abrirBusinessDbEscrituraExistente(dbPath) {
  return new Promise((resolve, reject) => {
    // OPEN_READWRITE sin OPEN_CREATE: jamas materializa un archivo nuevo.
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (error) => {
      if (error) { reject(error); return; }
      resolve(db);
    });
  });
}

// Primitiva completa, reutilizable por el futuro handler HTTP y por el futuro consumidor del outbox
// (S0b3). `empresaIdEsperada` (opcional) permite al caller atar la proyeccion a su tenant: una
// membership de otra empresa se rechaza antes de abrir ninguna business DB.
async function proyectarRolActivoMembership({ membershipId, controlDbPath, empresaIdEsperada } = {}) {
  const id = enteroPositivo(membershipId);
  if (!id) {
    return noProcesable("MEMBERSHIP_ID_INVALIDO");
  }

  const lectura = await leerSnapshotCentral(controlDbPath, id);
  if (!lectura.ok) {
    return lectura;
  }
  const { snapshot } = lectura;
  const base = { membershipId: id, empresaId: snapshot.empresaId, usuarioLocalId: snapshot.usuarioLocalId };

  if (empresaIdEsperada !== undefined && empresaIdEsperada !== null && Number(empresaIdEsperada) !== snapshot.empresaId) {
    return noProcesable("MEMBERSHIP_DE_OTRA_EMPRESA", base);
  }
  if (!lectura.tieneLapida) {
    return noProcesable("SIN_AUTORIDAD_CENTRAL", base);
  }
  if (!snapshotValido(snapshot)) {
    return noProcesable("SNAPSHOT_INVALIDO", base);
  }

  // Ruta de la business DB EXCLUSIVAMENTE desde el registry central (binding id+slug, empresa
  // activa, path canonico dentro del directorio permitido) -- nunca desde el caller.
  const registro = await resolverTenantDbRegistrado({
    empresaId: snapshot.empresaId,
    empresaSlug: snapshot.empresaSlug,
    controlDbPath: controlDbPath || undefined
  });
  if (!registro.ok) {
    return noProcesable(registro.errorCode || "TENANT_REGISTRY_INVALIDO", base);
  }
  const businessDbPath = registro.db.resolvedPath;
  if (!fs.existsSync(businessDbPath)) {
    return noProcesable("BUSINESS_DB_AUSENTE", base);
  }

  let businessDb;
  try {
    businessDb = await abrirBusinessDbEscrituraExistente(businessDbPath);
  } catch (error) {
    return noProcesable("BUSINESS_DB_INACCESIBLE", { ...base, error: error.message });
  }
  let transaccionAbierta = false;
  try {
    await runQuery(businessDb, "PRAGMA busy_timeout = 5000");
    await runQuery(businessDb, "BEGIN IMMEDIATE");
    transaccionAbierta = true;

    // tenant_identity, esquema y escritura en la MISMA conexion y la MISMA transaccion.
    const identidad = await verificarTenantDbIdentityEnConexion(businessDb, {
      empresaId: snapshot.empresaId,
      empresaSlug: snapshot.empresaSlug
    });
    if (!identidad.ok) {
      return noProcesable("TENANT_IDENTITY_INVALIDA", { ...base, detalle: identidad.errorCode });
    }
    const esquema = await verificarBusinessSchemaVersionEnConexion(businessDb);
    if (esquema.state !== "CURRENT") {
      return noProcesable("ESQUEMA_TENANT_NO_CURRENT", { ...base, detalle: esquema.state });
    }
    const columnas = await allQuery(businessDb, "PRAGMA table_info(usuarios)");
    if (!columnas.some((columna) => columna.name === COLUMNA_VERSION_PROYECCION)) {
      return noProcesable("COLUMNA_PROYECCION_AUSENTE", base);
    }

    const aplicado = await aplicarProyeccionMonotonica(businessDb, snapshot);
    if (aplicado.resultado === RESULTADOS_PROYECCION.NO_PROCESABLE) {
      return { ...aplicado, ...base };
    }
    await runQuery(businessDb, "COMMIT");
    transaccionAbierta = false;
    return { ...aplicado, ...base };
  } catch (error) {
    return noProcesable("ERROR_ESCRITURA_LOCAL", { ...base, error: error.message });
  } finally {
    if (transaccionAbierta) {
      try { await runQuery(businessDb, "ROLLBACK"); } catch (_) { /* se preserva el resultado original */ }
    }
    await closeDb(businessDb);
  }
}

module.exports = {
  RESULTADOS_PROYECCION,
  COLUMNA_VERSION_PROYECCION,
  aplicarProyeccionMonotonica,
  proyectarRolActivoMembership
};
