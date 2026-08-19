import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const renderer = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-game-progress.js"), "utf8");
const admin = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
const rankingRepository = fs.readFileSync(path.join(root, "backend", "repositories", "ranking-repository.js"), "utf8");

test("ランキング反映済みの中止はreflection履歴を確認し、二重の確認文字列を要求する", () => {
  assert.match(worker, /getV3RankingReflectionAudit/);
  assert.match(worker, /V3_RANKING_REFLECTION_STATE_UNAVAILABLE/);
  assert.match(worker, /V3_RANKING_REVOCATION_CONFIRMATION_REQUIRED/);
  assert.match(worker, /rankingConfirmationText.*ランキング取消/);
  assert.match(renderer, /data-v3-schedule-ranking-confirmation-text/);
  assert.match(admin, /rankingConfirmationText/);
});

test("ランキング取消は物理削除ではなくeligible filterとreflectionの監査で扱う", () => {
  assert.match(worker, /reflectionStatus = "excluded"/);
  assert.match(worker, /const nextReflectionStatus = reflectionStatus === "revoked" \? "revoked" : "excluded"/);
  assert.match(worker, /ranking_reflection_revoked/);
  assert.match(worker, /sourceOfTruth: "ranking_games_eligibility_filter"/);
  const scheduleHandler = worker.slice(worker.indexOf("async function handleAdminV3ScheduleUpdate"), worker.indexOf("async function reschedulePendingV3Jobs"));
  assert.doesNotMatch(scheduleHandler, /DELETE\s+FROM\s+(games|ranking_games|predictions|perfect_achievers)/i);
});

test("ランキング取消後の再構築は取消済み記録を上書きしないno-opになる", () => {
  assert.match(worker, /noOpReason: "RANKING_REFLECTION_REVOKED_BY_ELIGIBILITY"/);
  assert.match(worker, /rankingRevocationRequired\s*\?\s*\{ created: false, noOp: true/);
  assert.match(worker, /rankingEligibilityStatus !== RANKING_ELIGIBILITY_STATUS\.ELIGIBLE/);
});

test("public ranking系はis_ranking_eligible=falseの試合を集計しない", () => {
  assert.match(rankingRepository, /is_ranking_eligible = 1/);
  assert.match(rankingRepository, /game_status = 'scored'/);
  assert.match(rankingRepository, /publication_status = 'published'/);
  assert.match(worker, /result\.affectedScopes = result\.hasReflectedRevision \? \[\.\.\.RANKING_REFLECTION_SCOPES\]/);
  assert.match(worker, /"daily-best-nine"/);
});

test("admin-v3はランキングreflectionの状態と取消対象scopeを表示する", () => {
  assert.match(worker, /rankingRevocationConfirmationRequired/);
  assert.match(worker, /affectedScopes/);
  assert.match(renderer, /ranking reflection/);
  assert.match(renderer, /ランキング・perfect・daily-best-nineから除外/);
});

test("published試合の変更禁止はランキング取消追加後も維持される", () => {
  const scheduleHandler = worker.slice(worker.indexOf("async function handleAdminV3ScheduleUpdate"), worker.indexOf("async function reschedulePendingV3Jobs"));
  assert.match(scheduleHandler, /currentState === "published"/);
  assert.match(scheduleHandler, /V3_SCHEDULE_CHANGE_TOO_LATE/);
});
