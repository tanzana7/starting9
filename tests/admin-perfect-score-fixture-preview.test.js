import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const adminPreview = fs.readFileSync(path.join(root, "backend", "admin", "preview.js"), "utf8");
const admin = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
const perfectScoreRenderer = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-perfect-score-preview.js"), "utf8");
const adminPage = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
const publicPage = fs.readFileSync(path.join(root, "index.html"), "utf8");
const publicScript = fs.readFileSync(path.join(root, "script.js"), "utf8");
const v3Runtime = fs.readFileSync(path.join(root, "game-automation-v3.js"), "utf8");
const {
  buildReleaseDebugPerfectScoreFixtureLineup,
  buildReleaseDebugPerfectScoreFixturePreview
} = await import(pathToFileURL(path.join(root, "auth-worker.js")).href);

const expectedLineup = [
  ["西川", "2B"], ["中島", "C"], ["エドポロ", "SS"], ["リン", "RF"], ["山縣", "1B"],
  ["レイエス", "3B"], ["藤森", "LF"], ["宮崎", "DH"], ["マルティネス", "CF"]
];

test("RELEASE_DEBUG_PERFECT_SCORE_FIXTUREは指定された9人・打順・守備位置を持つ", () => {
  const lineup = buildReleaseDebugPerfectScoreFixtureLineup();
  assert.deepEqual(lineup.map((player) => [player.name, player.position]), expectedLineup);
  assert.deepEqual(lineup.map((player) => player.battingOrder), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(lineup.map((player) => player.playerId), [
    "debug_fixture_nishikawa",
    "debug_fixture_nakajima",
    "debug_fixture_edopolo",
    "debug_fixture_lin",
    "debug_fixture_yamagata",
    "debug_fixture_reyes",
    "debug_fixture_fujimori",
    "debug_fixture_miyazaki",
    "debug_fixture_martinez"
  ]);
});

test("fixture previewは同一fixtureの仮想正解・仮想予想を99点で返す", () => {
  const result = buildReleaseDebugPerfectScoreFixturePreview();
  assert.equal(result.fixtureKey, "release_full_score_debug_1");
  assert.equal(result.fixtureMode, true);
  assert.equal(result.productionWrite, false);
  assert.equal(result.score.total, 99);
  assert.deepEqual(result.score.counts, { player: 9, order: 9, position: 9, perfect: 9 });
  assert.deepEqual(result.breakdown.total, 99);
  assert.deepEqual(result.prediction.lineup, result.officialLineup);
});

test("fixture APIはadmin専用・previewOnly・D1 writeなしで、executeを持たない", () => {
  assert.match(worker, /RELEASE_DEBUG_PERFECT_SCORE_FIXTURE/);
  assert.match(worker, /mode === "fixture"/);
  assert.match(worker, /RELEASE_DEBUG_PERFECT_SCORE_FIXTURE_KEY_INVALID/);
  assert.match(worker, /requireAdminUser\(request, env, cors\)/);
  assert.match(worker, /buildAdminReadOnlyPreviewMetadata/);
  assert.match(adminPreview, /previewOnly: true/);
  assert.match(adminPreview, /fixtureMode: Boolean\(fixtureMode\)/);
  assert.match(adminPreview, /fixtureKey: fixtureMode \? fixtureKey : null/);
  assert.match(adminPreview, /productionWrite: false/);
  const start = worker.indexOf("async function handleAdminV3PerfectScorePreview");
  const end = worker.indexOf("async function recordV3AdminAudit", start);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(worker.slice(start, end), /INSERT|UPDATE|DELETE/);
  assert.doesNotMatch(worker, /perfect-score-test\/execute/);
});

test("固定fixtureはadmin-v3の本番assetと導線から除去され、正式previewだけが残る", () => {
  assert.doesNotMatch(admin, /RELEASE_DEBUG_PERFECT_SCORE_FIXTURE|fixtureKey|data-v3-perfect-score-fixture-preview/);
  assert.doesNotMatch(perfectScoreRenderer, /固定fixture|fixtureKey|data-v3-perfect-score-fixture-preview/);
  assert.match(perfectScoreRenderer, /data-v3-perfect-score-preview/);
  assert.match(adminPage, /admin-v3-v3-recovery-operations-1/);
  assert.doesNotMatch(publicPage, /RELEASE_DEBUG_PERFECT_SCORE_FIXTURE|perfect-score-test/);
  assert.doesNotMatch(publicScript, /RELEASE_DEBUG_PERFECT_SCORE_FIXTURE|perfect-score-test/);
  assert.doesNotMatch(v3Runtime, /RELEASE_DEBUG_PERFECT_SCORE_FIXTURE|perfect-score-test/);
  assert.doesNotMatch(admin, /data-v3-perfect-score-execute/);
});
