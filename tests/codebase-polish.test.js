const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("portfolio documentation describes the current V3 architecture and release boundary", () => {
  const architecture = read("docs/ARCHITECTURE.md");
  const checklist = read("docs/RELEASE_CHECKLIST.md");

  assert.match(architecture, /Game Automation V3/);
  assert.match(architecture, /games\.internal_game_id/);
  assert.match(architecture, /PublicAppCoordinator/);
  assert.match(checklist, /RELEASE_DEBUG_PERFECT_SCORE_FIXTURE/);
  assert.match(checklist, /ranking reset marker/);
  assert.match(checklist, /test accounts/);
});

test("the example Worker config documents V3 as an explicit opt-in", () => {
  const config = read("wrangler.auth.example.jsonc");

  assert.match(config, /"ENABLE_WORKFLOW_COMPLETION_JOBS"\s*:\s*"true"/);
  assert.match(config, /"ENABLE_GAME_AUTOMATION_V3"\s*:\s*"false"/);
});

test("public static assets use the current cache buster and no dead ranking wrapper remains", () => {
  const index = read("index.html");
  const script = read("script.js");

  assert.match(index, /script\.js\?v=public-previous-result-api-state-loading-1/);
  assert.doesNotMatch(script, /function\s+initializeYearlyRanking\s*\(/);
});
