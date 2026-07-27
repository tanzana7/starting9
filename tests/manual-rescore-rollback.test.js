import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = path.join(root, "auth-worker.js");
const workerUrl = pathToFileURL(workerPath).href;
const worker = fs.readFileSync(workerPath, "utf8");
const migration = fs.readFileSync(path.join(root, "migrations", "0015_manual_rescore.sql"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

test("再採点はgameId固定の管理者APIだけを持ち、日付だけでは実行できない", () => {
  for (const route of ["lineup-history", "lineup-revisions", "rescore-preview", "rescore-confirm", "restore-lineup-version", "rescore-history"]) {
    assert.match(worker, new RegExp(`\\b${route}\\b`));
  }
  assert.match(worker, /RESCORE_GAME_ID_MISMATCH/);
  assert.match(worker, /RESCORE_GAME_METADATA_MISMATCH/);
  assert.match(worker, /WHERE id = \?5 AND game_id = \?6/);
  assert.doesNotMatch(worker, /\/api\/admin\/rescore\?date=/);
});

test("7月18日の指定gameIdだけを更新条件にし、翌日や同日別試合を更新しない", () => {
  assert.match(worker, /WHERE id = \?5 AND game_id = \?6/);
  assert.match(worker, /DELETE FROM perfect_achievers WHERE game_id = \?1/);
  assert.match(worker, /WHERE game_id = \?6 AND scoring_status <> 'processing'/);
  assert.doesNotMatch(worker, /UPDATE predictions\s+SET[\s\S]{0,300}WHERE game_date =/);
});

test("正式スタメンはversion履歴として残り、修正版保存だけでは採点を更新しない", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS game_lineup_revisions/);
  assert.match(migration, /is_current INTEGER NOT NULL DEFAULT 0/);
  assert.match(migration, /idx_game_lineup_revisions_current/);
  assert.match(worker, /async function createManualLineupRevision/);
  assert.match(worker, /UPDATE game_lineup_revisions SET is_current = 0/);
  assert.match(worker, /async function handleAdminLineupRevision/);
  assert.doesNotMatch(worker.slice(worker.indexOf("async function handleAdminLineupRevision"), worker.indexOf("async function handleAdminLineupRestore")), /UPDATE predictions/);
});

test("再採点は期限付きプレビューとcurrent versionの再検証後だけ、対象gameIdの点数・満点者を置換する", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS game_rescore_previews/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS game_rescore_jobs/);
  assert.match(worker, /RESCORE_PREVIEW_EXPIRED/);
  assert.match(worker, /RESCORE_VERSION_CHANGED/);
  assert.match(worker, /expected_prediction_count/);
  assert.match(worker, /DELETE FROM perfect_achievers WHERE game_id = \?1/);
  assert.match(worker, /UPDATE predictions[\s\S]*WHERE id = \?5 AND game_id = \?6/);
  assert.match(worker, /const results = await db\.batch\(statements\)/);
  assert.match(worker, /status = 'completed'/);
  assert.match(worker, /async function isManualRescoreLocked/);
  assert.match(worker, /revision_fingerprint !== row\.active_fingerprint/);
  assert.match(worker, /if \(await isManualRescoreLocked\(env\.AUTH_DB, row\.game_id\)\)/);
  assert.match(worker, /if \(await isManualRescoreLocked\(env\.AUTH_DB, timeline\.gameId\)\)/);
});

test("再採点可能期限は試合日のJST終了から7日間で、予測データは既存保持を短縮しない", async () => {
  const { getManualRescoreExpiresAt } = await import(workerUrl);
  assert.equal(getManualRescoreExpiresAt("2026-07-18").toISOString(), "2026-07-25T14:59:59.999Z");
  assert.match(worker, /MANUAL_RESCORE_RETENTION_DAYS = 7/);
  assert.doesNotMatch(worker, /DELETE FROM predictions WHERE game_date/);
});

test("管理画面は選択中gameId、version、理由、プレビュー、確定、復元を同一パネルで扱う", () => {
  for (const id of ["adminManualRescorePanel", "manualRescoreReason", "saveLineupRevisionButton", "previewManualRescoreButton", "confirmManualRescoreButton", "restorePreviousLineupButton"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(script, /function getManualRescoreMetadata/);
  assert.match(script, /state\.manualRescore\.gameId = requestGameId/);
  assert.match(script, /他の日の試合は変更されません/);
  assert.match(script, /refreshManualRescorePanel\(\{ force: true \}\)/);
});
