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
    VALUES ('apbc-2026', 'ASIA_CS', 'APBC 2026', 'APBC26', '2026-11-12', '2026-11-15', 'draft', ?, ?)`)
    .run(now, now);
  const teams = [
    ["team-japan-uuid", "jpn", "日本", "日本", "JPN"],
    ["team-kor-uuid", "kor", "韓国", "KOR", "KOR"],
    ["team-aus-uuid", "aus", "オーストラリア", "AUS", "AUS"],
    ["team-tpe-uuid", "tpe", "チャイニーズ・タイペイ", "TPE", "TPE"]
  ];
  for (const [id, key, display, short, country] of teams) {
    database.prepare(`INSERT INTO teams
      (id, competition_id, team_key, display_name, short_name, country_code, created_at, updated_at)
      VALUES (?, 'apbc-2026', ?, ?, ?, ?, ?, ?)`)
      .run(id, key, display, short, country, now, now);
  }
  const games = [
    ["apbc-2026-g1", "2026-11-12T03:00:00.000Z", "2026-11-12T02:00:00.000Z", "team-kor-uuid", "韓国", "team-aus-uuid", "オーストラリア"],
    ["apbc-2026-g2", "2026-11-12T10:00:00.000Z", "2026-11-12T09:00:00.000Z", "team-tpe-uuid", "チャイニーズ・タイペイ", "team-japan-uuid", "日本"],
    ["apbc-2026-g3", "2026-11-13T03:00:00.000Z", "2026-11-13T02:00:00.000Z", "team-aus-uuid", "オーストラリア", "team-tpe-uuid", "チャイニーズ・タイペイ"],
    ["apbc-2026-g4", "2026-11-13T10:00:00.000Z", "2026-11-13T09:00:00.000Z", "team-japan-uuid", "日本", "team-kor-uuid", "韓国"],
    ["apbc-2026-g5", "2026-11-14T03:00:00.000Z", "2026-11-14T02:00:00.000Z", "team-aus-uuid", "オーストラリア", "team-japan-uuid", "日本"],
    ["apbc-2026-g6", "2026-11-14T10:00:00.000Z", "2026-11-14T09:00:00.000Z", "team-kor-uuid", "韓国", "team-tpe-uuid", "チャイニーズ・タイペイ"]
  ];
  for (const [id, start, deadline, homeId, homeName, awayId, awayName] of games) {
    database.prepare(`INSERT INTO games
      (id, title, competition_type, competition_id, game_date, start_at, prediction_deadline_at,
       home_team_id, home_team_name, away_team_id, away_team_name, status, publication_status, created_at, updated_at)
      VALUES (?, ?, 'ASIA_CS', 'apbc-2026', ?, ?, ?, ?, ?, ?, ?, 'open', 'pending', ?, ?)`)
      .run(id, id.toUpperCase(), start.slice(0, 10), start, deadline, homeId, homeName, awayId, awayName, now, now);
  }
  return { database, DB: createD1Adapter(database), ASIA_CS_LOCAL_AUTH: "true", ASIA_CS_ENV: "test", ALLOWED_ORIGIN: "https://asia-cs.test" };
}

async function request(worker, env, url, options = {}) {
  const response = await worker.default.fetch(new Request(`https://asia-cs.test${url}`, options), env, {});
  const payload = await response.json();
  return { response, payload, cookie: response.headers.get("set-cookie") || "" };
}

test("APBC prediction scope is Japan-only while schedule remains tournament-wide", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = createFixture();
  const landing = await request(worker, env, "/api/competition?competitionId=apbc-2026");
  assert.equal(landing.response.status, 200);
  assert.deepEqual(landing.payload.games.map((game) => game.id), [
    "apbc-2026-g1", "apbc-2026-g2", "apbc-2026-g3", "apbc-2026-g4", "apbc-2026-g5", "apbc-2026-g6"
  ]);
  assert.deepEqual(landing.payload.games.map((game) => game.predictionEligible), [false, true, false, true, true, false]);
  assert.deepEqual(landing.payload.games.map((game) => game.canPredict), [false, true, false, true, true, false]);
  assert.equal(landing.payload.nextGame.id, "apbc-2026-g2");
  assert.deepEqual(landing.payload.acceptingGames.map((game) => game.id), ["apbc-2026-g2", "apbc-2026-g4", "apbc-2026-g5"]);

  const nonJapan = await request(worker, env, "/api/games/apbc-2026-g1");
  assert.equal(nonJapan.payload.game.predictionEligible, false);
  assert.equal(nonJapan.payload.game.canPredict, false);
  const japan = await request(worker, env, "/api/games/apbc-2026-g2");
  assert.equal(japan.payload.game.predictionEligible, true);
  assert.equal(japan.payload.game.canPredict, true);
});
test("APBC non-Japan prediction save is rejected before lineup validation", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = createFixture();
  const registration = await request(worker, env, "/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "apbc-scope-user", password: "apbc-scope-password" })
  });
  assert.equal(registration.response.status, 201);
  const cookie = registration.cookie.split(";")[0];
  const blocked = await request(worker, env, "/api/games/apbc-2026-g1/prediction", {
    method: "PUT",
    headers: { Cookie: cookie, Origin: "https://asia-cs.test", "Content-Type": "application/json" },
    body: JSON.stringify({ lineup: [], teamId: "team-kor-uuid" })
  });
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.payload.code, "PREDICTION_NOT_ELIGIBLE");
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM predictions").get().count, 0);
});

test("APBC UI keeps non-Japan games as schedule-only and opens Japan games", () => {
  const app = fs.readFileSync(path.join(root, "asia-cs/public/app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.match(app, /predictionEligible/);
  assert.match(app, /日程のみ/);
  assert.match(app, /function isJapanPredictionGame/);
  assert.match(app, /if \(!isJapanPredictionGame\(state\.game\)\)/);
  assert.match(html, /id="asiaEditionNextTitle">次の日本戦</);
});
