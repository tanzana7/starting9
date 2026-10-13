import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrations = [
  "0001_asia_cs_mvp.sql",
  "0002_competition_and_formal_jobs.sql",
  "0003_review_hardening.sql",
  "0004_ranking-generation-snapshots.sql",
  "0005_publication-revision.sql",
  "0006_phase2-product.sql",
  "0007_phase2-roster-metadata.sql"
].map((file) => fs.readFileSync(path.join(root, "asia-cs/migrations", file), "utf8")).join("\n");

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
  database.exec(migrations);
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

async function createCompetitionTeams(worker, env, adminCookie, competitionId) {
  for (const team of [
    { teamKey: "jpn", displayName: "Japan", shortName: "JPN", countryCode: "JPN" },
    { teamKey: "kor", displayName: "Korea", shortName: "KOR", countryCode: "KOR" },
    { teamKey: "tpe", displayName: "Chinese Taipei", shortName: "TPE", countryCode: "TPE" }
  ]) {
    const result = await request(worker, env, "/api/admin/teams", jsonOptions("POST", adminCookie, { ...team, competitionId }));
    assert.equal(result.response.status, 201);
  }
}

function gameInput(id, overrides = {}) {
  return {
    id,
    competitionId: "deadline-test",
    title: id,
    gameDate: "2026-11-15",
    startAt: "2026-11-15T19:00:00+09:00",
    homeTeamId: "jpn",
    awayTeamId: "kor",
    homeTeamName: "Japan",
    awayTeamName: "Korea",
    ...overrides
  };
}

test("new Asia games derive the 60-minute deadline and preserve Japan-only jobs", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = { ...fixture(), ADMIN_BOOTSTRAP_TOKEN: "deadline-token", ALLOWED_ORIGIN: "https://asia-cs.test" };
  const adminCookie = await adminSession(worker, env);
  const competition = await request(worker, env, "/api/admin/competition", jsonOptions("POST", adminCookie, {
    id: "deadline-test", displayName: "Deadline Test", shortName: "DT", status: "draft"
  }));
  assert.equal(competition.response.status, 200);
  await createCompetitionTeams(worker, env, adminCookie, "deadline-test");

  const game7 = await request(worker, env, "/api/admin/games", jsonOptions("POST", adminCookie, gameInput("game7", {
    startAt: "2026-11-15T11:00:00+09:00"
  })));
  assert.equal(game7.response.status, 201);
  assert.equal(game7.payload.game.predictionDeadlineAt, "2026-11-15T01:00:00.000Z");
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM formal_jobs WHERE game_id = 'game7'").get().count, 4);

  const game8 = await request(worker, env, "/api/admin/games", jsonOptions("POST", adminCookie, gameInput("game8", {
    predictionDeadlineAt: "2026-11-15T18:00:00+09:00"
  })));
  assert.equal(game8.response.status, 201);
  assert.equal(game8.payload.game.predictionDeadlineAt, "2026-11-15T09:00:00.000Z");

  const nonJapan = await request(worker, env, "/api/admin/games", jsonOptions("POST", adminCookie, gameInput("non-japan", {
    homeTeamId: "kor",
    awayTeamId: "tpe",
    homeTeamName: "Korea",
    awayTeamName: "Chinese Taipei"
  })));
  assert.equal(nonJapan.response.status, 201);
  assert.equal(nonJapan.payload.game.predictionDeadlineAt, "2026-11-15T09:00:00.000Z");
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM formal_jobs WHERE game_id = 'non-japan'").get().count, 0);

  const inconsistent = await request(worker, env, "/api/admin/games", jsonOptions("POST", adminCookie, gameInput("bad-deadline", {
    predictionDeadlineAt: "2026-11-15T17:30:00+09:00"
  })));
  assert.equal(inconsistent.response.status, 400);
  assert.equal(inconsistent.payload.code, "INVALID_PREDICTION_DEADLINE");
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM games WHERE id = 'bad-deadline'").get().count, 0);
});

test("bulk game creation derives deadlines and remains idempotent at the job boundary", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = { ...fixture(), ADMIN_BOOTSTRAP_TOKEN: "bulk-deadline-token", ALLOWED_ORIGIN: "https://asia-cs.test" };
  const adminCookie = await adminSession(worker, env);
  await createCompetitionTeams(worker, env, adminCookie, "deadline-test");

  const imported = await request(worker, env, "/api/admin/games/import", jsonOptions("POST", adminCookie, {
    competitionId: "deadline-test",
    games: [gameInput("bulk-game", { startAt: "2026-11-15T11:00:00+09:00" })]
  }));
  assert.equal(imported.response.status, 200);
  assert.equal(imported.payload.games[0].predictionDeadlineAt, "2026-11-15T01:00:00.000Z");
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM formal_jobs WHERE game_id = 'bulk-game'").get().count, 4);

  const repeated = await request(worker, env, "/api/admin/games/import", jsonOptions("POST", adminCookie, {
    competitionId: "deadline-test",
    games: [gameInput("bulk-game", { startAt: "2026-11-15T11:00:00+09:00" })]
  }));
  assert.equal(repeated.response.status, 400);
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM formal_jobs WHERE game_id = 'bulk-game'").get().count, 4);
});

test("admin game detail GET is read-only and reports missing jobs without repairing them", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = { ...fixture(), ADMIN_BOOTSTRAP_TOKEN: "readonly-token", ALLOWED_ORIGIN: "https://asia-cs.test" };
  const adminCookie = await adminSession(worker, env);
  await createCompetitionTeams(worker, env, adminCookie, "deadline-test");
  const created = await request(worker, env, "/api/admin/games", jsonOptions("POST", adminCookie, gameInput("readonly-game")));
  assert.equal(created.response.status, 201);
  env.database.prepare("DELETE FROM formal_jobs WHERE game_id = 'readonly-game' AND job_type IN ('score', 'publish')").run();
  const before = env.database.prepare("SELECT id, job_type, updated_at FROM formal_jobs WHERE game_id = 'readonly-game' ORDER BY job_type").all();

  const first = await request(worker, env, "/api/admin/games/readonly-game", { headers: { Cookie: adminCookie } });
  const second = await request(worker, env, "/api/admin/games/readonly-game", { headers: { Cookie: adminCookie } });
  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);
  assert.deepEqual(first.payload.missingFormalJobTypes.sort(), ["publish", "score"]);
  assert.deepEqual(second.payload.missingFormalJobTypes.sort(), ["publish", "score"]);
  assert.deepEqual(env.database.prepare("SELECT id, job_type, updated_at FROM formal_jobs WHERE game_id = 'readonly-game' ORDER BY job_type").all(), before);
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM formal_jobs WHERE game_id = 'readonly-game'").get().count, 2);
});
