import { SCORING_MAX_SCORE, SCORING_RULES } from "../domain/scoring.js";

// A score attempt is deliberately independent from the current read model.
// Workers may die after any staging write; only commitScoreAttempt can make
// the staged lineage visible to ranking, publication, or personal results.

export async function createScoreAttempt(db, input) {
  const result = await db.prepare(`
    INSERT OR IGNORE INTO score_attempts (
      attempt_id, internal_game_id, game_id, canonical_lineup_revision_id,
      scoring_lineup_revision_id, canonical_lineup_fingerprint, job_id,
      claim_token, status, expected_prediction_count, expected_test_count,
      scoring_revision_id, scoring_revision_number, actual_lineup_json,
      created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'staging', ?9, ?10, ?11, ?12, ?13, ?14)`)
    .bind(
      input.attemptId,
      input.internalGameId,
      input.gameId,
      input.canonicalLineupRevisionId,
      input.scoringLineupRevisionId,
      input.lineupFingerprint,
      input.jobId,
      input.claimToken,
      input.expectedPredictionCount,
      input.expectedTestCount || 0,
      input.scoringRevisionId,
      input.scoringRevisionNumber,
      input.actualLineupJson,
      input.createdAt
    ).run();
  if (Number(result?.meta?.changes || 0) === 1) return input.attemptId;
  const existing = await db.prepare(
    "SELECT attempt_id FROM score_attempts WHERE job_id = ?1 AND claim_token = ?2 LIMIT 1"
  ).bind(input.jobId, input.claimToken).first();
  if (!existing?.attempt_id) throw new Error("score attempt claim generation already exists");
  return String(existing.attempt_id);
}

export async function stageScorePrediction(db, attemptId, row) {
  const counts = row.counts || {};
  const scored = row.outcome === "scored";
  const playerScore = Number(counts.player || 0) * SCORING_RULES.player.perHit;
  const orderScore = Number(counts.order || 0) * SCORING_RULES.order.perHit;
  const defenseScore = Number(counts.position || 0) * SCORING_RULES.position.perHit;
  const perfectBonus = Number(counts.perfect || 0) * SCORING_RULES.perfect.perHit;
  await db.prepare(`
    INSERT INTO score_attempt_prediction_rows (
      attempt_id, prediction_id, outcome, validity_status, total_score,
      max_score, participation_score, batting_order_score, defense_score,
      perfect_bonus, player_hits, order_hits, position_hits, perfect_hits,
      exclusion_reason, lineage_json
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
    ON CONFLICT(attempt_id, prediction_id) DO UPDATE SET
      outcome = excluded.outcome,
      validity_status = excluded.validity_status,
      total_score = excluded.total_score,
      max_score = excluded.max_score,
      participation_score = excluded.participation_score,
      batting_order_score = excluded.batting_order_score,
      defense_score = excluded.defense_score,
      perfect_bonus = excluded.perfect_bonus,
      player_hits = excluded.player_hits,
      order_hits = excluded.order_hits,
      position_hits = excluded.position_hits,
      perfect_hits = excluded.perfect_hits,
      exclusion_reason = excluded.exclusion_reason,
      lineage_json = excluded.lineage_json`)
    .bind(
      attemptId,
      row.id,
      scored ? "scored" : "excluded",
      scored ? "valid" : "excluded",
      scored ? Number(row.score) : null,
      scored ? SCORING_MAX_SCORE : null,
      scored ? playerScore : null,
      scored ? orderScore : null,
      scored ? defenseScore : null,
      scored ? perfectBonus : null,
      scored ? Number(counts.player || 0) : null,
      scored ? Number(counts.order || 0) : null,
      scored ? Number(counts.position || 0) : null,
      scored ? Number(counts.perfect || 0) : null,
      scored ? null : String(row.exclusionReason || "INVALID_PREDICTION"),
      JSON.stringify({ scoring: "starting9-v1", attemptId })
    ).run();
}

export async function stageScoreTest(db, attemptId, row) {
  await db.prepare(`
    INSERT INTO score_attempt_test_rows (
      attempt_id, slot, prediction_json, status, score, max_score,
      warning_code, lineage_json
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    ON CONFLICT(attempt_id, slot) DO UPDATE SET
      prediction_json = excluded.prediction_json,
      status = excluded.status,
      score = excluded.score,
      max_score = excluded.max_score,
      warning_code = excluded.warning_code,
      lineage_json = excluded.lineage_json`)
    .bind(
      attemptId,
      Number(row.slot),
      row.predictionJson || JSON.stringify({ source: "fixed_preset", slot: row.slot }),
      row.status,
      row.status === "scored" ? Number(row.score) : null,
      row.status === "scored" ? SCORING_MAX_SCORE : null,
      row.warningCode || null,
      JSON.stringify({ scoring: "starting9-v1", attemptId, slot: Number(row.slot) })
    ).run();
}

export async function markScoreAttemptReady(db, attemptId, now = new Date()) {
  const result = await db.prepare(`
    UPDATE score_attempts
       SET status = 'ready', ready_at = ?1
     WHERE attempt_id = ?2
       AND status = 'staging'
       AND expected_prediction_count = (
         SELECT COUNT(*) FROM score_attempt_prediction_rows WHERE attempt_id = ?2)
       AND expected_test_count = (
         SELECT COUNT(*) FROM score_attempt_test_rows WHERE attempt_id = ?2)`)
    .bind(now.toISOString(), attemptId).run();
  return Number(result?.meta?.changes || 0) === 1;
}

function ownedAttempt(attemptPlaceholder = "?1", noncePlaceholder = "?2") {
  return `EXISTS (
    SELECT 1 FROM score_attempts AS owned_attempt
     WHERE owned_attempt.attempt_id = ${attemptPlaceholder}
       AND owned_attempt.status = 'committing'
       AND owned_attempt.commit_nonce = ${noncePlaceholder}
  )`;
}

// The last statement is an intentional constraint assertion. If any formal
// update was skipped, inserting the same attempt_id violates the primary key
// and D1 rolls back the entire batch, including the ownership CAS and every
// formal read-model update.
export async function commitScoreAttempt(db, {
  attemptId, jobId, claimToken, now = new Date(), internalGameId, gameId,
  canonicalLineupRevisionId, scoringLineupRevisionId, scoringRevisionId,
  scoringRevisionNumber, processed, perfectCount
}) {
  const at = now.toISOString();
  const nonce = crypto.randomUUID();
  const owned = ownedAttempt("?1", "?2");
  const statements = [
    db.prepare(`
      UPDATE score_attempts
         SET status = 'committing', commit_nonce = ?1
       WHERE attempt_id = ?2
         AND status = 'ready'
         AND job_id = ?3 AND claim_token = ?4
         AND internal_game_id = ?5
         AND canonical_lineup_revision_id = ?6
         AND expected_prediction_count = (
           SELECT COUNT(*) FROM score_attempt_prediction_rows WHERE attempt_id = ?2)
         AND expected_test_count = (
           SELECT COUNT(*) FROM score_attempt_test_rows WHERE attempt_id = ?2)
         AND NOT EXISTS (
           SELECT 1 FROM score_attempts AS prior
            WHERE prior.internal_game_id = ?5
              AND prior.canonical_lineup_revision_id = ?6
              AND prior.status = 'committed')
         AND EXISTS (
           SELECT 1 FROM game_lineups AS lineup
            WHERE lineup.internal_game_id = ?5
              AND lineup.final_lineup_revision_id = ?6
              AND lineup.lineup_fingerprint = score_attempts.canonical_lineup_fingerprint)
         AND EXISTS (
           SELECT 1 FROM game_lineup_revisions AS final_revision
            WHERE final_revision.internal_game_id = ?5
              AND final_revision.is_current = 1
              AND final_revision.is_final = 1
              AND (final_revision.revision_id = ?6
                OR final_revision.revision_id = ?7))
         AND NOT EXISTS (
           SELECT 1 FROM game_scoring_revisions AS conflicting
            WHERE conflicting.internal_game_id = ?5
              AND conflicting.id = ?8
              AND (conflicting.lineup_revision_id <> ?7
                OR conflicting.revision_number <> ?9))
         AND EXISTS (
           SELECT 1 FROM game_jobs_v3 AS owner
            WHERE owner.id = ?3
              AND owner.internal_game_id = ?5
              AND owner.job_type = 'score'
              AND owner.status = 'claimed'
              AND owner.claim_token = ?4
              AND julianday(owner.lease_expires_at) > julianday('now'))`)
      .bind(nonce, attemptId, Number(jobId), claimToken, internalGameId,
        canonicalLineupRevisionId, scoringLineupRevisionId, scoringRevisionId,
        Number(scoringRevisionNumber)),

    db.prepare(`
      UPDATE predictions
         SET score = (SELECT staged.total_score FROM score_attempt_prediction_rows AS staged
                       WHERE staged.attempt_id = ?1 AND staged.prediction_id = predictions.id),
             max_score = ?3, scored_at = ?4, status = 'scored',
             actual_lineup_json = (SELECT actual_lineup_json FROM score_attempts WHERE attempt_id = ?1),
             scoring_status = 'scored', scoring_exclusion_reason = NULL,
             scored_lineup_revision_id = ?5, scoring_revision = ?6,
             scored_by = 'system', scored_attempt_id = ?1, updated_at = ?4
       WHERE internal_game_id = ?7 AND is_test_prediction = 0
         AND EXISTS (SELECT 1 FROM score_attempt_prediction_rows AS staged
                      WHERE staged.attempt_id = ?1 AND staged.prediction_id = predictions.id
                        AND staged.outcome = 'scored')
         AND ${owned}`)
      .bind(attemptId, nonce, SCORING_MAX_SCORE, at, scoringLineupRevisionId,
        Number(scoringRevisionNumber), internalGameId),

    db.prepare(`
      UPDATE predictions
         SET score = NULL, max_score = NULL, scored_at = NULL,
             actual_lineup_json = NULL, scoring_status = 'excluded',
             scoring_exclusion_reason = (SELECT staged.exclusion_reason
                  FROM score_attempt_prediction_rows AS staged
                 WHERE staged.attempt_id = ?1 AND staged.prediction_id = predictions.id),
             scored_lineup_revision_id = NULL, scoring_revision = 0,
             scored_by = NULL, scored_attempt_id = ?1, updated_at = ?3
       WHERE internal_game_id = ?4 AND is_test_prediction = 0
         AND EXISTS (SELECT 1 FROM score_attempt_prediction_rows AS staged
                      WHERE staged.attempt_id = ?1 AND staged.prediction_id = predictions.id
                        AND staged.outcome = 'excluded')
         AND ${owned}`)
      .bind(attemptId, nonce, at, internalGameId),

    db.prepare(`
      UPDATE game_scoring_revisions SET is_active = 0
       WHERE internal_game_id = ?3 AND ${owned}`)
      .bind(attemptId, nonce, internalGameId),

    db.prepare(`
      INSERT INTO game_scoring_revisions (
        id, internal_game_id, game_id, revision_number, lineup_revision_id,
        status, reason, created_by, created_at, completed_at, is_active,
        committed_attempt_id
      )
      SELECT ?3, ?4, ?5, ?6, ?7, 'completed', 'initial_scoring', 'system', ?8, ?8, 1, ?1
       WHERE ${owned}
      ON CONFLICT(internal_game_id, lineup_revision_id) DO UPDATE SET
        status = 'completed', completed_at = excluded.completed_at,
        is_active = 1, committed_attempt_id = excluded.committed_attempt_id
       WHERE ${owned}`)
      .bind(attemptId, nonce, scoringRevisionId, internalGameId, gameId,
        Number(scoringRevisionNumber), scoringLineupRevisionId, at),

    db.prepare(`
      INSERT OR IGNORE INTO prediction_score_revisions (
        id, prediction_id, game_id, internal_game_id, is_test_prediction,
        scoring_revision, lineup_revision_id, score, max_score,
        actual_lineup_json, scored_at, scored_by, created_at
      )
      SELECT p.id || ':' || ?3, p.id, p.game_id, p.internal_game_id, 0,
             ?3, ?4, p.score, p.max_score, p.actual_lineup_json,
             p.scored_at, 'system', ?5
        FROM predictions AS p
       WHERE p.internal_game_id = ?6 AND p.is_test_prediction = 0
         AND p.status = 'scored' AND p.scored_attempt_id = ?1
         AND ${owned}`)
      .bind(attemptId, nonce, Number(scoringRevisionNumber), scoringLineupRevisionId,
        at, internalGameId),

    db.prepare(`
      UPDATE game_lineups
         SET scoring_status = 'scored', scored_at = ?3,
             scoring_started_at = NULL, last_error = NULL,
             processed_predictions = ?4, perfect_count = ?5,
             new_perfect_achievers = 0, scoring_lineup_revision_id = ?6,
             scoring_revision = ?7, scored_by = 'system', updated_at = ?3
       WHERE internal_game_id = ?8
         AND final_lineup_revision_id = ?9
         AND ${owned}`)
      .bind(attemptId, nonce, at, Number(processed || 0), Number(perfectCount || 0),
        scoringLineupRevisionId, Number(scoringRevisionNumber), internalGameId,
        canonicalLineupRevisionId),

    db.prepare(`
      INSERT INTO ranking_test_predictions (
        internal_game_id, slot, prediction_json, status, score, max_score,
        lineup_revision_id, scoring_revision_id, scored_at, created_at,
        updated_at, scored_attempt_id
      )
      SELECT ?3, staged.slot, staged.prediction_json, staged.status,
             staged.score, staged.max_score,
             CASE WHEN staged.status = 'scored' THEN ?4 ELSE NULL END,
             CASE WHEN staged.status = 'scored' THEN ?5 ELSE NULL END,
             CASE WHEN staged.status = 'scored' THEN ?6 ELSE NULL END,
             ?6, ?6, ?1
        FROM score_attempt_test_rows AS staged
       WHERE staged.attempt_id = ?1 AND ${owned}
      ON CONFLICT(internal_game_id, slot) DO UPDATE SET
        prediction_json = excluded.prediction_json, status = excluded.status,
        score = excluded.score, max_score = excluded.max_score,
        lineup_revision_id = excluded.lineup_revision_id,
        scoring_revision_id = excluded.scoring_revision_id,
        scored_at = excluded.scored_at, updated_at = excluded.updated_at,
        scored_attempt_id = excluded.scored_attempt_id`)
      .bind(attemptId, nonce, internalGameId, canonicalLineupRevisionId,
        scoringRevisionId, at),

    db.prepare(`
      UPDATE game_automation_v3_state
         SET state = 'scored', scoring_revision_id = ?3,
             version = version + 1, updated_at = ?4,
             failure_code = NULL, failure_message = NULL
       WHERE internal_game_id = ?5
         AND state IN ('scheduled', 'prediction_closed', 'lineup_ready',
                       'manual_action_required', 'scored', 'ranked', 'published')
         AND ${owned}`)
      .bind(attemptId, nonce, scoringRevisionId, at, internalGameId),

    db.prepare(`
      UPDATE game_jobs_v3
         SET status = 'completed', completed_at = ?3,
             lease_expires_at = NULL, claim_token = NULL,
             failure_code = NULL, failure_message = NULL, updated_at = ?3
       WHERE id = ?4 AND internal_game_id = ?5 AND status = 'claimed'
         AND claim_token = ?6 AND ${owned}`)
      .bind(attemptId, nonce, at, Number(jobId), internalGameId, claimToken),

    // Deliberate rollback assertion. This has zero rows on success and a
    // duplicate-primary-key insert on any failed invariant.
    db.prepare(`
      INSERT INTO score_attempts (
        attempt_id, internal_game_id, game_id, canonical_lineup_revision_id,
        scoring_lineup_revision_id, canonical_lineup_fingerprint, job_id,
        claim_token, status, expected_prediction_count, expected_test_count,
        scoring_revision_id, scoring_revision_number, actual_lineup_json,
        commit_nonce, created_at
      )
      SELECT attempt_id, internal_game_id, game_id, canonical_lineup_revision_id,
             scoring_lineup_revision_id, canonical_lineup_fingerprint, job_id,
             claim_token, status, expected_prediction_count, expected_test_count,
             scoring_revision_id, scoring_revision_number, actual_lineup_json,
             commit_nonce, created_at
        FROM score_attempts AS attempt
       WHERE attempt.attempt_id = ?1 AND attempt.status = 'committing'
         AND attempt.commit_nonce = ?2
         AND NOT (
           (SELECT COUNT(*) FROM predictions
             WHERE internal_game_id = ?3 AND is_test_prediction = 0
               AND scored_attempt_id = ?1) = attempt.expected_prediction_count
           AND (SELECT COUNT(*) FROM score_attempt_prediction_rows
             WHERE attempt_id = ?1) = attempt.expected_prediction_count
           AND (SELECT COUNT(*) FROM ranking_test_predictions
             WHERE internal_game_id = ?3 AND scored_attempt_id = ?1) = attempt.expected_test_count
           AND EXISTS (SELECT 1 FROM game_scoring_revisions
             WHERE id = ?4 AND internal_game_id = ?3
               AND status = 'completed' AND is_active = 1
               AND committed_attempt_id = ?1)
           AND EXISTS (SELECT 1 FROM game_lineups
             WHERE internal_game_id = ?3
               AND final_lineup_revision_id = ?5
               AND scoring_status = 'scored')
           AND EXISTS (SELECT 1 FROM game_automation_v3_state
             WHERE internal_game_id = ?3 AND state = 'scored'
               AND scoring_revision_id = ?4)
           AND EXISTS (SELECT 1 FROM game_jobs_v3
             WHERE id = ?6 AND status = 'completed')
         )`)
      .bind(attemptId, nonce, internalGameId, scoringRevisionId,
        canonicalLineupRevisionId, Number(jobId)),

    db.prepare(`
      UPDATE score_attempts SET status = 'committed', committed_at = ?3
       WHERE attempt_id = ?1 AND status = 'committing' AND commit_nonce = ?2`)
      .bind(attemptId, nonce, at)
  ];

  const results = await db.batch(statements);
  return {
    committed: Number(results[0]?.meta?.changes || 0) === 1
      && Number(results[results.length - 1]?.meta?.changes || 0) === 1,
    stale: Number(results[0]?.meta?.changes || 0) !== 1
  };
}
