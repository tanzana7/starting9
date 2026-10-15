const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadPublicFrontendModules } = require("./load-public-frontend-modules.cjs");

// Load the shipped scripts intact. Exercise the coordinator's real operations,
// not copied function bodies, so private helper names are free to change.
function createPublicRuntime({ fetchImpl, user = { id: "user-1" }, candidateNames = [] } = {}) {
  const root = path.join(__dirname, "..", "..");
  const stored = new Map();
  const chips = candidateNames.map((player) => {
    const classes = new Set();
    return {
      dataset: { player, picker: "prediction" },
      classList: {
        toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
        contains: (name) => classes.has(name)
      }
    };
  });
  const elements = new Map(["savedPrediction", "sharePredictionButton"].map((id) => [id, {
    setAttribute() {}, classList: { add() {}, remove() {}, toggle() {} }
  }]));
  const window = {
    location: { href: "https://starting9.test/", search: "", hostname: "starting9.test" },
    localStorage: {
      getItem: (key) => stored.get(key) || null,
      setItem: (key, value) => stored.set(key, value),
      removeItem: (key) => stored.delete(key)
    },
    starting9Auth: { getUser: () => user, getApiBaseUrl: () => "https://starting9.test" }
  };
  const context = vm.createContext({
    window, URL, URLSearchParams, AbortController,
    console,
    document: {
      addEventListener() {}, getElementById: (id) => elements.get(id) || null,
      querySelectorAll: (selector) => selector === '.player-chip[data-picker="prediction"]' ? chips : []
    },
    fetch: fetchImpl || (async () => { throw new Error("Unexpected request"); })
  });
  loadPublicFrontendModules(context, root);
  for (const file of ["players.js", "script.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
  }
  const { state, operations } = window.publicAppCoordinator;
  state.predictionTargetGameId = "canonical-game";
  state.predictionTargetGame = { internalGameId: "canonical-game", date: "2099-07-21", startAt: "2099-07-21T09:00:00Z" };
  return { state, operations, appState: window.publicAppState, stored, chips };
}

module.exports = { createPublicRuntime };
