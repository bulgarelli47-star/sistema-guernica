(function () {
  const STYLE_ID = "kpi-visibility-styles";

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .kpi-visibility-bar {
        display: flex;
        justify-content: flex-end;
        align-items: center;
        margin: 0;
        width: 100%;
        pointer-events: none;
        align-self: start;
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
        background: rgba(255, 255, 255, .92);
        border-radius: 999px;
        padding: 0 11px;
        font-size: 12px;
        font-weight: 800;
        color: var(--muted, #64748b);
        cursor: pointer;
        box-shadow: 0 8px 18px rgba(17, 24, 39, .06);
        pointer-events: auto;
        position: relative;
      }
      .kpi-visibility-button:hover {
        color: var(--text, #0f172a);
        border-color: #cbd5e1;
        background: #fff;
      }
      .kpi-visibility-button .app-icon {
        width: 16px;
        height: 16px;
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

    function setVisible(visible, persist = true) {
      targets.forEach((target) => {
        target.style.display = visible ? defaultDisplays.get(target) || defaultDisplay : "none";
      });
      bar.style.display = enabled ? "flex" : "none";
      button.classList.toggle("is-hidden", !visible);
      button.setAttribute("aria-pressed", visible ? "false" : "true");
      button.setAttribute("aria-label", visible ? "Ocultar KPIs" : "Mostrar KPIs");
      button.title = visible ? "Ocultar KPIs" : "Mostrar KPIs";
      if (text) text.textContent = visible ? "Ocultar KPIs" : "Mostrar KPIs";
      if (persist) localStorage.setItem(storageKey, visible ? "1" : "0");
    }

    if (!enabled) {
      targets.forEach((target) => { target.style.display = "none"; });
      bar.style.display = "none";
      return { setVisible };
    }

    const stored = localStorage.getItem(storageKey);
    setVisible(stored === null ? true : stored !== "0", false);
    button.onclick = function () {
      setVisible(targets.some((target) => target.style.display === "none"));
    };

    return { setVisible };
  };
})();
