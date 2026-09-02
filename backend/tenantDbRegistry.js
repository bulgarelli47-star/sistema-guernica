const fs = require("fs");
const {
  ALLOWED_DB_DIR,
  DEFAULT_DB_PATH,
  closeDb,
  getQuery,
  resolveEmpresaDbPath
} = require("../database/init-control-db");
const { abrirControlDbSoloLectura } = require("./centralAuthResolver");

function resultadoError(errorCode, message, parcial = {}) {
  return { ok: false, errorCode, message, ...parcial };
}

function normalizarId(valor) {
  const numero = Number(valor);
  return Number.isInteger(numero) && numero > 0 ? numero : null;
}

function resolverDbPathRegistrado(registeredPath) {
  if (typeof registeredPath !== "string" || !registeredPath.trim()) {
    throw new Error("db_path registrado invalido");
  }

  const resolvedPath = resolveEmpresaDbPath(registeredPath);
  if (resolvedPath === ALLOWED_DB_DIR) {
    throw new Error("db_path registrado apunta al directorio raiz de databases");
  }
  if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
    throw new Error("db_path registrado apunta a un directorio");
  }

  return resolvedPath;
}

async function resolverTenantDbRegistrado({ empresaId, empresaSlug, controlDbPath } = {}) {
  const id = normalizarId(empresaId);
  const slug = String(empresaSlug || "").trim();
  if (!id || !slug) {
    return resultadoError("TENANT_REGISTRY_BINDING_INVALID", "resolverTenantDbRegistrado: empresaId/empresaSlug invalidos");
  }

  const resolvedControlDbPath = controlDbPath || DEFAULT_DB_PATH;
  if (!fs.existsSync(resolvedControlDbPath)) {
    return resultadoError("TENANT_REGISTRY_CONTROL_DB_AUSENTE", `Control plane no encontrado: ${resolvedControlDbPath}`);
  }

  let controlDb;
  try {
    controlDb = await abrirControlDbSoloLectura(resolvedControlDbPath);
  } catch (error) {
    return resultadoError("TENANT_REGISTRY_CONTROL_DB_INACCESIBLE", error.message);
  }

  try {
    const row = await getQuery(
      controlDb,
      `SELECT id, slug, nombre, db_path, activa
       FROM empresas
       WHERE id = ? AND slug = ?`,
      [id, slug]
    );

    if (!row) {
      return resultadoError("TENANT_REGISTRY_BINDING_INVALID", "La empresa no coincide con el registry central");
    }

    const empresa = {
      id: row.id,
      slug: row.slug,
      nombre: row.nombre,
      activa: Number(row.activa) === 1
    };

    if (!empresa.activa) {
      return resultadoError("EMPRESA_INACTIVA", "La empresa registrada esta inactiva", { empresa });
    }

    const db = {
      registeredPath: row.db_path,
      resolvedPath: null
    };

    try {
      db.resolvedPath = resolverDbPathRegistrado(row.db_path);
    } catch (error) {
      return resultadoError("TENANT_DB_PATH_INVALID", error.message, { empresa, db });
    }

    // Este resolver solo certifica metadata del registry; no abre ni materializa la business DB.
    return { ok: true, empresa, db };
  } catch (error) {
    return resultadoError("TENANT_REGISTRY_CONTROL_DB_QUERY_ERROR", error.message);
  } finally {
    await closeDb(controlDb);
  }
}

module.exports = {
  resolverTenantDbRegistrado
};
