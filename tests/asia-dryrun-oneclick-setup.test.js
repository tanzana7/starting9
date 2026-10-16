import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrations = fs.readdirSync(path.join(root, "asia-cs/migrations"))
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
        statements.forEach((statement) => statement._execute());
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return statements.map(() => ({ meta: { changes: 1 } }));
    }
  };
}

function createFixture({ sourceRosterCount = 15 } = {}) {
  const database = new DatabaseSync(":memory:");
  database.exec(migrations);
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO competitions
    (id, competition_type, display_name, short_name, start_date, end_date, status, created_at, updated_at)
    VALUES ('apbc-2026', 'ASIA_CS', 'APBC 2026', 'APBC26', '2026-11-12', '2026-11-15', 'active', ?, ?)`)
    .run(now, now);
  for (const [id, key, displayName, shortName, countryCode] of [
    ["team-japan", "jpn", "日本", "JPN", "JPN"],
    ["team-tpe", "tpe", "チャイニーズ・タイペイ", "TPE", "TPE"],
    ["team-kor", "kor", "韓国", "KOR", "KOR"],
    ["team-aus", "aus", "オーストラリア", "AUS", "AUS"]
  ]) {
    database.prepare(`INSERT INTO teams
      (id, competition_id, team_key, display_name, short_name, country_code, created_at, updated_at)
      VALUES (?, 'apbc-2026', ?, ?, ?, ?, ?, ?)`)
      .run(id, key, displayName, shortName, countryCode, now, now);
  }
  database.prepare(`INSERT INTO games
    (id, title, competition_type, competition_id, game_date, start_at, prediction_deadline_at,
     home_team_id, home_team_name, away_team_id, away_team_name, status, publication_status, created_at, updated_at)
    VALUES ('apbc-2026-g2', 'GAME2', 'ASIA_CS', 'apbc-2026', '2026-11-12',
      '2026-11-12T09:00:00.000Z', '2026-11-12T08:00:00.000Z', 'tpe', 'チャイニーズ・タイペイ', 'jpn', '日本', 'open', 'pending', ?, ?)`)
    .run(now, now);
  for (let index = 1; index <= sourceRosterCount; index += 1) {
    database.prepare(`INSERT INTO players
      (id, game_id, name, uniform_number, team, team_id, position, bat, throw, active, created_at, updated_at)
      VALUES (?, 'apbc-2026-g2', ?, ?, ?, 'team-japan', ?, 'R', 'R', 1, ?, ?)`)
      .run(`apbc-player-${index}`, `日本選手${index}`, String(index), `球団${index}`, index <= 2 ? "捕手" : index <= 10 ? "内野手" : "外野手", now, now);
  }
  return {
    database,
    DB: createD1Adapter(database),
    ASIA_CS_LOCAL_AUTH: "true",
    ASIA_CS_ENV: "test",
    ALLOWED_ORIGIN: "https://asia-cs.test",
    ADMIN_BOOTSTRAP_TOKEN: "dry-run-token"
  };
}

async function loadWorker() {
  return import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
}

async function request(worker, env, pathName, options = {}) {
  const response = await worker.default.fetch(new Request(`https://asia-cs.test${pathName}`, options), env, {});
  const payload = await response.json().catch(() => ({}));
  return { response, payload, setCookie: response.headers.get("set-cookie") || "" };
}

function cookie(result) { return result.setCookie.split(";")[0]; }

async function adminCookie(worker, env) {
  const bootstrap = await request(worker, env, "/api/auth/admin/bootstrap", {
    method: "POST",
    headers: { "X-Admin-Bootstrap-Token": env.ADMIN_BOOTSTRAP_TOKEN },
    body: JSON.stringify({ username: "dry-run-admin", password: "dry-run-admin-password" })
  });
  assert.equal(bootstrap.response.status, 201);
  const login = await request(worker, env, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "dry-run-admin", password: "dry-run-admin-password" })
  });
  assert.equal(login.response.status, 200);
  return cookie(login);
}

async function regularCookie(worker, env) {
  const registration = await request(worker, env, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username: "dry-run-user", password: "dry-run-user-password" })
  });
  assert.equal(registration.response.status, 201);
  return cookie(registration);
}

test("10/16 fixture endpoint is fixed, authenticated, CSRF protected, and idempotent", async () => {
  const worker = await loadWorker();
  const env = createFixture();
  const anonymous = await request(worker, env, "/api/admin/dry-run/fixture", { method: "POST", body: "{}" });
  assert.equal(anonymous.response.status, 401);

  const userCookie = await regularCookie(worker, env);
  const nonAdmin = await request(worker, env, "/api/admin/dry-run/fixture", { method: "POST", headers: { Cookie: userCookie }, body: "{}" });
  assert.equal(nonAdmin.response.status, 403);

  const admin = await adminCookie(worker, env);
  const invalidCsrf = await request(worker, env, "/api/admin/dry-run/fixture", {
    method: "POST",
    headers: { Cookie: admin, Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
    body: JSON.stringify({ competitionId: "apbc-2026" })
  });
  assert.equal(invalidCsrf.response.status, 403);

  const first = await request(worker, env, "/api/admin/dry-run/fixture", {
    method: "POST",
    headers: { Cookie: admin, Origin: "https://asia-cs.test", "Sec-Fetch-Site": "same-origin" },
    body: JSON.stringify({ competitionId: "attacker-controlled" })
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.payload.fixture.competition.id, "apbc-switch-test-2026-10-16");
  assert.equal(first.payload.fixture.status, "draft");
  assert.equal(first.payload.fixture.ready, true);
  assert.deepEqual(first.payload.fixture.games.map((game) => [game.id, game.startAt, game.predictionDeadlineAt, game.homeTeamId, game.awayTeamId]), [
    ["TEST1", "2026-10-16T09:00:00.000Z", "2026-10-16T08:00:00.000Z", "jpn", "kor"],
    ["TEST2", "2026-10-16T13:00:00.000Z", "2026-10-16T12:00:00.000Z", "aus", "jpn"]
  ]);
  assert.deepEqual(first.payload.fixture.formalJobs.map((job) => [job.gameId, job.job_type, job.status]), [
    ["TEST1", "prediction_close", "scheduled"], ["TEST1", "publish", "scheduled"], ["TEST1", "ranking_rebuild", "scheduled"], ["TEST1", "score", "scheduled"],
    ["TEST2", "prediction_close", "scheduled"], ["TEST2", "publish", "scheduled"], ["TEST2", "ranking_rebuild", "scheduled"], ["TEST2", "score", "scheduled"]
  ]);

  const second = await request(worker, env, "/api/admin/dry-run/fixture", {
    method: "POST",
    headers: { Cookie: admin, Origin: "https://asia-cs.test", "Sec-Fetch-Site": "same-origin" },
    body: "{}"
  });
  assert.equal(second.response.status, 200);
  assert.deepEqual(second.payload.fixture.games.map((game) => [game.id, game.rosterCount, game.formalJobs.length]), [["TEST1", 15, 4], ["TEST2", 15, 4]]);
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM competitions WHERE id = 'apbc-switch-test-2026-10-16'").get().count, 1);
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM teams WHERE competition_id = 'apbc-switch-test-2026-10-16'").get().count, 4);
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM games WHERE competition_id = 'apbc-switch-test-2026-10-16'").get().count, 2);
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM formal_jobs WHERE competition_id = 'apbc-switch-test-2026-10-16'").get().count, 8);
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM players WHERE game_id = 'apbc-2026-g2'").get().count, 15);
  const sourcePlayers = env.database.prepare("SELECT id, name, team, position FROM players WHERE game_id = 'apbc-2026-g2' ORDER BY id").all();
  assert.equal(new Set(second.payload.fixture.games.flatMap((game) => game.players.map((player) => player.sourcePlayerId))).size, 15);
  for (const game of second.payload.fixture.games) {
    assert.deepEqual(game.players.map((player) => [player.sourcePlayerId, player.name, player.club, player.registeredPosition]).sort(), sourcePlayers.map((player) => [player.id, player.name, player.team, player.position]).sort());
  }
});

test("10/16 fixture rejects an incomplete source roster before creating target data", async () => {
  const worker = await loadWorker();
  const env = createFixture({ sourceRosterCount: 14 });
  const admin = await adminCookie(worker, env);
  const result = await request(worker, env, "/api/admin/dry-run/fixture", {
    method: "POST",
    headers: { Cookie: admin, Origin: "https://asia-cs.test", "Sec-Fetch-Site": "same-origin" },
    body: "{}"
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.payload.code, "DRYRUN_SOURCE_ROSTER_INVALID");
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM competitions WHERE id = 'apbc-switch-test-2026-10-16'").get().count, 0);
});

test("activation is a separate fixed-fixture transition and preserves APBC", async (t) => {
  // This checks pre-deadline acceptance of the fixed 10/16 fixture. Wall-clock
  // time must not turn it into a post-deadline test after that date passes.
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-16T00:00:00Z") });
  const worker = await loadWorker();
  const env = createFixture();
  const admin = await adminCookie(worker, env);
  const before = env.database.prepare("SELECT status FROM competitions WHERE id = 'apbc-2026'").get().status;
  await request(worker, env, "/api/admin/dry-run/fixture", { method: "POST", headers: { Cookie: admin, Origin: "https://asia-cs.test" }, body: "{}" });
  const active = await request(worker, env, "/api/admin/dry-run/fixture/activate", { method: "POST", headers: { Cookie: admin, Origin: "https://asia-cs.test" }, body: "{}" });
  assert.equal(active.response.status, 200);
  assert.equal(active.payload.fixture.status, "active");
  assert.equal(env.database.prepare("SELECT status FROM competitions WHERE id = 'apbc-2026'").get().status, before);

  let landing = await request(worker, env, "/api/competition?competitionId=apbc-switch-test-2026-10-16");
  assert.deepEqual(landing.payload.acceptingGames.map((game) => game.id), ["TEST1"]);
  assert.equal(landing.payload.games.find((game) => game.id === "TEST2").canPredict, false);
  env.database.prepare("UPDATE games SET status = 'published', publication_status = 'published' WHERE id = 'TEST1'").run();
  landing = await request(worker, env, "/api/competition?competitionId=apbc-switch-test-2026-10-16");
  assert.deepEqual(landing.payload.acceptingGames.map((game) => game.id), ["TEST2"]);
});

test("Asia admin UI exposes only the fixed one-click fixture controls", () => {
  const page = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
  const admin = fs.readFileSync(path.join(root, "asia-cs/public/admin.js"), "utf8");
  assert.match(page, /10\/16テスト大会を準備/);
  assert.match(page, /dryRunFixture/);
  assert.match(admin, /\/api\/admin\/dry-run\/fixture/);
  assert.match(admin, /APBC本大会とは独立した10\/16仮運用テスト大会を作成します/);
  assert.match(admin, /10\/16仮運用テストの予想受付を開始します/);
  assert.doesNotMatch(admin, /competitionId.*dryRun/);
});
