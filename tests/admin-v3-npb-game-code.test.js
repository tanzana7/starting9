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

test("V3のNPBコード更新APIはinternalGameIdのPATCHへ登録される", () => {
  assert.match(worker, /parseAdminV3NpbGameCodeRoute/);
  assert.match(worker, /request\.method === "PATCH"/);
  assert.match(worker, /npb-game-code\$\/\.exec/);
  assert.match(worker, /handleAdminV3NpbGameCodeUpdate\(request, env, cors/);
});

test("NPBコード更新は既存管理者認証とgames.npb_game_codeを使用する", () => {
  const handler = worker.slice(worker.indexOf("async function handleAdminV3NpbGameCodeUpdate"), worker.indexOf("async function handleAdminV3JobCreate"));
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
  const handler = worker.slice(worker.indexOf("async function handleAdminV3NpbGameCodeUpdate"), worker.indexOf("async function handleAdminV3JobCreate"));
  assert.match(handler, /input\.npbGameCode\.trim\(\)/);
  assert.match(handler, /rawCode && !nextCode/);
  assert.match(handler, /nextCode \|\| null/);
  assert.match(handler, /NPB_GAME_CODE_INVALID/);
});

test("更新は旧値・新値・管理者・時刻を既存V3監査へ記録する", () => {
  const handler = worker.slice(worker.indexOf("async function handleAdminV3NpbGameCodeUpdate"), worker.indexOf("async function handleAdminV3JobCreate"));
  assert.match(handler, /previous_npb_game_code/);
  assert.match(handler, /next_npb_game_code/);
  assert.match(handler, /updated_by/);
  assert.match(handler, /admin_npb_game_code_update/);
  assert.match(handler, /env\.AUTH_DB\.batch\(\[/);
});

test("V3管理画面は現在値・入力欄・保存操作を持ち、更新後に再取得する", () => {
  assert.match(client, /data-v3-npb-code/);
  assert.match(client, /data-v3-code-save/);
  assert.match(client, /method: "PATCH"/);
  assert.match(client, /npb-game-code/);
  assert.match(client, /await loadV3\(\)/);
  assert.match(page, /admin-v3\.css\?v=automation-v3-2/);
  assert.match(page, /admin-v3\.js\?v=automation-v3-2/);
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

test("lineup fetchは保存済みgames.npb_game_codeをV3 targetへ渡す", () => {
  const executor = worker.slice(worker.indexOf("async function executeGameAutomationV3Job"), worker.indexOf("export async function runScheduledGameAutomation"));
  const targetLoader = worker.slice(worker.indexOf("async function loadV3GameTarget"), worker.indexOf("async function executeGameAutomationV3Job"));
  assert.match(targetLoader, /gameCode: row\.npb_game_code \|\| ""/);
  assert.doesNotMatch(targetLoader, /gameCode: row\.npb_game_code \|\| identifiers/);
  assert.match(executor, /gameCode: target\.gameCode/);
  assert.match(executor, /NPB_GAME_CODE_UNAVAILABLE/);
});
