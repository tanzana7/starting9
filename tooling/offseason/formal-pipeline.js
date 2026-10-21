import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createContestId } from "../../backend/contest-identity.js";
import { fileURLToPath } from "node:url";
import worker, {
  executeGameAutomationV3Job,
  getManualLineupPlayerCatalog,
  normalizeManualLineupInput
} from "../../auth-worker.js";
import {
  planMainWorkflowJobs,
  runGameAutomationV3
} from "../../game-automation-v3.js";
import { evaluateCanonicalArtifactsFromDb } from "../../backend/automation-v3/canonical-artifact-evaluator.js";
import { V3_TIMING } from "../../backend/automation-v3/constants.js";
import { getRankingForPeriod } from "../../backend/repositories/ranking-repository.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const POSITIONS = ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"];
const SESSION_TOKEN = "offseason-formal-pipeline-session";
export const FORMAL_RANKING_EXPECTATIONS = Object.freeze([
  Object.freeze({ userId: "offseason-perfect", username: "offseason-perfect", perGameScore: 99 }),
  Object.freeze({ userId: "offseason-rotate-a", username: "offseason-rotate-a", perGameScore: 45 }),
  Object.freeze({ userId: "offseason-rotate-b", username: "offseason-rotate-b", perGameScore: 45 })
]);

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      const bound = (...params) => ({
        all: async () => ({ results: statement.all(...params) }),
        first: async () => statement.get(...params) || null,
        run: async () => ({ meta: { changes: Number(statement.run(...params).changes || 0) } })
      });
      return {
        all: async () => ({ results: statement.all() }),
        first: async () => statement.get() || null,
        run: async () => ({ meta: { changes: Number(statement.run().changes || 0) } }),
        bind(...params) { return bound(...params); }
      };
    },
    async batch(statements) {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function gameDateAt(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(value));
}

function lineup() {
  return getManualLineupPlayerCatalog().slice(0, 9).map((player, index) => ({
    playerId: player.playerId,
    playerName: player.playerName,
    uniformNumber: String(player.uniformNumber),
    teamCode: player.teamCode,
    teamId: player.teamId,
    position: POSITIONS[index],
    battingOrder: index + 1
  }));
}

function predictionLineup(actualLineup, shift) {
  if (shift === 0) return actualLineup.map((player) => ({ ...player }));
  return actualLineup.map((player, index) => ({
    ...actualLineup[(index + shift) % actualLineup.length],
    position: player.position,
    battingOrder: player.battingOrder
  }));
}

function requestHeaders() {
  return {
    Cookie: `s9_session=${encodeURIComponent(SESSION_TOKEN)}`,
    Origin: "https://starting9.offseason.test",
    "Content-Type": "application/json"
  };
}

async function adminRequest(env, pathname, body) {
  return worker.fetch(new Request(`https://starting9.offseason.test${pathname}`, {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify(body)
  }), env, {});
}

function loadSchema(database) {
  const migrationDir = path.join(ROOT, "migrations");
  for (const file of fs.readdirSync(migrationDir).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(fs.readFileSync(path.join(migrationDir, file), "utf8"));
  }
}

function insertFixtureRows(database, games, timestamp, tokenHash) {
  const insertUser = database.prepare(`
    INSERT INTO users (id, username, username_normalized, password_hash, password_salt, password_iterations, status, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `);
  insertUser.run("offseason-operator", "offseason-operator", "offseason-operator", "test", "test", 1, "admin", timestamp, timestamp);
  for (const expected of FORMAL_RANKING_EXPECTATIONS) {
    insertUser.run(expected.userId, expected.username, expected.username, "test", "test", 1, "user", timestamp, timestamp);
  }
  database.prepare(`
    INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("offseason-session", "offseason-operator", tokenHash, timestamp, "2099-01-01T00:00:00.000Z", timestamp);

  const actualLineup = lineup();
  for (const [index, game] of games.entries()) {
    database.prepare(`
      INSERT INTO games (
        internal_game_id, game_date, start_time, home_team, away_team, npb_game_code,
        game_status, is_active, deleted_at, npb_identity_status, npb_identity_resolved_at,
        npb_identity_source, npb_game_url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'scheduled', 1, NULL, 'resolved', ?, 'offseason-fixture', ?, ?, ?)
    `).run(
      game.internalGameId, game.gameDate, game.startAt, "fighters", "hawks",
      `offseason-${index}`, timestamp, `https://offseason.invalid/${index}`, timestamp, timestamp
    );
    const contestId = createContestId(game.internalGameId, "fighters");
    database.prepare(`
      INSERT INTO game_contests (contest_id, internal_game_id, target_team_key)
      VALUES (?, ?, 'fighters')
    `).run(contestId, game.internalGameId);
    database.prepare(`
      INSERT INTO game_automation_v3_state (internal_game_id, state, version, created_at, updated_at)
      VALUES (?, 'scheduled', 0, ?, ?)
    `).run(game.internalGameId, timestamp, timestamp);
    database.prepare(`
      INSERT INTO probable_starters (
        game_id, internal_game_id, status, home_pitcher_name, away_pitcher_name,
        fetched_at, announced_at, updated_at
      ) VALUES (?, ?, 'announced', ?, ?, ?, ?, ?)
    `).run(game.internalGameId, game.internalGameId, `先発A-${index}`, `先発B-${index}`, timestamp, timestamp, timestamp);
    database.prepare(`
      INSERT INTO ranking_games (
        game_id, internal_game_id, game_date, is_ranking_eligible, ranking_eligible_at,
        game_status, is_test_game, publication_status, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, 'pending', 0, 'pending', ?, ?)
    `).run(game.internalGameId, game.internalGameId, game.gameDate, timestamp, timestamp, timestamp);
    for (const [userIndex, expected] of FORMAL_RANKING_EXPECTATIONS.entries()) {
      database.prepare(`
        INSERT INTO predictions (
          id, user_id, game_id, internal_game_id, contest_id, prediction_json, schema_version,
          game_date, home_team, away_team, opponent_code, is_home, submitted_at, updated_at,
          status, is_test_prediction, scoring_status
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1, ?, ?, 'submitted', 0, 'pending')
      `).run(
        `offseason-prediction-${index}-${userIndex}`, expected.userId,
        game.internalGameId, game.internalGameId, contestId,
        JSON.stringify({ schemaVersion: 1, lineup: predictionLineup(actualLineup, userIndex) }), game.gameDate,
        "fighters", "hawks", "hawks", game.predictionDeadlineAt, timestamp
      );
    }
  }
}

export async function createFormalPipelineFixture({
  gameCount = 6,
  // The fixture is used by admin rescore tests. Keep the synthetic game
  // inside the current rescore window so the suite remains valid after the
  // calendar moves past the historical season date used by old snapshots.
  startAt = new Date(Date.now() - 12 * 60_000).toISOString()
} = {}) {
  if (gameCount !== 6) throw new Error("formal pipeline fixture must contain six simultaneous games");
  const database = new DatabaseSync(":memory:");
  loadSchema(database);
  const start = new Date(startAt);
  const timestamp = start.toISOString();
  const deadline = new Date(start.getTime() - V3_TIMING.predictionDeadlineMinutes * 60_000);
  const games = Array.from({ length: gameCount }, (_, index) => ({
    internalGameId: `9f7e2f4c-9b16-4c70-9cb8-9d7d2a2a${String(index + 1).padStart(4, "0")}`,
    gameDate: gameDateAt(start),
    startAt: start.toISOString(),
    predictionDeadlineAt: deadline.toISOString()
  }));
  insertFixtureRows(database, games, timestamp, await sha256Base64Url(SESSION_TOKEN));
  return {
    database,
    env: {
      AUTH_DB: d1(database),
      AUTH_ALLOWED_ORIGINS: "https://starting9.offseason.test",
      ENABLE_GAME_AUTOMATION_V3: "true",
      ENABLE_SEMI_AUTO_LINEUP: "true",
      ENABLE_AUTO_PROBABLE_STARTER: "false"
    },
    games,
    beforeDeadline: new Date(deadline.getTime() - 1_000),
    afterDeadline: new Date(start.getTime() + 12 * 60_000)
  };
}

export async function finalizeSyntheticLineups(fixture) {
  const results = [];
  const normalized = normalizeManualLineupInput(lineup()).lineup;
  for (const game of fixture.games) {
    const response = await adminRequest(fixture.env, `/api/admin/v3/games/${game.internalGameId}/lineup-revisions`, {
      lineup: normalized, reason: "Off-season formal pipeline fixture", confirmed: true
    });
    const body = await response.json();
    if (response.status !== 201) throw new Error(`lineup revision failed: ${response.status} ${JSON.stringify(body)}`);
    const finalizeResponse = await adminRequest(fixture.env, `/api/admin/v3/games/${game.internalGameId}/lineup-finalize`, {
      lineupRevisionId: body.revision.revisionId, confirmed: true
    });
    const finalizeBody = await finalizeResponse.json();
    if (finalizeResponse.status !== 200) throw new Error(`lineup finalize failed: ${finalizeResponse.status} ${JSON.stringify(finalizeBody)}`);
    results.push({ revisionId: body.revision.revisionId, finalized: finalizeBody.finalizedRevision?.isFinal === true });
  }
  return results;
}

export async function runFormalPipeline(fixture, {
  now = fixture.afterDeadline,
  failOnceAt = null,
  maxPasses = 8
} = {}) {
  const executed = [];
  const phases = [];
  let injected = false;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const result = await runGameAutomationV3(fixture.env, now, {
      // This fixture intentionally exercises an off-season historical game.
      // Production Cron uses the bounded current/recent discovery window;
      // the isolated pipeline must opt into historical discovery explicitly.
      gameListOptions: { includeRecentHistory: true },
      formalPlanner: (db, games, at) => planMainWorkflowJobs(db, games, at, {
        disabledStages: ["roster_fetch", "lineup_fetch"],
        targetTeamKey: "fighters"
      }),
      auxiliaryPlanner: async () => ({ created: 0, planned: [], diagnostics: [], errors: [] }),
      executeJob: async (context) => {
        const type = String(context.job?.job_type || "");
        executed.push({
          gameId: context.internalGameId,
          jobId: Number(context.job?.id),
          jobType: type,
          pass
        });
        if (!injected && failOnceAt && type === failOnceAt) {
          injected = true;
          throw new Error(`off-season injected interruption at ${type}`);
        }
        return executeGameAutomationV3Job(context);
      },
      onPhase: (phase) => { phases.push({ pass, ...phase }); }
    });
    phases.push({ pass, stage: "test_run_result", result });
    const openFormalJobs = databaseOpenFormalJobs(fixture.database);
    if (openFormalJobs === 0 && result.execution?.processed === 0 && result.created === 0) break;
  }
  return { executed, phases, injected, fullyClosed: databaseOpenFormalJobs(fixture.database) === 0 };
}

function databaseOpenFormalJobs(database) {
  return Number(database.prepare(`
    SELECT COUNT(*) AS count FROM game_jobs_v3
     WHERE status IN ('pending', 'claimed', 'retry_wait')
  `).get().count || 0);
}

export async function readFormalPipelineResults(fixture) {
  const results = [];
  for (const game of fixture.games) {
    const contestId = createContestId(game.internalGameId, "fighters");
    const canonical = await evaluateCanonicalArtifactsFromDb(fixture.env.AUTH_DB, game.internalGameId, contestId);
    const scores = fixture.database.prepare(
      "SELECT user_id, score, scored_attempt_id, scoring_status FROM predictions WHERE contest_id = ? AND internal_game_id = ? ORDER BY user_id"
    ).all(contestId, game.internalGameId);
    const lineupRow = fixture.database.prepare(
      "SELECT final_lineup_revision_id, scoring_status, publication_status, published_at FROM game_lineups WHERE contest_id = ? AND internal_game_id = ?"
    ).get(contestId, game.internalGameId);
    const scoringRow = fixture.database.prepare(
      "SELECT lineup_revision_id, status, is_active FROM contest_scoring_revisions WHERE contest_id = ? AND internal_game_id = ? AND is_active = 1"
    ).get(contestId, game.internalGameId);
    const reflectionRow = fixture.database.prepare(
      "SELECT scoring_revision_id, status FROM contest_ranking_reflection_revisions WHERE contest_id = ? AND internal_game_id = ? ORDER BY ranking_update_revision DESC LIMIT 1"
    ).get(contestId, game.internalGameId);
    results.push({ gameId: game.internalGameId, canonical, scores, score: scores[0] || null, lineupRow, scoringRow, reflectionRow });
  }
  return results;
}

export async function readFormalRanking(fixture) {
  const startAt = fixture.games[0]?.gameDate || null;
  const endAt = startAt ? new Date(`${startAt}T00:00:00+09:00`) : null;
  if (endAt) endAt.setUTCDate(endAt.getUTCDate() + 1);
  return getRankingForPeriod(fixture.env.AUTH_DB, {
    limit: FORMAL_RANKING_EXPECTATIONS.length,
    offset: 0,
    qualifiedOnly: false,
    startAt,
    endAt: endAt ? gameDateAt(endAt) : null,
    publishedOnly: true,
    targetTeamKey: "fighters"
  });
}

export function closeFormalPipelineFixture(fixture) {
  fixture.database.close();
}
