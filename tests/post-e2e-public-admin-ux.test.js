import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const admin = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
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
  const lineupStart = admin.indexOf("function renderLineupView");
  const lineupEnd = admin.indexOf("function renderScoringView", lineupStart);
  const lineup = admin.slice(lineupStart, lineupEnd);
  assert.match(lineup, /normalizeV3RevisionList\(details\.revisions\)/);
  assert.match(lineup, /REVISION_SHAPE_UNEXPECTED/);
});

test("admin-v3はjobsとstructured logsも共通の配列正規化を使う", () => {
  assert.match(admin, /v3ListItems\(game\?\.jobs, "jobs"\)/);
  const logsStart = admin.indexOf("function renderAutomationLogs");
  const logsEnd = admin.indexOf("function renderCurrentV3View", logsStart);
  const logs = admin.slice(logsStart, logsEnd);
  assert.match(logs, /const gameRuns = v3ListItems\(logs\.gameRuns, "gameRuns"\)/);
  assert.match(logs, /const jobTimeline = v3ListItems\(logs\.jobTimeline, "jobTimeline"\)/);
  assert.match(admin, /const games = normalizeV3List\(payload\?\.games, "games"\)/);
});

test("公開結果はhome/away順の日本語labelと安全なpublished表示fieldを返す", () => {
  const metadataStart = worker.indexOf("function createPublicResultDisplayLabel");
  const metadataEnd = worker.indexOf("async function getResultGameMetadata", metadataStart);
  const labels = worker.slice(metadataStart, metadataEnd);
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
  assert.match(script, /結果を読み込み中です。/);
  assert.match(script, /結果を読み込めませんでした。時間をおいて再度お試しください。/);
  assert.match(script, /公開：\$\{formatPublicJstDateTime\(state\.result\.publishedAt\)\}/);
  const historyStart = script.indexOf("function renderResultHistory");
  const historyEnd = script.indexOf("function buildCurrentPredictionApiUrl", historyStart);
  const history = script.slice(historyStart, historyEnd);
  assert.doesNotMatch(history, /game\.gameId/);
  assert.match(history, /data-result-game-id="\$\{escapeHtml\(gameId\)\}"/);
  assert.match(script, /return home && away \? `\$\{home\} vs \$\{away\}`/);
});

test("post-E2E表示修正のcache busterを更新し、旧手動操作を復活させない", () => {
  assert.match(index, /script\.js\?v=public-roster-source-freshness-1/);
  assert.match(adminPage, /admin-v3\.js\?v=automation-v3-19-post-e2e-admin-polish/);
  assert.doesNotMatch(admin, /runAutoScoringNowButton/);
});
