import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const admin = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
const gameProgress = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-game-progress.js"), "utf8");
const diagnostics = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-diagnostics.js"), "utf8");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const publicResults = fs.readFileSync(path.join(root, "backend", "domain", "public-results.js"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const publicResultsRenderer = fs.readFileSync(path.join(root, "frontend", "public", "render-results.js"), "utf8");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const adminPage = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");

function normalizeRevision(value) {
  const start = admin.indexOf("function normalizeV3List");
  const end = admin.indexOf("function v3StorageGet", start);
  const context = { input: value };
  vm.runInNewContext(`${admin.slice(start, end)}\nresult = normalizeV3RevisionList(input);`, context);
  return context.result;
}

test("admin-v3はrevision API wrapperと文字列化JSONを配列へ正規化する", () => {
  for (const value of [
    [{ revisionId: "r1" }],
    { ok: true, internalGameId: "game-1", revisions: [{ revisionId: "r1" }] },
    JSON.stringify({ revisions: [{ revisionId: "r1" }] })
  ]) {
    const normalized = normalizeRevision(value);
    assert.equal(normalized.unexpected, false);
    assert.equal(normalized.items.length, 1);
    assert.equal(normalized.items[0].revisionId, "r1");
  }
});

test("admin-v3はrevisionの欠損・不正shapeを局所的に扱い、詳細画面全体を落とさない", () => {
  for (const value of [undefined, null]) {
    const normalized = normalizeRevision(value);
    assert.equal(normalized.unexpected, false);
    assert.equal(normalized.items.length, 0);
  }
  for (const value of [{ revisionId: "r1" }, "not-json", "{}", { unexpected: true }]) {
    const normalized = normalizeRevision(value);
    assert.equal(normalized.unexpected, true);
    assert.equal(normalized.items.length, 0);
  }
  const lineupStart = gameProgress.indexOf("function renderLineupView");
  const lineupEnd = gameProgress.indexOf("function renderScoringView", lineupStart);
  const lineup = gameProgress.slice(lineupStart, lineupEnd);
  assert.match(lineup, /normalizeRevisionList\(details\.revisions\)/);
  assert.match(lineup, /REVISION_SHAPE_UNEXPECTED/);
});

test("admin-v3はjobsとstructured logsも共通の配列正規化を使う", () => {
  assert.match(admin, /v3ListItems\(game\?\.jobs, "jobs"\)/);
  const logsStart = diagnostics.indexOf("function renderAutomationLogs");
  const logs = diagnostics.slice(logsStart);
  assert.match(logs, /const gameRuns = listItems\(logs\.gameRuns, "gameRuns"\)/);
  assert.match(logs, /const jobTimeline = listItems\(logs\.jobTimeline, "jobTimeline"\)/);
  assert.match(admin, /const games = normalizeV3List\(payload\?\.games, "games"\)/);
});

test("公開結果はhome/away順の日本語labelと安全なpublished表示fieldを返す", () => {
  const labels = publicResults;
  assert.match(labels, /home && away \? `\$\{home\} vs \$\{away\}`/);
  const list = worker;
  assert.match(list, /ranking_games\.published_at/);
  assert.match(list, /resultStatus: resultsPublished \? "published"/);
  assert.match(list, /gameLabel: metadata\.displayLabel/);
  const detailStart = worker.indexOf("async function handleGetResultGame");
  const detailEnd = worker.indexOf("async function getTableColumnSet", detailStart);
  const detail = worker.slice(detailStart, detailEnd);
  assert.match(detail, /publishedAt: resultsPublished \? \(rankingState\?\.published_at \|\| null\) : null/);
  assert.match(detail, /totalScore: resultsPublished/);
});

test("通常画面は公開結果の読込中・失敗・完了を内部情報なしで分離する", () => {
  assert.match(script, /isDetailLoading: false/);
  assert.match(script, /detailError: ""/);
  assert.match(publicResultsRenderer, /結果を読み込み中です。/);
  assert.match(script, /結果を読み込めませんでした。時間をおいて再度お試しください。/);
  assert.match(publicResultsRenderer, /公開：\$\{deps\.formatPublicJstDateTime\(displayedResult\.publishedAt\)\}/);
  const historyStart = script.indexOf("function renderResultHistory");
  const historyEnd = script.indexOf("function buildCurrentPredictionApiUrl", historyStart);
  const history = script.slice(historyStart, historyEnd);
  assert.doesNotMatch(history, /game\.gameId/);
  assert.match(history, /data-result-history-toggle/);
  assert.match(history, /data-result-history-select/);
  assert.match(script, /return home && away \? `\$\{home\} vs \$\{away\}`/);
});

test("post-E2E表示修正のcache busterを更新し、旧手動操作を復活させない", () => {
  assert.match(index, /script\.js\?v=public-result-image-readability-balance-1/);
  assert.match(adminPage, /admin-v3\.js\?v=admin-v3-all-job-manual-controls-1/);
  assert.doesNotMatch(admin, /runAutoScoringNowButton/);
});
