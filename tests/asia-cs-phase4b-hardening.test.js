import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationFiles = [
  "0001_asia_cs_mvp.sql",
  "0002_competition_and_formal_jobs.sql",
  "0003_review_hardening.sql",
  "0004_ranking-generation-snapshots.sql",
  "0005_publication-revision.sql",
  "0006_phase2-product.sql",
  "0007_phase2-roster-metadata.sql"
];
const migration = migrationFiles.map((file) => fs.readFileSync(path.join(root, "asia-cs/migrations", file), "utf8")).join("\n");

function createD1Adapter(database) {
  const wrap = (statement, values = []) => ({
    bind(...nextValues) { return wrap(statement, nextValues); },
    async first() { return statement.get(...values) || null; },
    async all() { return { results: statement.all(...values) }; },
    async run() { const result = statement.run(...values); return { meta: { changes: result.changes } }; },
    _execute() { statement.run(...values); }
  });
  return {
    prepare(sql) { return wrap(database.prepare(sql)); },
    async batch(statements) {
      database.exec("BEGIN");
      try {
        for (const statement of statements) statement._execute();
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return statements.map(() => ({ meta: { changes: 1 } }));
    }
  };
}

function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(migration);
  return { database, DB: createD1Adapter(database), ASIA_CS_LOCAL_AUTH: "true", ASIA_CS_ENV: "test" };
}

async function request(worker, env, requestPath, options = {}) {
  const response = await worker.default.fetch(new Request(`https://asia-cs.test${requestPath}`, options), env, {});
  return { response, payload: await response.json(), cookie: response.headers.get("set-cookie") || "" };
}

function cookie(result) { return result.cookie.split(";")[0]; }

async function adminSession(worker, env) {
  const bootstrap = await request(worker, env, "/api/auth/admin/bootstrap", {
    method: "POST",
    headers: { "X-Admin-Bootstrap-Token": env.ADMIN_BOOTSTRAP_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "operator", password: "operator-password" })
  });
  assert.equal(bootstrap.response.status, 201);
  const login = await request(worker, env, "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "operator", password: "operator-password" })
  });
  assert.equal(login.response.status, 200);
  return cookie(login);
}

function jsonOptions(method, adminCookie, body) {
  return { method, headers: { Cookie: adminCookie, "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function game(id, overrides = {}) {
  return {
    id,
    title: id,
    gameDate: "2026-11-12",
    startAt: "2026-11-12T19:00:00+09:00",
    predictionDeadlineAt: "2026-11-12T18:00:00+09:00",
    homeTeamId: "home",
    awayTeamId: "away",
    ...overrides
  };
}

test("bulk game import rejects before bootstrap and preserves the database on invalid batches", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = { ...fixture(), ADMIN_BOOTSTRAP_TOKEN: "phase4b-token", ALLOWED_ORIGIN: "https://asia-cs.test" };
  const adminCookie = await adminSession(worker, env);
  const competitionsBeforeMissingImport = env.database.prepare("SELECT COUNT(*) AS count FROM competitions").get().count;
  const missingCompetition = await request(worker, env, "/api/admin/games/import", jsonOptions("POST", adminCookie, {
    competitionId: "missing-import-competition",
    games: [game("missing-invalid", { predictionDeadlineAt: "2026-11-12T20:00:00+09:00" })]
  }));
  assert.equal(missingCompetition.response.status, 404);
  assert.equal(missingCompetition.payload.code, "COMPETITION_NOT_FOUND");
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM competitions").get().count, competitionsBeforeMissingImport);

  const competition = await request(worker, env, "/api/admin/competition", jsonOptions("POST", adminCookie, {
    id: "phase4b-import",
    displayName: "Phase 4B Import",
    shortName: "P4B",
    status: "draft"
  }));
  assert.equal(competition.response.status, 200);
  for (const team of [{ teamKey: "home", displayName: "Home", shortName: "H" }, { teamKey: "away", displayName: "Away", shortName: "A" }]) {
    assert.equal((await request(worker, env, "/api/admin/teams", jsonOptions("POST", adminCookie, { ...team, competitionId: "phase4b-import" }))).response.status, 201);
  }
  const baseline = {
    competitions: env.database.prepare("SELECT COUNT(*) AS count FROM competitions").get().count,
    games: env.database.prepare("SELECT COUNT(*) AS count FROM games").get().count,
    jobs: env.database.prepare("SELECT COUNT(*) AS count FROM formal_jobs").get().count
  };
  const cases = [
    ["invalid deadline", [game("invalid-deadline", { predictionDeadlineAt: "2026-11-12T19:00:00+09:00" })], 400],
    ["unknown team", [game("unknown-team", { awayTeamId: "unknown" })], 409],
    ["mixed batch", [game("valid-first"), game("invalid-second", { predictionDeadlineAt: "2026-11-12T20:00:00+09:00" })], 400],
    ["duplicate within batch", [game("duplicate"), game("duplicate")], 400]
  ];
  for (const [name, games, expectedStatus] of cases) {
    const result = await request(worker, env, "/api/admin/games/import", jsonOptions("POST", adminCookie, { competitionId: "phase4b-import", games }));
    assert.equal(result.response.status, expectedStatus, name);
    assert.deepEqual({
      competitions: env.database.prepare("SELECT COUNT(*) AS count FROM competitions").get().count,
      games: env.database.prepare("SELECT COUNT(*) AS count FROM games").get().count,
      jobs: env.database.prepare("SELECT COUNT(*) AS count FROM formal_jobs").get().count
    }, baseline, name);
  }
  const valid = await request(worker, env, "/api/admin/games/import", jsonOptions("POST", adminCookie, {
    competitionId: "phase4b-import",
    games: [game("valid-one"), game("valid-two", { gameDate: "2026-11-13", startAt: "2026-11-13T19:00:00+09:00", predictionDeadlineAt: "2026-11-13T18:00:00+09:00" })]
  }));
  assert.equal(valid.response.status, 200);
  assert.equal(valid.payload.imported, 2);
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM games WHERE competition_id = 'phase4b-import'").get().count, 2);
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM formal_jobs WHERE game_id IN ('valid-one', 'valid-two')").get().count, 8);
});

test("competition creation defaults to draft and requires explicit active status", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = { ...fixture(), ADMIN_BOOTSTRAP_TOKEN: "phase4b-status-token", ALLOWED_ORIGIN: "https://asia-cs.test" };
  const adminCookie = await adminSession(worker, env);
  const omitted = await request(worker, env, "/api/admin/competition", jsonOptions("POST", adminCookie, { id: "draft-default", displayName: "Draft", shortName: "D" }));
  assert.equal(omitted.response.status, 200);
  assert.equal(omitted.payload.competition.status, "draft");
  const active = await request(worker, env, "/api/admin/competition", jsonOptions("POST", adminCookie, { id: "explicit-active", displayName: "Active", shortName: "A", status: "active" }));
  assert.equal(active.response.status, 200);
  assert.equal(active.payload.competition.status, "active");
  const html = fs.readFileSync(path.join(root, "asia-cs/public/admin.html"), "utf8");
  assert.match(html, /<option value="draft" selected>draft<\/option>/);
  assert.doesNotMatch(html, /<option value="active" selected>active<\/option>/);
});

test("competition status omission preserves existing status while explicit values still apply", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = { ...fixture(), ADMIN_BOOTSTRAP_TOKEN: "phase4b-status-preserve-token", ALLOWED_ORIGIN: "https://asia-cs.test" };
  const adminCookie = await adminSession(worker, env);
  const create = async (id, status) => request(worker, env, "/api/admin/competition", jsonOptions("POST", adminCookie, {
    id, displayName: id, shortName: id.slice(0, 8), ...(status ? { status } : {})
  }));
  assert.equal((await create("existing-active", "active")).payload.competition.status, "active");
  assert.equal((await create("existing-draft", "draft")).payload.competition.status, "draft");
  const updateWithoutStatus = async (id) => request(worker, env, "/api/admin/competition", jsonOptions("PUT", adminCookie, {
    id, displayName: `${id}-updated`, shortName: "updated"
  }));
  assert.equal((await updateWithoutStatus("existing-active")).payload.competition.status, "active");
  assert.equal((await updateWithoutStatus("existing-draft")).payload.competition.status, "draft");
  assert.equal((await create("existing-active", "draft")).payload.competition.status, "draft");
  assert.equal((await create("existing-draft", "active")).payload.competition.status, "active");
});

test("valid bulk import bootstraps a missing competition only after validation", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = { ...fixture(), ADMIN_BOOTSTRAP_TOKEN: "phase4b-bootstrap-token", ALLOWED_ORIGIN: "https://asia-cs.test" };
  const adminCookie = await adminSession(worker, env);
  const competitionId = "legacy-bootstrap";
  for (const [teamKey, displayName] of [["home", "Home"], ["away", "Away"]]) {
    env.database.prepare(`INSERT INTO teams
      (id, competition_id, team_key, display_name, short_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(`${competitionId}-${teamKey}`, competitionId, teamKey, displayName, teamKey.slice(0, 1).toUpperCase(), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  }
  const invalid = await request(worker, env, "/api/admin/games/import", jsonOptions("POST", adminCookie, {
    competitionId,
    games: [game("bootstrap-invalid", { predictionDeadlineAt: "2026-11-12T19:00:00+09:00" })]
  }));
  assert.equal(invalid.response.status, 404);
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM competitions WHERE id = ?").get(competitionId).count, 0);
  const valid = await request(worker, env, "/api/admin/games/import", jsonOptions("POST", adminCookie, {
    competitionId,
    games: [game("bootstrap-one"), game("bootstrap-two", { gameDate: "2026-11-13", startAt: "2026-11-13T19:00:00+09:00", predictionDeadlineAt: "2026-11-13T18:00:00+09:00" })]
  }));
  assert.equal(valid.response.status, 200);
  assert.equal(env.database.prepare("SELECT status FROM competitions WHERE id = ?").get(competitionId).status, "draft");
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM games WHERE competition_id = ?").get(competitionId).count, 2);
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM formal_jobs WHERE competition_id = ?").get(competitionId).count, 8);
});

test("player JSON template is empty, API-shaped, and not production-ready", () => {
  const template = JSON.parse(fs.readFileSync(path.join(root, "asia-cs/staging/phase4/players.template.json"), "utf8"));
  assert.equal(template.readyForProduction, false);
  assert.deepEqual(template.players, []);
  const readme = fs.readFileSync(path.join(root, "asia-cs/staging/phase4/README.md"), "utf8");
  for (const field of ["id", "name", "teamId", "position", "uniformNumber", "bat", "throw", "active"]) assert.match(readme, new RegExp(`\\b${field}\\b`));
  assert.doesNotMatch(JSON.stringify(template), /TEST_ONLY|Japan Test Player/);
});
