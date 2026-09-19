const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const adminHtml = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
const scriptCacheBuster = "public-single-game-1";
const moduleCacheBuster = "public-compliance-disclaimer-and-fetch-safety-1";
const appCoordinatorCacheBuster = `${moduleCacheBuster}-public-ranking-start-date-1`;
const playerDisplayCacheBuster = "public-player-display-1-batting-hand-player-number-1-player-details-1";
const fightersPlayerDetailsCacheBuster = "fighters-player-details-20260903-1";
const styleCacheBuster = "public-single-game-1-public-position-menu-left-clamp-1-bat-line-1-player-number-1-player-details-1-bat-line-row-accent-1-public-selected-highlight-1-public-ranking-unqualified-cleanup-1-public-prediction-height-15-1-public-save-button-layout-1-public-save-button-lower-1-public-save-button-mobile-spacing-1-cf-web-analytics-1-public-login-cta-1";

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
  assert.match(html, new RegExp(`script\\.js\\?v=${scriptCacheBuster}&user-save-auth-unavailable-fix-20260903.*public-ranking-start-date-1`));
  assert.match(html, new RegExp(`style\\.css\\?v=${styleCacheBuster}`));
  for (const match of html.matchAll(/frontend\/public\/[^\"']+\.js\?v=([^\"']+)/g)) {
    const expectedCacheBuster = match[0].startsWith("frontend/public/render-results.js?")
      ? "public-cancelled-result-date-display-1"
      : match[0].startsWith("frontend/public/analytics.js?")
        ? "cf-web-analytics-1"
      : match[0].startsWith("frontend/public/app-coordinator.js?")
        ? appCoordinatorCacheBuster
      : match[0].startsWith("frontend/public/fighters-player-details.js?")
        ? fightersPlayerDetailsCacheBuster
      : match[0].startsWith("frontend/public/player-display.js?")
        ? playerDisplayCacheBuster
        : moduleCacheBuster;
    const isPredictionForm = match[0].startsWith("frontend/public/prediction-form.js?");
    const isRankingRenderer = match[0].startsWith("frontend/public/render-ranking.js?");
    assert.equal(match[1], isPredictionForm
      ? `${moduleCacheBuster}&user-save-auth-unavailable-fix-20260903`
      : isRankingRenderer
        ? `${moduleCacheBuster}&public-ranking-top10-1&public-ranking-average40-1&public-ranking-hide-unqualified-1`
      : expectedCacheBuster);
  }
});
