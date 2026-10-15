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

// Fixed time and literal expectations characterize the pre-refactor response,
// rather than reproducing its derivation in the assertion helper.
const CONTRACT_NOW = Date.parse("2026-10-15T00:00:00.000Z");
const CONTRACT_IDS = ["apbc-2026-g2", "apbc-2026-g4", "apbc-2026-g5"];
const CONTRACT_DEADLINES = ["2026-11-12T09:00:00.000Z", "2026-11-13T09:00:00.000Z", "2026-11-14T02:00:00.000Z"];

function predictionContract(game) {
  return {
    id: game.id,
    predictionEligible: game.predictionEligible,
    canPredict: game.canPredict,
    predictionState: game.predictionState,
    predictionDeadlineAt: game.predictionDeadlineAt
  };
}

async function assertPredictionContract(worker, env, expected, competitionId = "apbc-2026") {
  const before = env.database.prepare("SELECT total_changes() AS count").get().count;
  const competition = await request(worker, env, `/api/competition?competitionId=${competitionId}`);
  const list = await request(worker, env, `/api/games?competitionId=${competitionId}`);
  assert.equal(competition.response.status, 200);
  assert.equal(list.response.status, 200);
  assert.deepEqual(competition.payload.games.map(predictionContract), expected);
  assert.deepEqual(list.payload.games.map(predictionContract), expected);
  assert.deepEqual(competition.payload.acceptingGames.map((game) => game.id), expected.filter((game) => game.canPredict).map((game) => game.id));
  for (const snapshot of expected) {
    const detail = await request(worker, env, `/api/games/${snapshot.id}`);
    assert.equal(detail.response.status, 200);
    assert.deepEqual(predictionContract(detail.payload.game), snapshot);
  }
  assert.equal(env.database.prepare("SELECT total_changes() AS count").get().count, before, "public reads must not write");
}

for (const scenario of [
  { name: "active initial", states: ["open", "waiting_for_previous_publish", "waiting_for_previous_publish"], open: 0 },
  { name: "GAME2 published", published: 1, states: ["published", "open", "waiting_for_previous_publish"], open: 1 },
  { name: "GAME4 published", published: 2, states: ["published", "published", "open"], open: 2 },
  { name: "all published", published: 3, states: ["published", "published", "published"], open: -1 },
  { name: "draft", status: "draft", states: ["closed", "waiting_for_previous_publish", "waiting_for_previous_publish"], open: -1 },
  { name: "completed", status: "completed", states: ["closed", "waiting_for_previous_publish", "waiting_for_previous_publish"], open: -1 },
  { name: "unknown status", status: "unknown", states: ["closed", "waiting_for_previous_publish", "waiting_for_previous_publish"], open: -1 },
  { name: "deadline minus 1ms", now: Date.parse(CONTRACT_DEADLINES[0]) - 1, states: ["open", "waiting_for_previous_publish", "waiting_for_previous_publish"], open: 0 },
  { name: "deadline exact", now: Date.parse(CONTRACT_DEADLINES[0]), states: ["closed", "waiting_for_previous_publish", "waiting_for_previous_publish"], open: -1 },
  { name: "deadline plus 1ms", now: Date.parse(CONTRACT_DEADLINES[0]) + 1, states: ["closed", "waiting_for_previous_publish", "waiting_for_previous_publish"], open: -1 },
  { name: "only game status published", gameStatus: "published", states: ["closed", "waiting_for_previous_publish", "waiting_for_previous_publish"], open: -1 },
  { name: "only artifact published", publicationStatus: "published", states: ["open", "waiting_for_previous_publish", "waiting_for_previous_publish"], open: 0 }
]) {
  test(`public prediction list/detail contract: ${scenario.name}`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: scenario.now ?? CONTRACT_NOW });
    const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
    const env = createFixture();
    t.after(() => env.database.close());
    if (scenario.status) {
      // Only this isolated DB admits a malformed legacy state for fail-closed coverage.
      env.database.exec("PRAGMA ignore_check_constraints = ON");
      env.database.prepare("UPDATE competitions SET status = ? WHERE id = 'apbc-2026'").run(scenario.status);
    }
    for (const id of CONTRACT_IDS.slice(0, scenario.published || 0)) await publish(env.database, id);
    if (scenario.gameStatus) env.database.prepare("UPDATE games SET status = ? WHERE id = ?").run(scenario.gameStatus, CONTRACT_IDS[0]);
    if (scenario.publicationStatus) env.database.prepare("UPDATE games SET publication_status = ? WHERE id = ?").run(scenario.publicationStatus, CONTRACT_IDS[0]);
    await assertPredictionContract(worker, env, CONTRACT_IDS.map((id, index) => ({
      id, predictionEligible: true, canPredict: index === scenario.open,
      predictionState: scenario.states[index], predictionDeadlineAt: CONTRACT_DEADLINES[index]
    })));
  });
}

test("public prediction contract keeps Japan-only filtering and generic fixture compatibility", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: CONTRACT_NOW });
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = createFixture();
  t.after(() => env.database.close());
  env.database.prepare("UPDATE games SET home_team_id = 'team-kor', home_team_name = '韓国', away_team_id = 'team-aus', away_team_name = 'オーストラリア' WHERE id = ?").run(CONTRACT_IDS[0]);
  await assertPredictionContract(worker, env, [
    { id: CONTRACT_IDS[1], predictionEligible: true, canPredict: true, predictionState: "open", predictionDeadlineAt: CONTRACT_DEADLINES[1] },
    { id: CONTRACT_IDS[2], predictionEligible: true, canPredict: false, predictionState: "waiting_for_previous_publish", predictionDeadlineAt: CONTRACT_DEADLINES[2] }
  ]);
  const hidden = await request(worker, env, `/api/games/${CONTRACT_IDS[0]}`);
  assert.equal(hidden.response.status, 404);
  assert.equal(hidden.payload.code, "GAME_NOT_AVAILABLE");
  env.database.prepare("UPDATE teams SET team_key = 'generic', display_name = 'Generic', short_name = 'Generic', country_code = 'ZZ' WHERE id = 'team-japan'").run();
  await assertPredictionContract(worker, env, CONTRACT_IDS.map((id, index) => ({
    id, predictionEligible: true, canPredict: index === 0,
    predictionState: index === 0 ? "open" : "waiting_for_previous_publish", predictionDeadlineAt: CONTRACT_DEADLINES[index]
  })));
});

test("public prediction list/detail contract advances the isolated 10/16 fixture", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: CONTRACT_NOW });
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = createFixture();
  t.after(() => env.database.close());
  const id = "apbc-switch-test-2026-10-16";
  env.database.prepare("INSERT INTO competitions (id, competition_type, display_name, short_name, status, created_at, updated_at) VALUES (?, 'ASIA_CS', 'Switch Test', 'Test', 'active', ?, ?)").run(id, new Date().toISOString(), new Date().toISOString());
  env.database.prepare("UPDATE teams SET competition_id = ? WHERE competition_id = 'apbc-2026'").run(id);
  env.database.prepare("DELETE FROM games WHERE id = ?").run(CONTRACT_IDS[2]);
  for (const [index, gameId] of ["TEST1", "TEST2"].entries()) {
    env.database.prepare("UPDATE games SET id = ?, competition_id = ?, game_date = '2026-10-16', start_at = ?, prediction_deadline_at = ? WHERE id = ?")
      .run(gameId, id, `2026-10-16T${index === 0 ? "09" : "13"}:00:00.000Z`, `2026-10-16T${index === 0 ? "08" : "12"}:00:00.000Z`, CONTRACT_IDS[index]);
  }
  const snapshots = [
    { id: "TEST1", predictionEligible: true, canPredict: true, predictionState: "open", predictionDeadlineAt: "2026-10-16T08:00:00.000Z" },
    { id: "TEST2", predictionEligible: true, canPredict: false, predictionState: "waiting_for_previous_publish", predictionDeadlineAt: "2026-10-16T12:00:00.000Z" }
  ];
  await assertPredictionContract(worker, env, snapshots, id);
  await publish(env.database, "TEST1");
  await assertPredictionContract(worker, env, [
    { ...snapshots[0], canPredict: false, predictionState: "published" },
    { ...snapshots[1], canPredict: true, predictionState: "open" }
  ], id);
});

test("public prediction target selection reuses the list and performs one discovery per detail", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: CONTRACT_NOW });
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = createFixture();
  t.after(() => env.database.close());
  const queries = [];
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => { queries.push(sql); return prepare(sql); };
  const list = await request(worker, env, "/api/games?competitionId=apbc-2026");
  assert.equal(list.response.status, 200);
  assert.equal(queries.filter((sql) => /\bFROM games\b/.test(sql)).length, 1, "list discovery must reuse loaded games");
  queries.length = 0;
  const detail = await request(worker, env, `/api/games/${CONTRACT_IDS[0]}`);
  assert.equal(detail.response.status, 200);
  assert.equal(queries.filter((sql) => /\bFROM games\b/.test(sql)).length, 2, "one game lookup and one current-target discovery");
});

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

test("a Japan placement game becomes the next target without game-number branching", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: CONTRACT_NOW });
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = createFixture();
  t.after(() => env.database.close());
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
  await assertPredictionContract(worker, env, [
    ...CONTRACT_IDS.map((id, index) => ({
      id, predictionEligible: true, canPredict: false,
      predictionState: "published", predictionDeadlineAt: CONTRACT_DEADLINES[index]
    })),
    { id: "placement-final", predictionEligible: true, canPredict: true, predictionState: "open", predictionDeadlineAt: "2026-11-15T02:00:00.000Z" }
  ]);
});

test("public derivation does not replace independent PUT/DELETE prediction guards", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: CONTRACT_NOW });
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = createFixture();
  t.after(() => env.database.close());
  const registration = await request(worker, env, "/api/auth/register", {
    method: "POST", body: JSON.stringify({ username: "guard-contract-user", password: "local-contract-password" })
  });
  assert.equal(registration.response.status, 201);
  const headers = { Cookie: registration.cookie.split(";")[0], Origin: "https://asia-cs.test", "Content-Type": "application/json" };
  for (const scenario of [
    { status: "draft", game: CONTRACT_IDS[0], code: "PREDICTION_NOT_OPEN" },
    { status: "completed", game: CONTRACT_IDS[0], code: "COMPETITION_COMPLETED" },
    { status: "active", game: CONTRACT_IDS[1], code: "PREDICTION_NOT_OPEN" },
    { status: "active", game: CONTRACT_IDS[0], expired: true, code: "PREDICTION_DEADLINE_PASSED" }
  ]) {
    env.database.prepare("UPDATE competitions SET status = ? WHERE id = 'apbc-2026'").run(scenario.status);
    if (scenario.expired) env.database.prepare("UPDATE games SET prediction_deadline_at = ? WHERE id = ?").run(new Date(CONTRACT_NOW).toISOString(), scenario.game);
    const before = env.database.prepare("SELECT total_changes() AS count").get().count;
    for (const method of ["PUT", "DELETE"]) {
      const result = await request(worker, env, `/api/games/${scenario.game}/prediction`, { method, headers, ...(method === "PUT" ? { body: JSON.stringify({ lineup: [] }) } : {}) });
      assert.equal(result.response.status, 409, `${method}: ${scenario.code}`);
      assert.equal(result.payload.code, scenario.code);
    }
    assert.equal(env.database.prepare("SELECT total_changes() AS count").get().count, before);
  }
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
