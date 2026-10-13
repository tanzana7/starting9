import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = fs.readdirSync(path.join(root, "asia-cs/migrations"))
  .filter((file) => /^\d+_.*\.sql$/.test(file))
  .sort()
  .map((file) => fs.readFileSync(path.join(root, "asia-cs/migrations", file), "utf8"))
  .join("\n");

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

function createFixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(migration);
  return { database, DB: createD1Adapter(database), ASIA_CS_LOCAL_AUTH: "true", ASIA_CS_ENV: "test" };
}

async function request(worker, env, endpoint, options = {}) {
  const response = await worker.default.fetch(new Request(`https://asia-cs.test${endpoint}`, options), env, {});
  return { response, payload: await response.json(), cookie: response.headers.get("set-cookie") || "" };
}

function cookie(result) {
  return result.cookie.split(";")[0];
}

async function adminSession(worker, env) {
  const bootstrap = await request(worker, env, "/api/auth/admin/bootstrap", {
    method: "POST",
    headers: { "X-Admin-Bootstrap-Token": "japan-only-token" },
    body: JSON.stringify({ username: "operator", password: "operator-password" })
  });
  assert.equal(bootstrap.response.status, 201);
  const login = await request(worker, env, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "operator", password: "operator-password" })
  });
  assert.equal(login.response.status, 200);
  return cookie(login);
}

function gamePayload(id, homeTeamId, awayTeamId, index) {
  const day = String(15 + index).padStart(2, "0");
  return {
    id,
    title: id,
    competitionId: "apbc-2026",
    gameDate: `2026-11-${day}`,
    startAt: `2026-11-${day}T09:00:00+09:00`,
    predictionDeadlineAt: `2026-11-${day}T08:00:00+09:00`,
    homeTeamId,
    homeTeamName: homeTeamId,
    awayTeamId,
    awayTeamName: awayTeamId
  };
}

test("APBC formal jobs are generated only when Japan participates", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const fixture = createFixture();
  const env = { ...fixture, ADMIN_BOOTSTRAP_TOKEN: "japan-only-token", ALLOWED_ORIGIN: "https://asia-cs.test" };
  const adminCookie = await adminSession(worker, env);

  const competition = await request(worker, env, "/api/admin/competition", {
    method: "PUT",
    headers: { Cookie: adminCookie },
    body: JSON.stringify({ id: "apbc-2026", displayName: "APBC 2026", shortName: "APBC", status: "draft" })
  });
  assert.equal(competition.response.status, 200);
  for (const [teamKey, displayName, countryCode] of [
    ["korea", "Korea", "KOR"],
    ["australia", "Australia", "AUS"],
    ["chinese-taipei", "Chinese Taipei", "TPE"],
    ["japan", "Japan", "JPN"]
  ]) {
    const created = await request(worker, env, "/api/admin/teams", {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: JSON.stringify({ competitionId: "apbc-2026", teamKey, displayName, shortName: teamKey, countryCode })
    });
    assert.equal(created.response.status, 201);
  }

  const games = [
    ["GAME1", "korea", "australia"],
    ["GAME2", "chinese-taipei", "japan"],
    ["GAME3", "australia", "chinese-taipei"],
    ["GAME4", "japan", "korea"],
    ["GAME5", "australia", "japan"],
    ["GAME6", "korea", "chinese-taipei"]
  ];
  for (const [index, [id, home, away]] of games.entries()) {
    const created = await request(worker, env, "/api/admin/games", {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: JSON.stringify(gamePayload(id, home, away, index))
    });
    assert.equal(created.response.status, 201, id);
  }

  const counts = fixture.database.prepare("SELECT game_id, COUNT(*) AS count FROM formal_jobs GROUP BY game_id ORDER BY game_id").all();
  assert.deepEqual(counts.map((row) => ({ game_id: row.game_id, count: row.count })), [
    { game_id: "GAME2", count: 4 },
    { game_id: "GAME4", count: 4 },
    { game_id: "GAME5", count: 4 }
  ]);
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM formal_jobs").get().count, 12);
});

test("ensureFormalJobs does not recreate non-Japan jobs and prediction operations fail closed", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const fixture = createFixture();
  const env = { ...fixture, ADMIN_BOOTSTRAP_TOKEN: "japan-only-token", ALLOWED_ORIGIN: "https://asia-cs.test" };
  const adminCookie = await adminSession(worker, env);
  await request(worker, env, "/api/admin/competition", {
    method: "PUT", headers: { Cookie: adminCookie },
    body: JSON.stringify({ id: "apbc-2026", displayName: "APBC 2026", shortName: "APBC", status: "draft" })
  });
  for (const [teamKey, displayName, countryCode] of [["japan", "Japan", "JPN"], ["korea", "Korea", "KOR"], ["australia", "Australia", "AUS"]]) {
    await request(worker, env, "/api/admin/teams", {
      method: "POST", headers: { Cookie: adminCookie },
      body: JSON.stringify({ competitionId: "apbc-2026", teamKey, displayName, shortName: teamKey, countryCode })
    });
  }
  const created = await request(worker, env, "/api/admin/games", {
    method: "POST", headers: { Cookie: adminCookie },
    body: JSON.stringify(gamePayload("GAME1", "korea", "australia", 0))
  });
  assert.equal(created.response.status, 201);
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM formal_jobs WHERE game_id = 'GAME1'").get().count, 0);

  // Legacy rows are intentionally left untouched, but an admin read must not
  // use ensureFormalJobs to add more rows after a safe reconciliation.
  const now = new Date().toISOString();
  for (const jobType of ["prediction_close", "score", "ranking_rebuild", "publish"]) {
    fixture.database.prepare(`INSERT INTO formal_jobs
      (id, game_id, competition_type, competition_id, job_type, status, due_at, attempts, created_at, updated_at)
      VALUES (?, 'GAME1', 'ASIA_CS', 'apbc-2026', ?, 'scheduled', ?, 0, ?, ?)`)
      .run(`legacy-${jobType}`, jobType, now, now, now);
  }
  const before = fixture.database.prepare("SELECT COUNT(*) AS count FROM formal_jobs WHERE game_id = 'GAME1'").get().count;
  const detail = await request(worker, env, "/api/admin/games/GAME1", { headers: { Cookie: adminCookie } });
  assert.equal(detail.response.status, 200);
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM formal_jobs WHERE game_id = 'GAME1'").get().count, before);

  const ranking = await request(worker, env, "/api/admin/games/GAME1/ranking", { method: "POST", headers: { Cookie: adminCookie }, body: "{}" });
  assert.equal(ranking.response.status, 409);
  assert.equal(ranking.payload.code, "PREDICTION_NOT_ELIGIBLE");
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM competition_ranking_generations").get().count, 0);
});

test("formal job eligibility follows team identity for future games, not game numbers", async () => {
  const { formalJobTypesForGame } = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const japan = { id: "team-jpn", team_key: "jpn", display_name: "Japan", short_name: "JPN", country_code: "JPN" };
  const korea = { id: "team-kor", team_key: "kor", display_name: "Korea", short_name: "KOR", country_code: "KOR" };
  const australia = { id: "team-aus", team_key: "aus", display_name: "Australia", short_name: "AUS", country_code: "AUS" };
  const allTeams = [japan, korea, australia];
  assert.equal(formalJobTypesForGame({ id: "GAME8", home_team_id: "jpn", away_team_id: "kor" }, allTeams).length, 4);
  assert.equal(formalJobTypesForGame({ id: "GAME8", home_team_id: "kor", away_team_id: "aus" }, allTeams).length, 0);
});
