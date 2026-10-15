const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadPublicFrontendModules } = require("./load-public-frontend-modules.cjs");

// Load the shipped scripts intact. Exercise the coordinator's real operations,
// not copied function bodies, so private helper names are free to change.
function createPublicRuntime({ fetchImpl, user = { id: "user-1" }, candidateNames = [], now, ui = false, lineup = [], staticGames = [], positionMenuRuntime = false } = {}) {
  const root = path.join(__dirname, "..", "..");
  const stored = new Map();
  const timers = new Map();
  const documentListeners = new Map();
  let timerId = 0;
  let clock = now ? Date.parse(now) : Date.now();
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  class RuntimeElement {}
  function element(dataset = {}) {
    const classes = new Set();
    let markup = "";
    const attributes = new Map();
    const listeners = new Map();
    const node = Object.setPrototypeOf({
      dataset, children: [], disabled: false, tagName: "DIV", parentElement: null,
      style: { removeProperty: (key) => { delete node.style[key]; } },
      get className() { return [...classes].join(" "); },
      set className(value) { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach((name) => classes.add(name)); },
      get textContent() { return markup.replace(/<[^>]*>/g, ""); },
      set textContent(value) { this.children.length = 0; markup = String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); },
      get innerHTML() { return markup; },
      set innerHTML(value) {
        this.children.length = 0;
        markup = String(value);
        // The result fallback appends rows to the empty tbody it just renders.
        if (/<tbody><\/tbody>/.test(markup)) {
          const tbody = element();
          tbody.tagName = "TBODY";
          this.appendChild(tbody);
        }
      },
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
      append(...children) { children.forEach((child) => this.appendChild(child)); },
      appendChild(child) {
        if (!child) return child;
        if (child.nodeType === 11) {
          child.children.slice().forEach((fragmentChild) => this.appendChild(fragmentChild));
          child.children.length = 0;
        } else {
          child.parentElement = this;
          this.children.push(child);
        }
        return child;
      },
      closest(selector) {
        const key = { "[data-result-history-select]": "resultHistorySelect", "[data-result-history-toggle]": "resultHistoryToggle" }[selector];
        return key && Object.hasOwn(dataset, key) ? this : null;
      },
      matches(selector) {
        const classMatch = selector.match(/\.([\w-]+)/);
        if (classMatch && !classes.has(classMatch[1])) return false;
        const pickerMatch = selector.match(/\[data-picker="([^"]+)"\]/);
        if (pickerMatch && this.dataset.picker !== pickerMatch[1]) return false;
        const attributeMatch = selector.match(/\[data-([\w-]+)\]/);
        if (attributeMatch && !Object.hasOwn(this.dataset, attributeMatch[1])) return false;
        const tagMatch = selector.match(/^([a-z][\w-]*)/i);
        return !tagMatch || String(this.tagName).toLowerCase() === tagMatch[1].toLowerCase();
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      querySelectorAll(selector) {
        const matches = [];
        const visit = (child) => {
          if (child?.matches?.(selector)) matches.push(child);
          child?.children?.forEach(visit);
        };
        this.children.forEach(visit);
        return matches;
      },
      getContext: () => null
    }, RuntimeElement.prototype);
    return node;
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
  if (positionMenuRuntime) elementIds.push("predictionLineup", "predictionPlayers");
  const elements = new Map(elementIds.map((id) => [id, element()]));
  const slots = lineup.map((item, index) => {
    const slot = element({ picker: "prediction", order: String(index + 1), player: item.player || "", position: item.position || "" });
    const controls = new Map([".slot-player", ".position-button", ".slot-clear"].map((key) => [key, element()]));
    slot.querySelector = (selector) => controls.get(selector) || null;
    return slot;
  });
  const body = element();
  body.tagName = "BODY";
  if (positionMenuRuntime) {
    [elements.get("predictionLineup"), elements.get("predictionPlayers")].forEach((container) => body.appendChild(container));
  }
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
    body,
    documentElement: { clientWidth: 1024, clientHeight: 768 },
    addEventListener(type, handler) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(handler);
    },
    async emit(type, event = {}) {
      const results = (documentListeners.get(type) || []).map((handler) => handler({ preventDefault() {}, stopPropagation() {}, ...event }));
      await Promise.all(results);
    },
    getElementById: (id) => elements.get(id) || null,
    createElement: () => element(),
    createDocumentFragment: () => Object.assign(element(), { nodeType: 11, tagName: "#document-fragment" }),
    querySelectorAll: (selector) => {
      if (positionMenuRuntime) return body.querySelectorAll(selector);
      if (selector === '.player-chip[data-picker="prediction"]') return chips;
      if (selector === '.lineup-slot[data-picker="prediction"]') return slots;
      return [];
    }
  };
  const context = vm.createContext({
    window, URL, URLSearchParams, AbortController,
    console, document, Date: ClockDate, Element: RuntimeElement, HTMLSelectElement: RuntimeElement,
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
    state, operations, appState: window.publicAppState, stored, chips, elements, slots, body, createElement: element,
    emitDocument: (type, event) => document.emit(type, event),
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
