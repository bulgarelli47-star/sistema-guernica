(function () {
  const BREAKPOINT = 860;
  const OPEN_CLASS = "mobile-nav-open";
  const READY_ATTR = "data-mobile-nav-ready";
  const BACKDROP_ID = "mobileNavBackdrop";

  let lastFocused = null;
  let lockedScrollY = 0;

  function isMobile() {
    return window.matchMedia(`(max-width: ${BREAKPOINT}px)`).matches;
  }

  function getVisibleFocusable(root) {
    return [...root.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((element) => {
        if (element.hidden) return false;
        const style = window.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      });
  }

  function closeUserMenu() {
    document.querySelectorAll(".user-menu.open").forEach((menu) => menu.classList.remove("open"));
    document.querySelectorAll(".user-box.user-menu-open").forEach((box) => {
      box.classList.remove("user-menu-open");
      box.setAttribute("aria-expanded", "false");
    });
  }

  function initMobileNav() {
    const sidebar = document.querySelector(".sidebar");
    const nav = sidebar?.querySelector(".nav");
    const topbarLeft = document.querySelector(".topbar-left");
    if (!sidebar || !nav || !topbarLeft || document.body.hasAttribute(READY_ATTR)) return;

    document.body.setAttribute(READY_ATTR, "1");
    if (!sidebar.id) sidebar.id = "atlas-sidebar";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "mobile-nav-toggle";
    toggle.setAttribute("aria-label", "Abrir navegación");
    toggle.setAttribute("aria-controls", sidebar.id);
    toggle.setAttribute("aria-expanded", "false");
    toggle.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M4.5 7.25h15M4.5 12h15M4.5 16.75h15" />
      </svg>
    `;
    topbarLeft.insertBefore(toggle, topbarLeft.firstChild);

    const drawerHeader = document.createElement("div");
    drawerHeader.className = "mobile-nav-drawer-header";
    drawerHeader.innerHTML = `
      <strong>Navegación</strong>
      <button type="button" class="mobile-nav-close" aria-label="Cerrar navegación">
        <span aria-hidden="true">&times;</span>
      </button>
    `;
    sidebar.insertBefore(drawerHeader, sidebar.firstChild);

    const closeButton = drawerHeader.querySelector(".mobile-nav-close");
    let backdrop = document.getElementById(BACKDROP_ID);
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.id = BACKDROP_ID;
      backdrop.className = "mobile-nav-backdrop";
      backdrop.hidden = true;
      document.body.appendChild(backdrop);
    }

    function lockPageScroll() {
      lockedScrollY = window.scrollY || document.documentElement.scrollTop || 0;
      document.body.style.top = `-${lockedScrollY}px`;
      document.body.classList.add(OPEN_CLASS);
    }

    function unlockPageScroll() {
      document.body.classList.remove(OPEN_CLASS);
      document.body.style.top = "";
      window.scrollTo(0, lockedScrollY);
    }

    function setExpanded(isOpen) {
      toggle.setAttribute("aria-expanded", String(isOpen));
      toggle.setAttribute("aria-label", isOpen ? "Cerrar navegación" : "Abrir navegación");
    }

    function closeDrawer({ restoreFocus = true } = {}) {
      if (!document.body.classList.contains(OPEN_CLASS)) return;
      sidebar.classList.remove(OPEN_CLASS);
      backdrop.classList.remove("mobile-nav-backdrop-open");
      backdrop.hidden = true;
      setExpanded(false);
      unlockPageScroll();
      document.removeEventListener("keydown", handleKeydown);

      if (restoreFocus) {
        const target = lastFocused && document.contains(lastFocused) ? lastFocused : toggle;
        target.focus({ preventScroll: true });
      }
    }

    function openDrawer() {
      if (!isMobile() || document.body.classList.contains(OPEN_CLASS)) return;
      lastFocused = toggle;
      closeUserMenu();
      lockPageScroll();
      sidebar.classList.add(OPEN_CLASS);
      backdrop.hidden = false;
      window.requestAnimationFrame(() => backdrop.classList.add("mobile-nav-backdrop-open"));
      setExpanded(true);
      document.addEventListener("keydown", handleKeydown);

      const focusTarget = closeButton || getVisibleFocusable(sidebar)[0];
      focusTarget?.focus({ preventScroll: true });
    }

    function handleKeydown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDrawer();
        return;
      }

      if (event.key !== "Tab" || !document.body.classList.contains(OPEN_CLASS)) return;

      const focusable = getVisibleFocusable(sidebar);
      if (!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    toggle.addEventListener("click", () => {
      if (document.body.classList.contains(OPEN_CLASS)) {
        closeDrawer();
      } else {
        openDrawer();
      }
    });

    closeButton?.addEventListener("click", () => closeDrawer());
    backdrop.addEventListener("click", () => closeDrawer());

    nav.addEventListener("click", (event) => {
      const link = event.target.closest("a[href]");
      if (link && isMobile()) closeDrawer({ restoreFocus: false });
    });

    window.addEventListener("resize", () => {
      if (!isMobile()) closeDrawer({ restoreFocus: false });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initMobileNav);
  } else {
    initMobileNav();
  }
})();
