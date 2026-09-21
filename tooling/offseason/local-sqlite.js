import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import {
  claimV3Job,
  completeV3Job,
  listDueV3Jobs
} from "../../backend/automation-v3/repository.js";
import { claimDueJobs } from "../../backend/automation-v3/orchestrator.js";

// This schema mirrors the production job columns and indexes used by the
// repository. It remains an in-memory database, so it cannot touch D1.
export function createLocalScenarioDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE games (
      internal_game_id TEXT PRIMARY KEY NOT NULL
    );
    CREATE TABLE game_jobs_v3 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      internal_game_id TEXT NOT NULL,
      job_type TEXT NOT NULL CHECK (job_type IN (
        'npb_identity_resolve', 'prediction_close', 'lineup_fetch',
        'lineup_finalize', 'score', 'ranking_rebuild', 'publish',
        'probable_starter_fetch', 'roster_fetch'
      )),
      scheduled_at TEXT NOT NULL,
      scheduled_slot_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'claimed', 'completed', 'retry_wait', 'failed', 'cancelled')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      max_attempts INTEGER NOT NULL DEFAULT 12 CHECK (max_attempts > 0),
      next_retry_at TEXT NULL,
      claimed_at TEXT NULL,
      claim_token TEXT NULL,
      lease_expires_at TEXT NULL,
      completed_at TEXT NULL,
      failure_code TEXT NULL,
      failure_message TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (internal_game_id, job_type, scheduled_slot_at),
      FOREIGN KEY (internal_game_id) REFERENCES games(internal_game_id) ON DELETE RESTRICT
    );
    CREATE TABLE teams (team_code TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE players (
      player_id TEXT PRIMARY KEY,
      team_code TEXT NOT NULL REFERENCES teams(team_code),
      name TEXT NOT NULL
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
    CREATE INDEX idx_game_jobs_v3_due
      ON game_jobs_v3(status, scheduled_at, next_retry_at);
    CREATE INDEX idx_game_jobs_v3_lease
      ON game_jobs_v3(status, lease_expires_at);
    CREATE INDEX idx_game_jobs_v3_game
      ON game_jobs_v3(internal_game_id, job_type, scheduled_slot_at);
    CREATE INDEX idx_predictions_game_status ON predictions(internal_game_id, status, score);
  `);
  return db;
}

// The production repository expects the D1 fluent API. This adapter only
// translates that API to the local SQLite connection; it has no network path.
function createD1Adapter(db) {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async all() {
              return { results: db.prepare(sql).all(...params) };
            },
            async first() {
              return db.prepare(sql).get(...params) || null;
            },
            async run() {
              const result = db.prepare(sql).run(...params);
              return { meta: { changes: Number(result.changes || 0) } };
            }
          };
        }
      };
    }
  };
}

export function seedLocalScenario(db, scenario) {
  const insertTeam = db.prepare("INSERT INTO teams (team_code, name) VALUES (?, ?)");
  const insertPlayer = db.prepare("INSERT INTO players (player_id, team_code, name) VALUES (?, ?, ?)");
  const insertGame = db.prepare("INSERT INTO games (internal_game_id) VALUES (?)");
  const insertPrediction = db.prepare(`INSERT INTO predictions
    (prediction_id, user_id, internal_game_id, submitted_at, status, score, max_score)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insertJob = db.prepare(`INSERT INTO game_jobs_v3
    (internal_game_id, job_type, scheduled_at, scheduled_slot_at, status,
     attempt_count, max_attempts, next_retry_at, claimed_at, claim_token,
     lease_expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  db.exec("BEGIN");
  try {
    for (const team of scenario.teams) insertTeam.run(team.teamCode, team.name);
    for (const player of scenario.players) insertPlayer.run(player.playerId, player.teamCode, player.name);
    for (const game of scenario.games) insertGame.run(game.internalGameId);
    for (const prediction of scenario.predictions) insertPrediction.run(
      prediction.predictionId, prediction.userId, prediction.internalGameId,
      prediction.submittedAt, prediction.status, prediction.score, prediction.maxScore
    );
    for (const job of scenario.jobs) insertJob.run(
      job.internalGameId, job.jobType, job.scheduledAt, job.scheduledSlotAt,
      job.status, job.attemptCount, job.maxAttempts, job.nextRetryAt,
      job.claimedAt, job.claimToken, job.leaseExpiresAt,
      job.createdAt || job.scheduledAt, job.updatedAt || job.scheduledAt
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

export async function runRepresentativeQueries(db, { now = "2026-10-01T09:00:00.000Z" } = {}) {
  const d1 = createD1Adapter(db);
  const dueJobsStarted = performance.now();
  const dueJobs = await listDueV3Jobs(d1, new Date(now), 200);
  const dueJobsMs = performance.now() - dueJobsStarted;
  const scoredPredictions = measureQuery(db, `SELECT p.internal_game_id, p.user_id, p.score
    FROM predictions AS p
    JOIN games AS g ON g.internal_game_id = p.internal_game_id
    WHERE p.status = 'scored'
    ORDER BY p.score DESC, p.user_id ASC LIMIT 100`, []);
  const perGame = measureQuery(db, `SELECT internal_game_id, COUNT(*) AS prediction_count,
    AVG(score) AS average_score
    FROM predictions WHERE status = 'scored'
    GROUP BY internal_game_id ORDER BY internal_game_id`, []);
  return {
    dueJobs: { count: dueJobs.length, ms: dueJobsMs, rows: dueJobs },
    scoredPredictions: { count: scoredPredictions.rows.length, ms: scoredPredictions.ms },
    perGame: { count: perGame.rows.length, ms: perGame.ms }
  };
}

export async function processAllDueJobs(db, { now = "2026-10-01T13:00:00.000Z" } = {}) {
  const d1 = createD1Adapter(db);
  const current = new Date(now);
  const rounds = [];
  let hasMoreDue = true;

  while (hasMoreDue) {
    // claimDueJobs is the production Cron boundary. Its effective budget is
    // V3_DUE_JOB_BATCH_SIZE * V3_DUE_JOB_MAX_BATCHES (50 * 4 = 200).
    const round = await claimDueJobs(d1, current, [], { disabledJobTypes: [] });
    const processed = [];
    for (const claimedEntry of round.claimed) {
      const claimed = claimedEntry.claimed;
      if (!claimed) continue;
      const completed = await completeV3Job(d1, {
        jobId: claimed.id,
        claimToken: claimed.claim_token,
        now: current
      });
      if (completed) processed.push({ id: claimed.id, jobType: claimed.job_type });
    }
    rounds.push({ dueCount: round.due.length, processed, hasMoreDue: round.hasMoreDue });
    hasMoreDue = round.hasMoreDue;
  }

  const remaining = db.prepare(`SELECT COUNT(*) AS count FROM game_jobs_v3
    WHERE status IN ('pending', 'retry_wait')
       OR (status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)`)
    .get(current.toISOString()).count;
  return { rounds, processed: rounds.flatMap((round) => round.processed), remaining: Number(remaining) };
}

export function closeLocalScenarioDatabase(db) {
  db.close();
}
