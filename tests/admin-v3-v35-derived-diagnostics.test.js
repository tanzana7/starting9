import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

test("admin-v3 overview attaches V3.5 derived diagnostics without changing V3 operations", () => {
  const worker = read("auth-worker.js");
  const overview = worker.slice(worker.indexOf("async function handleAdminV3Overview"), worker.indexOf("async function handleAdminV3IdentityResolve"));
  assert.match(worker, /import \{ adaptV35Input \} from \"\.\/backend\/automation-v3\/stage-health-adapter\.js\"/);
  assert.match(worker, /import \{ evaluateV35Automation \} from \"\.\/backend\/automation-v3\/stage-health-evaluator\.js\"/);
  assert.match(overview, /v35DerivedDiagnostics/);
  assert.doesNotMatch(overview, /transitionV3State\([^)]*v35|createV3Job\([^)]*v35/i);
});

test("V3.5 derived diagnostics exposes effective state, stages, warnings and source summary", () => {
  const worker = read("auth-worker.js");
  const helper = worker.slice(worker.indexOf("function buildV35AdminDerivedDiagnostics"), worker.indexOf("async function handleAdminV3Overview"));
  for (const field of ["adaptV35Input", "evaluateV35Automation", "effectiveState", "persistedState", "stateMismatch", "stages", "warnings", "sourceSummary"]) {
    assert.match(helper, new RegExp(field));
  }
});

test("admin-v3 renders V3.5 diagnostics as read-only stage health", () => {
  const renderer = read("frontend/admin-v3/render-game-progress.js");
  assert.match(renderer, /renderV35DerivedDiagnostics/);
  assert.match(renderer, /V3\.5診断（試験中・read-only）/);
  assert.match(renderer, /data-v35-derived-diagnostics/);
  assert.match(renderer, /effectiveState/);
  assert.match(renderer, /persistedState/);
  assert.match(renderer, /stateMismatch/);
  assert.match(renderer, /stageHealth/);
  assert.match(renderer, /scheduled（日程登録済み）/);
  assert.match(renderer, /状態:/);
  assert.match(renderer, /理由:/);
  assert.match(renderer, /対応:/);
  assert.match(renderer, /healthStatus/);
  assert.match(renderer, /recoveryReason/);
  assert.match(renderer, /V3\.5診断を取得できませんでした。現行V3の動作には影響ありません。/);
  assert.match(renderer, /if \(!diagnostics \|\| diagnostics\.enabled === false \|\| diagnostics\.status === "unavailable"\)/);
  assert.match(renderer, /renderV35DerivedDiagnostics\(game\)/);
  assert.match(renderer, /renderManualControls\(game\)/);
});

test("admin-v3 keeps the V3.5 stage order readable", () => {
  const renderer = read("frontend/admin-v3/render-game-progress.js");
  assert.ok(renderer.indexOf('schedule_registration: "日程登録"') < renderer.indexOf('npb_game_identify: "NPB識別"'));
  assert.ok(renderer.indexOf('npb_game_identify: "NPB識別"') < renderer.indexOf('probable_starter: "予告先発"'));
  assert.ok(renderer.indexOf('probable_starter: "予告先発"') < renderer.indexOf('roster_fetch: "ロースター取得"'));
  assert.ok(renderer.indexOf('roster_fetch: "ロースター取得"') < renderer.indexOf('prediction_close: "予想締切"'));
});

test("admin-v3 uses the V3.5 derived diagnostics cache buster", () => {
  const page = read("admin-v3.html");
  const expected = "admin-v3-v35-diagnostics-readability-1";
  assert.match(page, new RegExp(expected));
  assert.doesNotMatch(page, /admin-v3-ranking-status-labels-1/);
});
