const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const adminHtml = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
const scriptCacheBuster = "public-result-actual-lineup-basis-performance-1";
const moduleCacheBuster = "public-past-result-date-heading-1";
const styleCacheBuster = "public-beta-release-qa-fixes-1";

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

test("公開entry scriptのcache busterを更新し、既存moduleの読み込みを維持する", () => {
  assert.match(html, new RegExp(`script\\.js\\?v=${scriptCacheBuster}`));
  assert.match(html, new RegExp(`style\\.css\\?v=${styleCacheBuster}`));
  for (const match of html.matchAll(/frontend\/public\/[^\"']+\.js\?v=([^\"']+)/g)) {
    assert.equal(match[1], moduleCacheBuster);
  }
});
