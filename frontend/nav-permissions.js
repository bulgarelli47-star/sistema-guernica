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
    "/finanzas.html": "finanzas",
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
    const normalized = String(role || "colaborador").trim().toLowerCase().replace(/\s+/g, "_");
    return { operador: "colaborador", caja: "colaborador", cajero: "colaborador" }[normalized] || normalized;
  }

  function getModuleFromLink(link) {
    const href = link.getAttribute("href") || "";
    const url = href.startsWith("http") ? new URL(href) : new URL(href, window.location.origin);
    return MODULES[url.pathname] || null;
  }

  function isAllowed(config, moduleName, role) {
    if (!moduleName) return true;
    if (moduleName === "finanzas") return role === "admin";
    if (role === "admin" && (moduleName === "usuarios" || moduleName === "configuracion")) return true;
    const key = `modulo_${moduleName}_${role}`;
    return config[key] !== false;
  }

  function asBool(value, fallback = true) {
    if (value === undefined || value === null || value === "") return fallback;
    return value === true || value === "true" || value === 1 || value === "1";
  }

  function getBusinessName(config) {
    return String(config.negocio_nombre_comercial || config.ticket_nombre || "Mi Negocio").trim() || "Mi Negocio";
  }

  function applyBrandTypography() {
    if (document.getElementById("atlas-brand-typography")) return;
    // Fuente Space Grotesk solo para el nombre del sistema ATLAS OS
    const style = document.createElement("style");
    style.id = "atlas-brand-typography";
    style.textContent = `
      @font-face {
        font-family: "Brimstone";
        src: url("/fonts/BRIMRG__.TTF") format("truetype");
        font-weight: normal;
        font-style: normal;
        font-display: swap;
      }
      .logo-text strong {
        font-family: "Brimstone", "Space Grotesk", "Inter", sans-serif;
        font-size: 17px;
        font-weight: 800;
        letter-spacing: .06em;
        text-transform: uppercase;
        line-height: 1.05;
      }
      .logo-text small {
        font-family: "Segoe UI", Arial, sans-serif;
        font-size: 10px;
        font-weight: 500;
        letter-spacing: .01em;
        text-transform: none;
        opacity: .78;
      }
      .branch-label {
        display: block;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: .07em;
        opacity: .55;
        margin-bottom: 2px;
      }
    `;
    document.head.appendChild(style);
  }

  function applyBusinessBranding(config) {
    applyBrandTypography();
    const businessName = getBusinessName(config);

    // Solo actualiza la tarjeta del comercio en el sidebar — no toca el logo Atlas OS
    document.querySelectorAll(".branch-card strong").forEach((node) => {
      node.textContent = businessName;
    });

    // El logo del comercio (negocio_logo_url) se reserva para tickets/comprobantes.
    // El logo-mark del header siempre muestra el isotipo Atlas OS.
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
          const adminOnly = link.dataset.adminOnly === "true";
          link.hidden = adminOnly && role !== "admin" ? true : !isAllowed(config, moduleName, role);
        });
      }

      applyConfigToPage(config);
    } catch (error) {
      console.error("Error aplicando configuracion global:", error);
    }
  }

  // ── Sidebar minimizable ────────────────────────────────────────────────────
  function initSidebarToggle() {
    if (document.getElementById("atlas-sidebar-toggle")) return;
    const sidebar = document.querySelector(".sidebar");
    if (!sidebar) return;

    // Inject CSS (once per page)
    if (!document.getElementById("atlas-sidebar-collapse-css")) {
      const s = document.createElement("style");
      s.id = "atlas-sidebar-collapse-css";
      s.textContent = `
        /* Tab button: solapa pegada al borde derecho del sidebar */
        #atlas-sidebar-toggle {
          position: absolute;
          right: -25px;
          top: 72px;
          width: 25px;
          height: 52px;
          border: 1px solid var(--border, #e5e7eb);
          border-left: 0;
          border-radius: 0 8px 8px 0;
          background: var(--sidebar, #ffffff);
          color: var(--muted, #6b7280);
          cursor: pointer;
          font-size: 15px;
          font-weight: 900;
          z-index: 40;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 3px 0 8px rgba(0,0,0,.07);
          transition: background .15s, color .15s;
          line-height: 1;
          padding: 0;
        }
        #atlas-sidebar-toggle:hover {
          background: var(--primary-soft, #f0e5ff);
          color: var(--primary, #6d28d9);
        }

        /* Collapsed: grid column override */
        body.sidebar-collapsed .app-shell {
          grid-template-columns: 72px minmax(0, 1fr);
        }
        body.sidebar-collapsed .sidebar {
          padding: 12px 4px;
        }
        body.sidebar-collapsed .nav-title {
          display: none;
        }
        body.sidebar-collapsed .nav a {
          justify-content: center;
          padding: 12px 0;
          gap: 0;
        }
        body.sidebar-collapsed .nav a span:not([class*="nav-icon"]):not([class*="app-icon"]) {
          display: none;
        }
        body.sidebar-collapsed .branch-card {
          display: none;
        }

        /* Mobile: revert completely */
        @media (max-width: 860px) {
          body.sidebar-collapsed .app-shell {
            grid-template-columns: 1fr;
          }
          body.sidebar-collapsed .sidebar {
            padding: 20px 18px 24px;
          }
          body.sidebar-collapsed .nav-title { display: block; }
          body.sidebar-collapsed .nav a {
            justify-content: flex-start;
            padding: 12px 14px;
            gap: 12px;
          }
          body.sidebar-collapsed .nav a span:not([class*="nav-icon"]):not([class*="app-icon"]) {
            display: inline;
          }
          body.sidebar-collapsed .branch-card { display: block; }
          #atlas-sidebar-toggle { display: none; }
        }
      `;
      document.head.appendChild(s);
    }

    // Add title attributes to nav links for tooltip when collapsed
    sidebar.querySelectorAll(".nav a").forEach((a) => {
      const textSpan = [...a.querySelectorAll("span")].find(
        (s) => !s.className.includes("nav-icon") && !s.className.includes("app-icon")
      );
      if (textSpan && !a.title) a.title = textSpan.textContent.trim();
    });

    // Create tab toggle button
    const btn = document.createElement("button");
    btn.id = "atlas-sidebar-toggle";
    btn.type = "button";

    const collapsed = localStorage.getItem("atlasSidebarCollapsed") === "true";
    if (collapsed) document.body.classList.add("sidebar-collapsed");
    // ‹ = collapse direction  ›  = expand direction
    btn.textContent = collapsed ? "›" : "‹";
    btn.title = collapsed ? "Expandir sidebar" : "Colapsar sidebar";

    btn.addEventListener("click", () => {
      if (window.innerWidth <= 860) return;
      const isNowCollapsed = document.body.classList.toggle("sidebar-collapsed");
      localStorage.setItem("atlasSidebarCollapsed", String(isNowCollapsed));
      btn.textContent = isNowCollapsed ? "›" : "‹";
      btn.title = isNowCollapsed ? "Expandir sidebar" : "Colapsar sidebar";
    });

    // Ensure sidebar is a positioned context (for absolute button).
    // If already sticky/absolute/fixed, those already act as positioning context — don't override.
    const sidebarPos = window.getComputedStyle(sidebar).position;
    if (sidebarPos === "static") sidebar.style.position = "relative";
    sidebar.style.zIndex = "10";

    // Append to sidebar (absolutely positioned, no flow impact)
    sidebar.appendChild(btn);
  }

  document.addEventListener("DOMContentLoaded", initSidebarToggle);
  document.addEventListener("DOMContentLoaded", applySidebarPermissions);
})();
