import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const publicRanking = fs.readFileSync(path.join(root, "frontend", "public", "render-ranking.js"), "utf8");
const admin = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
const perfectScoreRenderer = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-perfect-score-preview.js"), "utf8");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const adminPreview = fs.readFileSync(path.join(root, "backend", "admin", "preview.js"), "utf8");
const page = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
const { buildPerfectScorePreview } = await import(pathToFileURL(path.join(root, "auth-worker.js")).href);

function officialLineup() {
  return [
    ["捕", "1"], ["一", "2"], ["二", "3"], ["三", "4"], ["遊", "5"],
    ["左", "6"], ["中", "7"], ["右", "8"], ["指", "9"]
  ].map(([position, uniformNumber], index) => ({
    battingOrder: index + 1,
    playerId: `F-${uniformNumber}`,
    playerName: `選手${uniformNumber}`,
    displayName: `選手${uniformNumber}`,
    teamCode: "fighters",
    teamId: "F",
    uniformNumber,
    position
  }));
}

test("ランキング見出しは自然な文言で、未到達者表示は内部切替で制御できる", () => {
  assert.doesNotMatch(script, /規定到達ランキング/);
  assert.match(publicRanking, /title\.textContent = "ランキング"/);
  assert.match(script, /RANKING_DISPLAY_OPTIONS = Object\.freeze\(\{ hideIneligibleRankings: false \}\)/);
  assert.match(publicRanking, /hideIneligibleRankings \? normalizedRows\.filter\(\(row\) => row\?\.isQualified\) : normalizedRows/);
  assert.match(publicRanking, /公開済み試合の参加状況と成績をもとにランキングを表示しています/);
  assert.match(publicRanking, /規定未到達/);
});

test("満点previewは正式スタメンと既存採点コアから99点を算出する", () => {
  const result = buildPerfectScorePreview(officialLineup());
  assert.equal(result.score.total, 99);
  assert.deepEqual(result.score.counts, { player: 9, order: 9, position: 9, perfect: 9 });
  assert.equal(result.breakdown.total, 99);
  assert.equal(result.prediction.schemaVersion, 1);
  assert.equal(result.prediction.lineup.length, 9);
});

test("満点preview APIはadmin認証、正式スタメン、読み取り専用の契約を持つ", () => {
  assert.match(worker, /\/api\/admin\/v3\/perfect-score-test\/preview/);
  assert.match(worker, /requireAdminUser\(request, env, cors\)/);
  assert.match(worker, /PERFECT_SCORE_LINEUP_REQUIRED/);
  assert.match(adminPreview, /database: false[\s\S]*predictions: false[\s\S]*ranking: false[\s\S]*publication: false/);
  assert.match(worker, /officialLineup: mode === "fixture" \? officialLineup : actualResult\.lineup/);
  assert.match(worker, /virtualPerfectPrediction: preview\.prediction/);
  const previewHandler = worker.slice(worker.indexOf("async function handleAdminV3PerfectScorePreview"), worker.indexOf("async function recordV3AdminAudit"));
  assert.doesNotMatch(previewHandler, /INSERT|UPDATE|DELETE/);
  assert.doesNotMatch(admin, /perfect-score-test\/execute/);
  assert.match(perfectScoreRenderer, /data-v3-perfect-score-preview/);
  assert.match(page, /public-roster-source-of-truth-1/);
});

test("満点previewは本番データ作成やランキングリセット実行を自動で行わない", () => {
  assert.match(perfectScoreRenderer, /本番予想、ランキング、公開結果、監査データは変更しません/);
  assert.doesNotMatch(perfectScoreRenderer, /data-v3-perfect-score-execute/);
  assert.doesNotMatch(worker, /perfect-score-test\/execute/);
});
