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
import { createV3Job, runGameAutomationV3, planMainWorkflowJobs, transitionV3State } from "../game-automation-v3.js";
import { evaluateCanonicalArtifactsFromDb } from "../backend/automation-v3/canonical-artifact-evaluator.js";

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
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
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

async function createGoldenDb() {
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
    ) VALUES (?, ?, ?, 'fighters', 'hawks', 'f-h-golden-1', 'scheduled', 1, NULL,
      'resolved', ?, 'test-fixture', 'https://npb.example/golden-1', ?, ?)
  `).run(GAME_ID, gameDate, startAt.toISOString(), timestamp, timestamp, timestamp);
  database.prepare(`
    INSERT INTO game_automation_v3_state (internal_game_id, state, version, created_at, updated_at)
    VALUES (?, 'scheduled', 0, ?, ?)
  `).run(GAME_ID, timestamp, timestamp);
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
      id, user_id, game_id, internal_game_id, prediction_json, schema_version,
      game_date, home_team, away_team, opponent_code, is_home, submitted_at, updated_at,
      status, is_test_prediction, scoring_status
    ) VALUES (?, ?, ?, ?, ?, 1, ?, 'fighters', 'hawks', 'hawks', 1, ?, ?, 'submitted', 0, 'pending')
  `).run("prediction-1", "operator-1", GAME_ID, GAME_ID, JSON.stringify({ schemaVersion: 1, lineup }), gameDate, timestamp, timestamp);

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
    lineup
  };
}

async function runFormalCron(env, now, executed = [], { formalPlanner = null } = {}) {
  return runGameAutomationV3(env, now, {
    formalPlanner: formalPlanner || ((db, games, at) => planMainWorkflowJobs(db, games, at, {
      disabledStages: ["roster_fetch", "lineup_fetch"]
    })),
    auxiliaryPlanner: async () => ({ created: 0, planned: [], diagnostics: [], errors: [] }),
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
    jobType,
    scheduledAt: new Date(at.getTime() - 1000),
    scheduledSlotAt: new Date(at.getTime() - 1000 + suffix).toISOString()
  });
}

async function completeGoldenPathA(fixture) {
  const save = await adminRequest(fixture.env, `/api/admin/v3/games/${GAME_ID}/lineup-revisions`, {
      lineup: normalLineup(), reason: "Golden Path A fixture", confirmed: true
  });
  const saveBody = await save.json();
  assert.equal(save.status, 201, JSON.stringify(saveBody));

  const finalize = await adminRequest(fixture.env, `/api/admin/v3/games/${GAME_ID}/lineup-finalize`, {
      lineupRevisionId: saveBody.revision.revisionId, confirmed: true
  });
  const finalizeBody = await finalize.json();
  assert.equal(finalize.status, 200, JSON.stringify(finalizeBody));
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
    score: database.prepare("SELECT score FROM predictions WHERE id = 'prediction-1'").get().score
  };
}

test("Golden Path A: prediction closeからmanual lineup、score、ranking、publishまでを正式executorで完了する", async () => {
  const fixture = await createGoldenDb();
  try {
    const result = await completeGoldenPathA(fixture);
    assert.deepEqual(result.executed.slice(0, 4), ["prediction_close", "score", "ranking_rebuild", "publish"]);
    const canonical = await evaluateCanonicalArtifactsFromDb(fixture.env.AUTH_DB, GAME_ID);
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

test("Golden Path B: 公開後のA→B correctionは旧revisionを保持してBだけを再採点・再反映・再公開する", async () => {
  const fixture = await createGoldenDb();
  try {
    const first = await completeGoldenPathA(fixture);
    const oldScoring = fixture.database.prepare("SELECT id FROM game_scoring_revisions WHERE internal_game_id = ? AND is_active = 1").get(GAME_ID);
    const oldReflection = fixture.database.prepare("SELECT scoring_revision_id FROM ranking_reflection_revisions WHERE internal_game_id = ? ORDER BY ranking_update_revision DESC LIMIT 1").get(GAME_ID);
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
    const canonical = await evaluateCanonicalArtifactsFromDb(fixture.env.AUTH_DB, GAME_ID);
    assert.equal(canonical.aggregate.fullyPublished, true);
    assert.equal(canonical.lineup.canonicalFinalRevisionId, correctionRevision.revision_id);
    assert.equal(canonical.scoring.lineupRevisionMatch, true);
    assert.equal(canonical.ranking.scoringRevisionMatch, true);
    assert.equal(canonical.publication.rankingRevisionMatch, true);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM game_scoring_revisions WHERE internal_game_id = ?").get(GAME_ID).count, 2);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM ranking_reflection_revisions WHERE internal_game_id = ?").get(GAME_ID).count, 2);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE job_type = 'ranking_rebuild'").get().count, 2);
    assert.equal(fixture.database.prepare("SELECT is_active, status FROM game_scoring_revisions WHERE id = ?").get(oldScoring.id).is_active, 0);
    assert.equal(fixture.database.prepare("SELECT scoring_revision_id FROM ranking_reflection_revisions WHERE scoring_revision_id = ?").get(oldReflection.scoring_revision_id).scoring_revision_id, oldReflection.scoring_revision_id);
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
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM ranking_reflection_revisions WHERE internal_game_id = ?").get(GAME_ID).count, 1);

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
    const canonical = await evaluateCanonicalArtifactsFromDb(fixture.env.AUTH_DB, GAME_ID);
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
    const canonical = await evaluateCanonicalArtifactsFromDb(fixture.env.AUTH_DB, GAME_ID);
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
    invalidLineup.database.prepare("UPDATE game_lineup_revisions SET actual_lineup_json = '[]' WHERE internal_game_id = ? AND is_final = 1").run(GAME_ID);
    invalidLineup.database.prepare("UPDATE game_automation_v3_state SET state = 'prediction_closed' WHERE internal_game_id = ?").run(GAME_ID);
    const scoreJob = await createDueJob(invalidLineup, "score", new Date(invalidLineup.startAt.getTime() + 40 * 60 * 1000), 0);
    await runFormalCron(invalidLineup.env, new Date(invalidLineup.startAt.getTime() + 40 * 60 * 1000 + 1000), [], { formalPlanner: noOpFormalPlanner });
    const invalidCanonical = await evaluateCanonicalArtifactsFromDb(invalidLineup.env.AUTH_DB, GAME_ID);
    assert.equal(invalidCanonical.aggregate.lineupReady, false);
    assert.notEqual(invalidLineup.database.prepare("SELECT status FROM game_jobs_v3 WHERE id = ?").get(scoreJob.job.id).status, "completed");
  } finally {
    invalidLineup.database.close();
  }

  const scoringMismatch = await createGoldenDb();
  try {
    await completeGoldenPathA(scoringMismatch);
    scoringMismatch.database.prepare("UPDATE game_scoring_revisions SET lineup_revision_id = 'wrong-lineup-revision' WHERE internal_game_id = ? AND is_active = 1").run(GAME_ID);
    scoringMismatch.database.prepare("UPDATE game_automation_v3_state SET state = 'scored' WHERE internal_game_id = ?").run(GAME_ID);
    const rankingJob = await createDueJob(scoringMismatch, "ranking_rebuild", new Date(scoringMismatch.startAt.getTime() + 40 * 60 * 1000), 0);
    await runFormalCron(scoringMismatch.env, new Date(scoringMismatch.startAt.getTime() + 40 * 60 * 1000 + 1000), [], { formalPlanner: noOpFormalPlanner });
    const mismatchCanonical = await evaluateCanonicalArtifactsFromDb(scoringMismatch.env.AUTH_DB, GAME_ID);
    assert.equal(mismatchCanonical.aggregate.scoringReady, false);
    assert.notEqual(scoringMismatch.database.prepare("SELECT status FROM game_jobs_v3 WHERE id = ?").get(rankingJob.job.id).status, "completed");
  } finally {
    scoringMismatch.database.close();
  }

  const rankingMismatch = await createGoldenDb();
  try {
    await completeGoldenPathA(rankingMismatch);
    rankingMismatch.database.prepare("UPDATE ranking_reflection_revisions SET scoring_revision_id = 'wrong-scoring-revision' WHERE internal_game_id = ?").run(GAME_ID);
    rankingMismatch.database.prepare("UPDATE game_automation_v3_state SET state = 'ranked' WHERE internal_game_id = ?").run(GAME_ID);
    const publishJob = await createDueJob(rankingMismatch, "publish", new Date(rankingMismatch.startAt.getTime() + 40 * 60 * 1000), 0);
    await runFormalCron(rankingMismatch.env, new Date(rankingMismatch.startAt.getTime() + 40 * 60 * 1000 + 1000), [], { formalPlanner: noOpFormalPlanner });
    const mismatchCanonical = await evaluateCanonicalArtifactsFromDb(rankingMismatch.env.AUTH_DB, GAME_ID);
    assert.equal(mismatchCanonical.aggregate.rankingReady, false);
    assert.notEqual(rankingMismatch.database.prepare("SELECT status FROM game_jobs_v3 WHERE id = ?").get(publishJob.job.id).status, "completed");
  } finally {
    rankingMismatch.database.close();
  }

  const publicationMismatch = await createGoldenDb();
  try {
    await completeGoldenPathA(publicationMismatch);
    publicationMismatch.database.prepare("UPDATE game_lineups SET published_at = NULL WHERE internal_game_id = ?").run(GAME_ID);
    const canonical = await evaluateCanonicalArtifactsFromDb(publicationMismatch.env.AUTH_DB, GAME_ID);
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
    const canonical = await evaluateCanonicalArtifactsFromDb(fixture.env.AUTH_DB, GAME_ID);
    assert.equal(canonical.aggregate.fullyPublished, false);
    await assert.rejects(
      () => executeGameAutomationV3Job({ env: fixture.env, job: { job_type: "publish" }, internalGameId: GAME_ID, now: new Date() }),
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
