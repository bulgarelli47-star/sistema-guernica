// MT-1C.1D: herramienta operativa de reconciliacion shadow. Distinta de sync-shadow-users.js
// (bootstrap/import legacy, mirror total incluyendo perfil y central.activo=local.activo) --
// este reconciler solo detecta y repara divergencias SEGURAS entre una empresa local y su
// espejo en atlas_control.db, respetando el contrato de autoridades ya cerrado (ver
// MT-1C.1D-AUDIT): password/rol/activo-de-membership tienen autoridad LOCAL durante shadow;
// central.activo (global) y el perfil NUNCA se reparan automaticamente aca.
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();
const {
  DEFAULT_DB_PATH,
  closeDb,
  runQuery,
  getQuery,
  allQuery,
  resolveEmpresaDbPath,
  crearUsuarioCentral,
  crearMembership,
  actualizarPasswordUsuarioCentral,
  actualizarAccesoMembership
} = require("./init-control-db");

// Apertura segura compartida por business DB (siempre solo lectura) y control DB en modo CHECK
// (tambien solo lectura). Con callback explicito: si sqlite3.Database() fallase al abrir sin
// callback, emitiria un evento 'error' sin listener y tumbaria el proceso entero en vez de
// rechazar la promesa (el mismo riesgo ya documentado y resuelto en userControlBridge.js).
function abrirDbSoloLectura(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (error) => {
      if (error) { reject(error); return; }
      resolve(db);
    });
  });
}

// APPLY necesita escritura real, pero jamas debe poder materializar un control plane nuevo por
// accidente: se abre con OPEN_READWRITE sin OPEN_CREATE, igual que abrirControlDbBridge en
// userControlBridge.js -- pero implementado aca de forma independiente a proposito (ver
// MT-1C.1D-AUDIT seccion 9: la capa database/ no deberia depender de backend/*).
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

// AUTH-SYNC-B2-S1A1-PARTIAL-SCHEMA-HARDENING: deteccion de soporte del esquema S0 por
// introspeccion pura -- nunca migra, nunca altera. Verifica los TRES elementos de S0 por
// separado -- usuarios.version, usuario_empresas.version y la tabla sync_pendiente -- porque
// initControlSchema agrega version a AMBAS tablas (usuarios Y usuario_empresas), no solo a
// usuario_empresas. Verificar solo esta ultima (version original de este checkpoint) dejaba
// esquemas con unicamente usuarios.version mal clasificados como CASO A (pre-S0), y esquemas con
// usuario_empresas.version + sync_pendiente pero SIN usuarios.version mal clasificados como CASO
// B (S0 completo) -- ambos casos, hoy corregidos, caen en CASO C (parcial). Tres resultados:
//   CASO A (soportaS0=false): NINGUNA de las tres estructuras existe -- Control DB legacy pre-S0,
//     la reconciliacion se comporta EXACTAMENTE como antes de este checkpoint.
//   CASO B (soportaS0=true): las TRES existen, con sync_pendiente en su forma minima esperada --
//     proteccion permanente de rol_activo y versionado CAS quedan activos.
//   CASO C (soportaS0=null): cualquier otra combinacion (una o dos de las tres estructuras
//     presentes, o sync_pendiente presente pero le faltan columnas esperadas) -- FAIL CLOSED: el
//     caller debe abortar sin escribir nada, en CHECK o en APPLY, porque no se puede determinar
//     con certeza si una reparacion legacy seria segura. Deliberadamente NO importada desde
//     database/sync-shadow-users.js (que tiene su propia copia identica en criterio, por el mismo
//     motivo ya documentado en ambos modulos: no acoplar el reconciliador S1A1 al importador
//     legacy S1A2D, ni viceversa).
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

function normalizarModo(modoRaw) {
  const modo = String(modoRaw || "check").trim().toLowerCase();
  if (modo !== "check" && modo !== "apply") {
    throw new Error(`Modo de reconciliacion invalido: ${modoRaw}`);
  }
  return modo;
}

// Unica transaccion para no dejar jamas una identidad central huerfana si la membership falla
// (misma forma que syncUserCreate en userControlBridge.js, reimplementada aca deliberadamente
// para no acoplar la capa database/ al runtime del bridge -- ver MT-1C.1D-AUDIT seccion 20/40).
async function crearIdentidadYMembershipDesdeLocal(controlDb, empresaId, local) {
  await runQuery(controlDb, "BEGIN IMMEDIATE");
  let transactionStarted = true;
  try {
    const central = await crearUsuarioCentral(controlDb, {
      nombre: local.nombre,
      usuarioReferencia: local.usuario,
      passwordHash: local.password,
      email: local.email,
      telefono: local.telefono,
      fotoUrl: local.foto_url || null,
      activo: 1
    });
    const membership = await crearMembership(controlDb, {
      usuarioId: central.id,
      empresaId,
      usuarioLocalId: local.id,
      rol: local.rol,
      activo: local.activo
    });
    await runQuery(controlDb, "COMMIT");
    transactionStarted = false;
    return { central, membership };
  } catch (error) {
    if (transactionStarted) {
      try { await runQuery(controlDb, "ROLLBACK"); } catch (rollbackError) { error.rollbackError = rollbackError; }
    }
    throw error;
  }
}

// AUTH-SYNC-B2-S1A1: password y acceso (rol+activo de membership) ya NO comparten
// incondicionalmente la misma autoridad -- acceso puede pasar a ser central-first (lapida en
// sync_pendiente), password sigue con autoridad LOCAL mientras no exista un marcador propio para
// la identidad (fuera de alcance de este checkpoint). Se reparan en la MISMA transaccion (una
// unidad atomica por usuario, MT-1C.1D-AUDIT seccion 17), pero cada rama se decide y se re-verifica
// por separado, DENTRO de la transaccion -- nunca confiando en el mismatch calculado antes de
// BEGIN, para cerrar la carrera entre leer la lapida/version y escribir (ver
// AUTH-SYNC-B2-S1-CONTRACT-RECTIFICATION seccion 2 y AUTH-SYNC-B2-S1A-SAFETY-GATE seccion 5).
// `soportaS0` llega ya resuelto por detectarSoporteEsquemaS0 (una sola vez por corrida, no por
// fila) -- en CASO A (legacy) nunca se consulta version/sync_pendiente, se preserva exactamente
// la sentencia actualizarAccesoMembership de siempre.
async function repararPasswordYAcceso(controlDb, { centralId, membershipId, local, passwordMismatch, accessMismatch, soportaS0 }) {
  await runQuery(controlDb, "BEGIN IMMEDIATE");
  let transactionStarted = true;
  try {
    let escribioPassword = false;
    let escribioAcceso = false;
    let accesoProtegido = false;

    if (passwordMismatch) {
      const centralActual = await getQuery(controlDb, "SELECT password_hash FROM usuarios WHERE id = ?", [centralId]);
      if (centralActual && String(centralActual.password_hash) !== String(local.password)) {
        await actualizarPasswordUsuarioCentral(controlDb, centralId, local.password);
        escribioPassword = true;
      }
    }

    if (accessMismatch) {
      let lapidaExiste = false;
      if (soportaS0) {
        // Releida DENTRO de la transaccion -- una comprobacion hecha antes de BEGIN nunca es
        // autorizacion suficiente para escribir: podria haberse creado una lapida nueva mientras
        // tanto (ver seccion 5 del checkpoint).
        const lapida = await getQuery(
          controlDb,
          "SELECT 1 AS x FROM sync_pendiente WHERE membership_id = ? AND tipo_operacion = 'rol_activo'",
          [membershipId]
        );
        lapidaExiste = Boolean(lapida);
      }

      if (lapidaExiste) {
        accesoProtegido = true;
      } else {
        // En CASO A (pre-S0), la columna version NO existe -- pedirla incondicionalmente rompe la
        // consulta con "no such column". Solo se selecciona cuando el esquema la soporta.
        const membershipActual = soportaS0
          ? await getQuery(controlDb, "SELECT rol, activo, version FROM usuario_empresas WHERE id = ?", [membershipId])
          : await getQuery(controlDb, "SELECT rol, activo FROM usuario_empresas WHERE id = ?", [membershipId]);
        if (membershipActual) {
          const rolMismatchFresco = String(local.rol) !== String(membershipActual.rol);
          const activoMismatchFresco = Number(local.activo ? 1 : 0) !== Number(membershipActual.activo ? 1 : 0);
          if (rolMismatchFresco || activoMismatchFresco) {
            if (soportaS0) {
              const result = await runQuery(
                controlDb,
                "UPDATE usuario_empresas SET rol = ?, activo = ?, version = version + 1, actualizado_en = datetime('now') WHERE id = ? AND version = ?",
                [local.rol, local.activo ? 1 : 0, membershipId, membershipActual.version]
              );
              if (result.changes !== 1) {
                throw new Error(`repararPasswordYAcceso: CAS de acceso no coincidio (membershipId=${membershipId}, version esperada=${membershipActual.version}, changes=${result.changes})`);
              }
            } else {
              await actualizarAccesoMembership(controlDb, membershipId, { rol: local.rol, activo: local.activo });
            }
            escribioAcceso = true;
          }
        }
      }
    }

    await runQuery(controlDb, "COMMIT");
    transactionStarted = false;
    return { escribioPassword, escribioAcceso, accesoProtegido };
  } catch (error) {
    if (transactionStarted) {
      try { await runQuery(controlDb, "ROLLBACK"); } catch (rollbackError) { error.rollbackError = rollbackError; }
    }
    throw error;
  }
}

function perfilDifiere(local, central) {
  return String(local.nombre || "") !== String(central.nombre || "") ||
    String(local.usuario || "") !== String(central.usuario_referencia || "") ||
    String(local.email || "") !== String(central.email || "") ||
    String(local.telefono || "") !== String(central.telefono || "") ||
    String(local.foto_url || "") !== String(central.foto_url || "");
}

// Funcion principal, pensada para ser llamada directamente desde tests (sin pasar por CLI ni por
// argv). businessDbPath es un override deliberado -- igual que syncUsuariosShadowDesdeDbPath en
// sync-shadow-users.js -- para que los tests puedan apuntar a una DB temporal fuera del
// directorio de empresas registradas sin tener que registrar rutas reales.
async function reconcileShadowUsers({ empresaSlug, mode: modeRaw, controlDbPath, businessDbPath: businessDbPathOverride } = {}) {
  const empresaSlugTrimmed = String(empresaSlug || "").trim();
  if (!empresaSlugTrimmed) {
    return { ok: false, errorCode: "EMPRESA_REQUERIDA", message: "reconcileShadowUsers: falta empresaSlug" };
  }

  let mode;
  try {
    mode = normalizarModo(modeRaw);
  } catch (error) {
    return { ok: false, errorCode: "MODO_INVALIDO", message: error.message };
  }

  const resolvedControlDbPath = controlDbPath || DEFAULT_DB_PATH;
  if (!fs.existsSync(resolvedControlDbPath)) {
    return { ok: false, errorCode: "CONTROL_DB_AUSENTE", message: `Control plane no encontrado: ${resolvedControlDbPath}` };
  }

  let controlDb;
  try {
    controlDb = mode === "apply"
      ? await abrirControlDbEscritura(resolvedControlDbPath)
      : await abrirDbSoloLectura(resolvedControlDbPath);
  } catch (error) {
    return { ok: false, errorCode: "CONTROL_DB_INACCESIBLE", message: error.message };
  }

  // AUTH-SYNC-B2-S1A1: deteccion de esquema UNA sola vez por corrida, antes de tocar cualquier
  // empresa/usuario -- puramente por introspeccion, nunca migra. CASO C (parcial/incompatible)
  // aborta de inmediato, en CHECK o en APPLY: no hay forma segura de asumir que una reparacion
  // legacy es correcta cuando el esquema esta a medio camino.
  let soportaS0;
  try {
    const deteccion = await detectarSoporteEsquemaS0(controlDb);
    if (deteccion.soportaS0 === null) {
      await closeDb(controlDb);
      return {
        ok: false,
        errorCode: "SCHEMA_S0_INCOMPATIBLE",
        message: `Esquema de Control DB parcial o incompatible con S0 (${deteccion.motivo}) -- reconciliacion abortada sin escrituras`
      };
    }
    soportaS0 = deteccion.soportaS0;
  } catch (error) {
    await closeDb(controlDb);
    return { ok: false, errorCode: "SCHEMA_DETECTION_ERROR", message: error.message };
  }

  try {
    const empresa = await getQuery(controlDb, "SELECT * FROM empresas WHERE slug = ?", [empresaSlugTrimmed]);
    if (!empresa) {
      return { ok: false, errorCode: "EMPRESA_NO_EXISTE", message: `Empresa '${empresaSlugTrimmed}' no existe en el control plane` };
    }
    const empresaActiva = Number(empresa.activa) === 1;
    const escrituraPermitida = mode === "apply" && empresaActiva;

    let businessDbPath;
    if (businessDbPathOverride) {
      businessDbPath = businessDbPathOverride;
    } else {
      try {
        businessDbPath = resolveEmpresaDbPath(empresa.db_path);
      } catch (error) {
        return { ok: false, errorCode: "BUSINESS_DB_PATH_INVALIDO", message: error.message };
      }
    }
    if (!fs.existsSync(businessDbPath)) {
      return { ok: false, errorCode: "BUSINESS_DB_AUSENTE", message: `Business DB no encontrada: ${businessDbPath}` };
    }

    let businessDb;
    try {
      businessDb = await abrirDbSoloLectura(businessDbPath);
    } catch (error) {
      return { ok: false, errorCode: "BUSINESS_DB_INACCESIBLE", message: error.message };
    }
    let usuariosLocales;
    try {
      usuariosLocales = await allQuery(businessDb, "SELECT * FROM usuarios");
    } finally {
      await closeDb(businessDb);
    }

    const memberships = await allQuery(controlDb, "SELECT * FROM usuario_empresas WHERE empresa_id = ?", [empresa.id]);
    const membershipByLocalId = new Map(memberships.map((m) => [Number(m.usuario_local_id), m]));
    const localIds = new Set(usuariosLocales.map((u) => Number(u.id)));

    const summary = {
      total_local: usuariosLocales.length,
      aligned: 0,
      repaired: 0,
      critical: 0,
      review_blockers: 0,
      info: 0,
      errors: 0,
      protected_central: 0
    };
    const usuarios = [];

    for (const local of usuariosLocales) {
      const membership = membershipByLocalId.get(Number(local.id));
      const entry = {
        usuario_local_id: Number(local.id),
        central_id: null,
        membership_id: null,
        estados: [],
        acciones: []
      };

      if (!membership) {
        if (escrituraPermitida) {
          try {
            const creado = await crearIdentidadYMembershipDesdeLocal(controlDb, empresa.id, local);
            entry.central_id = creado.central.id;
            entry.membership_id = creado.membership.id;
            entry.acciones.push("CREAR_CENTRAL_Y_MEMBERSHIP");
            summary.repaired++;
          } catch (error) {
            entry.estados.push("ERROR");
            entry.error = error.message;
            summary.errors++;
          }
        } else {
          entry.estados.push("MISSING_MEMBERSHIP");
          summary.critical++;
        }
        if (entry.estados.length === 0) {
          entry.estados.push("ALIGNED");
          summary.aligned++;
        }
        usuarios.push(entry);
        continue;
      }

      entry.membership_id = membership.id;
      entry.central_id = membership.usuario_id;

      const central = await getQuery(controlDb, "SELECT * FROM usuarios WHERE id = ?", [membership.usuario_id]);
      if (!central) {
        entry.estados.push("BROKEN_CENTRAL_REF");
        summary.critical++;
        usuarios.push(entry);
        continue;
      }

      const passwordMismatch = String(local.password) !== String(central.password_hash);
      const rolMismatch = String(local.rol) !== String(membership.rol);
      const activoMismatch = Number(local.activo ? 1 : 0) !== Number(membership.activo ? 1 : 0);
      const accessMismatch = rolMismatch || activoMismatch;
      const globalActiveReview = Number(central.activo) === 0;
      const profileDiff = perfilDifiere(local, central);

      // AUTH-SYNC-B2-S1A1: la lapida se consulta aca SOLO para decidir que reportar en el resumen
      // (CHECK y APPLY informan igual, sin mutar nada por esta lectura) -- la autorizacion REAL
      // para escribir se re-verifica de nuevo, dentro de su propia transaccion, en
      // repararPasswordYAcceso. Cualquier estado de la lapida (pendiente o procesado) protege por
      // igual: nunca se borra, es el marcador de autoridad permanente.
      let accesoProtegidoPorCentral = false;
      if (soportaS0 && accessMismatch) {
        const lapida = await getQuery(
          controlDb,
          "SELECT 1 AS x FROM sync_pendiente WHERE membership_id = ? AND tipo_operacion = 'rol_activo'",
          [membership.id]
        );
        accesoProtegidoPorCentral = Boolean(lapida);
      }
      const accessAccionable = accessMismatch && !accesoProtegidoPorCentral;

      if ((passwordMismatch || accessAccionable) && escrituraPermitida) {
        try {
          const resultado = await repararPasswordYAcceso(controlDb, {
            centralId: central.id,
            membershipId: membership.id,
            local,
            passwordMismatch,
            accessMismatch: accessAccionable,
            soportaS0
          });
          if (resultado.escribioPassword) entry.acciones.push("PASSWORD");
          if (resultado.escribioAcceso) entry.acciones.push("ACCESS");
          if (resultado.escribioPassword || resultado.escribioAcceso) summary.repaired++;
        } catch (error) {
          entry.estados.push("ERROR");
          entry.error = error.message;
          summary.errors++;
        }
      } else {
        if (passwordMismatch) entry.estados.push("PASSWORD_MISMATCH");
        if (accessAccionable) entry.estados.push("MEMBERSHIP_ACCESS_MISMATCH");
        if (passwordMismatch || accessAccionable) summary.critical++;
      }

      if (accesoProtegidoPorCentral) {
        entry.estados.push("ACCESS_PROTECTED_CENTRAL_FIRST");
        summary.protected_central++;
      }

      if (globalActiveReview) {
        entry.estados.push("GLOBAL_ACTIVE_REVIEW");
        summary.review_blockers++;
      }
      if (profileDiff) {
        entry.estados.push("PROFILE_DIFF");
        summary.info++;
      }
      if (entry.estados.length === 0) {
        entry.estados.push("ALIGNED");
        summary.aligned++;
      }

      usuarios.push(entry);
    }

    // Direccion inversa: memberships de esta empresa que ya no tienen usuario local (borrado
    // local sin sync). No se busca "adjudicar" nada -- solo se reporta como critico.
    for (const membership of memberships) {
      if (!localIds.has(Number(membership.usuario_local_id))) {
        summary.critical++;
        usuarios.push({
          usuario_local_id: Number(membership.usuario_local_id),
          central_id: membership.usuario_id,
          membership_id: membership.id,
          estados: ["ORPHAN_MEMBERSHIP"],
          acciones: []
        });
      }
    }

    return {
      ok: true,
      empresa: empresa.slug,
      empresa_activa: empresaActiva,
      modo: mode,
      escritura_bloqueada_por_empresa_inactiva: mode === "apply" && !empresaActiva,
      summary,
      usuarios
    };
  } finally {
    await closeDb(controlDb);
  }
}

function parseArgs(argv) {
  const args = { empresa: null, check: false, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--empresa") {
      args.empresa = argv[++i] || null;
    } else if (arg.startsWith("--empresa=")) {
      args.empresa = arg.slice("--empresa=".length);
    } else if (arg === "--check") {
      args.check = true;
    } else if (arg === "--apply") {
      args.apply = true;
    } else {
      throw new Error(`Argumento desconocido: ${arg}`);
    }
  }
  return args;
}

function formatUsuarioLinea(usuario) {
  const acciones = usuario.acciones && usuario.acciones.length ? ` acciones=${usuario.acciones.join(",")}` : "";
  const error = usuario.error ? ` error="${usuario.error}"` : "";
  return `  usuario_local_id=${usuario.usuario_local_id} central_id=${usuario.central_id ?? "-"} membership_id=${usuario.membership_id ?? "-"} estado=${usuario.estados.join(",")}${acciones}${error}`;
}

async function runCli(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  if (!args.empresa) {
    console.error("Uso: node database/reconcile-shadow-users.js --empresa <slug> [--check|--apply]");
    return 2;
  }
  if (args.check && args.apply) {
    console.error("No se puede especificar --check y --apply simultaneamente");
    return 2;
  }
  const mode = args.apply ? "apply" : "check";

  const resultado = await reconcileShadowUsers({ empresaSlug: args.empresa, mode });
  if (!resultado.ok) {
    console.error(`ERROR: [${resultado.errorCode}] ${resultado.message}`);
    return 2;
  }

  console.log(`Empresa: ${resultado.empresa} (${resultado.empresa_activa ? "activa" : "INACTIVA"})`);
  console.log(`Modo: ${resultado.modo.toUpperCase()}`);
  if (resultado.escritura_bloqueada_por_empresa_inactiva) {
    console.log("APPLY solicitado pero la empresa esta inactiva: no se realizo ninguna escritura.");
  }
  console.log("");
  resultado.usuarios.forEach((usuario) => console.log(formatUsuarioLinea(usuario)));
  console.log("");
  const s = resultado.summary;
  console.log(`Resumen: total_local=${s.total_local} aligned=${s.aligned} repaired=${s.repaired} critical=${s.critical} review_blockers=${s.review_blockers} info=${s.info} errors=${s.errors} protected_central=${s.protected_central}`);

  if (s.critical > 0 || s.review_blockers > 0 || s.errors > 0) {
    return 1;
  }
  return 0;
}

module.exports = {
  reconcileShadowUsers,
  runCli,
  parseArgs
};

if (require.main === module) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
