import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const worker = read("auth-worker.js");
const scoring = read("backend/domain/scoring.js");
const preview = read("backend/admin/preview.js");
const admin = read("admin-v3.js");
const renderer = read("frontend/admin-v3/render-perfect-score-preview.js");

test("正式リリースbundleからrelease debug perfect-score fixtureを除去する", () => {
  for (const source of [worker, scoring, preview, admin, renderer]) {
    assert.doesNotMatch(source, /RELEASE_DEBUG_PERFECT_SCORE_FIXTURE|release_full_score_debug_1|debug_fixture_/);
  }
});

test("満点previewは確定済み正式スタメンだけを使うread-only経路として残す", () => {
  assert.match(worker, /\/api\/admin\/v3\/perfect-score-test\/preview/);
  assert.match(worker, /mode !== "perfect"/);
  assert.match(worker, /getV3LineupRevisionRows/);
  assert.match(worker, /finalRevision = revisions\.find/);
  assert.match(worker, /officialLineup: actualResult\.lineup/);
  assert.doesNotMatch(worker, /mode === "fixture"|fixtureKey|perfect-score-test\/execute/);
  assert.doesNotMatch(worker.slice(worker.indexOf("async function handleAdminV3PerfectScorePreview"), worker.indexOf("async function handleAdminV3ManualGamePreview")), /INSERT|UPDATE|DELETE/);
  assert.match(preview, /previewOnly: true/);
  assert.match(preview, /productionWrite: false/);
  assert.doesNotMatch(preview, /fixtureMode|fixtureKey/);
  assert.match(renderer, /data-v3-perfect-score-preview/);
});
