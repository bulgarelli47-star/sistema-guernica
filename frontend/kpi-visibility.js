(function () {
  const STYLE_ID = "kpi-visibility-styles";

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
      .kpi-visibility-text {
        line-height: 1;
      }
      .kpi-visibility-button.is-hidden .app-icon {
        opacity: .55;
      }
      .kpi-visibility-button.is-hidden::after {
        content: "";
        position: absolute;
        width: 18px;
        height: 2px;
        border-radius: 999px;
        background: currentColor;
        transform: rotate(-38deg);
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

    let button = document.getElementById(buttonId);
    if (!button) {
      button = document.createElement("button");
      button.id = buttonId;
      button.type = "button";
      bar.replaceChildren(button);
    }
    button.className = "kpi-visibility-button";
    button.innerHTML = '<span class="app-icon icon-view" aria-hidden="true"></span><span class="kpi-visibility-text"></span>';
    return { bar, button };
  }

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
      return /[$€£¥]|(?:^|[\s(])-?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})\b/.test(text);
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
        .filter(isSensitiveNode);
    }

    function setMasked(masked) {
      getSensitiveNodes().forEach((node) => {
        if (!node.dataset.kpiOriginalValue) {
          node.dataset.kpiOriginalValue = node.textContent;
        }
        node.textContent = masked ? "****" : node.dataset.kpiOriginalValue;
        node.classList.toggle("kpi-sensitive-hidden", masked);
      });
    }

    function setVisible(visible, persist = true) {
      targets.forEach((target) => {
        target.style.display = defaultDisplays.get(target) || defaultDisplay;
      });
      setMasked(!visible);
      bar.style.display = enabled ? "flex" : "none";
      button.classList.toggle("is-hidden", !visible);
      button.setAttribute("aria-pressed", visible ? "false" : "true");
      button.setAttribute("aria-label", visible ? "Ocultar montos" : "Mostrar montos");
      button.title = visible ? "Ocultar montos" : "Mostrar montos";
      if (text) text.textContent = visible ? "Visible" : "Invisible";
      if (persist) localStorage.setItem(storageKey, visible ? "1" : "0");
    }

    if (!enabled) {
      bar.style.display = "none";
      return { setVisible };
    }

    const stored = localStorage.getItem(storageKey);
    setVisible(stored === null ? true : stored !== "0", false);
    button.onclick = function () {
      setVisible(button.classList.contains("is-hidden"));
    };

    return { setVisible };
  };
})();
