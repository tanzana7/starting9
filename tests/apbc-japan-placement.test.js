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

function d1(database) {
  const wrap = (statement, values = []) => ({
    bind(...next) { return wrap(statement, next); },
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

function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(migrations);
  const now = new Date().toISOString();
  database.prepare("INSERT INTO competitions (id, competition_type, display_name, short_name, start_date, end_date, status, created_at, updated_at) VALUES ('apbc-2026', 'ASIA_CS', 'APBC 2026', 'APBC26', '2026-11-12', '2026-11-15', 'active', ?, ?)").run(now, now);
  for (const [id, key, name, country] of [
    ["team-jpn", "jpn", "Japan", "JPN"],
    ["team-kor", "kor", "Korea", "KOR"],
    ["team-aus", "aus", "Australia", "AUS"],
    ["team-tpe", "tpe", "Chinese Taipei", "TPE"]
  ]) {
    database.prepare("INSERT INTO teams (id, competition_id, team_key, display_name, short_name, country_code, created_at, updated_at) VALUES (?, 'apbc-2026', ?, ?, ?, ?, ?, ?)").run(id, key, name, key.toUpperCase(), country, now, now);
  }
  for (const [id, start, home, away] of [
    ["apbc-2026-g2", "2026-11-13T10:00:00.000Z", "team-tpe", "team-jpn"],
    ["apbc-2026-g4", "2026-11-14T10:00:00.000Z", "team-jpn", "team-kor"]
  ]) {
    const deadline = new Date(new Date(start).getTime() - 60 * 60 * 1000).toISOString();
    const homeName = home === "team-jpn" ? "Japan" : home === "team-tpe" ? "Chinese Taipei" : "Korea";
    const awayName = away === "team-jpn" ? "Japan" : "Korea";
    database.prepare("INSERT INTO games (id, title, competition_type, competition_id, game_date, start_at, prediction_deadline_at, home_team_id, home_team_name, away_team_id, away_team_name, status, publication_status, created_at, updated_at) VALUES (?, ?, 'ASIA_CS', 'apbc-2026', ?, ?, ?, ?, ?, ?, ?, 'open', 'pending', ?, ?)").run(id, id, start.slice(0, 10), start, deadline, home, homeName, away, awayName, now, now);
  }
  return { database, DB: d1(database), ASIA_CS_LOCAL_AUTH: "true", ASIA_CS_ENV: "test", ALLOWED_ORIGIN: "https://asia-cs.test", ADMIN_BOOTSTRAP_TOKEN: "placement-token" };
}

async function request(worker, env, url, options = {}) {
  const response = await worker.default.fetch(new Request("https://asia-cs.test" + url, options), env, {});
  return { response, payload: await response.json(), cookie: response.headers.get("set-cookie") || "" };
}

async function adminCookie(worker, env) {
  const bootstrap = await request(worker, env, "/api/auth/admin/bootstrap", {
    method: "POST",
    headers: { "X-Admin-Bootstrap-Token": "placement-token" },
    body: JSON.stringify({ username: "placement-admin", password: "placement-password" })
  });
  assert.equal(bootstrap.response.status, 201);
  const login = await request(worker, env, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "placement-admin", password: "placement-password" })
  });
  assert.equal(login.response.status, 200);
  return login.cookie.split(";")[0];
}

function seedRoster(database, gameId, prefix) {
  const now = new Date().toISOString();
  for (let index = 1; index <= 15; index += 1) {
    database.prepare("INSERT INTO players (id, game_id, name, uniform_number, team, team_id, position, active, created_at, updated_at) VALUES (?, ?, ?, ?, 'Japan', 'team-jpn', '外野手', 1, ?, ?)").run(prefix + "-" + index, gameId, prefix + "-" + index, String(index), now, now);
  }
}

test("placement defaults to Final, derives schedule/deadline, and copies the latest Japan roster once", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = fixture();
  seedRoster(env.database, "apbc-2026-g2", "old");
  seedRoster(env.database, "apbc-2026-g4", "latest");
  const cookie = await adminCookie(worker, env);
  const created = await request(worker, env, "/api/admin/placement-games", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ competitionId: "apbc-2026", opponentTeamId: "team-kor", japanSide: "away" })
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.game.id, "apbc-2026-g8");
  assert.equal(created.payload.game.externalGameCode, "GAME8");
  assert.equal(created.payload.game.startAt, "2026-11-15T10:00:00.000Z");
  assert.equal(created.payload.game.predictionDeadlineAt, "2026-11-15T09:00:00.000Z");
  assert.equal(created.payload.game.homeTeam.name, "Korea");
  assert.equal(created.payload.game.awayTeam.name, "Japan");
  assert.equal(created.payload.rosterCopiedFromGameId, "apbc-2026-g4");
  assert.equal(created.payload.rosterCount, 15);
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM formal_jobs WHERE game_id = 'apbc-2026-g8'").get().count, 4);
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM players WHERE game_id = 'apbc-2026-g8'").get().count, 15);
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM players WHERE game_id = 'apbc-2026-g8' AND name LIKE 'latest-%'").get().count, 15);

  const duplicate = await request(worker, env, "/api/admin/placement-games", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ competitionId: "apbc-2026", placementType: "third_place", opponentTeamId: "team-aus", japanSide: "home" })
  });
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.payload.code, "PLACEMENT_GAME_EXISTS");

  const publicSchedule = await request(worker, env, "/api/competition?competitionId=apbc-2026");
  assert.deepEqual(publicSchedule.payload.games.map((game) => game.id), ["apbc-2026-g2", "apbc-2026-g4", "apbc-2026-g8"]);
});

test("third-place placement uses the alternative official slot and selected Japan side", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = fixture();
  seedRoster(env.database, "apbc-2026-g4", "latest");
  const cookie = await adminCookie(worker, env);
  const created = await request(worker, env, "/api/admin/placement-games", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ competitionId: "apbc-2026", placementType: "third_place", opponentTeamId: "team-aus", japanSide: "home" })
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.game.id, "apbc-2026-g7");
  assert.equal(created.payload.game.startAt, "2026-11-15T02:00:00.000Z");
  assert.equal(created.payload.game.predictionDeadlineAt, "2026-11-15T01:00:00.000Z");
  assert.equal(created.payload.game.homeTeam.name, "Japan");
  assert.equal(created.payload.game.awayTeam.name, "Australia");
  assert.equal(created.payload.formalJobTypes.length, 4);
});

test("placement UI exposes one dynamic placement path without bracket automation", () => {
  const html = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
  const admin = fs.readFileSync(path.join(root, "asia-cs/public/admin.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "asia-cs/public/app.js"), "utf8");
  assert.match(html, /id="placementType"[\s\S]*value="final" selected/);
  assert.match(html, /id="placementOpponentTeamId"/);
  assert.match(html, /id="placementJapanSide"/);
  assert.match(admin, /\/api\/admin\/placement-games/);
  assert.match(admin, /placementType/);
  assert.match(app, /filter\(isJapanPredictionGame\)/);
});
