import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildGameIdentityAuditReport,
  classifyGameIdentityFormat,
  parseGameIdentityAuditOptions
} from "../auth-worker.js";

const descriptiveGameId = "2026-07-31-fighters-marines-1800";
const compactGameId = "2026-07-31-f-m-14";
const orphanGameId = "2026-08-01-f-m-15";

function createFixtureReport(includeDetails = true) {
  return buildGameIdentityAuditReport({
    options: { includeDetails, limit: 50, dateFrom: "2026-07-01", dateTo: "2026-07-31" },
    scheduleRows: [
      {
        game_id: descriptiveGameId,
        source_game_key: "npb-2026-07-31-f-m-14-a",
        game_date: "2026-07-31",
        start_at: "2026-07-31T18:00:00+09:00",
        home_team: "fighters",
        away_team: "marines",
        game_code: "f-m-14"
      },
      {
        game_id: compactGameId,
        source_game_key: "npb-2026-07-31-f-m-14-b",
        game_date: "2026-07-31",
        start_at: "2026-07-31T09:00:00.000Z",
        home_team: "fighters",
        away_team: "marines",
        game_code: "f-m-14"
      },
      {
        game_id: "2026-08-02-f-m-16",
        source_game_key: "npb-2026-08-02-f-m-16",
        game_date: "2026-08-02",
        start_at: "2026-08-02T18:00:00+09:00",
        home_team: "fighters",
        away_team: "marines",
        game_code: "f-m-16"
      }
    ],
    tableRows: {
      predictions: [
        { game_id: descriptiveGameId, row_count: 2, game_date: "2026-07-31", scored_prediction_count: 1, unscored_prediction_count: 1 },
        { game_id: orphanGameId, row_count: 1, game_date: "2026-08-01", scored_prediction_count: 0, unscored_prediction_count: 1 }
      ],
      game_lineups: [
        { game_id: compactGameId, row_count: 1, lineup_scoring_status: "scored", publication_status: "published" }
      ],
      ranking_games: [
        { game_id: compactGameId, row_count: 1, ranking_game_status: "service_unavailable", is_ranking_eligible: 1, publication_status: "pending" }
      ],
      game_pregame_automation: [
        { game_id: compactGameId, row_count: 1, lineup_status: "captured", scoring_status: "pending", error_code: "SCORING_RETRY_EXPIRED", next_lineup_attempt_at: "2026-07-31T10:00:00.000Z" }
      ],
      game_workflow_logs: [
        { game_id: compactGameId, row_count: 1, error_log_count: 1, error_code: "LINEUP_FAILED" }
      ]
    }
  });
}

test("game identity audit classifies compact, descriptive, other, and empty identifiers", () => {
  assert.equal(classifyGameIdentityFormat(compactGameId), "compact");
  assert.equal(classifyGameIdentityFormat(descriptiveGameId), "descriptive");
  assert.equal(classifyGameIdentityFormat("legacy-game"), "other");
  assert.equal(classifyGameIdentityFormat(""), "empty");
});

test("game identity audit detects duplicate aliases, table splits, orphans, and state conflicts without prediction contents", () => {
  const report = createFixtureReport();
  assert.equal(report.summary.duplicateCandidateGroups, 1);
  assert.equal(report.summary.orphanGameIds, 1);
  assert.deepEqual(report.duplicateCandidates[0].gameIds, [compactGameId, descriptiveGameId]);
  assert.ok(report.stateConflicts.some((conflict) => conflict.code === "TABLE_ID_PARTITIONED"));
  assert.ok(report.stateConflicts.some((conflict) => conflict.code === "SERVICE_UNAVAILABLE_RANKING_ELIGIBLE"));
  assert.ok(report.stateConflicts.some((conflict) => conflict.code === "MIXED_PREDICTION_SCORING_STATE"));
  assert.ok(report.orphanIds.some((entry) => entry.gameId === orphanGameId));
  assert.equal(JSON.stringify(report).includes("user_id"), false);
  assert.equal(JSON.stringify(report).includes("prediction_json"), false);
});

test("normal distinct schedule rows are not reported as duplicate candidates", () => {
  const report = buildGameIdentityAuditReport({
    options: { includeDetails: true, limit: 50 },
    scheduleRows: [
      { game_id: compactGameId, source_game_key: "one", game_date: "2026-07-31", start_at: "2026-07-31T18:00:00+09:00", home_team: "fighters", away_team: "marines", game_code: "f-m-14" },
      { game_id: "2026-08-01-f-m-15", source_game_key: "two", game_date: "2026-08-01", start_at: "2026-08-01T14:00:00+09:00", home_team: "fighters", away_team: "marines", game_code: "f-m-15" }
    ]
  });
  assert.equal(report.summary.duplicateCandidateGroups, 0);
});

test("game identity audit reports scored games without a lineup and handles unavailable optional tables", () => {
  const report = buildGameIdentityAuditReport({
    options: { includeDetails: true, limit: 50 },
    unavailableTables: ["probable_starters"],
    scheduleRows: [
      { game_id: compactGameId, source_game_key: "one", game_date: "2026-07-31", start_at: "2026-07-31T18:00:00+09:00", home_team: "fighters", away_team: "marines", game_code: "f-m-14" }
    ],
    tableRows: {
      ranking_games: [{ game_id: compactGameId, row_count: 1, ranking_game_status: "scored", is_ranking_eligible: 1, publication_status: "scored_private" }]
    }
  });
  assert.ok(report.stateConflicts.some((conflict) => conflict.code === "SCORED_RANKING_GAME_WITHOUT_LINEUP"));
  assert.deepEqual(report.summary.unavailableTables, ["probable_starters"]);
});

test("game identity audit separates summary-only responses and bounds the default query range", () => {
  const options = parseGameIdentityAuditOptions(new Request("https://example.test/api/admin/audit/game-identities"), new Date("2026-08-01T03:00:00.000Z"));
  assert.equal(options.ok, true);
  assert.equal(options.dateFrom, "2026-07-03");
  assert.equal(options.dateTo, "2026-08-01");
  assert.equal(options.limit, 50);
  assert.equal(options.allPeriod, false);
  assert.equal(parseGameIdentityAuditOptions(new Request("https://example.test/api/admin/audit/game-identities?scope=all&limit=999"), new Date()).limit, 100);
  const report = createFixtureReport(false);
  assert.equal("duplicateCandidates" in report, false);
  assert.equal("orphanIds" in report, false);
});

test("game identity audit route is admin-only and contains no mutation SQL", async () => {
  const source = await readFile(new URL("../auth-worker.js", import.meta.url), "utf8");
  assert.match(source, /path === "\/api\/admin\/audit\/game-identities" && request\.method === "GET"/);
  const start = source.indexOf("async function handleAdminGameIdentityAudit");
  const end = source.indexOf("export function selectNextPredictionTarget", start);
  const auditSource = source.slice(start, end);
  assert.match(auditSource, /requireAdminUser\(request, env, cors\)/);
  assert.doesNotMatch(auditSource, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i);
  assert.doesNotMatch(auditSource, /fetch\(/);
  for (const table of ["detected_game_schedule", "probable_starters", "game_day_notice_games", "game_roster_snapshots", "game_pregame_automation", "game_lineups", "game_lineup_revisions", "predictions", "ranking_games", "perfect_achievers", "game_rescore_jobs", "game_workflow_logs", "game_workflow_controls"]) {
    assert.match(source, new RegExp(`"${table}"`));
  }
});
