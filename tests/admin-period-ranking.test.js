import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.join(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const worker = read("auth-worker.js");
const html = read("admin-v3.html");
const client = read("frontend/admin-v3/api-client.js");
const rendererSource = read("frontend/admin-v3/render-ranking.js");

test("期間別ランキングはadmin認証付きAPIへ移し、公開期間APIはデータを返さない", () => {
  assert.match(worker, /adminRankingRoute/);
  assert.match(worker, /async function handleAdminRanking[\s\S]*?requireAdminUser\(request, env, cors\)/);
  assert.match(worker, /async function handleAdminRanking[\s\S]*?getRankingForPeriod\(env\.AUTH_DB/);
  assert.match(worker, /async function handleAdminRanking[\s\S]*?publishedOnly: true,[\s\S]*?includeTestUsers: true/);
  assert.match(worker, /async function handleGetWeeklyRanking[\s\S]*?hiddenPublicRankingPeriodResponse/);
  assert.match(worker, /PUBLIC_RANKING_ADMIN_ONLY/);
  assert.match(worker, /Cache-Control", "private, no-store"/);
});

test("adminランキング画面は週間・月間・年間の切替と順位・ユーザー名・得点を持つ", () => {
  assert.match(html, /data-v3-view="ranking">ランキング/);
  assert.match(html, /frontend\/admin-v3\/render-ranking\.js\?v=admin-ranking-only-1/);
  assert.match(client, /getRanking\(periodType/);
  assert.match(client, /api\/admin\/rankings/);

  const context = { window: {}, Intl, Date };
  vm.createContext(context);
  vm.runInContext(rendererSource, context);
  const renderer = context.window.Starting9AdminV3.createAdminV3RankingRenderer();
  const markup = renderer.render({
    periodType: "weekly",
    periodKey: "2026-09-21",
    rows: [{ rank: 1, username: "alpha", averageScore: 91.25, totalScore: 91, gamesPlayed: 1, eligibleGames: 1 }],
    summary: { totalUsers: 1, eligibleGames: 1 },
    loading: false
  });
  assert.match(markup, /週間/);
  assert.match(markup, /alpha/);
  assert.match(markup, /91\.25/);
  assert.match(markup, /表示 1人 \/ 対象 1人/);
});
