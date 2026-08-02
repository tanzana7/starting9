import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getGameIdentityRepairPreviewDateTo } from "../auth-worker.js";
import { buildGameIdentityRepairPreview, hashGameIdentityRepairPlan, isNonGameScope } from "../game-identity-repair.js";

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

test("修復dry-runの既定範囲は日程registryと同じ近未来を含む", () => {
  assert.equal(getGameIdentityRepairPreviewDateTo(new Date("2026-08-02T00:00:00.000Z")), "2026-08-05");
});

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

test("修復plan hashはgeneratedAt、履歴フィールド、配列取得順に依存しない", async () => {
  const material = {
    classification: "SAFE_CREATE_INTERNAL_GAME",
    scheduleGameId: schedule.game_id,
    scheduleIdentity: { gameDate: schedule.game_date, startTime: schedule.start_at, homeTeam: schedule.home_team, awayTeam: schedule.away_team },
    targetInternalGameId: "",
    targetGameStatus: "scheduled",
    createInternalGame: true,
    legacyGameIds: ["2026-08-01-f-m-15", schedule.game_id],
    identifiersToInsert: [
      { provider: "npb", identifierType: "npb_game_code", identifierValue: "f-m-15" },
      { provider: "starting9", identifierType: "legacy_descriptive_game_id", identifierValue: schedule.game_id }
    ],
    tableRowsToUpdate: [
      { table: "ranking_games", legacyGameId: "2026-08-01-f-m-15", expectedCount: 1 },
      { table: "predictions", legacyGameId: "2026-08-01-f-m-15", expectedCount: 2 }
    ],
    reasonCodes: ["UNIQUE_SCHEDULE_MATCH", "INTERNAL_GAME_CREATION_REQUIRED"],
    stateConflict: false
  };
  const reordered = {
    ...material,
    generatedAt: "2026-08-02T01:00:00.000Z",
    rollbackData: { failure: { stage: "history_complete", errorCode: "IGNORED" } },
    legacyGameIds: [...material.legacyGameIds].reverse(),
    identifiersToInsert: [...material.identifiersToInsert].reverse(),
    tableRowsToUpdate: [...material.tableRowsToUpdate].reverse()
  };
  assert.equal(await hashGameIdentityRepairPlan(material), await hashGameIdentityRepairPlan(reordered));
});

test("dry-runのplan hashは生成日時が変わっても同じDB状態なら一致する", async () => {
  const input = { scheduleRows: [schedule], games: [], tableRows: { predictions: [{ game_id: "2026-08-01-f-m-15", row_count: 1, unlinked_row_count: 1 }] } };
  const first = await buildGameIdentityRepairPreview({ ...input, now: new Date("2026-08-02T00:00:00.000Z") });
  const second = await buildGameIdentityRepairPreview({ ...input, now: new Date("2026-08-02T06:00:00.000Z") });
  assert.equal(first.safeInternalGameCreations[0].planHash, second.safeInternalGameCreations[0].planHash);
});

test("一意な未登録日程だけをSAFE_CREATE_INTERNAL_GAMEに分類し、dry-runではUUIDを作らない", async () => {
  const preview = await buildGameIdentityRepairPreview({ scheduleRows: [schedule], games: [], now: new Date("2026-08-01T00:00:00.000Z") });
  assert.equal(preview.safeInternalGameCreations.length, 1);
  assert.equal(preview.safeInternalGameCreations[0].targetInternalGameId, "");
  assert.equal(preview.safeInternalGameCreations[0].createInternalGame, true);
  assert.equal(preview.summary.projectedCoverage, 1);
});

test("一意に一致するcompact IDの関連行を同じSAFE_CREATE計画へ収束させる", async () => {
  const compactGameId = "2026-08-01-f-m-15";
  const input = {
    scheduleRows: [schedule],
    tableRows: {
      predictions: [{ game_id: compactGameId, row_count: 2, unlinked_row_count: 2 }],
      game_lineups: [{ game_id: compactGameId, row_count: 1, unlinked_row_count: 1 }],
      ranking_games: [{ game_id: compactGameId, row_count: 1, unlinked_row_count: 1 }],
      game_pregame_automation: [{ game_id: compactGameId, row_count: 1, unlinked_row_count: 1, start_at: schedule.start_at }]
    }
  };
  const preview = await buildGameIdentityRepairPreview(input);
  const repeatedPreview = await buildGameIdentityRepairPreview(input);
  const plan = preview.safeInternalGameCreations[0];
  assert.ok(plan.legacyGameIds.includes(schedule.game_id));
  assert.ok(plan.legacyGameIds.includes(compactGameId));
  assert.deepEqual(plan.identifiersToInsert.find((identifier) => identifier.identifierValue === compactGameId), {
    provider: "starting9", identifierType: "legacy_compact_game_id", identifierValue: compactGameId
  });
  assert.deepEqual(plan.tableRowsToUpdate.map((row) => `${row.table}:${row.legacyGameId}`).sort(), [
    `game_lineups:${compactGameId}`,
    `game_pregame_automation:${compactGameId}`,
    `predictions:${compactGameId}`,
    `ranking_games:${compactGameId}`
  ]);
  assert.equal(preview.summary.projectedScheduleLegacyIdsWithoutInternalGameId, 0);
  assert.equal(preview.summary.projectedAllTableLegacyIdsWithoutInternalGameId, 0);
  assert.equal(preview.summary.projectedCompactIdsWithoutInternalGameId, 0);
  assert.equal(preview.obsoleteOrphans.some((item) => item.gameId === compactGameId), false);
  assert.equal(preview.classificationIntegrity.valid, true);
  assert.deepEqual(preview.classificationIntegrity.repairPlanAndObsolete, []);
  assert.equal(plan.repairId, repeatedPreview.safeInternalGameCreations[0].repairId);
  assert.equal(plan.planHash, repeatedPreview.safeInternalGameCreations[0].planHash);
});

test("reverse home/awayのcompact IDはSAFE計画へ入れずMANUAL_REVIEWに残す", async () => {
  const compactGameId = "2026-07-23-l-f-17";
  const reverseSchedule = {
    ...schedule,
    game_id: "2026-07-23-fighters-lions-1800",
    game_date: "2026-07-23",
    start_at: "2026-07-23T09:00:00.000Z",
    home_team: "fighters",
    away_team: "lions",
    game_code: "f-l-17"
  };
  const preview = await buildGameIdentityRepairPreview({
    scheduleRows: [reverseSchedule],
    tableRows: { predictions: [{ game_id: compactGameId, row_count: 1, unlinked_row_count: 1 }] }
  });
  assert.equal(preview.safeInternalGameCreations[0].legacyGameIds.includes(compactGameId), false);
  assert.ok(preview.manualReviewItems.some((item) => item.compactGameId === compactGameId
    && item.reasonCodes.includes("REVERSE_HOME_AWAY_RISK")));
  assert.equal(preview.obsoleteOrphans.some((item) => item.gameId === compactGameId), false);
  assert.equal(preview.classificationIntegrity.valid, true);
  assert.equal(preview.summary.projectedCompactIdsWithoutInternalGameId, 1);
});

test("指定されたcompact IDは一意の同日同一カードだけに安全に関連付ける", async () => {
  const cases = [
    ["2026-07-31-f-m-14", "2026-07-31-fighters-marines-1800", "2026-07-31", "fighters", "marines", "f-m-14", "2026-07-31T09:00:00.000Z"],
    ["2026-08-01-f-m-15", "2026-08-01-fighters-marines-1400", "2026-08-01", "fighters", "marines", "f-m-15", "2026-08-01T05:00:00.000Z"],
    ["2026-07-25-f-e-15", "2026-07-25-fighters-eagles-1400", "2026-07-25", "fighters", "eagles", "f-e-15", "2026-07-25T05:00:00.000Z"],
    ["2026-07-26-f-e-16", "2026-07-26-fighters-eagles-1300", "2026-07-26", "fighters", "eagles", "f-e-16", "2026-07-26T04:00:00.000Z"]
  ];
  for (const [compactGameId, descriptiveGameId, gameDate, homeTeam, awayTeam, gameCode, startAt] of cases) {
    const scheduleRow = { ...schedule, game_id: descriptiveGameId, game_date: gameDate, home_team: homeTeam, away_team: awayTeam, game_code: gameCode, start_at: startAt };
    const preview = await buildGameIdentityRepairPreview({
      scheduleRows: [scheduleRow],
      tableRows: { predictions: [{ game_id: compactGameId, row_count: 1, unlinked_row_count: 1 }] }
    });
    assert.ok(preview.safeInternalGameCreations[0].legacyGameIds.includes(compactGameId), compactGameId);
    assert.equal(preview.obsoleteOrphans.some((item) => item.gameId === compactGameId), false, compactGameId);
    assert.equal(preview.manualReviewItems.some((item) => item.compactGameId === compactGameId), false, compactGameId);
  }
});

test("scheduleだけの旧指標と全関連テーブルを含む新指標を分けて返す", async () => {
  const compactGameId = "2026-08-01-f-m-15";
  const preview = await buildGameIdentityRepairPreview({
    scheduleRows: [{ ...schedule, game_code: "f-m-99", internal_game_id: "11111111-1111-4111-8111-111111111111" }],
    tableRows: { predictions: [{ game_id: compactGameId, row_count: 1, unlinked_row_count: 1 }] }
  });
  assert.equal(preview.summary.projectedLegacyIdsWithoutInternalGameId, 0);
  assert.equal(preview.summary.projectedScheduleLegacyIdsWithoutInternalGameId, 0);
  assert.equal(preview.summary.projectedAllTableLegacyIdsWithoutInternalGameId, 1);
  assert.equal(preview.summary.projectedCompactIdsWithoutInternalGameId, 1);
  assert.equal(preview.summary.projectedDescriptiveIdsWithoutInternalGameId, 0);
  assert.deepEqual(preview.summary.projectedAllTableLegacyIdBreakdown, [{
    gameId: compactGameId,
    classification: "MANUAL_REVIEW",
    tableCount: 1,
    tableRows: [{ table: "predictions", count: 1 }],
    reasonCodes: ["GAME_CODE_CONFLICT"]
  }]);
});

test("既に日程へ設定済みのUUIDにも安全なcompact IDをSAFE_AUTO_LINKで収束できる", async () => {
  const internalGameId = "11111111-1111-4111-8111-111111111111";
  const compactGameId = "2026-08-01-f-m-15";
  const preview = await buildGameIdentityRepairPreview({
    scheduleRows: [{ ...schedule, internal_game_id: internalGameId }],
    tableRows: {
      predictions: [{ game_id: compactGameId, row_count: 1, unlinked_row_count: 1 }],
      ranking_games: [{ game_id: compactGameId, row_count: 1, unlinked_row_count: 1 }]
    }
  });
  assert.equal(preview.safeAutoLinks.length, 1);
  assert.equal(preview.safeAutoLinks[0].targetInternalGameId, internalGameId);
  assert.ok(preview.safeAutoLinks[0].legacyGameIds.includes(compactGameId));
  assert.equal(preview.summary.projectedAllTableLegacyIdsWithoutInternalGameId, 0);
});

test("8月4日のpregameとrosterのlegacy-only行を既存UUIDへSAFE_AUTO_LINKする", async () => {
  const internalGameId = "33333333-3333-4333-8333-333333333333";
  const compactGameId = "2026-08-04-h-f-15";
  const descriptiveGameId = "2026-08-04-hawks-fighters-1500";
  const sourceGameKey = "2026-08-04:hawks:fighters:15:00";
  const augustFourSchedule = {
    game_id: descriptiveGameId,
    source_game_key: sourceGameKey,
    game_date: "2026-08-04",
    start_at: "2026-08-04T06:00:00.000Z",
    home_team: "hawks",
    away_team: "fighters",
    game_code: "h-f-15",
    game_status: "scheduled",
    internal_game_id: internalGameId
  };
  const previewInput = {
    scheduleRows: [augustFourSchedule],
    games: [game(internalGameId, {
      game_date: "2026-08-04",
      start_time: "2026-08-04T06:00:00.000Z",
      home_team: "hawks",
      away_team: "fighters",
      game_status: "scheduled"
    })],
    identifiers: [
      { internal_game_id: internalGameId, provider: "starting9", identifier_type: "descriptive_game_id", identifier_value: descriptiveGameId },
      { internal_game_id: internalGameId, provider: "npb", identifier_type: "npb_game_code", identifier_value: "h-f-15" },
      { internal_game_id: internalGameId, provider: "schedule_worker", identifier_type: "source_game_key", identifier_value: sourceGameKey }
    ],
    tableRows: {
      game_pregame_automation: [{ game_id: compactGameId, row_count: 1, unlinked_row_count: 1, start_at: augustFourSchedule.start_at }],
      game_roster_snapshots: [{ game_id: compactGameId, row_count: 1, unlinked_row_count: 1, game_date: augustFourSchedule.game_date }]
    },
    now: new Date("2026-08-02T00:00:00.000Z")
  };
  const preview = await buildGameIdentityRepairPreview(previewInput);
  const repeated = await buildGameIdentityRepairPreview(previewInput);
  assert.equal(preview.safeAutoLinks.length, 1);
  const plan = preview.safeAutoLinks[0];
  assert.equal(plan.targetInternalGameId, internalGameId);
  assert.equal(plan.createInternalGame, false);
  assert.deepEqual(plan.identifiersToInsert, []);
  assert.deepEqual(plan.tableRowsToUpdate, [
    { table: "game_pregame_automation", legacyGameId: compactGameId, expectedCount: 1 },
    { table: "game_roster_snapshots", legacyGameId: compactGameId, expectedCount: 1 }
  ]);
  assert.equal(plan.legacyGameIds.includes(compactGameId), true);
  assert.equal(preview.obsoleteOrphans.some((item) => item.gameId === compactGameId), false);
  assert.equal(preview.classificationIntegrity.valid, true);
  assert.equal(plan.repairId, repeated.safeAutoLinks[0].repairId);
  assert.equal(plan.planHash, repeated.safeAutoLinks[0].planHash);
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
