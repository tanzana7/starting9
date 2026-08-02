const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const workerModule = import("../auth-worker.js");

const historicalGame = {
  internalGameId: "12d554bb-ad25-44be-8159-0134c046dcee",
  gameId: "2026-08-02-fighters-marines-1300",
  workflowStatus: "retrying",
  lastErrorCode: "DATA_VALIDATION_FAILED"
};

test("過去試合の詳細監査APIはUUID指定の管理者専用GETとして登録される", () => {
  assert.match(worker, /parseHistoricalGameWorkflowAuditRoute\(path\)/);
  assert.match(worker, /handleAdminHistoricalGameWorkflow\(request, env, cors, historicalGameWorkflowAuditRoute\.internalGameId\)/);
  assert.match(worker, /const access = await requireAdminUser\(request, env, cors\);/);
  assert.match(worker, /INVALID_INTERNAL_GAME_ID/);
  assert.match(worker, /GAME_WORKFLOW_NOT_FOUND/);
  assert.match(worker, /\/api\/admin\/audit\/game-workflows\//);
  assert.match(worker, /async function isWorkflowJobSchemaReady\(db\)/);
  assert.match(worker, /SELECT 1 FROM game_job_runs LIMIT 1/);
});

test("8月2日の失敗試合をinternal_game_idで監査できるfixtureを維持する", () => {
  assert.equal(historicalGame.internalGameId, "12d554bb-ad25-44be-8159-0134c046dcee");
  assert.equal(historicalGame.gameId, "2026-08-02-fighters-marines-1300");
  assert.equal(historicalGame.workflowStatus, "retrying");
  assert.equal(historicalGame.lastErrorCode, "DATA_VALIDATION_FAILED");
  assert.match(worker, /WORKFLOW_RETRYING_WITHOUT_ACTIVE_RETRY_JOB/);
  assert.match(worker, /HISTORICAL_JOB_STATE_MISMATCH/);
});

test("ジョブ詳細は試合進行に必要な安全な診断項目だけを返す", () => {
  const handlerStart = worker.indexOf("async function handleAdminHistoricalGameWorkflow");
  const handlerEnd = worker.indexOf("function parseGameWorkflowAuditOptions", handlerStart);
  const handler = worker.slice(handlerStart, handlerEnd);
  assert.match(handler, /job_type/);
  assert.match(handler, /scheduled_slot_at/);
  assert.match(handler, /attempt_count/);
  assert.match(handler, /max_attempts/);
  assert.match(handler, /error_code/);
  assert.match(handler, /error_detail/);
  assert.match(handler, /validation/);
  assert.match(worker, /parseStage/);
  assert.match(worker, /httpStatus/);
  assert.match(worker, /sourceUrlHost/);
  assert.match(worker, /overdue/);
  assert.doesNotMatch(handler, /actual_lineup_json/);
  assert.doesNotMatch(handler, /roster_json/);
  assert.doesNotMatch(handler, /predictions/);
  assert.doesNotMatch(handler, /playerName/);
});

test("監査結果はprovisional/finalのジョブ、検証、採点可否を同じレスポンスで返す", () => {
  const handlerStart = worker.indexOf("async function handleAdminHistoricalGameWorkflow");
  const handlerEnd = worker.indexOf("function parseGameWorkflowAuditOptions", handlerStart);
  const handler = worker.slice(handlerStart, handlerEnd);
  const responseKeyPatterns = {
    jobs: /\bjobs:/g,
    lineupJobs: /\blineupJobs:/g,
    lineupFetchStatus: /\blineupFetchStatus:/g,
    lineupFetchState: /\blineupFetchState:/g,
    lastFetchAttempt: /\blastFetchAttempt:/g,
    validation: /\bvalidation:/g,
    scoringEligibility: /\bscoringEligibility:/g,
    warnings: /\bwarnings,/g,
    errors: /\berrors:/g
  };
  for (const [key, pattern] of Object.entries(responseKeyPatterns)) {
    assert.equal((handler.match(pattern) || []).length, 1, `${key} must appear once in response construction`);
  }
  assert.match(worker, /provisional_lineup_fetch/);
  assert.match(worker, /final_lineup_fetch/);
  assert.match(handler, /scoringEligibility/);
  assert.match(worker, /DATA_VALIDATION_FAILED/);
});

test("home/away不一致は自動修正せず監査警告として返す", () => {
  assert.match(worker, /GAME_HOME_AWAY_INCONSISTENCY/);
  assert.match(worker, /auditGameHomeAwayConsistency/);
  assert.match(worker, /homeTeam: identity\.home_team/);
  assert.match(worker, /awayTeam: identity\.away_team/);
  assert.doesNotMatch(worker.slice(worker.indexOf("async function handleAdminHistoricalGameWorkflow"), worker.indexOf("function parseGameWorkflowAuditOptions")), /UPDATE /);
});

test("監査APIは外部取得や機密データの返却を行わない", () => {
  const handlerStart = worker.indexOf("async function handleAdminHistoricalGameWorkflow");
  const handlerEnd = worker.indexOf("function parseGameWorkflowAuditOptions", handlerStart);
  const handler = worker.slice(handlerStart, handlerEnd);
  assert.doesNotMatch(handler, /await fetch\(/);
  assert.match(handler, /sanitizeHistoricalWorkflowErrorDetail/);
  assert.match(handler, /identifiers/);
  assert.doesNotMatch(handler, /Authorization/);
  assert.doesNotMatch(handler, /cookie/i);
});

test("既存の現在試合監査APIとジョブ監査APIのルートは維持される", () => {
  assert.match(worker, /\/api\/admin\/audit\/current-game-workflow/);
  assert.match(worker, /\/api\/admin\/audit\/game-workflows"/);
  assert.match(worker, /handleAdminCurrentGameWorkflow/);
  assert.match(worker, /handleAdminGameWorkflowAudit/);
});

test("retryingだがactive retry jobがない過去試合は不整合警告とvalidationを返す", async () => {
  const { summarizeHistoricalWorkflowJobs } = await workerModule;
  const result = summarizeHistoricalWorkflowJobs([
    {
      id: 7,
      job_type: "provisional_lineup_fetch",
      status: "cancelled",
      scheduled_slot_at: "2026-08-02T04:00:00.000Z",
      attempt_count: 1,
      max_attempts: 3,
      updated_at: "2026-08-02T04:10:00.000Z"
    },
    {
      id: 8,
      job_type: "final_lineup_fetch",
      status: "permanently_failed",
      error_code: "DATA_VALIDATION_FAILED",
      error_detail: "lineup validation failed",
      scheduled_slot_at: "2026-08-02T04:05:00.000Z",
      attempt_count: 3,
      max_attempts: 3,
      result_metadata: JSON.stringify({
        validation: {
          validationReason: "missing_required_players",
          parsedHomeCount: 0,
          parsedAwayCount: 9,
          detectedTeams: ["fighters", "marines"],
          playerName: "must not be returned"
        },
        parseStage: "validate_lineup",
        httpStatus: 200,
        sourceUrlHost: "npb.jp",
        retryable: false,
        lineup: [{ playerName: "must not be returned" }]
      }),
      updated_at: "2026-08-02T04:20:00.000Z"
    }
  ], "retrying", new Date("2026-08-02T05:00:00.000Z"));
  assert.deepEqual(result.warnings, ["WORKFLOW_RETRYING_WITHOUT_ACTIVE_RETRY_JOB", "HISTORICAL_JOB_STATE_MISMATCH"]);
  assert.equal(result.activeRetryJobs.length, 0);
  assert.equal(result.lineupFetchStatus.provisional.status, "cancelled");
  assert.equal(result.lineupFetchStatus.final.status, "permanently_failed");
  assert.equal(result.lineupFetchStatus.final.validation.validationReason, "missing_required_players");
  assert.equal(result.lineupFetchStatus.final.validation.parsedHomeCount, 0);
  assert.equal(result.lineupFetchStatus.final.validation.httpStatus, 200);
  assert.equal(result.scoringEligibility.eligible, false);
  assert.equal(result.scoringEligibility.status, "blocked");
  assert.doesNotMatch(JSON.stringify(result), /must not be returned/);
});

test("retry_waitが存在する場合は期限と再試行可能性を識別する", async () => {
  const { summarizeHistoricalWorkflowJobs } = await workerModule;
  const result = summarizeHistoricalWorkflowJobs([
    {
      job_type: "final_lineup_fetch",
      status: "retry_wait",
      error_code: "EXTERNAL_HTTP_ERROR",
      next_attempt_at: "2026-08-02T05:30:00.000Z",
      scheduled_slot_at: "2026-08-02T05:00:00.000Z",
      attempt_count: 1,
      max_attempts: 5,
      updated_at: "2026-08-02T05:10:00.000Z"
    }
  ], "retrying", new Date("2026-08-02T05:00:00.000Z"));
  assert.deepEqual(result.warnings, []);
  assert.equal(result.activeRetryJobs.length, 1);
  assert.equal(result.jobs[0].retryable, true);
  assert.equal(result.jobs[0].overdue, false);
  assert.equal(result.lastFetchAttempt.health.overdue, false);
  assert.equal(result.scoringEligibility.reasonCode, "EXTERNAL_HTTP_ERROR");
});

test("gamesとscheduleのhome/awayが異なる場合は警告だけを返す", async () => {
  const { auditGameHomeAwayConsistency } = await workerModule;
  const result = auditGameHomeAwayConsistency({
    game: { homeTeam: "fighters", awayTeam: "marines", startAt: "2026-08-02T04:00:00.000Z" },
    scheduleRows: [{ game_id: "2026-08-02-fighters-marines-1300", home_team: "marines", away_team: "fighters", start_at: "2026-08-02T04:00:00.000Z" }]
  });
  assert.equal(result.consistent, false);
  assert.equal(result.warningCode, "GAME_HOME_AWAY_INCONSISTENCY");
  assert.equal(result.mismatches.length, 1);
});
