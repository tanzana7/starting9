(function startStarting9AdminEditionShell(global) {
  "use strict";

  function sync(edition) {
    const current = global.Starting9Edition.normalizeEdition(edition)
      || global.Starting9Edition.resolveSelectedEdition();
    document.getElementById("npbAdminEditionContent")?.classList.toggle("hidden", current !== global.Starting9Edition.NPB);
    document.getElementById("asiaAdminEditionContent")?.classList.toggle("hidden", current !== global.Starting9Edition.ASIA_CS);
    document.querySelectorAll("[data-admin-edition-select]").forEach((button) => {
      const selected = button.dataset.adminEditionSelect === current;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-selected", selected ? "true" : "false");
    });
    document.documentElement.dataset.starting9AdminEdition = current;
    if (current === global.Starting9Edition.ASIA_CS && global.Starting9AsiaCsAdmin?.refreshSession) {
      void global.Starting9AsiaCsAdmin.refreshSession();
    }
  }

  function start() {
    if (!global.Starting9Edition) return;
    document.addEventListener("click", (event) => {
      const button = event.target.closest("[data-admin-edition-select]");
      if (!button) return;
      event.preventDefault();
      const url = new URL(global.location.href);
      url.searchParams.set("edition", button.dataset.adminEditionSelect.toLowerCase());
      global.history.replaceState(null, "", url);
      sync(button.dataset.adminEditionSelect);
    });
    sync(global.Starting9Edition.resolveSelectedEdition());
  }

  global.Starting9AdminEditionShell = Object.freeze({ sync, start });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})(window);
