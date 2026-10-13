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

test("APBC public schedule is limited to Japan games", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = createFixture();
  const landing = await request(worker, env, "/api/competition?competitionId=apbc-2026");
  assert.equal(landing.response.status, 200);
  assert.deepEqual(landing.payload.games.map((game) => game.id), ["apbc-2026-g2", "apbc-2026-g4", "apbc-2026-g5"]);
  assert.deepEqual(landing.payload.games.map((game) => game.predictionEligible), [true, true, true]);
  assert.deepEqual(landing.payload.games.map((game) => game.canPredict), [false, false, false]);
  assert.equal(landing.payload.nextGame, null);
  assert.deepEqual(landing.payload.acceptingGames, []);

  const nonJapan = await request(worker, env, "/api/games/apbc-2026-g1");
  assert.equal(nonJapan.response.status, 404);
  assert.equal(nonJapan.payload.code, "GAME_NOT_AVAILABLE");
  const japan = await request(worker, env, "/api/games/apbc-2026-g2");
  assert.equal(japan.payload.game.predictionEligible, true);
  assert.equal(japan.payload.game.canPredict, false);
});

test("APBC draftは公開読み取りを維持し、予想の保存・削除をfail closedする", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = createFixture();
  const registration = await request(worker, env, "/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "apbc-draft-user", password: "apbc-draft-password" })
  });
  assert.equal(registration.response.status, 201);
  const cookie = registration.cookie.split(";")[0];
  const publicRead = await request(worker, env, "/api/games/apbc-2026-g2");
  assert.equal(publicRead.response.status, 200);
  assert.equal(publicRead.payload.game.canPredict, false);
  const save = await request(worker, env, "/api/games/apbc-2026-g2/prediction", {
    method: "PUT",
    headers: { Cookie: cookie, Origin: "https://asia-cs.test", "Content-Type": "application/json" },
    body: JSON.stringify({ lineup: [] })
  });
  assert.equal(save.response.status, 409);
  assert.equal(save.payload.code, "PREDICTION_NOT_OPEN");
  const deletion = await request(worker, env, "/api/games/apbc-2026-g2/prediction", {
    method: "DELETE",
    headers: { Cookie: cookie, Origin: "https://asia-cs.test" }
  });
  assert.equal(deletion.response.status, 409);
  assert.equal(deletion.payload.code, "PREDICTION_NOT_OPEN");
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM predictions").get().count, 0);
});
test("APBC non-Japan prediction save is rejected before lineup validation", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = createFixture();
  env.database.prepare("UPDATE competitions SET status = 'active' WHERE id = 'apbc-2026'").run();
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

test("APBC formal jobs are created only for Japan games and non-Japan detail reads do not backfill", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = { ...createFixture(), ADMIN_BOOTSTRAP_TOKEN: "local-bootstrap-token" };
  const bootstrap = await request(worker, env, "/api/auth/admin/bootstrap", {
    method: "POST",
    headers: { "X-Admin-Bootstrap-Token": "local-bootstrap-token" },
    body: JSON.stringify({ username: "formal-admin", password: "formal-admin-password" })
  });
  assert.equal(bootstrap.response.status, 201);
  const login = await request(worker, env, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "formal-admin", password: "formal-admin-password" })
  });
  assert.equal(login.response.status, 200);
  const adminCookie = login.cookie.split(";")[0];
  const common = {
    competitionId: "apbc-2026",
    gameDate: "2026-11-15",
    startAt: "2026-11-15T09:00:00+09:00",
    predictionDeadlineAt: "2026-11-15T08:00:00+09:00"
  };
  const japanGame = await request(worker, env, "/api/admin/games", {
    method: "POST",
    headers: { Cookie: adminCookie },
    body: JSON.stringify({
      ...common,
      id: "apbc-2026-g7-japan",
      title: "GAME7",
      homeTeamId: "team-japan-uuid",
      homeTeamName: "日本",
      awayTeamId: "team-kor-uuid",
      awayTeamName: "韓国"
    })
  });
  assert.equal(japanGame.response.status, 201);
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM formal_jobs WHERE game_id = ?").get("apbc-2026-g7-japan").count, 4);

  const nonJapanGame = await request(worker, env, "/api/admin/games", {
    method: "POST",
    headers: { Cookie: adminCookie },
    body: JSON.stringify({
      ...common,
      id: "apbc-2026-g8-non-japan",
      title: "GAME8",
      homeTeamId: "team-kor-uuid",
      homeTeamName: "韓国",
      awayTeamId: "team-tpe-uuid",
      awayTeamName: "チャイニーズ・タイペイ"
    })
  });
  assert.equal(nonJapanGame.response.status, 201);
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM formal_jobs WHERE game_id = ?").get("apbc-2026-g8-non-japan").count, 0);
  const nonJapanDetail = await request(worker, env, "/api/admin/games/apbc-2026-g8-non-japan", { headers: { Cookie: adminCookie } });
  assert.equal(nonJapanDetail.response.status, 200);
  assert.equal(nonJapanDetail.payload.formalJobs.length, 0);

  const imported = await request(worker, env, "/api/admin/games/import", {
    method: "POST",
    headers: { Cookie: adminCookie },
    body: JSON.stringify({
      competitionId: "apbc-2026",
      games: [
        { id: "apbc-2026-g7-imported", title: "GAME7 imported", gameDate: "2026-11-15", startAt: "2026-11-15T12:00:00+09:00", predictionDeadlineAt: "2026-11-15T11:00:00+09:00", homeTeamId: "team-japan-uuid", awayTeamId: "team-kor-uuid" },
        { id: "apbc-2026-g8-imported", title: "GAME8 imported", gameDate: "2026-11-15", startAt: "2026-11-15T15:00:00+09:00", predictionDeadlineAt: "2026-11-15T14:00:00+09:00", homeTeamId: "team-kor-uuid", awayTeamId: "team-tpe-uuid" }
      ]
    })
  });
  assert.equal(imported.response.status, 200);
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM formal_jobs WHERE game_id = ?").get("apbc-2026-g7-imported").count, 4);
  assert.equal(env.database.prepare("SELECT COUNT(*) AS count FROM formal_jobs WHERE game_id = ?").get("apbc-2026-g8-imported").count, 0);
});

test("legacy non-Japan formal jobs are not executed by prediction pipeline operations", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = { ...createFixture(), ADMIN_BOOTSTRAP_TOKEN: "local-bootstrap-token" };
  const bootstrap = await request(worker, env, "/api/auth/admin/bootstrap", {
    method: "POST",
    headers: { "X-Admin-Bootstrap-Token": "local-bootstrap-token" },
    body: JSON.stringify({ username: "legacy-admin", password: "legacy-admin-password" })
  });
  assert.equal(bootstrap.response.status, 201);
  const login = await request(worker, env, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "legacy-admin", password: "legacy-admin-password" })
  });
  const adminCookie = login.cookie.split(";")[0];
  const now = new Date().toISOString();
  for (const jobType of ["prediction_close", "score", "ranking_rebuild", "publish"]) {
    env.database.prepare(`INSERT INTO formal_jobs
      (id, game_id, competition_type, competition_id, job_type, status, due_at, attempts, created_at, updated_at)
      VALUES (?, 'apbc-2026-g1', 'ASIA_CS', 'apbc-2026', ?, 'scheduled', ?, 0, ?, ?)`)
      .run(`legacy-${jobType}`, jobType, now, now, now);
  }
  const before = env.database.prepare("SELECT job_type, status, attempts FROM formal_jobs WHERE game_id = 'apbc-2026-g1' ORDER BY job_type").all();
  for (const endpoint of ["score", "ranking", "publish", "rescore"]) {
    const response = await request(worker, env, `/api/admin/games/apbc-2026-g1/${endpoint}`, {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: endpoint === "rescore" ? JSON.stringify({ lineup: [] }) : undefined
    });
    assert.equal(response.response.status, 409, endpoint);
    assert.equal(response.payload.code, "PREDICTION_NOT_ELIGIBLE", endpoint);
  }
  const after = env.database.prepare("SELECT job_type, status, attempts FROM formal_jobs WHERE game_id = 'apbc-2026-g1' ORDER BY job_type").all();
  assert.deepEqual(after, before);
  assert.equal(env.database.prepare("SELECT status, publication_status FROM games WHERE id = 'apbc-2026-g1'").get().status, "open");
});

test("APBC ranking excludes legacy non-Japan prediction rows", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = { ...createFixture(), ADMIN_BOOTSTRAP_TOKEN: "local-bootstrap-token" };
  const bootstrap = await request(worker, env, "/api/auth/admin/bootstrap", {
    method: "POST",
    headers: { "X-Admin-Bootstrap-Token": "local-bootstrap-token" },
    body: JSON.stringify({ username: "ranking-admin", password: "ranking-admin-password" })
  });
  assert.equal(bootstrap.response.status, 201);
  const login = await request(worker, env, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "ranking-admin", password: "ranking-admin-password" })
  });
  const adminCookie = login.cookie.split(";")[0];
  const user = await request(worker, env, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username: "ranking-user", password: "ranking-user-password" })
  });
  const now = "2026-11-13T08:00:00.000Z";
  for (const gameId of ["apbc-2026-g1", "apbc-2026-g2"]) {
    env.database.prepare("UPDATE games SET status = 'scored', publication_status = 'pending', current_lineup_revision = 1 WHERE id = ?").run(gameId);
    env.database.prepare(`INSERT INTO scoring_runs
      (id, game_id, revision_number, kind, processed_count, score_changed_count, started_at, completed_at, created_by)
      VALUES (?, ?, 1, 'initial', 1, 1, ?, ?, ?)`)
      .run(`ranking-run-${gameId}`, gameId, now, now, user.payload.user.id);
  }
  const insertScore = (id, gameId, score) => env.database.prepare(`INSERT INTO predictions
    (id, user_id, game_id, prediction_json, submitted_at, updated_at, status, score, max_score, scored_revision, actual_lineup_json, scored_at, is_test_prediction)
    VALUES (?, ?, ?, '{}', ?, ?, 'scored', ?, 99, 1, '{}', ?, 0)`)
    .run(id, user.payload.user.id, gameId, now, now, score, now);
  insertScore("legacy-non-japan-score", "apbc-2026-g1", 99);
  insertScore("japan-score", "apbc-2026-g2", 90);

  const ranking = await request(worker, env, "/api/admin/games/apbc-2026-g2/ranking", {
    method: "POST",
    headers: { Cookie: adminCookie }
  });
  assert.equal(ranking.response.status, 200);
  const entry = env.database.prepare("SELECT score_total, games_count FROM competition_ranking_entries WHERE competition_id = 'apbc-2026' AND generation = ?").get(ranking.payload.generation);
  assert.deepEqual({ score_total: entry.score_total, games_count: entry.games_count }, { score_total: 90, games_count: 1 });
});

test("APBC UI renders only Japan games and opens Japan games", () => {
  const app = fs.readFileSync(path.join(root, "asia-cs/public/app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.match(app, /predictionEligible/);
  assert.match(app, /filter\(isJapanPredictionGame\)/);
  assert.match(app, /function isJapanPredictionGame/);
  assert.match(app, /if \(!isJapanPredictionGame\(state\.game\)\)/);
  assert.match(html, /id="asiaEditionNextTitle">次の日本戦</);
});

test("APBC prediction form prevents duplicates and makes completion requirements visible", () => {
  const app = fs.readFileSync(path.join(root, "asia-cs/public/app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.match(app, /function validateLineup/);
  assert.match(app, /同じ選手は複数登録できません/);
  assert.match(app, /選手を9人選択してください/);
  assert.match(app, /守備位置を選択してください/);
  assert.match(app, /usedByOtherRows\.has\(String\(item\.id\)\)/);
  assert.match(app, /value\.position \|\| ""/);
  assert.match(app, /予想締切 .*JST/);
  assert.match(app, /予想受付開始前/);
  assert.match(app, /playerMeta/);
  assert.match(html, /id="asiaEditionPredictionValidation"/);
  assert.match(html, /id="asiaEditionSaveButton"[^>]+type="submit"/);
});
