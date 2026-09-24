import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker, { executeGameAutomationV3Job, getManualLineupPlayerCatalog } from "../auth-worker.js";
import { claimV3Job, createV3Job } from "../backend/automation-v3/repository.js";
import { executeClaimedJobs } from "../backend/automation-v3/executor.js";
import { applyEligibilityChange } from "../backend/automation-v3/eligibility-service.js";
import { applyScheduleChange, deriveScheduleArtifacts } from "../backend/automation-v3/schedule-service.js";
import { evaluateCanonicalArtifactsFromDb } from "../backend/automation-v3/canonical-artifact-evaluator.js";
import { transitionV3State } from "../game-automation-v3.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GAME_ID = "9f7e2f4c-9b16-4c70-9cb8-9d7d2a2a0041";
const GAME_CODE = "f-h-1";
const SESSION_TOKEN = "phase1-4-cross-session";
const POSITIONS = ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"];

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      const bind = (...params) => ({
        all: async () => ({ results: statement.all(...params) }),
        first: async () => statement.get(...params),
        run: async () => ({ meta: { changes: Number(statement.run(...params).changes || 0) } })
      });
      return {
        all: async () => ({ results: statement.all() }),
        first: async () => statement.get(),
        run: async () => ({ meta: { changes: Number(statement.run().changes || 0) } }),
        bind
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

function jstDate(now) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(now);
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

function officialLineupPayload() {
  return lineup().map((player, index) => ({
    playerName: player.playerName,
    uniformNumber: player.uniformNumber,
    position: player.position,
    order: index + 1
  }));
}

function adminHeaders() {
  return {
    Cookie: `s9_session=${encodeURIComponent(SESSION_TOKEN)}`,
    Origin: "https://starting9.test",
    "Content-Type": "application/json"
  };
}

async function adminRequest(env, pathname, body) {
  return worker.fetch(new Request(`https://starting9.test${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: adminHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body)
  }), env, {});
}

function fakeNpbWorker() {
  return {
    async fetch() {
      return new Response(JSON.stringify({
        ok: true,
        lineup: officialLineupPayload(),
        fetchedAt: "2026-09-24T05:00:00.000Z",
        sourceUrl: "https://npb.jp/fake/cross-integration"
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  };
}

async function createFixture() {
  const database = new DatabaseSync(":memory:");
  const migrationNames = fs.readdirSync(path.join(ROOT, "migrations")).filter((name) => name.endsWith(".sql")).sort();
  for (const name of migrationNames) database.exec(fs.readFileSync(path.join(ROOT, "migrations", name), "utf8"));

  const now = new Date();
  const timestamp = now.toISOString();
  const gameDate = jstDate(now);
  const startAt = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const tokenHash = await sha256Base64Url(SESSION_TOKEN);
  const predictedLineup = JSON.stringify({ schemaVersion: 1, lineup: lineup() });
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
      'resolved', ?, 'test-fixture', 'https://npb.jp/fake/cross', ?, ?)
  `).run(GAME_ID, gameDate, startAt.toISOString(), GAME_CODE, timestamp, timestamp, timestamp);
  database.prepare(`
    INSERT INTO game_automation_v3_state (internal_game_id, state, version, created_at, updated_at)
    VALUES (?, 'scheduled', 0, ?, ?)
  `).run(GAME_ID, timestamp, timestamp);
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
  `).run("prediction-1", "operator-1", GAME_ID, GAME_ID, predictedLineup, gameDate, timestamp, timestamp);

  return {
    database,
    env: {
      AUTH_DB: d1(database),
      AUTH_ALLOWED_ORIGINS: "https://starting9.test",
      ENABLE_GAME_AUTOMATION_V3: "true",
      ENABLE_SEMI_AUTO_LINEUP: "true",
      ENABLE_AUTO_PROBABLE_STARTER: "false",
      NPB_FETCH_WORKER: fakeNpbWorker()
    },
    gameDate,
    startAt,
    at: new Date(now.getTime() + 1_000)
  };
}

async function runJob(fixture, jobType, source = "cron", now = fixture.at) {
  const created = await createV3Job(fixture.env.AUTH_DB, {
    internalGameId: GAME_ID,
    jobType,
    scheduledAt: new Date(now.getTime() - 1_000),
    scheduledSlotAt: new Date(now.getTime() - 1_000),
    source
  });
  const claimed = await claimV3Job(fixture.env.AUTH_DB, { jobId: created.job.id, now });
  assert.equal(claimed.status, "claimed");
  const execution = await executeClaimedJobs(
    fixture.env,
    [{ job: claimed, claimed, entry: null, claimResult: { claimed: true, source } }],
    [],
    now,
    { executeJob: (context) => executeGameAutomationV3Job({ ...context, v4SemiAuto: false }) }
  );
  assert.equal(execution.processed, 1);
  if (execution.failed) {
    const failedJob = fixture.database.prepare(
      "SELECT job_type, status, failure_code, failure_message FROM game_jobs_v3 WHERE id = ?"
    ).get(created.job.id);
    assert.fail(JSON.stringify({ execution, failedJob }));
  }
  return { created: created.job, execution };
}

async function setPredictionClosed(fixture) {
  await transitionV3State(fixture.env.AUTH_DB, {
    internalGameId: GAME_ID,
    from: "scheduled",
    to: "prediction_closed",
    now: fixture.at
  });
}

async function finalizeAdminLineup(fixture) {
  const save = await adminRequest(fixture.env, `/api/admin/v3/games/${GAME_ID}/lineup-revisions`, {
    lineup: lineup(), reason: "cross integration admin lineup", confirmed: true
  });
  const saveBody = await save.json();
  assert.equal(save.status, 201, JSON.stringify(saveBody));
  const finalize = await adminRequest(fixture.env, `/api/admin/v3/games/${GAME_ID}/lineup-finalize`, {
    lineupRevisionId: saveBody.revision.revisionId, confirmed: true
  });
  const finalizeBody = await finalize.json();
  assert.equal(finalize.status, 200, JSON.stringify(finalizeBody));
  return finalizeBody;
}

async function runAdminJob(fixture, jobType, path = `/api/admin/v3/games/${GAME_ID}/jobs`) {
  const response = await adminRequest(fixture.env, path, {
    jobType, reason: `cross integration admin ${jobType}`, confirmed: true
  });
  const body = await response.json();
  assert.ok([200, 202].includes(response.status), JSON.stringify(body));
  assert.equal(body.ok, true, JSON.stringify(body));
  return body;
}

async function publicGames(fixture) {
  const response = await worker.fetch(new Request("https://starting9.test/api/public/games", {
    method: "GET", headers: { Origin: "https://starting9.test" }
  }), fixture.env, {});
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.games.find((game) => game.internalGameId === GAME_ID) || null;
}

async function semanticSnapshot(fixture) {
  const canonical = await evaluateCanonicalArtifactsFromDb(fixture.env.AUTH_DB, GAME_ID);
  const revision = fixture.database.prepare(
    "SELECT lineup_fingerprint, is_current, is_final FROM game_lineup_revisions WHERE internal_game_id = ? ORDER BY version DESC LIMIT 1"
  ).get(GAME_ID);
  const scoring = fixture.database.prepare(
    "SELECT lineup_revision_id, status, is_active FROM game_scoring_revisions WHERE internal_game_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(GAME_ID);
  const reflection = fixture.database.prepare(
    "SELECT scoring_revision_id, status FROM ranking_reflection_revisions WHERE internal_game_id = ? ORDER BY ranking_update_revision DESC LIMIT 1"
  ).get(GAME_ID);
  const ranking = fixture.database.prepare(
    "SELECT publication_status, published_at, ranking_eligibility_status FROM ranking_games WHERE internal_game_id = ?"
  ).get(GAME_ID);
  const lineupRow = fixture.database.prepare(
    "SELECT scoring_status, publication_status, published_at, final_lineup_revision_id FROM game_lineups WHERE internal_game_id = ?"
  ).get(GAME_ID);
  const score = fixture.database.prepare("SELECT score, scoring_status FROM predictions WHERE id = 'prediction-1'").get();
  const jobs = fixture.database.prepare(
    "SELECT job_type, status FROM game_jobs_v3 WHERE internal_game_id = ? ORDER BY id"
  ).all(GAME_ID).map(({ job_type, status }) => ({ jobType: job_type, status }));
  return {
    state: fixture.database.prepare("SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?").get(GAME_ID).state,
    finalLineupFingerprint: revision?.lineup_fingerprint || null,
    revisionCurrentAndFinal: [Number(revision?.is_current || 0), Number(revision?.is_final || 0)],
    score: { value: score?.score ?? null, status: score?.scoring_status || null },
    scoreRevisionMatchesLineup: Boolean(scoring?.lineup_revision_id && canonical.scoring.lineupRevisionMatch),
    scoreRevisionActive: Number(scoring?.is_active || 0),
    reflectionMatchesScore: Boolean(reflection && canonical.ranking.scoringRevisionMatch),
    reflectionStatus: reflection?.status || null,
    ranking: { status: ranking?.publication_status || null, eligibility: ranking?.ranking_eligibility_status || null },
    publication: { lineup: lineupRow?.publication_status || null, ranking: ranking?.publication_status || null, published: Boolean(lineupRow?.published_at) },
    canonical: {
      lineupReady: canonical.aggregate.lineupReady,
      scoringReady: canonical.aggregate.scoringReady,
      rankingReady: canonical.aggregate.rankingReady,
      publicationReady: canonical.aggregate.publicationReady,
      fullyPublished: canonical.aggregate.fullyPublished,
      mismatch: canonical.aggregate.artifactMismatch
    },
    jobs
  };
}

async function runAutomaticGoldenPath(fixture) {
  await applyScheduleChange(fixture.env.AUTH_DB, {
    internalGameId: GAME_ID,
    proposedSchedule: {
      gameDate: fixture.gameDate, startAt: fixture.startAt.toISOString(), homeTeam: "fighters", awayTeam: "hawks", status: "scheduled", npbGameCode: GAME_CODE
    },
    derivedSchedule: deriveScheduleArtifacts(fixture.startAt.toISOString()),
    source: "cron", actor: "cross-cron", reason: "official sync", now: fixture.at
  });
  await applyEligibilityChange({
    db: fixture.env.AUTH_DB, gameId: GAME_ID, internalGameId: GAME_ID,
    status: "eligible", source: "cron", actor: "cross-cron", persist: async () => ({ rankingEligibilityStatus: "eligible" }), now: fixture.at
  });
  await runJob(fixture, "prediction_close");
  await runJob(fixture, "lineup_finalize");
  await runJob(fixture, "score");
  await runJob(fixture, "ranking_rebuild");
  const beforePublish = await publicGames(fixture);
  await runJob(fixture, "publish");
  return { snapshot: await semanticSnapshot(fixture), beforePublish };
}

async function runAdminRecoveryPath(fixture) {
  await applyScheduleChange(fixture.env.AUTH_DB, {
    internalGameId: GAME_ID,
    proposedSchedule: {
      gameDate: fixture.gameDate, startAt: fixture.startAt.toISOString(), homeTeam: "fighters", awayTeam: "hawks", status: "scheduled", npbGameCode: GAME_CODE
    },
    derivedSchedule: deriveScheduleArtifacts(fixture.startAt.toISOString()),
    source: "admin", actor: "operator-1", reason: "admin schedule confirmation", now: fixture.at
  });
  await applyEligibilityChange({
    db: fixture.env.AUTH_DB, gameId: GAME_ID, internalGameId: GAME_ID,
    status: "eligible", source: "admin", actor: "operator-1", persist: async () => ({ rankingEligibilityStatus: "eligible" }), now: fixture.at
  });
  await finalizeAdminLineup(fixture);
  // Prediction close is a precondition owned by the deadline boundary. This
  // creates and executes the same formal job while the test keeps Cron off.
  await runJob(fixture, "prediction_close", "admin");
  await transitionV3State(fixture.env.AUTH_DB, {
    internalGameId: GAME_ID,
    from: "prediction_closed",
    to: "lineup_ready",
    now: fixture.at
  });
  await runAdminJob(fixture, "score");
  await runAdminJob(fixture, "ranking_rebuild");
  const beforePublish = await publicGames(fixture);
  await runAdminJob(fixture, "publish");
  return { snapshot: await semanticSnapshot(fixture), beforePublish };
}

test("Phase 1〜4: 自動Golden PathとCron停止時の管理者復旧は同じcanonical成果物へ到達する", async () => {
  const automatic = await createFixture();
  const manual = await createFixture();
  try {
    const autoSnapshot = await runAutomaticGoldenPath(automatic);
    const adminSnapshot = await runAdminRecoveryPath(manual);
    for (const [result, isAutomatic] of [[autoSnapshot, true], [adminSnapshot, false]]) {
      const snapshot = result.snapshot;
      assert.equal(snapshot.state, "published");
      assert.equal(snapshot.finalLineupFingerprint, autoSnapshot.snapshot.finalLineupFingerprint);
      assert.deepEqual(snapshot.revisionCurrentAndFinal, [1, 1]);
      assert.equal(snapshot.score.status, "scored");
      assert.equal(snapshot.scoreRevisionMatchesLineup, true);
      assert.equal(snapshot.scoreRevisionActive, 1);
      assert.equal(snapshot.reflectionMatchesScore, true);
      assert.equal(snapshot.reflectionStatus, "reflected");
      assert.deepEqual(snapshot.ranking, { status: "published", eligibility: "eligible" });
      assert.deepEqual(snapshot.publication, { lineup: "published", ranking: "published", published: true });
      assert.deepEqual(snapshot.canonical, { lineupReady: true, scoringReady: true, rankingReady: true, publicationReady: true, fullyPublished: true, mismatch: false });
      const expectedJobs = isAutomatic
        ? ["prediction_close", "lineup_finalize", "score", "ranking_rebuild", "publish"]
        : ["prediction_close", "score", "ranking_rebuild", "publish"];
      assert.deepEqual(snapshot.jobs.map((job) => job.jobType), expectedJobs);
      assert.ok(snapshot.jobs.every((job) => job.status === "completed"));
      assert.equal(result.beforePublish?.isPublished, false);
    }
    assert.equal(adminSnapshot.snapshot.score.value, autoSnapshot.snapshot.score.value);
    assert.equal((await publicGames(automatic)).isPublished, true);
    assert.equal((await publicGames(manual)).isPublished, true);
  } finally {
    automatic.database.close();
    manual.database.close();
  }
});

test("Phase 1〜4: auto→admin と admin→auto のhandoffは完了jobを二重実行しない", async () => {
  const autoToAdmin = await createFixture();
  const adminToAuto = await createFixture();
  try {
    await runJob(autoToAdmin, "prediction_close");
    await runJob(autoToAdmin, "lineup_finalize");
    await runAdminJob(autoToAdmin, "score");
    await runAdminJob(autoToAdmin, "ranking_rebuild");
    await runAdminJob(autoToAdmin, "publish");
    const first = await semanticSnapshot(autoToAdmin);
    assert.equal(first.canonical.fullyPublished, true);
    assert.deepEqual(first.jobs.map((job) => job.jobType), ["prediction_close", "lineup_finalize", "score", "ranking_rebuild", "publish"]);

    await finalizeAdminLineup(adminToAuto);
    await runJob(adminToAuto, "prediction_close", "admin");
    await transitionV3State(adminToAuto.env.AUTH_DB, {
      internalGameId: GAME_ID, from: "prediction_closed", to: "lineup_ready", now: adminToAuto.at
    });
    await runAdminJob(adminToAuto, "score");
    await runJob(adminToAuto, "ranking_rebuild");
    await runJob(adminToAuto, "publish");
    const second = await semanticSnapshot(adminToAuto);
    assert.equal(second.canonical.fullyPublished, true);
    assert.deepEqual(second.jobs.map((job) => job.jobType), ["prediction_close", "score", "ranking_rebuild", "publish"]);
    for (const fixture of [autoToAdmin, adminToAuto]) {
      for (const type of ["score", "ranking_rebuild", "publish"]) {
        assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE internal_game_id = ? AND job_type = ?").get(GAME_ID, type).count, 1);
      }
    }
  } finally {
    autoToAdmin.database.close();
    adminToAuto.database.close();
  }
});

test("Phase 3/4: stale Cronの日程・スタメンは管理者確定を巻き戻さず、同一内容の再実行はno-opになる", async () => {
  const fixture = await createFixture();
  try {
    const adminSchedule = await applyScheduleChange(fixture.env.AUTH_DB, {
      internalGameId: GAME_ID,
      proposedSchedule: { gameDate: fixture.gameDate, startAt: new Date(fixture.startAt.getTime() + 60 * 60 * 1000).toISOString(), homeTeam: "fighters", awayTeam: "hawks", status: "scheduled", npbGameCode: GAME_CODE },
      derivedSchedule: deriveScheduleArtifacts(new Date(fixture.startAt.getTime() + 60 * 60 * 1000).toISOString()),
      source: "admin", actor: "operator-1", reason: "admin correction", now: fixture.at
    });
    assert.equal(adminSchedule.status, "updated");
    const staleCron = await applyScheduleChange(fixture.env.AUTH_DB, {
      internalGameId: GAME_ID,
      proposedSchedule: { gameDate: fixture.gameDate, startAt: fixture.startAt.toISOString(), homeTeam: "fighters", awayTeam: "hawks", status: "scheduled", npbGameCode: GAME_CODE },
      derivedSchedule: deriveScheduleArtifacts(fixture.startAt.toISOString()),
      source: "cron", actor: "old-sync", reason: "stale official payload", now: new Date(fixture.at.getTime() + 1_000)
    });
    assert.equal(staleCron.reason, "MANUAL_OVERRIDE_ACTIVE");
    assert.equal(fixture.database.prepare("SELECT start_time FROM games WHERE internal_game_id = ?").get(GAME_ID).start_time, new Date(fixture.startAt.getTime() + 60 * 60 * 1000).toISOString());

    const save = await adminRequest(fixture.env, `/api/admin/v3/games/${GAME_ID}/lineup-revisions`, {
      lineup: lineup(), reason: "cross integration duplicate candidate", confirmed: true
    });
    const saveBody = await save.json();
    assert.equal(save.status, 201, JSON.stringify(saveBody));
    const before = fixture.database.prepare("SELECT COUNT(*) AS count FROM game_lineup_revisions WHERE internal_game_id = ?").get(GAME_ID).count;
    const duplicate = await adminRequest(fixture.env, `/api/admin/v3/games/${GAME_ID}/lineup-revisions`, { lineup: lineup(), reason: "duplicate admin save", confirmed: true });
    const duplicateBody = await duplicate.json();
    assert.equal(duplicate.status, 200, JSON.stringify(duplicateBody));
    assert.equal(duplicateBody.noOp, true);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM game_lineup_revisions WHERE internal_game_id = ?").get(GAME_ID).count, before);
    const finalize = await adminRequest(fixture.env, `/api/admin/v3/games/${GAME_ID}/lineup-finalize`, { lineupRevisionId: saveBody.revision.revisionId, confirmed: true });
    const finalBody = await finalize.json();
    assert.equal(finalize.status, 200, JSON.stringify(finalBody));
    assert.equal(finalBody.finalizedRevision.isFinal, true);
    await setPredictionClosed(fixture);
    await runJob(fixture, "lineup_finalize");
    const afterAuto = fixture.database.prepare("SELECT final_lineup_revision_id FROM game_lineups WHERE internal_game_id = ?").get(GAME_ID);
    assert.equal(afterAuto.final_lineup_revision_id, finalBody.finalizedRevision.revisionId);
  } finally {
    fixture.database.close();
  }
});

test("Phase 2/4: 公開済みcorrectionは新lineageで再採点・再反映し、旧成果物をcurrentへ戻さない", async () => {
  const fixture = await createFixture();
  try {
    await runAdminRecoveryPath(fixture);
    const before = await semanticSnapshot(fixture);
    const changed = lineup().map((row, index) => index === 0 ? { ...row, playerName: getManualLineupPlayerCatalog()[9].playerName, playerId: getManualLineupPlayerCatalog()[9].playerId, uniformNumber: String(getManualLineupPlayerCatalog()[9].uniformNumber) } : row);
    const correction = await adminRequest(fixture.env, `/api/admin/v3/games/${GAME_ID}/lineup-correction`, { lineup: changed, reason: "cross integration correction", confirmed: true });
    const correctionBody = await correction.json();
    assert.equal(correction.status, 202, JSON.stringify(correctionBody));
    assert.notEqual(correctionBody.correctionRevision.revisionId, before.finalLineupFingerprint);
    const afterCorrection = await semanticSnapshot(fixture);
    assert.equal(afterCorrection.state, "manual_action_required");
    assert.equal(afterCorrection.canonical.fullyPublished, false);
    assert.equal(afterCorrection.publication.lineup, "pending");
    assert.notEqual(afterCorrection.finalLineupFingerprint, before.finalLineupFingerprint);
    assert.equal(afterCorrection.score.value, before.score.value);
    await runJob(fixture, "score");
    await runJob(fixture, "ranking_rebuild");
    await runJob(fixture, "publish");
    const republished = await semanticSnapshot(fixture);
    assert.equal(republished.state, "published");
    assert.equal(republished.canonical.fullyPublished, true);
    assert.equal(republished.canonical.mismatch, false);
    assert.notEqual(republished.finalLineupFingerprint, before.finalLineupFingerprint);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM game_lineup_revisions WHERE internal_game_id = ?").get(GAME_ID).count, 2);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM game_scoring_revisions WHERE internal_game_id = ?").get(GAME_ID).count, 2);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM ranking_reflection_revisions WHERE internal_game_id = ?").get(GAME_ID).count, 2);
  } finally {
    fixture.database.close();
  }
});

test("横断テストはrevision guard・公開境界・CPU hot pathの回帰を検出できる", async () => {
  const source = fs.readFileSync(path.join(ROOT, "auth-worker.js"), "utf8");
  const executor = fs.readFileSync(path.join(ROOT, "backend/automation-v3/executor.js"), "utf8");
  const orchestrator = fs.readFileSync(path.join(ROOT, "backend/automation-v3/orchestrator.js"), "utf8");
  const fixture = await createFixture();
  try {
    assert.match(source, /async function applyLineupRevisionService/);
    assert.match(source, /source: "cron"[\s\S]*?applyLineupRevisionService\(\{/);
    assert.match(source, /source: "admin"[\s\S]*?applyLineupRevisionService\(\{/);
    assert.match(source, /V3_LINEUP_REVISION_CONFLICT/);
    assert.match(source, /PUBLISH_COMPLETED_WITHOUT_PUBLICATION/);
    assert.match(executor, /claimDueJobs/);
    assert.match(executor, /retryV3Job/);
    assert.match(orchestrator, /hasMoreDue/);
    assert.match(executor, /reconcileCompletedV3StateTransitions/);

    await runAdminRecoveryPath(fixture);
    const published = await publicGames(fixture);
    assert.equal(published.isPublished, true);
    assert.equal(published.workflowState, "published");

    // Deliberately poison the canonical pointer. The evaluator must fail the
    // fixture instead of silently treating the old publication as current.
    fixture.database.prepare("UPDATE game_lineups SET final_lineup_revision_id = 'poisoned-revision' WHERE internal_game_id = ?").run(GAME_ID);
    const poisoned = await evaluateCanonicalArtifactsFromDb(fixture.env.AUTH_DB, GAME_ID);
    assert.equal(poisoned.aggregate.artifactMismatch, true);
    assert.equal(poisoned.aggregate.fullyPublished, false);
  } finally {
    fixture.database.close();
  }
});
