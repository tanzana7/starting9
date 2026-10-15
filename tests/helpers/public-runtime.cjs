const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadPublicFrontendModules } = require("./load-public-frontend-modules.cjs");

// Load the shipped scripts intact. Exercise the coordinator's real operations,
// not copied function bodies, so private helper names are free to change.
function createPublicRuntime({ fetchImpl, user = { id: "user-1" }, candidateNames = [], now, ui = false, lineup = [], staticGames = [] } = {}) {
  const root = path.join(__dirname, "..", "..");
  const stored = new Map();
  const timers = new Map();
  let timerId = 0;
  let clock = now ? Date.parse(now) : Date.now();
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  function element(dataset = {}) {
    const classes = new Set();
    let markup = "";
    const attributes = new Map();
    const listeners = new Map();
    return {
      dataset, children: [], disabled: false,
      get className() { return [...classes].join(" "); },
      set className(value) { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach((name) => classes.add(name)); },
      get textContent() { return markup.replace(/<[^>]*>/g, ""); },
      set textContent(value) { markup = String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); },
      get innerHTML() { return markup; },
      set innerHTML(value) { markup = String(value); },
      classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        toggle(name, enabled = !classes.has(name)) { enabled ? classes.add(name) : classes.delete(name); },
        contains: (name) => classes.has(name)
      },
      setAttribute: (key, value) => attributes.set(key, String(value)),
      getAttribute: (key) => attributes.get(key) ?? null,
      addEventListener(type, handler) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(handler);
      },
      async emit(type, event = {}) {
        const results = (listeners.get(type) || []).map((handler) => handler({ preventDefault() {}, stopPropagation() {}, ...event }));
        await Promise.all(results);
      },
      append(...children) { this.children.push(...children); },
      appendChild(child) { this.children.push(child); return child; },
      querySelector: () => null, querySelectorAll: () => [],
      getContext: () => null
    };
  }
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
  const elementIds = ["savedPrediction", "sharePredictionButton"];
  if (ui) elementIds.push("predictionForm", "resetPredictionButton", "savePredictionButton", "predictionError", "predictionSaveMessage", "publicGameSelectionMeta", "predictionEditor", "predictionCtaButton", "probableStarterDisplay", "predictionRosterStatus", "resultHistoryList");
  const elements = new Map(elementIds.map((id) => [id, element()]));
  const slots = lineup.map((item, index) => {
    const slot = element({ picker: "prediction", order: String(index + 1), player: item.player || "", position: item.position || "" });
    const controls = new Map([".slot-player", ".position-button", ".slot-clear"].map((key) => [key, element()]));
    slot.querySelector = (selector) => controls.get(selector) || null;
    return slot;
  });
  const window = {
    HAM_GAME_SCHEDULE: staticGames,
    location: { href: "https://starting9.test/", search: "", hostname: "starting9.test" },
    localStorage: {
      getItem: (key) => stored.get(key) || null,
      setItem: (key, value) => stored.set(key, value),
      removeItem: (key) => stored.delete(key)
    },
    starting9Auth: { getUser: () => user, getApiBaseUrl: () => "https://starting9.test" }
  };
  window.addEventListener = () => {};
  const document = {
    addEventListener() {}, getElementById: (id) => elements.get(id) || null,
    createElement: () => element(),
    querySelectorAll: (selector) => {
      if (selector === '.player-chip[data-picker="prediction"]') return chips;
      if (selector === '.lineup-slot[data-picker="prediction"]') return slots;
      return [];
    }
  };
  const context = vm.createContext({
    window, URL, URLSearchParams, AbortController,
    console, document, Date: ClockDate,
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay, interval: false }); return timerId; },
    setInterval: (callback, delay) => { timers.set(++timerId, { callback, delay, interval: true }); return timerId; },
    clearTimeout: (id) => timers.delete(id), clearInterval: (id) => timers.delete(id),
    fetch: fetchImpl || (async () => { throw new Error("Unexpected request"); })
  });
  loadPublicFrontendModules(context, root);
  for (const file of ["players.js", "script.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
  }
  const { state, operations } = window.publicAppCoordinator;
  state.predictionTargetGameId = "canonical-game";
  state.predictionTargetGame = { internalGameId: "canonical-game", date: "2099-07-21", startAt: "2099-07-21T09:00:00Z" };
  return {
    state, operations, appState: window.publicAppState, stored, chips, elements, slots,
    setNow: (value) => { clock = Date.parse(value); },
    intervalDelays: () => [...timers.values()].filter((timer) => timer.interval).map((timer) => timer.delay),
    async tickIntervals() {
      for (const timer of [...timers.values()]) if (timer.interval) await timer.callback();
      // Timer callbacks intentionally launch non-blocking UI refreshes. Let
      // their mocked fetch/JSON promise chains settle without real timers.
      await new Promise(setImmediate);
    },
    dispose: () => timers.clear()
  };
}

module.exports = { createPublicRuntime };
