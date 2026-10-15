const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const settle = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };

// Build only IDs shipped by admin-v3: unknown/retired IDs return null, rather
// than letting a permissive fixture hide a dependency on the removed page.
function canonicalAdmin({ authenticated = true } = {}) {
  const html = read("admin-v3.html");
  function node(attributes = "") {
    const listeners = new Map();
    const classes = new Set((attributes.match(/class="([^"]*)"/)?.[1] || "").split(/\s+/));
    return {
      value: attributes.match(/value="([^"]*)"/)?.[1] || "", textContent: "", dataset: {}, elements: {},
      classList: { remove: (key) => classes.delete(key), contains: (key) => classes.has(key), toggle(key, on) { on ? classes.add(key) : classes.delete(key); } },
      setAttribute() {}, replaceChildren() {}, appendChild() {},
      addEventListener(type, handler) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(handler); },
      async emit(type) { await Promise.all((listeners.get(type) || []).map((handler) => handler({ preventDefault() {}, currentTarget: this }))); await settle(); },
      listenerCount: (type) => (listeners.get(type) || []).length
    };
  }
  const elements = new Map([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(([tag, id]) => [id, node(tag)]));
  const panels = [...html.matchAll(/<section\b[^>]*class="[^"]*\badmin-only\b[^>]*>/g)].map(([tag]) => node(tag));
  for (const [form, body] of [...html.matchAll(/<form\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)].map((m) => [m[1], m[2]])) {
    for (const [tag, name] of [...body.matchAll(/<(?:input|select|textarea)\b[^>]*name="([^"]+)"[^>]*>/g)]) elements.get(form).elements[name] = node(tag);
  }
  elements.get("competitionForm").elements.status.value = "draft";
  const documentEvents = node();
  const unknownIds = [];
  const document = {
    readyState: "interactive", documentElement: { dataset: {} },
    getElementById(id) { if (!elements.has(id)) unknownIds.push(id); return elements.get(id) || null; },
    querySelectorAll(selector) { return selector === ".admin-only" ? panels : []; },
    addEventListener: (...args) => documentEvents.addEventListener(...args)
  };
  const calls = [];
  let fixtureReady = false;
  const window = { location: { href: "https://starting9.test/admin-v3.html?edition=asia" }, history: { replaceState() {} }, confirm: () => true };
  const context = vm.createContext({ window, globalThis: window, document, URL, Date, console,
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    FormData: class { constructor(form) { this.entries = Object.entries(form.elements).map(([key, value]) => [key, value.value]); } [Symbol.iterator]() { return this.entries[Symbol.iterator](); } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      let payload;
      if (url === "/api/asia-cs/auth/me") payload = { ok: true, isAdmin: authenticated, user: authenticated ? { id: "admin" } : null };
      else if (url === "/api/asia-cs/admin/overview?competitionId=apbc-2026") payload = { competition: { id: "apbc-2026", displayName: "APBC", status: "draft" }, teams: [{ id: "jpn" }, { id: "kor" }], games: [] };
      else if (url === "/api/asia-cs/admin/dry-run/fixture") {
        if (options.method === "POST") fixtureReady = true;
        payload = { ready: fixtureReady, fixture: { exists: fixtureReady, ready: fixtureReady, status: "draft", games: [] } };
      } else if (url === "/api/asia-cs/admin/dry-run/fixture/activate") {
        payload = { fixture: { exists: true, ready: true, status: "active", games: [] } };
      } else if (url === "/api/asia-cs/admin/placement-games") payload = { game: { title: "決勝" } };
      else throw new Error(`Unexpected API ${url}`);
      return { ok: true, json: async () => payload };
    }
  });
  for (const file of ["frontend/shared/edition.js", "frontend/admin-v3/edition-shell.js", "asia-cs/public/admin-action-guardrails.js", "asia-cs/public/admin.js"]) vm.runInContext(read(file), context, { filename: file });
  return { calls, elements, unknownIds, panels, window, context };
}

test("canonical Asia admin initializes without legacy DOM and requests each bootstrap API once", async () => {
  const app = canonicalAdmin();
  await settle();
  assert.deepEqual(app.unknownIds, []);
  for (const id of ["loadGame", "teamTitle", "rosterTitle"]) assert.equal(app.elements.has(id), false);
  assert.deepEqual(app.calls.map((call) => call.url), ["/api/asia-cs/auth/me", "/api/asia-cs/admin/overview?competitionId=apbc-2026", "/api/asia-cs/admin/dry-run/fixture"]);
  assert.equal(app.elements.get("competitionForm").elements.id.value, "apbc-2026");
  assert.ok(app.panels.length > 0);
  assert.ok(app.panels.every((panel) => !panel.classList.contains("hidden")));
  for (const id of ["refreshOverview", "confirmLineup", "scoreGame", "rankingGame", "publishGame", "rescoreGame", "prepareDryRunFixture", "activateDryRunFixture", "refreshDryRunFixture"]) assert.equal(app.elements.get(id).listenerCount("click"), 1, id);
  assert.equal(app.elements.get("placementGameForm").listenerCount("submit"), 1);
  await app.elements.get("refreshOverview").emit("click");
  assert.equal(app.calls.filter((call) => call.url.includes("overview?")).length, 2);
  assert.ok(app.calls.every((call) => call.options.credentials === "include" && call.options.cache === "no-store"));
});

test("canonical dry-run and placement bind once and keep their existing API payloads", async () => {
  const app = canonicalAdmin();
  await settle();
  await app.elements.get("prepareDryRunFixture").emit("click");
  assert.equal(app.calls.filter((call) => call.options.method === "POST" && call.url.endsWith("/dry-run/fixture")).length, 1);
  assert.equal(app.calls.filter((call) => call.url.endsWith("/dry-run/fixture") && !call.options.method).length, 2);
  await app.elements.get("activateDryRunFixture").emit("click");
  assert.equal(app.calls.filter((call) => call.url.endsWith("/fixture/activate") && call.options.method === "POST").length, 1);
  const form = app.elements.get("placementGameForm");
  form.elements.placementType.value = "final";
  form.elements.opponentTeamId.value = "kor";
  form.elements.japanSide.value = "home";
  await form.emit("submit");
  const placement = app.calls.filter((call) => call.url.endsWith("/placement-games"));
  assert.equal(placement.length, 1);
  assert.equal(placement[0].options.method, "POST");
  assert.deepEqual(JSON.parse(placement[0].options.body), { competitionId: "apbc-2026", placementType: "final", opponentTeamId: "kor", japanSide: "home" });
  assert.deepEqual(app.unknownIds, []);
});

test("anonymous canonical admin does not load overview or fixture data", async () => {
  const app = canonicalAdmin({ authenticated: false });
  await settle();
  assert.deepEqual(app.calls.map((call) => call.url), ["/api/asia-cs/auth/me"]);
  assert.ok(app.panels.length > 0);
  assert.ok(app.panels.every((panel) => panel.classList.contains("hidden")));
  assert.match(app.elements.get("adminAuthStatus").textContent, /管理者/);
});

test("edition shell still needs the global session bridge without rebinding action buttons", async () => {
  const app = canonicalAdmin();
  await settle();
  app.window.Starting9AdminEditionShell.sync("ASIA_CS");
  await settle();
  assert.equal(app.calls.filter((call) => call.url.endsWith("/auth/me")).length, 2);
  assert.equal(app.elements.get("prepareDryRunFixture").listenerCount("click"), 1);
  assert.equal(app.elements.get("placementGameForm").listenerCount("submit"), 1);
});
