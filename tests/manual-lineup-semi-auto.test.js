import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../auth-worker.js";
import {
  getManualLineupPlayerCatalog,
  getManualLineupFinalizeDecision,
  isManualLineupEditAllowed,
  normalizeManualLineupInput
} from "../auth-worker.js";
import { buildStagePlan, buildV3PlanningState } from "../backend/automation-v3/planning-engine.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerSource = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const uiSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-manual-lineup.js"), "utf8");
const progressSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-game-progress.js"), "utf8");
const adminSource = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");

const INTEGRATION_GAME_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_TOKEN = "manual-lineup-integration-session";

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      const bound = (...params) => ({
        all: async () => ({ results: statement.all(...params) }),
        first: async () => statement.get(...params),
        run: async () => {
          const result = statement.run(...params);
          return { meta: { changes: Number(result.changes || 0) } };
        }
      });
      return {
        all: async () => ({ results: statement.all() }),
        first: async () => statement.get(),
        run: async () => {
          const result = statement.run();
          return { meta: { changes: Number(result.changes || 0) } };
        },
        bind(...params) { return bound(...params); }
      };
    },
    async batch(statements) {
      for (const statement of statements) await statement.run();
      return [];
    }
  };
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function currentJstDate() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  return parts.filter((part) => part.type !== "literal").map((part) => part.value).join("-");
}

function jstDateOffset(days) {
  const date = new Date(`${currentJstDate()}T12:00:00+09:00`);
  date.setUTCDate(date.getUTCDate() + days);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  return parts.filter((part) => part.type !== "literal").map((part) => part.value).join("-");
}

async function createManualLineupIntegrationDb({ role = "admin", state = "scheduled", gameStatus = "scheduled", gameDate = currentJstDate(), startTime = `${gameDate}T09:00:00+09:00` } = {}) {
  const database = new DatabaseSync(":memory:");
  const tokenHash = await sha256Base64Url(SESSION_TOKEN);
  database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT, status TEXT, role TEXT,
      password_hash TEXT, password_salt TEXT, password_iterations INTEGER,
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, user_id TEXT, token_hash TEXT, created_at TEXT,
      expires_at TEXT, last_used_at TEXT
    );
    CREATE TABLE games (
      internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
      home_team TEXT, away_team TEXT, npb_game_code TEXT, game_status TEXT,
      is_active INTEGER, deleted_at TEXT, npb_identity_status TEXT,
      npb_identity_resolved_at TEXT, npb_identity_source TEXT,
      stadium TEXT, npb_game_url TEXT, source_schedule_key TEXT,
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE game_identifiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
      provider TEXT, identifier_type TEXT, identifier_value TEXT,
      updated_at TEXT
    );
    CREATE TABLE game_automation_v3_state (
      internal_game_id TEXT PRIMARY KEY, state TEXT, version INTEGER,
      prediction_closed_at TEXT, lineup_finalized_at TEXT, scoring_revision_id TEXT,
      ranked_at TEXT, published_at TEXT, excluded_at TEXT, failure_code TEXT,
      failure_message TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE game_lineups (
      id TEXT PRIMARY KEY, game_id TEXT UNIQUE, internal_game_id TEXT UNIQUE,
      actual_lineup_json TEXT, lineup_fingerprint TEXT, schema_version INTEGER,
      lineup_detected_at TEXT, scoring_due_at TEXT, scoring_started_at TEXT,
      scored_at TEXT, scoring_status TEXT, scoring_attempts INTEGER,
      last_error TEXT, processed_predictions INTEGER, perfect_count INTEGER,
      new_perfect_achievers INTEGER, lineup_source TEXT, publication_status TEXT,
      published_at TEXT, final_lineup_revision_id TEXT, finalized_at TEXT,
      finalized_by TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE game_lineup_revisions (
      game_id TEXT, version INTEGER, revision_id TEXT, internal_game_id TEXT,
      actual_lineup_json TEXT, lineup_fingerprint TEXT, source TEXT,
      created_at TEXT, captured_at TEXT, created_by INTEGER, reason TEXT,
      is_current INTEGER, superseded_at TEXT, validation_json TEXT,
      unresolved_player_count INTEGER, is_final INTEGER, finalized_at TEXT,
      finalized_by TEXT, PRIMARY KEY (game_id, version)
    );
    CREATE TABLE ranking_games (
      game_id TEXT PRIMARY KEY, internal_game_id TEXT, game_date TEXT,
      is_ranking_eligible INTEGER, ranking_eligible_at TEXT, game_status TEXT,
      is_test_game INTEGER, publication_status TEXT, scored_private_at TEXT,
      published_at TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE game_workflow_logs (
      id TEXT PRIMARY KEY, event_type TEXT, status TEXT, game_id TEXT,
      occurred_at TEXT, message TEXT, error_code TEXT, metadata TEXT, source TEXT
    );
    CREATE TABLE game_automation_v3_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT, job_id INTEGER,
      job_type TEXT, state_before TEXT, state_after TEXT, attempt_count INTEGER,
      failure_code TEXT, failure_message TEXT, occurred_at TEXT, source TEXT
    );
    CREATE TABLE game_jobs_v3 (
      id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT, job_type TEXT,
      scheduled_at TEXT, scheduled_slot_at TEXT, status TEXT, attempt_count INTEGER,
      max_attempts INTEGER, next_retry_at TEXT, claimed_at TEXT, claim_token TEXT,
      lease_expires_at TEXT, completed_at TEXT, failure_code TEXT,
      failure_message TEXT, created_at TEXT, updated_at TEXT
    );
    INSERT INTO users (id, username, status, role) VALUES ('1', 'operator', 'active', '${role}');
    INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_used_at)
      VALUES ('session-1', '1', '${tokenHash}', '2026-09-02T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z');
    INSERT INTO games (internal_game_id, game_date, start_time, home_team, away_team, npb_game_code,
      game_status, is_active, deleted_at, npb_identity_status, created_at, updated_at)
      VALUES ('${INTEGRATION_GAME_ID}', '${gameDate}', '${startTime}', 'fighters', 'hawks',
      'f-h-22', '${gameStatus}', 1, NULL, 'resolved', '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z');
    INSERT INTO game_identifiers (internal_game_id, provider, identifier_type, identifier_value, updated_at)
      VALUES ('${INTEGRATION_GAME_ID}', 'npb', 'npb_game_code', 'f-h-22', '2026-09-02T00:00:00.000Z');
    INSERT INTO game_automation_v3_state (internal_game_id, state, version, created_at, updated_at)
      VALUES ('${INTEGRATION_GAME_ID}', '${state}', 0, '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z');
  `);
  return { database, env: { AUTH_DB: d1(database), AUTH_ALLOWED_ORIGINS: "https://starting9.test" } };
}

function adminHeaders() {
  return { Cookie: `s9_session=${encodeURIComponent(SESSION_TOKEN)}`, Origin: "https://starting9.test", "Content-Type": "application/json" };
}

async function adminRequest(env, pathname, body, headers = adminHeaders()) {
  return worker.fetch(new Request(`https://starting9.test${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  }), env, {});
}

function validManualLineup() {
  const positions = ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"];
  return getManualLineupPlayerCatalog().slice(0, 9).map((player, index) => ({
    playerName: player.playerName,
    uniformNumber: player.uniformNumber,
    position: positions[index],
    battingOrder: index + 1
  }));
}

test("manual lineupはFightersマスターから1チーム9人をcanonical化する", () => {
  const result = normalizeManualLineupInput(validManualLineup());
  assert.equal(result.ok, true);
  assert.equal(result.lineup.length, 9);
  assert.equal(new Set(result.lineup.map((row) => row.playerId)).size, 9);
  assert.ok(result.lineup.every((row) => row.teamCode === "fighters" && row.teamId === "F" && row.resolutionStatus === "resolved"));
});

test("manual lineupは9人未満・未知選手・重複・不正守備位置を拒否する", () => {
  const base = validManualLineup();
  for (const input of [base.slice(0, 8), [...base, { ...base[0], battingOrder: 10 }]]) {
    assert.equal(normalizeManualLineupInput(input).ok, false);
  }
  assert.equal(normalizeManualLineupInput(base.map((row, index) => index === 8 ? { ...row, playerName: "存在しない選手" } : row)).ok, false);
  assert.equal(normalizeManualLineupInput(base.map((row, index) => index === 8 ? { ...row, playerName: base[0].playerName } : row)).ok, false);
  assert.equal(normalizeManualLineupInput(base.map((row, index) => index === 8 ? { ...row, position: "投" } : row)).ok, false);
  assert.equal(normalizeManualLineupInput(base.map((row, index) => index === 8 ? { ...row, battingOrder: 1 } : row)).ok, false);
});

test("manual lineupはcanonical finalがある場合だけ採点開始後の通常変更を拒否する", () => {
  const base = validManualLineup();
  assert.equal(normalizeManualLineupInput(base.map((row, index) => index === 0 ? { ...row, uniformNumber: "999" } : row)).ok, false);
  assert.equal(normalizeManualLineupInput(base.map((row, index) => index === 0 ? { ...row, playerId: "H-1" } : row)).ok, false);
  assert.equal(isManualLineupEditAllowed({ workflowState: "prediction_closed", scoringStatus: "pending" }), true);
  assert.equal(isManualLineupEditAllowed({ workflowState: "scored", scoringStatus: "pending", canonicalFinalLineupExists: false }), true);
  assert.equal(isManualLineupEditAllowed({ workflowState: "scored", scoringStatus: "pending", canonicalFinalLineupExists: true }), false);
  assert.equal(isManualLineupEditAllowed({ workflowState: "lineup_ready", scoringStatus: "processing", canonicalFinalLineupExists: false }), true);
  assert.equal(isManualLineupEditAllowed({ workflowState: "ranked", scoringStatus: "scored", canonicalFinalLineupExists: true }), false);
  assert.equal(isManualLineupEditAllowed({ workflowState: "excluded", canonicalFinalLineupExists: false }), false);
  assert.equal(isManualLineupEditAllowed({ workflowState: "scheduled", gameStatus: "postponed", canonicalFinalLineupExists: false }), false);
});

test("manual lineup finalizeは未来日と予想締切前を拒否し、当日・過去の締切後を許可する", () => {
  const now = new Date("2026-09-04T08:30:00.000Z");
  const future = getManualLineupFinalizeDecision({ gameDate: "2026-09-08", startAt: "2026-09-08T09:00:00.000Z", now });
  assert.equal(future.allowed, false);
  assert.equal(future.code, "V3_MANUAL_LINEUP_FINALIZE_NOT_TODAY");
  const beforeDeadline = getManualLineupFinalizeDecision({ gameDate: "2026-09-04", startAt: "2026-09-04T09:00:00.000Z", now: new Date("2026-09-04T07:30:00.000Z") });
  assert.equal(beforeDeadline.allowed, false);
  assert.equal(beforeDeadline.code, "V3_MANUAL_LINEUP_FINALIZE_NOT_DUE");
  const allowed = getManualLineupFinalizeDecision({ gameDate: "2026-09-04", startAt: "2026-09-04T09:00:00.000Z", now });
  assert.equal(allowed.allowed, true);
  const past = getManualLineupFinalizeDecision({ gameDate: "2026-09-03", startAt: "2026-09-03T09:00:00.000Z", now });
  assert.equal(past.allowed, true);
});

test("手動確定済みartifactはlineup_fetchを抑止し、正式Cronのscoreへ継続できる", () => {
  const game = {
    internalGameId: "11111111-1111-4111-8111-111111111111",
    gameDate: "2026-09-02",
    startAt: "2026-09-02T09:00:00.000Z",
    npbGameCode: "f-h-22",
    npbIdentityStatus: "resolved",
    gameStatus: "scheduled"
  };
  const planningState = buildV3PlanningState({
    game,
    persistedState: "prediction_closed",
    now: new Date("2026-09-02T09:05:00.000Z"),
    artifacts: {
      lineup_fetch: { available: true, ready: true, candidateExists: true, finalizedLineupExists: true, finalizedValid: true },
      lineup_finalize: { available: true, ready: true, valid: true },
      scoring: { available: false, ready: false }
    }
  });
  const lineupFetch = buildStagePlan(planningState, "lineup_fetch");
  const lineupFinalize = buildStagePlan(planningState, "lineup_finalize");
  const score = buildStagePlan(planningState, "scoring");
  assert.equal(lineupFetch.artifactReady, true);
  assert.equal(lineupFetch.shouldCreateJob, false);
  assert.equal(lineupFinalize.shouldCreateJob, false);
  assert.equal(score.shouldCreateJob, true);
});

test("manual finalize後は既存V3 Cronのscore→ranking→publish契約へ接続できる", () => {
  const game = {
    internalGameId: INTEGRATION_GAME_ID,
    gameDate: "2026-09-02",
    startAt: "2026-09-02T09:00:00.000Z",
    npbGameCode: "f-h-22",
    npbIdentityStatus: "resolved",
    gameStatus: "scheduled"
  };
  const score = buildStagePlan(buildV3PlanningState({
    game,
    persistedState: "prediction_closed",
    effectiveState: "prediction_closed",
    now: new Date("2026-09-02T09:05:00.000Z"),
    artifacts: { lineup_finalize: { available: true, ready: true, valid: true, finalizedValid: true } }
  }), "scoring");
  assert.equal(score.shouldCreateJob, true);
  const beforePublication = buildStagePlan(buildV3PlanningState({
    game,
    persistedState: "scored",
    now: new Date("2026-09-02T09:09:00.000Z")
  }), "ranking_reflect");
  assert.equal(beforePublication.shouldCreateJob, false);
  const ranking = buildStagePlan(buildV3PlanningState({
    game,
    persistedState: "scored",
    now: new Date("2026-09-02T09:10:00.000Z")
  }), "ranking_reflect");
  assert.equal(ranking.shouldCreateJob, true);
  const publish = buildStagePlan(buildV3PlanningState({
    game,
    persistedState: "ranked",
    now: new Date("2026-09-02T09:11:00.000Z")
  }), "publish");
  assert.equal(publish.shouldCreateJob, true);
});

test("手動スタメンはjob投入なしで保存・確定し、自動取得保護とモバイルUIを持つ", () => {
  assert.match(workerSource, /normalizeManualLineupInput\(input\?\.lineup \|\| input\?\.actualLineup\)/);
  assert.equal((workerSource.match(/input\?\.confirmed !== true/g) || []).length >= 2, true);
  assert.match(workerSource, /nextAction: "formal_cron_score"/);
  assert.match(workerSource, /manualLineupProtected: true/);
  assert.doesNotMatch(workerSource.slice(workerSource.indexOf("async function handleAdminV3LineupFinalize"), workerSource.indexOf("function v3RescoreBody")), /createV3AdminActionJob/);
  assert.match(uiSource, /manual-lineup-grid/);
  assert.match(uiSource, /data-v3-manual-lineup-search/);
  assert.match(uiSource, /data-v3-manual-lineup-finalize/);
  assert.doesNotMatch(uiSource, /<input[^>]+playerId/i);
  assert.match(adminSource, /saveManualLineup: saveV3ManualLineup/);
  assert.match(adminSource, /confirmationFingerprint/);
  assert.match(adminSource, /resetManualLineupConfirmation/);
  assert.match(adminSource, /finalizeManualLineup: finalizeV3ManualLineup/);
  assert.match(htmlSource, /render-manual-lineup\.js/);
  assert.match(workerSource, /V3_MANUAL_LINEUP_FINALIZE_NOT_TODAY/);
  assert.match(workerSource, /V3_MANUAL_LINEUP_FINALIZE_NOT_DUE/);
  assert.match(adminSource, /selectionValidated/);
  assert.match(adminSource, /selectionSafetyNotice/);
  assert.match(uiSource, /manual-lineup-target/);
  assert.match(uiSource, /manual-lineup-confirmation-list/);
  assert.match(uiSource, /manual-lineup-confirmation-row/);
  assert.match(uiSource, /manual-lineup-duplicate-warning/);
  assert.match(uiSource, /data-v3-manual-lineup-preview/);
  assert.doesNotMatch(uiSource, /試合日・対戦相手・スタメン内容を確認しました/);
  assert.match(uiSource, /この内容でスタメンを確定/);
});

test("manual lineupのsave/finalize APIは実handler経由で保存し、score jobを直接投入しない", async () => {
  const integration = await createManualLineupIntegrationDb();
  try {
    const path = `/api/admin/v3/games/${INTEGRATION_GAME_ID}`;
    const save = await adminRequest(integration.env, `${path}/lineup-revisions`, {
      lineup: validManualLineup(),
      reason: "公式発表を確認",
      confirmed: true
    });
    const saveBody = await save.json();
    assert.equal(save.status, 201, JSON.stringify(saveBody));
    assert.equal(saveBody.ok, true);
    assert.equal(saveBody.revision.source, "manual-revision");
    assert.equal(saveBody.revision.lineup.length, 9);
    assert.deepEqual(saveBody.revision.lineup.map((row) => row.battingOrder), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.ok(saveBody.revision.lineup.every((row) => row.playerId && row.position));

    const stored = integration.database.prepare(
      "SELECT source, actual_lineup_json, reason, created_by, validation_json FROM game_lineup_revisions WHERE game_id = ?1"
    ).get(INTEGRATION_GAME_ID);
    assert.equal(stored.source, "manual-revision");
    assert.equal(JSON.parse(stored.actual_lineup_json).length, 9);
    assert.equal(stored.reason, "公式発表を確認");
    assert.equal(stored.created_by, 1);
    assert.equal(JSON.parse(stored.validation_json).source, "manual");

    const finalize = await adminRequest(integration.env, `${path}/lineup-finalize`, {
      lineupRevisionId: saveBody.revision.revisionId,
      reason: "公式発表を再確認して確定",
      confirmed: true
    });
    const finalizeBody = await finalize.json();
    assert.equal(finalize.status, 200, JSON.stringify(finalizeBody));
    assert.equal(finalizeBody.ok, true);
    assert.equal(finalizeBody.finalizedRevision.isFinal, true);
    assert.equal(finalizeBody.finalizedRevision.source, "manual-revision");
    assert.equal(finalizeBody.scoreJob, null);
    assert.equal(finalizeBody.nextAction, "formal_cron_score");
    assert.equal(integration.database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3").get().count, 0);
    assert.equal(integration.database.prepare("SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?1").get(INTEGRATION_GAME_ID).state, "scheduled");
    assert.equal(integration.database.prepare("SELECT scoring_status, lineup_source FROM game_lineups WHERE internal_game_id = ?1").get(INTEGRATION_GAME_ID).lineup_source, "manual");
  } finally {
    integration.database.close();
  }
});

test("manual lineup finalizeは開始後でもcanonical未登録なら許可する", async () => {
  const gameDate = currentJstDate();
  const integration = await createManualLineupIntegrationDb({
    state: "prediction_closed",
    gameDate,
    startTime: `${gameDate}T00:00:00+09:00`
  });
  try {
    const path = `/api/admin/v3/games/${INTEGRATION_GAME_ID}`;
    const save = await adminRequest(integration.env, `${path}/lineup-revisions`, { lineup: validManualLineup(), confirmed: true });
    assert.equal(save.status, 201);
    const saved = await save.json();
    const finalize = await adminRequest(integration.env, `${path}/lineup-finalize`, {
      lineupRevisionId: saved.revision.revisionId,
      version: saved.revision.version,
      confirmed: true
    });
    const body = await finalize.json();
    assert.equal(finalize.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.finalizedRevision.isFinal, true);
    assert.ok(integration.database.prepare("SELECT final_lineup_revision_id FROM game_lineups WHERE internal_game_id = ?1").get(INTEGRATION_GAME_ID).final_lineup_revision_id);
  } finally {
    integration.database.close();
  }
});

test("manual lineup finalizeは過去の正常試合でもcanonical未登録なら許可する", async () => {
  const gameDate = jstDateOffset(-1);
  const integration = await createManualLineupIntegrationDb({
    state: "prediction_closed",
    gameDate,
    startTime: `${gameDate}T09:00:00+09:00`
  });
  try {
    const path = `/api/admin/v3/games/${INTEGRATION_GAME_ID}`;
    const save = await adminRequest(integration.env, `${path}/lineup-revisions`, { lineup: validManualLineup(), confirmed: true });
    assert.equal(save.status, 201);
    const saved = await save.json();
    const finalize = await adminRequest(integration.env, `${path}/lineup-finalize`, {
      lineupRevisionId: saved.revision.revisionId,
      version: saved.revision.version,
      confirmed: true
    });
    const body = await finalize.json();
    assert.equal(finalize.status, 200, JSON.stringify(body));
    assert.equal(body.finalizedRevision.isFinal, true);
  } finally {
    integration.database.close();
  }
});

test("published stale stateでもcanonical final未登録ならmanual lineup登録を許可する", async () => {
  const integration = await createManualLineupIntegrationDb({ state: "published", gameStatus: "completed" });
  try {
    const response = await adminRequest(integration.env, `/api/admin/v3/games/${INTEGRATION_GAME_ID}/lineup-revisions`, { lineup: validManualLineup(), confirmed: true });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    assert.equal(body.ok, true);
  } finally {
    integration.database.close();
  }
});

test("manual lineupはcancelled・postponed・excluded試合への登録を拒否する", async () => {
  for (const gameStatus of ["cancelled", "postponed"]) {
    const integration = await createManualLineupIntegrationDb({ gameStatus, state: "prediction_closed" });
    try {
      const response = await adminRequest(integration.env, `/api/admin/v3/games/${INTEGRATION_GAME_ID}/lineup-revisions`, { lineup: validManualLineup(), confirmed: true });
      assert.equal(response.status, 409, gameStatus);
      assert.equal(integration.database.prepare("SELECT COUNT(*) AS count FROM game_lineup_revisions").get().count, 0);
    } finally {
      integration.database.close();
    }
  }
  const excluded = await createManualLineupIntegrationDb({ state: "excluded" });
  try {
    const response = await adminRequest(excluded.env, `/api/admin/v3/games/${INTEGRATION_GAME_ID}/lineup-revisions`, { lineup: validManualLineup(), confirmed: true });
    assert.equal(response.status, 409, "excluded");
    assert.equal(excluded.database.prepare("SELECT COUNT(*) AS count FROM game_lineup_revisions").get().count, 0);
  } finally {
    excluded.database.close();
  }
});

test("manual lineupは入力理由なしで保存でき、未来scheduledのmanual revisionだけを安全に取消できる", async () => {
  const futureGameDate = jstDateOffset(1);
  const integration = await createManualLineupIntegrationDb({ gameDate: futureGameDate, startTime: `${futureGameDate}T09:00:00+09:00` });
  try {
    const path = `/api/admin/v3/games/${INTEGRATION_GAME_ID}`;
    const save = await adminRequest(integration.env, `${path}/lineup-revisions`, { lineup: validManualLineup(), confirmed: true });
    assert.equal(save.status, 201);
    const saved = await save.json();
    integration.database.prepare("UPDATE game_lineup_revisions SET is_current = 1, is_final = 1 WHERE game_id = ?1 AND version = ?2").run(INTEGRATION_GAME_ID, saved.revision.version);
    integration.database.prepare("INSERT INTO game_lineups (id, game_id, internal_game_id, actual_lineup_json, lineup_fingerprint, scoring_status, lineup_source, publication_status, final_lineup_revision_id) VALUES ('lineup-1', ?1, ?1, ?2, ?3, 'pending', 'manual', 'pending', ?4)").run(INTEGRATION_GAME_ID, JSON.stringify(validManualLineup()), saved.revision.lineupFingerprint || "", saved.revision.revisionId);
    const cancel = await adminRequest(integration.env, `${path}/lineup-revisions/${encodeURIComponent(saved.revision.revisionId)}/cancel`, { confirmed: true, confirmationText: "CANCEL_MANUAL_LINEUP_REVISION" });
    const body = await cancel.json();
    assert.equal(cancel.status, 200, JSON.stringify(body));
    assert.equal(body.canonicalInvalidated, true);
    const revision = integration.database.prepare("SELECT is_current, is_final, superseded_at FROM game_lineup_revisions WHERE game_id = ?1 AND version = ?2").get(INTEGRATION_GAME_ID, saved.revision.version);
    assert.equal(revision.is_current, 0);
    assert.equal(revision.is_final, 0);
    assert.ok(revision.superseded_at);
    const canonical = integration.database.prepare("SELECT actual_lineup_json, lineup_source, scoring_status, final_lineup_revision_id FROM game_lineups WHERE internal_game_id = ?1").get(INTEGRATION_GAME_ID);
    assert.equal(canonical.actual_lineup_json, "[]");
    assert.equal(canonical.lineup_source, "manual-invalidated");
    assert.equal(canonical.scoring_status, "pending");
    assert.equal(canonical.final_lineup_revision_id, null);
  } finally {
    integration.database.close();
  }
});

test("manual lineup finalizeは別日のfuture gameをDB変更なしで拒否する", async () => {
  const futureGameDate = jstDateOffset(1);
  const integration = await createManualLineupIntegrationDb({ gameDate: futureGameDate, startTime: `${futureGameDate}T09:00:00+09:00` });
  try {
    const path = `/api/admin/v3/games/${INTEGRATION_GAME_ID}`;
    const save = await adminRequest(integration.env, `${path}/lineup-revisions`, {
      lineup: validManualLineup(), reason: "公式発表を確認", confirmed: true
    });
    assert.equal(save.status, 201);
    const savedBody = await save.json();
    const finalize = await adminRequest(integration.env, `${path}/lineup-finalize`, {
      lineupRevisionId: savedBody.revision.revisionId, version: savedBody.revision.version, reason: "対象日を確認", confirmed: true
    });
    const body = await finalize.json();
    assert.equal(finalize.status, 409);
    assert.equal(body.code, "V3_MANUAL_LINEUP_FINALIZE_NOT_TODAY");
    assert.equal(integration.database.prepare("SELECT COUNT(*) AS count FROM game_lineups").get().count, 0);
    assert.equal(integration.database.prepare("SELECT COUNT(*) AS count FROM game_lineup_revisions WHERE is_final = 1").get().count, 0);
  } finally {
    integration.database.close();
  }
});

test("manual lineupの実handlerは認証・確認・入力検証をサーバー側で拒否する", async () => {
  const unauthenticated = await createManualLineupIntegrationDb();
  try {
    const pathname = `/api/admin/v3/games/${INTEGRATION_GAME_ID}/lineup-revisions`;
    const noAuth = await adminRequest(unauthenticated.env, pathname, { lineup: validManualLineup(), reason: "確認", confirmed: true }, { Origin: "https://starting9.test", "Content-Type": "application/json" });
    assert.equal(noAuth.status, 401);
  } finally {
    unauthenticated.database.close();
  }

  const nonAdmin = await createManualLineupIntegrationDb({ role: "user" });
  try {
    const pathname = `/api/admin/v3/games/${INTEGRATION_GAME_ID}/lineup-revisions`;
    const response = await adminRequest(nonAdmin.env, pathname, { lineup: validManualLineup(), reason: "確認", confirmed: true });
    assert.equal(response.status, 403);
  } finally {
    nonAdmin.database.close();
  }

  const invalid = await createManualLineupIntegrationDb();
  try {
    const pathname = `/api/admin/v3/games/${INTEGRATION_GAME_ID}/lineup-revisions`;
    const draft = await adminRequest(invalid.env, pathname, { lineup: validManualLineup(), reason: "下書き", confirmed: false });
    assert.equal(draft.status, 201);
    assert.equal(invalid.database.prepare("SELECT COUNT(*) AS count FROM game_lineups").get().count, 0);
    const unknown = validManualLineup().map((row, index) => index === 8 ? { ...row, playerName: "未知選手" } : row);
    const invalidPlayer = await adminRequest(invalid.env, pathname, { lineup: unknown, reason: "確認", confirmed: true });
    assert.equal(invalidPlayer.status, 400);
    const invalidCount = await adminRequest(invalid.env, pathname, { lineup: validManualLineup().slice(0, 8), reason: "確認", confirmed: true });
    assert.equal(invalidCount.status, 400);
    assert.equal(invalid.database.prepare("SELECT COUNT(*) AS count FROM game_lineup_revisions").get().count, 1);
  } finally {
    invalid.database.close();
  }

  const noConfirmation = await createManualLineupIntegrationDb({ startTime: `${currentJstDate()}T00:00:00+09:00` });
  try {
    const pathname = `/api/admin/v3/games/${INTEGRATION_GAME_ID}`;
    const draft = await adminRequest(noConfirmation.env, `${pathname}/lineup-revisions`, { lineup: validManualLineup(), reason: "下書き" });
    assert.equal(draft.status, 201);
    const draftBody = await draft.json();
    const finalize = await adminRequest(noConfirmation.env, `${pathname}/lineup-finalize`, { lineupRevisionId: draftBody.revision.revisionId });
    const finalizeBody = await finalize.json();
    assert.equal(finalize.status, 409, JSON.stringify(finalizeBody));
    assert.equal(finalizeBody.code, "V3_CONFIRMATION_REQUIRED");
    assert.equal(noConfirmation.database.prepare("SELECT COUNT(*) AS count FROM game_lineups").get().count, 0);
    assert.equal(noConfirmation.database.prepare("SELECT COUNT(*) AS count FROM game_lineup_revisions WHERE is_final = 1").get().count, 0);
    const mismatch = await adminRequest(noConfirmation.env, `${pathname}/lineup-finalize`, {
      lineupRevisionId: draftBody.revision.revisionId,
      confirmed: true,
      confirmationInternalGameId: INTEGRATION_GAME_ID,
      confirmationRevisionId: draftBody.revision.revisionId,
      confirmationFingerprint: "stale-confirmation"
    });
    const mismatchBody = await mismatch.json();
    assert.equal(mismatch.status, 409, JSON.stringify(mismatchBody));
    assert.equal(mismatchBody.code, "V3_CONFIRMATION_CONTENT_MISMATCH");
    assert.equal(noConfirmation.database.prepare("SELECT COUNT(*) AS count FROM game_lineups").get().count, 0);
    const wrongGame = await adminRequest(noConfirmation.env, `${pathname}/lineup-finalize`, {
      lineupRevisionId: draftBody.revision.revisionId,
      confirmed: true,
      confirmationInternalGameId: "another-internal-game",
      confirmationRevisionId: draftBody.revision.revisionId,
      confirmationFingerprint: draftBody.revision.lineupFingerprint
    });
    const wrongGameBody = await wrongGame.json();
    assert.equal(wrongGame.status, 409, JSON.stringify(wrongGameBody));
    assert.equal(wrongGameBody.code, "V3_CONFIRMATION_GAME_MISMATCH");
    assert.equal(noConfirmation.database.prepare("SELECT COUNT(*) AS count FROM game_lineups").get().count, 0);
  } finally {
    noConfirmation.database.close();
  }

  const noDraft = await createManualLineupIntegrationDb();
  try {
    const pathname = `/api/admin/v3/games/${INTEGRATION_GAME_ID}/lineup-finalize`;
    const response = await adminRequest(noDraft.env, pathname, { lineupRevisionId: `${INTEGRATION_GAME_ID}:1`, reason: "確認", confirmed: true });
    assert.equal(response.status, 404);
  } finally {
    noDraft.database.close();
  }

  const locked = await createManualLineupIntegrationDb({ state: "scored" });
  try {
    locked.database.prepare(
      "INSERT INTO game_lineups (id, game_id, internal_game_id, scoring_status, lineup_source, publication_status, final_lineup_revision_id) VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6)"
    ).run("lineup-locked", INTEGRATION_GAME_ID, "scored", "manual", "pending", "locked-revision");
    const pathname = `/api/admin/v3/games/${INTEGRATION_GAME_ID}/lineup-revisions`;
    const response = await adminRequest(locked.env, pathname, { lineup: validManualLineup(), reason: "確認", confirmed: true });
    assert.equal(response.status, 409);
  } finally {
    locked.database.close();
  }
});

test("保存済みmanual draftは再読込時にスマホUI stateへ復元され、finalized revisionは編集ロックされる", () => {
  assert.match(adminSource, /detailsHydrated/);
  assert.match(adminSource, /currentRevision \|\| details\.lineup\.finalRevision/);
  assert.match(adminSource, /manualLineupRowsFromRevision/);
  assert.match(uiSource, /lineupDetails\.finalRevision\?\.isFinal/);
  assert.match(uiSource, /data-v3-manual-lineup-save/);
});

test("manual lineup画面は対象試合の識別情報とrevision/canonical/workflow状態を分離表示する", () => {
  assert.match(uiSource, /data-v3-manual-lineup-target/);
  assert.match(uiSource, /internalGameId/);
  assert.match(uiSource, /manual-lineup-confirmation-list/);
  assert.match(progressSource, /revision状態/);
  assert.match(progressSource, /canonical lineup/);
  assert.match(progressSource, /workflow persisted/);
  assert.match(progressSource, /workflow effective/);
  assert.match(progressSource, /v3-state-mismatch-warning/);
});
