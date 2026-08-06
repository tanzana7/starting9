import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

test("通常画面はV3対象のinternalGameIdを優先して保存済み予告先発を取得する", () => {
  assert.match(script, /const internalGameId = String\(game\?\.internalGameId \|\| \"\"\)\.trim\(\)/);
  assert.match(script, /\/api\/probable-starter\?internalGameId=/);
  assert.match(script, /const game = state\.probableStarter\.nextGame;/);
  assert.match(script, /const url = buildProbableStarterApiUrl\(game\)/);
  assert.match(script, /\/api\/probable-starter\?gameId=/);
});

test("予告先発APIはinternalGameIdで正規試合を解決し、同じprobable_starters行を読む", () => {
  assert.match(worker, /const suppliedInternalGameId = String\(params\.get\("internalGameId"\) \|\| ""\)\.trim\(\)/);
  assert.match(worker, /resolveApiGameReference\(env\.AUTH_DB, suppliedInternalGameId \|\| suppliedGameId\)/);
  assert.match(worker, /WHERE internal_game_id = \?1 OR \(internal_game_id IS NULL AND game_id = \?2\)/);
  assert.match(worker, /gameDate: metadata\.date \|\| game\.game_date \|\| ""/);
  assert.match(worker, /startAt: metadata\.startAt \|\| game\.start_at \|\| ""/);
  assert.match(worker, /homeProbableStarter:/);
  assert.match(worker, /awayProbableStarter:/);
  assert.match(worker, /state: probableStarter\?\.status \|\| "empty"/);
  assert.match(worker, /confirmed: Boolean\(probableStarter\?\.isConfirmed\)/);
});

test("APIの取得状態とV3保存元を通常画面へ返し、キャッシュを抑止する", () => {
  assert.match(worker, /source: row\.source \|\| \(row\.source_url \? "npb" : ""\)/);
  assert.match(worker, /lastFailureCode: errorCode/);
  assert.match(worker, /isConfirmed: status === "announced"/);
  assert.match(worker, /response\.headers\.set\("Cache-Control", "no-store"\)/);
  assert.match(script, /state\.predictionTargetGame = canonicalGame/);
  assert.match(script, /applyStoredProbableStarter\(result\.probableStarter, result\)/);
  assert.match(script, /status === "empty" \|\| status === "unannounced"/);
  assert.match(script, /function getProbableStarterReferenceDiagnostics\(selectedGame, response, httpStatus = 200\)/);
  assert.match(script, /GAME_REFERENCE_MISMATCH/);
  assert.match(script, /mismatches\.push\("HOME_TEAM_MISMATCH"\)/);
  assert.match(script, /getProbableStarterReferenceDiagnostics\(game, result, response\.status\)/);
});

test("通常画面はhome/awayをDB順で表示し、反転候補を一致扱いしない", () => {
  assert.match(script, /matchupLabel: `\$\{target\.homeTeam \|\| ""\} vs \$\{target\.awayTeam \|\| ""\}`/);
  assert.match(script, /function matchProbableStarterGame\(nextGame, games\)/);
  assert.match(script, /return null;\r?\n}\r?\n\r?\nfunction normalizeScheduleTeamCode/);
  assert.doesNotMatch(script, /const teams = new Set\(\[normalizeScheduleTeamCode\(game\.homeTeam\)/);
  assert.match(script, /game_reference_mismatch: "error-message"/);
});

test("script.jsの表示接続変更に対応するキャッシュバスターが更新されている", () => {
  assert.match(html, /script\.js\?v=admin-test-data-20260728-9/);
});
