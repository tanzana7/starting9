import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  evaluateCanonicalArtifacts,
  revisionMatchesIdentity,
  revisionsMatch
} from "../backend/automation-v3/canonical-artifact-evaluator.js";
import { buildStagePlan, buildStagePlans, buildV3PlanningState } from "../backend/automation-v3/planning-engine.js";
import { planV3MainJobs } from "../backend/automation-v3/orchestrator.js";

const GAME_ID = "formal-canonical-gate-game";
const START_AT = "2026-09-08T05:00:00.000Z";
const NOW = new Date("2026-09-09T00:00:00.000Z");
const FINAL_REVISION_ID = `${GAME_ID}:2`;

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
    }
  };
}

function lineupJson() {
  return JSON.stringify(Array.from({ length: 9 }, (_, index) => ({
    battingOrder: index + 1,
    position: String(index + 1),
    playerId: `player-${index + 1}`,
    playerName: `Player ${index + 1}`
  })));
}

function canonical({
  lineupValid = true,
  scoring = false,
  ranking = false,
  publication = false,
  scoringRevisionId = "score-b",
  rankingRevisionId = scoringRevisionId
} = {}) {
  const revisionId = lineupValid ? FINAL_REVISION_ID : `${GAME_ID}:invalid`;
  const canonicalLineup = {
    internal_game_id: GAME_ID,
    final_lineup_revision_id: revisionId,
    scoring_status: scoring ? "scored" : "pending",
    scored_at: scoring ? "2026-09-08T06:00:00.000Z" : null,
    publication_status: publication ? "published" : "private",
    published_at: publication ? "2026-09-08T07:00:00.000Z" : null
  };
  return evaluateCanonicalArtifacts({
    canonicalLineup,
    lineupRevisions: [{
      internal_game_id: GAME_ID,
      revision_id: revisionId,
      version: 2,
      actual_lineup_json: lineupValid ? lineupJson() : JSON.stringify([{ battingOrder: 1, position: "1", playerId: "duplicate", playerName: "duplicate" }]),
      validation_json: JSON.stringify({ ok: lineupValid })
    }],
    activeScoringRevision: scoring ? {
      id: scoringRevisionId,
      lineup_revision_id: FINAL_REVISION_ID,
      status: "completed"
    } : null,
    rankingReflection: ranking ? {
      scoring_revision_id: rankingRevisionId,
      status: "reflected"
    } : null
  });
}

function planningState(persistedState, canonicalArtifacts, jobs = []) {
  return buildV3PlanningState({
    game: {
      internalGameId: GAME_ID,
      gameDate: "2026-09-08",
      startAt: START_AT,
      workflowState: persistedState
    },
    persistedState,
    canonicalArtifacts,
    jobs,
    now: NOW
  });
}

test("stale prediction_closed stateはcanonical lineup成立後にscoringを計画できる", () => {
  const plan = buildStagePlan(planningState("prediction_closed", canonical()), "scoring");
  assert.equal(plan.shouldCreateJob, true);
  assert.equal(plan.reasonCode, "DUE_JOB_MISSING");
  assert.equal(plan.blocked, false);
});

test("legacy candidate revisionをmanual finalizeしたcanonical pointerでもscore jobを計画する", async () => {
  const database = new DatabaseSync(":memory:");
  const internalGameId = "13710e97-2475-45c7-90eb-c08dbf961a7f";
  const legacyGameId = "h-f-25";
  const lineup = lineupJson();
  try {
    database.exec(`
      CREATE TABLE games (
        internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
        home_team TEXT, away_team TEXT, npb_game_code TEXT, npb_identity_status TEXT,
        game_status TEXT, is_active INTEGER, deleted_at TEXT
      );
      CREATE TABLE game_automation_v3_state (internal_game_id TEXT PRIMARY KEY, state TEXT);
      CREATE TABLE game_jobs_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT, job_type TEXT,
        scheduled_at TEXT, scheduled_slot_at TEXT, status TEXT, attempt_count INTEGER,
        max_attempts INTEGER, next_retry_at TEXT, claimed_at TEXT, claim_token TEXT,
        lease_expires_at TEXT, completed_at TEXT, failure_code TEXT, failure_message TEXT,
        created_at TEXT, updated_at TEXT,
        UNIQUE(internal_game_id, job_type, scheduled_slot_at)
      );
      CREATE TABLE game_lineups (
        internal_game_id TEXT PRIMARY KEY, game_id TEXT, actual_lineup_json TEXT,
        final_lineup_revision_id TEXT, scoring_status TEXT, scored_at TEXT,
        publication_status TEXT, published_at TEXT
      );
      CREATE TABLE game_lineup_revisions (
        internal_game_id TEXT, game_id TEXT, version INTEGER, revision_id TEXT,
        is_final INTEGER, actual_lineup_json TEXT, validation_json TEXT
      );
      CREATE TABLE game_scoring_revisions (
        id TEXT PRIMARY KEY, internal_game_id TEXT, lineup_revision_id TEXT,
        status TEXT, is_active INTEGER, revision_number INTEGER, completed_at TEXT
      );
      CREATE TABLE ranking_reflection_revisions (
        id INTEGER PRIMARY KEY, internal_game_id TEXT, scoring_revision_id TEXT,
        ranking_update_revision INTEGER, status TEXT, reflected_at TEXT
      );
      INSERT INTO games VALUES ('${internalGameId}', '2026-09-10', '2026-09-10T09:00:00.000Z', 'fighters', 'hawks', 'h-f-25', 'resolved', 'scheduled', 1, NULL);
      INSERT INTO game_automation_v3_state VALUES ('${internalGameId}', 'prediction_closed');
      INSERT INTO game_lineups VALUES ('${internalGameId}', '${legacyGameId}', '${lineup}', '${internalGameId}:1', 'pending', NULL, 'private', NULL);
      INSERT INTO game_lineup_revisions VALUES ('${internalGameId}', '${legacyGameId}', 1, '${legacyGameId}:1', 1, '${lineup}', '{"ok":true}');
    `);

    const result = await planV3MainJobs(d1(database), [{
      internalGameId,
      gameDate: "2026-09-10",
      startAt: "2026-09-10T09:00:00.000Z",
      homeTeam: "fighters",
      awayTeam: "hawks",
      gameStatus: "scheduled",
      isActive: 1,
      npbGameCode: "h-f-25",
      npbIdentityStatus: "resolved"
    }], new Date("2026-09-10T09:03:00.000Z"));

    const score = result.planned.find((entry) => entry.plan?.jobType === "score");
    assert.equal(score?.created, true, JSON.stringify(result.diagnostics));
  } finally {
    database.close();
  }
});

test("canonical revision aliasは同一game/versionだけを一致させる", () => {
  const revision = {
    revision_id: "game-code:2",
    game_id: "game-code",
    internal_game_id: GAME_ID,
    version: 2
  };
  assert.equal(revisionMatchesIdentity(revision, "game-code:2"), true);
  assert.equal(revisionMatchesIdentity(revision, `${GAME_ID}:2`), true);
  assert.equal(revisionMatchesIdentity({ ...revision, gameId: "game-code", internalGameId: GAME_ID }, `${GAME_ID}:2`), true);
  assert.equal(revisionMatchesIdentity({ gameCode: "game-code", version: 2 }, "game-code:2"), true);
  assert.equal(revisionMatchesIdentity(revision, "other-game:2"), false);
  assert.equal(revisionMatchesIdentity(revision, `${GAME_ID}:3`), false);
  assert.equal(revisionsMatch(revision, { revisionId: `${GAME_ID}:2`, gameId: GAME_ID, version: 2 }), true);
  assert.equal(revisionsMatch(revision, { revisionId: `${GAME_ID}:3`, gameId: GAME_ID, version: 3 }), false);
});

test("active scoring revisionはlegacy revision idでもcanonical artifactと一致する", () => {
  const artifacts = evaluateCanonicalArtifacts({
    canonicalLineup: {
      internal_game_id: GAME_ID,
      final_lineup_revision_id: `${GAME_ID}:2`,
      scoring_status: "scored",
      scored_at: "2026-09-08T06:00:00.000Z"
    },
    lineupRevisions: [{
      internal_game_id: GAME_ID,
      game_id: "game-code",
      revision_id: "game-code:2",
      version: 2,
      actual_lineup_json: lineupJson(),
      validation_json: JSON.stringify({ ok: true })
    }],
    activeScoringRevision: {
      id: "score-b",
      lineup_revision_id: "game-code:2",
      status: "completed"
    },
    rankingReflection: null
  });
  assert.equal(artifacts.lineup.lineupReady, true);
  assert.equal(artifacts.scoring.lineupRevisionMatch, true);
  assert.equal(artifacts.scoring.valid, true);
});

test("stale lineup_ready stateはcanonical score成立後にrankingを計画できる", () => {
  const plan = buildStagePlan(planningState("lineup_ready", canonical({ scoring: true })), "ranking_reflect");
  assert.equal(plan.shouldCreateJob, true);
  assert.equal(plan.reasonCode, "DUE_JOB_MISSING");
});

test("stale scoring stateはcanonical reflection成立後にpublishを計画できる", () => {
  const plan = buildStagePlan(planningState("scored", canonical({ scoring: true, ranking: true })), "publish");
  assert.equal(plan.shouldCreateJob, true);
  assert.equal(plan.reasonCode, "DUE_JOB_MISSING");
});

test("stateがrankedでもcanonical ranking reflection欠落時はpublishを禁止する", () => {
  const plan = buildStagePlan(planningState("ranked", canonical({ scoring: true })), "publish");
  assert.equal(plan.shouldCreateJob, false);
  assert.equal(plan.blockedReason, "PUBLISH_CANONICAL_RANKING_INVALID");
});

test("stateがpublishedでもpublication不整合は自動修復せずneeds attentionにする", () => {
  const artifacts = canonical({ scoring: true, ranking: false, publication: true });
  assert.equal(artifacts.aggregate.fullyPublished, false);
  assert.equal(artifacts.aggregate.needsAttention, true);
  const plans = buildStagePlans(planningState("published", artifacts));
  assert.equal(plans.some((plan) => plan.shouldCreateJob), false);
  assert.equal(plans.every((plan) => plan.reasonCode === "PUBLISHED_CANONICAL_ARTIFACT_MISMATCH_NEEDS_ATTENTION"), true);
});

test("stateがlineup_readyでもcanonical lineup invalidならscoringを禁止する", () => {
  const plan = buildStagePlan(planningState("lineup_ready", canonical({ lineupValid: false })), "scoring");
  assert.equal(plan.shouldCreateJob, false);
  assert.equal(plan.blockedReason, "SCORING_CANONICAL_LINEUP_INVALID");
});

test("correctionはscore B→rank B→publish Bを通し、完了後は新規jobを作らない", () => {
  const scoreB = canonical({ scoring: true, scoringRevisionId: "score-b" });
  const rankAOnly = canonical({ scoring: true, ranking: true, scoringRevisionId: "score-b", rankingRevisionId: "score-a" });
  const rankB = canonical({ scoring: true, ranking: true, scoringRevisionId: "score-b", rankingRevisionId: "score-b" });
  const publishedB = canonical({ scoring: true, ranking: true, publication: true, scoringRevisionId: "score-b", rankingRevisionId: "score-b" });

  assert.equal(buildStagePlan(planningState("lineup_ready", scoreB), "ranking_reflect").shouldCreateJob, true);
  assert.equal(buildStagePlan(planningState("ranked", rankAOnly), "ranking_reflect").shouldCreateJob, true);
  assert.equal(buildStagePlan(planningState("ranked", rankB), "publish").shouldCreateJob, true);
  assert.equal(buildStagePlans(planningState("published", publishedB)).some((plan) => plan.shouldCreateJob), false);
});

test("correctionのranking jobはopen jobがあれば二重作成しない", () => {
  const plan = buildStagePlan(planningState("ranked", canonical({ scoring: true }), [{
    internalGameId: GAME_ID,
    job_type: "ranking_rebuild",
    status: "pending",
    scheduled_slot_at: "2026-09-08T07:00:00.000Z"
  }]), "ranking_reflect");
  assert.equal(plan.shouldCreateJob, false);
  assert.equal(plan.reasonCode, "OPEN_JOB_EXISTS");
});

test("canonical artifactを渡さない通常formal pipelineのgateは従来どおり", () => {
  const state = planningState("prediction_closed", null);
  const score = buildStagePlan(state, "scoring");
  assert.equal(score.shouldCreateJob, false);
  assert.equal(score.blockedReason, "SCORING_STATE_GATE");
});
