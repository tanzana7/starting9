import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker, { getManualLineupPlayerCatalog, normalizeManualLineupInput } from "../auth-worker.js";

const GAME_ID = "11111111-1111-4111-8111-111111111111";
const SESSION = "lineup-correction-session";
const POSITIONS = ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"];

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        all: async () => ({ results: statement.all() }),
        first: async () => statement.get(),
        run: async () => ({ meta: { changes: Number(statement.run().changes || 0) } }),
        bind(...params) {
          return {
            all: async () => ({ results: statement.all(...params) }),
            first: async () => statement.get(...params),
            run: async () => ({ meta: { changes: Number(statement.run(...params).changes || 0) } })
          };
        }
      };
    },
    async batch(statements) {
      for (const statement of statements) await statement.run();
      return [];
    }
  };
}

async function hash(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
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
  return { Cookie: `s9_session=${encodeURIComponent(SESSION)}`, Origin: "https://starting9.test", "Content-Type": "application/json" };
}

async function createDb({ gameDate = "2026-09-05", state = "published", canonicalRevisionId = `${GAME_ID}:1` } = {}) {
  const database = new DatabaseSync(":memory:");
  const tokenHash = await hash(SESSION);
  const original = lineup();
  const canonicalLineup = normalizeManualLineupInput(original).lineup;
  const originalJson = JSON.stringify(canonicalLineup);
  const originalFingerprint = await hash(originalJson);
  const canonicalRevisionSql = canonicalRevisionId === null
    ? "NULL"
    : `'${String(canonicalRevisionId).replaceAll("'", "''")}'`;
  database.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, status TEXT, role TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, token_hash TEXT, created_at TEXT, expires_at TEXT, last_used_at TEXT);
    CREATE TABLE games (internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT, home_team TEXT, away_team TEXT, npb_game_code TEXT, game_status TEXT, is_active INTEGER, deleted_at TEXT);
    CREATE TABLE game_automation_v3_state (internal_game_id TEXT PRIMARY KEY, state TEXT, version INTEGER, prediction_closed_at TEXT, lineup_finalized_at TEXT, scoring_revision_id TEXT, ranked_at TEXT, published_at TEXT, excluded_at TEXT, failure_code TEXT, failure_message TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE game_lineups (id TEXT PRIMARY KEY, game_id TEXT UNIQUE, internal_game_id TEXT UNIQUE, actual_lineup_json TEXT, lineup_fingerprint TEXT, schema_version INTEGER, lineup_detected_at TEXT, scoring_due_at TEXT, scoring_started_at TEXT, scored_at TEXT, scoring_status TEXT, scoring_attempts INTEGER, last_error TEXT, processed_predictions INTEGER, perfect_count INTEGER, new_perfect_achievers INTEGER, lineup_source TEXT, publication_status TEXT, published_at TEXT, final_lineup_revision_id TEXT, finalized_at TEXT, finalized_by TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE game_lineup_revisions (game_id TEXT, version INTEGER, revision_id TEXT, internal_game_id TEXT, actual_lineup_json TEXT, lineup_fingerprint TEXT, source TEXT, created_at TEXT, captured_at TEXT, created_by INTEGER, reason TEXT, is_current INTEGER, superseded_at TEXT, validation_json TEXT, unresolved_player_count INTEGER, is_final INTEGER, finalized_at TEXT, finalized_by TEXT, PRIMARY KEY (game_id, version));
    CREATE TABLE ranking_games (game_id TEXT PRIMARY KEY, internal_game_id TEXT, game_date TEXT, is_ranking_eligible INTEGER, ranking_eligible_at TEXT, game_status TEXT, is_test_game INTEGER, publication_status TEXT, scored_private_at TEXT, published_at TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE predictions (id TEXT PRIMARY KEY, internal_game_id TEXT, payload TEXT);
    CREATE TABLE game_jobs_v3 (id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT, job_type TEXT, scheduled_at TEXT, scheduled_slot_at TEXT, status TEXT, attempt_count INTEGER, max_attempts INTEGER, next_retry_at TEXT, claimed_at TEXT, claim_token TEXT, lease_expires_at TEXT, completed_at TEXT, failure_code TEXT, failure_message TEXT, created_at TEXT, updated_at TEXT, UNIQUE(internal_game_id, job_type, scheduled_slot_at));
    CREATE TABLE game_automation_v3_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT, job_id INTEGER, job_type TEXT, state_before TEXT, state_after TEXT, attempt_count INTEGER, failure_code TEXT, failure_message TEXT, occurred_at TEXT, source TEXT);
    CREATE TABLE game_workflow_logs (id TEXT PRIMARY KEY, event_type TEXT, status TEXT, game_id TEXT, occurred_at TEXT, message TEXT, error_code TEXT, metadata TEXT, source TEXT);
    INSERT INTO users VALUES ('1', 'operator', 'active', 'admin');
    INSERT INTO sessions VALUES ('session-1', '1', '${tokenHash}', '2026-09-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    INSERT INTO games VALUES ('${GAME_ID}', '${gameDate}', '${gameDate}T09:00:00+09:00', 'fighters', 'hawks', 'f-h-22', 'scheduled', 1, NULL);
    INSERT INTO game_automation_v3_state VALUES ('${GAME_ID}', '${state}', 3, NULL, '2026-09-05T01:00:00.000Z', 'old-score', '2026-09-05T02:00:00.000Z', 'old-score', NULL, NULL, NULL, '2026-09-01T00:00:00.000Z', '2026-09-05T03:00:00.000Z');
    INSERT INTO game_lineups VALUES ('lineup-1', '${GAME_ID}', '${GAME_ID}', '${originalJson.replaceAll("'", "''")}', '${originalFingerprint}', 1, '2026-09-05T01:00:00.000Z', NULL, NULL, '2026-09-05T02:00:00.000Z', 'scored', 1, NULL, 10, 1, 0, 'manual', 'published', '2026-09-05T03:00:00.000Z', ${canonicalRevisionSql}, '2026-09-05T01:00:00.000Z', 'admin', '2026-09-05T01:00:00.000Z', '2026-09-05T03:00:00.000Z');
    INSERT INTO game_lineup_revisions VALUES ('${GAME_ID}', 1, '${GAME_ID}:1', '${GAME_ID}', '${originalJson.replaceAll("'", "''")}', '${originalFingerprint}', 'manual-revision', '2026-09-05T01:00:00.000Z', '2026-09-05T01:00:00.000Z', 1, 'initial', 1, NULL, '{"ok":true}', 0, 1, '2026-09-05T01:00:00.000Z', 'admin');
    INSERT INTO ranking_games VALUES ('${GAME_ID}', '${GAME_ID}', '${gameDate}', 1, '2026-09-05T02:00:00.000Z', 'scored', 0, 'published', '2026-09-05T02:00:00.000Z', '2026-09-05T03:00:00.000Z', '2026-09-01T00:00:00.000Z', '2026-09-05T03:00:00.000Z');
    INSERT INTO predictions VALUES ('prediction-1', '${GAME_ID}', 'unchanged-prediction');
  `);
  return { database, env: { AUTH_DB: d1(database), AUTH_ALLOWED_ORIGINS: "https://starting9.test" }, original };
}

async function adminRequest(env, pathname, body) {
  return worker.fetch(new Request(`https://starting9.test${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: requestHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body)
  }), env, {});
}

test("スタメン修正はcanonical finalを読み取り、一覧・詳細で処理状態を表示する", async () => {
  const { env } = await createDb();
  const listResponse = await adminRequest(env, "/api/admin/v3/lineup-corrections");
  const list = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.equal(list.games.length, 1);
  assert.equal(list.games[0].canonicalRevision.revisionId, `${GAME_ID}:1`);
  const detailResponse = await adminRequest(env, `/api/admin/v3/games/${GAME_ID}/lineup-correction`);
  const detail = await detailResponse.json();
  assert.equal(detailResponse.status, 200);
  assert.equal(detail.canonicalRevision.revisionId, `${GAME_ID}:1`);
  assert.equal(detail.readOnlyStatuses.publicationStatus, "published");
  assert.equal(detail.playerCatalog.length > 9, true);
});

test("canonical不備の過去試合は一覧から消さず、修正不可理由をread-only表示する", async () => {
  const { env } = await createDb({ canonicalRevisionId: null });
  const response = await adminRequest(env, "/api/admin/v3/lineup-corrections");
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.games.length, 1);
  assert.equal(payload.games[0].correctionAvailable, false);
  assert.match(payload.games[0].correctionUnavailableReason, /canonical final lineup revision/);
});

test("スタメン修正は新revisionを保持し、予想を触らず、正式score jobだけへ引き継ぐ", async () => {
  const { env, original } = await createDb();
  const corrected = original.map((row, index) => index === 0 ? { ...row, playerId: getManualLineupPlayerCatalog()[9].playerId, playerName: getManualLineupPlayerCatalog()[9].playerName, uniformNumber: String(getManualLineupPlayerCatalog()[9].uniformNumber) } : row);
  const response = await adminRequest(env, `/api/admin/v3/games/${GAME_ID}/lineup-correction`, { lineup: corrected, reason: "公式訂正を反映", confirmed: true });
  const payload = await response.json();
  assert.equal(response.status, 202);
  assert.equal(payload.stateAfter, "manual_action_required");
  assert.equal(payload.scoreJob.job.job_type, "score");
  assert.equal(payload.nextAction, "formal_v3_cron_score_ranking_reflect_publish");
  const revisions = env.AUTH_DB.prepare("SELECT version, is_final, is_current FROM game_lineup_revisions WHERE internal_game_id = ?1 ORDER BY version").bind(GAME_ID);
  const revisionRows = (await revisions.all()).results;
  assert.equal(revisionRows.length, 2);
  assert.deepEqual(revisionRows.map((row) => [row.version, row.is_final, row.is_current]), [[1, 0, 0], [2, 1, 1]]);
  const canonical = await env.AUTH_DB.prepare("SELECT final_lineup_revision_id, scoring_status, publication_status FROM game_lineups WHERE internal_game_id = ?1").bind(GAME_ID).first();
  assert.equal(canonical.final_lineup_revision_id, `${GAME_ID}:2`);
  assert.equal(canonical.scoring_status, "pending");
  assert.equal(canonical.publication_status, "pending");
  const state = await env.AUTH_DB.prepare("SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?1").bind(GAME_ID).first();
  assert.equal(state.state, "manual_action_required");
  const jobs = (await env.AUTH_DB.prepare("SELECT job_type FROM game_jobs_v3 WHERE internal_game_id = ?1").bind(GAME_ID).all()).results;
  assert.deepEqual(jobs.map((job) => job.job_type), ["score"]);
  assert.equal((await env.AUTH_DB.prepare("SELECT payload FROM predictions WHERE id = 'prediction-1'").first()).payload, "unchanged-prediction");
  const duplicate = await adminRequest(env, `/api/admin/v3/games/${GAME_ID}/lineup-correction`, { lineup: corrected, reason: "同じ公式訂正の再送", confirmed: true });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).code, "V3_LINEUP_CORRECTION_NO_OP");
});

test("同じ修正の再送はno-op、未来試合と確認なしは拒否し、normal finalizeロックを緩めない", async () => {
  const { env, original } = await createDb();
  const noOp = await adminRequest(env, `/api/admin/v3/games/${GAME_ID}/lineup-correction`, { lineup: original, reason: "変更確認", confirmed: true });
  assert.equal(noOp.status, 409);
  assert.equal((await noOp.json()).code, "V3_LINEUP_CORRECTION_NO_OP");
  const noConfirm = await adminRequest(env, `/api/admin/v3/games/${GAME_ID}/lineup-correction`, { lineup: original, reason: "変更確認" });
  assert.equal(noConfirm.status, 409);
  assert.equal((await noConfirm.json()).code, "V3_LINEUP_CORRECTION_CONFIRMATION_REQUIRED");
  const futureDb = await createDb({ gameDate: "2099-01-01" });
  const future = await adminRequest(futureDb.env, `/api/admin/v3/games/${GAME_ID}/lineup-correction`, { lineup: futureDb.original.map((row, index) => index === 0 ? { ...row, position: "指" } : row), reason: "未来確認", confirmed: true });
  assert.equal(future.status, 409);
  assert.equal((await future.json()).code, "V3_LINEUP_CORRECTION_FUTURE_GAME");
  const normalFinalize = await adminRequest(env, `/api/admin/v3/games/${GAME_ID}/lineup-finalize`, { lineupRevisionId: `${GAME_ID}:1`, confirmed: true });
  assert.equal(normalFinalize.status, 409);
});
