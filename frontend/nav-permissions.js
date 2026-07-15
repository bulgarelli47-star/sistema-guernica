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
    if (!sidebar.id) sidebar.id = "atlas-sidebar";

    // Inject CSS (once per page)
    if (!document.getElementById("atlas-sidebar-collapse-css")) {
      const s = document.createElement("style");
      s.id = "atlas-sidebar-collapse-css";
      s.textContent = `
        /* Button: solapa pegada al borde derecho del sidebar */
        #atlas-sidebar-toggle {
          position: absolute;
          right: -28px;
          top: 72px;
          width: 28px;
          height: 44px;
          border: 1px solid var(--border, #d9e1ec);
          border-left: 0;
          border-radius: 0 10px 10px 0;
          background: var(--surface, #fcfcfd);
          color: var(--muted, #64748b);
          cursor: pointer;
          font-size: 14px;
          font-weight: 900;
          z-index: 40;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 3px 0 10px rgba(15,23,42,.08);
          transition: background 150ms ease, color 150ms ease, border-color 150ms ease, box-shadow 150ms ease;
          line-height: 1;
          padding: 0;
          overflow: visible;
        }
        #atlas-sidebar-toggle:hover {
          background: var(--primary-soft, #f0e5ff);
          color: var(--primary, #7c3aed);
          border-color: rgba(124,58,237,.22);
          box-shadow: 3px 0 12px rgba(124,58,237,.14);
        }
        #atlas-sidebar-toggle:focus-visible {
          outline: none;
          box-shadow: 0 0 0 3px rgba(124,58,237,.14), 3px 0 10px rgba(15,23,42,.08);
        }

        /* Button tooltip (Atlas V1) */
        #atlas-sidebar-toggle[data-tooltip]::before {
          content: attr(data-tooltip);
          position: absolute;
          top: calc(100% + 8px);
          left: 50%;
          transform: translateX(-50%) translateY(-4px);
          background: #111827;
          color: #fff;
          font-family: "Inter", "Segoe UI", sans-serif;
          font-size: 12px;
          font-weight: 500;
          line-height: 1;
          padding: 7px 10px;
          border-radius: 8px;
          white-space: nowrap;
          pointer-events: none;
          z-index: 200;
          box-shadow: 0 6px 18px rgba(15,23,42,.18);
          opacity: 0;
          visibility: hidden;
          transition: opacity 150ms ease, transform 150ms ease, visibility 150ms ease;
        }
        #atlas-sidebar-toggle[data-tooltip]::after {
          content: '';
          position: absolute;
          top: calc(100% + 2px);
          left: 50%;
          transform: translateX(-50%) translateY(-4px);
          width: 0;
          height: 0;
          border-left: 5px solid transparent;
          border-right: 5px solid transparent;
          border-bottom: 6px solid #111827;
          pointer-events: none;
          z-index: 200;
          opacity: 0;
          visibility: hidden;
          transition: opacity 150ms ease, transform 150ms ease, visibility 150ms ease;
        }
        #atlas-sidebar-toggle:hover[data-tooltip]::before,
        #atlas-sidebar-toggle:focus-visible[data-tooltip]::before {
          opacity: 1;
          visibility: visible;
          transform: translateX(-50%) translateY(0);
        }
        #atlas-sidebar-toggle:hover[data-tooltip]::after,
        #atlas-sidebar-toggle:focus-visible[data-tooltip]::after {
          opacity: 1;
          visibility: visible;
          transform: translateX(-50%) translateY(0);
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

    // Add data-tooltip + aria-label to nav links (Atlas Tooltip V1, no native title)
    sidebar.querySelectorAll(".nav a").forEach((a) => {
      const textSpan = [...a.querySelectorAll("span")].find(
        (s) => !s.className.includes("nav-icon") && !s.className.includes("app-icon")
      );
      if (textSpan) {
        const label = textSpan.textContent.trim();
        if (label) {
          a.setAttribute("data-tooltip", label);
          if (!a.getAttribute("aria-label")) a.setAttribute("aria-label", label);
        }
      }
    });

    // Create tab toggle button
    const btn = document.createElement("button");
    btn.id = "atlas-sidebar-toggle";
    btn.type = "button";

    const collapsed = localStorage.getItem("atlasSidebarCollapsed") === "true";
    if (collapsed) document.body.classList.add("sidebar-collapsed");
    // ‹ = collapse direction  ›  = expand direction
    btn.textContent = collapsed ? "›" : "‹";

    const LABEL_EXPAND = "Expandir navegación";
    const LABEL_COLLAPSE = "Colapsar navegación";
    btn.setAttribute("aria-label", collapsed ? LABEL_EXPAND : LABEL_COLLAPSE);
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    btn.setAttribute("aria-controls", "atlas-sidebar");
    btn.setAttribute("data-tooltip", collapsed ? LABEL_EXPAND : LABEL_COLLAPSE);

    btn.addEventListener("click", () => {
      if (window.innerWidth <= 860) return;
      const isNowCollapsed = document.body.classList.toggle("sidebar-collapsed");
      localStorage.setItem("atlasSidebarCollapsed", String(isNowCollapsed));
      btn.textContent = isNowCollapsed ? "›" : "‹";
      btn.setAttribute("aria-label", isNowCollapsed ? LABEL_EXPAND : LABEL_COLLAPSE);
      btn.setAttribute("aria-expanded", isNowCollapsed ? "false" : "true");
      btn.setAttribute("data-tooltip", isNowCollapsed ? LABEL_EXPAND : LABEL_COLLAPSE);
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
