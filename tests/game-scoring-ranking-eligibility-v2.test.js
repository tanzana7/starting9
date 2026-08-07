const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");

const root = path.resolve(__dirname, "..");
const internalGameId = "11111111-1111-4111-8111-111111111111";

test("ranking eligibility rules distinguish excluded, pending, and eligible games", async () => {
  const rules = await import(pathToFileURL(path.join(root, "game-scoring-ranking-v2.js")).href);
  assert.deepEqual(rules.deriveInitialRankingEligibility({ gameStatus: "cancelled", startAt: "2026-08-04T09:00:00Z", now: "2026-08-04T08:00:00Z" }), {
    status: "excluded", eligible: false, reason: "cancelled_before_start"
  });
  assert.equal(rules.deriveInitialRankingEligibility({ gameStatus: "scheduled" }).status, "eligible");
  assert.equal(rules.isRankingAggregationEligible({ rankingEligible: true, eligibilityStatus: "eligible", gameStatus: "scored", scoringStatus: "completed" }), true);
  assert.equal(rules.isRankingAggregationEligible({ rankingEligible: false, eligibilityStatus: "excluded", gameStatus: "scored", scoringStatus: "completed" }), false);
  assert.equal(rules.isScoringComplete({ eligiblePredictionCount: 3, scoredPredictionCount: 2, excludedPredictionCount: 1, failedPredictionCount: 0 }), true);
  assert.equal(rules.isScoringComplete({ eligiblePredictionCount: 3, scoredPredictionCount: 2, excludedPredictionCount: 0, failedPredictionCount: 1 }), false);
});

test("0028 backfills eligibility and scoring revision history without deleting legacy results", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const migrationDir = path.join(root, "migrations");
    for (const file of fs.readdirSync(migrationDir).filter((name) => /^00(?:0[1-9]|1[0-9]|2[0-7])_.*\.sql$/.test(name)).sort()) {
      db.exec(fs.readFileSync(path.join(migrationDir, file), "utf8"));
    }
    db.exec(`
      INSERT INTO users (id, username, username_normalized, password_hash, password_salt, password_iterations, created_at, updated_at)
      VALUES ('fixture-user', 'fixture', 'fixture', 'hash', 'salt', 1, '2026-08-01', '2026-08-01');
      INSERT INTO games (internal_game_id, game_date, start_time, home_team, away_team, game_status, created_at, updated_at)
      VALUES ('${internalGameId}', '2026-08-04', '2026-08-04T09:00:00Z', 'hawks', 'fighters', 'completed', '2026-08-01', '2026-08-04');
      INSERT INTO predictions (id, user_id, game_id, internal_game_id, prediction_json, game_date, home_team, away_team, opponent_code, is_home, submitted_at, updated_at, status, score, max_score, scored_at, actual_lineup_json, is_test_prediction)
      VALUES ('prediction-1', 'fixture-user', '2026-08-04-h-f-15', '${internalGameId}', '[]', '2026-08-04', 'hawks', 'fighters', 'f', 1, '2026-08-04T08:00:00Z', '2026-08-04T12:00:00Z', 'scored', 100, 100, '2026-08-04T12:00:00Z', '[]', 0);
      INSERT INTO ranking_games (game_id, internal_game_id, game_date, is_ranking_eligible, game_status, is_test_game, created_at, updated_at, publication_status)
      VALUES ('2026-08-04-h-f-15', '${internalGameId}', '2026-08-04', 1, 'scored', 0, '2026-08-04', '2026-08-04', 'published');
    `);
    db.exec(fs.readFileSync(path.join(migrationDir, "0028_game_scoring_ranking_eligibility.sql"), "utf8"));
    const eligibility = db.prepare("SELECT ranking_eligibility_status, ranking_eligibility_reason, is_ranking_eligible FROM ranking_games WHERE game_id = ?").get("2026-08-04-h-f-15");
    assert.deepEqual({ status: eligibility.ranking_eligibility_status, reason: eligibility.ranking_eligibility_reason, eligible: eligibility.is_ranking_eligible }, { status: "eligible", reason: null, eligible: 1 });
    const prediction = db.prepare("SELECT scoring_status, scoring_exclusion_reason FROM predictions WHERE id = 'prediction-1'").get();
    assert.deepEqual({ status: prediction.scoring_status, reason: prediction.scoring_exclusion_reason }, { status: "scored", reason: null });
    const revision = db.prepare("SELECT revision_number, status, reason, is_active FROM game_scoring_revisions WHERE internal_game_id = ?").get(internalGameId);
    assert.deepEqual({ revision: revision.revision_number, status: revision.status, reason: revision.reason, active: revision.is_active }, { revision: 1, status: "completed", reason: "initial_scoring", active: 1 });
    assert.equal(db.prepare("SELECT score FROM predictions WHERE id = 'prediction-1'").get().score, 100);
  } finally {
    db.close();
  }
});

test("admin eligibility API and user result expose the explicit exclusion state", () => {
  const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
  assert.match(worker, /ranking-eligibility/);
  assert.match(worker, /RANKING_ELIGIBILITY_REASON_REQUIRED/);
  assert.match(worker, /ranking_eligibility_history/);
  assert.match(worker, /RANKING_GAME_EXCLUDED/);
  assert.match(worker, /rankingExcludedMessage/);
  assert.match(html, /adminGameProgressBoard/);
  assert.match(script, /data-ranking-eligibility-action/);
});

test("V3 state rules remain the only workflow transition contract", async () => {
  const automation = await import(pathToFileURL(path.join(root, "game-automation-v3.js")).href);
  assert.equal(automation.getV3TransitionDefinition("published", "scored"), null);
  assert.equal(automation.getV3TransitionDefinition("scored", "ranked").triggeringJob, "ranking_rebuild");
  assert.equal(automation.getV3TransitionDefinition("ranked", "published").triggeringJob, "publish");
});
