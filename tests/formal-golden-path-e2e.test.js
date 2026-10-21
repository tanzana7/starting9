import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker, {
  executeGameAutomationV3Job,
  getManualLineupPlayerCatalog,
  normalizeManualLineupInput
} from "../auth-worker.js";
import { claimV3Job, completeV3Job, createV3Job, retryV3Job, runGameAutomationV3, planMainWorkflowJobs, transitionV3State } from "../game-automation-v3.js";
import { evaluateCanonicalArtifactsFromDb } from "../backend/automation-v3/canonical-artifact-evaluator.js";
import { getRankingForPeriod } from "../backend/repositories/ranking-repository.js";
import { buildLineupAlertSignal, runLineupCandidatePipeline } from "../backend/automation-v3/lineup-candidate-service.js";
import { createContestId } from "../backend/contest-identity.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GAME_ID = "9f7e2f4c-9b16-4c70-9cb8-9d7d2a2a0001";
const SESSION_TOKEN = "formal-golden-path-session";
const POSITIONS = ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"];

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      const bound = (...params) => ({
        all: async () => ({ results: statement.all(...params) }),
        first: async () => statement.get(...params),
        run: async () => ({ meta: { changes: Number(statement.run(...params).changes || 0) } })
      });
      return {
        all: async () => ({ results: statement.all() }),
        first: async () => statement.get(),
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

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

function gatedD1(database, predicate, gate) {
  const base = d1(database);
  let paused = false;
  return {
    prepare(sql) {
      const statement = base.prepare(sql);
      if (!predicate(sql)) return statement;
      return {
        all: statement.all,
        first: statement.first,
        run: statement.run,
        bind(...params) {
          const bound = statement.bind(...params);
          return {
            async all() {
              const rows = await bound.all();
              if (!paused) {
                paused = true;
                gate.hit.resolve(rows);
                await gate.release.promise;
              }
              return rows;
            },
            run: bound.run,
            async first() {
              const row = await bound.first();
              if (!paused) {
                paused = true;
                gate.hit.resolve(row);
                await gate.release.promise;
              }
              return row;
            }
          };
        }
      };
    },
    async batch(statements) {
      return base.batch(statements);
    }
  };
}

function gatedBatchD1(database, gate) {
  const base = d1(database);
  let paused = false;
  return {
    prepare: base.prepare,
    async batch(statements) {
      if (!paused) {
        paused = true;
        gate.hit.resolve(statements.length);
        await gate.release.promise;
      }
      return base.batch(statements);
    }
  };
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function currentJstDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now);
  return parts.filter((part) => part.type !== "literal").map((part) => part.value).join("-");
}

function normalLineup() {
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

function changedLineup() {
  const catalog = getManualLineupPlayerCatalog();
  return normalLineup().map((row, index) => index === 0
    ? { ...row, playerId: catalog[9].playerId, playerName: catalog[9].playerName, uniformNumber: String(catalog[9].uniformNumber) }
    : row);
}

function simulatorLineupHtml(fixture, lineup = normalLineup(), status = "lineup_announced") {
  const rows = lineup.map((row) => `<tr data-batting-order="${row.battingOrder}" data-player-id="${row.playerId}" data-player-name="${row.playerName}" data-position="${row.position}" data-jersey-number="${row.uniformNumber}"></tr>`).join("");
  return `<div data-game-code="${fixture.npbGameCode}" data-game-date="${fixture.gameDate}" data-home-team="fighters" data-away-team="hawks" data-game-status="${status}"><table data-lineup-team="fighters">${rows}</table></div>`;
}

function requestHeaders() {
  return {
    Cookie: `s9_session=${encodeURIComponent(SESSION_TOKEN)}`,
    Origin: "https://starting9.test",
    "Content-Type": "application/json"
  };
}

async function adminRequest(env, pathname, body) {
  return worker.fetch(new Request(`https://starting9.test${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: requestHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body)
  }), env, {});
}

async function createGoldenDb({ npbGameCode = "f-h-golden-1" } = {}) {
  const database = new DatabaseSync(":memory:");
  for (const file of fs.readdirSync(path.join(ROOT, "migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(fs.readFileSync(path.join(ROOT, "migrations", file), "utf8"));
  }

  const now = new Date();
  const gameDate = currentJstDate(now);
  let startAt = new Date(now.getTime() + 10 * 60 * 1000);
  if (currentJstDate(startAt) !== gameDate) startAt = new Date(now.getTime() - 10 * 60 * 1000);
  const timestamp = now.toISOString();
  const tokenHash = await sha256Base64Url(SESSION_TOKEN);
  const lineup = normalizeManualLineupInput(normalLineup()).lineup;

  database.prepare(`
    INSERT INTO users (id, username, username_normalized, password_hash, password_salt, password_iterations, status, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', 'admin', ?, ?)
  `).run("operator-1", "operator", "operator", "test", "test", 1, timestamp, timestamp);
  database.prepare(`
    INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("session-1", "operator-1", tokenHash, timestamp, "2099-01-01T00:00:00.000Z", timestamp);
  database.prepare(`
    INSERT INTO games (
      internal_game_id, game_date, start_time, home_team, away_team, npb_game_code,
      game_status, is_active, deleted_at, npb_identity_status, npb_identity_resolved_at,
      npb_identity_source, npb_game_url, created_at, updated_at
    ) VALUES (?, ?, ?, 'fighters', 'hawks', ?, 'scheduled', 1, NULL,
      'resolved', ?, 'test-fixture', 'https://npb.example/golden-1', ?, ?)
  `).run(GAME_ID, gameDate, startAt.toISOString(), npbGameCode, timestamp, timestamp, timestamp);
  database.prepare(`
    INSERT INTO game_contests (contest_id, internal_game_id, target_team_key)
    VALUES (?, ?, 'fighters')
  `).run(createContestId(GAME_ID, "fighters"), GAME_ID);
  database.prepare(`
    INSERT INTO game_automation_v3_state (internal_game_id, state, version, created_at, updated_at)
    VALUES (?, 'scheduled', 0, ?, ?)
  `).run(GAME_ID, timestamp, timestamp);
  database.prepare(`INSERT INTO contest_automation_v3_state
    (contest_id,internal_game_id,state,version,created_at,updated_at)
    VALUES(?1,?2,'scheduled',0,?3,?3)`).run(createContestId(GAME_ID, "fighters"), GAME_ID, timestamp);
  // Legacy-only fixture assertions still observe the Fighters mirror. The
  // production state machine uses contest_automation_v3_state; these triggers
  // are test-only and deliberately do nothing once a second contest exists.
  database.exec(`CREATE TRIGGER fixture_sync_single_contest_state_to_legacy
    AFTER UPDATE OF state ON contest_automation_v3_state
    WHEN (SELECT COUNT(*) FROM game_contests WHERE internal_game_id=NEW.internal_game_id)=1
    BEGIN UPDATE game_automation_v3_state SET state=NEW.state,version=NEW.version,updated_at=NEW.updated_at
      WHERE internal_game_id=NEW.internal_game_id; END;
    CREATE TRIGGER fixture_sync_legacy_state_to_single_contest
    AFTER UPDATE OF state ON game_automation_v3_state
    WHEN (SELECT COUNT(*) FROM game_contests WHERE internal_game_id=NEW.internal_game_id)=1
    BEGIN UPDATE contest_automation_v3_state SET state=NEW.state,version=NEW.version,updated_at=NEW.updated_at
      WHERE internal_game_id=NEW.internal_game_id; END;`);
  database.prepare(`
    INSERT INTO probable_starters (
      game_id, internal_game_id, status, home_pitcher_name, away_pitcher_name,
      fetched_at, announced_at, updated_at
    ) VALUES (?, ?, 'announced', '先発A', '先発B', ?, ?, ?)
  `).run(GAME_ID, GAME_ID, timestamp, timestamp, timestamp);
  database.prepare(`
    INSERT INTO ranking_games (
      game_id, internal_game_id, game_date, is_ranking_eligible, ranking_eligible_at,
      game_status, is_test_game, publication_status, created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, 'pending', 0, 'pending', ?, ?)
  `).run(GAME_ID, GAME_ID, gameDate, timestamp, timestamp, timestamp);
  database.prepare(`
    INSERT INTO predictions (
      id, user_id, game_id, internal_game_id, contest_id, prediction_json, schema_version,
      game_date, home_team, away_team, opponent_code, is_home, submitted_at, updated_at,
      status, is_test_prediction, scoring_status
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'fighters', 'hawks', 'hawks', 1, ?, ?, 'submitted', 0, 'pending')
  `).run("prediction-1", "operator-1", GAME_ID, GAME_ID, createContestId(GAME_ID, "fighters"), JSON.stringify({ schemaVersion: 1, lineup }), gameDate, timestamp, timestamp);

  return {
    database,
    env: {
      AUTH_DB: d1(database),
      AUTH_ALLOWED_ORIGINS: "https://starting9.test",
      ENABLE_GAME_AUTOMATION_V3: "true",
      ENABLE_SEMI_AUTO_LINEUP: "true",
      ENABLE_AUTO_PROBABLE_STARTER: "false"
    },
    gameDate,
    startAt,
    npbGameCode,
    lineup
  };
}

async function runFormalCron(env, now, executed = [], { formalPlanner = null, v4SemiAuto = false } = {}) {
  return runGameAutomationV3(env, now, {
    targetTeamKey: "fighters",
    formalPlanner: formalPlanner || ((db, games, at) => planMainWorkflowJobs(db, games, at, {
      disabledStages: ["roster_fetch", "lineup_fetch"],
      v4SemiAuto,
      targetTeamKey: "fighters"
    })),
    auxiliaryPlanner: async () => ({ created: 0, planned: [], diagnostics: [], errors: [] }),
    v4SemiAuto,
    executeJob: async (context) => {
      executed.push(context.job.job_type);
      return executeGameAutomationV3Job(context);
    }
  });
}

function noOpFormalPlanner() {
  return { created: 0, planned: [], diagnostics: [], errors: [] };
}

function planningGame(fixture, workflowState = "scheduled") {
  return {
    internalGameId: GAME_ID,
    gameDate: fixture.gameDate,
    startAt: fixture.startAt.toISOString(),
    homeTeam: "fighters",
    awayTeam: "hawks",
    gameStatus: "scheduled",
    isActive: 1,
    deletedAt: null,
    workflowState
  };
}

async function createDueJob(fixture, jobType, at, suffix) {
  return createV3Job(fixture.env.AUTH_DB, {
    internalGameId: GAME_ID,
    contestId: createContestId(GAME_ID, "fighters"),
    jobType,
    scheduledAt: new Date(at.getTime() - 1000),
    scheduledSlotAt: new Date(at.getTime() - 1000 + suffix).toISOString()
  });
}

async function prepareManualLineup(fixture) {
  const save = await adminRequest(fixture.env, `/api/admin/v3/games/${GAME_ID}/lineup-revisions`, {
    lineup: normalLineup(), reason: "Golden Path fixture", confirmed: true
  });
  const saveBody = await save.json();
  assert.equal(save.status, 201, JSON.stringify(saveBody));
  const finalize = await adminRequest(fixture.env, `/api/admin/v3/games/${GAME_ID}/lineup-finalize`, {
    lineupRevisionId: saveBody.revision.revisionId, confirmed: true
  });
  const finalizeBody = await finalize.json();
  assert.equal(finalize.status, 200, JSON.stringify(finalizeBody));
  return { saveBody, finalizeBody };
}

async function rankingSnapshot(fixture, { publishedOnly = true } = {}) {
  const nextDate = new Date(`${fixture.gameDate}T00:00:00+09:00`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  return getRankingForPeriod(fixture.env.AUTH_DB, {
    limit: 10,
    offset: 0,
    qualifiedOnly: false,
    startAt: fixture.gameDate,
    endAt: currentJstDate(nextDate),
    publishedOnly,
    targetTeamKey: "fighters"
  });
}

async function evaluateGoldenCanonical(fixture, internalGameId = GAME_ID) {
  return evaluateCanonicalArtifactsFromDb(
    fixture.env.AUTH_DB,
    internalGameId,
    createContestId(internalGameId, "fighters")
  );
}

async function completeGoldenPathA(fixture) {
  const { saveBody, finalizeBody } = await prepareManualLineup(fixture);
  assert.equal(finalizeBody.finalizedRevision.isFinal, true);

  const executed = [];
  const at = new Date(fixture.startAt.getTime() + 12 * 60 * 1000);
  for (let pass = 0; pass < 5; pass += 1) await runFormalCron(fixture.env, at, executed);
  return { saveBody, finalizeBody, executed, at };
}

function artifactCounts(database) {
  return {
    jobs: database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3").get().count,
    scoring: database.prepare("SELECT COUNT(*) AS count FROM game_scoring_revisions").get().count,
    reflections: database.prepare("SELECT COUNT(*) AS count FROM ranking_reflection_revisions").get().count,
    scoreHistory: database.prepare("SELECT COUNT(*) AS count FROM prediction_score_revisions").get().count,
    scoreAttempts: database.prepare("SELECT COUNT(*) AS count FROM score_attempts").get().count,
    score: database.prepare("SELECT score FROM predictions WHERE id = 'prediction-1'").get().score
  };
}

test("Golden Path A: prediction closeからmanual lineup、score、ranking、publishまでを正式executorで完了する", async () => {
  const fixture = await createGoldenDb();
  try {
    const result = await completeGoldenPathA(fixture);
    assert.deepEqual(result.executed.slice(0, 4), ["prediction_close", "score", "ranking_rebuild", "publish"]);
    const canonical = await evaluateCanonicalArtifactsFromDb(fixture.env.AUTH_DB, GAME_ID, createContestId(GAME_ID, "fighters"));
    assert.equal(canonical.evaluator, "canonical_artifact");
    assert.equal(canonical.aggregate.fullyPublished, true);
    assert.equal(canonical.aggregate.lineupReady, true);
    assert.equal(canonical.aggregate.scoringReady, true);
    assert.equal(canonical.aggregate.rankingReady, true);
    assert.equal(canonical.aggregate.publicationReady, true);
    assert.equal(canonical.aggregate.artifactMismatch, false);
    assert.equal(canonical.aggregate.needsAttention, false);
    assert.equal(canonical.lineup.canonicalFinalRevisionId, result.saveBody.revision.revisionId);
    assert.equal(canonical.scoring.lineupRevisionMatch, true);
    assert.equal(canonical.ranking.scoringRevisionMatch, true);
    assert.equal(canonical.publication.rankingRevisionMatch, true);
    assert.equal(fixture.database.prepare("SELECT lineup_source FROM game_lineups WHERE internal_game_id = ?").get(GAME_ID).lineup_source, "manual");
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE job_type IN ('roster_fetch', 'lineup_fetch', 'probable_starter_fetch')").get().count, 0);
    assert.equal(fixture.database.prepare("SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?").get(GAME_ID).state, "published");
    const attempt = fixture.database.prepare("SELECT attempt_id, status, expected_prediction_count, expected_test_count FROM contest_score_attempts WHERE internal_game_id = ? AND contest_id = ?").get(GAME_ID, createContestId(GAME_ID, "fighters"));
    assert.equal(attempt.status, "committed");
    assert.equal(attempt.expected_prediction_count, 1);
    assert.equal(attempt.expected_test_count, 9);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM contest_score_attempt_test_rows WHERE attempt_id = ?").get(attempt.attempt_id).count, 9);
    assert.equal(fixture.database.prepare("SELECT scored_attempt_id FROM predictions WHERE id = 'prediction-1'").get().scored_attempt_id, attempt.attempt_id);
    assert.equal(fixture.database.prepare("SELECT committed_attempt_id FROM contest_scoring_revisions WHERE internal_game_id = ? AND contest_id = ? AND is_active = 1").get(GAME_ID, createContestId(GAME_ID, "fighters")).committed_attempt_id, attempt.attempt_id);
  } finally {
    fixture.database.close();
  }
});

test("管理者のranking/publish手動実行は同じV3 job/executorで順番に完了する", async () => {
  const fixture = await createGoldenDb();
  try {
    await prepareManualLineup(fixture);
    await transitionV3State(fixture.env.AUTH_DB, { internalGameId: GAME_ID, from: "scheduled", to: "prediction_closed", now: fixture.startAt });
    const scoreAt = new Date(fixture.startAt.getTime() + 12 * 60 * 1000);
    await createDueJob(fixture, "score", scoreAt, 201);
    await runFormalCron(fixture.env, new Date(scoreAt.getTime() + 1000), [], { formalPlanner: noOpFormalPlanner });
    assert.equal(fixture.database.prepare("SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?").get(GAME_ID).state, "scored");

    const rankingResponse = await adminRequest(fixture.env, `/api/admin/v3/games/${GAME_ID}/jobs/run`, {
      jobType: "ranking_rebuild", reason: "ranking manual recovery", confirmed: true
    });
    const rankingBody = await rankingResponse.json();
    assert.equal(rankingResponse.status, 200, JSON.stringify(rankingBody));
    assert.equal(rankingBody.manualExecution, true);
    assert.equal(rankingBody.status, "completed");
    assert.equal(rankingBody.job.job_type, "ranking_rebuild");
    assert.equal(fixture.database.prepare("SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?").get(GAME_ID).state, "ranked");

    const publishResponse = await adminRequest(fixture.env, `/api/admin/v3/games/${GAME_ID}/jobs/run`, {
      jobType: "publish", reason: "publish manual recovery", confirmed: true
    });
    const publishBody = await publishResponse.json();
    assert.equal(publishResponse.status, 200, JSON.stringify(publishBody));
    assert.equal(publishBody.manualExecution, true);
    assert.equal(publishBody.status, "completed");
    assert.equal(publishBody.job.job_type, "publish");
    const canonical = await evaluateCanonicalArtifactsFromDb(fixture.env.AUTH_DB, GAME_ID, createContestId(GAME_ID, "fighters"));
    assert.equal(canonical.aggregate.fullyPublished, true);
    assert.equal(canonical.ranking.scoringRevisionMatch, true);
    assert.equal(canonical.publication.rankingRevisionMatch, true);
  } finally {
    fixture.database.close();
  }
});

test("V4はranking artifactが開始後にreadyならstart+10を待たずpublishする", async () => {
  const fixture = await createGoldenDb();
  try {
    await prepareManualLineup(fixture);
    const at = new Date(fixture.startAt.getTime() + 5 * 60 * 1000);
    const executed = [];
    for (let pass = 0; pass < 4; pass += 1) {
      await runFormalCron(fixture.env, at, executed, { v4SemiAuto: true });
    }
    const canonical = await evaluateCanonicalArtifactsFromDb(fixture.env.AUTH_DB, GAME_ID, createContestId(GAME_ID, "fighters"));
    assert.equal(canonical.aggregate.fullyPublished, true);
    assert.equal(executed.includes("publish"), true);
    assert.equal(fixture.database.prepare("SELECT publication_status FROM game_lineups WHERE internal_game_id = ?").get(GAME_ID).publication_status, "published");
  } finally {
    fixture.database.close();
  }
});

test("Golden Path A rerun: 公開済みの同一Cronはjob・採点・ランキング・公開を増やさない", async () => {
  const fixture = await createGoldenDb();
  try {
    const result = await completeGoldenPathA(fixture);
    const before = artifactCounts(fixture.database);
    const rerun = [];
    await runFormalCron(fixture.env, result.at, rerun);
    assert.deepEqual(rerun, []);
    assert.deepEqual(artifactCounts(fixture.database), before);
  } finally {
    fixture.database.close();
  }
});

test("legacy game-code revisionでもformal scoreはcanonical lineageを保って完了する", async () => {
  const fixture = await createGoldenDb();
  try {
    const prepared = await prepareManualLineup(fixture);
    const legacyGameId = "f-h-legacy-1";
    fixture.database.prepare(
      "UPDATE game_lineup_revisions SET game_id = ?, revision_id = ? WHERE internal_game_id = ? AND version = 1"
    ).run(legacyGameId, `${legacyGameId}:1`, GAME_ID);
    fixture.database.prepare(
      "UPDATE game_lineups SET game_id = ?, final_lineup_revision_id = ? WHERE internal_game_id = ?"
    ).run(legacyGameId, `${GAME_ID}:1`, GAME_ID);

    const scoreJob = await createDueJob(fixture, "score", new Date(fixture.startAt.getTime() + 12 * 60 * 1000), 101);
    const claim = await claimV3Job(fixture.env.AUTH_DB, { jobId: scoreJob.job.id, now: new Date(fixture.startAt.getTime() + 12 * 60 * 1000) });
    const result = await executeGameAutomationV3Job({
      env: fixture.env,
      job: claim,
      internalGameId: GAME_ID,
      now: new Date(fixture.startAt.getTime() + 12 * 60 * 1000)
    });
    assert.equal(result.stateAfter, "scored");
    assert.equal(fixture.database.prepare("SELECT scoring_status FROM game_lineups WHERE internal_game_id = ?").get(GAME_ID).scoring_status, "scored");
    assert.equal(fixture.database.prepare("SELECT lineup_revision_id FROM game_scoring_revisions WHERE internal_game_id = ? AND is_active = 1").get(GAME_ID).lineup_revision_id, `${legacyGameId}:1`);
    const canonical = await evaluateGoldenCanonical(fixture);
    assert.equal(canonical.aggregate.scoringReady, true);
    assert.equal(canonical.lineup.canonicalFinalRevisionId, prepared.saveBody.revision.revisionId);
  } finally {
    fixture.database.close();
  }
});

test("Golden Path B: 公開後のA→B correctionは旧revisionを保持してBだけを再採点・再反映・再公開する", async () => {
  const fixture = await createGoldenDb();
  try {
    const first = await completeGoldenPathA(fixture);
    const contestId = createContestId(GAME_ID, "fighters");
    const oldScoring = fixture.database.prepare("SELECT id FROM contest_scoring_revisions WHERE internal_game_id = ? AND contest_id = ? AND is_active = 1").get(GAME_ID, contestId);
    const oldReflection = fixture.database.prepare("SELECT scoring_revision_id FROM contest_ranking_reflection_revisions WHERE internal_game_id = ? AND contest_id = ? ORDER BY ranking_update_revision DESC LIMIT 1").get(GAME_ID, contestId);
    const originalPredictionPayload = fixture.database.prepare("SELECT prediction_json FROM predictions WHERE id = 'prediction-1'").get().prediction_json;
    const correction = await adminRequest(fixture.env, `/api/admin/v3/games/${GAME_ID}/lineup-correction`, {
      lineup: changedLineup(), reason: "Golden Path B official correction", confirmed: true
    });
    const correctionBody = await correction.json();
    assert.equal(correction.status, 202, JSON.stringify(correctionBody));
    assert.equal(correctionBody.scoreJob.job.job_type, "score");
    const correctionRevision = fixture.database.prepare(
      "SELECT revision_id, is_final, is_current FROM game_lineup_revisions WHERE internal_game_id = ? ORDER BY version DESC LIMIT 1"
    ).get(GAME_ID);
    assert.equal(correctionRevision.is_final, 1);
    assert.equal(correctionRevision.is_current, 1);
    assert.notEqual(correctionRevision.revision_id, first.saveBody.revision.revisionId);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM game_lineup_revisions WHERE internal_game_id = ?").get(GAME_ID).count, 2);

    const executed = [];
    const correctionAt = new Date(first.at.getTime() + 1000);
    for (let pass = 0; pass < 5; pass += 1) {
      await runFormalCron(fixture.env, new Date(correctionAt.getTime() + (pass + 1) * 1000), executed);
    }
    assert.deepEqual(executed.slice(0, 3), ["score", "ranking_rebuild", "publish"]);
    const canonical = await evaluateCanonicalArtifactsFromDb(fixture.env.AUTH_DB, GAME_ID, contestId);
    assert.equal(canonical.aggregate.fullyPublished, true);
    assert.equal(canonical.lineup.canonicalFinalRevisionId, correctionRevision.revision_id);
    assert.equal(canonical.scoring.lineupRevisionMatch, true);
    assert.equal(canonical.ranking.scoringRevisionMatch, true);
    assert.equal(canonical.publication.rankingRevisionMatch, true);
    const correctionJob = fixture.database.prepare(`SELECT status,lineup_revision_id,scoring_revision
      FROM contest_game_rescore_jobs WHERE contest_id=? AND internal_game_id=? AND id=?`).get(
      contestId, GAME_ID, `${contestId}:lineup-correction:2`);
    const correctionAudit = fixture.database.prepare(`SELECT status,lineup_version
      FROM contest_game_rescore_audits WHERE contest_id=? AND internal_game_id=? AND id=?`).get(
      contestId, GAME_ID, `${contestId}:lineup-correction:2`);
    assert.equal(correctionJob.status, "completed");
    assert.equal(correctionJob.lineup_revision_id, correctionRevision.revision_id);
    assert.equal(correctionJob.scoring_revision, 2);
    assert.equal(correctionAudit.status, "completed");
    assert.equal(correctionAudit.lineup_version, 2);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM contest_scoring_revisions WHERE internal_game_id = ? AND contest_id = ?").get(GAME_ID, contestId).count, 2);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM contest_ranking_reflection_revisions WHERE internal_game_id = ? AND contest_id = ?").get(GAME_ID, contestId).count, 2);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE job_type = 'ranking_rebuild'").get().count, 2);
    assert.equal(fixture.database.prepare("SELECT is_active, status FROM contest_scoring_revisions WHERE contest_id = ? AND id = ?").get(contestId, oldScoring.id).is_active, 0);
    assert.equal(fixture.database.prepare("SELECT scoring_revision_id FROM contest_ranking_reflection_revisions WHERE contest_id = ? AND scoring_revision_id = ?").get(contestId, oldReflection.scoring_revision_id).scoring_revision_id, oldReflection.scoring_revision_id);
    assert.equal(fixture.database.prepare("SELECT prediction_json FROM predictions WHERE id = 'prediction-1'").get().prediction_json, originalPredictionPayload);

    const beforeRerun = artifactCounts(fixture.database);
    const rerun = [];
    await runFormalCron(fixture.env, correctionAt, rerun);
    assert.deepEqual(rerun, []);
    assert.deepEqual(artifactCounts(fixture.database), beforeRerun);
  } finally {
    fixture.database.close();
  }
});

test("Golden Path C: B採点済み・ランキングA・publish retry_waitのmid-flightをranking Bから自然復旧する", async () => {
  const fixture = await createGoldenDb();
  try {
    const first = await completeGoldenPathA(fixture);
    const correction = await adminRequest(fixture.env, `/api/admin/v3/games/${GAME_ID}/lineup-correction`, {
      lineup: changedLineup(), reason: "Golden Path C mid-flight correction", confirmed: true
    });
    const correctionBody = await correction.json();
    assert.equal(correction.status, 202, JSON.stringify(correctionBody));

    const scoreAt = new Date(first.at.getTime() + 1000);
    await runFormalCron(fixture.env, scoreAt, []);
    assert.equal(fixture.database.prepare("SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?").get(GAME_ID).state, "scored");
    const currentScoring = fixture.database.prepare(
      "SELECT id, lineup_revision_id, status, is_active FROM game_scoring_revisions WHERE internal_game_id = ? AND is_active = 1"
    ).get(GAME_ID);
    assert.equal(currentScoring.status, "completed");
    assert.equal(currentScoring.lineup_revision_id.endsWith(":2"), true);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM contest_ranking_reflection_revisions WHERE internal_game_id = ? AND contest_id = ?").get(GAME_ID, createContestId(GAME_ID, "fighters")).count, 1);

    // Test-only fixture setup for the observed in-flight boundary: the state
    // was persisted as ranked and the old publish claim is waiting while the
    // new scoring revision has not yet been reflected.
    await transitionV3State(fixture.env.AUTH_DB, {
      internalGameId: GAME_ID, from: "scored", to: "ranked", now: scoreAt
    });
    const resumeBase = new Date(scoreAt.getTime() + 10 * 1000);
    const publishRetryAt = new Date(resumeBase.getTime() + 4 * 1000).toISOString();
    fixture.database.prepare(`
      UPDATE game_jobs_v3
         SET status = 'retry_wait', attempt_count = 1, next_retry_at = ?,
             claimed_at = NULL, claim_token = NULL, lease_expires_at = NULL,
             completed_at = NULL, failure_code = 'PUBLISH_RETRY_WAIT', failure_message = 'mid-flight fixture'
       WHERE internal_game_id = ? AND job_type = 'publish'
    `).run(publishRetryAt, GAME_ID);
    assert.equal(fixture.database.prepare("SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?").get(GAME_ID).state, "ranked");
    assert.equal(fixture.database.prepare("SELECT status FROM game_jobs_v3 WHERE job_type = 'publish'").get().status, "retry_wait");

    const executed = [];
    for (let pass = 0; pass < 5; pass += 1) {
      await runFormalCron(fixture.env, new Date(resumeBase.getTime() + (pass + 1) * 1000), executed);
    }
    assert.equal(executed.includes("ranking_rebuild"), true);
    assert.equal(executed.includes("publish"), true);
    const canonical = await evaluateCanonicalArtifactsFromDb(fixture.env.AUTH_DB, GAME_ID, createContestId(GAME_ID, "fighters"));
    assert.equal(canonical.aggregate.fullyPublished, true);
    assert.equal(canonical.lineup.canonicalFinalRevisionId.endsWith(":2"), true);
    assert.equal(canonical.scoring.lineupRevisionMatch, true);
    assert.equal(canonical.ranking.scoringRevisionMatch, true);
    assert.equal(fixture.database.prepare("SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?").get(GAME_ID).state, "published");

    const beforeRerun = artifactCounts(fixture.database);
    const rerun = [];
    await runFormalCron(fixture.env, new Date(resumeBase.getTime() + 10 * 1000), rerun);
    assert.deepEqual(rerun, []);
    assert.deepEqual(artifactCounts(fixture.database), beforeRerun);
  } finally {
    fixture.database.close();
  }
});

test("Golden Path D: stale persisted stateでもcanonical lineup→score→ranking→publishを段階復旧する", async () => {
  const fixture = await createGoldenDb();
  try {
    await completeGoldenPathA(fixture);
    fixture.database.prepare("UPDATE game_lineups SET publication_status = 'pending', published_at = NULL WHERE internal_game_id = ?").run(GAME_ID);
    fixture.database.prepare("UPDATE ranking_games SET publication_status = 'pending', published_at = NULL WHERE internal_game_id = ?").run(GAME_ID);
    fixture.database.prepare("UPDATE game_jobs_v3 SET status = 'cancelled', claimed_at = NULL, claim_token = NULL, lease_expires_at = NULL WHERE internal_game_id = ?").run(GAME_ID);

    const base = new Date(fixture.startAt.getTime() + 30 * 60 * 1000);
    const resetState = (state) => fixture.database.prepare(
      "UPDATE game_automation_v3_state SET state = ?, updated_at = ? WHERE internal_game_id = ?"
    ).run(state, base.toISOString(), GAME_ID);

    resetState("prediction_closed");
    await createDueJob(fixture, "score", base, 0);
    const scoreRun = [];
    await runFormalCron(fixture.env, new Date(base.getTime() + 1000), scoreRun, { formalPlanner: noOpFormalPlanner });
    assert.equal(scoreRun.includes("score"), true);
    assert.equal(fixture.database.prepare("SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?").get(GAME_ID).state, "scored");

    resetState("lineup_ready");
    await createDueJob(fixture, "ranking_rebuild", new Date(base.getTime() + 2000), 0);
    const rankingRun = [];
    await runFormalCron(fixture.env, new Date(base.getTime() + 3000), rankingRun, { formalPlanner: noOpFormalPlanner });
    assert.equal(rankingRun.includes("ranking_rebuild"), true);
    assert.equal(fixture.database.prepare("SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?").get(GAME_ID).state, "ranked");

    resetState("scored");
    await createDueJob(fixture, "publish", new Date(base.getTime() + 4000), 0);
    const publishRun = [];
    await runFormalCron(fixture.env, new Date(base.getTime() + 5000), publishRun, { formalPlanner: noOpFormalPlanner });
    assert.equal(publishRun.includes("publish"), true);
    const canonical = await evaluateGoldenCanonical(fixture);
    assert.equal(canonical.aggregate.fullyPublished, true);
    assert.equal(canonical.aggregate.artifactMismatch, false);
    assert.equal(fixture.database.prepare("SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?").get(GAME_ID).state, "published");
  } finally {
    fixture.database.close();
  }
});

test("Negative paths: canonical artifact mismatchはscore・ranking・publishを進めず、公開済み不整合も未完了扱いにする", async () => {
  const invalidLineup = await createGoldenDb();
  try {
    await completeGoldenPathA(invalidLineup);
    invalidLineup.database.prepare("UPDATE contest_lineup_revisions SET actual_lineup_json = '[]' WHERE internal_game_id = ? AND is_final = 1").run(GAME_ID);
    invalidLineup.database.prepare("UPDATE game_automation_v3_state SET state = 'prediction_closed' WHERE internal_game_id = ?").run(GAME_ID);
    const scoreJob = await createDueJob(invalidLineup, "score", new Date(invalidLineup.startAt.getTime() + 40 * 60 * 1000), 0);
    await runFormalCron(invalidLineup.env, new Date(invalidLineup.startAt.getTime() + 40 * 60 * 1000 + 1000), [], { formalPlanner: noOpFormalPlanner });
    const invalidCanonical = await evaluateGoldenCanonical(invalidLineup);
    assert.equal(invalidCanonical.aggregate.lineupReady, false);
    assert.notEqual(invalidLineup.database.prepare("SELECT status FROM game_jobs_v3 WHERE id = ?").get(scoreJob.job.id).status, "completed");
  } finally {
    invalidLineup.database.close();
  }

  const scoringMismatch = await createGoldenDb();
  try {
    await completeGoldenPathA(scoringMismatch);
    scoringMismatch.database.prepare("UPDATE contest_scoring_revisions SET status = 'failed' WHERE internal_game_id = ? AND is_active = 1").run(GAME_ID);
    scoringMismatch.database.prepare("UPDATE game_automation_v3_state SET state = 'scored' WHERE internal_game_id = ?").run(GAME_ID);
    const rankingJob = await createDueJob(scoringMismatch, "ranking_rebuild", new Date(scoringMismatch.startAt.getTime() + 40 * 60 * 1000), 0);
    await runFormalCron(scoringMismatch.env, new Date(scoringMismatch.startAt.getTime() + 40 * 60 * 1000 + 1000), [], { formalPlanner: noOpFormalPlanner });
    const mismatchCanonical = await evaluateGoldenCanonical(scoringMismatch);
    assert.equal(mismatchCanonical.aggregate.scoringReady, false);
    assert.notEqual(scoringMismatch.database.prepare("SELECT status FROM game_jobs_v3 WHERE id = ?").get(rankingJob.job.id).status, "completed");
  } finally {
    scoringMismatch.database.close();
  }

  const rankingMismatch = await createGoldenDb();
  try {
    await completeGoldenPathA(rankingMismatch);
    rankingMismatch.database.prepare("UPDATE contest_ranking_reflection_revisions SET status = 'failed' WHERE internal_game_id = ?").run(GAME_ID);
    rankingMismatch.database.prepare("UPDATE game_automation_v3_state SET state = 'ranked' WHERE internal_game_id = ?").run(GAME_ID);
    const publishJob = await createDueJob(rankingMismatch, "publish", new Date(rankingMismatch.startAt.getTime() + 40 * 60 * 1000), 0);
    await runFormalCron(rankingMismatch.env, new Date(rankingMismatch.startAt.getTime() + 40 * 60 * 1000 + 1000), [], { formalPlanner: noOpFormalPlanner });
    const mismatchCanonical = await evaluateGoldenCanonical(rankingMismatch);
    assert.equal(mismatchCanonical.aggregate.rankingReady, false);
    assert.notEqual(rankingMismatch.database.prepare("SELECT status FROM game_jobs_v3 WHERE id = ?").get(publishJob.job.id).status, "completed");
  } finally {
    rankingMismatch.database.close();
  }

  const publicationMismatch = await createGoldenDb();
  try {
    await completeGoldenPathA(publicationMismatch);
    publicationMismatch.database.prepare("UPDATE game_lineups SET published_at = NULL WHERE internal_game_id = ? AND contest_id = ?").run(GAME_ID, createContestId(GAME_ID, "fighters"));
    const canonical = await evaluateGoldenCanonical(publicationMismatch);
    assert.equal(canonical.aggregate.fullyPublished, false);
    assert.equal(canonical.aggregate.needsAttention, true);
  } finally {
    publicationMismatch.database.close();
  }
});

test("Negative paths: published-only artifact不備とfuture・wrong-date・cancelled・postponed・excluded correctionを拒否する", async () => {
  const fixture = await createGoldenDb();
  try {
    fixture.database.prepare("UPDATE game_automation_v3_state SET state = 'published' WHERE internal_game_id = ?").run(GAME_ID);
    const canonical = await evaluateGoldenCanonical(fixture);
    assert.equal(canonical.aggregate.fullyPublished, false);
    await assert.rejects(
      () => executeGameAutomationV3Job({ env: fixture.env, job: { job_type: "publish", contest_id: createContestId(GAME_ID, "fighters") }, internalGameId: GAME_ID, now: new Date() }),
      (error) => error?.code === "V3_RANKING_ARTIFACT_NOT_READY"
    );

    fixture.database.prepare("UPDATE game_automation_v3_state SET state = 'scheduled' WHERE internal_game_id = ?").run(GAME_ID);
    await completeGoldenPathA(fixture);
    const future = new Date(`${fixture.gameDate}T12:00:00+09:00`);
    future.setUTCDate(future.getUTCDate() + 1);
    fixture.database.prepare("UPDATE games SET game_date = ? WHERE internal_game_id = ?").run(currentJstDate(future), GAME_ID);
    const futureResponse = await adminRequest(fixture.env, `/api/admin/v3/games/${GAME_ID}/lineup-correction`, {
      lineup: changedLineup(), reason: "future rejection", confirmed: true
    });
    assert.equal(futureResponse.status, 409);
    assert.equal((await futureResponse.json()).code, "V3_LINEUP_CORRECTION_FUTURE_GAME");
    fixture.database.prepare("UPDATE games SET game_date = ?, game_status = ? WHERE internal_game_id = ?").run("wrong-date", "scheduled", GAME_ID);
    const wrongDate = await adminRequest(fixture.env, `/api/admin/v3/games/${GAME_ID}/lineup-correction`, {
      lineup: changedLineup(), reason: "wrong date rejection", confirmed: true
    });
    assert.equal(wrongDate.status, 409);
    assert.equal((await wrongDate.json()).code, "V3_LINEUP_CORRECTION_FUTURE_GAME");
    fixture.database.prepare("UPDATE games SET game_date = ? WHERE internal_game_id = ?").run(fixture.gameDate, GAME_ID);
    for (const status of ["cancelled", "postponed", "excluded"]) {
      fixture.database.prepare("UPDATE games SET game_status = ? WHERE internal_game_id = ?").run(status, GAME_ID);
      const response = await adminRequest(fixture.env, `/api/admin/v3/games/${GAME_ID}/lineup-correction`, {
        lineup: changedLineup(), reason: `${status} rejection`, confirmed: true
      });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, "V3_LINEUP_CORRECTION_GAME_UNAVAILABLE");
    }
  } finally {
    fixture.database.close();
  }
});

test("Duplicate Cron: 同一slotの並列plannerとclaimは一つのjob・一つの最終効果に収束する", async () => {
  const fixture = await createGoldenDb();
  try {
    await prepareManualLineup(fixture);
    const at = new Date(fixture.startAt.getTime() + 12 * 60 * 1000);
    const plannerOptions = { disabledStages: ["roster_fetch", "lineup_fetch"] };
    const [firstPlan, secondPlan] = await Promise.all([
      planMainWorkflowJobs(fixture.env.AUTH_DB, [planningGame(fixture, "scheduled")], at, plannerOptions),
      planMainWorkflowJobs(fixture.env.AUTH_DB, [planningGame(fixture, "scheduled")], at, plannerOptions)
    ]);
    const jobs = fixture.database.prepare(
      "SELECT job_type, scheduled_slot_at FROM game_jobs_v3 WHERE internal_game_id = ? ORDER BY id"
    ).all(GAME_ID);
    assert.equal(new Set(jobs.map((row) => `${row.job_type}:${row.scheduled_slot_at}`)).size, jobs.length);
    assert.equal(firstPlan.created + secondPlan.created, jobs.length);

    const claimed = await Promise.all([
      runFormalCron(fixture.env, at, []),
      runFormalCron(fixture.env, at, [])
    ]);
    assert.equal(claimed.some((run) => run.processed > 0), true);
    const executed = [];
    for (let pass = 0; pass < 5; pass += 1) {
      await runFormalCron(fixture.env, new Date(at.getTime() + (pass + 1) * 1000), executed);
    }
    const canonical = await evaluateGoldenCanonical(fixture);
    assert.equal(canonical.aggregate.fullyPublished, true);
    assert.equal(canonical.aggregate.artifactMismatch, false);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM game_scoring_revisions WHERE internal_game_id = ?").get(GAME_ID).count, 1);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM contest_ranking_reflection_revisions WHERE internal_game_id = ? AND contest_id = ?").get(GAME_ID, createContestId(GAME_ID, "fighters")).count, 1);
    const ranking = await rankingSnapshot(fixture);
    assert.equal(ranking.rows.length, 1);
    assert.equal(ranking.rows[0].totalScore, 99);
    assert.equal(ranking.rows[0].gamesPlayed, 1);
  } finally {
    fixture.database.close();
  }
});

test("Claim / lease: valid lease中の重複claimを拒否し、stale leaseはtokenを更新し、old completionを無効化する", async () => {
  const fixture = await createGoldenDb();
  try {
    const at = new Date(fixture.startAt.getTime() + 12 * 60 * 1000);
    const created = await createDueJob(fixture, "score", at, 11);
    const [first, duplicate] = await Promise.all([
      claimV3Job(fixture.env.AUTH_DB, { jobId: created.job.id, now: at }),
      claimV3Job(fixture.env.AUTH_DB, { jobId: created.job.id, now: at })
    ]);
    assert.equal(Boolean(first) !== Boolean(duplicate), true);
    const claimA = first || duplicate;
    assert.equal(claimA.status, "claimed");
    fixture.database.prepare(
      "UPDATE game_jobs_v3 SET lease_expires_at = ?, updated_at = ? WHERE id = ?"
    ).run(new Date(at.getTime() - 1000).toISOString(), at.toISOString(), created.job.id);
    const reclaimed = await claimV3Job(fixture.env.AUTH_DB, { jobId: created.job.id, now: new Date(at.getTime() + 2000) });
    assert.equal(reclaimed.status, "claimed");
    assert.notEqual(reclaimed.claim_token, claimA.claim_token);
    assert.equal(await completeV3Job(fixture.env.AUTH_DB, { jobId: created.job.id, claimToken: claimA.claim_token, now: at }), false);
    assert.equal(await completeV3Job(fixture.env.AUTH_DB, { jobId: created.job.id, claimToken: reclaimed.claim_token, now: new Date(at.getTime() + 3000) }), true);
    assert.equal(fixture.database.prepare("SELECT status FROM game_jobs_v3 WHERE id = ?").get(created.job.id).status, "completed");
  } finally {
    fixture.database.close();
  }
});

test("same score job reclaim後のA late successはB completed artifactに触れない", async () => {
  const fixture = await createGoldenDb();
  try {
    await prepareManualLineup(fixture);
    fixture.database.prepare("UPDATE game_automation_v3_state SET state='lineup_ready' WHERE internal_game_id=?").run(GAME_ID);
    const at = new Date(fixture.startAt.getTime() + 20 * 60 * 1000);
    const created = await createDueJob(fixture, "score", at, 41);
    const old = await claimV3Job(fixture.env.AUTH_DB, { jobId: created.job.id, now: at });
    const gate = { hit: deferred(), release: deferred() };
    const oldExecutor = executeGameAutomationV3Job({
      env: { ...fixture.env, AUTH_DB: gatedD1(fixture.database,
        (sql) => sql.includes("SELECT * FROM game_lineups WHERE internal_game_id"), gate) },
      job: old, internalGameId: GAME_ID, now: at
    });
    await gate.hit.promise;
    fixture.database.prepare("UPDATE game_jobs_v3 SET lease_expires_at = ? WHERE id = ?")
      .run(new Date(at.getTime() - 1000).toISOString(), old.id);
    const freshAt = new Date(at.getTime() + 2000);
    const fresh = await claimV3Job(fixture.env.AUTH_DB, { jobId: old.id, now: freshAt });
    assert.notEqual(old.claim_token, fresh.claim_token);
    const current = await executeGameAutomationV3Job({ env: fixture.env, job: fresh, internalGameId: GAME_ID, now: freshAt });
    const before = artifactCounts(fixture.database);
    gate.release.resolve();
    const stale = await oldExecutor;
    assert.equal(stale.status, "stale_no_op");
    assert.equal(stale.noOpReason, "V3_STALE_SCORE_EXECUTOR");
    assert.equal(current.status, "scored");
    assert.deepEqual(artifactCounts(fixture.database), before);
  } finally { fixture.database.close(); }
});

test("Stale score executor: Aを読み込んだ後のB correctionでAをcurrentへ再採用しない", async () => {
  const fixture = await createGoldenDb();
  try {
    const first = await prepareManualLineup(fixture);
    fixture.database.prepare("UPDATE game_automation_v3_state SET state = 'lineup_ready' WHERE internal_game_id = ?").run(GAME_ID);
    const at = new Date(fixture.startAt.getTime() + 20 * 60 * 1000);
    const created = await createDueJob(fixture, "score", at, 21);
    const claimed = await claimV3Job(fixture.env.AUTH_DB, { jobId: created.job.id, now: at });
    const gate = { hit: deferred(), release: deferred() };
    const gatedEnv = {
      ...fixture.env,
      AUTH_DB: gatedD1(
        fixture.database,
        (sql) => sql.includes("SELECT id, user_id, prediction_json FROM predictions")
          && sql.includes("is_test_prediction = 0"),
        gate
      )
    };
    const oldExecutor = executeGameAutomationV3Job({
      env: gatedEnv,
      job: claimed,
      internalGameId: GAME_ID,
      now: at
    });
    await gate.hit.promise;

    const correction = await adminRequest(fixture.env, `/api/admin/v3/games/${GAME_ID}/lineup-correction`, {
      lineup: changedLineup(), reason: "stale score race correction", confirmed: true
    });
    const correctionBody = await correction.json();
    assert.equal(correction.status, 202, JSON.stringify(correctionBody));
    const correctionRevision = correctionBody.correctionRevision.revisionId;
    gate.release.resolve();

    const oldResult = await oldExecutor;
    assert.equal(oldResult.status, "stale_no_op");
    assert.equal(oldResult.noOpReason, "V3_STALE_SCORE_EXECUTOR");
    assert.equal(await completeV3Job(fixture.env.AUTH_DB, { jobId: claimed.id, claimToken: claimed.claim_token, now: at }), true);

    const canonical = await evaluateGoldenCanonical(fixture);
    assert.equal(canonical.lineup.canonicalFinalRevisionId, correctionRevision);
    assert.equal(canonical.aggregate.lineupReady, true);
    assert.equal(canonical.aggregate.scoringReady, false);
    assert.equal(canonical.aggregate.rankingReady, false);
    assert.equal(canonical.aggregate.publicationReady, false);
    assert.equal(canonical.aggregate.fullyPublished, false);
    assert.equal(canonical.aggregate.needsAttention, false);
    assert.equal(canonical.aggregate.reprocessingRequired, false);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM contest_scoring_revisions WHERE internal_game_id = ? AND contest_id = ? AND status = 'completed' AND is_active = 1").get(GAME_ID, createContestId(GAME_ID, "fighters")).count, 0);
    assert.equal(fixture.database.prepare("SELECT prediction_json, actual_lineup_json FROM predictions WHERE id = 'prediction-1'").get().actual_lineup_json, null);
    assert.notEqual(first.saveBody.revision.revisionId, correctionRevision);
  } finally {
    fixture.database.close();
  }
});

test("Stale ranking / publish executor: Aの遅延完了はBのreadinessとpublicationを汚染しない", async () => {
  const fixture = await createGoldenDb();
  try {
    const first = await completeGoldenPathA(fixture);
    const staleRanking = await createDueJob(fixture, "ranking_rebuild", new Date(first.at.getTime() + 1000), 31);
    const stalePublish = await createDueJob(fixture, "publish", new Date(first.at.getTime() + 2000), 32);
    const rankingClaim = await claimV3Job(fixture.env.AUTH_DB, { jobId: staleRanking.job.id, now: new Date(first.at.getTime() + 3000) });
    const publishClaim = await claimV3Job(fixture.env.AUTH_DB, { jobId: stalePublish.job.id, now: new Date(first.at.getTime() + 3000) });

    const correction = await adminRequest(fixture.env, `/api/admin/v3/games/${GAME_ID}/lineup-correction`, {
      lineup: changedLineup(), reason: "stale ranking and publish race correction", confirmed: true
    });
    const correctionBody = await correction.json();
    assert.equal(correction.status, 202, JSON.stringify(correctionBody));
    const correctionRevision = correctionBody.correctionRevision.revisionId;

    await assert.rejects(
      () => executeGameAutomationV3Job({ env: fixture.env, job: rankingClaim, internalGameId: GAME_ID, now: new Date(first.at.getTime() + 4000) }),
      (error) => error?.code === "V3_SCORING_ARTIFACT_NOT_READY"
    );
    await assert.rejects(
      () => executeGameAutomationV3Job({ env: fixture.env, job: publishClaim, internalGameId: GAME_ID, now: new Date(first.at.getTime() + 5000) }),
      (error) => error?.code === "V3_RANKING_ARTIFACT_NOT_READY"
    );
    await retryV3Job(fixture.env.AUTH_DB, {
      jobId: rankingClaim.id, claimToken: rankingClaim.claim_token, attemptCount: rankingClaim.attempt_count,
      maxAttempts: rankingClaim.max_attempts, now: new Date(first.at.getTime() + 4000), errorCode: "STALE_RANKING", errorMessage: "stale fixture",
      retryAt: new Date(first.at.getTime() + 10 * 1000)
    });
    await retryV3Job(fixture.env.AUTH_DB, {
      jobId: publishClaim.id, claimToken: publishClaim.claim_token, attemptCount: publishClaim.attempt_count,
      maxAttempts: publishClaim.max_attempts, now: new Date(first.at.getTime() + 5000), errorCode: "STALE_PUBLISH", errorMessage: "stale fixture",
      retryAt: new Date(first.at.getTime() + 12 * 1000)
    });

    const during = await evaluateCanonicalArtifactsFromDb(fixture.env.AUTH_DB, GAME_ID);
    assert.equal(during.lineup.canonicalFinalRevisionId, correctionRevision);
    assert.equal(during.aggregate.scoringReady, false);
    assert.equal(during.aggregate.rankingReady, false);
    assert.equal(during.aggregate.publicationReady, false);
    assert.equal(during.aggregate.fullyPublished, false);
    assert.equal(fixture.database.prepare("SELECT publication_status FROM game_lineups WHERE internal_game_id = ?").get(GAME_ID).publication_status, "pending");

    const executed = [];
    for (let pass = 0; pass < 5; pass += 1) {
      await runFormalCron(fixture.env, new Date(first.at.getTime() + 10 * 1000 + pass * 1000), executed);
    }
    const final = await evaluateGoldenCanonical(fixture);
    assert.equal(final.lineup.canonicalFinalRevisionId, correctionRevision);
    assert.equal(final.aggregate.fullyPublished, true);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM contest_ranking_reflection_revisions WHERE internal_game_id = ? AND contest_id = ?").get(GAME_ID, createContestId(GAME_ID, "fighters")).count, 2);
    const ranking = await rankingSnapshot(fixture);
    assert.equal(ranking.rows[0].totalScore, 88);
    assert.equal(ranking.rows[0].gamesPlayed, 1);
  } finally {
    fixture.database.close();
  }
});

test("Correction B→C: 遅延B jobがC canonicalを上書きせず、Cだけが最終lineageになる", async () => {
  const fixture = await createGoldenDb();
  try {
    const first = await completeGoldenPathA(fixture);
    const correctionB = await adminRequest(fixture.env, `/api/admin/v3/games/${GAME_ID}/lineup-correction`, {
      lineup: changedLineup(), reason: "correction B", confirmed: true
    });
    const bodyB = await correctionB.json();
    assert.equal(correctionB.status, 202, JSON.stringify(bodyB));
    await new Promise((resolve) => setTimeout(resolve, 2));
    const correctionCLineup = normalLineup().map((row, index) => index === 1
      ? { ...row, playerId: getManualLineupPlayerCatalog()[10].playerId, playerName: getManualLineupPlayerCatalog()[10].playerName, uniformNumber: String(getManualLineupPlayerCatalog()[10].uniformNumber) }
      : row);
    const correctionC = await adminRequest(fixture.env, `/api/admin/v3/games/${GAME_ID}/lineup-correction`, {
      lineup: correctionCLineup, reason: "correction C", confirmed: true
    });
    const bodyC = await correctionC.json();
    assert.equal(correctionC.status, 202, JSON.stringify(bodyC));
    assert.notEqual(bodyB.correctionRevision.revisionId, bodyC.correctionRevision.revisionId);

    const executed = [];
    for (let pass = 0; pass < 8; pass += 1) {
      await runFormalCron(fixture.env, new Date(first.at.getTime() + 2 * 1000 + pass * 1000), executed);
    }
    const canonical = await evaluateGoldenCanonical(fixture);
    assert.equal(canonical.lineup.canonicalFinalRevisionId, bodyC.correctionRevision.revisionId);
    assert.equal(canonical.aggregate.fullyPublished, true);
    assert.equal(canonical.scoring.lineupRevisionMatch, true);
    assert.equal(canonical.ranking.scoringRevisionMatch, true);
    assert.equal(canonical.publication.rankingRevisionMatch, true);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM game_scoring_revisions WHERE internal_game_id = ?").get(GAME_ID).count, 2);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM contest_ranking_reflection_revisions WHERE internal_game_id = ? AND contest_id = ?").get(GAME_ID, createContestId(GAME_ID, "fighters")).count, 2);
    const ranking = await rankingSnapshot(fixture);
    assert.equal(ranking.rows[0].totalScore, 88);
    assert.equal(ranking.rows[0].gamesPlayed, 1);
  } finally {
    fixture.database.close();
  }
});

test("Partial artifact/job failure: artifact作成後のscore・ranking・publish失敗をretryしても二重効果を作らない", async () => {
  const fixture = await createGoldenDb();
  try {
    await prepareManualLineup(fixture);
    const baseAt = new Date(fixture.startAt.getTime() + 1000);
    fixture.database.prepare(
      "UPDATE game_automation_v3_state SET state = 'lineup_ready', version = version + 1, updated_at = ? WHERE internal_game_id = ?"
    ).run(baseAt.toISOString(), GAME_ID);

    const runWithPostArtifactFailure = async (jobType, firstAt, slotSuffix, artifactCheck) => {
      await createDueJob(fixture, jobType, firstAt, slotSuffix);
      let failAfterArtifact = true;
      const executeJob = async (context) => {
        const result = await executeGameAutomationV3Job(context);
        if (jobType === "score") return result;
        if (failAfterArtifact) {
          failAfterArtifact = false;
          throw new Error(`test failure after ${jobType} artifact`);
        }
        return result;
      };
      const firstRun = await runGameAutomationV3(fixture.env, firstAt, {
        formalPlanner: (db, games, at) => planMainWorkflowJobs(db, games, at, {
          disabledStages: ["roster_fetch", "lineup_fetch"]
        }),
        auxiliaryPlanner: async () => ({ created: 0, planned: [], diagnostics: [], errors: [] }),
        executeJob
      });
      assert.equal(firstRun.execution.failed, jobType === "score" ? 0 : 1);
      assert.equal(firstRun.execution.retryWait, jobType === "score" ? 0 : 1);
      assert.equal((await artifactCheck()).ready, true);
      if (jobType === "score") return;
      const retryAt = new Date(firstAt.getTime() + 10 * 60 * 1000 + 1000);
      const retryErrors = [];
      const secondRun = await runGameAutomationV3(fixture.env, retryAt, {
        formalPlanner: (db, games, at) => planMainWorkflowJobs(db, games, at, {
          disabledStages: ["roster_fetch", "lineup_fetch"]
        }),
        auxiliaryPlanner: async () => ({ created: 0, planned: [], diagnostics: [], errors: [] }),
        onError: (error, context) => retryErrors.push({ code: error?.code || null, message: String(error?.message || ""), stage: context?.stage || null, jobId: context?.job?.id || null }),
        executeJob: async (context) => executeGameAutomationV3Job(context)
      });
      assert.equal(secondRun.execution.failed, 0, `retry failed for ${jobType}: ${JSON.stringify(secondRun.execution)} errors=${JSON.stringify(retryErrors)} jobs=${JSON.stringify(fixture.database.prepare("SELECT id, job_type, status, attempt_count, failure_code, failure_message FROM game_jobs_v3 ORDER BY id").all())}`);
      assert.equal(fixture.database.prepare("SELECT status FROM game_jobs_v3 WHERE job_type = ? ORDER BY id DESC LIMIT 1").get(jobType).status, "completed");
    };

    await runWithPostArtifactFailure("score", baseAt, 1, async () => {
      const canonical = await evaluateGoldenCanonical(fixture);
      return { ready: canonical.aggregate.scoringReady };
    });
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM game_scoring_revisions WHERE internal_game_id = ?").get(GAME_ID).count, 1);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM predictions WHERE internal_game_id = ? AND scoring_status = 'scored'").get(GAME_ID).count, 1);

    const rankingAt = new Date(baseAt.getTime() + 20 * 60 * 1000);
    await runWithPostArtifactFailure("ranking_rebuild", rankingAt, 2, async () => {
      const canonical = await evaluateGoldenCanonical(fixture);
      return { ready: canonical.aggregate.rankingReady };
    });
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM contest_ranking_reflection_revisions WHERE internal_game_id = ? AND contest_id = ?").get(GAME_ID, createContestId(GAME_ID, "fighters")).count, 1);
    const rankingBeforePublish = await rankingSnapshot(fixture, { publishedOnly: false });
    assert.equal(rankingBeforePublish.rows[0].totalScore, 99);
    assert.equal(rankingBeforePublish.rows[0].gamesPlayed, 1);

    const publishAt = new Date(rankingAt.getTime() + 20 * 60 * 1000);
    await runWithPostArtifactFailure("publish", publishAt, 3, async () => {
      const canonical = await evaluateGoldenCanonical(fixture);
      return { ready: canonical.aggregate.publicationReady };
    });
    const final = await evaluateGoldenCanonical(fixture);
    assert.equal(final.aggregate.fullyPublished, true);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM contest_ranking_reflection_revisions WHERE internal_game_id = ? AND contest_id = ?").get(GAME_ID, createContestId(GAME_ID, "fighters")).count, 1);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM game_scoring_revisions WHERE internal_game_id = ?").get(GAME_ID).count, 1);
    const rankingAfterPublish = await rankingSnapshot(fixture, { publishedOnly: false });
    assert.deepEqual(rankingAfterPublish.rows, rankingBeforePublish.rows);
  } finally {
    fixture.database.close();
  }
});

test("Stale publish executor: Bのpublication batch直前のC correctionでBを公開しない", async () => {
  const fixture = await createGoldenDb();
  try {
    const first = await completeGoldenPathA(fixture);
    const correctionB = await adminRequest(fixture.env, `/api/admin/v3/games/${GAME_ID}/lineup-correction`, {
      lineup: changedLineup(), reason: "publish race correction B", confirmed: true
    });
    const bodyB = await correctionB.json();
    assert.equal(correctionB.status, 202, JSON.stringify(bodyB));

    const scoreAt = new Date(first.at.getTime() + 1000);
    await runFormalCron(fixture.env, scoreAt, []);
    const rankingJob = await createDueJob(fixture, "ranking_rebuild", new Date(scoreAt.getTime() + 1000), 40);
    const rankingClaim = await claimV3Job(fixture.env.AUTH_DB, { jobId: rankingJob.job.id, now: new Date(scoreAt.getTime() + 2000) });
    const rankingResult = await executeGameAutomationV3Job({
      env: fixture.env,
      job: rankingClaim,
      internalGameId: GAME_ID,
      now: new Date(scoreAt.getTime() + 3000)
    });
    assert.equal(rankingResult.stateAfter, "ranked");
    assert.equal(await completeV3Job(fixture.env.AUTH_DB, { jobId: rankingClaim.id, claimToken: rankingClaim.claim_token, now: new Date(scoreAt.getTime() + 3000) }), true);
    await transitionV3State(fixture.env.AUTH_DB, { internalGameId: GAME_ID, from: "scored", to: "ranked", now: new Date(scoreAt.getTime() + 3000) });
    const beforePublish = await evaluateGoldenCanonical(fixture);
    assert.equal(beforePublish.aggregate.rankingReady, true);
    assert.equal(beforePublish.aggregate.publicationReady, false);
    assert.equal(fixture.database.prepare("SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?").get(GAME_ID).state, "ranked");

    const publishJob = await createDueJob(fixture, "publish", new Date(scoreAt.getTime() + 2000), 41);
    const publishClaim = await claimV3Job(fixture.env.AUTH_DB, { jobId: publishJob.job.id, now: new Date(scoreAt.getTime() + 3000) });
    const gate = { hit: deferred(), release: deferred() };
    const gatedEnv = { ...fixture.env, AUTH_DB: gatedBatchD1(fixture.database, gate) };
    const oldPublish = executeGameAutomationV3Job({
      env: gatedEnv,
      job: publishClaim,
      internalGameId: GAME_ID,
      now: new Date(scoreAt.getTime() + 4000)
    });
    await gate.hit.promise;

    const correctionCLineup = normalLineup().map((row, index) => index === 1
      ? { ...row, playerId: getManualLineupPlayerCatalog()[10].playerId, playerName: getManualLineupPlayerCatalog()[10].playerName, uniformNumber: String(getManualLineupPlayerCatalog()[10].uniformNumber) }
      : row);
    const correctionC = await adminRequest(fixture.env, `/api/admin/v3/games/${GAME_ID}/lineup-correction`, {
      lineup: correctionCLineup, reason: "publish race correction C", confirmed: true
    });
    const bodyC = await correctionC.json();
    assert.equal(correctionC.status, 202, JSON.stringify(bodyC));
    assert.notEqual(bodyB.correctionRevision.revisionId, bodyC.correctionRevision.revisionId);
    gate.release.resolve();

    const oldResult = await oldPublish;
    assert.equal(oldResult.status, "stale_no_op");
    assert.equal(oldResult.noOpReason, "V3_STALE_LINEUP_REVISION");
    assert.equal(fixture.database.prepare("SELECT publication_status FROM game_lineups WHERE internal_game_id = ?").get(GAME_ID).publication_status, "pending");
    assert.equal(fixture.database.prepare("SELECT publication_status FROM contest_ranking_games WHERE internal_game_id = ? AND contest_id = ?").get(GAME_ID, createContestId(GAME_ID, "fighters")).publication_status, "pending");
    assert.equal(await completeV3Job(fixture.env.AUTH_DB, { jobId: publishClaim.id, claimToken: publishClaim.claim_token, now: new Date(scoreAt.getTime() + 5000) }), true);
    const canonical = await evaluateGoldenCanonical(fixture);
    assert.equal(canonical.lineup.canonicalFinalRevisionId, bodyC.correctionRevision.revisionId);
    assert.equal(canonical.aggregate.publicationReady, false);
  } finally {
    fixture.database.close();
  }
});

test("Concurrent manual finalize: 競合するfinalizeでもcanonical pointerとactual lineupを同じrevisionへ収束させる", async () => {
  const fixture = await createGoldenDb();
  try {
    const [saveA, saveB] = await Promise.all([
      adminRequest(fixture.env, `/api/admin/v3/games/${GAME_ID}/lineup-revisions`, {
        lineup: normalLineup(), reason: "concurrent finalize A", confirmed: true
      }),
      adminRequest(fixture.env, `/api/admin/v3/games/${GAME_ID}/lineup-revisions`, {
        lineup: changedLineup(), reason: "concurrent finalize B", confirmed: true
      })
    ]);
    const bodyA = await saveA.json();
    const bodyB = await saveB.json();
    assert.equal(saveA.status, 201, JSON.stringify(bodyA));
    assert.equal(saveB.status, 201, JSON.stringify(bodyB));

    const [finalizeA, finalizeB] = await Promise.all([
      adminRequest(fixture.env, `/api/admin/v3/games/${GAME_ID}/lineup-finalize`, {
        lineupRevisionId: bodyA.revision.revisionId, confirmed: true
      }),
      adminRequest(fixture.env, `/api/admin/v3/games/${GAME_ID}/lineup-finalize`, {
        lineupRevisionId: bodyB.revision.revisionId, confirmed: true
      })
    ]);
    const finalizeBodyA = await finalizeA.json();
    const finalizeBodyB = await finalizeB.json();
    assert.equal([200, 409].includes(finalizeA.status), true, JSON.stringify(finalizeBodyA));
    assert.equal([200, 409].includes(finalizeB.status), true, JSON.stringify(finalizeBodyB));
    assert.equal([finalizeA.status, finalizeB.status].some((status) => status === 200), true);

    const currentFinals = fixture.database.prepare(
      "SELECT revision_id, actual_lineup_json FROM game_lineup_revisions WHERE internal_game_id = ? AND is_current = 1 AND is_final = 1"
    ).all(GAME_ID);
    const canonical = fixture.database.prepare(
      "SELECT final_lineup_revision_id, actual_lineup_json FROM game_lineups WHERE internal_game_id = ?"
    ).get(GAME_ID);
    assert.equal(currentFinals.length, 1);
    assert.equal(canonical.final_lineup_revision_id, currentFinals[0].revision_id);
    assert.equal(canonical.actual_lineup_json, currentFinals[0].actual_lineup_json);
  } finally {
    fixture.database.close();
  }
});

test("Phase 7.5: S9simu candidateからauto-final、prediction_close、score、ranking、publishまで正式executorで完走する", async () => {
  const fixture = await createGoldenDb({ npbGameCode: "f-h-1" });
  try {
    const autoEnv = {
      ...fixture.env,
      ENVIRONMENT: "test",
      ENABLE_DEVELOPMENT_MODE: "true",
      NPB_SOURCE: "simulator",
      S9SIMU_BASE_URL: "https://s9simu.example.test"
    };
    const target = {
      internalGameId: GAME_ID,
      gameDate: fixture.gameDate,
      homeTeam: "fighters",
      awayTeam: "hawks",
      npbGameCode: fixture.npbGameCode,
      status: "scheduled"
    };
    const candidate = await runLineupCandidatePipeline({
      env: autoEnv,
      target,
      db: fixture.env.AUTH_DB,
      fetchImpl: async () => new Response(simulatorLineupHtml(fixture), { status: 200 }),
      now: new Date(fixture.startAt.getTime() - 5 * 60 * 1000),
      autoFinalEnabled: true
    });
    assert.equal(candidate.status, "verified");
    assert.equal(candidate.persisted.status, "created");
    assert.equal(candidate.finalized.status, "finalized");
    assert.deepEqual(buildLineupAlertSignal(candidate), {});

    const finalRow = fixture.database.prepare(
      "SELECT final_lineup_revision_id, lineup_source, actual_lineup_json FROM game_lineups WHERE internal_game_id = ?"
    ).get(GAME_ID);
    const finalRevision = fixture.database.prepare(
      "SELECT revision_id, is_current, is_final, validation_json, actual_lineup_json FROM game_lineup_revisions WHERE internal_game_id = ? AND version = ?"
    ).get(GAME_ID, candidate.finalized.revision.version);
    assert.equal(finalRow.final_lineup_revision_id, finalRevision.revision_id);
    assert.equal(finalRow.lineup_source, "npb-auto");
    assert.equal(finalRevision.is_current, 1);
    assert.equal(finalRevision.is_final, 1);
    assert.equal(JSON.parse(finalRevision.validation_json).lifecycleStatus, "verified");
    assert.equal(JSON.parse(finalRevision.actual_lineup_json).length, 9);
    assert.equal(finalRow.actual_lineup_json, finalRevision.actual_lineup_json);

    const executed = [];
    const at = new Date(fixture.startAt.getTime() + 12 * 60 * 1000);
    for (let pass = 0; pass < 5; pass += 1) await runFormalCron(fixture.env, at, executed);

    assert.deepEqual(executed.slice(0, 4), ["prediction_close", "score", "ranking_rebuild", "publish"]);
    const canonical = await evaluateGoldenCanonical(fixture);
    assert.equal(canonical.aggregate.fullyPublished, true);
    assert.equal(canonical.aggregate.lineupReady, true);
    assert.equal(canonical.aggregate.scoringReady, true);
    assert.equal(canonical.aggregate.rankingReady, true);
    assert.equal(canonical.aggregate.publicationReady, true);
    assert.equal(canonical.aggregate.artifactMismatch, false);
    assert.equal(canonical.lineup.canonicalFinalRevisionId, finalRevision.revision_id);
    assert.equal(canonical.scoring.lineupRevisionMatch, true);
    assert.equal(canonical.ranking.scoringRevisionMatch, true);
    assert.equal(canonical.publication.rankingRevisionMatch, true);
    assert.equal(fixture.database.prepare("SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?").get(GAME_ID).state, "published");

    // The downstream consumer must see the same canonical contract as a
    // manual final. Only source metadata and revision identity are expected
    // to differ between the two development fixtures.
    const manualFixture = await createGoldenDb({ npbGameCode: "f-h-3" });
    try {
      await completeGoldenPathA(manualFixture);
      const manualCanonical = await evaluateGoldenCanonical(manualFixture);
      assert.equal(canonical.aggregate.fullyPublished, manualCanonical.aggregate.fullyPublished);
      assert.equal(canonical.lineup.lineupValid, manualCanonical.lineup.lineupValid);
      assert.equal(canonical.scoring.valid, manualCanonical.scoring.valid);
      assert.equal(canonical.ranking.valid, manualCanonical.ranking.valid);
      assert.equal(canonical.publication.valid, manualCanonical.publication.valid);
      assert.equal(canonical.scoring.lineupRevisionMatch, manualCanonical.scoring.lineupRevisionMatch);
      assert.equal(canonical.ranking.scoringRevisionMatch, manualCanonical.ranking.scoringRevisionMatch);
      assert.equal(canonical.publication.rankingRevisionMatch, manualCanonical.publication.rankingRevisionMatch);
    } finally {
      manualFixture.database.close();
    }

    const before = artifactCounts(fixture.database);
    const refetched = await runLineupCandidatePipeline({
      env: autoEnv,
      target,
      db: fixture.env.AUTH_DB,
      fetchImpl: async () => new Response(simulatorLineupHtml(fixture), { status: 200 }),
      now: new Date(fixture.startAt.getTime() + 13 * 60 * 1000),
      autoFinalEnabled: true
    });
    assert.equal(refetched.persisted.status, "no_op");
    const rerun = [];
    await runFormalCron(fixture.env, at, rerun);
    assert.deepEqual(rerun, []);
    assert.deepEqual(artifactCounts(fixture.database), before);
  } finally {
    fixture.database.close();
  }
});

test("Phase 7.5 delayed lineup: 未発表ではfinal/alertを作らず、発表後は同じformal pathで完走する", async () => {
  const fixture = await createGoldenDb({ npbGameCode: "f-h-2" });
  try {
    const autoEnv = {
      ...fixture.env,
      ENVIRONMENT: "test",
      ENABLE_DEVELOPMENT_MODE: "true",
      NPB_SOURCE: "simulator",
      S9SIMU_BASE_URL: "https://s9simu.example.test"
    };
    const target = {
      internalGameId: GAME_ID,
      gameDate: fixture.gameDate,
      homeTeam: "fighters",
      awayTeam: "hawks",
      npbGameCode: fixture.npbGameCode,
      status: "scheduled"
    };
    const delayed = await runLineupCandidatePipeline({
      env: autoEnv,
      target,
      db: fixture.env.AUTH_DB,
      fetchImpl: async () => new Response(simulatorLineupHtml(fixture, [], "scheduled"), { status: 200 }),
      now: new Date(fixture.startAt.getTime() - 5 * 60 * 1000),
      autoFinalEnabled: true
    });
    assert.equal(delayed.status, "not_published");
    assert.deepEqual(delayed.alertSignal, {});
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM game_lineup_revisions WHERE is_final = 1").get().count, 0);

    const recovered = await runLineupCandidatePipeline({
      env: autoEnv,
      target,
      db: fixture.env.AUTH_DB,
      fetchImpl: async () => new Response(simulatorLineupHtml(fixture), { status: 200 }),
      now: new Date(fixture.startAt.getTime() - 2 * 60 * 1000),
      autoFinalEnabled: true
    });
    assert.equal(recovered.status, "verified");
    assert.equal(recovered.finalized.status, "finalized");

    const executed = [];
    const at = new Date(fixture.startAt.getTime() + 12 * 60 * 1000);
    for (let pass = 0; pass < 5; pass += 1) await runFormalCron(fixture.env, at, executed);
    assert.deepEqual(executed.slice(0, 4), ["prediction_close", "score", "ranking_rebuild", "publish"]);
    const canonical = await evaluateGoldenCanonical(fixture);
    assert.equal(canonical.aggregate.fullyPublished, true);
    assert.equal(canonical.aggregate.artifactMismatch, false);
  } finally {
    fixture.database.close();
  }
});
