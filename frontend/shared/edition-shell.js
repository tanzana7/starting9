(function startStarting9EditionShell(global) {
  "use strict";

  function elements() {
    return {
      npb: document.getElementById("npbEditionContent"),
      asia: document.getElementById("asiaEditionContent"),
      buttons: Array.from(document.querySelectorAll("[data-edition-select]") || [])
    };
  }

  function sync(edition) {
    const current = global.Starting9Edition.normalizeEdition(edition)
      || global.Starting9Edition.resolveSelectedEdition();
    const nodes = elements();
    nodes.npb?.classList.toggle("hidden", current !== global.Starting9Edition.NPB);
    nodes.asia?.classList.toggle("hidden", current !== global.Starting9Edition.ASIA_CS);
    document.querySelectorAll("[data-npb-only]").forEach((node) => node.classList.toggle("hidden", current === global.Starting9Edition.ASIA_CS));
    nodes.buttons.forEach((button) => {
      const selected = button.dataset.editionSelect === current;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-selected", selected ? "true" : "false");
    });
    document.documentElement.dataset.starting9Edition = current;
    global.Starting9Edition.active = current;
    if (current === global.Starting9Edition.NPB && global.publicAppCoordinator?.start) {
      void global.publicAppCoordinator.start();
    }
    if (current === global.Starting9Edition.ASIA_CS && global.Starting9AsiaCsApp?.load) {
      void global.Starting9AsiaCsApp.load();
    }
  }

  function start() {
    if (!global.Starting9Edition) return;
    document.addEventListener("click", (event) => {
      const button = event.target.closest("[data-edition-select]");
      if (!button) return;
      event.preventDefault();
      const url = new URL(global.location.href);
      url.searchParams.set("edition", button.dataset.editionSelect.toLowerCase());
      global.history.replaceState(null, "", url);
      sync(button.dataset.editionSelect);
    });
    sync(global.Starting9Edition.resolveSelectedEdition());
  }

  global.Starting9EditionShell = Object.freeze({ sync, start });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})(window);
