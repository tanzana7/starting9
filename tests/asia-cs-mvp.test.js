import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = fs.readFileSync(path.join(root, "asia-cs/migrations/0001_asia_cs_mvp.sql"), "utf8");

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

function createDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(migration);
  return { database, DB: createD1Adapter(database) };
}

async function request(worker, env, path, options = {}) {
  const response = await worker.default.fetch(new Request(`https://asia-cs.test${path}`, options), env, {});
  const payload = await response.json();
  return { response, payload, cookie: response.headers.get("set-cookie") || "" };
}

function authCookie(response) {
  return response.cookie.split(";")[0];
}

const players = Array.from({ length: 9 }, (_, index) => ({
  id: `p${index + 1}`,
  name: `Player ${index + 1}`,
  uniformNumber: String(index + 1),
  team: "ASIA"
}));
const lineup = players.map((player, index) => ({
  battingOrder: index + 1,
  playerId: player.id,
  playerName: player.name,
  position: ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"][index]
}));

test("Asia CS MVP: 予想→締切→正式登録→採点→B9→正式修正→再採点→B9更新", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const fixture = createDatabase();
  const env = { ...fixture, ADMIN_USERNAMES: "admin", ALLOWED_ORIGIN: "https://asia-cs.test" };
  const adminRegistration = await request(worker, env, "/api/auth/register", { method: "POST", body: JSON.stringify({ username: "admin", password: "admin-password" }) });
  assert.equal(adminRegistration.response.status, 201);
  const adminCookie = authCookie(adminRegistration);
  const fanRegistration = await request(worker, env, "/api/auth/register", { method: "POST", body: JSON.stringify({ username: "fan", password: "fan-password" }) });
  assert.equal(fanRegistration.response.status, 201);
  const fanCookie = authCookie(fanRegistration);

  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const created = await request(worker, env, "/api/admin/games", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ id: "asia-cs-demo", title: "Asia CS Final", gameDate: "2026-09-22", startAt: future, predictionDeadlineAt: future }) });
  assert.equal(created.response.status, 201);
  const roster = await request(worker, env, "/api/admin/games/asia-cs-demo/players", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ players }) });
  assert.equal(roster.response.status, 200);

  const saved = await request(worker, env, "/api/games/asia-cs-demo/prediction", { method: "PUT", headers: { Cookie: fanCookie }, body: JSON.stringify({ lineup }) });
  assert.equal(saved.response.status, 200);

  const closedAt = new Date(Date.now() - 1_000).toISOString();
  const submittedBeforeDeadline = new Date(Date.now() - 2_000).toISOString();
  fixture.database.prepare("UPDATE games SET prediction_deadline_at = ? WHERE id = ?").run(closedAt, "asia-cs-demo");
  fixture.database.prepare("UPDATE predictions SET submitted_at = ? WHERE game_id = ?").run(submittedBeforeDeadline, "asia-cs-demo");
  const rejectedAfterDeadline = await request(worker, env, "/api/games/asia-cs-demo/prediction", { method: "PUT", headers: { Cookie: fanCookie }, body: JSON.stringify({ lineup }) });
  assert.equal(rejectedAfterDeadline.response.status, 409);
  assert.equal(rejectedAfterDeadline.payload.code, "PREDICTION_DEADLINE_PASSED");

  const confirmed = await request(worker, env, "/api/admin/games/asia-cs-demo/lineup", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ lineup }) });
  assert.equal(confirmed.response.status, 200);
  const scored = await request(worker, env, "/api/admin/games/asia-cs-demo/score", { method: "POST", headers: { Cookie: adminCookie } });
  assert.equal(scored.response.status, 200);
  assert.equal(scored.payload.scored, 1);
  assert.equal(scored.payload.scoreChangedCount, 1);
  const published = await request(worker, env, "/api/admin/games/asia-cs-demo/publish", { method: "POST", headers: { Cookie: adminCookie } });
  assert.equal(published.response.status, 200);

  const bestNine = await request(worker, env, "/api/games/asia-cs-demo/best-nine");
  assert.equal(bestNine.payload.published, true);
  assert.deepEqual(bestNine.payload.bestNine.map((row) => [row.rank, row.username, row.score]), [[1, "fan", 100]]);

  const corrected = lineup.map((item) => ({ ...item }));
  [corrected[6].position, corrected[7].position] = [corrected[7].position, corrected[6].position];
  const rescored = await request(worker, env, "/api/admin/games/asia-cs-demo/rescore", { method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ lineup: corrected, reason: "試合前の正式スタメン訂正" }) });
  assert.equal(rescored.response.status, 200);
  assert.equal(rescored.payload.revision, 2);
  assert.equal(rescored.payload.published, true);
  assert.equal(rescored.payload.scoreChangedCount, 1);

  const updatedBestNine = await request(worker, env, "/api/games/asia-cs-demo/best-nine");
  assert.deepEqual(updatedBestNine.payload.bestNine.map((row) => [row.rank, row.username, row.score]), [[1, "fan", 94]]);
  const predictionRow = fixture.database.prepare("SELECT score, scored_revision, actual_lineup_json FROM predictions WHERE game_id = 'asia-cs-demo'").get();
  assert.equal(predictionRow.score, 94);
  assert.equal(predictionRow.scored_revision, 2);
  assert.deepEqual(JSON.parse(predictionRow.actual_lineup_json), corrected);
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM lineup_revisions WHERE game_id = 'asia-cs-demo' AND is_current = 1").get().count, 1);
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM scoring_runs WHERE game_id = 'asia-cs-demo' AND revision_number = 2").get().count, 1);
});

test("Asia CS Best Nineは未公開では返さず、得点・提出時刻・username・user_id順を固定する", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const fixture = createDatabase();
  const env = { ...fixture, ADMIN_USERNAMES: "admin" };
  const admin = await request(worker, env, "/api/auth/register", { method: "POST", body: JSON.stringify({ username: "admin", password: "admin-password" }) });
  const game = await request(worker, env, "/api/admin/games", { method: "POST", headers: { Cookie: authCookie(admin) }, body: JSON.stringify({ id: "b9-test", title: "B9", gameDate: "2026-09-22", startAt: "2026-09-22T00:00:00.000Z", predictionDeadlineAt: "2026-09-21T00:00:00.000Z" }) });
  assert.equal(game.response.status, 201);
  const hidden = await request(worker, env, "/api/games/b9-test/best-nine");
  assert.deepEqual(hidden.payload, { ok: true, published: false, bestNine: [], totalCount: 0 });
});
