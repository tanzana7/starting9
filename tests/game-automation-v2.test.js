const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");

const root = path.resolve(__dirname, "..");

test("v2 schedule derives deadline, lineup polling, and finalization from the D1 startAt", async () => {
  const automation = await import(pathToFileURL(path.join(root, "game-automation-v2.js")).href);
  const schedule = automation.deriveAutomationSchedule({
    internalGameId: "12d554bb-ad25-44be-8159-0134c046dcee",
    gameDate: "2026-08-04",
    startAt: "2026-08-04T09:00:00.000Z",
    homeTeam: "hawks",
    awayTeam: "fighters",
    npbGameCode: "h-f-15"
  });
  assert.equal(schedule.predictionDeadline, "2026-08-04T08:00:00.000Z");
  assert.equal(schedule.rosterFetchAt1, "2026-08-04T07:00:00.000Z");
  assert.equal(schedule.rosterFetchAt2, "2026-08-04T07:10:00.000Z");
  assert.equal(schedule.lineupPollingStart, "2026-08-04T08:10:00.000Z");
  assert.equal(schedule.finalLineupAt, "2026-08-04T09:02:00.000Z");
  assert.equal(schedule.publicationAt, "2026-08-04T09:10:00.000Z");
  assert.equal(automation.getLineupPollingSlot(schedule, "2026-08-04T08:27:30.000Z"), "2026-08-04T08:20:00.000Z");
});

test("probable starter source date follows the JST display rule", async () => {
  const automation = await import(pathToFileURL(path.join(root, "game-automation-v2.js")).href);
  assert.equal(automation.getProbableStarterSourceDate({ now: "2026-08-04T08:59:00.000Z" }), "2026-08-04");
  assert.equal(automation.getProbableStarterSourceDate({ now: "2026-08-04T09:00:00.000Z" }), "2026-08-05");
  assert.equal(automation.getProbableStarterSourceDate({
    now: "2026-08-04T10:00:00.000Z",
    currentGameStartAt: "2026-08-04T09:00:00.000Z",
    nextGameDate: "2026-08-05"
  }), "2026-08-05");
});

test("roster decisions are daily or two-hours-before-start and isolate after-start work", async () => {
  const automation = await import(pathToFileURL(path.join(root, "game-automation-v2.js")).href);
  const schedule = automation.deriveAutomationSchedule({
    internalGameId: "game-1",
    gameDate: "2026-08-04",
    startAt: "2026-08-04T09:00:00.000Z",
    homeTeam: "hawks",
    awayTeam: "fighters"
  });
  assert.equal(automation.getRosterExecutorDecision(schedule, { gameId: "game-1" }, "2026-08-04T07:00:00.000Z").kind, "pregame");
  assert.equal(automation.getRosterExecutorDecision(schedule, { gameId: "game-1", lastPregameCheckGameId: "game-1" }, "2026-08-04T07:10:00.000Z").kind, "daily_slot");
  const laterSchedule = automation.deriveAutomationSchedule({ ...schedule, startAt: "2026-08-04T10:00:00.000Z" });
  assert.equal(automation.getRosterExecutorDecision(laterSchedule, { gameId: "game-1", lastPregameCheckGameId: "game-1", lastSuccessfulFetchSlot: "2026-08-04:16:10" }, "2026-08-04T08:10:00.000Z").kind, "pregame");
  assert.equal(automation.getRosterExecutorDecision(schedule, { gameId: "game-1", lastPregameCheckGameId: "game-1", lastSuccessfulFetchAt: "2026-08-04T07:00:00.000Z" }, "2026-08-04T07:01:00.000Z").due, false);
  assert.equal(automation.getRosterExecutorDecision(schedule, {}, "2026-08-04T09:01:00.000Z").reason, "AFTER_START");
});

test("lineup revision validation and scoring no-op protect identity and duplicate execution", async () => {
  const automation = await import(pathToFileURL(path.join(root, "game-automation-v2.js")).href);
  const lineup = Array.from({ length: 9 }, (_, index) => ({
    order: index + 1,
    playerId: `player-${index + 1}`,
    position: index === 0 ? "CF" : "IF",
    internalGameId: "game-1"
  }));
  assert.equal(automation.validateLineupRevision(lineup, { internalGameId: "game-1" }).valid, true);
  const unresolved = lineup.map((row, index) => index === 5 ? { ...row, playerId: null, playerName: "不明", rawPlayerName: "未登録選手" } : row);
  assert.equal(automation.validateLineupRevision(unresolved, { internalGameId: "game-1", allowUnresolvedPlayer: true }).valid, true);
  assert.equal(automation.validateLineupRevision(unresolved, { internalGameId: "game-1" }).reason, "PLAYER_INVALID");
  assert.equal(automation.validateLineupRevision([...lineup, { ...lineup[0], order: 10, playerId: "player-10" }]).reason, "ORDER_INVALID");
  assert.deepEqual(automation.shouldCreateScoringRevision({
    lineupRevisionId: "game-1:2",
    activeScoringLineupRevisionId: "game-1:2",
    scoringStatus: "scored"
  }), { due: false, reason: "ALREADY_SCORED_FOR_LINEUP_REVISION" });
});

test("canonical state transitions cover normal publication and admin correction", async () => {
  const automation = await import(pathToFileURL(path.join(root, "game-automation-v2.js")).href);
  assert.equal(automation.canonicalAutomationStateFromLegacy("final_lineup_captured"), "final_lineup_confirmed");
  assert.equal(automation.isAutomationV2StateTransitionAllowed("ranking_reflected", "published"), true);
  assert.equal(automation.isAutomationV2StateTransitionAllowed("published", "lineup_correction_pending"), true);
  assert.equal(automation.isAutomationV2StateTransitionAllowed("published", "scored"), false);
});

test("schedule administration and additive revision schema are wired without changing legacy identifiers", () => {
  const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
  const migration = fs.readFileSync(path.join(root, "migrations", "0027_game_automation_v2.sql"), "utf8");
  assert.match(worker, /schedule\|predictions/);
  assert.match(worker, /handleAdminGameScheduleUpdate/);
  assert.match(worker, /predictionReopened: false/);
  assert.match(worker, /manual_intervention_required.*cancelled/);
  assert.match(worker, /markManualLineupCorrectionPending/);
  assert.match(worker, /canonicalStatus: "lineup_correction_pending"/);
  assert.match(worker, /canonicalStatus: "rescored"/);
  assert.match(migration, /game_schedule_change_history/);
  assert.match(migration, /final_lineup_revision_id/);
  assert.match(migration, /scoring_lineup_revision_id/);
});

test("0027 applies to a 0026-compatible database and preserves existing published data", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const migrationFiles = fs.readdirSync(path.join(root, "migrations"))
      .filter((file) => /^00(?:0[1-9]|1[0-9]|2[0-6])_.*\.sql$/.test(file))
      .sort();
    for (const file of migrationFiles) {
      database.exec(fs.readFileSync(path.join(root, "migrations", file), "utf8"));
    }

    database.exec(`
      INSERT INTO users
        (id, username, username_normalized, password_hash, password_salt, password_iterations, created_at, updated_at)
      VALUES
        ('fixture-user', 'fixture', 'fixture', 'hash', 'salt', 1, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
      INSERT INTO games
        (internal_game_id, game_date, start_time, home_team, away_team, game_status, created_at, updated_at)
      VALUES
        ('12d554bb-ad25-44be-8159-0134c046dcee', '2026-08-02', '2026-08-02T09:00:00Z', 'marines', 'fighters', 'completed', '2026-08-01T00:00:00Z', '2026-08-02T20:00:00Z');
      INSERT INTO game_workflow_state
        (internal_game_id, legacy_game_id, game_status, workflow_status, workflow_version, created_at, updated_at)
      VALUES
        ('12d554bb-ad25-44be-8159-0134c046dcee', '2026-08-02-f-m-14', 'completed', 'published', 4, '2026-08-01T00:00:00Z', '2026-08-02T21:00:00Z');
      INSERT INTO game_lineup_revisions
        (game_id, version, actual_lineup_json, lineup_fingerprint, source, created_at, created_by, reason, is_current)
      VALUES
        ('2026-08-02-f-m-14', 1, '[]', 'fixture', 'npb-auto', '2026-08-02T17:00:00Z', NULL, 'fixture', 1);
      INSERT INTO game_lineups
        (id, game_id, actual_lineup_json, lineup_fingerprint, schema_version, lineup_detected_at, scoring_due_at, scoring_status,
         scoring_attempts, processed_predictions, perfect_count, new_perfect_achievers, created_at, updated_at, internal_game_id)
      VALUES
        ('lineup-1', '2026-08-02-f-m-14', '[]', 'fixture', 1, '2026-08-02T17:00:00Z', '2026-08-02T17:02:00Z', 'scored',
         1, 1, 0, 0, '2026-08-02T17:00:00Z', '2026-08-02T17:30:00Z', '12d554bb-ad25-44be-8159-0134c046dcee');
      INSERT INTO predictions
        (id, user_id, game_id, prediction_json, game_date, home_team, away_team, opponent_code, is_home,
         submitted_at, updated_at, status, score, max_score, scored_at, actual_lineup_json, is_test_prediction)
      VALUES
        ('prediction-1', 'fixture-user', '2026-08-02-f-m-14', '[]', '2026-08-02', 'marines', 'fighters', 'f', 1,
         '2026-08-02T16:00:00Z', '2026-08-02T17:30:00Z', 'scored', 80, 100, '2026-08-02T17:30:00Z', '[]', 0);
    `);

    database.exec(fs.readFileSync(path.join(root, "migrations", "0027_game_automation_v2.sql"), "utf8"));

    const game = database.prepare(
      "SELECT prediction_deadline_at, lineup_polling_start_at, final_lineup_at FROM games WHERE internal_game_id = ?1"
    ).get("12d554bb-ad25-44be-8159-0134c046dcee");
    assert.equal(game.prediction_deadline_at, "2026-08-02 08:00:00");
    assert.equal(game.lineup_polling_start_at, "2026-08-02 08:10:00");
    assert.equal(game.final_lineup_at, "2026-08-02 09:02:00");

    const workflow = database.prepare(
      "SELECT workflow_status, canonical_status FROM game_workflow_state WHERE internal_game_id = ?1"
    ).get("12d554bb-ad25-44be-8159-0134c046dcee");
    assert.equal(workflow.workflow_status, "published");
    assert.equal(workflow.canonical_status, "published");

    const prediction = database.prepare(
      "SELECT scoring_revision FROM predictions WHERE id = ?1"
    ).get("prediction-1");
    assert.equal(prediction.scoring_revision, 1);
    const scoreRevision = database.prepare(
      "SELECT scoring_revision, score, lineup_revision_id FROM prediction_score_revisions WHERE prediction_id = ?1"
    ).get("prediction-1");
    assert.deepEqual({ ...scoreRevision }, {
      scoring_revision: 1,
      score: 80,
      lineup_revision_id: "2026-08-02-f-m-14:1"
    });

    const revision = { ...database.prepare(
      "SELECT revision_id, captured_at, is_current FROM game_lineup_revisions WHERE game_id = ?1 AND version = 1"
    ).get("2026-08-02-f-m-14") };
    assert.deepEqual(revision, {
      revision_id: "2026-08-02-f-m-14:1",
      captured_at: "2026-08-02T17:00:00Z",
      is_current: 1
    });
  } finally {
    database.close();
  }
});
