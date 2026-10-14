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
    async run() { const result = statement.run(...values); return { meta: { changes: result.changes } }; }
  });
  return {
    prepare(sql) { return wrap(database.prepare(sql)); },
    async batch(statements) {
      database.exec("BEGIN");
      try {
        for (const statement of statements) await statement.run();
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
  database.exec(migrations);
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO competitions
    (id, competition_type, display_name, short_name, start_date, end_date, status, created_at, updated_at)
    VALUES ('apbc-2026', 'ASIA_CS', 'APBC 2026', 'APBC26', '2026-11-12', '2026-11-15', 'active', ?, ?)`)
    .run(now, now);
  const teams = [
    ["team-japan", "jpn", "日本", "JPN", "JPN"],
    ["team-tpe", "tpe", "チャイニーズ・タイペイ", "TPE", "TPE"],
    ["team-kor", "kor", "韓国", "KOR", "KOR"],
    ["team-aus", "aus", "オーストラリア", "AUS", "AUS"]
  ];
  for (const [id, key, display, short, country] of teams) {
    database.prepare(`INSERT INTO teams
      (id, competition_id, team_key, display_name, short_name, country_code, created_at, updated_at)
      VALUES (?, 'apbc-2026', ?, ?, ?, ?, ?, ?)`)
      .run(id, key, display, short, country, now, now);
  }
  const games = [
    ["apbc-2026-g2", "2026-11-12", "2026-11-12T10:00:00.000Z", "2026-11-12T09:00:00.000Z", "team-tpe", "チャイニーズ・タイペイ", "team-japan", "日本"],
    ["apbc-2026-g4", "2026-11-13", "2026-11-13T10:00:00.000Z", "2026-11-13T09:00:00.000Z", "team-japan", "日本", "team-kor", "韓国"],
    ["apbc-2026-g5", "2026-11-14", "2026-11-14T03:00:00.000Z", "2026-11-14T02:00:00.000Z", "team-aus", "オーストラリア", "team-japan", "日本"]
  ];
  for (const [id, date, start, deadline, homeId, homeName, awayId, awayName] of games) {
    database.prepare(`INSERT INTO games
      (id, title, competition_type, competition_id, game_date, start_at, prediction_deadline_at,
       home_team_id, home_team_name, away_team_id, away_team_name, status, publication_status, created_at, updated_at)
      VALUES (?, ?, 'ASIA_CS', 'apbc-2026', ?, ?, ?, ?, ?, ?, ?, 'open', 'pending', ?, ?)`)
      .run(id, id.toUpperCase(), date, start, deadline, homeId, homeName, awayId, awayName, now, now);
  }
  return { database, DB: createD1Adapter(database), ASIA_CS_LOCAL_AUTH: "true", ASIA_CS_ENV: "test", ALLOWED_ORIGIN: "https://asia-cs.test" };
}

async function request(worker, env, url, options = {}) {
  const response = await worker.default.fetch(new Request(`https://asia-cs.test${url}`, options), env, {});
  const payload = await response.json();
  return { response, payload, cookie: response.headers.get("set-cookie") || "" };
}

async function publish(database, gameId) {
  database.prepare("UPDATE games SET status = 'published', publication_status = 'published' WHERE id = ?").run(gameId);
}

test("Asia prediction target advances only after the prior Japan game is fully published", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = createFixture();
  const target = async () => (await request(worker, env, "/api/competition?competitionId=apbc-2026")).payload;

  let payload = await target();
  assert.deepEqual(payload.acceptingGames.map((game) => game.id), ["apbc-2026-g2"]);
  assert.deepEqual(payload.games.map((game) => [game.id, game.canPredict]), [
    ["apbc-2026-g2", true], ["apbc-2026-g4", false], ["apbc-2026-g5", false]
  ]);
  assert.deepEqual(payload.games.map((game) => [game.id, game.predictionState]), [
    ["apbc-2026-g2", "open"], ["apbc-2026-g4", "waiting_for_previous_publish"], ["apbc-2026-g5", "waiting_for_previous_publish"]
  ]);

  await publish(env.database, "apbc-2026-g2");
  payload = await target();
  assert.deepEqual(payload.acceptingGames.map((game) => game.id), ["apbc-2026-g4"]);
  assert.equal(payload.games.find((game) => game.id === "apbc-2026-g2").predictionState, "published");
  assert.equal(payload.games.find((game) => game.id === "apbc-2026-g5").predictionState, "waiting_for_previous_publish");

  await publish(env.database, "apbc-2026-g4");
  payload = await target();
  assert.deepEqual(payload.acceptingGames.map((game) => game.id), ["apbc-2026-g5"]);

  await publish(env.database, "apbc-2026-g5");
  payload = await target();
  assert.deepEqual(payload.acceptingGames, []);
  assert.ok(payload.games.every((game) => game.canPredict === false));
});

test("a Japan placement game becomes the next target without game-number branching", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = createFixture();
  await publish(env.database, "apbc-2026-g2");
  await publish(env.database, "apbc-2026-g4");
  await publish(env.database, "apbc-2026-g5");
  const now = new Date().toISOString();
  env.database.prepare(`INSERT INTO games
    (id, title, competition_type, competition_id, game_date, start_at, prediction_deadline_at,
     home_team_id, home_team_name, away_team_id, away_team_name, status, publication_status, created_at, updated_at)
    VALUES ('placement-final', 'Final', 'ASIA_CS', 'apbc-2026', '2026-11-15', '2026-11-15T03:00:00.000Z', '2026-11-15T02:00:00.000Z', 'team-japan', '日本', 'team-kor', '韓国', 'open', 'pending', ?, ?)`)
    .run(now, now);
  const payload = (await request(worker, env, "/api/competition?competitionId=apbc-2026")).payload;
  assert.deepEqual(payload.acceptingGames.map((game) => game.id), ["placement-final"]);
});

test("an expired unpublished target blocks later games and rejects direct future-game POST", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = createFixture();
  env.database.prepare("UPDATE games SET prediction_deadline_at = '2026-10-14T00:00:00.000Z' WHERE id = 'apbc-2026-g2'").run();
  const payload = (await request(worker, env, "/api/competition?competitionId=apbc-2026")).payload;
  assert.deepEqual(payload.acceptingGames, []);
  assert.ok(payload.games.every((game) => game.canPredict === false));
  assert.equal(payload.games.find((game) => game.id === "apbc-2026-g4").predictionState, "waiting_for_previous_publish");

  const registration = await request(worker, env, "/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "sequential-user", password: "sequential-password" })
  });
  const cookie = registration.cookie.split(";")[0];
  const futurePost = await request(worker, env, "/api/games/apbc-2026-g4/prediction", {
    method: "PUT",
    headers: { Cookie: cookie, Origin: "https://asia-cs.test", "Content-Type": "application/json" },
    body: JSON.stringify({ lineup: [] })
  });
  assert.equal(futurePost.response.status, 409);
  assert.equal(futurePost.payload.code, "PREDICTION_NOT_OPEN");
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM predictions").get().count, 0);
});

test("test competition access is allowlisted and visibly marked without changing the canonical default", () => {
  const app = fs.readFileSync(path.join(root, "asia-cs/public/app.js"), "utf8");
  const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const standalone = fs.readFileSync(path.join(root, "asia-cs/public/index.html"), "utf8");
  assert.match(app, /ALLOWED_COMPETITION_IDS = new Set\(\["apbc-2026", "apbc-switch-test-2026-10-16"\]\)/);
  assert.match(app, /isTestCompetition/);
  assert.match(app, /testBanner/);
  assert.match(index, /id="asiaEditionTestBanner"/);
  assert.match(index, /data-competition-id="apbc-2026"/);
  assert.match(standalone, /id="testBanner"/);
});

test("test competition is created through the admin API and gets isolated formal jobs", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = { ...createFixture(), ADMIN_BOOTSTRAP_TOKEN: "local-bootstrap-token" };
  const bootstrap = await request(worker, env, "/api/auth/admin/bootstrap", {
    method: "POST",
    headers: { "X-Admin-Bootstrap-Token": "local-bootstrap-token" },
    body: JSON.stringify({ username: "sequential-admin", password: "sequential-admin-password" })
  });
  assert.equal(bootstrap.response.status, 201);
  const login = await request(worker, env, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "sequential-admin", password: "sequential-admin-password" })
  });
  const adminCookie = login.cookie.split(";")[0];
  const competitionId = "apbc-switch-test-2026-10-16";
  const created = await request(worker, env, "/api/admin/competition", {
    method: "POST",
    headers: { Cookie: adminCookie },
    body: JSON.stringify({ id: competitionId, displayName: "APBC予想切替テスト 2026-10-16", shortName: "APBC Switch Test", startDate: "2026-10-16", endDate: "2026-10-16", status: "draft" })
  });
  assert.equal(created.response.status, 200);
  for (const team of [
    { teamKey: "jpn", displayName: "日本", shortName: "JPN", countryCode: "JPN" },
    { teamKey: "kor", displayName: "韓国", shortName: "KOR", countryCode: "KOR" },
    { teamKey: "aus", displayName: "オーストラリア", shortName: "AUS", countryCode: "AUS" }
  ]) {
    const result = await request(worker, env, "/api/admin/teams", {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: JSON.stringify({ ...team, competitionId })
    });
    assert.equal(result.response.status, 201);
  }
  const apbcBefore = env.database.prepare("SELECT status FROM competitions WHERE id = 'apbc-2026'").get();
  const game = await request(worker, env, "/api/admin/games", {
    method: "POST",
    headers: { Cookie: adminCookie },
    body: JSON.stringify({
      id: "TEST1",
      title: "TEST1 日本 vs 韓国",
      competitionId,
      gameDate: "2026-10-16",
      startAt: "2026-10-16T09:00:00.000Z",
      predictionDeadlineAt: "2026-10-16T08:00:00.000Z",
      homeTeamId: "jpn",
      homeTeamName: "日本",
      awayTeamId: "kor",
      awayTeamName: "韓国"
    })
  });
  assert.equal(game.response.status, 201);
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM formal_jobs WHERE game_id = 'TEST1'").get().count, 4);
  assert.equal(env.database.prepare("SELECT status FROM competitions WHERE id = ?").get(competitionId).status, "draft");
  assert.equal(env.database.prepare("SELECT status FROM competitions WHERE id = 'apbc-2026'").get().status, apbcBefore.status);
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM games WHERE competition_id = 'apbc-2026'").get().count, 3);
});
