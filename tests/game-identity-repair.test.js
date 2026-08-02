import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildGameIdentityRepairPreview, isNonGameScope } from "../game-identity-repair.js";

const schedule = {
  game_id: "2026-08-01-fighters-marines-1400",
  game_date: "2026-08-01",
  start_at: "2026-08-01T05:00:00.000Z",
  home_team: "fighters",
  away_team: "marines",
  game_code: "f-m-15",
  source_game_key: "npb-2026-08-01-f-m-15"
};

function game(internal_game_id, overrides = {}) {
  return {
    internal_game_id,
    game_date: schedule.game_date,
    start_time: schedule.start_at,
    home_team: schedule.home_team,
    away_team: schedule.away_team,
    game_status: "scheduled",
    ...overrides
  };
}

test("一意な日程と既存gamesの一致はSAFE_AUTO_LINKとして安定した計画になる", async () => {
  const input = { scheduleRows: [schedule], games: [game("11111111-1111-4111-8111-111111111111")], now: new Date("2026-08-01T00:00:00.000Z") };
  const first = await buildGameIdentityRepairPreview(input);
  const second = await buildGameIdentityRepairPreview(input);
  assert.equal(first.safeAutoLinks.length, 1);
  assert.equal(first.safeAutoLinks[0].classification, "SAFE_AUTO_LINK");
  assert.equal(first.safeAutoLinks[0].repairId, second.safeAutoLinks[0].repairId);
  assert.equal(first.safeAutoLinks[0].planHash, second.safeAutoLinks[0].planHash);
  assert.equal(first.safeAutoLinks[0].targetInternalGameId, "11111111-1111-4111-8111-111111111111");
  const changed = await buildGameIdentityRepairPreview({
    ...input,
    games: [game("11111111-1111-4111-8111-111111111111", { game_status: "cancelled" })]
  });
  assert.notEqual(first.safeAutoLinks[0].planHash, changed.safeAutoLinks[0].planHash);
});

test("一意な未登録日程だけをSAFE_CREATE_INTERNAL_GAMEに分類し、dry-runではUUIDを作らない", async () => {
  const preview = await buildGameIdentityRepairPreview({ scheduleRows: [schedule], games: [], now: new Date("2026-08-01T00:00:00.000Z") });
  assert.equal(preview.safeInternalGameCreations.length, 1);
  assert.equal(preview.safeInternalGameCreations[0].targetInternalGameId, "");
  assert.equal(preview.safeInternalGameCreations[0].createInternalGame, true);
  assert.equal(preview.summary.projectedCoverage, 1);
});

test("doubleheader、開始時刻またはNPBコードの矛盾はMANUAL_REVIEWに残す", async () => {
  const doubleheader = await buildGameIdentityRepairPreview({
    scheduleRows: [schedule],
    games: [game("11111111-1111-4111-8111-111111111111"), game("22222222-2222-4222-8222-222222222222")]
  });
  assert.equal(doubleheader.manualReviewItems[0].classification, "MANUAL_REVIEW");
  assert.ok(doubleheader.manualReviewItems[0].reasonCodes.includes("DOUBLEHEADER_RISK"));

  const codeConflict = await buildGameIdentityRepairPreview({
    scheduleRows: [schedule],
    games: [game("11111111-1111-4111-8111-111111111111", { game_code: "f-m-99" })]
  });
  assert.ok(codeConflict.manualReviewItems[0].reasonCodes.includes("GAME_CODE_CONFLICT"));

  const startMismatch = await buildGameIdentityRepairPreview({
    scheduleRows: [schedule],
    games: [game("11111111-1111-4111-8111-111111111111", { start_time: "2026-08-01T06:00:00.000Z" })]
  });
  assert.ok(startMismatch.manualReviewItems[0].reasonCodes.includes("START_TIME_MISMATCH"));

  const teamMismatch = await buildGameIdentityRepairPreview({
    scheduleRows: [schedule],
    games: [game("11111111-1111-4111-8111-111111111111", { home_team: "marines", away_team: "fighters" })]
  });
  assert.ok(teamMismatch.manualReviewItems[0].reasonCodes.includes("TEAM_MISMATCH"));
});

test("非試合scopeは修復候補にせず、予想内容や個人情報を計画へ含めない", async () => {
  const preview = await buildGameIdentityRepairPreview({
    tableRows: { game_workflow_logs: [{ game_id: "day-2026-08-01", row_count: 2, first_seen_at: "x", last_seen_at: "y", user_id: "hidden", prediction_json: "hidden" }] }
  });
  assert.equal(isNonGameScope("day-2026-08-01"), true);
  assert.equal(preview.ignoredNonGameScopes.length, 1);
  assert.equal(JSON.stringify(preview).includes("user_id"), false);
  assert.equal(JSON.stringify(preview).includes("prediction_json"), false);
});

test("修復APIは管理者専用で、previewは読み取り専用、実行とrollbackは明示POSTだけを受ける", async () => {
  const source = await readFile(new URL("../auth-worker.js", import.meta.url), "utf8");
  assert.match(source, /path === "\/api\/admin\/audit\/game-identity-repairs" && request\.method === "GET"/);
  assert.match(source, /path === "\/api\/admin\/game-identities\/repairs" && request\.method === "POST"/);
  assert.match(source, /parseGameIdentityRepairRollbackRoute/);
  const previewStart = source.indexOf("async function handleAdminGameIdentityRepairPreview");
  const previewEnd = source.indexOf("function normalizeRepairRequest", previewStart);
  const previewSource = source.slice(previewStart, previewEnd);
  assert.match(previewSource, /requireAdminUser\(request, env, cors\)/);
  assert.doesNotMatch(previewSource, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i);
});

test("修復migrationは履歴だけを追加し、適用時に既存データを修復しない", async () => {
  const migration = await readFile(new URL("../migrations/0026_game_identity_repairs.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS game_identity_repair_plans/);
  assert.match(migration, /rollback_json TEXT NULL/);
  assert.doesNotMatch(migration, /\b(?:UPDATE|DELETE|INSERT INTO games|ALTER TABLE)\b/i);
});
