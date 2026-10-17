const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const settle = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };

// Use the shipped admin-v3 HTML as the only DOM fixture. This keeps runtime
// coverage honest when IDs are retired or a renderer expects a real form.
function canonicalAdmin({ withCoordinator = false, coordinatorActions = {} } = {}) {
  const html = read("admin-v3.html");
  function node(attributes = "") {
    const listeners = new Map();
    const classes = new Set((attributes.match(/class="([^"]*)"/)?.[1] || "").split(/\s+/));
    return {
      value: attributes.match(/value="([^"]*)"/)?.[1] || "", textContent: "", dataset: {}, elements: {}, style: { removeProperty() {} },
      classList: { add: (...keys) => keys.forEach((key) => classes.add(key)), remove: (...keys) => keys.forEach((key) => classes.delete(key)), contains: (key) => classes.has(key), toggle(key, on) { on ? classes.add(key) : classes.delete(key); } },
      setAttribute() {}, replaceChildren() {}, appendChild() {},
      addEventListener(type, handler) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(handler); },
      async emit(type, event = {}) { await Promise.all((listeners.get(type) || []).map((handler) => handler({ preventDefault() {}, currentTarget: this, ...event }))); await settle(); },
      listenerCount: (type) => (listeners.get(type) || []).length
    };
  }
  const elements = new Map([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(([tag, id]) => [id, node(tag)]));
  const panels = [...html.matchAll(/<section\b[^>]*class="[^\"]*\badmin-only\b[^\"]*"[^>]*>/g)].map(([tag]) => node(tag));
  for (const [form, body] of [...html.matchAll(/<form\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)].map((m) => [m[1], m[2]])) {
    for (const [tag, name] of [...body.matchAll(/<(?:input|select|textarea)\b[^>]*name="([^"]+)"[^>]*>/g)]) elements.get(form).elements[name] = node(tag);
  }
  const documentEvents = node();
  const unknownIds = [];
  const document = {
    readyState: "interactive", visibilityState: "visible", documentElement: { dataset: {}, clientWidth: 1280, clientHeight: 720 }, body: node(),
    getElementById(id) { if (!elements.has(id)) unknownIds.push(id); return elements.get(id) || null; },
    querySelector() { return null; }, querySelectorAll(selector) { return selector === ".admin-only" ? panels : []; },
    elementFromPoint() { return null; }, addEventListener: (...args) => documentEvents.addEventListener(...args)
  };
  const window = { location: { href: "https://starting9.test/admin-v3.html" }, history: { replaceState() {} }, confirm: () => true, addEventListener() {} };
  const context = vm.createContext({ window, globalThis: window, document, URL, Date, console, Map, Set, Number,
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    FormData: class { constructor(form) { this.entries = Object.entries(form.elements).map(([key, value]) => [key, value.value]); } [Symbol.iterator]() { return this.entries[Symbol.iterator](); } },
  });
  let coordinator;
  if (withCoordinator) {
    const state = { rankingReset: {}, perfectScorePreview: {}, manualLineup: {}, manualRoster: {}, lineupCorrection: {}, rankingTestUsers: {} };
    const actions = new Proxy(coordinatorActions, { get(target, property) { return target[property] || (() => {}); } });
    vm.runInContext(read("frontend/admin-v3/app-coordinator.js"), context, { filename: "frontend/admin-v3/app-coordinator.js" });
    coordinator = context.window.Starting9AdminV3.createAdminV3Coordinator({ document, window, state, actions });
  }
  return { elements, unknownIds, panels, window, context, coordinator, emitDocument: (type, event) => documentEvents.emit(type, event) };
}

module.exports = { canonicalAdmin, settle };
