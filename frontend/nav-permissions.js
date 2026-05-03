(function () {
  const USER_KEY = "guernicaUser";
  const MODULES = {
    "/dashboard.html": "inicio",
    "/ventas.html": "ventas",
    "/caja.html": "caja",
    "/pagos.html": "pagos",
    "/productos.html": "stock",
    "/clientes.html": "clientes",
    "/proveedores.html": "proveedores",
    "/reportes.html": "reportes",
    "/usuarios.html": "usuarios",
    "/configuracion.html": "configuracion"
  };

  function readJson(storage, key) {
    try {
      return JSON.parse(storage.getItem(key) || "null");
    } catch {
      return null;
    }
  }

  function getUser() {
    return readJson(localStorage, USER_KEY) || readJson(sessionStorage, USER_KEY) || {};
  }

  function normalizeRole(role) {
    return String(role || "operador").trim().toLowerCase().replace(/\s+/g, "_");
  }

  function getModuleFromLink(link) {
    const href = link.getAttribute("href") || "";
    const url = href.startsWith("http") ? new URL(href) : new URL(href, window.location.origin);
    return MODULES[url.pathname] || null;
  }

  function isAllowed(config, moduleName, role) {
    if (!moduleName) return true;
    if (role === "admin" && (moduleName === "usuarios" || moduleName === "configuracion")) return true;
    const key = `modulo_${moduleName}_${role}`;
    return config[key] !== false;
  }

  function asBool(value, fallback = true) {
    if (value === undefined || value === null || value === "") return fallback;
    return value === true || value === "true" || value === 1 || value === "1";
  }

  function getBusinessName(config) {
    return String(config.negocio_nombre_comercial || config.ticket_nombre || "Guernica Bar").trim() || "Guernica Bar";
  }

  function applyBrandTypography() {
    if (document.getElementById("guernica-brand-typography")) return;
    const style = document.createElement("style");
    style.id = "guernica-brand-typography";
    style.textContent = `
      .logo-text strong {
        font-family: "Inter", "Segoe UI", Arial, sans-serif;
        font-size: 18px;
        font-weight: 800;
        letter-spacing: 0;
        text-transform: none;
        line-height: 1.05;
      }
      .logo-text small {
        font-family: "Inter", "Segoe UI", Arial, sans-serif;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: .03em;
        text-transform: lowercase;
      }
    `;
    document.head.appendChild(style);
  }

  function applyBusinessBranding(config) {
    applyBrandTypography();
    const businessName = getBusinessName(config);
    const logoUrl = String(config.negocio_logo_url || "").trim();
    const initial = businessName.charAt(0).toUpperCase() || "G";

    document.querySelectorAll(".logo-text strong").forEach((node) => {
      node.textContent = businessName;
    });

    document.querySelectorAll(".logo-text small").forEach((node) => {
      node.textContent = "gestión";
    });

    document.querySelectorAll(".branch-card strong").forEach((node) => {
      node.textContent = businessName;
    });

    document.querySelectorAll(".logo-mark").forEach((node) => {
      if (logoUrl) {
        node.textContent = "";
        node.style.backgroundImage = `url("${logoUrl}")`;
        node.style.backgroundSize = "contain";
        node.style.backgroundPosition = "center";
        node.style.backgroundRepeat = "no-repeat";
        node.style.backgroundColor = "#ffffff";
      } else {
        node.style.backgroundImage = "";
        node.style.backgroundRepeat = "";
        node.textContent = initial;
      }
    });
  }

  function paymentConfigKey(payment) {
    return {
      efectivo: "pago_efectivo_activo",
      debito: "pago_debito_activo",
      credito: "pago_credito_activo",
      transferencia: "pago_transferencia_activo",
      billetera: "pago_billetera_activo",
      cuenta_corriente: "pago_cuenta_corriente_activo"
    }[payment] || null;
  }

  function applyPaymentMethods(config) {
    const buttons = [...document.querySelectorAll("[data-payment]")];
    if (!buttons.length) return;

    buttons.forEach((button) => {
      const key = paymentConfigKey(button.dataset.payment);
      button.hidden = key ? !asBool(config[key], true) : false;
    });

    const active = buttons.find((button) => button.classList.contains("active"));
    if (active && active.hidden) {
      const next = buttons.find((button) => !button.hidden);
      if (next) next.click();
    }
  }

  function applyTicketConfig(config) {
    const title = document.getElementById("ticketTitle");
    if (title && (!title.dataset.customerName || title.textContent.trim() === "Consumidor Final")) {
      title.textContent = String(config.ticket_nombre || "Consumidor Final").trim() || "Consumidor Final";
    }
  }

  function applyReportConfig(config) {
    const exportFormato = document.getElementById("exportFormato");
    if (exportFormato && !exportFormato.value) {
      exportFormato.value = config.reporte_formato_default || "excel";
    }
  }

  function applyConfigToPage(config) {
    window.guernicaConfig = config;
    applyBusinessBranding(config);
    applyPaymentMethods(config);
    applyTicketConfig(config);
    applyReportConfig(config);
    window.dispatchEvent(new CustomEvent("guernica:config-loaded", { detail: { config } }));
  }

  window.applyGuernicaConfig = applyConfigToPage;

  async function applySidebarPermissions() {
    const nav = document.querySelector(".nav");

    try {
      const role = normalizeRole(getUser().rol);
      const response = await fetch("/configuracion");
      const data = response.ok ? await response.json() : { config: {} };
      const config = data.config || {};

      if (nav) {
        nav.querySelectorAll("a[href]").forEach((link) => {
          const moduleName = getModuleFromLink(link);
          link.hidden = !isAllowed(config, moduleName, role);
        });
      }

      applyConfigToPage(config);
    } catch (error) {
      console.error("Error aplicando configuracion global:", error);
    }
  }

  document.addEventListener("DOMContentLoaded", applySidebarPermissions);
})();
