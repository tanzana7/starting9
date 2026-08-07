const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");

const root = path.join(__dirname, "..");
const migration = fs.readFileSync(path.join(root, "migrations", "0006_user_achievements.sql"), "utf8");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

test("実績migrationはマスタ、ユーザー付与、重複防止、初期実績を定義する", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS achievements/);
  assert.match(migration, /code TEXT NOT NULL UNIQUE/);
  assert.match(migration, /rarity IN \('common', 'rare', 'epic', 'limited'\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS user_achievements/);
  assert.match(migration, /UNIQUE \(user_id, achievement_id\)/);
  assert.match(migration, /source IN \('system', 'admin', 'development', 'migration'\)/);
  for (const code of ["beta_predictor", "first_prediction", "perfect_prediction"]) {
    assert.ok(migration.includes(code), `${code} が初期実績として見つかりません`);
  }
});

test("実績migrationはメモリSQLiteで初期実績とユーザー別重複防止を適用できる", () => {
  const db = new DatabaseSync(":memory:");
  for (const file of ["0001_auth.sql", "0004_admin_role.sql", "0006_user_achievements.sql"]) {
    db.exec(fs.readFileSync(path.join(root, "migrations", file), "utf8"));
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM achievements").get().count, 3);
  db.prepare(
    `INSERT INTO users
       (id, username, username_normalized, password_hash, password_salt, password_iterations, created_at, updated_at, status, role)
     VALUES ('test-user', 'tester', 'tester', 'hash', 'salt', 100000, '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z', 'active', 'user')`
  ).run();
  const achievement = db.prepare("SELECT id FROM achievements WHERE code = 'beta_predictor'").get();
  const statement = db.prepare(
    `INSERT INTO user_achievements (id, user_id, achievement_id, earned_at, source, created_at)
     VALUES (?1, 'test-user', ?2, '2026-07-20T00:00:00.000Z', 'development', '2026-07-20T00:00:00.000Z')`
  );
  statement.run("earned-1", achievement.id);
  assert.throws(() => statement.run("earned-2", achievement.id));
});

test("実績APIは本人の取得と管理者テスト用の本人付与・削除を分離する", () => {
  assert.match(worker, /\/api\/me\/achievements/);
  assert.match(worker, /requireAuthenticatedUser\(request, env, cors\)/);
  assert.match(worker, /if \(request\.method !== "GET"\) return legacyAdminOperationRetiredResponse\(cors\)/);
  assert.match(worker, /async function handleAdminTestRoute[\s\S]*?await requireAdminUser\(request, env, cors\)/);
  assert.match(worker, /INSERT OR IGNORE INTO user_achievements/);
  assert.match(worker, /source = 'development'/);
  assert.match(worker, /user_id = \?1/);
});

test("通常画面と管理画面内テストに実績の表示・検証導線を持つ", () => {
  assert.match(html, /id="achievementsPanel"/);
  assert.match(html, /id="achievementsList"/);
  assert.match(html, /id="adminTestAchievements"/);
  assert.match(script, /function fetchUserAchievements/);
  assert.match(script, /function refreshAdminTestAchievements/);
  assert.match(script, /function grantAdminTestAchievement/);
  assert.match(script, /function removeAdminTestAchievement/);
  assert.match(script, /const hasAchievements = state\.achievements\.items\.length > 0/);
  assert.match(script, /panel\.classList\.toggle\("hidden", !user \|\| !hasAchievements\)/);
  assert.doesNotMatch(script, /取得済み実績はありません/);
});
