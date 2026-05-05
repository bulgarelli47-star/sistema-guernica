(function () {
  const SESSION_KEY = "guernicaSession";
  const USER_KEY = "guernicaUser";

  function getToken() {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY) || "null");
      return s?.token && s?.expires_at && new Date(s.expires_at).getTime() > Date.now() ? s.token : null;
    } catch { return null; }
  }

  function getUser() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || sessionStorage.getItem(USER_KEY) || "null") || {};
    } catch { return {}; }
  }

  function clearSession() {
    [localStorage, sessionStorage].forEach((st) => {
      st.removeItem(SESSION_KEY);
      st.removeItem(USER_KEY);
    });
  }

  async function logout() {
    try {
      await window._fetchOriginal("/logout", { method: "POST" });
    } catch {}
    clearSession();
    window.location.href = "/";
  }

  // Redirigir a login si no hay sesión válida
  const enLogin = window.location.pathname === "/" || window.location.pathname.endsWith("login.html");
  if (!enLogin && !getToken()) {
    window.location.href = "/";
    return;
  }

  // Guardar fetch original antes de interceptar
  window._fetchOriginal = window.fetch.bind(window);

  // Interceptar fetch para agregar Authorization en todas las llamadas al mismo origen
  window.fetch = async function (url, options) {
    options = options || {};
    const token = getToken();
    const urlStr = String(url);
    const esMismoOrigen = !urlStr.startsWith("http") || urlStr.startsWith(window.location.origin);
    if (token && esMismoOrigen && !urlStr.startsWith("data:")) {
      options = {
        ...options,
        headers: Object.assign({}, options.headers || {}, { Authorization: "Bearer " + token })
      };
    }
    const response = await window._fetchOriginal(url, options);
    if (response.status === 401 && !urlStr.includes("/login")) {
      clearSession();
      window.location.href = "/";
    }
    return response;
  };

  // Enfocar primer campo cuando se abre un modal
  document.addEventListener("DOMContentLoaded", function () {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type !== "attributes" || m.attributeName !== "class") continue;
        const el = m.target;
        if (!el.classList.contains("modal") && !el.classList.contains("modal-card")) continue;
        const abierto = el.classList.contains("open") || el.getAttribute("aria-hidden") === "false";
        if (!abierto) continue;
        const focusable = el.querySelector("input:not([type=hidden]):not([readonly]), select, textarea");
        if (focusable) setTimeout(() => focusable.focus(), 80);
      }
    });
    document.querySelectorAll(".modal, [aria-hidden]").forEach((m) =>
      observer.observe(m, { attributes: true })
    );
  });

  // Actualizar header con datos reales del usuario + botón logout
  document.addEventListener("DOMContentLoaded", function () {
    const userBox = document.querySelector(".user-box");
    if (!userBox) return;

    const user = getUser();
    const nombre = user.nombre || user.usuario || "Usuario";
    const rol = String(user.rol || "").toLowerCase();
    const rolLabel = { admin: "Dueño", encargado: "Encargado", operador: "Colaborador", caja: "Caja" }[rol] || rol;
    const inicial = nombre.charAt(0).toUpperCase();

    const avatar = userBox.querySelector(".avatar");
    if (avatar) avatar.textContent = inicial;

    const strong = userBox.querySelector("strong");
    if (strong) strong.textContent = nombre;

    const small = userBox.querySelector("small");
    if (small) small.textContent = rolLabel;

    // Agregar botón logout si no existe
    if (!userBox.querySelector(".logout-btn")) {
      const btn = document.createElement("button");
      btn.className = "logout-btn";
      btn.title = "Cerrar sesión";
      btn.setAttribute("aria-label", "Cerrar sesión");
      btn.style.cssText = "background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.22);color:#fff;border-radius:8px;padding:5px 9px;cursor:pointer;font-size:12px;font-weight:700;margin-left:6px;white-space:nowrap;";
      btn.textContent = "Salir";
      btn.onclick = logout;
      userBox.appendChild(btn);
    }
  });
})();
