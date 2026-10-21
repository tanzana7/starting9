import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createContestId } from "../backend/contest-identity.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = path.join(ROOT, "migrations");
const GAMES = [
  { legacyId: "2026-07-22-l-f-16", internalId: "8194933c-6116-5460-ba32-61bad1344a5d", date: "2026-07-22", start: "2026-07-22T09:00:00.000Z", home: "lions", away: "fighters", code: "l-f-16", url: "https://npb.jp/scores/2026/0722/l-f-16/" },
  { legacyId: "2026-07-25-f-e-15", internalId: "0b4ac3b2-9387-59a3-a3f2-056d98ad73df", date: "2026-07-25", start: "2026-07-25T05:00:00.000Z", home: "fighters", away: "eagles", code: "f-e-15", url: "https://npb.jp/scores/2026/0725/f-e-15/" },
  { legacyId: "2026-07-26-f-e-16", internalId: "6723a50c-e243-527f-a0eb-c0890303726f", date: "2026-07-26", start: "2026-07-26T04:00:00.000Z", home: "fighters", away: "eagles", code: "f-e-16", url: "https://npb.jp/scores/2026/0726/f-e-16/" },
  { legacyId: "2026-07-31-f-m-14", internalId: "331a0778-204e-5457-87bc-e5a36f0b8d21", date: "2026-07-31", start: "2026-07-31T09:00:00.000Z", home: "fighters", away: "marines", code: "f-m-14", url: "https://npb.jp/scores/2026/0731/f-m-14/" },
  { legacyId: "2026-07-18-b-f-16", internalId: "256163ea-7597-5c29-94f7-7f6ef8c336a1", date: "2026-07-18", start: "2026-07-18T04:00:00.000Z", home: "buffaloes", away: "fighters", code: "b-f-16", url: "https://npb.jp/scores/2026/0718/b-f-16/" },
  { legacyId: "2026-07-19-b-f-17", internalId: "7a486251-539c-5bed-9e6d-8cef2e2ee8a5", date: "2026-07-19", start: "2026-07-19T04:00:00.000Z", home: "buffaloes", away: "fighters", code: "b-f-17", url: "https://npb.jp/scores/2026/0719/b-f-17/" },
  { legacyId: "2026-07-20-b-f-18", internalId: "2b60f45d-1e8e-52b9-a5ef-6a0061da6be3", date: "2026-07-20", start: "2026-07-20T04:00:00.000Z", home: "buffaloes", away: "fighters", code: "b-f-18", url: "https://npb.jp/scores/2026/0720/b-f-18/" },
  { legacyId: "2026-07-23-l-f-17", internalId: "d2fbd4fc-40ae-51e4-b895-dd86a48229ad", date: "2026-07-23", start: "2026-07-23T09:00:00.000Z", home: "lions", away: "fighters", code: "l-f-17", url: "https://npb.jp/scores/2026/0723/l-f-17/" },
  { legacyId: "2026-08-01-f-m-15", internalId: "f165423d-72c7-51e4-beaa-7bac7166f728", date: "2026-08-01", start: "2026-08-01T05:00:00.000Z", home: "fighters", away: "marines", code: "f-m-15", url: "https://npb.jp/scores/2026/0801/f-m-15/" },
  { legacyId: "2026-08-04-h-f-15", internalId: "b13f89c2-fd70-506d-b937-c7a6f38521fe", date: "2026-08-04", start: "2026-08-04T09:00:00.000Z", home: "hawks", away: "fighters", code: "h-f-15", url: "https://npb.jp/scores/2026/0804/h-f-15/" }
];
const PREDICTION_GAMES = GAMES.slice(0, 4);
const LEGACY_SCHEDULE_ALIASES = [
  { id: "2026-07-25-fighters-eagles-1400", game: GAMES[1] },
  { id: "2026-07-26-fighters-eagles-1300", game: GAMES[2] },
  { id: "2026-07-31-fighters-marines-1800", game: GAMES[3] },
  { id: "2026-08-01-fighters-marines-1400", game: GAMES[8] }
];
const NOW = "2026-10-21T00:00:00.000Z";
const LINEUP_JSON = JSON.stringify([{ order: 1, player: "fixture hitter", position: "指" }]);

function applyThrough(db, migration) {
  const files = fs.readdirSync(MIGRATIONS).filter((file) => file.endsWith(".sql") && file <= migration).sort();
  for (const file of files) db.exec(fs.readFileSync(path.join(MIGRATIONS, file), "utf8"));
}

function applyAfter(db, previous, through) {
  const files = fs.readdirSync(MIGRATIONS).filter((file) => file.endsWith(".sql") && file > previous && file <= through).sort();
  for (const file of files) {
    try {
      db.exec(fs.readFileSync(path.join(MIGRATIONS, file), "utf8"));
    } catch (error) {
      throw new Error(`${file}: ${error.message}`, { cause: error });
    }
  }
}

function applyMigrationTransactionally(db, name) {
  db.exec("BEGIN");
  try {
    db.exec(fs.readFileSync(path.join(MIGRATIONS, name), "utf8"));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function seedUser(db) {
  db.prepare(`INSERT INTO users
    (id, username, username_normalized, password_hash, password_salt, password_iterations, status, created_at, updated_at)
    VALUES ('1', 'fixture-user', 'fixture-user', 'hash', 'salt', 1, 'active', ?, ?)`).run(NOW, NOW);
}

function seedPrediction(db, game, id = `prediction:${game.legacyId}`) {
  db.prepare(`INSERT INTO predictions
    (id, user_id, game_id, prediction_json, schema_version, game_date, home_team, away_team,
     opponent_code, is_home, submitted_at, updated_at, status, score, max_score, scored_at, actual_lineup_json)
    VALUES (?, '1', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'scored', 42, 99, ?, ?)`)
    .run(id, game.legacyId, JSON.stringify({ marker: id }), game.date, game.home, game.away,
      game.away.slice(0, 1), game.home === "fighters" ? 1 : 0, NOW, NOW, NOW, LINEUP_JSON);
}

function seedFourLegacyGames(db) {
  seedUser(db);
  for (const game of PREDICTION_GAMES) seedPrediction(db, game);
  const first = GAMES[0];
  db.prepare(`INSERT INTO prediction_score_revisions
    (id, prediction_id, game_id, is_test_prediction, scoring_revision, score, max_score, actual_lineup_json, scored_at, created_at)
    VALUES ('legacy-score-revision', ?, ?, 0, 1, 42, 99, ?, ?, ?)`)
    .run(`prediction:${first.legacyId}`, first.legacyId, LINEUP_JSON, NOW, NOW);
  db.prepare(`INSERT INTO game_lineups
    (id, game_id, actual_lineup_json, lineup_fingerprint, schema_version, lineup_detected_at,
     scoring_due_at, scoring_status, created_at, updated_at)
    VALUES ('legacy-lineup', ?, ?, 'fingerprint-legacy', 1, ?, ?, 'scored', ?, ?)`)
    .run(first.legacyId, LINEUP_JSON, NOW, NOW, NOW, NOW);
  db.prepare(`INSERT INTO game_lineup_revisions
    (game_id, version, actual_lineup_json, lineup_fingerprint, source, created_at, created_by, reason, is_current, is_final)
    VALUES (?, 1, ?, 'fingerprint-legacy', 'manual', ?, NULL, 'fixture', 1, 1)`)
    .run(first.legacyId, LINEUP_JSON, NOW);
  for (const game of GAMES) {
    db.prepare(`INSERT INTO ranking_games
      (game_id, is_ranking_eligible, ranking_eligible_at, game_status, is_test_game, created_at, updated_at, game_date,
       scored_private_at, published_at, publication_status)
      VALUES (?, 1, ?, 'scored', 0, ?, ?, ?, ?, ?, 'published')`)
      .run(game.legacyId, NOW, NOW, NOW, game.date, NOW, NOW);
  }
  for (const game of PREDICTION_GAMES) {
    db.prepare(`INSERT INTO game_pregame_automation (game_id, game_date, start_at, roster_status, lineup_status,
      scoring_status, created_at, updated_at) VALUES (?, ?, ?, 'captured', 'captured', 'scored', ?, ?)`)
      .run(game.legacyId, game.date, game.start, NOW, NOW);
  }
  for (const { id, game } of LEGACY_SCHEDULE_ALIASES) {
    db.prepare(`INSERT INTO detected_game_schedule
      (game_id, source_game_key, game_date, start_at, home_team, away_team, game_code, venue,
       game_status, detected_at, schedule_checked_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'fixture venue', 'scheduled', ?, ?, ?, ?)`)
      .run(id, `npb:${id}`, game.date, game.start, game.home, game.away, game.code, NOW, NOW, NOW, NOW);
    db.prepare(`INSERT INTO game_pregame_automation (game_id, game_date, start_at, roster_status, lineup_status,
      scoring_status, created_at, updated_at) VALUES (?, ?, ?, 'captured', 'captured', 'scored', ?, ?)`)
      .run(id, game.date, game.start, NOW, NOW);
    db.prepare(`INSERT INTO game_roster_snapshots
      (game_id, game_date, captured_at, roster_json, source, player_count, status, created_at, updated_at)
      VALUES (?, ?, ?, '{"players":["legacy alias"]}', 'npb-roster', 1, 'captured', ?, ?)`)
      .run(id, game.date, NOW, NOW, NOW);
  }
  const probable = GAMES[3];
  db.prepare(`INSERT INTO probable_starters (game_id, status, home_pitcher_name, away_pitcher_name, updated_at)
    VALUES (?, 'announced', 'home pitcher', 'away pitcher', ?)`)
    .run(probable.legacyId, NOW);
  db.prepare(`INSERT INTO probable_starters
    (game_id, status, home_pitcher_name, away_pitcher_name, updated_at)
    VALUES ('2026-07-31-fighters-marines-1800', 'announced', 'home pitcher', 'away pitcher', ?)`)
    .run(NOW);
  for (const game of GAMES.slice(1, 3)) {
    db.prepare(`INSERT INTO game_roster_snapshots
      (game_id, game_date, captured_at, roster_json, source, player_count, status, created_at, updated_at)
      VALUES (?, ?, ?, '{"players":["fixture"]}', 'npb-roster', 1, 'captured', ?, ?)`)
      .run(game.legacyId, game.date, NOW, NOW, NOW);
  }
  db.prepare(`INSERT INTO game_rescore_audits
    (id, game_id, game_date, previous_version, lineup_version, reason, executed_by, executed_at,
     prediction_count, changed_score_count, perfect_count_delta, status, created_at, updated_at)
    VALUES ('legacy-rescore-audit', ?, ?, 0, 1, 'fixture', 1, ?, 1, 0, 0, 'completed', ?, ?)`)
    .run(first.legacyId, first.date, NOW, NOW, NOW);
}

function rollbackError(db, callback) {
  db.exec("BEGIN");
  try {
    callback();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

test("legacy game reconciliation migrates 0001-0045 fixtures through 0049 without losing data", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyThrough(db, "0045_cron_heartbeat.sql");
    seedFourLegacyGames(db);
    const before = {
      predictionRows: db.prepare("SELECT id, game_id, prediction_json, submitted_at, updated_at, score, max_score, scored_at, actual_lineup_json FROM predictions ORDER BY game_id").all(),
      lineup: { ...db.prepare("SELECT id, game_id, actual_lineup_json, lineup_fingerprint, created_at, updated_at FROM game_lineups").get() },
      rankingCount: db.prepare("SELECT COUNT(*) AS n FROM ranking_games").get().n,
      scoreHistoryRows: db.prepare(`SELECT id, prediction_id, game_id, internal_game_id, is_test_prediction,
        scoring_revision, lineup_revision_id, score, max_score, actual_lineup_json, scored_at, scored_by, created_at
        FROM prediction_score_revisions ORDER BY id`).all(),
      probableCount: db.prepare("SELECT COUNT(*) AS n FROM probable_starters").get().n,
      rosterCount: db.prepare("SELECT COUNT(*) AS n FROM game_roster_snapshots").get().n,
      pregameCount: db.prepare("SELECT COUNT(*) AS n FROM game_pregame_automation").get().n,
      rescoreAuditCount: db.prepare("SELECT COUNT(*) AS n FROM game_rescore_audits").get().n
    };

    applyAfter(db, "0045_cron_heartbeat.sql", "0049_contest_scoped_formal_jobs.sql");

    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM games").get().n, 10);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM game_contests").get().n, 10);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM predictions").get().n, before.predictionRows.length);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM game_lineups").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ranking_games").get().n, before.rankingCount);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM contest_prediction_score_revisions").get().n, before.scoreHistoryRows.length);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM probable_starters").get().n, before.probableCount);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM game_roster_snapshots").get().n, before.rosterCount);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM game_pregame_automation").get().n, before.pregameCount);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM contest_game_rescore_audits").get().n, before.rescoreAuditCount);

    for (const game of PREDICTION_GAMES) {
      const physical = db.prepare("SELECT internal_game_id, game_date, start_time, home_team, away_team, npb_game_code, npb_identity_status FROM games WHERE npb_game_code = ?").get(game.code);
      assert.deepEqual({ ...physical }, {
        internal_game_id: game.internalId, game_date: game.date, start_time: game.start,
        home_team: game.home, away_team: game.away, npb_game_code: game.code, npb_identity_status: "resolved"
      });
      const contest = db.prepare("SELECT contest_id, internal_game_id, target_team_key FROM game_contests WHERE internal_game_id = ?").get(game.internalId);
      assert.deepEqual({ ...contest }, {
        contest_id: createContestId(game.internalId, "fighters"), internal_game_id: game.internalId, target_team_key: "fighters"
      });
      const prediction = db.prepare("SELECT id, game_id, internal_game_id, contest_id, prediction_json, submitted_at, updated_at, score, max_score, scored_at, actual_lineup_json FROM predictions WHERE game_id = ?").get(game.legacyId);
      const priorPrediction = before.predictionRows.find((row) => row.game_id === game.legacyId);
      assert.equal(prediction.internal_game_id, game.internalId);
      assert.equal(prediction.contest_id, createContestId(game.internalId, "fighters"));
      for (const field of ["id", "game_id", "prediction_json", "submitted_at", "updated_at", "score", "max_score", "scored_at", "actual_lineup_json"]) {
        assert.equal(prediction[field], priorPrediction[field], `${field} preserved for ${game.legacyId}`);
      }
      assert.equal(db.prepare("SELECT internal_game_id FROM ranking_games WHERE game_id = ?").get(game.legacyId).internal_game_id, game.internalId);
      assert.equal(db.prepare("SELECT internal_game_id FROM game_pregame_automation WHERE game_id = ?").get(game.legacyId).internal_game_id, game.internalId);
    }
    for (const game of GAMES.slice(4)) {
      assert.equal(db.prepare("SELECT internal_game_id FROM ranking_games WHERE game_id = ?").get(game.legacyId).internal_game_id, game.internalId);
      assert.equal(db.prepare("SELECT contest_id FROM game_contests WHERE internal_game_id = ? AND target_team_key = 'fighters'").get(game.internalId).contest_id, createContestId(game.internalId, "fighters"));
    }
    assert.deepEqual({ ...db.prepare("SELECT id, game_id, internal_game_id, contest_id, actual_lineup_json, lineup_fingerprint, created_at, updated_at FROM game_lineups").get() }, {
      id: before.lineup.id, game_id: before.lineup.game_id, internal_game_id: GAMES[0].internalId,
      contest_id: createContestId(GAMES[0].internalId, "fighters"), actual_lineup_json: before.lineup.actual_lineup_json,
      lineup_fingerprint: before.lineup.lineup_fingerprint, created_at: before.lineup.created_at, updated_at: before.lineup.updated_at
    });
    assert.equal(db.prepare("SELECT internal_game_id FROM contest_lineup_revisions WHERE game_id = ?").get(GAMES[0].legacyId).internal_game_id, GAMES[0].internalId);
    assert.equal(db.prepare("SELECT internal_game_id FROM probable_starters WHERE game_id = ?").get(GAMES[3].legacyId).internal_game_id, GAMES[3].internalId);
    assert.equal(db.prepare("SELECT internal_game_id FROM probable_starters WHERE game_id = '2026-07-31-fighters-marines-1800'").get().internal_game_id, GAMES[3].internalId);
    for (const game of GAMES.slice(1, 3)) assert.equal(db.prepare("SELECT internal_game_id FROM game_roster_snapshots WHERE game_id = ?").get(game.legacyId).internal_game_id, game.internalId);
    for (const { id, game } of LEGACY_SCHEDULE_ALIASES) {
      assert.equal(db.prepare("SELECT internal_game_id FROM game_roster_snapshots WHERE game_id = ?").get(id).internal_game_id, game.internalId);
      assert.equal(db.prepare("SELECT internal_game_id FROM game_pregame_automation WHERE game_id = ?").get(id).internal_game_id, game.internalId);
      assert.equal(db.prepare("SELECT internal_game_id FROM game_identifiers WHERE identifier_value = ?").get(id).internal_game_id, game.internalId);
      assert.equal(db.prepare("SELECT internal_game_id FROM detected_game_schedule WHERE game_id = ?").get(id).internal_game_id, game.internalId);
    }
    assert.deepEqual({ ...db.prepare(`SELECT id, prediction_id, game_id, internal_game_id, is_test_prediction,
      scoring_revision, lineup_revision_id, score, max_score, actual_lineup_json, scored_at, scored_by, created_at
      FROM contest_prediction_score_revisions WHERE id = 'legacy-score-revision'`).get() }, {
      ...before.scoreHistoryRows[0], internal_game_id: GAMES[0].internalId
    });
    assert.equal(db.prepare("SELECT internal_game_id FROM contest_game_rescore_audits WHERE id = 'legacy-rescore-audit'").get().internal_game_id, GAMES[0].internalId);
    assert.equal(db.prepare("SELECT COUNT(DISTINCT internal_game_id) AS n FROM games").get().n, 10);
    assert.equal(db.prepare("SELECT COUNT(DISTINCT internal_game_id || ':' || target_team_key) AS n FROM game_contests").get().n, 10);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally {
    db.close();
  }
});

test("a unique existing physical identity is reused instead of duplicated", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyThrough(db, "0045_cron_heartbeat.sql");
    seedUser(db);
    const game = GAMES[0];
    const existingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    db.prepare(`INSERT INTO games
      (internal_game_id, game_date, start_time, home_team, away_team, npb_game_code, game_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?)`)
      .run(existingId, game.date, game.start, game.home, game.away, game.code, NOW, NOW);
    seedPrediction(db, game);
    db.exec(fs.readFileSync(path.join(MIGRATIONS, "0046_contest_identity_foundation.sql"), "utf8"));
    rollbackError(db, () => db.exec(fs.readFileSync(path.join(MIGRATIONS, "0047_contest_scoped_predictions_lineups.sql"), "utf8")));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM games").get().n, 1);
    assert.equal(db.prepare("SELECT internal_game_id FROM predictions").get().internal_game_id, existingId);
    assert.equal(db.prepare("SELECT internal_game_id FROM game_contests").get().internal_game_id, existingId);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM game_identifiers WHERE identifier_value = ?").get(game.legacyId).n, 1);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});

test("unreferenced reviewed mappings do not create historical games on a fresh migration chain", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyThrough(db, "0049_contest_scoped_formal_jobs.sql");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM games").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM game_contests").get().n, 0);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});

test("malformed, invalid-date, unknown-team and non-Fighters legacy IDs fail closed", () => {
  const invalidGames = [
    { legacyId: "not-a-compact-game", date: "2026-07-22", home: "fighters", away: "lions" },
    { legacyId: "2026-02-30-f-e-1", date: "2026-02-30", home: "fighters", away: "eagles" },
    { legacyId: "2026-07-22-x-f-16", date: "2026-07-22", home: "fighters", away: "lions" },
    { legacyId: "2026-07-22-l-m-16", date: "2026-07-22", home: "lions", away: "marines" }
  ];
  for (const game of invalidGames) {
    const db = new DatabaseSync(":memory:");
    try {
      applyThrough(db, "0045_cron_heartbeat.sql");
      seedUser(db);
      seedPrediction(db, { ...game, away: game.away }, `prediction:${game.legacyId}`);
      if (game.legacyId === "2026-07-22-l-m-16") {
        db.prepare(`INSERT INTO games (internal_game_id, game_date, start_time, home_team, away_team, game_status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)`)
          .run(game.legacyId, game.date, `${game.date}T09:00:00.000Z`, game.home, game.away, NOW, NOW);
      }
      db.exec(fs.readFileSync(path.join(MIGRATIONS, "0046_contest_identity_foundation.sql"), "utf8"));
      assert.throws(() => rollbackError(db, () => db.exec(fs.readFileSync(path.join(MIGRATIONS, "0047_contest_scoped_predictions_lineups.sql"), "utf8"))));
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM games").get().n, game.legacyId === "2026-07-22-l-m-16" ? 1 : 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM game_contests WHERE internal_game_id IN (SELECT internal_game_id FROM games WHERE game_date = ?)").get(game.date).n, 0);
      assert.equal(db.prepare("SELECT internal_game_id FROM predictions").get().internal_game_id, null);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      db.close();
    }
  }
});

test("duplicate physical schedule identities abort before reconciliation writes", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyThrough(db, "0045_cron_heartbeat.sql");
    seedUser(db);
    const game = GAMES[0];
    for (const internalId of ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]) {
      db.prepare(`INSERT INTO games
        (internal_game_id, game_date, start_time, home_team, away_team, npb_game_code, game_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?)`)
        .run(internalId, game.date, game.start, game.home, game.away, game.code, NOW, NOW);
    }
    seedPrediction(db, game);
    db.exec(fs.readFileSync(path.join(MIGRATIONS, "0046_contest_identity_foundation.sql"), "utf8"));
    assert.throws(() => rollbackError(db, () => db.exec(fs.readFileSync(path.join(MIGRATIONS, "0047_contest_scoped_predictions_lineups.sql"), "utf8"))));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM games").get().n, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM game_identifiers WHERE identifier_value = ?").get(game.legacyId).n, 0);
    assert.equal(db.prepare("SELECT internal_game_id FROM predictions").get().internal_game_id, null);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});

test("a legacy schedule alias already claimed by another physical game fails closed", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyThrough(db, "0045_cron_heartbeat.sql");
    seedUser(db);
    const alias = LEGACY_SCHEDULE_ALIASES[0];
    const unrelatedId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    db.prepare(`INSERT INTO games
      (internal_game_id, game_date, start_time, home_team, away_team, game_status, created_at, updated_at)
      VALUES (?, '2026-07-25', '2026-07-25T09:00:00.000Z', 'hawks', 'lions', 'completed', ?, ?)`)
      .run(unrelatedId, NOW, NOW);
    db.prepare(`INSERT INTO game_identifiers
      (internal_game_id, provider, identifier_type, identifier_value, is_primary, created_at, updated_at)
      VALUES (?, 'npb', 'legacy_schedule_key', ?, 0, ?, ?)`)
      .run(unrelatedId, alias.id, NOW, NOW);
    db.prepare(`INSERT INTO detected_game_schedule
      (game_id, source_game_key, game_date, start_at, home_team, away_team, game_code, game_status,
       detected_at, schedule_checked_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?)`)
      .run(alias.id, `npb:${alias.id}`, alias.game.date, alias.game.start,
        alias.game.home, alias.game.away, alias.game.code, NOW, NOW, NOW, NOW);

    db.exec(fs.readFileSync(path.join(MIGRATIONS, "0046_contest_identity_foundation.sql"), "utf8"));
    assert.throws(() => rollbackError(db, () => db.exec(fs.readFileSync(
      path.join(MIGRATIONS, "0047_contest_scoped_predictions_lineups.sql"), "utf8"
    ))));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM games").get().n, 1);
    assert.equal(db.prepare("SELECT internal_game_id FROM game_identifiers WHERE identifier_value = ?").get(alias.id).internal_game_id, unrelatedId);
    assert.equal(db.prepare("SELECT internal_game_id FROM detected_game_schedule WHERE game_id = ?").get(alias.id).internal_game_id, null);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM game_contests").get().n, 0);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});
