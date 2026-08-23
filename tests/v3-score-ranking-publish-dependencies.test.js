import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const v3 = await import(pathToFileURL(path.join(root, "game-automation-v3.js")));
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const admin = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-game-progress.js"), "utf8");
const html = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");

const game = {
  internalGameId: "b0c9cf20-3df8-4d6f-9809-a8656c6463a7",
  gameDate: "2026-08-09",
  startAt: "2026-08-09T05:00:00.000Z"
};

test("採点が未完了ならranking/publishは前提待ちとして正規化される", () => {
  const ranking = v3.deriveV3PhaseStatus({
    phase: "ranking",
    game,
    workflowState: "scored",
    jobs: [{ job_type: "ranking_rebuild", status: "retry_wait", failure_code: "V3_SCORING_INCOMPLETE" }]
  });
  assert.deepEqual(
    { severity: ranking.severity, label: ranking.label, reasonCode: ranking.reasonCode },
    { severity: "WAITING", label: "採点完了待ち", reasonCode: "V3_SCORING_INCOMPLETE" }
  );

  const publish = v3.deriveV3PhaseStatus({
    phase: "publish",
    game,
    workflowState: "scored",
    jobs: [{ job_type: "publish", status: "pending" }]
  });
  assert.deepEqual(
    { severity: publish.severity, label: publish.label, reasonCode: publish.reasonCode },
    { severity: "WAITING", label: "ランキング反映待ち", reasonCode: "V3_RANKING_INCOMPLETE" }
  );
});

test("main plannerはscore→ranking→publishのstate gateを越えてjobを作らない", () => {
  const at = new Date("2026-08-09T05:20:00.000Z");
  assert.deepEqual(v3.getV3DuePlans(game, "lineup_ready", at).map((plan) => plan.jobType), ["score"]);
  assert.deepEqual(v3.getV3DuePlans(game, "scored", at).map((plan) => plan.jobType), ["ranking_rebuild"]);
  assert.deepEqual(v3.getV3DuePlans(game, "ranked", at).map((plan) => plan.jobType), ["publish"]);
  assert.equal(v3.getV3TransitionDefinition("scored", "lineup_ready")?.triggeringJob, "ranking_rebuild");
});

test("V3 scoring uses canonical internal_game_id for predictions while claiming the stored lineup key", () => {
  assert.match(worker, /const canonicalLineup = await getGameLineup\(env\.AUTH_DB, \{ gameId: internalGameId, internalGameId \}\)/);
  assert.match(worker, /claimGameLineupForScoring\(env\.AUTH_DB, canonicalLineup\.game_id, now, \{ internalGameId \}\)/);
  assert.match(worker, /const predictionScopeColumn = internalGameId \? "internal_game_id" : "game_id"/);
  assert.match(worker, /const predictionScopeColumn = internalGameId && predictionsColumns\.has\("internal_game_id"\) \? "internal_game_id" : "game_id"/);
  assert.match(worker, /scoringStatusSet = predictionColumns\.has\("scoring_status"\) \? ", scoring_status = 'scored'"/);
  assert.match(worker, /scoring_status IN \('pending', 'failed', 'processing', 'scored'\)/);
  assert.match(worker, /status: "score_recovery_scheduled"/);
});

test("admin timeline uses phase status instead of treating prerequisite retry_wait as a failure", () => {
  assert.match(admin, /function timelinePhaseStep\(/);
  assert.match(admin, /timelinePhaseStep\("ランキング反映", game, "ranking"/);
  assert.match(admin, /timelinePhaseStep\("結果公開", game, "publish"/);
  assert.match(html, /admin-v3\.js\?v=admin-v3-v35-derived-diagnostics-1/);
});
