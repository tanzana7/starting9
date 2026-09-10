import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
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

test("admin-v3 workflow view uses V4 status markup and removes shadow/manual recovery controls", () => {
  const renderer = read("frontend/admin-v3/render-game-progress.js");
  assert.match(renderer, /renderV4CanonicalStatus/);
  assert.match(renderer, /data-v4-canonical-status/);
  assert.match(renderer, /formal job/);
  assert.doesNotMatch(renderer, /V3\.5|V35|shadow|renderManualControls|data-v3-job-run|data-v3-state-reconcile/);
});

test("admin-v3 page identifies the official V4 operations surface", () => {
  const page = read("admin-v3.html");
  assert.match(page, /Starting9 正式運用V4/);
  assert.match(page, /GAME OPERATIONS V4/);
  assert.match(page, /v4-canonical-status-1/);
  assert.doesNotMatch(page, /v35|V3\.5/);
});
