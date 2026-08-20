import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("0件または採点対象0件は採点完了として扱い、正式lineupなしは完了扱いにしない", async () => {
  const rules = await import(pathToFileURL(path.join(root, "game-scoring-ranking-v2.js")));
  assert.equal(rules.isScoringComplete({
    eligiblePredictionCount: 0,
    scoredPredictionCount: 0,
    excludedPredictionCount: 0,
    failedPredictionCount: 0
  }), true);
  assert.equal(rules.isScoringComplete({
    eligiblePredictionCount: 0,
    scoredPredictionCount: 0,
    excludedPredictionCount: 3,
    failedPredictionCount: 0
  }), true);

  const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
  const audit = fs.readFileSync(path.join(root, "backend/automation-v3/audit.js"), "utf8");
  assert.match(worker, /V3_FINAL_LINEUP_REQUIRED/);
  assert.match(worker, /V3_SCORING_NO_PREDICTIONS/);
  assert.match(worker, /V3_SCORING_NO_ELIGIBLE_PREDICTIONS/);
  assert.match(worker, /status: noOpReason \? "no_op_success" : "scored"/);
  assert.match(audit, /eventType === "job" && noOpReason/);
});

test("採点no-opの監査結果を管理画面へ返し、公開条件へ接続する", () => {
  const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
  const admin = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
  const gameProgress = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-game-progress.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
  assert.match(worker, /event_type = 'scoring_no_op'/);
  assert.match(worker, /scoring: \{ \.\.\.completion, noOpReason \}/);
  assert.match(worker, /scoring_status = 'scored'/);
  assert.match(gameProgress, /data-v3-scoring-no-op/);
  assert.match(gameProgress, /予想0件または採点対象なし/);
  assert.match(html, /admin-v3-click-handlers-fix-1/);
});
