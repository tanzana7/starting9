// Formal scoring writes only to attempt-owned staging until the final D1 batch.
// The batch is the sole path that changes the current score read model.
export async function createScoreAttempt(db, input) {
  const result = await db.prepare(`INSERT OR IGNORE INTO score_attempts
    (attempt_id, internal_game_id, game_id, canonical_lineup_revision_id,
     scoring_lineup_revision_id, canonical_lineup_fingerprint, job_id, claim_token, status,
     expected_prediction_count, expected_test_count, scoring_revision_id,
     scoring_revision_number, actual_lineup_json, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'staging', ?9, ?10, ?11, ?12, ?13, ?14)`)
    .bind(input.attemptId, input.internalGameId, input.gameId, input.lineupRevisionId,
      input.scoringLineupRevisionId, input.lineupFingerprint, input.jobId, input.claimToken,
      input.expectedPredictionCount, input.expectedTestCount,
      input.scoringRevisionId, input.scoringRevisionNumber,
      input.actualLineupJson, input.createdAt).run();
  if (Number(result?.meta?.changes || 0) !== 1) {
    const existing = await db.prepare(
      "SELECT attempt_id FROM score_attempts WHERE job_id = ?1 AND claim_token = ?2 LIMIT 1"
    ).bind(input.jobId, input.claimToken).first();
    if (!existing || existing.attempt_id !== input.attemptId) {
      throw new Error("score attempt claim generation already exists");
    }
  }
}

export async function stageScorePrediction(db, attemptId, row) {
  await db.prepare(`INSERT INTO score_attempt_prediction_rows
    (attempt_id, prediction_id, outcome, score, max_score,
     player_hits, order_hits, position_hits, perfect_hits, exclusion_reason)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
    ON CONFLICT(attempt_id, prediction_id) DO UPDATE SET
      outcome = excluded.outcome, score = excluded.score, max_score = excluded.max_score,
      player_hits = excluded.player_hits, order_hits = excluded.order_hits,
      position_hits = excluded.position_hits, perfect_hits = excluded.perfect_hits,
      exclusion_reason = excluded.exclusion_reason`)
    .bind(attemptId, row.id, row.outcome, row.score ?? null, row.maxScore ?? null,
      row.counts?.player ?? null, row.counts?.order ?? null,
      row.counts?.position ?? null, row.counts?.perfect ?? null,
      row.exclusionReason ?? null).run();
}

export async function stageScoreTest(db, attemptId, row) {
  await db.prepare(`INSERT INTO score_attempt_test_rows
    (attempt_id, slot, prediction_json, status, score, max_score, warning_code)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT(attempt_id, slot) DO UPDATE SET
      prediction_json = excluded.prediction_json, status = excluded.status,
      score = excluded.score, max_score = excluded.max_score,
      warning_code = excluded.warning_code`)
    .bind(attemptId, row.slot, row.predictionJson ?? null, row.status,
      row.score ?? null, row.maxScore ?? null, row.warningCode ?? null).run();
}

export async function markScoreAttemptReady(db, attemptId) {
  const result = await db.prepare(`UPDATE score_attempts SET status = 'ready'
    WHERE attempt_id = ?1 AND status = 'staging'
      AND expected_prediction_count = (SELECT COUNT(*) FROM score_attempt_prediction_rows WHERE attempt_id = ?1)
      AND expected_test_count = (SELECT COUNT(*) FROM score_attempt_test_rows WHERE attempt_id = ?1)`)
    .bind(attemptId).run();
  return Number(result?.meta?.changes || 0) === 1;
}

export async function commitScoreAttempt(db, { attemptId, jobId, claimToken, now,
  internalGameId, gameId, lineupRevisionId, scoringLineupRevisionId, scoringRevisionId,
  scoringRevisionNumber, processed, perfectCount }) {
  const at = now.toISOString();
  const nonce = crypto.randomUUID();
  const owned = `EXISTS (SELECT 1 FROM score_attempts AS attempt
    WHERE attempt.attempt_id = ?1 AND attempt.status = 'committing'
      AND attempt.commit_nonce = ?2)`;
  // D1 batch is a transaction. The first CAS is the only ownership decision;
  // every subsequent mutation is gated by its fresh nonce. A failed final
  // consistency check raises a CHECK error and rolls the whole batch back.
  const statements = [
    db.prepare(`UPDATE score_attempts SET status = 'committing', commit_nonce = ?1
      WHERE attempt_id = ?2 AND status = 'ready' AND job_id = ?3 AND claim_token = ?4
        AND internal_game_id = ?5 AND canonical_lineup_revision_id = ?6
        AND expected_prediction_count = (
          SELECT COUNT(*) FROM score_attempt_prediction_rows WHERE attempt_id = ?2)
        AND expected_prediction_count = (
          SELECT COUNT(*) FROM predictions WHERE internal_game_id = ?5 AND is_test_prediction = 0)
        AND expected_test_count = (
          SELECT COUNT(*) FROM score_attempt_test_rows WHERE attempt_id = ?2)
        AND NOT EXISTS (SELECT 1 FROM score_attempts AS committed
          WHERE committed.internal_game_id = ?5
            AND committed.canonical_lineup_revision_id = ?6
            AND committed.status = 'committed')
        AND NOT EXISTS (SELECT 1 FROM predictions AS p
          WHERE p.internal_game_id = ?5 AND p.is_test_prediction = 0
            AND NOT EXISTS (SELECT 1 FROM score_attempt_prediction_rows AS staged
              WHERE staged.attempt_id = ?2 AND staged.prediction_id = p.id))
        AND NOT EXISTS (SELECT 1 FROM score_attempt_prediction_rows AS staged
          LEFT JOIN predictions AS p ON p.id = staged.prediction_id
          WHERE staged.attempt_id = ?2 AND (p.internal_game_id IS NULL
            OR p.internal_game_id <> ?5 OR p.is_test_prediction <> 0))
        AND NOT EXISTS (SELECT 1 FROM game_scoring_revisions AS revision
          WHERE revision.internal_game_id = ?5
            AND revision.lineup_revision_id = score_attempts.scoring_lineup_revision_id
            AND (revision.id <> score_attempts.scoring_revision_id
              OR revision.revision_number <> score_attempts.scoring_revision_number))
        AND EXISTS (SELECT 1 FROM game_lineups AS lineup
          WHERE lineup.internal_game_id = ?5
            AND lineup.final_lineup_revision_id = ?6
            AND lineup.lineup_fingerprint = score_attempts.canonical_lineup_fingerprint)
        AND EXISTS (SELECT 1 FROM game_lineup_revisions AS finalized
          WHERE finalized.internal_game_id = ?5 AND finalized.is_final = 1
            AND finalized.is_current = 1
            AND finalized.revision_id = score_attempts.scoring_lineup_revision_id)
        AND EXISTS (SELECT 1 FROM game_jobs_v3 AS job
          WHERE job.id = ?3 AND job.internal_game_id = ?5 AND job.job_type = 'score'
            AND job.status = 'claimed' AND job.claim_token = ?4
            AND julianday(job.lease_expires_at) > julianday('now'))`)
      .bind(nonce, attemptId, jobId, claimToken, internalGameId, lineupRevisionId),
    db.prepare(`UPDATE predictions SET
        score = (SELECT staged.score FROM score_attempt_prediction_rows AS staged
          WHERE staged.attempt_id = ?1 AND staged.prediction_id = predictions.id),
        max_score = 99, scored_at = ?3, status = 'scored',
        actual_lineup_json = (SELECT actual_lineup_json FROM score_attempts WHERE attempt_id = ?1),
        scoring_status = 'scored', scoring_exclusion_reason = NULL,
        scored_lineup_revision_id = ?4, scoring_revision = ?5,
        scored_by = 'system', scored_attempt_id = ?1
      WHERE internal_game_id = ?6 AND is_test_prediction = 0
        AND EXISTS (SELECT 1 FROM score_attempt_prediction_rows AS staged
          WHERE staged.attempt_id = ?1 AND staged.prediction_id = predictions.id AND staged.outcome = 'scored')
        AND ${owned}`)
      .bind(attemptId, nonce, at, scoringLineupRevisionId, scoringRevisionNumber, internalGameId),
    db.prepare(`UPDATE predictions SET
        score = NULL, max_score = NULL, scored_at = NULL,
        actual_lineup_json = NULL, status = 'locked',
        scoring_status = 'excluded',
        scoring_exclusion_reason = (SELECT staged.exclusion_reason FROM score_attempt_prediction_rows AS staged
          WHERE staged.attempt_id = ?1 AND staged.prediction_id = predictions.id),
        scored_lineup_revision_id = NULL, scoring_revision = 0,
        scored_by = NULL, scored_attempt_id = ?1, updated_at = ?3
      WHERE internal_game_id = ?4 AND is_test_prediction = 0
        AND EXISTS (SELECT 1 FROM score_attempt_prediction_rows AS staged
          WHERE staged.attempt_id = ?1 AND staged.prediction_id = predictions.id AND staged.outcome = 'excluded')
        AND ${owned}`)
      .bind(attemptId, nonce, at, internalGameId),
    db.prepare(`UPDATE game_scoring_revisions SET is_active = 0
      WHERE internal_game_id = ?3 AND ${owned}`)
      .bind(attemptId, nonce, internalGameId),
    db.prepare(`INSERT INTO game_scoring_revisions
      (id, internal_game_id, game_id, revision_number, lineup_revision_id,
       status, reason, created_by, created_at, completed_at, is_active, committed_attempt_id)
      SELECT ?3, ?4, ?5, ?6, ?7, 'completed', 'initial_scoring', 'system', ?8, ?8, 1, ?1
      WHERE ${owned}
      ON CONFLICT(internal_game_id, lineup_revision_id) DO UPDATE SET
        status = 'completed', completed_at = excluded.completed_at,
        is_active = 1, committed_attempt_id = excluded.committed_attempt_id`)
      .bind(attemptId, nonce, scoringRevisionId, internalGameId, gameId,
        scoringRevisionNumber, scoringLineupRevisionId, at),
    db.prepare(`INSERT INTO prediction_score_revisions
      (id, prediction_id, game_id, internal_game_id, is_test_prediction,
       scoring_revision, lineup_revision_id, score, max_score, actual_lineup_json,
       scored_at, scored_by, created_at)
      SELECT p.id || ':' || ?3, p.id, p.game_id, p.internal_game_id, 0,
             ?3, ?4, p.score, p.max_score, p.actual_lineup_json,
             p.scored_at, 'system', ?5
        FROM predictions AS p
       WHERE p.internal_game_id = ?6 AND p.is_test_prediction = 0
         AND p.status = 'scored' AND p.scored_attempt_id = ?1 AND ${owned}
      ON CONFLICT(prediction_id, scoring_revision) DO UPDATE SET
        score = excluded.score, max_score = excluded.max_score,
        actual_lineup_json = excluded.actual_lineup_json,
        scored_at = excluded.scored_at, lineup_revision_id = excluded.lineup_revision_id`)
      .bind(attemptId, nonce, scoringRevisionNumber, scoringLineupRevisionId, at, internalGameId),
    db.prepare(`UPDATE game_lineups SET scoring_status = 'scored',
        scored_at = ?3, scoring_started_at = NULL, last_error = NULL,
        processed_predictions = ?4, perfect_count = ?5,
        new_perfect_achievers = 0, scoring_lineup_revision_id = ?6,
        scoring_revision = ?7, scored_by = 'system', updated_at = ?3
      WHERE internal_game_id = ?8 AND final_lineup_revision_id = ?9 AND ${owned}`)
      .bind(attemptId, nonce, at, processed, perfectCount, scoringLineupRevisionId,
        scoringRevisionNumber, internalGameId, lineupRevisionId),
    db.prepare(`INSERT INTO ranking_test_predictions
      (internal_game_id, slot, prediction_json, status, score, max_score,
       lineup_revision_id, scoring_revision_id, scored_at, created_at, updated_at, scored_attempt_id)
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
      .bind(attemptId, nonce, internalGameId, lineupRevisionId, scoringRevisionId, at),
    db.prepare(`UPDATE game_automation_v3_state SET
        state = 'scored', scoring_revision_id = ?3,
        version = version + 1, updated_at = ?4,
        failure_code = NULL, failure_message = NULL
      WHERE internal_game_id = ?5 AND state IN ('scheduled', 'prediction_closed', 'lineup_ready', 'manual_action_required', 'published')
        AND ${owned}`)
      .bind(attemptId, nonce, scoringRevisionId, at, internalGameId),
    db.prepare(`UPDATE game_jobs_v3 SET status = 'completed',
        completed_at = ?3, lease_expires_at = NULL, claim_token = NULL,
        failure_code = NULL, failure_message = NULL, updated_at = ?3
      WHERE id = ?4 AND internal_game_id = ?5 AND status = 'claimed'
        AND claim_token = ?6 AND ${owned}`)
      .bind(attemptId, nonce, at, jobId, internalGameId, claimToken),
    db.prepare(`UPDATE score_attempts SET
        status = CASE WHEN
          (SELECT COUNT(*) FROM predictions WHERE internal_game_id = ?3
            AND is_test_prediction = 0 AND scored_attempt_id = ?1) = expected_prediction_count
          AND (SELECT COUNT(*) FROM ranking_test_predictions WHERE internal_game_id = ?3
            AND scored_attempt_id = ?1) = expected_test_count
          AND EXISTS (SELECT 1 FROM game_scoring_revisions AS revision
            WHERE revision.id = ?4 AND revision.internal_game_id = ?3
              AND revision.is_active = 1 AND revision.status = 'completed'
              AND revision.committed_attempt_id = ?1)
          AND EXISTS (SELECT 1 FROM game_lineups AS lineup
            WHERE lineup.internal_game_id = ?3 AND lineup.final_lineup_revision_id = ?5
              AND lineup.scoring_status = 'scored')
          AND EXISTS (SELECT 1 FROM game_automation_v3_state AS workflow
            WHERE workflow.internal_game_id = ?3 AND workflow.state = 'scored'
              AND workflow.scoring_revision_id = ?4)
          AND EXISTS (SELECT 1 FROM game_jobs_v3 AS job
            WHERE job.id = ?6 AND job.status = 'completed')
        THEN 'committed' ELSE 'abandoned' END,
        committed_at = ?7
      WHERE attempt_id = ?1 AND commit_nonce = ?2 AND status = 'committing'`)
      .bind(attemptId, nonce, internalGameId, scoringRevisionId,
        lineupRevisionId, jobId, at)
  ];
  const results = await db.batch(statements);
  return { committed: Number(results[0]?.meta?.changes || 0) === 1,
    stale: Number(results[0]?.meta?.changes || 0) !== 1 };
}
