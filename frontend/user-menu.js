(function () {
  const USER_KEY = "guernicaUser";
  const SESSION_KEY = "guernicaSession";

  function readJson(storage, key) {
    try {
      return JSON.parse(storage.getItem(key) || "null");
    } catch {
      return null;
    }
  }

  function getStoredUser() {
    return readJson(localStorage, USER_KEY) || readJson(sessionStorage, USER_KEY);
  }

  function getStoredSession() {
    return readJson(localStorage, SESSION_KEY) || readJson(sessionStorage, SESSION_KEY);
  }

  function isValidSession(session) {
    return Boolean(session?.token && session?.expires_at && new Date(session.expires_at).getTime() > Date.now());
  }

  function initials(name) {
    const parts = String(name || "Usuario").trim().split(/\s+/).filter(Boolean);
    return parts.slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "U";
  }

  function roleLabel(value) {
    if (!value) return "Administrador";
    return String(value).replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function showToast(text) {
    let toast = document.querySelector(".user-menu-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "user-menu-toast";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      document.body.appendChild(toast);
    }

    toast.textContent = text;
    toast.classList.add("open");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove("open"), 2400);
  }

  function logout() {
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(USER_KEY);
    sessionStorage.removeItem(SESSION_KEY);
    window.location.href = "/login";
  }

  function closeAll(except = null) {
    document.querySelectorAll(".user-menu.open").forEach((menu) => {
      if (menu !== except) {
        menu.classList.remove("open");
        const box = menu.parentElement?.querySelector(".user-box");
        if (box) {
          box.classList.remove("user-menu-open");
          box.setAttribute("aria-expanded", "false");
        }
      }
    });
  }

  function buildMenu(user, currentName, currentRole) {
    const menu = document.createElement("div");
    menu.className = "user-menu";
    menu.setAttribute("role", "menu");
    menu.innerHTML = `
      <div class="user-menu-header">
        <strong>${user?.nombre || currentName || "Juan Perez"}</strong>
        <span>${roleLabel(user?.rol || currentRole || "Administrador")}</span>
        <small>Sucursal Central</small>
      </div>
      <div class="user-menu-section">
        <button class="user-menu-button" type="button" data-user-action="perfil" role="menuitem">Mi perfil</button>
        <button class="user-menu-button" type="button" data-user-action="password" role="menuitem">Cambiar contraseña</button>
        <button class="user-menu-button" type="button" data-user-action="sucursal" role="menuitem">Cambiar sucursal</button>
      </div>
      <div class="user-menu-section">
        <button class="user-menu-button" type="button" data-user-action="cambiar" role="menuitem">Cambiar usuario</button>
        <button class="user-menu-button danger" type="button" data-user-action="salir" role="menuitem">Cerrar sesion</button>
      </div>
    `;
    return menu;
  }

  function enhanceUserBox(box, index) {
    if (box.dataset.userMenuReady === "1") return;

    const user = getStoredUser();
    const nameNode = box.querySelector("strong");
    const roleNode = box.querySelector("small");
    const avatar = box.querySelector(".avatar");
    const currentName = nameNode?.textContent.trim();
    const currentRole = roleNode?.textContent.trim();
    const displayName = user?.nombre || currentName || "Juan Perez";
    const displayRole = roleLabel(user?.rol || currentRole || "Administrador");

    if (nameNode) nameNode.textContent = displayName;
    if (roleNode) roleNode.textContent = displayRole;
    if (avatar) {
      if (user?.foto_url) {
        avatar.textContent = "";
        avatar.style.backgroundImage = `url("${user.foto_url}")`;
        avatar.style.backgroundSize = "cover";
        avatar.style.backgroundPosition = "center";
      } else {
        avatar.textContent = initials(displayName);
      }
    }

    const host = document.createElement("div");
    host.className = "user-menu-host";
    box.parentNode.insertBefore(host, box);
    host.appendChild(box);

    const menu = buildMenu(user, displayName, displayRole);
    const menuId = `userMenu-${index}`;
    menu.id = menuId;
    host.appendChild(menu);

    box.dataset.userMenuReady = "1";
    box.setAttribute("role", "button");
    box.setAttribute("tabindex", "0");
    box.setAttribute("aria-haspopup", "menu");
    box.setAttribute("aria-expanded", "false");
    box.setAttribute("aria-controls", menuId);

    function toggleMenu() {
      const willOpen = !menu.classList.contains("open");
      closeAll(menu);
      menu.classList.toggle("open", willOpen);
      box.classList.toggle("user-menu-open", willOpen);
      box.setAttribute("aria-expanded", String(willOpen));
    }

    box.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleMenu();
    });

    box.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleMenu();
      }
    });

    menu.addEventListener("click", (event) => {
      const action = event.target.closest("[data-user-action]")?.dataset.userAction;
      if (!action) return;
      closeAll();

      if (action === "perfil") {
        window.location.href = "/perfil.html";
      } else if (action === "password") {
        window.location.href = "/perfil.html#password";
      } else if (action === "sucursal") {
        showToast("Sucursal Central seleccionada.");
      } else if (action === "cambiar" || action === "salir") {
        logout();
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    const session = getStoredSession();
    const user = getStoredUser();

    if (!isValidSession(session) && !user) {
      localStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(USER_KEY);
      sessionStorage.removeItem(USER_KEY);
      window.location.href = "/login";
      return;
    }

    document.querySelectorAll(".user-box").forEach(enhanceUserBox);

    document.addEventListener("click", (event) => {
      if (!event.target.closest(".user-menu-host")) closeAll();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeAll();
    });
  });
})();
