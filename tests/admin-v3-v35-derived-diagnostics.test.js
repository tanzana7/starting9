import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
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
  assert.equal(status.stages.score.label, "要対応");
  assert.equal(status.stages.roster.label, "手動運用");
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

test("admin-v3 page identifies the official V4 operations surface", () => {
  const page = read("admin-v3.html");
  assert.match(page, /Starting9 正式運用V4/);
  assert.match(page, /GAME OPERATIONS V4/);
  assert.match(page, /v4-canonical-status-1/);
  assert.doesNotMatch(page, /v35|V3\.5/);
});
