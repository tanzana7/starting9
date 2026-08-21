import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const worker = read("auth-worker.js");
const script = read("script.js");
const renderer = read("frontend/public/render-results.js");
const html = read("index.html");

test("public result APIs expose cancellation and exclusion without score data", () => {
  const resultGamesStart = worker.indexOf("async function handleGetResultGames");
  const resultGameStart = worker.indexOf("async function handleGetResultGame(", resultGamesStart);
  const resultGames = worker.slice(resultGamesStart, resultGameStart);
  const resultGameEnd = worker.indexOf("async function getTableColumnSet", resultGameStart);
  const resultGame = worker.slice(resultGameStart, resultGameEnd);

  assert.match(resultGames, /gameStatus: row\.game_status/);
  assert.match(resultGames, /resultAvailability: excluded/);
  assert.match(resultGames, /score: !excluded && resultsPublished/);
  assert.match(resultGame, /resultAvailability: serviceUnavailable \? "service_unavailable" : "excluded"/);
  assert.match(resultGame, /resultAvailability: "excluded"/);
  assert.match(resultGame, /score: null/);
  assert.match(resultGame, /actualLineup: null/);
  assert.match(resultGame, /この試合は予想・採点・ランキングの対象外です。/);
});

test("previous result selection keeps an unavailable game distinguishable from unpublished", () => {
  const start = worker.indexOf("async function handleGetPreviousResultGame");
  const end = worker.indexOf("async function handleGetProbableStarter", start);
  const handler = worker.slice(start, end);

  assert.doesNotMatch(handler, /game_status NOT IN/);
  assert.match(handler, /const unavailable =/);
  assert.match(handler, /if \(!resultsPublished && !unavailable\) continue/);
  assert.match(handler, /state: unavailable \? "excluded" : "published"/);
  assert.match(handler, /rankingExcluded: unavailable/);
});

test("public UI renders a status card and suppresses normal result/canvas output", () => {
  assert.match(script, /function getPublicResultAvailability\(result\)/);
  assert.match(script, /この試合は中止になりました/);
  assert.match(script, /この試合は対象外です/);
  assert.match(script, /getPublicResultAvailability\(game\)/);
  assert.match(renderer, /result-unavailable-card/);
  assert.match(renderer, /const availability = deps\.getPublicResultAvailability/);
  assert.match(renderer, /if \(availability\) \{/);
  assert.match(renderer, /deps\.createPredictionSummary/);
  assert.doesNotMatch(renderer, /if \(displayedResult\.serviceUnavailable\)/);
  assert.match(renderer, /card\.classList\.toggle\("hidden", !isPublished \|\| Boolean\(unavailable\)\)/);
});

test("cancelled/excluded games stop prediction input and are labeled in history", () => {
  assert.match(script, /if \(editor\) editor\.classList\.toggle\("hidden", isScheduleGameUnavailable\(selectedGame\)\)/);
  assert.match(script, /const statusLabel = availability \? `［\$\{availability\.shortLabel\}］` : ""/);
  assert.match(script, /rankingExcluded === true/);
  assert.match(html, /public-roster-source-of-truth-1/);
});
