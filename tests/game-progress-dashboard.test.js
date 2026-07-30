import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = path.join(root, "auth-worker.js");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const worker = fs.readFileSync(workerPath, "utf8");
const { deriveGameProgressStatuses, formatGameProgressLabel } = await import(pathToFileURL(workerPath).href);
const { buildPregameTimeline } = await import(pathToFileURL(path.join(root, "pregame-automation.js")).href);

const schedule = {
  startAt: "2026-07-31T05:00:00.000Z",
  predictionDeadlineAt: "2026-07-31T04:00:00.000Z",
  lineupFetchStartAt: "2026-07-31T04:10:00.000Z",
  resultReleaseAt: "2026-07-31T05:05:00.000Z"
};

test("試合進行ステータスは締切前の受付中と取得待ちを判定する", () => {
  const result = deriveGameProgressStatuses({
    gameId: "2026-07-31-f-m-14",
    schedule,
    now: new Date("2026-07-31T03:30:00.000Z")
  });
  assert.equal(result.statuses.targetSelected.status, "completed");
  assert.equal(result.statuses.predictionOpen.status, "completed");
  assert.equal(result.statuses.predictionClosed.status, "waiting");
  assert.equal(result.statuses.lineupFetched.status, "waiting");
  assert.equal(result.statuses.errorState.status, "completed");
});

test("締切後から採点・ランキング・公開済みまでを表示できる", () => {
  const result = deriveGameProgressStatuses({
    gameId: "2026-07-31-f-m-14",
    game: { matchupLabel: "2026/07/31 日本ハム vs ロッテ" },
    schedule,
    probableStarter: { status: "announced", announced_at: "2026-07-31T02:00:00.000Z", home_pitcher_name: "投手A", away_pitcher_name: "投手B" },
    lineup: { status: "captured", detectedAt: "2026-07-31T04:20:00.000Z" },
    scoring: { status: "scored", scoredAt: "2026-07-31T05:02:00.000Z", dueAt: "2026-07-31T05:02:00.000Z", publicationStatus: "published", publishedAt: "2026-07-31T05:05:00.000Z" },
    ranking: { isRankingEligible: true, rankingEligibleAt: "2026-07-31T05:02:00.000Z", publicationStatus: "published", publishedAt: "2026-07-31T05:05:00.000Z" },
    logs: [{ eventType: "ranking_reflected", status: "success", occurredAt: "2026-07-31T05:02:00.000Z", message: "ランキング反映" }],
    now: new Date("2026-07-31T05:10:00.000Z")
  });
  assert.equal(result.statuses.probableStarter.status, "completed");
  assert.equal(result.statuses.predictionClosed.status, "completed");
  assert.equal(result.statuses.scoringCompleted.status, "completed");
  assert.equal(result.statuses.rankingUpdated.status, "completed");
  assert.equal(result.statuses.resultPublished.status, "completed");
  assert.equal(result.statuses.errorState.status, "completed");
  assert.equal(result.game.matchupLabel, "2026/07/31 日本ハム vs ロッテ");
});

test("D1のISO開始時刻から既存基準で締切を算出できる", () => {
  const detectedGame = {
    gameId: "2026-07-31-marines-fighters-1800",
    date: "2026-07-31",
    startAt: "2026-07-31T09:00:00.000Z",
    homeTeam: "marines",
    awayTeam: "fighters"
  };
  const dynamicSchedule = buildPregameTimeline(detectedGame);
  assert.equal(dynamicSchedule.startAt.toISOString(), "2026-07-31T09:00:00.000Z");
  assert.equal(dynamicSchedule.predictionDeadlineAt.toISOString(), "2026-07-31T08:00:00.000Z");

  const result = deriveGameProgressStatuses({
    gameId: detectedGame.gameId,
    schedule: dynamicSchedule,
    scheduleSource: "detected_game_schedule",
    now: new Date("2026-07-31T07:30:00.000Z")
  });
  assert.equal(result.statuses.predictionOpen.status, "completed");
  assert.equal(result.statuses.predictionClosed.status, "waiting");
});

test("締切日時が見つからない場合は確認した保存先を管理者向け詳細へ含める", () => {
  const result = deriveGameProgressStatuses({
    gameId: "2026-07-31-marines-fighters-1800",
    scheduleSource: "none",
    checkedScheduleSources: ["prediction_target", "detected_game_schedule", "existing_schedule", "workflow_state"]
  });
  assert.equal(result.statuses.predictionOpen.errorCode, "PREDICTION_DEADLINE_UNAVAILABLE");
  assert.match(result.statuses.predictionOpen.detail, /detected_game_schedule/);
});

test("内部チームコードは保存済み表示名がない場合も管理画面用の日本語名へ変換する", () => {
  assert.equal(
    formatGameProgressLabel({ date: "2026-07-31", awayTeam: "fighters", homeTeam: "marines" }),
    "2026/07/31 日本ハム vs ロッテ"
  );
  assert.equal(
    formatGameProgressLabel({ matchupLabel: "2026/07/31 日本ハム vs ロッテ 14回戦", awayTeam: "fighters", homeTeam: "marines" }),
    "2026/07/31 日本ハム vs ロッテ 14回戦"
  );
});

test("失敗ログはエラー、skipや変更なしはエラーにしない", () => {
  const warning = deriveGameProgressStatuses({
    gameId: "game-1",
    schedule,
    logs: [{ eventType: "prediction_target_switch_skipped", status: "warning", occurredAt: "2026-07-31T01:00:00.000Z", message: "次戦なし" }]
  });
  assert.equal(warning.statuses.errorState.status, "completed");

  const failure = deriveGameProgressStatuses({
    gameId: "game-1",
    schedule,
    logs: [{ eventType: "result_publish_failed", status: "error", occurredAt: "2026-07-31T05:06:00.000Z", message: "公開失敗", errorCode: "PUBLISH_FAILED" }]
  });
  assert.equal(failure.statuses.resultPublished.status, "error");
  assert.equal(failure.statuses.errorState.status, "error");
  assert.equal(failure.errors[0].errorCode, "PUBLISH_FAILED");
});

test("試合進行ステータスAPIと管理者限定UIは業務処理を発火しない", () => {
  assert.match(worker, /path === "\/api\/admin\/game-progress-status" && request\.method === "GET"/);
  assert.match(worker, /async function handleAdminGameProgressStatus\(request, env, cors\)/);
  assert.match(worker, /const access = await requireAdminUser\(request, env, cors\);/);
  assert.match(script, /function buildAdminGameProgressStatusApiUrl\(\)/);
  assert.match(script, /GAME_PROGRESS_STATUS_REFRESH_MS = 60 \* 1000/);
  assert.match(script, /function stopGameProgressStatusRefresh\(\)/);
  assert.match(script, /現在の管理対象試合はありません/);
  assert.match(html, /id="adminGameProgressBoard"/);
  assert.match(html, /id="refreshAdminGameProgressButton"/);
  assert.doesNotMatch(script.slice(script.indexOf("async function refreshAdminGameProgressStatus"), script.indexOf("function startGameProgressStatusRefresh")), /runGame|fetchNpb|performRosterCheck|captureOfficialLineup/);
});
