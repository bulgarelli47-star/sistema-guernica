const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();
const { closeDb, getQuery } = require("../database/init-control-db");

function resultadoError(errorCode, message, parcial = {}) {
  return { ok: false, errorCode, message, ...parcial };
}

function normalizarId(valor) {
  const numero = Number(valor);
  return Number.isInteger(numero) && numero > 0 ? numero : null;
}

function esIdentityValida(row) {
  if (!row) return false;
  return Number.isInteger(row.empresa_control_id)
    && row.empresa_control_id > 0
    && typeof row.tenant_slug === "string"
    && row.tenant_slug.length > 0
    && row.tenant_slug === row.tenant_slug.trim();
}

function abrirBusinessDbSoloLectura(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (error) => {
      if (error) { reject(error); return; }
      resolve(db);
    });
  });
}

async function verificarTenantDbIdentity({ dbPath, empresaId, empresaSlug } = {}) {
  const id = normalizarId(empresaId);
  const slug = String(empresaSlug || "").trim();
  if (typeof dbPath !== "string" || !dbPath.trim() || !id || !slug) {
    return resultadoError("TENANT_DB_IDENTITY_ARGUMENTOS_INVALIDOS", "verificarTenantDbIdentity: argumentos invalidos");
  }

  if (!fs.existsSync(dbPath)) {
    return resultadoError("TENANT_DB_AUSENTE", `Business DB no encontrada: ${dbPath}`);
  }

  let db;
  try {
    db = await abrirBusinessDbSoloLectura(dbPath);
  } catch (error) {
    return resultadoError("TENANT_DB_INACCESIBLE", error.message);
  }

  try {
    const row = await getQuery(
      db,
      `SELECT empresa_control_id, tenant_slug
       FROM tenant_identity
       WHERE id = 1`
    );

    if (!row) {
      return resultadoError("TENANT_DB_IDENTITY_MISSING", "La business DB no declara tenant_identity");
    }

    if (!esIdentityValida(row)) {
      return resultadoError("TENANT_DB_IDENTITY_INVALID", "La business DB declara una identity invalida");
    }

    const identity = {
      empresaId: row.empresa_control_id,
      slug: row.tenant_slug
    };

    if (identity.empresaId !== id || identity.slug !== slug) {
      return resultadoError("TENANT_DB_IDENTITY_MISMATCH", "La business DB declara otra identidad tenant", { identity });
    }

    return { ok: true, identity };
  } catch (error) {
    return resultadoError("TENANT_DB_IDENTITY_QUERY_ERROR", error.message);
  } finally {
    await closeDb(db);
  }
}

module.exports = {
  verificarTenantDbIdentity
};
