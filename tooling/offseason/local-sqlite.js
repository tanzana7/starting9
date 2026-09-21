import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";

export function createLocalScenarioDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE teams (team_code TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE players (
      player_id TEXT PRIMARY KEY,
      team_code TEXT NOT NULL REFERENCES teams(team_code),
      name TEXT NOT NULL
    );
    CREATE TABLE games (
      internal_game_id TEXT PRIMARY KEY,
      game_date TEXT NOT NULL,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      prediction_deadline_at TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE predictions (
      prediction_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      internal_game_id TEXT NOT NULL REFERENCES games(internal_game_id),
      submitted_at TEXT NOT NULL,
      status TEXT NOT NULL,
      score INTEGER NOT NULL,
      max_score INTEGER NOT NULL
    );
    CREATE TABLE game_jobs_v3_next (
      job_id TEXT PRIMARY KEY,
      internal_game_id TEXT NOT NULL REFERENCES games(internal_game_id),
      job_type TEXT NOT NULL,
      status TEXT NOT NULL,
      run_after TEXT NOT NULL
    );
    CREATE INDEX idx_predictions_game_status ON predictions(internal_game_id, status, score);
    CREATE INDEX idx_jobs_due ON game_jobs_v3_next(status, run_after, internal_game_id);
  `);
  return db;
}

export function seedLocalScenario(db, scenario) {
  const insertTeam = db.prepare("INSERT INTO teams (team_code, name) VALUES (?, ?)");
  const insertPlayer = db.prepare("INSERT INTO players (player_id, team_code, name) VALUES (?, ?, ?)");
  const insertGame = db.prepare(`INSERT INTO games
    (internal_game_id, game_date, home_team, away_team, prediction_deadline_at, starts_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insertPrediction = db.prepare(`INSERT INTO predictions
    (prediction_id, user_id, internal_game_id, submitted_at, status, score, max_score)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insertJob = db.prepare(`INSERT INTO game_jobs_v3_next
    (job_id, internal_game_id, job_type, status, run_after)
    VALUES (?, ?, ?, ?, ?)`);

  db.exec("BEGIN");
  try {
    for (const team of scenario.teams) insertTeam.run(team.teamCode, team.name);
    for (const player of scenario.players) insertPlayer.run(player.playerId, player.teamCode, player.name);
    for (const game of scenario.games) insertGame.run(
      game.internalGameId, game.gameDate, game.homeTeam, game.awayTeam,
      game.predictionDeadlineAt, game.startsAt, game.status
    );
    for (const prediction of scenario.predictions) insertPrediction.run(
      prediction.predictionId, prediction.userId, prediction.internalGameId,
      prediction.submittedAt, prediction.status, prediction.score, prediction.maxScore
    );
    for (const job of scenario.jobs) insertJob.run(
      job.jobId, job.internalGameId, job.jobType, job.status, job.runAfter
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function measureQuery(db, statement, params = []) {
  const started = performance.now();
  const rows = db.prepare(statement).all(...params);
  return { rows, ms: performance.now() - started };
}

export function runRepresentativeQueries(db, { now = "2026-10-01T09:00:00.000Z" } = {}) {
  const dueJobs = measureQuery(db, `SELECT job_id, internal_game_id, job_type, status
    FROM game_jobs_v3_next
    WHERE status IN ('pending', 'claimed') AND run_after <= ?
    ORDER BY run_after ASC, job_id ASC LIMIT 100`, [now]);
  const scoredPredictions = measureQuery(db, `SELECT p.internal_game_id, p.user_id, p.score
    FROM predictions AS p
    JOIN games AS g ON g.internal_game_id = p.internal_game_id
    WHERE p.status = 'scored' AND g.status = 'scheduled'
    ORDER BY p.score DESC, p.user_id ASC LIMIT 100`, []);
  const perGame = measureQuery(db, `SELECT internal_game_id, COUNT(*) AS prediction_count,
    AVG(score) AS average_score
    FROM predictions WHERE status = 'scored'
    GROUP BY internal_game_id ORDER BY internal_game_id`, []);
  return {
    dueJobs: { count: dueJobs.rows.length, ms: dueJobs.ms },
    scoredPredictions: { count: scoredPredictions.rows.length, ms: scoredPredictions.ms },
    perGame: { count: perGame.rows.length, ms: perGame.ms }
  };
}

export function closeLocalScenarioDatabase(db) {
  db.close();
}
