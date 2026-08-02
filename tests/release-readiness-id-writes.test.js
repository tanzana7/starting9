const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("UUID未割当の試合とlegacy-only書き込みの監査明細を返す契約がある", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /gamesWithoutInternalGameIdDetails/);
  assert.match(worker, /scheduleGameId/);
  assert.match(worker, /detectedScheduleInternalGameId/);
  assert.match(worker, /gamesCandidateCount/);
  assert.match(worker, /identifierCandidateCount/);
  assert.match(worker, /recentLegacyOnlyWrites/);
  assert.match(worker, /legacyOnlyWritesByTable/);
  assert.match(worker, /legacyOnlyWritesBySource/);
  assert.match(worker, /expectedInternalGameId/);
  assert.match(worker, /INTERNAL_GAME_ID_UNRESOLVED/);
});

test("新規日程にUUIDがない場合はprediction targetから通常処理へ流さない", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /internal_game_id IS NOT NULL AND internal_game_id <> ''/);
  assert.match(worker, /if \(registryAvailable && target && !INTERNAL_GAME_ID_PATTERN\.test/);
  assert.match(worker, /resolveScheduleInternalGameId\(env\.AUTH_DB, registry/);
  assert.match(worker, /createScheduleGameIdentifiers\(/);
});

test("通常試合の主要保存経路はinternal_game_id必須resolverを通り、schema未適用時だけfallbackする", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /async function requireInternalGameIdForWrite/);
  for (const table of [
    "predictions",
    "probable_starters",
    "game_roster_snapshots",
    "game_pregame_automation",
    "game_lineups",
    "ranking_games",
    "game_rescore_jobs"
  ]) {
    assert.match(worker, new RegExp(`table: "${table}"`));
  }
  assert.match(worker, /INTERNAL_GAME_ID_REQUIRED/);
  assert.match(worker, /INSERT INTO predictions[\s\S]*internal_game_id/);
  assert.match(worker, /INSERT INTO probable_starters[\s\S]*internal_game_id/);
  assert.match(worker, /INSERT INTO game_lineups[\s\S]*internal_game_id/);
  assert.match(worker, /INSERT INTO ranking_games[\s\S]*internal_game_id/);
});

test("day scope・テスト試合をlegacy-only監査から除外する", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /game_id NOT LIKE 'day-%'/);
  assert.match(worker, /is_test_prediction = 0/);
  assert.match(worker, /is_test_game = 0 OR is_test_game IS NULL/);
});

test("正常なretry_waitはwarning、期限超過・UUID解決不能はblockerになる", async () => {
  const { classifyRetryWaitJobs, deriveReleaseReadiness } = await import("../auth-worker.js");
  const now = new Date("2026-08-02T00:00:00.000Z");
  const normal = classifyRetryWaitJobs([{
    internal_game_id: "11111111-1111-4111-8111-111111111111",
    job_type: "final_lineup_fetch",
    status: "retry_wait",
    scheduled_slot_at: "2026-08-02T00:00:00.000Z",
    next_attempt_at: "2026-08-02T00:20:00.000Z",
    attempt_count: 2,
    max_attempts: 72,
    error_code: "LINEUP_HTTP_ERROR",
    updated_at: "2026-08-02T00:00:00.000Z"
  }], now);
  assert.equal(normal.retryWaitBlockerCount, 0);
  assert.equal(deriveReleaseReadiness({ counts: { retryWaitCount: 1, retryWaitBlockerCount: 0 } }).ready, true);

  const expired = classifyRetryWaitJobs([{
    internal_game_id: "",
    job_type: "scoring",
    status: "retry_wait",
    scheduled_slot_at: "2026-08-01T00:00:00.000Z",
    next_attempt_at: "2026-08-01T00:00:00.000Z",
    attempt_count: 5,
    max_attempts: 5,
    error_code: "LINEUP_HTTP_ERROR",
    updated_at: "2026-08-01T00:00:00.000Z"
  }], now);
  assert.equal(expired.retryWaitBlockerCount, 1);
  const readiness = deriveReleaseReadiness({ counts: { retryWaitCount: 1, retryWaitBlockerCount: 1 } });
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.blockers, ["RETRY_WAIT_EXPIRED"]);
});

