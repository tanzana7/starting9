const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const adminHtml = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
const cacheBuster = "public-scoreboard-ui-refresh-1";

test("通常公開HTMLに旧admin・緊急復旧・test markupを含めない", () => {
  for (const marker of [
    "adminDetails",
    "adminPregameTools",
    "adminTestDetails",
    "adminModeBadge",
    "openAdminButton",
    "openAdminV3Button",
    "actualForm",
    "adminServerScoringPanel",
    "adminManualRescorePanel",
    "gameIdentityRepairs",
    "pregame-automation"
  ]) {
    assert.doesNotMatch(html, new RegExp(marker));
  }
  assert.doesNotMatch(html, /admin-test-data/);
  assert.match(html, /id="predictionForm"/);
  assert.match(html, /id="predictionPlayers"/);
  assert.match(html, /id="savedPrediction"/);
  assert.match(html, /id="resultHistory"/);
  assert.match(html, /id="dailyBestNineCard"/);
  assert.match(html, /id="rankingPanel"/);
  assert.match(html, /id="gameDayNoticeStatus"/);
});

test("公開scriptから旧admin操作・テストデータ生成・手動復旧処理を切り離す", () => {
  for (const marker of [
    "openAdminPanel",
    "refreshAdminAccess",
    "runServerScoring",
    "runManualRescoreRequest",
    "runPregameAutomationAction",
    "executeGameIdentityRepair",
    "generateTestPrediction",
    "resetAllData",
    "adminServerScoring",
    "adminGameIdentityRepairs"
  ]) {
    assert.doesNotMatch(script, new RegExp(`(?:function\\s+|\\b)${marker}`));
  }
  assert.match(script, /new publicFrontend\.PublicAppCoordinator/);
  assert.doesNotMatch(script, /window\.confirm\([^)]*(?:管理者|テスト|復旧)/);
});

test("admin-v3の運用画面は公開bundleと分離して残る", () => {
  assert.match(adminHtml, /admin-v3/);
  assert.match(adminHtml, /ranking/i);
});

test("公開静的scriptとmoduleのcache busterを統一する", () => {
  assert.match(html, new RegExp(`script\\.js\\?v=${cacheBuster}`));
  assert.match(html, new RegExp(`style\\.css\\?v=${cacheBuster}`));
  for (const match of html.matchAll(/frontend\/public\/[^\"']+\.js\?v=([^\"']+)/g)) {
    assert.equal(match[1], cacheBuster);
  }
});
