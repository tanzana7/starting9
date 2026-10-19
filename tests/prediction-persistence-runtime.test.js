const assert = require("node:assert/strict");
const test = require("node:test");
const { createPublicRuntime } = require("./helpers/public-runtime.cjs");
const teamContext = require("../frontend/shared/team-context.js");

const url = "https://starting9.test/api/predictions/current?internalGameId=game-1";

function createPersistence(apiClient) {
  const app = createPublicRuntime({ targetTeam: teamContext.FIGHTERS });
  return { app, persistence: app.publicFrontend.createPublicPredictionPersistence({ apiClient, targetTeam: teamContext.FIGHTERS }) };
}

function scopedUrl() {
  const parsed = new URL(url);
  parsed.searchParams.set("contestId", "contest_67616d652d31_6669676874657273");
  return parsed.toString();
}

test("load preserves GET credentials, no-store, signal, and returns the parsed prediction", async (t) => {
  const calls = [];
  const controller = new AbortController();
  const app = createPublicRuntime({ targetTeam: teamContext.FIGHTERS });
  t.after(app.dispose);
  const apiClient = app.publicFrontend.createPublicApiClient(async (...args) => {
      calls.push(args);
      return { ok: true, status: 200, json: async () => ({ ok: true, prediction: { lineup: [] } }) };
  });
  const persistence = app.publicFrontend.createPublicPredictionPersistence({ apiClient, targetTeam: teamContext.FIGHTERS });

  const result = await persistence.load(url, controller.signal);

  assert.deepEqual(result, { ok: true, prediction: { lineup: [] } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], scopedUrl());
  assert.equal(calls[0][1].credentials, "include");
  assert.equal(calls[0][1].cache, "no-store");
  assert.equal(calls[0][1].signal, controller.signal);
});

test("load rejects HTTP and API-level failures using the existing message contract", async (t) => {
  for (const [response, payload, message] of [
    [{ ok: false, status: 401 }, { ok: false, error: "unauthorized" }, "unauthorized"],
    [{ ok: true, status: 200 }, { ok: false, error: "missing" }, "missing"]
  ]) {
    const { app, persistence } = createPersistence({ get: async () => ({ response, payload }) });
    t.after(app.dispose);
    await assert.rejects(persistence.load(url), { message });
  }
});

test("save preserves canonical PUT body, JSON header, credentials, and response payload", async (t) => {
  const calls = [];
  const prediction = { schemaVersion: 1, lineup: [{ playerId: "F-12", position: "右" }] };
  const { app, persistence } = createPersistence({
    request: async (...args) => {
      calls.push(args);
      return { response: { ok: true, status: 200 }, payload: { ok: true, submittedAt: "submitted", updatedAt: "updated" } };
    }
  });
  t.after(app.dispose);

  const result = await persistence.save(url, "game-1", prediction);

  assert.deepEqual(result, { ok: true, submittedAt: "submitted", updatedAt: "updated" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], scopedUrl());
  assert.equal(calls[0][1].method, "PUT");
  assert.equal(calls[0][1].credentials, "include");
  assert.equal(calls[0][1].headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    internalGameId: "game-1", contestId: "contest_67616d652d31_6669676874657273", prediction
  });
});

test("save 401, PREDICTION_NOT_OPEN 409, and network errors remain failures", async (t) => {
  const conflict = createPersistence({ request: async () => ({ response: { ok: false, status: 409 }, payload: { ok: false, code: "PREDICTION_NOT_OPEN", error: "closed" } }) });
  t.after(conflict.app.dispose);
  await assert.rejects(conflict.persistence.save(url, "game-1", { lineup: [] }), (error) => {
    assert.equal(error.code, "PREDICTION_NOT_OPEN");
    assert.equal(error.status, 409);
    assert.equal(error.message, "closed");
    return true;
  });

  const unauthorized = createPersistence({ request: async () => ({ response: { ok: false, status: 401 }, payload: { ok: false, code: "AUTH_REQUIRED" } }) });
  t.after(unauthorized.app.dispose);
  await assert.rejects(unauthorized.persistence.save(url, "game-1", { lineup: [] }), (error) => error.code === "AUTH_REQUIRED" && error.status === 401);

  const offline = createPersistence({ request: async () => { throw new TypeError("offline"); } });
  t.after(offline.app.dispose);
  await assert.rejects(offline.persistence.save(url, "game-1", { lineup: [] }), { message: "offline" });
});

test("remove uses the canonical DELETE request and rejects API failures", async (t) => {
  const calls = [];
  const { app, persistence } = createPersistence({
    request: async (...args) => {
      calls.push(args);
      return { response: { ok: true, status: 200 }, payload: { ok: true } };
    }
  });
  t.after(app.dispose);

  assert.deepEqual(await persistence.remove(url), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], scopedUrl());
  assert.equal(calls[0][1].method, "DELETE");
  assert.equal(calls[0][1].credentials, "include");

  const failed = createPersistence({ request: async () => ({ response: { ok: false, status: 409 }, payload: { ok: false, code: "PREDICTION_NOT_OPEN" } }) });
  t.after(failed.app.dispose);
  await assert.rejects(failed.persistence.remove(url), { message: "HTTP 409" });
});
