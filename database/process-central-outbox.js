// AUTH-SYNC-B2-P1A: consumer dedicado del outbox durable (CENTRAL -> LOCAL), direccion opuesta a
// database/reconcile-shadow-users.js (LOCAL -> CENTRAL / auditoria). Deliberadamente NO se agrega
// esta responsabilidad al reconciliador -- mezclar ambas direcciones de autoridad en un mismo
// modulo fue identificado como riesgo explicito durante el diseno de este slice. Este archivo
// nunca lee la Business DB como fuente de verdad: la Business DB es aca exclusivamente destino de
// escritura (shadow), y `atlas_control.db` es la unica fuente de verdad para el hash vigente.
//
// Deliberadamente NO importa nada de backend/userControlBridge.js ni de
// database/reconcile-shadow-users.js -- misma decision de desacoplamiento ya documentada en ambos
// (MT-1C.1D-AUDIT seccion 9 / AUTH-SYNC-B2-S1A2D): la capa database/ no depende de backend/*, y
// cada herramienta de esta familia mantiene su propia copia de las funciones que necesita para no
// acoplar su ciclo de vida al de otra.
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();
const {
  DEFAULT_DB_PATH,
  closeDb,
  runQuery,
  getQuery,
  allQuery,
  resolveEmpresaDbPath
} = require("./init-control-db");

// Misma apertura seguras ya establecidas en reconcile-shadow-users.js/userControlBridge.js:
// OPEN_READWRITE sin OPEN_CREATE, nunca materializa un archivo nuevo por accidente; callback
// explicito para que un fallo de apertura rechace la promesa en vez de tumbar el proceso.
function abrirControlDbEscritura(dbPath) {
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

function abrirBusinessDbEscritura(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (error) => {
      if (error) { reject(error); return; }
      resolve(db);
    });
  });
}

// Tercera copia deliberada de este detector (ya existe en reconcile-shadow-users.js y en
// sync-shadow-users.js, cada una independiente por el mismo motivo de desacoplamiento). Puramente
// introspectivo -- nunca migra, nunca altera. Ver database/reconcile-shadow-users.js para el
// razonamiento completo de los tres casos (A/B/C).
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
    const formaCorrecta = columnasEsperadas.every((columna) => nombresSyncPendiente.has(columna));
    if (!formaCorrecta) {
      return { soportaS0: null, motivo: "SYNC_PENDIENTE_FORMA_INCOMPATIBLE" };
    }
    return { soportaS0: true };
  }

  return { soportaS0: null, motivo: "ESQUEMA_S0_PARCIAL" };
}

// AUTH-SYNC-B2-P1A: backfill de memberships que no existian todavia cuando una identidad recibio
// su primer cambio de password central-first. NO le pertenece al reconciliador (esa decision es
// explicita: el reconciliador nunca escribe en sync_pendiente, solo lo lee para proteger). Regla
// estricta: solo INSERT de filas faltantes -- jamas reabre ni toca una fila que ya existe (viva o
// procesada). El fan-out de un cambio de password NUEVO (userControlBridge.actualizarPasswordCentralFirst)
// es el UNICO camino que reabre una fila existente a 'pendiente'; este backfill nunca lo hace.
// Corre una transaccion propia POR IDENTIDAD para no competir de forma insegura con un cambio de
// password concurrente sobre la misma identidad (ver seccion de concurrencia del contrato).
async function backfillMembershipsFaltantes(controlDb) {
  const usuariosConMarker = await allQuery(
    controlDb,
    "SELECT DISTINCT usuario_id FROM sync_pendiente WHERE tipo_operacion = 'password'"
  );

  for (const fila of usuariosConMarker) {
    const usuarioId = Number(fila.usuario_id);
    await runQuery(controlDb, "BEGIN IMMEDIATE");
    let transactionStarted = true;
    try {
      const central = await getQuery(controlDb, "SELECT id, version FROM usuarios WHERE id = ?", [usuarioId]);
      if (!central) {
        await runQuery(controlDb, "ROLLBACK");
        transactionStarted = false;
        continue;
      }
      const memberships = await allQuery(
        controlDb,
        "SELECT id, empresa_id, usuario_local_id FROM usuario_empresas WHERE usuario_id = ?",
        [usuarioId]
      );
      for (const membership of memberships) {
        const existente = await getQuery(
          controlDb,
          "SELECT id FROM sync_pendiente WHERE membership_id = ? AND tipo_operacion = 'password'",
          [membership.id]
        );
        if (existente) continue;
        await runQuery(
          controlDb,
          `INSERT INTO sync_pendiente
             (usuario_id, empresa_id, membership_id, usuario_local_id, tipo_operacion, version_objetivo, estado)
           VALUES (?, ?, ?, ?, 'password', ?, 'pendiente')`,
          [usuarioId, membership.empresa_id, membership.id, membership.usuario_local_id, Number(central.version)]
        );
      }
      await runQuery(controlDb, "COMMIT");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        try { await runQuery(controlDb, "ROLLBACK"); } catch (rollbackError) { error.rollbackError = rollbackError; }
      }
      throw error;
    }
  }
}

// AUTH-SYNC-B2-P1A: primitiva compartida -- procesa UNA fila del outbox de password. Usada tanto
// por el drenaje por lote (drenarOutboxPassword) como por el intento inmediato del handler HTTP
// (via procesarPendientePasswordStandalone). Recibe una conexion YA ABIERTA a Control DB (el
// caller decide su ciclo de vida) para que el drenaje por lote pueda reutilizar una unica conexion
// a traves de muchas filas sin reabrir el archivo en cada iteracion.
//
// Ningun paso de esta funcion es capaz de cerrar una fila que no proceso exitosamente: el cierre
// (ultimo paso) usa CAS por version_objetivo sobre la clave natural (membership_id, tipo_operacion)
// -- la misma UNIQUE ya existente en el esquema -- en vez de depender de un id de fila que el
// caller HTTP no siempre tiene a mano tras el commit central.
async function procesarPendientePassword(controlDb, { usuarioId, empresaId, membershipId, usuarioLocalId, versionObjetivo }) {
  const empresa = await getQuery(controlDb, "SELECT id, activa, db_path FROM empresas WHERE id = ?", [empresaId]);
  if (!empresa) {
    return { membershipId, resultado: "SKIP_EMPRESA_INEXISTENTE" };
  }
  if (Number(empresa.activa) !== 1) {
    return { membershipId, resultado: "SKIP_EMPRESA_INACTIVA" };
  }

  // membership.activo NO se consulta aca a proposito: password es global (GLOBAL USER), no una
  // propiedad de la membership -- actualizar el espejo local de una membership inactiva es
  // seguro y correcto (contrato P1A, seccion "consumer - procesamiento de una fila").

  let businessDbPath;
  try {
    businessDbPath = resolveEmpresaDbPath(empresa.db_path);
  } catch (error) {
    return { membershipId, resultado: "SKIP_PATH_INVALIDO", error: error.message };
  }

  if (!fs.existsSync(businessDbPath)) {
    return { membershipId, resultado: "SKIP_BUSINESS_DB_AUSENTE" };
  }

  let businessDb;
  try {
    businessDb = await abrirBusinessDbEscritura(businessDbPath);
  } catch (error) {
    return { membershipId, resultado: "SKIP_BUSINESS_DB_INACCESIBLE", error: error.message };
  }

  try {
    const usuarioLocal = await getQuery(businessDb, "SELECT id FROM usuarios WHERE id = ?", [usuarioLocalId]);
    if (!usuarioLocal) {
      return { membershipId, resultado: "SKIP_USUARIO_LOCAL_INEXISTENTE" };
    }

    // Releido FRESCO en cada intento -- nunca se usa un hash capturado en un momento anterior.
    // sync_pendiente nunca almacena el hash (confirmado: la tabla no tiene columna para eso).
    const central = await getQuery(controlDb, "SELECT password_hash FROM usuarios WHERE id = ?", [usuarioId]);
    if (!central) {
      return { membershipId, resultado: "SKIP_CENTRAL_INEXISTENTE" };
    }

    await runQuery(businessDb, "UPDATE usuarios SET password = ? WHERE id = ?", [central.password_hash, usuarioLocalId]);
  } catch (error) {
    return { membershipId, resultado: "SKIP_ERROR_ESCRITURA_LOCAL", error: error.message };
  } finally {
    await closeDb(businessDb);
  }

  // Cierre CAS: si version_objetivo ya no coincide (una generacion mas nueva llego mientras se
  // procesaba esta fila), changes=0 -- la fila sigue pendiente con la generacion nueva, nunca se
  // cierra por error una generacion vieja sobre una nueva.
  const cierre = await runQuery(
    controlDb,
    `UPDATE sync_pendiente
     SET estado = 'procesado', procesado_en = datetime('now')
     WHERE membership_id = ? AND tipo_operacion = 'password' AND estado = 'pendiente' AND version_objetivo = ?`,
    [membershipId, versionObjetivo]
  );

  if (cierre.changes !== 1) {
    return { membershipId, resultado: "PENDING_GENERACION_MAS_NUEVA" };
  }
  return { membershipId, resultado: "PROCESADO" };
}

// Envoltorio de conveniencia para el handler HTTP: abre y cierra su propia conexion de corta vida
// a Control DB alrededor de UNA sola fila -- usa exactamente la misma primitiva que el drenaje por
// lote, nunca una copia distinta de la logica de cierre/CAS.
async function procesarPendientePasswordStandalone(filaFields, { controlDbPath } = {}) {
  const dbPath = controlDbPath || DEFAULT_DB_PATH;
  const controlDb = await abrirControlDbEscritura(dbPath);
  try {
    return await procesarPendientePassword(controlDb, filaFields);
  } finally {
    await closeDb(controlDb);
  }
}

// AUTH-SYNC-B2-P1A: verificacion fail-closed para el handler HTTP -- ANTES de calcular bcrypt o
// intentar cualquier escritura central, se confirma que el esquema soporta el contrato necesario
// (version + sync_pendiente con forma correcta). Nunca migra, nunca crea Control DB (si no existe,
// se reporta como esquema no soportado -- no se usa OPEN_CREATE en ningun punto de este modulo).
async function verificarSoporteS0Standalone({ controlDbPath } = {}) {
  const dbPath = controlDbPath || DEFAULT_DB_PATH;
  if (!fs.existsSync(dbPath)) {
    return { soportaS0: false, motivo: "CONTROL_DB_AUSENTE" };
  }
  let controlDb;
  try {
    controlDb = await abrirControlDbEscritura(dbPath);
  } catch (error) {
    return { soportaS0: false, motivo: "CONTROL_DB_INACCESIBLE" };
  }
  try {
    const deteccion = await detectarSoporteEsquemaS0(controlDb);
    return deteccion;
  } finally {
    await closeDb(controlDb);
  }
}

// AUTH-SYNC-B2-P1A: drenaje por lote, invocacion manual via CLI -- mismo patron operacional 100%
// manual ya vigente y ya certificado para database/reconcile-shadow-users.js. No se agrega cron,
// timer ni hook de prestart (fuera de alcance explicito de este slice). Una fila fallida nunca
// impide procesar las demas -- los errores se capturan por fila, no abortan el lote completo.
async function drenarOutboxPassword({ controlDbPath } = {}) {
  const dbPath = controlDbPath || DEFAULT_DB_PATH;
  if (!fs.existsSync(dbPath)) {
    return { ok: false, errorCode: "CONTROL_DB_AUSENTE", message: `Control plane no encontrado: ${dbPath}` };
  }

  let controlDb;
  try {
    controlDb = await abrirControlDbEscritura(dbPath);
  } catch (error) {
    return { ok: false, errorCode: "CONTROL_DB_INACCESIBLE", message: error.message };
  }

  try {
    const deteccion = await detectarSoporteEsquemaS0(controlDb);
    if (deteccion.soportaS0 !== true) {
      return {
        ok: false,
        errorCode: "SCHEMA_S0_INCOMPATIBLE",
        message: `Esquema de Control DB parcial o incompatible con S0 (${deteccion.motivo || "PRE_S0"}) -- drenaje abortado sin escrituras`
      };
    }

    await backfillMembershipsFaltantes(controlDb);

    const pendientes = await allQuery(
      controlDb,
      "SELECT usuario_id, empresa_id, membership_id, usuario_local_id, version_objetivo FROM sync_pendiente WHERE tipo_operacion = 'password' AND estado = 'pendiente'"
    );

    const resultados = [];
    for (const fila of pendientes) {
      try {
        const resultado = await procesarPendientePassword(controlDb, {
          usuarioId: Number(fila.usuario_id),
          empresaId: Number(fila.empresa_id),
          membershipId: Number(fila.membership_id),
          usuarioLocalId: Number(fila.usuario_local_id),
          versionObjetivo: Number(fila.version_objetivo)
        });
        resultados.push(resultado);
      } catch (error) {
        resultados.push({ membershipId: Number(fila.membership_id), resultado: "ERROR", error: error.message });
      }
    }

    return { ok: true, total: pendientes.length, resultados };
  } finally {
    await closeDb(controlDb);
  }
}

async function runCli() {
  const resultado = await drenarOutboxPassword({});
  if (!resultado.ok) {
    console.error(`ERROR: [${resultado.errorCode}] ${resultado.message}`);
    return 2;
  }
  console.log(`Outbox password: ${resultado.total} filas pendientes evaluadas.`);
  resultado.resultados.forEach((r) => {
    console.log(`  membership_id=${r.membershipId} resultado=${r.resultado}${r.error ? ` error="${r.error}"` : ""}`);
  });
  const errores = resultado.resultados.filter((r) => r.resultado === "ERROR").length;
  return errores > 0 ? 1 : 0;
}

module.exports = {
  detectarSoporteEsquemaS0,
  backfillMembershipsFaltantes,
  procesarPendientePassword,
  procesarPendientePasswordStandalone,
  verificarSoporteS0Standalone,
  drenarOutboxPassword,
  runCli
};

if (require.main === module) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}
