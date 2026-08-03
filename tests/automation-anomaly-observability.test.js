import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("公式gameCode取得後も試合日・開始時刻・対戦カードで既存game_idを再利用する", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /createScheduleIdentityKey\(\{ date, startAt, homeTeam: game\.homeTeam, awayTeam: game\.awayTeam \}\)/);
  assert.match(worker, /existingRow: existingByIdentity\.get\(identityKey\) \|\| null/);
  assert.match(worker, /UPDATE detected_game_schedule[\s\S]*?WHERE game_id = \?8/);
  assert.doesNotMatch(worker, /String\(row\.game_id \|\| ""\) !== String\(game\.gameId \|\| ""\)/);
});

test("NPB URLは保存済みgame_codeをID由来のフォールバックより優先する", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /const storedGameCode = normalizeNpbGameCode\(timeline\.game\?\.gameCode\)/);
  assert.match(worker, /const gameCode = storedGameCode \|\| normalizeNpbGameCode\(fallback\.gameCode\) \|\| normalizeNpbGameCode\(idGameCode\)/);
  assert.match(worker, /LINEUP_URL_BUILD_FAILED/);
  assert.match(worker, /const isLineupStep = step === "lineup" \|\| step === "final_lineup"/);
});

test("フォールバックIDと静的日程の同一試合は一つに統合し、公式コードを補完する", async () => {
  const automation = await import(pathToFileURL(path.join(root, "pregame-automation.js")));
  automation.setDetectedScheduleGames([{
    gameId: "2026-07-31-fighters-marines-1800",
    date: "2026-07-31",
    startTime: "18:00",
    homeTeam: "fighters",
    awayTeam: "marines"
  }]);
  const games = automation.getScheduledGames().filter((game) => game.date === "2026-07-31" && game.homeTeam === "fighters" && game.awayTeam === "marines");
  assert.equal(games.length, 1);
  assert.equal(games[0].gameId, "2026-07-31-fighters-marines-1800");
  assert.equal(games[0].gameCode, "f-m-14");
  assert.equal(automation.getScheduledGame("2026-07-31-fighters-marines-1800").gameCode, "f-m-14");
  assert.ok(automation.getScheduledGame("2026-07-31-f-m-14"));

  automation.setDetectedScheduleGames([
    { ...games[0], gameCode: "" },
    { ...games[0], gameId: "2026-07-31-f-m-14", gameCode: "f-m-14" }
  ]);
  const legacyResolved = automation.getScheduledGame("2026-07-31-fighters-marines-1800");
  assert.equal(legacyResolved.gameId, "2026-07-31-fighters-marines-1800");
  assert.equal(legacyResolved.gameCode, "f-m-14");
});

test("正常な発表済みスキップは開始・終了ログの連打対象にならない", () => {
  const worker = read("auth-worker.js");
  const block = worker.match(/if \(selection\.reason === "already_announced"\) \{([\s\S]*?)\n  \}/)?.[1] || "";
  assert.match(block, /return \{ status: "already_announced"/);
  assert.doesNotMatch(block, /recordProbableStarterDecision/);
});

test("期限超過後は最終スタメン取得へ戻らずSCORING_RETRY_EXPIREDを一度だけ記録する", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /if \(isFinalPhase && isFinalLineupRetryExpired\(timeline, now\)\)/);
  assert.match(worker, /await recordScoringRetryExpiredOnce\(env\.AUTH_DB, timeline, now/);
  assert.match(worker, /next_lineup_attempt_at = NULL/);
});
