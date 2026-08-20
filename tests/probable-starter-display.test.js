const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");

test("予告先発は未発表と取得失敗を異なる案内として表示する", () => {
  assert.match(script, /status = "unannounced"/);
  assert.match(script, /function renderProbableStarterDisplay\(\)/);
  assert.match(script, /document\.getElementById\("probableStarterDisplay"\)/);
  assert.match(script, /probableStarter\.status === "unannounced"/);
  assert.match(script, /renderProbableStarterNotice\(container, "unannounced", probableStarter\.nextGame\)/);
  assert.match(script, /現在、次の試合の予告先発はまだ発表されていません。/);
  assert.match(script, /発表され次第、自動で表示されます。/);
  assert.match(script, /probableStarter\.status === "error"/);
  assert.match(script, /予告先発を取得できませんでした。/);
  assert.match(script, /次回の自動更新で再試行します。/);
});

test("予告先発カードは発表済み・未発表・失敗で同じ表示領域を維持する", () => {
  assert.match(script, /container\.className = "probable-starter-card is-success"/);
  assert.match(script, /container\.className = `probable-starter-card \$\{isError \? "is-error" : "is-pending"\}`/);
  assert.match(css, /\.probable-starter-card[\s\S]*?min-height: 128px/);
  assert.match(css, /\.probable-starter-card\.is-error/);
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.probable-starter-card\.is-success[\s\S]*background: #214f7d/);
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.probable-starter-heading a[\s\S]*color: #f1d276/);
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.probable-starter-heading a[\s\S]*border-radius: 999px/);
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.probable-starter-card\.is-success[\s\S]*border-left-color: #c6ab64/);
});

test("予告先発カードはNPB公式ではなく汎用NPBase matchupsへリンクする", () => {
  assert.match(script, /const NPBASE_MATCHUPS_URL = "https:\/\/npbase\.jp\/\?view=labo&tool=matchups&day=today&sort=average&order=desc"/);
  assert.match(script, /対予告先発成績を見る/);
  assert.match(script, /target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(script, />NPB公式<\/a>/);
  assert.match(script, /createProbableStarterHeadingHtml\(\)/);
});

test("公開トップの予告先発情報は更新時刻として表示する", () => {
  assert.doesNotMatch(script, /取得：\$\{escapeHtml\(formatDateTime\(probableStarter\.fetchedAt\)\)\}/);
  assert.match(script, /予告先発情報：\$\{escapeHtml\(formatDateTime\(probableStarter\.fetchedAt\)\)\} 更新/);
});

test("ブラウザは保存済みAPIだけを読み、NPB Workerのstarter取得を起動しない", () => {
  assert.match(script, /function buildProbableStarterApiUrl\(gameId\)/);
  assert.match(script, /\/api\/probable-starter\?gameId=/);
  assert.match(script, /fetchStoredProbableStarter\(\)/);
  assert.doesNotMatch(script, /function buildProbableStarterWorkerRequestUrl\(/);
  assert.doesNotMatch(script, /searchParams\.set\("mode", "starter"\)/);
});

test("通常公開bundleから予告先発の管理者再取得処理を除去する", () => {
  assert.doesNotMatch(script, /buildAdminGameApiUrl|probable-starter\/refresh|method: "POST"/);
  assert.match(script, /fetchStoredProbableStarter\(\)/);
});
