const test = require("node:test");
const assert = require("node:assert/strict");
const { canonicalAdmin, settle } = require("./helpers/admin-canonical-runtime.cjs");

test("canonical Asia admin initializes from shipped HTML and renders the overview games", async () => {
  const app = canonicalAdmin();
  await settle();
  assert.deepEqual(app.unknownIds, []);
  for (const id of ["loadGame", "teamTitle", "rosterTitle"]) assert.equal(app.elements.has(id), false);
  assert.deepEqual(app.calls.map((call) => call.url), ["/api/asia-cs/auth/me", "/api/asia-cs/admin/overview?competitionId=apbc-2026", "/api/asia-cs/admin/dry-run/fixture"]);
  assert.equal(app.elements.get("competitionForm").elements.id.value, "apbc-2026");
  assert.equal(app.elements.get("competitionForm").elements.status.value, "draft");
  assert.match(app.elements.get("overview").textContent, /game-1/);
  assert.match(app.elements.get("overview").textContent, /game-2/);
  assert.match(app.elements.get("overview").textContent, /GAME2/);
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
