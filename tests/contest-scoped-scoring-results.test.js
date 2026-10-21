import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { getDailyBestNineForGame, getLatestPublishedRankingGame, getRankingForPeriod } from "../backend/repositories/ranking-repository.js";
import { createScoreAttempt, stageScorePrediction, markScoreAttemptReady, commitScoreAttempt } from "../backend/automation-v3/score-attempts.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = path.join(ROOT, "migrations");
const A3 = "0048_contest_scoped_results.sql";

function applyThrough(db, last) {
  for (const file of fs.readdirSync(MIGRATIONS).filter(name => name.endsWith(".sql") && name <= last).sort()) {
    db.exec(fs.readFileSync(path.join(MIGRATIONS, file), "utf8"));
  }
}

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      const bound = (...values) => ({
        first: async () => statement.get(...values),
        all: async () => ({ results: statement.all(...values) }),
        run: async () => ({ meta: { changes: Number(statement.run(...values).changes || 0) } })
      });
      return { bind: (...values) => bound(...values), run: async () => ({ meta: { changes: Number(statement.run().changes || 0) } }) };
    },
    async batch(statements) {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    }
  };
}

test("0048 fresh migration creates contest-owned scoring, ranking, rescore and publication artifacts", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyThrough(db, A3);
    for (const table of ["contest_scoring_revisions", "contest_score_attempts", "contest_score_attempt_prediction_rows",
      "contest_score_attempt_test_rows", "contest_ranking_test_game_settings", "contest_ranking_test_predictions",
      "contest_prediction_score_revisions", "contest_ranking_games", "contest_ranking_reflection_revisions",
      "contest_game_rescore_previews", "contest_game_rescore_jobs", "contest_game_rescore_audits",
      "contest_perfect_achievers"]) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), `missing ${table}`);
    }
    const now = "2026-10-20T00:00:00.000Z";
    db.prepare(`INSERT INTO games (internal_game_id,game_date,start_time,home_team,away_team,game_status,created_at,updated_at)
      VALUES ('unscored-excluded-game','2026-10-20','2026-10-20T09:00:00Z','fighters','marines','scheduled',?,?)`).run(now,now);
    db.prepare(`INSERT INTO game_contests (contest_id,internal_game_id,target_team_key,created_at)
      VALUES ('unscored-excluded-contest','unscored-excluded-game','fighters',?)`).run(now);
    db.prepare(`INSERT INTO contest_ranking_reflection_revisions
      (id,contest_id,internal_game_id,scoring_revision_id,ranking_eligibility_version,ranking_update_revision,status,created_at)
      VALUES ('no-score-exclusion','unscored-excluded-contest','unscored-excluded-game',NULL,1,1,'excluded',?)`).run(now);
    db.prepare(`INSERT INTO contest_ranking_reflection_revisions
      (id,contest_id,internal_game_id,scoring_revision_id,ranking_eligibility_version,ranking_update_revision,status,created_at)
      VALUES ('no-score-revocation','unscored-excluded-contest','unscored-excluded-game',NULL,2,2,'revoked',?)`).run(now);
    assert.equal(db.prepare("SELECT status FROM contest_ranking_reflection_revisions WHERE id='no-score-revocation'").get().status, "revoked");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { db.close(); }
});

test("Daily Best Nine lookup stays in the requested contest for a shared physical game", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyThrough(db, A3);
    const now = "2026-10-20T00:00:00.000Z";
    db.prepare(`INSERT INTO users (id,username,username_normalized,password_hash,password_salt,password_iterations,status,role,created_at,updated_at)
      VALUES ('u-f','fighters-user','fighters-user','h','s',1,'active','user',?,?),
             ('u-m','marines-user','marines-user','h','s',1,'active','user',?,?)`).run(now,now,now,now);
    db.prepare(`INSERT INTO games (internal_game_id,game_date,start_time,home_team,away_team,game_status,created_at,updated_at)
      VALUES ('same-physical-game','2026-10-19','2026-10-19T09:00:00Z','fighters','marines','scheduled',?,?)`).run(now,now);
    db.prepare(`INSERT INTO game_jobs_v3 (id,internal_game_id,job_type,scheduled_at,scheduled_slot_at,status,created_at,updated_at)
      VALUES (1,'same-physical-game','score',?,'2026-10-19T09:00:00Z','completed',?,?)`).run(now,now,now);
    db.exec(`INSERT INTO game_contests (contest_id,internal_game_id,target_team_key,created_at)
      VALUES ('contest-f','same-physical-game','fighters','${now}'),('contest-m','same-physical-game','marines','${now}')`);
    db.prepare(`INSERT INTO predictions (id,user_id,game_id,internal_game_id,contest_id,prediction_json,schema_version,game_date,
      home_team,away_team,opponent_code,is_home,is_test_prediction,submitted_at,updated_at,score,max_score,status,scoring_status,
      scoring_revision,scored_attempt_id) VALUES
      ('pf','u-f','same-physical-game','same-physical-game','contest-f','{}',1,'2026-10-19','fighters','marines','m',1,0,?,?,88,99,'scored','scored',1,'af'),
      ('pm','u-m','same-physical-game','same-physical-game','contest-m','{}',1,'2026-10-19','fighters','marines','f',0,0,?,?,41,99,'scored','scored',1,'am')`).run(now,now,now,now);
    for (const [contestId, userId, attemptId, score] of [["contest-f","u-f","af",88],["contest-m","u-m","am",41]]) {
      db.prepare(`INSERT INTO game_lineups (id,game_id,contest_id,actual_lineup_json,lineup_fingerprint,schema_version,
        lineup_detected_at,scoring_due_at,scoring_status,created_at,updated_at,publication_status,published_at,
        internal_game_id,final_lineup_revision_id,scoring_lineup_revision_id,scoring_revision)
        VALUES (?, 'same-physical-game',?,'[]','fp',1,?,?,'scored',? ,?,'published',?,'same-physical-game',?,?,1)`)
        .run(`${contestId}:lineup`,contestId,now,now,now,now,now,`${contestId}:lineup:1`,`${contestId}:lineup:1`);
      db.prepare(`INSERT INTO contest_lineup_revisions (contest_id,internal_game_id,game_id,version,revision_id,actual_lineup_json,
        lineup_fingerprint,source,created_at,reason,is_current,is_final) VALUES (?, 'same-physical-game','same-physical-game',1,?, '[]','fp','manual',?,'fixture',1,1)`)
        .run(contestId,`${contestId}:lineup:1`,now);
      db.prepare(`INSERT INTO contest_scoring_revisions (contest_id,internal_game_id,id,game_id,revision_number,lineup_revision_id,status,
        reason,created_by,created_at,completed_at,is_active,committed_attempt_id) VALUES (?,'same-physical-game',?,'same-physical-game',1,?,'completed','initial','system',?,?,1,?)`)
        .run(contestId,`${contestId}:score:1`,`${contestId}:lineup:1`,now,now,attemptId);
      db.prepare(`INSERT INTO contest_score_attempts (attempt_id,contest_id,internal_game_id,game_id,canonical_lineup_revision_id,
        scoring_lineup_revision_id,canonical_lineup_fingerprint,job_id,claim_token,status,expected_prediction_count,expected_test_count,
        scoring_revision_id,scoring_revision_number,actual_lineup_json,created_at,committed_at) VALUES (?,?, 'same-physical-game','same-physical-game',?,?, 'fp', 1, ?, 'committed',1,0,?,1,'[]',?,?)`)
        .run(attemptId,contestId,`${contestId}:lineup:1`,`${contestId}:lineup:1`,attemptId,`${contestId}:score:1`,now,now);
      db.prepare(`INSERT INTO contest_ranking_games (contest_id,internal_game_id,game_id,is_ranking_eligible,ranking_eligible_at,
        game_status,is_test_game,created_at,updated_at,game_date,scored_private_at,published_at,publication_status,
        ranking_eligibility_status,ranking_eligibility_version,ranking_eligibility_updated_by,ranking_eligibility_updated_at)
        VALUES (?,'same-physical-game','same-physical-game',1,?,'scored',0,?,?,'2026-10-19',?,?,'published','eligible',1,'system',?)`)
        .run(contestId,now,now,now,now,now,now);
    }
    db.prepare("UPDATE contest_ranking_games SET publication_status='pending',published_at=NULL WHERE contest_id='contest-m'").run();
    db.prepare("UPDATE game_lineups SET publication_status='pending',published_at=NULL WHERE contest_id='contest-m'").run();
    const binding = d1(db);
    const fighters = await getDailyBestNineForGame(binding, { internalGameId: "same-physical-game", contestId: "contest-f" });
    const marines = await getDailyBestNineForGame(binding, { internalGameId: "same-physical-game", contestId: "contest-m" });
    assert.deepEqual(fighters.rows.map(row => row.score), [88]);
    assert.deepEqual(marines.rows, []);
    assert.equal((await getLatestPublishedRankingGame(binding, { contestId: "contest-f" })).contestId, "contest-f");
    assert.equal(await getLatestPublishedRankingGame(binding, { contestId: "contest-m" }), null);
    const fightersRanking = await getRankingForPeriod(binding, { limit: 10, offset: 0, qualifiedOnly: false,
      startAt: null, endAt: null, publishedOnly: true, targetTeamKey: "fighters" });
    const marinesRanking = await getRankingForPeriod(binding, { limit: 10, offset: 0, qualifiedOnly: false,
      startAt: null, endAt: null, publishedOnly: true, targetTeamKey: "marines" });
    assert.deepEqual(fightersRanking.rows.map(row => [row.username, row.totalScore]), [["fighters-user", 88]]);
    assert.deepEqual(marinesRanking.rows, []);

    const fightersPublishedAt = db.prepare("SELECT published_at FROM contest_ranking_games WHERE contest_id='contest-f'").get().published_at;
    db.prepare("UPDATE contest_ranking_games SET publication_status='published',published_at=? WHERE contest_id='contest-m'").run(now);
    db.prepare("UPDATE game_lineups SET publication_status='published',published_at=? WHERE contest_id='contest-m'").run(now);
    assert.equal((await getLatestPublishedRankingGame(binding, { contestId: "contest-m" })).contestId, "contest-m");
    assert.equal(db.prepare("SELECT published_at FROM contest_ranking_games WHERE contest_id='contest-f'").get().published_at, fightersPublishedAt);
    assert.deepEqual((await getDailyBestNineForGame(binding, { internalGameId: "same-physical-game", contestId: "contest-m" })).rows.map(row => row.score), [41]);
  } finally { db.close(); }
});

test("same-game score commits write independent contest scores and revision lineage", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    applyThrough(database, A3);
    const db = d1(database);
    const now = "2026-10-20T00:00:00.000Z";
    database.prepare(`INSERT INTO users (id,username,username_normalized,password_hash,password_salt,password_iterations,status,role,created_at,updated_at)
      VALUES ('score-f','score-f','score-f','h','s',1,'active','user',?,?),('score-m','score-m','score-m','h','s',1,'active','user',?,?)`).run(now,now,now,now);
    database.prepare(`INSERT INTO games (internal_game_id,game_date,start_time,home_team,away_team,game_status,created_at,updated_at)
      VALUES ('score-shared','2026-10-19','2026-10-19T09:00:00Z','fighters','marines','scheduled',?,?)`).run(now,now);
    database.exec(`INSERT INTO game_contests (contest_id,internal_game_id,target_team_key,created_at)
      VALUES ('score-contest-f','score-shared','fighters','${now}'),('score-contest-m','score-shared','marines','${now}')`);
    const fixtures = [
      { contestId: "score-contest-f", userId: "score-f", jobId: 101, token: "claim-f", score: 77, rev: "score-contest-f:lineup:1", slot: "2026-10-20T00:00:01.000Z" },
      { contestId: "score-contest-m", userId: "score-m", jobId: 102, token: "claim-m", score: 33, rev: "score-contest-m:lineup:1", slot: "2026-10-20T00:00:02.000Z" }
    ];
    for (const fixture of fixtures) {
      database.prepare(`INSERT INTO game_jobs_v3 (id,internal_game_id,job_type,scheduled_at,scheduled_slot_at,status,claim_token,lease_expires_at,created_at,updated_at)
        VALUES (?,'score-shared','score',? ,?,'claimed',?,'2099-01-01T00:00:00.000Z',?,?)`)
        .run(fixture.jobId, fixture.slot, fixture.slot, fixture.token, now, now);
      database.prepare(`INSERT INTO game_lineups (id,game_id,contest_id,actual_lineup_json,lineup_fingerprint,schema_version,
        lineup_detected_at,scoring_due_at,scoring_status,created_at,updated_at,publication_status,internal_game_id,
        final_lineup_revision_id,scoring_lineup_revision_id,scoring_revision)
        VALUES (?,'score-shared',?,'[]','fp',1,?,?,'pending',?,?,'pending','score-shared',?,NULL,0)`)
        .run(`${fixture.contestId}:lineup`,fixture.contestId,now,now,now,now,fixture.rev);
      database.prepare(`INSERT INTO contest_lineup_revisions (contest_id,internal_game_id,game_id,version,revision_id,actual_lineup_json,
        lineup_fingerprint,source,created_at,reason,is_current,is_final) VALUES (?,'score-shared','score-shared',1,?,'[]','fp','manual',?,'fixture',1,1)`)
        .run(fixture.contestId,fixture.rev,now);
      database.prepare(`INSERT INTO predictions (id,user_id,game_id,contest_id,prediction_json,schema_version,game_date,home_team,away_team,
        opponent_code,is_home,submitted_at,updated_at,status,is_test_prediction,internal_game_id,scoring_status)
        VALUES (?,?,'score-shared',?,'{}',1,'2026-10-19','fighters','marines','',1,?,?,'submitted',0,'score-shared','pending')`)
        .run(`${fixture.contestId}:prediction`,fixture.userId,fixture.contestId,now,now);
      database.prepare(`INSERT INTO contest_scoring_revisions (contest_id,internal_game_id,id,game_id,revision_number,lineup_revision_id,
        status,reason,created_by,created_at,is_active) VALUES (?,'score-shared',?,'score-shared',1,?,'in_progress','initial_scoring','system',?,0)`)
        .run(fixture.contestId,`${fixture.contestId}:score:1`,fixture.rev,now);
    }
    for (const fixture of fixtures) {
      const attemptId = `${fixture.contestId}:attempt`;
      await createScoreAttempt(db, { attemptId, contestId: fixture.contestId, internalGameId: "score-shared", gameId: "score-shared",
        canonicalLineupRevisionId: fixture.rev, scoringLineupRevisionId: fixture.rev, lineupFingerprint: "fp", jobId: fixture.jobId,
        claimToken: fixture.token, expectedPredictionCount: 1, expectedTestCount: 0,
        scoringRevisionId: `${fixture.contestId}:score:1`, scoringRevisionNumber: 1, actualLineupJson: "[]", createdAt: now });
      await stageScorePrediction(db, attemptId, { id: `${fixture.contestId}:prediction`, outcome: "scored", score: fixture.score,
        counts: { player: 3, order: 2, position: 1, perfect: 0 } });
      assert.equal(await markScoreAttemptReady(db, attemptId, new Date(now)), true);
      const committed = await commitScoreAttempt(db, { attemptId, contestId: fixture.contestId, jobId: fixture.jobId,
        claimToken: fixture.token, now: new Date(now), internalGameId: "score-shared", gameId: "score-shared",
        canonicalLineupRevisionId: fixture.rev, scoringLineupRevisionId: fixture.rev,
        scoringRevisionId: `${fixture.contestId}:score:1`, scoringRevisionNumber: 1, processed: 1, perfectCount: 0 });
      assert.equal(committed.committed, true);
    }
    assert.deepEqual(database.prepare(`SELECT p.contest_id,p.score,s.revision_number,s.lineup_revision_id
      FROM predictions p JOIN contest_scoring_revisions s ON s.contest_id=p.contest_id
      WHERE p.internal_game_id='score-shared' ORDER BY p.contest_id`).all().map(row => ({ ...row })), [
      { contest_id: "score-contest-f", score: 77, revision_number: 1, lineup_revision_id: "score-contest-f:lineup:1" },
      { contest_id: "score-contest-m", score: 33, revision_number: 1, lineup_revision_id: "score-contest-m:lineup:1" }
    ]);
    assert.throws(() => database.prepare(`INSERT INTO contest_prediction_score_revisions
      (id,contest_id,prediction_id,game_id,internal_game_id,scoring_revision,created_at)
      VALUES ('cross-score-history','score-contest-f','score-contest-m:prediction','score-shared','score-shared',1,?)`).run(now),
    /FOREIGN KEY constraint failed/,
    "a score-history row cannot attach a sibling contest prediction even when both share one physical game");

    const assertNoWrite = (table, statement, ...params) => {
      const before = database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
      assert.throws(() => statement.run(...params), /FOREIGN KEY constraint failed|SCORE_ATTEMPT_CONTEST_MISMATCH/);
      assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, before, `${table} stayed unchanged after scope mismatch`);
    };
    assertNoWrite("contest_scoring_revisions", database.prepare(`INSERT INTO contest_scoring_revisions
      (contest_id,internal_game_id,id,game_id,revision_number,lineup_revision_id,status,reason,created_by,created_at,is_active)
      VALUES ('score-contest-f','score-shared','bad-revision','score-shared',2,'score-contest-m:lineup:1','pending','injected','system',?,0)`), now);

    for (const [jobId, attemptId, token, column] of [
      [103, "bad-canonical-attempt", "bad-canonical-token", "canonical_lineup_revision_id"],
      [104, "bad-scoring-attempt", "bad-scoring-token", "scoring_lineup_revision_id"]
    ]) {
      database.prepare(`INSERT INTO game_jobs_v3 (id,internal_game_id,job_type,scheduled_at,scheduled_slot_at,status,created_at,updated_at)
        VALUES (?,'score-shared','score',?,?, 'pending',?,?)`).run(jobId, now, `${now.slice(0, 19)}.${jobId}Z`, now, now);
      const canonical = column === "canonical_lineup_revision_id" ? "score-contest-m:lineup:1" : "score-contest-f:lineup:1";
      const scoring = column === "scoring_lineup_revision_id" ? "score-contest-m:lineup:1" : "score-contest-f:lineup:1";
      assertNoWrite("contest_score_attempts", database.prepare(`INSERT INTO contest_score_attempts
        (attempt_id,contest_id,internal_game_id,game_id,canonical_lineup_revision_id,scoring_lineup_revision_id,
         canonical_lineup_fingerprint,job_id,claim_token,status,expected_prediction_count,expected_test_count,
         scoring_revision_id,scoring_revision_number,actual_lineup_json,created_at)
        VALUES (?,'score-contest-f','score-shared','score-shared',?,?, 'fp',?,?,'staging',0,0,'score-contest-f:score:1',1,'[]',?)`),
      attemptId, canonical, scoring, jobId, token, now);
    }

    assert.throws(() => database.prepare(`INSERT INTO contest_score_attempt_prediction_rows
      (attempt_id,contest_id,prediction_id,outcome,validity_status,total_score,max_score)
      VALUES ('score-contest-f:attempt','score-contest-f','score-contest-m:prediction','scored','valid',20,99)`)
      .run(), /SCORE_ATTEMPT_CONTEST_MISMATCH/);

    assertNoWrite("contest_ranking_reflection_revisions", database.prepare(`INSERT INTO contest_ranking_reflection_revisions
      (id,contest_id,internal_game_id,scoring_revision_id,ranking_eligibility_version,ranking_update_revision,status,created_at)
      VALUES ('bad-reflection','score-contest-f','score-shared','score-contest-m:score:1',1,99,'pending',?)`), now);

    assertNoWrite("contest_game_rescore_jobs", database.prepare(`INSERT INTO contest_game_rescore_jobs
      (id,contest_id,internal_game_id,game_id,lineup_version,status,created_at,updated_at,lineup_revision_id)
      VALUES ('bad-rescore','score-contest-f','score-shared','score-shared',1,'running',?,?, 'score-contest-m:lineup:1')`), now, now);

    assertNoWrite("contest_ranking_test_predictions", database.prepare(`INSERT INTO contest_ranking_test_predictions
      (contest_id,internal_game_id,slot,prediction_json,status,lineup_revision_id,scoring_revision_id,created_at,updated_at)
      VALUES ('score-contest-f','score-shared',1,'{}','submitted','score-contest-m:lineup:1','score-contest-f:score:1',?,?)`), now, now);
  } finally { database.close(); }
});

test("0048 preserves uniquely-owned legacy score, revision, ranking, publication and rescore rows", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyThrough(db, "0047_contest_scoped_predictions_lineups.sql");
    const now = "2026-10-20T00:00:00.000Z";
    const contestId = "legacy-fighters-contest";
    db.prepare(`INSERT INTO users (id,username,username_normalized,password_hash,password_salt,password_iterations,status,role,created_at,updated_at)
      VALUES ('legacy-user','legacy-user','legacy-user','h','s',1,'active','user',?,?)`).run(now,now);
    db.prepare(`INSERT INTO games (internal_game_id,game_date,start_time,home_team,away_team,npb_game_code,game_status,is_active,created_at,updated_at)
      VALUES ('legacy-game','2026-10-19','2026-10-19T09:00:00.000Z','fighters','marines','f-m-legacy','finished',1,?,?)`).run(now,now);
    db.prepare(`INSERT INTO game_contests (contest_id,internal_game_id,target_team_key,created_at)
      VALUES (?,'legacy-game','fighters',?)`).run(contestId,now);
    db.prepare(`INSERT INTO game_lineups (id,game_id,contest_id,actual_lineup_json,lineup_fingerprint,schema_version,
      lineup_detected_at,scoring_due_at,scoring_status,scoring_attempts,created_at,updated_at,lineup_source,
      publication_status,published_at,internal_game_id,final_lineup_revision_id,finalized_at,scoring_lineup_revision_id,scoring_revision)
      VALUES ('legacy-lineup','legacy-game',?,'[]','fp',1,?,?,'scored',1,?,?,'manual','published',?,'legacy-game','legacy-game:2',?,'legacy-game:2',2)`)
      .run(contestId,now,now,now,now,now,now);
    db.prepare(`INSERT INTO game_lineup_revisions
      (game_id,version,actual_lineup_json,lineup_fingerprint,source,created_at,reason,is_current,is_final,internal_game_id,revision_id,finalized_at)
      VALUES ('legacy-game',1,'[]','fp1','manual',?,'old',0,0,'legacy-game','legacy-game:1',?),
             ('legacy-game',2,'[]','fp2','manual-revision',?,'corrected',1,1,'legacy-game','legacy-game:2',?)`).run(now,now,now,now);
    db.prepare(`INSERT INTO contest_lineup_revisions
      (contest_id,internal_game_id,game_id,version,revision_id,actual_lineup_json,lineup_fingerprint,source,created_at,reason,is_current,is_final,finalized_at)
      VALUES (?,'legacy-game','legacy-game',1,'legacy-game:1','[]','fp1','manual',?,'old',0,0,?),
             (?,'legacy-game','legacy-game',2,'legacy-game:2','[]','fp2','manual-revision',?,'corrected',1,1,?)`)
      .run(contestId,now,now,contestId,now,now);
    db.prepare(`INSERT INTO predictions
      (id,user_id,game_id,contest_id,prediction_json,schema_version,game_date,home_team,away_team,opponent_code,is_home,
       submitted_at,updated_at,status,score,max_score,scored_at,is_test_prediction,internal_game_id,scored_lineup_revision_id,
       scoring_revision,scored_by,scoring_status)
      VALUES ('legacy-prediction','legacy-user','legacy-game',?,'{}',1,'2026-10-19','fighters','marines','marines',1,
       ?,?,'scored',77,99,?,0,'legacy-game','legacy-game:2',2,'system','scored')`)
      .run(contestId,now,now,now);
    db.prepare(`INSERT INTO game_scoring_revisions
      (id,internal_game_id,game_id,revision_number,lineup_revision_id,status,reason,created_by,created_at,completed_at,is_active)
      VALUES ('legacy-score-r2','legacy-game','legacy-game',2,'legacy-game:2','completed','correction','admin',?,?,1)`)
      .run(now,now);
    db.prepare(`INSERT INTO prediction_score_revisions
      (id,prediction_id,game_id,internal_game_id,is_test_prediction,scoring_revision,lineup_revision_id,score,max_score,actual_lineup_json,scored_at,scored_by,created_at)
      VALUES ('legacy-prediction:2','legacy-prediction','legacy-game','legacy-game',0,2,'legacy-game:2',77,99,'[]',?,'system',?)`)
      .run(now,now);
    db.prepare(`INSERT INTO ranking_games
      (game_id,internal_game_id,is_ranking_eligible,ranking_eligible_at,game_status,is_test_game,created_at,updated_at,
       game_date,scored_private_at,published_at,publication_status,ranking_eligibility_status,ranking_eligibility_version,ranking_eligibility_updated_by)
      VALUES ('legacy-game','legacy-game',1,?,'scored',0,?,?,'2026-10-19',? ,?,'published','eligible',3,'admin')`)
      .run(now,now,now,now,now);
    db.prepare(`INSERT INTO ranking_reflection_revisions
      (id,internal_game_id,scoring_revision_id,ranking_eligibility_version,ranking_update_revision,status,reflected_at,created_at)
      VALUES ('legacy-reflection','legacy-game','legacy-score-r2',3,8,'reflected',?,?),
             ('legacy-excluded-reflection','legacy-game','excluded',4,9,'excluded',?,?)`).run(now,now,now,now);
    db.prepare(`INSERT INTO perfect_achievers (id,user_id,game_id,score,max_score,achieved_at,created_at)
      VALUES ('legacy-perfect','legacy-user','legacy-game',99,99,?,?)`).run(now,now);
    db.prepare(`INSERT INTO ranking_test_game_settings
      (internal_game_id,include_in_public_ranking,updated_by,created_at,updated_at)
      VALUES ('legacy-game',1,'admin',?,?)`).run(now,now);
    db.prepare(`INSERT INTO ranking_test_predictions
      (internal_game_id,slot,prediction_json,status,score,max_score,lineup_revision_id,scoring_revision_id,
       scored_at,created_at,updated_at,scored_attempt_id)
      VALUES ('legacy-game',1,'{}','scored',99,99,'legacy-game:2','legacy-score-r2',?,?,?,'legacy-attempt')`)
      .run(now,now,now);
    db.prepare(`INSERT INTO game_rescore_previews
      (id,game_id,lineup_version,created_by,reason,summary_json,expected_prediction_count,expires_at,created_at)
      VALUES ('legacy-preview','legacy-game',2,'legacy-user','fixture','{}',1,?,?)`).run(now,now);
    db.prepare(`INSERT INTO game_rescore_jobs (id,game_id,lineup_version,status,created_at,updated_at,internal_game_id,lineup_revision_id,scoring_revision)
      VALUES ('legacy-rescore-job','legacy-game',2,'completed',?,?, 'legacy-game','legacy-game:2',2)`).run(now,now);
    db.prepare(`INSERT INTO game_rescore_audits
      (id,game_id,game_date,lineup_version,reason,executed_by,executed_at,prediction_count,status,created_at,updated_at)
      VALUES ('legacy-rescore-audit','legacy-game','2026-10-19',2,'fixture','legacy-user',?,1,'completed',?,?)`).run(now,now,now);

    const before = {
      lineup: db.prepare("SELECT id,final_lineup_revision_id,scoring_revision,publication_status,published_at,updated_at FROM game_lineups WHERE id='legacy-lineup'").get(),
      prediction: db.prepare("SELECT id,score,scoring_revision,scored_lineup_revision_id,scored_at FROM predictions WHERE id='legacy-prediction'").get(),
      score: db.prepare("SELECT id,revision_number,lineup_revision_id,status,completed_at,is_active FROM game_scoring_revisions WHERE id='legacy-score-r2'").get(),
      ranking: db.prepare("SELECT game_id,game_status,published_at,publication_status,ranking_eligibility_version FROM ranking_games WHERE game_id='legacy-game'").get()
    };

    db.exec(fs.readFileSync(path.join(MIGRATIONS, A3), "utf8"));
    assert.deepEqual({ ...db.prepare("SELECT id,final_lineup_revision_id,scoring_revision,publication_status,published_at,updated_at FROM game_lineups WHERE id='legacy-lineup'").get() }, { ...before.lineup });
    assert.deepEqual({ ...db.prepare("SELECT id,score,scoring_revision,scored_lineup_revision_id,scored_at FROM predictions WHERE id='legacy-prediction'").get() }, { ...before.prediction });
    assert.deepEqual({ ...db.prepare("SELECT id,revision_number,lineup_revision_id,status,completed_at,is_active FROM contest_scoring_revisions WHERE contest_id=?").get(contestId) }, { ...before.score });
    assert.deepEqual({ ...db.prepare("SELECT internal_game_id AS game_id,game_status,published_at,publication_status,ranking_eligibility_version FROM contest_ranking_games WHERE contest_id=?").get(contestId) }, { ...before.ranking });
    assert.equal(db.prepare("SELECT lineup_revision_id FROM contest_game_rescore_jobs WHERE id='legacy-rescore-job' AND contest_id=?").get(contestId).lineup_revision_id, "legacy-game:2");
    assert.equal(db.prepare("SELECT status FROM contest_game_rescore_audits WHERE id='legacy-rescore-audit' AND contest_id=?").get(contestId).status, "completed");
    assert.equal(db.prepare("SELECT score FROM contest_prediction_score_revisions WHERE id='legacy-prediction:2' AND contest_id=?").get(contestId).score, 77);
    assert.equal(db.prepare("SELECT include_in_public_ranking FROM contest_ranking_test_game_settings WHERE contest_id=?").get(contestId).include_in_public_ranking, 1);
    assert.equal(db.prepare("SELECT score FROM contest_ranking_test_predictions WHERE contest_id=? AND slot=1").get(contestId).score, 99);
    assert.equal(db.prepare("SELECT scoring_revision_id FROM contest_ranking_reflection_revisions WHERE id=?").get(`${contestId}:legacy-excluded-reflection`).scoring_revision_id, "legacy-score-r2");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { db.close(); }
});

test("0048 migrates a partial legacy state with ranking eligibility but no scoring lineage", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyThrough(db, "0047_contest_scoped_predictions_lineups.sql");
    const now = "2026-10-20T00:00:00.000Z";
    db.prepare(`INSERT INTO games (internal_game_id,game_date,start_time,home_team,away_team,game_status,created_at,updated_at)
      VALUES ('partial-game','2026-10-20','2026-10-20T09:00:00Z','fighters','marines','scheduled',?,?)`).run(now,now);
    db.prepare(`INSERT INTO game_contests (contest_id,internal_game_id,target_team_key,created_at)
      VALUES ('partial-fighters-contest','partial-game','fighters',?)`).run(now);
    db.prepare(`INSERT INTO ranking_games
      (game_id,internal_game_id,is_ranking_eligible,game_status,is_test_game,created_at,updated_at,game_date,publication_status,
       ranking_eligibility_status,ranking_eligibility_version,ranking_eligibility_updated_by)
      VALUES ('partial-game','partial-game',1,'pending',0,?,?,'2026-10-20','pending','eligible',2,'admin:operator')`)
      .run(now,now);

    db.exec(fs.readFileSync(path.join(MIGRATIONS, A3), "utf8"));
    const row = db.prepare(`SELECT game_status,ranking_eligibility_status,ranking_eligibility_version,publication_status
      FROM contest_ranking_games WHERE contest_id='partial-fighters-contest'`).get();
    assert.deepEqual({ ...row }, {
      game_status: "pending", ranking_eligibility_status: "eligible", ranking_eligibility_version: 2, publication_status: "pending"
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM contest_scoring_revisions WHERE contest_id='partial-fighters-contest'").get().n, 0);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { db.close(); }
});

test("0048 refuses to guess legacy game-only ownership when a second contest exists", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyThrough(db, "0047_contest_scoped_predictions_lineups.sql");
    const now = "2026-10-20T00:00:00.000Z";
    db.prepare(`INSERT INTO games (internal_game_id,game_date,start_time,home_team,away_team,game_status,created_at,updated_at)
      VALUES ('ambiguous-game','2026-10-19','2026-10-19T09:00:00Z','fighters','marines','scheduled',?,?)`).run(now,now);
    db.exec(`INSERT INTO game_contests (contest_id,internal_game_id,target_team_key,created_at)
      VALUES ('ambiguous-f','ambiguous-game','fighters','${now}'),('ambiguous-m','ambiguous-game','marines','${now}')`);
    db.prepare(`INSERT INTO ranking_games (game_id,internal_game_id,is_ranking_eligible,game_status,is_test_game,created_at,updated_at,game_date,publication_status)
      VALUES ('ambiguous-game','ambiguous-game',1,'scored',0,?,?,'2026-10-19','published')`).run(now,now);
    db.exec("BEGIN");
    assert.throws(() => db.exec(fs.readFileSync(path.join(MIGRATIONS, A3), "utf8")), /CHECK constraint failed/);
    db.exec("ROLLBACK");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ranking_games WHERE game_id='ambiguous-game'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='contest_ranking_games'").get().n, 0);
  } finally { db.close(); }
});

test("0048 refuses to silently drop ambiguous legacy ranking test settings", () => {
  const db = new DatabaseSync(":memory:");
  try {
    applyThrough(db, "0047_contest_scoped_predictions_lineups.sql");
    const now = "2026-10-20T00:00:00.000Z";
    db.prepare(`INSERT INTO games (internal_game_id,game_date,start_time,home_team,away_team,game_status,created_at,updated_at)
      VALUES ('ambiguous-test-game','2026-10-19','2026-10-19T09:00:00Z','fighters','marines','scheduled',?,?)`).run(now,now);
    db.exec(`INSERT INTO game_contests (contest_id,internal_game_id,target_team_key,created_at)
      VALUES ('ambiguous-test-f','ambiguous-test-game','fighters','${now}'),('ambiguous-test-m','ambiguous-test-game','marines','${now}')`);
    db.prepare(`INSERT INTO ranking_test_game_settings
      (internal_game_id,include_in_public_ranking,updated_by,created_at,updated_at)
      VALUES ('ambiguous-test-game',1,'test',?,?)`).run(now,now);
    db.exec("BEGIN");
    assert.throws(() => db.exec(fs.readFileSync(path.join(MIGRATIONS, A3), "utf8")), /CHECK constraint failed/);
    db.exec("ROLLBACK");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ranking_test_game_settings WHERE internal_game_id='ambiguous-test-game'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='contest_ranking_games'").get().n, 0);
  } finally { db.close(); }
});
