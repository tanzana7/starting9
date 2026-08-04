import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerUrl = pathToFileURL(path.join(root, "auth-worker.js")).href;

const uuid = "12d554bb-ad25-44be-8159-0134c046dcee";
const current = {
  internalGameId: uuid,
  gameId: "2026-08-04-fighters-hawks-1800",
  gameDate: "2026-08-04",
  startAt: "2026-08-04T09:00:00.000Z",
  homeTeam: "hawks",
  awayTeam: "fighters",
  gameStatus: "completed",
  workflowStatus: "retrying"
};

test("試合開始後も未公開workflowを未来試合よりcurrentへ優先する", async () => {
  const { selectCurrentManagedGame } = await import(workerUrl);
  const selected = selectCurrentManagedGame([
    current,
    {
      internalGameId: "22d554bb-ad25-44be-8159-0134c046dcee",
      gameId: "2026-08-05-fighters-hawks-1800",
      gameDate: "2026-08-05",
      startAt: "2026-08-05T09:00:00.000Z",
      homeTeam: "hawks",
      awayTeam: "fighters",
      gameStatus: "scheduled",
      workflowStatus: "waiting"
    }
  ], new Date("2026-08-04T09:16:00.000Z"));
  assert.equal(selected.internalGameId, uuid);
  assert.equal(selected.selectionReason, "TODAY_INCOMPLETE_GAME");
});

test("published後は未来試合へ切り替え、直近48時間の未完了も候補にする", async () => {
  const { selectCurrentManagedGame } = await import(workerUrl);
  const selectedFuture = selectCurrentManagedGame([
    { ...current, workflowStatus: "published", gameStatus: "completed" },
    { ...current, internalGameId: "42d554bb-ad25-44be-8159-0134c046dcee", gameId: "2026-08-05-fighters-hawks-1800", gameDate: "2026-08-05", startAt: "2026-08-05T09:00:00.000Z", gameStatus: "scheduled", workflowStatus: "waiting" }
  ], new Date("2026-08-04T09:16:00.000Z"));
  assert.equal(selectedFuture.gameId, "2026-08-05-fighters-hawks-1800");

  const selectedRecent = selectCurrentManagedGame([
    { ...current, gameDate: "2026-08-03", startAt: "2026-08-03T09:00:00.000Z", gameStatus: "completed", workflowStatus: "retrying" },
    { ...current, internalGameId: "52d554bb-ad25-44be-8159-0134c046dcee", gameId: "2026-08-06-fighters-hawks-1800", gameDate: "2026-08-06", startAt: "2026-08-06T09:00:00.000Z", gameStatus: "scheduled", workflowStatus: "waiting" }
  ], new Date("2026-08-04T09:16:00.000Z"));
  assert.equal(selectedRecent.selectionReason, "RECENT_UNCOMPLETED_GAME");
});

test("NPBコードはgames、registry、detected schedule、既存安全resolverの順で解決する", async () => {
  const { validateWorkflowJobTarget } = await import(workerUrl);
  const base = {
    internalGameId: uuid,
    gameRow: {
      game_date: "2026-08-04",
      start_time: "2026-08-04T09:00:00.000Z",
      home_team: "hawks",
      away_team: "fighters",
      game_status: "completed",
      npb_game_code: "h-f-15"
    },
    scheduleRows: [{ game_id: current.gameId, game_date: current.gameDate, start_at: current.startAt, home_team: "hawks", away_team: "fighters", game_code: null }],
    identifiers: [{ provider: "npb", identifier_type: "npb_game_code", identifier_value: "wrong-99" }]
  };
  const fromGames = validateWorkflowJobTarget(base);
  assert.equal(fromGames.valid, true);
  assert.equal(fromGames.target.gameCode, "h-f-15");
  assert.equal(fromGames.target.targetResolution.resolvedBy, "games.npb_game_code");

  const fromIdentifier = validateWorkflowJobTarget({ ...base, gameRow: { ...base.gameRow, npb_game_code: null }, identifiers: [{ provider: "npb", identifier_type: "npb_game_code", identifier_value: "h-f-15" }] });
  assert.equal(fromIdentifier.target.gameCode, "h-f-15");
  assert.equal(fromIdentifier.target.targetResolution.resolvedBy, "game_identifiers");

  const fromSchedule = validateWorkflowJobTarget({ ...base, gameRow: { ...base.gameRow, npb_game_code: null }, identifiers: [], scheduleRows: [{ ...base.scheduleRows[0], game_code: "h-f-15" }] });
  assert.equal(fromSchedule.target.gameCode, "h-f-15");
  assert.equal(fromSchedule.target.targetResolution.resolvedBy, "detected_game_schedule");
});

test("異なるNPBコードは安全停止し、公式コードなしでは推測URLへ進まない", async () => {
  const { validateWorkflowJobTarget } = await import(workerUrl);
  const result = validateWorkflowJobTarget({
    internalGameId: uuid,
    gameRow: { game_date: "2026-08-04", start_time: "2026-08-04T09:00:00.000Z", home_team: "hawks", away_team: "fighters", game_status: "completed" },
    scheduleRows: [{ game_id: current.gameId, game_date: current.gameDate, start_at: current.startAt, home_team: "hawks", away_team: "fighters", game_code: "h-f-15" }],
    identifiers: [{ provider: "npb", identifier_type: "npb_game_code", identifier_value: "h-f-16" }]
  });
  assert.equal(result.valid, false);
  assert.equal(result.code, "NPB_GAME_CODE_CONFLICT");

  const noCode = validateWorkflowJobTarget({
    internalGameId: uuid,
    gameRow: { game_date: "2026-08-04", start_time: "2026-08-04T09:00:00.000Z", home_team: "hawks", away_team: "fighters", game_status: "completed" },
    scheduleRows: [{ game_id: current.gameId, game_date: current.gameDate, start_at: current.startAt, home_team: "hawks", away_team: "fighters", game_code: null }]
  });
  assert.equal(noCode.valid, true);
  assert.equal(noCode.target.gameCode, "");
});

test("古いcurrent errorではなくactive jobの最新エラーを表示する", () => {
  const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
  const observation = worker.slice(worker.indexOf("function buildCurrentWorkflowObservation"), worker.indexOf("async function handleAdminCurrentGameWorkflow"));
  assert.match(observation, /currentErrorJob\?\.errorCode \|\| selection\.lastErrorCode/);
  assert.match(observation, /currentErrorJob\?\.errorDetail \|\| ""/);
  assert.match(observation, /latestJobsByType/);
});

test("cleanup SQLはPlan A/Bを分離し、未来試合・users・認証を対象にしない", () => {
  const sql = fs.readFileSync(path.join(root, "maintenance/legacy-game-data-cleanup-20260804.sql"), "utf8");
  assert.match(sql, /DRY RUN: SELECT ONLY/);
  assert.match(sql, /PLAN A: operational\/workflow\/log data only/);
  assert.match(sql, /PLAN B: Plan A plus predictions, scoring, ranking and publication data/);
  assert.match(sql, /game_date <= '2026-08-04'/);
  assert.doesNotMatch(sql, /game_date > '2026-08-04'[^\n]*DELETE/);
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+(users|sessions|admin_accounts)\s*;/i);
  assert.doesNotMatch(sql, /DROP\s+TABLE|wrangler\s+d1\s+execute\s+--remote/i);
  assert.match(sql, /future_games_touched/);
  assert.match(sql, /orphan_identifiers/);
});
