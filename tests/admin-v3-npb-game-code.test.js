import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const page = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
const client = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
const migration = fs.readFileSync(path.join(root, "migrations", "0030_game_automation_v3_npb_code_audit.sql"), "utf8");
const identityMigration = fs.readFileSync(path.join(root, "migrations", "0031_game_npb_identity_registry.sql"), "utf8");

test("V3のNPBコード更新APIはinternalGameIdのPATCHへ登録される", () => {
  assert.match(worker, /parseAdminV3NpbGameCodeRoute/);
  assert.match(worker, /request\.method === "PATCH"/);
  assert.match(worker, /npb-game-code\$\/\.exec/);
  assert.match(worker, /handleAdminV3NpbGameCodeUpdate\(request, env, cors/);
  assert.match(worker, /parseAdminV3IdentityResolveRoute/);
  assert.match(worker, /handleAdminV3IdentityResolve\(request, env, cors/);
  assert.match(worker, /parseAdminV3OrientationRoute/);
  assert.match(worker, /handleAdminV3OrientationUpdate\(request, env, cors/);
});

test("NPBコード更新は既存管理者認証とgames.npb_game_codeを使用する", () => {
  const handler = worker.slice(worker.indexOf("async function handleAdminV3NpbGameCodeUpdate"), worker.indexOf("async function getV3OrientationImpact"));
  assert.match(handler, /requireAdminUser\(request, env, cors\)/);
  assert.match(handler, /normalizeV3InternalGameId\(internalGameId\)/);
  assert.match(handler, /UPDATE games SET/);
  assert.match(handler, /npb_game_code = \?1/);
  assert.match(handler, /WHERE internal_game_id = \?\d+/);
  assert.doesNotMatch(handler, /legacyGameId|sourceGameKey/);
  assert.match(handler, /if \(!access\.ok\) return access\.response/);
  assert.match(handler, /V3_GAME_NOT_REGISTERED/);
  assert.match(handler, /}, 404, cors/);
  assert.match(handler, /NPB_GAME_CODE_INVALID/);
  assert.match(handler, /}, 400, cors/);
});

test("NPBコード入力はtrim・解除・形式検証を行う", () => {
  const handler = worker.slice(worker.indexOf("async function handleAdminV3NpbGameCodeUpdate"), worker.indexOf("async function getV3OrientationImpact"));
  assert.match(handler, /input\.npbGameCode\.trim\(\)/);
  assert.match(handler, /rawCode && !nextCode/);
  assert.match(handler, /nextCode \|\| null/);
  assert.match(handler, /NPB_GAME_CODE_INVALID/);
});

test("更新は旧値・新値・管理者・時刻を既存V3監査へ記録する", () => {
  const handler = worker.slice(worker.indexOf("async function handleAdminV3NpbGameCodeUpdate"), worker.indexOf("async function getV3OrientationImpact"));
  assert.match(handler, /previous_npb_game_code/);
  assert.match(handler, /next_npb_game_code/);
  assert.match(handler, /updated_by/);
  assert.match(handler, /admin_npb_game_code_update/);
  assert.match(handler, /npb_identity_status/);
  assert.match(handler, /manually_overridden/);
  assert.match(handler, /buildNpbGameUrl/);
  assert.match(handler, /env\.AUTH_DB\.batch\(\[/);
});

test("V3管理画面は現在値・入力欄・保存操作を持ち、更新後に再取得する", () => {
  assert.match(client, /data-v3-npb-code/);
  assert.match(client, /data-v3-code-save/);
  assert.match(client, /method: "PATCH"/);
  assert.match(client, /npb-game-code/);
  assert.match(client, /非常用手動上書き/);
  assert.match(client, /data-v3-identity-resolve/);
  assert.match(client, /npb-identity\/resolve/);
  assert.match(client, /data-v3-orientation-save/);
  assert.match(client, /\/orientation/);
  assert.match(client, /DB home/);
  assert.match(client, /DB away/);
  assert.ok(client.includes("${escapeV3(game.homeTeam)} vs ${escapeV3(game.awayTeam)}"));
  assert.match(client, /await loadV3\(\)/);
  assert.match(page, /admin-v3\.css\?v=automation-v3-7-phase1-cron-diagnostics/);
  assert.match(page, /admin-v3\.js\?v=automation-v3-7-phase1-cron-diagnostics/);
});

test("home/away修正APIはinternalGameId単位で関連データの影響を警告する", () => {
  const handler = worker.slice(worker.indexOf("async function handleAdminV3OrientationUpdate"), worker.indexOf("async function handleAdminV3JobCreate"));
  assert.match(handler, /requireAdminUser\(request, env, cors\)/);
  assert.match(handler, /normalizeV3InternalGameId\(internalGameId\)/);
  assert.match(handler, /UPDATE games SET/);
  assert.match(handler, /home_team = \?1/);
  assert.match(handler, /away_team = \?2/);
  assert.match(handler, /internal_game_id = \?1/);
  assert.match(handler, /getV3OrientationImpact/);
  assert.match(handler, /admin_game_orientation_changed/);
  assert.match(handler, /previousHomeTeam/);
  assert.match(handler, /nextAwayTeam/);
  assert.match(handler, /V3_ORIENTATION_REASON_REQUIRED/);
});

test("identity resolverはgamesのhome/awayを正とし、自動反転しない", () => {
  const handler = worker.slice(worker.indexOf("async function handleAdminV3IdentityResolve"), worker.indexOf("async function handleAdminV3NpbGameCodeUpdate"));
  assert.match(handler, /normalizeScheduleTeamCode\(current\.home_team\)/);
  assert.match(handler, /normalizeScheduleTeamCode\(current\.away_team\)/);
  assert.doesNotMatch(handler, /UPDATE games SET[\s\S]*home_team/);
});

test("V3監査のNPBコード変更列は追加migrationで定義される", () => {
  assert.match(migration, /ALTER TABLE game_automation_v3_audit ADD COLUMN event_type/);
  assert.match(migration, /previous_npb_game_code/);
  assert.match(migration, /next_npb_game_code/);
  assert.match(migration, /updated_by/);
  assert.doesNotMatch(migration, /INSERT|UPDATE|DELETE/);
});

test("0030は0029適用済みのSQLite fixtureへ追加適用できる", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`CREATE TABLE game_automation_v3_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      internal_game_id TEXT NOT NULL,
      job_type TEXT NOT NULL,
      scheduled_slot_at TEXT NULL,
      claim_id TEXT NULL,
      state_before TEXT NULL,
      state_after TEXT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      failure_code TEXT NULL,
      failure_message TEXT NULL,
      duration_ms INTEGER NULL,
      occurred_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'cron'
    )`);
    database.exec(migration);
    const columns = database.prepare("PRAGMA table_info(game_automation_v3_audit)").all().map((row) => row.name);
    assert.ok(columns.includes("event_type"));
    assert.ok(columns.includes("previous_npb_game_code"));
    assert.ok(columns.includes("next_npb_game_code"));
    assert.ok(columns.includes("updated_by"));
  } finally {
    database.close();
  }
});

test("0031は既存NPBコードを保持し、識別情報列を追加する", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`CREATE TABLE games (
      internal_game_id TEXT PRIMARY KEY NOT NULL,
      game_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      npb_game_code TEXT NULL
    );
    CREATE TABLE game_automation_v3_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      internal_game_id TEXT NOT NULL,
      job_type TEXT NOT NULL,
      event_type TEXT NOT NULL DEFAULT 'job',
      previous_npb_game_code TEXT NULL,
      next_npb_game_code TEXT NULL,
      updated_by TEXT NULL,
      occurred_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'cron'
    );
    INSERT INTO games VALUES ('g1', '2026-08-04', '2026-08-04T09:00:00.000Z', 'hawks', 'fighters', 'h-f-15');`);
    database.exec(identityMigration);
    assert.equal(database.prepare("SELECT npb_game_code FROM games WHERE internal_game_id = 'g1'").get().npb_game_code, "h-f-15");
    const columns = database.prepare("PRAGMA table_info(games)").all().map((row) => row.name);
    assert.ok(columns.includes("npb_game_url"));
    assert.ok(columns.includes("npb_identity_status"));
    assert.equal(database.prepare("SELECT npb_identity_status FROM games WHERE internal_game_id = 'g1'").get().npb_identity_status, "unresolved");
  } finally {
    database.close();
  }
});

test("lineup fetchは保存済みgames.npb_game_codeをV3 targetへ渡す", () => {
  const executor = worker.slice(worker.indexOf("async function executeGameAutomationV3Job"), worker.indexOf("export async function runScheduledGameAutomation"));
  const targetLoader = worker.slice(worker.indexOf("async function loadV3GameTarget"), worker.indexOf("async function executeGameAutomationV3Job"));
  assert.match(targetLoader, /gameCode: row\.npb_game_code \|\| ""/);
  assert.doesNotMatch(targetLoader, /gameCode: row\.npb_game_code \|\| identifiers/);
  assert.match(executor, /gameCode: target\.gameCode/);
  assert.match(targetLoader, /npbGameUrl: row\.npb_game_url/);
  assert.match(executor, /identityOverride: lineupIdentity/);
  assert.match(executor, /NPB_IDENTITY_UNRESOLVED/);
});
