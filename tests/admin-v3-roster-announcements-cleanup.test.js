import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
const roster = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-roster.js"), "utf8");
const gameProgress = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-game-progress.js"), "utf8");
const page = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");

test("admin-v3はロースターを公示ベースで読み取り表示し、未実行と失敗を区別する", () => {
  assert.match(client, /公式公示の取得予定/);
  assert.match(client, /公式公示を確認しました。変更はありません。/);
  assert.match(roster, /registeredPlayersHome/);
  assert.match(worker, /ROSTER_SOURCE_DATE_MISMATCH/);
  assert.match(worker, /ROSTER_TEAM_MISMATCH/);
  assert.match(worker, /getV3RosterPlanningDiagnostics/);
});

test("admin-v3は旧直接編集操作を外し、V3正式jobの安全な再実行だけを表示する", () => {
  assert.doesNotMatch(page, /data-v3-view="emergency"/);
  for (const selector of [
    "data-v3-identity-resolve", "data-v3-orientation-save", "data-v3-code-save",
    "data-v3-save-lineup", "data-v3-finalize-lineup", "data-v3-scoring-preview",
    "data-v3-scoring-confirm", "data-v3-ranking-rebuild", "data-v3-publish",
    "data-v3-republish", "data-v3-schedule-save", "data-v3-eligibility-save",
    "data-v3-job-retry", "data-v3-job-cancel"
  ]) assert.doesNotMatch(client, new RegExp(selector));
  assert.match(gameProgress, /job履歴/);
  assert.match(gameProgress, /V3工程の診断・手動再実行/);
  assert.match(gameProgress, /data-v3-job-run/);
});

test("admin-v3のJavaScriptキャッシュバスターは公示整理版へ更新される", () => {
  assert.match(page, /admin-v3\.js\?v=admin-v3-v3-schedule-operations-1/);
  assert.match(page, /admin-v3\.css\?v=admin-v3-v3-schedule-operations-1/);
});
