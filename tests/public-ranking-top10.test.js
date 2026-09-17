import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rendererSource = fs.readFileSync(path.join(root, "frontend", "public", "render-ranking.js"), "utf8");
const indexSource = fs.readFileSync(path.join(root, "index.html"), "utf8");

function createRenderer(accountUser = null) {
  const elements = { rankingContent: { innerHTML: "" } };
  const context = vm.createContext({
    window: { Starting9Public: {} },
    document: { getElementById: (id) => elements[id] || null }
  });
  vm.runInContext(rendererSource, context, { filename: "render-ranking.js" });
  const renderer = context.window.Starting9Public.createPublicRankingRenderer({
    escapeHtml: (value) => String(value),
    getPredictionAccountUser: () => accountUser,
    formatRankingScore: (value) => String(value),
    formatParticipationRate: (value) => String(value),
    createRankingAchievementBadgesHtml: () => ""
  });
  return { renderer, elements };
}

function row(rank, username = `user-${rank}`, averageScore = 90) {
  return { rank, username, isQualified: true, averageScore, gamesPlayed: 10, eligibleGames: 10, gamesNeeded: 0, participationRate: 1, totalScore: 900, perfectCount: 1 };
}

test("public ranking keeps ranked entries through rank 10, including all rank-10 ties", () => {
  const { renderer } = createRenderer();
  const rows = [row(9, "ninth"), row(10, "tenth-a"), row(10, "tenth-b"), row(11, "eleventh"), row(12, "twelfth")];
  assert.deepEqual(renderer.filterRows(rows).map((entry) => entry.username), ["ninth", "tenth-a", "tenth-b"]);
});

test("public ranking requires qualification, raw average score floor, and Top 10 without changing stored ranks", () => {
  const { renderer } = createRenderer();
  const rows = [
    row(1, "exactly-forty", 40),
    row(2, "below-forty", 39.9),
    row(3, "rounds-to-forty", 39.999),
    row(10, "tenth-a", 75),
    row(10, "tenth-b", 40),
    row(11, "eleventh-high-score", 80),
    { ...row(null, "unqualified-forty", 40), isQualified: false },
    { ...row(null, "unqualified-below", 39.9), isQualified: false }
  ];
  assert.deepEqual(renderer.filterRows(rows).map((entry) => entry.username), [
    "exactly-forty",
    "tenth-a",
    "tenth-b"
  ]);
});

test("public ranking shows a score-floor empty state without changing personal results", () => {
  const { renderer, elements } = createRenderer({ username: "self" });
  renderer.renderContent(
    { isLoading: false, summary: { eligibleGames: 3, requiredGames: 2 }, rows: [row(1, "below", 39.999)], self: row(1, "self", 39.999), isLoadingSelf: false, message: "" },
    { selfTitle: "自分", emptyMessage: "空", hideIneligibleRankings: false }
  );
  assert.match(elements.rankingContent.innerHTML, /ランキング掲載条件を満たすユーザーはまだいません/);
  assert.match(elements.rankingContent.innerHTML, /平均39\.999点/);
});

test("public ranking keeps fewer-than-ten ranked participants and omits unqualified references", () => {
  const { renderer, elements } = createRenderer();
  const rows = [row(1, "first"), row(2, "second"), { ...row(null, "unqualified"), rank: null, isQualified: false, gamesNeeded: 2 }];
  renderer.renderContent(
    { isLoading: false, summary: { eligibleGames: 3, requiredGames: 2 }, rows, self: null, isLoadingSelf: false, message: "" },
    { selfTitle: "自分", emptyMessage: "空", hideIneligibleRankings: false }
  );
  assert.match(elements.rankingContent.innerHTML, /first/);
  assert.match(elements.rankingContent.innerHTML, /second/);
  assert.doesNotMatch(elements.rankingContent.innerHTML, /unqualified/);
  assert.doesNotMatch(elements.rankingContent.innerHTML, /規定未到達者を見る/);
  assert.doesNotMatch(elements.rankingContent.innerHTML, /eleventh/);
});

test("weekly/monthly/yearly public ranking uses the Top10 renderer cache buster without changing API fetch depth", () => {
  assert.match(indexSource, /frontend\/public\/render-ranking\.js\?v=public-compliance-disclaimer-and-fetch-safety-1&public-ranking-top10-1&public-ranking-average40-1&public-ranking-hide-unqualified-1/);
  const scriptSource = fs.readFileSync(path.join(root, "script.js"), "utf8");
  assert.match(scriptSource, /url\.searchParams\.set\("limit", String\(RANKING_DISPLAY_LIMIT\)\)/);
  assert.match(scriptSource, /const RANKING_DISPLAY_LIMIT = 50/);
});
