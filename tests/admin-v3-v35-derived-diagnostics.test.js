import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { deriveAdminV3GameProgressStatus } from "../backend/automation-v3/admin-progress-status.js";
import { buildAdminV4Status } from "../backend/automation-v3/admin-v4-status.js";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

test("admin-v3 overview uses the V4 status builder and no longer exposes V3.5 shadow diagnostics", () => {
  const worker = read("auth-worker.js");
  const overview = worker.slice(worker.indexOf("async function handleAdminV3Overview"), worker.indexOf("async function handleAdminV3IdentityResolve"));
  assert.match(worker, /buildAdminV4Status/);
  assert.match(overview, /v4Status/);
  assert.doesNotMatch(worker, /adaptV35Input|evaluateV35Automation|planShadowRecovery|v35DerivedDiagnostics|v35ShadowRecoveryPlan/);
});

test("V4 status source is canonical artifacts plus formal jobs and keeps manual stages explicit", () => {
  const status = buildAdminV4Status({
    game: { internalGameId: "game-1", gameDate: "2026-09-10" },
    persistedState: "prediction_closed",
    automationMode: { mode: "v4_semi_auto" },
    phaseStatuses: {
      probable_starter: { severity: "OK", label: "発表済み" },
      prediction_close: { severity: "OK", label: "完了" },
      score: { severity: "WAITING", reasonCode: "MISSING_DUE_JOB" },
      ranking: { severity: "WAITING", reasonCode: "V3_SCORING_INCOMPLETE" },
      publish: { severity: "WAITING", reasonCode: "V3_RANKING_INCOMPLETE" }
    },
    canonicalArtifacts: {
      available: true,
      lineup: { canonicalFinalRevisionId: "internal-1:1", lineupValid: true, reason: "ARTIFACT_READY" },
      scoring: { activeScoringRevisionId: null, valid: false, reason: "ACTIVE_SCORING_REVISION_MISSING" },
      ranking: { reflectedRevisionId: null, valid: false, reason: "RANKING_REFLECTION_MISSING" },
      publication: { publicationStatus: null, valid: false, reason: "PUBLICATION_NOT_COMPLETED" },
      aggregate: { lineupReady: true, scoringReady: false, rankingReady: false, publicationReady: false }
    },
    displayStatus: { key: "needs_attention", label: "要対応", reason: "採点待ち", stage: "score" }
  });
  assert.equal(status.version, "v4");
  assert.equal(status.source.currentStatus, "canonical_artifact_evaluator");
  assert.equal(status.source.jobs, "formal_job_repository");
  assert.equal(status.source.artifacts, "formal_artifact_repository");
  assert.equal(status.stages.lineup_finalize.label, "完了");
  assert.equal(status.stages.score.label, "採点待ち");
  assert.equal(status.stages.score.key, "wait");
  assert.equal(status.stages.ranking.label, "採点完了待ち");
  assert.equal(status.stages.ranking.key, "wait");
  assert.equal(status.stages.publish.label, "ランキング反映待ち");
  assert.equal(status.stages.publish.key, "wait");
  assert.equal(status.stages.roster.label, "手動運用");
});

test("V4 canonical transitional stages do not promote waiting artifacts to attention", () => {
  const status = buildAdminV4Status({
    game: { gameDate: "2026-09-12", startAt: "2026-09-12T09:00:00.000Z" },
    persistedState: "prediction_closed",
    now: "2026-09-12T09:20:00.000Z",
    schedule: {
      startAt: "2026-09-12T09:00:00.000Z",
      finalLineupAt: "2026-09-12T09:02:00.000Z",
      scoringEarliestAt: "2026-09-12T09:02:00.000Z",
      publicationAt: "2026-09-12T09:10:00.000Z"
    },
    phaseStatuses: {
      score: { severity: "WAITING", reasonCode: "SCORE_PENDING" },
      ranking: { severity: "WAITING", reasonCode: "RANKING_PENDING" },
      publish: { severity: "WAITING", reasonCode: "PUBLISH_PENDING" }
    },
    canonicalArtifacts: {
      available: true,
      lineup: { reason: "ARTIFACT_READY" },
      scoring: { reason: "ACTIVE_SCORING_REVISION_MISSING" },
      ranking: { reason: "RANKING_REFLECTION_MISSING" },
      publication: { reason: "PUBLICATION_NOT_COMPLETED" },
      aggregate: { lineupReady: true, scoringReady: false, rankingReady: false, publicationReady: false }
    }
  });

  for (const phase of ["score", "ranking", "publish"]) {
    assert.equal(status.stages[phase].key, "wait");
    assert.notEqual(status.stages[phase].label, "要対応");
  }
});

test("V4 score status distinguishes a ready canonical lineup from a future score slot", () => {
  const status = buildAdminV4Status({
    game: { gameDate: "2026-09-12", startAt: "2026-09-12T09:00:00.000Z" },
    persistedState: "prediction_closed",
    automationMode: { mode: "v4_semi_auto", isV4SemiAuto: true },
    now: "2026-09-12T07:30:00.000Z",
    schedule: {
      startAt: "2026-09-12T09:00:00.000Z",
      predictionDeadline: "2026-09-12T08:00:00.000Z",
      finalLineupAt: "2026-09-12T09:02:00.000Z",
      scoringEarliestAt: "2026-09-12T09:02:00.000Z",
      publicationAt: "2026-09-12T09:10:00.000Z"
    },
    phaseStatuses: {
      prediction_close: { severity: "OK", reasonCode: "PREDICTION_CLOSE_COMPLETED" },
      score: { severity: "WAITING", reasonCode: "SCORE_PENDING" }
    },
    canonicalArtifacts: {
      available: true,
      lineup: { reason: "ARTIFACT_READY" },
      scoring: { reason: "ACTIVE_SCORING_REVISION_MISSING" },
      aggregate: { lineupReady: true, scoringReady: false, rankingReady: false, publicationReady: false }
    }
  });
  assert.equal(status.schedule.scoringEarliestAt, "2026-09-12T08:00:00.000Z");
  assert.equal(status.stages.score.key, "wait");
  assert.equal(status.stages.score.label, "採点時刻待ち");
  assert.equal(status.stages.score.reason, "採点時刻待ち");
  assert.equal(status.stages.score.reasonCode, "SCORING_NOT_DUE");
});

test("V4 score status reports the close prerequisite when canonical lineup is ready but close is missing", () => {
  const status = buildAdminV4Status({
    game: { gameDate: "2026-09-12", startAt: "2026-09-12T09:00:00.000Z" },
    persistedState: "scheduled",
    automationMode: { mode: "v4_semi_auto", isV4SemiAuto: true },
    now: "2026-09-12T08:18:00.000Z",
    schedule: {
      startAt: "2026-09-12T09:00:00.000Z",
      predictionDeadline: "2026-09-12T08:00:00.000Z",
      finalLineupAt: "2026-09-12T09:02:00.000Z",
      scoringEarliestAt: "2026-09-12T09:02:00.000Z",
      publicationAt: "2026-09-12T09:10:00.000Z"
    },
    phaseStatuses: {
      prediction_close: { severity: "WAITING", reasonCode: "PREDICTION_CLOSE_PENDING" },
      score: { severity: "WAITING", reasonCode: "SCORE_PENDING" }
    },
    canonicalArtifacts: {
      available: true,
      lineup: { reason: "ARTIFACT_READY" },
      scoring: { reason: "ACTIVE_SCORING_REVISION_MISSING" },
      aggregate: { lineupReady: true, scoringReady: false, rankingReady: false, publicationReady: false }
    }
  });
  assert.equal(status.stages.score.key, "wait");
  assert.equal(status.stages.score.reason, "予想締切処理待ち");
  assert.equal(status.stages.score.reasonCode, "PREDICTION_CLOSE_PENDING");
});

test("invalid canonical lineup blocks V4 status without a second evaluator", () => {
  const status = buildAdminV4Status({
    game: { gameDate: "2026-09-10" },
    phaseStatuses: { lineup_finalize: { severity: "WAITING", reasonCode: "LINEUP_FINALIZE_PENDING" } },
    canonicalArtifacts: {
      available: true,
      lineup: { canonicalFinalRevisionId: "bad:1", lineupValid: false, reason: "CANONICAL_FINAL_REVISION_NOT_FOUND" },
      scoring: { valid: false, reason: "ACTIVE_SCORING_REVISION_MISSING" },
      ranking: { valid: false, reason: "RANKING_REFLECTION_MISSING" },
      publication: { valid: false, reason: "PUBLICATION_NOT_COMPLETED" },
      aggregate: { lineupReady: false, scoringReady: false, rankingReady: false, publicationReady: false }
    }
  });
  assert.equal(status.stages.lineup_finalize.label, "要対応");
  assert.equal(status.stages.score.label, "要対応");
});

test("future games keep missing downstream artifacts in waiting state", () => {
  const schedule = {
    startAt: "2026-09-12T09:00:00.000Z",
    probableStarterNextAt: "2026-09-11T09:00:00.000Z",
    predictionDeadline: "2026-09-12T08:00:00.000Z",
    finalLineupAt: "2026-09-12T09:02:00.000Z",
    scoringEarliestAt: "2026-09-12T09:02:00.000Z",
    publicationAt: "2026-09-12T09:10:00.000Z"
  };
  const status = buildAdminV4Status({
    game: { gameDate: "2026-09-12", startAt: schedule.startAt },
    persistedState: "scheduled",
    now: "2026-09-11T00:00:00.000Z",
    schedule,
    phaseStatuses: {
      lineup_finalize: { severity: "ATTENTION", reasonCode: "CANONICAL_FINAL_REVISION_MISSING" },
      score: { severity: "ATTENTION", reasonCode: "ACTIVE_SCORING_REVISION_MISSING" },
      ranking: { severity: "ATTENTION", reasonCode: "RANKING_REFLECTION_MISSING" },
      publish: { severity: "ATTENTION", reasonCode: "PUBLICATION_NOT_COMPLETED" }
    },
    canonicalArtifacts: {
      available: true,
      lineup: { reason: "CANONICAL_FINAL_REVISION_MISSING" },
      scoring: { reason: "ACTIVE_SCORING_REVISION_MISSING" },
      ranking: { reason: "RANKING_REFLECTION_MISSING" },
      publication: { reason: "PUBLICATION_NOT_COMPLETED" },
      aggregate: { lineupReady: false, scoringReady: false, rankingReady: false, publicationReady: false }
    }
  });
  assert.equal(status.stages.lineup_finalize.key, "wait");
  assert.equal(status.stages.lineup_finalize.reason, "手動確定待ち / 試合当日の確認前");
  assert.equal(status.stages.score.reason, "正式スタメン確定待ち");
  assert.equal(status.stages.ranking.reason, "採点完了待ち");
  assert.equal(status.stages.publish.reason, "ランキング反映待ち");
  assert.equal(status.stages.probable_starter.scheduledAt, schedule.probableStarterNextAt);
  assert.equal(status.stages.prediction_close.scheduledAt, schedule.predictionDeadline);
});

test("due missing artifact can still be reported as attention", () => {
  const status = buildAdminV4Status({
    game: { gameDate: "2026-09-12", startAt: "2026-09-12T09:00:00.000Z" },
    persistedState: "prediction_closed",
    now: "2026-09-12T09:20:00.000Z",
    schedule: {
      startAt: "2026-09-12T09:00:00.000Z",
      finalLineupAt: "2026-09-12T09:02:00.000Z",
      scoringEarliestAt: "2026-09-12T09:02:00.000Z",
      publicationAt: "2026-09-12T09:10:00.000Z"
    },
    canonicalArtifacts: {
      available: true,
      scoring: { reason: "ACTIVE_SCORING_REVISION_MISSING" },
      aggregate: { lineupReady: true, scoringReady: false, rankingReady: false, publicationReady: false }
    },
    phaseStatuses: { score: { severity: "ATTENTION", reasonCode: "ACTIVE_SCORING_REVISION_MISSING" } }
  });
  assert.equal(status.stages.score.key, "attention");
  assert.equal(status.stages.score.reasonCode, "ACTIVE_SCORING_REVISION_MISSING");
});

test("canonical evaluatorが有効なら古いlineup healthとdownstream待ちでcanonical欠損を誤表示しない", () => {
  const status = deriveAdminV3GameProgressStatus({
    game: { gameDate: "2026-09-12" },
    now: "2026-09-12T09:07:00.000Z",
    workflowState: "scored",
    lineup: { available: false, canonicalFinalRevisionValid: false, finalizedValid: false },
    scoring: { ready: true, scoringRevisionId: "score-a" },
    ranking: { reflected: false },
    canonicalArtifacts: {
      available: true,
      lineup: { canonicalFinalRevisionId: "game-1:1", lineupValid: true, lineupReady: true },
      scoring: { activeScoringRevisionId: "score-a", valid: true },
      ranking: { reflected: false, valid: false },
      publication: { valid: false },
      aggregate: {
        lineupReady: true,
        scoringReady: true,
        rankingReady: false,
        publicationReady: false,
        artifactMismatch: false,
        needsAttention: true,
        reprocessingRequired: true
      }
    }
  });
  assert.notEqual(status.reason, "canonical正式スタメンまたは検証済みrevisionを確認できません。");
  assert.equal(status.key, "reprocessing");
  assert.equal(status.stage, "ranking_reflect");
});

test("canonical evaluatorが利用可能でも進行済み試合のrevision欠損は要対応にする", () => {
  const status = deriveAdminV3GameProgressStatus({
    game: { gameDate: "2026-09-12" },
    workflowState: "scored",
    canonicalArtifacts: {
      available: true,
      lineup: { canonicalFinalRevisionId: null, lineupValid: false },
      scoring: { activeScoringRevisionId: "score-a", valid: true },
      ranking: { reflected: false, valid: false },
      publication: { valid: false },
      aggregate: { lineupReady: false, scoringReady: true, rankingReady: false, publicationReady: false }
    }
  });
  assert.equal(status.key, "needs_attention");
  assert.equal(status.stage, "lineup");
});

test("V4正式工程は既存の完了時刻だけを表示データへ引き継ぐ", () => {
  const status = buildAdminV4Status({
    game: { gameDate: "2026-09-12", createdAt: "2026-09-01T00:00:00.000Z" },
    persistedState: "published",
    automationMode: { mode: "v4_semi_auto", isV4SemiAuto: true },
    canonicalArtifacts: {
      available: true,
      lineup: { canonicalFinalRevisionId: "game-1:1", lineupValid: true, lineupReady: true, finalizedAt: "2026-09-12T09:03:00.000Z" },
      scoring: { activeScoringRevisionId: "score-a", valid: true, completed: true, completedAt: "2026-09-12T09:04:00.000Z" },
      ranking: { reflectedRevisionId: "score-a", reflected: true, valid: true, reflectedAt: "2026-09-12T09:05:00.000Z" },
      publication: { publicationStatus: "published", valid: true, publishedAt: "2026-09-12T09:06:00.000Z" },
      aggregate: { lineupReady: true, scoringReady: true, rankingReady: true, publicationReady: true, fullyPublished: true }
    },
    jobs: [
      { job_type: "probable_starter_fetch", status: "completed", completed_at: "2026-09-12T08:00:00.000Z" },
      { job_type: "prediction_close", status: "completed", completed_at: "2026-09-12T08:01:00.000Z" }
    ]
  });
  assert.equal(status.stages.schedule.completedAt, "2026-09-01T00:00:00.000Z");
  assert.equal(status.stages.probable_starter.completedAt, "2026-09-12T08:00:00.000Z");
  assert.equal(status.stages.prediction_close.completedAt, "2026-09-12T08:01:00.000Z");
  assert.equal(status.stages.lineup_finalize.completedAt, "2026-09-12T09:03:00.000Z");
  assert.equal(status.stages.score.completedAt, "2026-09-12T09:04:00.000Z");
  assert.equal(status.stages.ranking.completedAt, "2026-09-12T09:05:00.000Z");
  assert.equal(status.stages.publish.completedAt, "2026-09-12T09:06:00.000Z");
});

test("未完了工程に完了時刻を推測して付与しない", () => {
  const status = buildAdminV4Status({
    game: { gameDate: "2026-09-12" },
    persistedState: "scored",
    automationMode: { mode: "v4_semi_auto", isV4SemiAuto: true },
    canonicalArtifacts: {
      available: true,
      lineup: { canonicalFinalRevisionId: "game-1:1", lineupValid: true, lineupReady: true },
      scoring: { activeScoringRevisionId: null, valid: false, reason: "ACTIVE_SCORING_REVISION_MISSING" },
      ranking: { valid: false, reason: "RANKING_REFLECTION_MISSING" },
      publication: { valid: false, reason: "PUBLICATION_NOT_COMPLETED" },
      aggregate: { lineupReady: true, scoringReady: false, rankingReady: false, publicationReady: false }
    },
    jobs: []
  });
  assert.equal(Object.hasOwn(status.stages.score, "completedAt"), false);
  assert.equal(Object.hasOwn(status.stages.ranking, "completedAt"), false);
  assert.equal(Object.hasOwn(status.stages.publish, "completedAt"), false);
});

test("publication readyはゲーム一覧の実在publishedAtを完了時刻fallbackとして表示する", () => {
  const publishedAt = "2026-09-12T09:06:00.000Z";
  const status = buildAdminV4Status({
    game: { gameDate: "2026-09-12", publishedAt },
    persistedState: "published",
    automationMode: { mode: "v4_semi_auto", isV4SemiAuto: true },
    canonicalArtifacts: {
      available: true,
      lineup: { lineupReady: true },
      scoring: { valid: true },
      ranking: { valid: true },
      publication: { publicationStatus: "published", valid: true, publishedAt: null },
      aggregate: { lineupReady: true, scoringReady: true, rankingReady: true, publicationReady: true }
    },
    jobs: []
  });
  assert.equal(status.stages.publish.key, "complete");
  assert.equal(status.stages.publish.completedAt, publishedAt);
});

test("publication pendingまたはtimestamp nullでは完了時刻を表示しない", () => {
  const status = buildAdminV4Status({
    game: { gameDate: "2026-09-12", publishedAt: null },
    persistedState: "published",
    automationMode: { mode: "v4_semi_auto", isV4SemiAuto: true },
    canonicalArtifacts: {
      available: true,
      publication: { publicationStatus: "ready", valid: false, publishedAt: null },
      aggregate: { lineupReady: true, scoringReady: true, rankingReady: true, publicationReady: false }
    },
    jobs: []
  });
  assert.equal(Object.hasOwn(status.stages.publish, "completedAt"), false);
});

test("V4新規statusは固定start+10分のranking/publication予定を生成しない", () => {
  const status = buildAdminV4Status({
    game: { gameDate: "2026-09-12", startAt: "2026-09-12T09:00:00.000Z" },
    persistedState: "scored",
    automationMode: { mode: "v4_semi_auto", isV4SemiAuto: true },
    schedule: {
      startAt: "2026-09-12T09:00:00.000Z",
      scoringEarliestAt: "2026-09-12T09:02:00.000Z",
      rankingEarliestAt: "2026-09-12T09:10:00.000Z",
      publicationAt: "2026-09-12T09:10:00.000Z"
    },
    canonicalArtifacts: {
      available: true,
      lineup: { lineupReady: true },
      scoring: { valid: true },
      ranking: { valid: false, reason: "RANKING_REFLECTION_MISSING" },
      publication: { valid: false, reason: "PUBLICATION_NOT_COMPLETED" },
      aggregate: { lineupReady: true, scoringReady: true, rankingReady: false, publicationReady: false }
    },
    jobs: []
  });
  assert.equal(status.schedule.rankingEarliestAt, null);
  assert.equal(status.schedule.publicationAt, null);
  assert.equal(Object.hasOwn(status.stages.ranking, "scheduledAt"), false);
  assert.equal(Object.hasOwn(status.stages.publish, "scheduledAt"), false);
});

test("V4の旧job由来の予定時刻は履歴としてのみ残る", () => {
  const historicalDueAt = "2026-09-12T09:10:00.000Z";
  const status = buildAdminV4Status({
    game: { gameDate: "2026-09-12" },
    persistedState: "scored",
    automationMode: { mode: "v4_semi_auto", isV4SemiAuto: true },
    canonicalArtifacts: {
      available: true,
      lineup: { lineupReady: true },
      scoring: { valid: true },
      ranking: { valid: false, reason: "RANKING_REFLECTION_MISSING" },
      publication: { valid: false, reason: "PUBLICATION_NOT_COMPLETED" },
      aggregate: { lineupReady: true, scoringReady: true, rankingReady: false, publicationReady: false }
    },
    jobs: [{ job_type: "ranking_rebuild", status: "pending", scheduled_at: historicalDueAt }]
  });
  assert.equal(status.stages.ranking.scheduledAt, historicalDueAt);
  assert.equal(status.schedule.rankingEarliestAt, null);
  assert.equal(status.schedule.publicationAt, null);
});

test("admin-v3 workflow view uses V4 status markup and removes shadow/manual recovery controls", () => {
  const renderer = read("frontend/admin-v3/render-game-progress.js");
  const workflow = renderer.slice(renderer.indexOf("function renderWorkflowView"), renderer.indexOf("function renderLineupView"));
  assert.match(renderer, /renderV4CanonicalStatus/);
  assert.match(renderer, /data-v4-canonical-status/);
  assert.match(renderer, /formal job/);
  assert.doesNotMatch(renderer, /V3\.5|V35|shadow|renderManualControls|data-v3-job-run|data-v3-state-reconcile/);
  assert.doesNotMatch(workflow, /renderWorkflowDiagnostics\(game\)/);
  assert.doesNotMatch(workflow, /renderTimeline\(game\)/);
  assert.doesNotMatch(workflow, /次の処理: <strong>/);
});

test("V4 workflow view does not render legacy roster or auto-lineup scheduling copy", () => {
  const context = { window: {}, Intl, Date };
  vm.createContext(context);
  vm.runInContext(read("frontend/admin-v3/render-game-progress.js"), context);
  const renderer = context.window.Starting9AdminV3.createAdminV3GameProgressRenderer({
    escapeHtml: (value) => String(value ?? ""),
    formatJst: (value) => String(value || "-"),
    renderSelectedGameHeader: (_game, title) => `<header>${title}</header>`,
    npbIdentityDisplay: () => ({ jobStatus: "resolved", code: "2026091201" }),
    renderJobRows: (_game, types) => `<div data-job-types="${types.join(",")}"></div>`,
    jobTypes: ["npb_identity_resolve", "probable_starter_fetch", "prediction_close", "roster_fetch", "lineup_fetch", "lineup_finalize", "score", "ranking_rebuild", "publish"]
  });
  const html = renderer.renderWorkflowView({
    state: { state: "scheduled" },
    v4Status: {
      persistedState: "scheduled",
      currentStatus: { key: "scheduled", label: "予定", reason: "未来試合です。" },
      stages: {
        roster: { key: "manual", label: "手動運用", reason: "V4ではロースターを手動確認します。" },
        lineup_finalize: { key: "wait", label: "手動確定待ち", reason: "手動確定待ち / 試合当日の確認前" },
        score: { key: "wait", label: "正式スタメン確定待ち", reason: "正式スタメン確定待ち" },
        ranking: { key: "wait", label: "待機", reason: "採点完了待ち" },
        publish: { key: "wait", label: "待機", reason: "ランキング反映待ち" }
      }
    }
  });
  assert.match(html, /手動確定待ち \/ 試合当日の確認前/);
  assert.doesNotMatch(html, /ロースター取得/);
  assert.doesNotMatch(html, /スタメン取得/);
  assert.doesNotMatch(html, /最新候補を開始2分後に確定/);
  assert.doesNotMatch(html, /次の処理:/);
  assert.doesNotMatch(html, /roster_fetch|lineup_fetch/);
});

test("V4 workflow view renders actual completion time when supplied", () => {
  const context = { window: {}, Intl, Date };
  vm.createContext(context);
  vm.runInContext(read("frontend/admin-v3/render-game-progress.js"), context);
  const renderer = context.window.Starting9AdminV3.createAdminV3GameProgressRenderer({
    escapeHtml: (value) => String(value ?? ""),
    formatJst: (value) => String(value || "-"),
    renderSelectedGameHeader: () => "",
    npbIdentityDisplay: () => ({}),
    renderJobRows: () => "",
    jobTypes: []
  });
  const html = renderer.renderWorkflowView({
    state: { state: "published" },
    v4Status: {
      persistedState: "published",
      currentStatus: { key: "completed", label: "完了", reason: "公開済みです。" },
      stages: {
        schedule: { key: "complete", label: "完了", completedAt: "2026-09-12T00:00:00.000Z" },
        publish: { key: "complete", label: "完了", completedAt: "2026-09-12T09:06:00.000Z" }
      }
    }
  });
  assert.match(html, /完了: 2026-09-12T09:06:00.000Z/);
});

test("admin-v3 page identifies the official V4 operations surface", () => {
  const page = read("admin-v3.html");
  assert.match(page, /Starting9 正式運用V4/);
  assert.match(page, /GAME OPERATIONS V4/);
  assert.match(page, /v4-canonical-status-1/);
  assert.doesNotMatch(page, /v35|V3\.5/);
});
