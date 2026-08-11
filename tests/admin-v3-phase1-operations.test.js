import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const client = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
const page = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
const v3 = await import(pathToFileURL(path.join(root, "game-automation-v3.js")).href);

const phase1Routes = [
  "/lineup", "/lineup-revisions", "/lineup-finalize", "/scoring/preview", "/scoring/confirm",
  "/ranking", "/ranking/rebuild", "/publication", "/publication/publish", "/publication/republish",
  "/ranking-eligibility", "/schedule"
];

test("V3 Phase 1 APIはinternalGameIdを入口にする専用ルートを持つ", () => {
  assert.match(worker, /parseAdminV3Phase1Route/);
  assert.match(worker, /normalizeV3InternalGameId\(internalGameId\)/);
  for (const route of phase1Routes) assert.match(worker, new RegExp(route.slice(1).replaceAll("/", "\\/")));
  assert.match(worker, /V3_MANAGED_GAME_USE_V3_API/);
});

test("スタメン操作はrevision作成・正式確定を既存コアへ接続し、理由を要求する", () => {
  assert.match(worker, /saveLineupCandidateRevision\(env\.AUTH_DB/);
  assert.match(worker, /activateLineupRevision\(env\.AUTH_DB/);
  assert.match(worker, /linkFinalLineupRevision\(env\.AUTH_DB/);
  assert.match(worker, /V3_LINEUP_REVISION_NOT_FOUND/);
  assert.match(worker, /V3_REASON_REQUIRED/);
});

test("再採点は既存preview/confirmコアへ委譲し、ランキング・公開はjobを冪等投入する", () => {
  assert.match(worker, /handleAdminRescorePreview\(request, env, cors, metadata, user\)/);
  assert.match(worker, /handleAdminRescoreConfirm\(request, env, cors, metadata, user/);
  assert.match(worker, /createV3AdminActionJob\(env\.AUTH_DB, context\.id, "ranking_rebuild"/);
  assert.match(worker, /createV3AdminActionJob\(env\.AUTH_DB, context\.id, "publish"/);
  assert.match(worker, /status IN \('pending', 'claimed', 'retry_wait'\)/);
});

test("旧job操作APIは安全条件を維持し、admin-v3の通常画面は読み取り専用にする", () => {
  assert.match(worker, /status IN \('failed', 'retry_wait'\) AND attempt_count < max_attempts/);
  assert.match(worker, /status IN \('pending', 'retry_wait'\)/);
  assert.doesNotMatch(client, /data-v3-job-retry/);
  assert.doesNotMatch(client, /data-v3-job-cancel/);
});

test("管理画面は自動進行の確認に限定し、手動Phase 1操作を表示しない", () => {
  for (const selector of ["data-v3-save-lineup", "data-v3-finalize-lineup", "data-v3-scoring-preview", "data-v3-scoring-confirm", "data-v3-ranking-rebuild", "data-v3-publish", "data-v3-republish", "data-v3-schedule-save", "data-v3-eligibility-save"]) {
    assert.doesNotMatch(client, new RegExp(selector));
  }
  assert.match(client, /V3が取得・確定したスタメンrevisionを確認します/);
  assert.match(client, /V3が進めた採点・ランキング・公開の状態を確認します/);
  assert.match(page, /admin-v3\.js\?v=ranking-copy-perfect-score-helper-1/);
  assert.match(page, /admin-v3\.css\?v=ranking-copy-perfect-score-helper-1/);
});

test("管理画面のjob詳細は失敗内容を確認でき、ユーザー情報を描画しない", () => {
  assert.match(client, /data-v3-job-detail/);
  assert.match(worker, /SELECT id, job_id, job_type, state_before, state_after/);
  assert.doesNotMatch(worker, /SELECT .*email.*FROM game_jobs_v3/);
});

test("V3表示用タイミングは既存仕様から18時開始の派生時刻を生成する", () => {
  const schedule = v3.deriveV3DisplaySchedule({
    gameDate: "2026-08-06",
    startAt: "2026-08-06T09:00:00.000Z"
  });
  assert.equal(schedule.predictionDeadline, "2026-08-06T08:00:00.000Z");
  assert.deepEqual(schedule.rosterFetchSlots, [
    "2026-08-06T07:00:00.000Z",
    "2026-08-06T07:02:00.000Z",
    "2026-08-06T07:10:00.000Z"
  ]);
  assert.equal(schedule.lineupPollingStart, "2026-08-06T08:10:00.000Z");
  assert.deepEqual(schedule.lineupPollingSlots, [
    "2026-08-06T08:10:00.000Z",
    "2026-08-06T08:20:00.000Z",
    "2026-08-06T08:30:00.000Z",
    "2026-08-06T08:40:00.000Z",
    "2026-08-06T08:50:00.000Z",
    "2026-08-06T09:00:00.000Z"
  ]);
  assert.equal(schedule.finalLineupAt, "2026-08-06T09:02:00.000Z");
  assert.equal(schedule.scoringEarliestAt, "2026-08-06T09:02:00.000Z");
  assert.equal(schedule.publicationAt, "2026-08-06T09:10:00.000Z");
  assert.equal(schedule.probableStarterNextAt, "2026-08-05T09:00:00.000Z");
});

test("V3次の処理は現在時刻より未来の未完了処理を選び、完了済みを除外する", () => {
  const schedule = v3.deriveV3DisplaySchedule({ gameDate: "2026-08-06", startAt: "2026-08-06T09:00:00.000Z" });
  const beforeDeadline = v3.getV3NextAction({ schedule, state: "scheduled", now: "2026-08-06T07:46:00.000Z" });
  assert.deepEqual(beforeDeadline, {
    nextAction: "prediction_close",
    nextActionAt: "2026-08-06T08:00:00.000Z",
    nextActionLabel: "予想締切"
  });
  const afterDeadline = v3.getV3NextAction({
    schedule,
    state: "prediction_closed",
    now: "2026-08-06T07:46:00.000Z",
    jobs: [{ job_type: "prediction_close", status: "completed" }]
  });
  assert.equal(afterDeadline.nextAction, "lineup_fetch");
  assert.equal(afterDeadline.nextActionAt, "2026-08-06T08:10:00.000Z");
});

test("依存処理は予定未定ではなく前段完了後として返す", () => {
  const schedule = v3.deriveV3DisplaySchedule({ gameDate: "2026-08-06", startAt: "2026-08-06T09:00:00.000Z" });
  const scoring = v3.getV3NextAction({ schedule, state: "lineup_ready", now: "2026-08-06T09:05:00.000Z" });
  const ranking = v3.getV3NextAction({ schedule, state: "scored", now: "2026-08-06T09:05:00.000Z" });
  assert.equal(scoring.nextActionLabel, "採点（正式スタメン確定後）");
  assert.equal(ranking.nextActionLabel, "ランキング反映（採点完了後）");
  assert.equal(scoring.nextActionAt, null);
  assert.equal(ranking.nextActionAt, null);
});

test("overviewは正規の表示用scheduleと次の処理を付加し、UIはそれを描画する", () => {
  assert.match(worker, /deriveV3DisplaySchedule\(game\)/);
  assert.match(worker, /getV3NextAction\(\{ schedule, state: resolvedState\.state/);
  assert.match(client, /game\.schedule \|\| \{\}/);
  assert.match(client, /schedule\.predictionDeadline/);
  assert.match(client, /schedule\.finalLineupAt/);
  assert.match(client, /schedule\.publicationAt/);
});

test("旧更新APIはV3 stateまたはV3 jobがある試合をlegacy ID経由でも拒否する", () => {
  assert.match(worker, /predictions\/score-predictions/);
  assert.match(worker, /game_automation_v3_state WHERE internal_game_id = \?1[\s\S]*game_jobs_v3 WHERE internal_game_id = \?1/);
  assert.match(worker, /V3_MANAGED_GAME_USE_V3_API/);
  assert.match(worker, /request\.method !== "GET"/);
});

test("スタメン確定は同一revisionをno-opにし、採点中の差し替えを拒否する", () => {
  assert.match(worker, /currentFinalRevisionId === requestedRevisionId/);
  assert.match(worker, /V3_LINEUP_FINALIZE_IN_PROGRESS/);
  assert.match(worker, /V3_LINEUP_REVISION_CONFLICT/);
});

test("再採点previewは試合・lineup・scoring revisionを固定し、confirm前提を再検証する", () => {
  assert.match(worker, /previewSummary\.v3Lineage/);
  assert.match(worker, /assertV3RescoreLineage/);
  assert.match(worker, /RESCORE_SCORING_REVISION_CHANGED/);
  assert.match(worker, /RESCORE_PREVIEW_EXPIRED/);
  assert.match(worker, /status = 'previewed'/);
  assert.match(worker, /deferPublication/);
});

test("再採点成功時はscoring revisionを完了させ、V3ではranking/publicationを後続へ分離する", () => {
  assert.match(worker, /beginGameScoringRevision\(db, \{[\s\S]*lineupRevisionId/);
  assert.match(worker, /completeGameScoringRevision\(db, \{[\s\S]*scoringRevisionId: scoringRevisionState\.id/);
  assert.match(worker, /if \(!deferPublication\) \{[\s\S]*to: "ranked"/);
  assert.match(worker, /publication_status = CASE WHEN \?7 = 1 THEN 'published' ELSE 'pending' END/);
});

test("rankingとpublicationはactive revision・reflection一致を要求し、slot単位で再投入する", () => {
  assert.match(worker, /V3_SCORING_REVISION_REQUIRED/);
  assert.match(worker, /V3_RANKING_REVISION_NOT_REFLECTED/);
  assert.match(worker, /finalRevision = revisions\.find\(\(row\) => Number\(row\.is_final\) === 1\)/);
  assert.match(worker, /正式スタメン確定済みの公開対象がありません/);
  assert.match(worker, /scheduledSlotAt: activeRevision\?\.created_at/);
  assert.match(worker, /allowAfterCompleted: true/);
});

test("eligibility変更は履歴を維持し、同じ状態をno-opにしてranking jobを再投入する", () => {
  assert.match(worker, /ranking_eligibility_history/);
  assert.match(worker, /rankingEligibilityUpdatedAt/);
  assert.match(worker, /scheduledSlotAt: eligibility\?\.rankingEligibilityUpdatedAt/);
  assert.match(worker, /rankingJob/);
});

test("job retry/cancelと日程変更は原子的条件・理由・pending限定再配置を持つ", () => {
  assert.match(worker, /status IN \('failed', 'retry_wait'\) AND attempt_count < max_attempts/);
  assert.match(worker, /status IN \('pending', 'retry_wait'\)/);
  assert.match(worker, /failureCode: before\?\.failure_code/);
  assert.match(worker, /status = 'pending'/);
  assert.match(worker, /predictionReopened: false/);
});

test("V3の通常管理画面には緊急操作メニューを置かない", () => {
  assert.doesNotMatch(page, /data-v3-view="emergency"/);
  assert.doesNotMatch(client, /renderEmergencyView/);
});

test("再採点途中の失敗は新revisionをfailed・非activeに閉じ、旧公開結果を保護する", () => {
  assert.match(worker, /try \{[\s\S]*const scoringRevision = scoringRevisionState\.number/);
  assert.match(worker, /failGameScoringRevision\(db, \{ scoringRevisionId: scoringRevisionState\.id/);
  assert.match(worker, /const keepPublished = published && !deferPublication/);
  assert.match(worker, /published_at = CASE WHEN \?7 = 1 THEN published_at ELSE NULL END/);
});
