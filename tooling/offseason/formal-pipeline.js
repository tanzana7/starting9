import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const POSITIONS = ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"];
const SESSION_TOKEN = "offseason-formal-pipeline-session";

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
  database.prepare(`
    INSERT INTO users (id, username, username_normalized, password_hash, password_salt, password_iterations, status, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', 'admin', ?, ?)
  `).run("offseason-operator", "offseason-operator", "offseason-operator", "test", "test", 1, timestamp, timestamp);
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
    database.prepare(`
      INSERT INTO predictions (
        id, user_id, game_id, internal_game_id, prediction_json, schema_version,
        game_date, home_team, away_team, opponent_code, is_home, submitted_at, updated_at,
        status, is_test_prediction, scoring_status
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1, ?, ?, 'submitted', 0, 'pending')
    `).run(
      `offseason-prediction-${index}`, "offseason-operator", game.internalGameId, game.internalGameId,
      JSON.stringify({ schemaVersion: 1, lineup: actualLineup }), game.gameDate,
      "fighters", "hawks", "hawks", game.predictionDeadlineAt, timestamp
    );
  }
}

export async function createFormalPipelineFixture({
  gameCount = 6,
  startAt = "2026-09-21T10:00:00.000Z"
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
      formalPlanner: (db, games, at) => planMainWorkflowJobs(db, games, at, {
        disabledStages: ["roster_fetch", "lineup_fetch"]
      }),
      auxiliaryPlanner: async () => ({ created: 0, planned: [], diagnostics: [], errors: [] }),
      executeJob: async (context) => {
        const type = String(context.job?.job_type || "");
        executed.push({ gameId: context.internalGameId, jobType: type, pass });
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
    const canonical = await evaluateCanonicalArtifactsFromDb(fixture.env.AUTH_DB, game.internalGameId);
    const score = fixture.database.prepare(
      "SELECT score, scored_attempt_id, scoring_status FROM predictions WHERE internal_game_id = ?"
    ).get(game.internalGameId);
    const lineupRow = fixture.database.prepare(
      "SELECT final_lineup_revision_id, scoring_status, publication_status, published_at FROM game_lineups WHERE internal_game_id = ?"
    ).get(game.internalGameId);
    const scoringRow = fixture.database.prepare(
      "SELECT lineup_revision_id, status, is_active FROM game_scoring_revisions WHERE internal_game_id = ? AND is_active = 1"
    ).get(game.internalGameId);
    const reflectionRow = fixture.database.prepare(
      "SELECT scoring_revision_id, status FROM ranking_reflection_revisions WHERE internal_game_id = ? ORDER BY ranking_update_revision DESC LIMIT 1"
    ).get(game.internalGameId);
    results.push({ gameId: game.internalGameId, canonical, score, lineupRow, scoringRow, reflectionRow });
  }
  return results;
}

export function closeFormalPipelineFixture(fixture) {
  fixture.database.close();
}
