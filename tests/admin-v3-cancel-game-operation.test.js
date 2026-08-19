import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const renderer = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-game-progress.js"), "utf8");
const page = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
const constants = await import(pathToFileURL(path.join(root, "backend", "automation-v3", "constants.js")).href);

test("中止・対象外化は物理削除なしで理由・確認・監査・job停止を行う", () => {
  assert.match(worker, /V3_REASON_REQUIRED/);
  assert.match(worker, /V3_CONFIRMATION_REQUIRED/);
  assert.match(worker, /cancelOpenV3Jobs/);
  assert.match(worker, /recordV3AdminAudit/);
  assert.match(worker, /UPDATE games SET/);
  const scheduleUpdate = worker.slice(worker.indexOf("async function handleAdminGameScheduleUpdate"), worker.indexOf("function parseAdminScoringRoute"));
  assert.doesNotMatch(scheduleUpdate, /DELETE FROM games/);
  assert.match(worker, /UPDATE ranking_games SET game_status = \?1/);
});

test("公開済み試合はread-onlyで、後続V3 jobは対象外試合へ投入できない", () => {
  assert.match(worker, /V3_PUBLISHED_READ_ONLY/);
  assert.match(worker, /V3_GAME_UNAVAILABLE/);
  assert.match(worker, /cancelled.*service_unavailable/);
  assert.match(renderer, /中止・対象外 \/ 停止/);
});

test("正式処理済み試合の中止は強い確認を要求する", () => {
  assert.match(worker, /V3_STRONG_CONFIRMATION_REQUIRED/);
  assert.match(worker, /confirmationText.*中止/);
  assert.match(worker, /V3_RANKING_REVOCATION_CONFIRMATION_REQUIRED/);
  assert.match(worker, /rankingConfirmationText.*ランキング取消/);
  assert.match(renderer, /data-v3-schedule-confirmation-text/);
  assert.match(renderer, /data-v3-schedule-ranking-confirmation-text/);
});

test("ランキング対象外化はAPI単体でも確認必須で、公開済み試合はread-only", () => {
  const eligibilityHandler = worker.slice(worker.indexOf("async function handleAdminV3EligibilityUpdate"), worker.indexOf("async function handleAdminV3ScheduleGet"));
  assert.match(eligibilityHandler, /status === RANKING_ELIGIBILITY_STATUS\.EXCLUDED && input\?\.confirmed !== true/);
  assert.match(eligibilityHandler, /V3_PUBLISHED_READ_ONLY/);
  assert.match(renderer, /data-v3-ranking-exclusion-confirm/);
  assert.match(renderer, /data-v3-ranking-exclude/);
});

test("manual_action_requiredからexcludedへのV3遷移を許可する", () => {
  assert.equal(constants.getV3TransitionDefinition("manual_action_required", "excluded")?.triggeringJob, "admin");
});

test("公開UIは中止・サービス対象外を選択対象から除外しつつ明示表示できる", () => {
  assert.match(script, /service_unavailable/);
  assert.match(script, /この試合は中止になりました/);
  assert.match(script, /この試合はサービス対象外です/);
  assert.match(script, /editor\.classList\.toggle\("hidden", isScheduleGameUnavailable\(selectedGame\)\)/);
});

test("admin-v3のcache busterは中止操作版へ更新されている", () => {
  assert.match(page, /admin-v3-cancel-game-ranking-revoke-1/);
  assert.doesNotMatch(page, /admin-v3-add-game-preview-1/);
});
