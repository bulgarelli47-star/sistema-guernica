(function () {
  const STYLE_ID = "kpi-visibility-styles";
  const VISIBLE_VALUE = "visible";
  const HIDDEN_VALUE = "hidden";

  function parseStoredVisibility(value) {
    if (value === HIDDEN_VALUE || value === "0") return false;
    return true;
  }

  function formatStoredVisibility(visible) {
    return visible ? VISIBLE_VALUE : HIDDEN_VALUE;
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .kpi-visibility-bar {
        grid-column: 1 / -1;
        display: flex;
        justify-content: flex-end;
        align-items: center;
        width: 100%;
        min-height: 34px;
        margin: 0 0 10px;
        padding: 0 2px;
        pointer-events: none;
        align-self: start;
        position: relative;
        z-index: 4;
      }
      .top-actions .kpi-visibility-bar {
        grid-column: auto;
        width: auto;
        min-height: 42px;
        margin: 0;
        padding: 0;
        pointer-events: auto;
        align-self: center;
      }
      .top-actions .kpi-visibility-button {
        width: 42px;
        height: 42px;
        min-width: 42px;
        min-height: 42px;
        padding: 0;
        gap: 0;
        border-color: rgba(255, 255, 255, .18);
        background: rgba(255, 255, 255, .08);
        color: #fff;
        border-radius: 999px;
        box-shadow: none;
      }
      .top-actions .kpi-visibility-button:hover {
        color: #fff;
        border-color: rgba(255, 255, 255, .34);
        background: rgba(255, 255, 255, .16);
        box-shadow: none;
      }
      .top-actions .kpi-visibility-button .app-icon {
        width: 18px;
        height: 18px;
        opacity: .94;
      }
      .top-actions .kpi-visibility-text {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
      }
      .kpi-visibility-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        width: auto;
        height: 34px;
        min-width: 34px;
        min-height: 34px;
        border: 1px solid var(--border, #e2e8f0);
        background: rgba(255, 255, 255, .94);
        border-radius: 999px;
        padding: 0 12px;
        font-size: 12px;
        font-weight: 800;
        color: var(--muted, #64748b);
        cursor: pointer;
        box-shadow: 0 8px 18px rgba(17, 24, 39, .06);
        pointer-events: auto;
        position: relative;
        white-space: nowrap;
        transition: border-color .18s ease, background .18s ease, color .18s ease, box-shadow .18s ease;
      }
      .kpi-visibility-button:hover {
        color: var(--text, #0f172a);
        border-color: #cbd5e1;
        background: #fff;
        box-shadow: 0 10px 24px rgba(17, 24, 39, .1);
      }
      .kpi-visibility-button:focus-visible {
        outline: 3px solid rgba(79, 70, 229, .22);
        outline-offset: 2px;
      }
      .kpi-visibility-button .app-icon {
        width: 16px;
        height: 16px;
        flex: 0 0 auto;
        opacity: .8;
      }
      .kpi-visibility-button .icon-hide {
        --icon: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='black' d='m3.3 2 18.7 18.7-1.3 1.3-3.1-3.1A10.6 10.6 0 0 1 12 20C7 20 3.5 15.8 2 13c.8-1.5 2.1-3.1 3.7-4.4L2 4.3 3.3 2Zm4 8.2A12.8 12.8 0 0 0 4.4 13C6 15.6 8.7 18 12 18c1.5 0 2.8-.5 4-1.2l-2-2a3.5 3.5 0 0 1-4.7-4.7l-2-1.9ZM12 6c5 0 8.5 4.2 10 7a13.7 13.7 0 0 1-2.7 3.5l-1.4-1.4A12.2 12.2 0 0 0 19.6 13C18 10.4 15.3 8 12 8c-.8 0-1.6.1-2.3.4L8.1 6.8A10.5 10.5 0 0 1 12 6Zm-.4 4.1 4.3 4.3c.1-.4.1-.8.1-1.2A4 4 0 0 0 12 9c-.4 0-.8 0-1.2.1l.8 1Z'/%3E%3C/svg%3E");
      }
      .kpi-visibility-text {
        line-height: 1;
      }
      .kpi-visibility-button.is-hidden .app-icon {
        opacity: .55;
      }
      .kpi-sensitive-hidden {
        letter-spacing: .08em;
      }
      @media (max-width: 720px) {
        .kpi-visibility-bar {
          min-height: 32px;
          margin: -2px 0 8px;
        }
        .kpi-visibility-button {
          height: 32px;
          min-height: 32px;
          padding: 0 10px;
          font-size: 11px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function createToggle(grid, barId, buttonId) {
    let bar = document.getElementById(barId);
    if (!bar) {
      bar = document.createElement("div");
      bar.id = barId;
      grid.parentNode.insertBefore(bar, grid);
    }
    bar.className = "kpi-visibility-bar";
    bar.removeAttribute("style");

    let button = document.getElementById(buttonId) || document.querySelector(".kpi-visibility-toggle");
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
    }
    button.id = buttonId;
    button.type = "button";
    button.className = "kpi-visibility-button kpi-visibility-toggle";
    button.innerHTML = '<span class="app-icon icon-view" aria-hidden="true"></span><span class="kpi-visibility-text"></span>';
    bar.replaceChildren(button);
    return { bar, button };
  }

  function findHeaderMount() {
    const explicit = document.getElementById("dashboardVisibilityMount")
      || document.getElementById("kpiVisibilityMount");
    if (explicit) return explicit;

    const actions = document.querySelector(".top-actions");
    if (!actions) return null;

    const mount = document.createElement("div");
    mount.id = "kpiVisibilityMount";
    mount.className = "kpi-visibility-mount";
    const notifications = actions.querySelector(".top-actions-menu");
    if (notifications?.nextSibling) {
      actions.insertBefore(mount, notifications.nextSibling);
    } else {
      actions.prepend(mount);
    }
    return mount;
  }

  function mountKpiVisibility(bar) {
    if (!bar) return false;
    const mount = findHeaderMount();
    if (!mount) return false;
    if (bar.parentElement !== mount) {
      mount.replaceChildren(bar);
    }
    bar.classList.add("kpi-visibility-header");
    return true;
  }

  window.mountKpiVisibility = mountKpiVisibility;

  window.initKpiVisibility = function initKpiVisibility(options = {}) {
    const grid = document.querySelector(options.gridSelector || ".kpi-grid");
    if (!grid) return null;
    const targets = Array.isArray(options.targetSelectors) && options.targetSelectors.length
      ? options.targetSelectors.flatMap((selector) => [...document.querySelectorAll(selector)])
      : [grid];

    ensureStyles();

    const storageKey = options.storageKey || `guernica_kpis_${location.pathname.replace(/[^a-z0-9]+/gi, "_")}`;
    const defaultDisplay = options.defaultDisplay || "grid";
    const enabled = options.enabled !== false;
    const barId = options.barId || "kpiToggleBar";
    const buttonId = options.buttonId || "toggleKpisBtn";
    const { bar, button } = createToggle(grid, barId, buttonId);
    if (options.mountInHeader !== false) mountKpiVisibility(bar);
    const text = button.querySelector(".kpi-visibility-text");
    const defaultDisplays = new Map(targets.map((target) => {
      const computed = getComputedStyle(target).display;
      return [target, options.defaultDisplay || target.dataset.kpiDefaultDisplay || (computed && computed !== "none" ? computed : "grid")];
    }));

    function isSensitiveNode(node) {
      if (!node) return false;
      if (node.dataset.kpiSensitive === "false") return false;
      if (node.dataset.kpiSensitive === "true" || node.dataset.sensitive === "money") return true;
      if (node.classList.contains("amount-number") || node.classList.contains("amount-value")) return true;
      if (node.classList.contains("money-value") || node.classList.contains("currency-value")) return true;
      const text = String(node.textContent || "").trim();
      return /[$€£¥]|(?:^|[\s(])-?\d{1,3}(?:[.,]\d{3})*[.,]\d{2}\b/.test(text);
    }

    function getSensitiveNodes() {
      const selectors = options.sensitiveSelectors || [
        "[data-kpi-sensitive='true']",
        "[data-sensitive='money']",
        ".metric-value",
        ".amount-value",
        ".amount-number",
        ".kpi-chart-value",
        ".money-value",
        ".currency-value"
      ];
      return [...new Set(targets.flatMap((target) => selectors.flatMap((selector) => [...target.querySelectorAll(selector)])))]
        .filter((node) => node?.dataset?.kpiSensitive !== "false")
        .filter((node) => node.dataset.kpiMasked === "1" || isSensitiveNode(node));
    }

    function setMasked(masked) {
      getSensitiveNodes().forEach((node) => {
        if (masked && node.dataset.kpiMasked !== "1") {
          node.dataset.kpiOriginalValue = node.textContent;
        }
        if (!masked && node.dataset.kpiOriginalValue !== undefined) {
          node.textContent = node.dataset.kpiOriginalValue;
        } else if (masked) {
          node.textContent = "****";
        }
        node.dataset.kpiMasked = masked ? "1" : "0";
        node.classList.toggle("kpi-sensitive-hidden", masked);
      });
    }

    function applyButtonState(visible) {
      const icon = button.querySelector(".app-icon");
      if (icon) {
        icon.classList.toggle("icon-view", visible);
        icon.classList.toggle("icon-hide", !visible);
      }
      button.classList.toggle("is-hidden", !visible);
      button.dataset.visible = visible ? VISIBLE_VALUE : HIDDEN_VALUE;
      button.setAttribute("aria-pressed", visible ? "false" : "true");
      button.setAttribute("aria-label", visible ? "Ocultar montos" : "Mostrar montos");
      button.title = visible ? "Ocultar montos" : "Mostrar montos";
      if (text) text.textContent = visible ? "Visible" : "Invisible";
    }

    function setVisible(visible, persist = true, notify = true) {
      targets.forEach((target) => {
        target.style.display = defaultDisplays.get(target) || defaultDisplay;
      });
      setMasked(!visible);
      bar.style.display = enabled ? "flex" : "none";
      applyButtonState(visible);
      if (persist) localStorage.setItem(storageKey, formatStoredVisibility(visible));
      if (notify) {
        window.dispatchEvent(new CustomEvent("guernica:kpi-visibility-change", {
          detail: { storageKey, visible, buttonId, barId }
        }));
      }
    }

    if (!enabled) {
      bar.style.display = "none";
      return { setVisible };
    }

    const stored = localStorage.getItem(storageKey);
    setVisible(stored === null ? true : parseStoredVisibility(stored), stored === null || stored === "1" || stored === "0", false);
    button.onclick = function () {
      setVisible(button.classList.contains("is-hidden"));
    };

    window.addEventListener("storage", (event) => {
      if (event.key !== storageKey) return;
      setVisible(event.newValue === null ? true : parseStoredVisibility(event.newValue), event.newValue === null, false);
    });

    window.addEventListener("guernica:kpi-visibility-sync", (event) => {
      if (event.detail?.storageKey && event.detail.storageKey !== storageKey) return;
      const current = localStorage.getItem(storageKey);
      setVisible(current === null ? true : parseStoredVisibility(current), current === null, false);
    });

    return { setVisible };
  };
})();
