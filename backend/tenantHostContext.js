const RESERVED_LABELS = new Set(["www", "app", "api"]);
const TENANT_LABEL_PATTERN = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.atlasos\.com\.ar$/;
const PORT_PATTERN = /^[0-9]{1,5}$/;

// GAP-1 Slice 1 (MT-1E1): parser puro Host -> contexto candidato de tenant. Deliberadamente sin
// fs/sqlite3/backend/db/tenantDbRegistry/tenantDbIdentity/init-control-db/process.env -- este
// modulo nunca decide autorizacion, solo interpreta lo que el request PIDE. La verificacion real
// (empresa existe, activa, membership, tenant identity) es de un slice posterior.
function parseTenantHost(input) {
  if (typeof input !== "string") return { kind: "INVALID", tenantSlug: null };
  if (input.length === 0) return { kind: "INVALID", tenantSlug: null };
  if (/\s/.test(input)) return { kind: "INVALID", tenantSlug: null };
  if (input.includes("://")) return { kind: "INVALID", tenantSlug: null };
  if (input.includes("/")) return { kind: "INVALID", tenantSlug: null };
  if (input.includes("@")) return { kind: "INVALID", tenantSlug: null };
  if (input.includes(",")) return { kind: "INVALID", tenantSlug: null };

  const normalizado = input.toLowerCase();
  const partes = normalizado.split(":");

  let hostPart;
  if (partes.length === 1) {
    hostPart = partes[0];
  } else if (partes.length === 2) {
    const [host, portPart] = partes;
    if (!PORT_PATTERN.test(portPart)) return { kind: "INVALID", tenantSlug: null };
    const puerto = Number(portPart);
    if (puerto < 1 || puerto > 65535) return { kind: "INVALID", tenantSlug: null };
    hostPart = host;
  } else {
    // dos o mas ":" -- IPv6 y variantes quedan fuera de contrato de este slice.
    return { kind: "INVALID", tenantSlug: null };
  }

  if (hostPart === "localhost" || hostPart === "127.0.0.1") {
    return { kind: "LOCAL", tenantSlug: null };
  }

  if (hostPart === "atlasos.com.ar") {
    return { kind: "RESERVED", tenantSlug: null };
  }

  const match = hostPart.match(TENANT_LABEL_PATTERN);
  if (!match) return { kind: "INVALID", tenantSlug: null };

  const label = match[1];
  if (RESERVED_LABELS.has(label)) {
    return { kind: "RESERVED", tenantSlug: null };
  }

  return { kind: "TENANT", tenantSlug: label };
}

module.exports = { parseTenantHost };
