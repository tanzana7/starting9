const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createPublicRuntime } = require("./helpers/public-runtime.cjs");

const root = path.resolve(__dirname, "..");
const script = ["script.js", "frontend/public/probable-starter.js"]
  .map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");

async function displayFor(t, status) {
  const game = { internalGameId: "next", canonical: true, date: "2026-10-17", startTime: "18:00", homeTeam: "fighters", awayTeam: "eagles" };
  const app = createPublicRuntime({ ui: true, now: "2026-10-16T00:00:00Z", fetchImpl: async () => ({
    ok: true, status: 200, json: async () => ({ ok: true, internalGameId: game.internalGameId,
      gameDate: game.date, homeTeam: game.homeTeam, awayTeam: game.awayTeam,
      probableStarter: { status, homePitcherName: status === "announced" ? "投手A" : "", fetchedAt: "2026-10-16T01:00:00Z" } })
  }) });
  t.after(app.dispose);
  app.state.publicGameCatalog.games = [game];
  await app.operations.initializeProbableStarter();
  return app.elements.get("probableStarterDisplay");
}

test("予告先発は未発表と取得失敗を異なる案内として表示する", async (t) => {
  const pending = await displayFor(t, "unannounced");
  assert.match(pending.textContent, /予告先発 未発表/);
  assert.match(pending.textContent, /発表され次第、自動で表示されます。/);
  const failed = await displayFor(t, "error");
  assert.match(failed.textContent, /予告先発を取得できませんでした。/);
  assert.match(failed.textContent, /次回の自動更新で再試行します。/);
});

test("予告先発カードは発表済み・未発表・失敗で同じ表示領域を維持する", async (t) => {
  for (const [status, className] of [["announced", "is-success"], ["unannounced", "is-pending"], ["error", "is-error"]]) {
    const display = await displayFor(t, status);
    assert.equal(display.classList.contains("probable-starter-card"), true);
    assert.equal(display.classList.contains(className), true);
  }
  assert.match(css, /\.probable-starter-card[\s\S]*?min-height: 128px/);
  assert.match(css, /\.probable-starter-card\.is-error/);
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.probable-starter-card\.is-success[\s\S]*background: #214f7d/);
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.probable-starter-heading a[\s\S]*color: #f1d276/);
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.probable-starter-heading a[\s\S]*border-radius: 999px/);
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.probable-starter-card\.is-success[\s\S]*border-left-color: #c6ab64/);
});

test("予告先発カードはNPB公式ではなく汎用NPBase matchupsへリンクする", async (t) => {
  const display = await displayFor(t, "announced");
  assert.match(display.innerHTML, /href="https:\/\/npbase\.jp\/\?view=labo&tool=matchups&day=today&sort=average&order=desc"/);
  assert.match(display.textContent, /対予告先発成績を見る/);
  assert.match(display.innerHTML, /target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(display.innerHTML, />NPB公式<\/a>/);
});

test("公開トップの予告先発情報は更新時刻として表示する", async (t) => {
  const display = await displayFor(t, "announced");
  assert.match(display.textContent, /予告先発情報：2026\/10\/16 10:00 更新/);
  assert.doesNotMatch(display.textContent, /取得：/);
});

test("ブラウザは保存済みAPIだけを読み、NPB Workerのstarter取得を起動しない", () => {
  assert.match(script, /\/api\/probable-starter\?internalGameId=/);
  assert.doesNotMatch(script, /function buildProbableStarterWorkerRequestUrl\(/);
  assert.doesNotMatch(script, /searchParams\.set\("mode", "starter"\)/);
});

test("通常公開bundleから予告先発の管理者再取得処理を除去する", () => {
  assert.doesNotMatch(script, /buildAdminGameApiUrl|probable-starter\/refresh|method: "POST"/);
});
