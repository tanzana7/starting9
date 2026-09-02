import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import worker from "../auth-worker.js";
import {
  createOfficialLineupFromNpb,
  executeGameAutomationV3Job,
  fetchNpbWorkerJson,
  normalizeV3LineupFetchError,
  selectV3LineupFinalizeCandidate,
  shouldSkipV3LineupFetchAfterStart,
  getV3LateLineupFetchWindowDecision,
  withV3ReadOnlyTimeout,
  writeV3TerminalAuditOnce,
  writeV3FatalRunAudits
} from "../auth-worker.js";
import { buildStagePlan, buildV3PlanningState } from "../backend/automation-v3/planning-engine.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerSource = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");

function createDbAdapter(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        bind(...parameters) {
          return {
            all: async () => ({ results: statement.all(...parameters) }),
            first: async () => statement.get(...parameters),
            run: async () => statement.run(...parameters)
          };
        }
      };
    }
  };
}

function lineupRows() {
  return ["遊", "二", "三", "一", "左", "中", "右", "捕", "指"].map((position, index) => ({
    battingOrder: index + 1,
    teamCode: "fighters",
    teamId: "F",
    uniformNumber: String(index + 1),
    playerId: `F-${index + 1}`,
    playerName: `選手${index + 1}`,
    displayName: `選手${index + 1}`,
    position
  }));
}

function createV3ExecutorFixture({ lineup = lineupRows().map((row) => ({
  playerName: row.playerName,
  uniformNumber: row.uniformNumber,
  order: row.battingOrder,
  position: row.position
})) } = {}) {
  const database = new DatabaseSync(":memory:");
  const internalGameId = "0f30b9bb-c8b0-4dc4-a8c9-c47777851362";
  database.exec(`
    CREATE TABLE games (
      internal_game_id TEXT PRIMARY KEY,
      game_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      npb_game_code TEXT,
      stadium TEXT,
      npb_game_url TEXT,
      source_schedule_key TEXT,
      npb_identity_status TEXT,
      npb_identity_resolved_at TEXT,
      npb_identity_source TEXT,
      game_status TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT
    );
    CREATE TABLE game_identifiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      internal_game_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      identifier_type TEXT NOT NULL,
      identifier_value TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE game_automation_v3_state (
      internal_game_id TEXT PRIMARY KEY,
      state TEXT NOT NULL
    );
    CREATE TABLE game_lineups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT,
      internal_game_id TEXT,
      actual_lineup_json TEXT,
      lineup_fingerprint TEXT,
      lineup_detected_at TEXT,
      scoring_due_at TEXT,
      scoring_started_at TEXT,
      scored_at TEXT,
      scoring_status TEXT,
      scoring_attempts INTEGER,
      last_error TEXT,
      processed_predictions INTEGER,
      perfect_count INTEGER,
      new_perfect_achievers TEXT,
      lineup_source TEXT,
      publication_status TEXT,
      published_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE game_lineup_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      actual_lineup_json TEXT NOT NULL,
      lineup_fingerprint TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT,
      reason TEXT,
      is_current INTEGER NOT NULL DEFAULT 0,
      superseded_at TEXT,
      revision_id TEXT,
      internal_game_id TEXT,
      captured_at TEXT,
      validation_json TEXT,
      unresolved_player_count INTEGER,
      finalized_at TEXT,
      finalized_by TEXT,
      is_final INTEGER NOT NULL DEFAULT 0
    );
  `);
  database.prepare(`
    INSERT INTO games
      (internal_game_id, game_date, start_time, home_team, away_team, npb_game_code,
       stadium, game_status, is_active)
    VALUES (?, '2026-09-01', '2026-09-01T09:00:00.000Z', 'fighters', 'hawks', 'f-h-21', 'エスコンF', 'scheduled', 1)
  `).run(internalGameId);
  database.prepare("INSERT INTO game_automation_v3_state (internal_game_id, state) VALUES (?, 'prediction_closed')").run(internalGameId);
  let fetchCount = 0;
  const env = {
    AUTH_DB: createDbAdapter(database),
    NPB_FETCH_WORKER: {
      fetch: async () => {
        fetchCount += 1;
        return new Response(JSON.stringify({
          ok: true,
          sourceUrl: "https://npb.jp/scores/2026/0901/f-h-21/",
          fetchedAt: "2026-09-01T12:00:00.000Z",
          lineup
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
  };
  return { database, env, internalGameId, getFetchCount: () => fetchCount };
}

test("production-shaped game_lineup_revisions without id column remains readable", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE game_lineup_revisions (
      game_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      actual_lineup_json TEXT NOT NULL,
      lineup_fingerprint TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      reason TEXT NOT NULL,
      is_current INTEGER NOT NULL DEFAULT 0,
      revision_id TEXT,
      internal_game_id TEXT,
      captured_at TEXT,
      validation_json TEXT,
      is_final INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (game_id, version)
    )
  `);
  database.prepare(`
    INSERT INTO game_lineup_revisions
      (game_id, version, actual_lineup_json, lineup_fingerprint, source, created_at, reason, revision_id, internal_game_id, captured_at)
    VALUES (?, 1, ?, 'fingerprint', 'npb-auto', ?, 'candidate', ?, ?, ?)
  `).run(
    "c099db0c-da34-425c-bd38-69e29ddc1064",
    JSON.stringify(lineupRows()),
    "2026-08-08T05:30:00.000Z",
    "c099db0c-da34-425c-bd38-69e29ddc1064:1",
    "c099db0c-da34-425c-bd38-69e29ddc1064",
    "2026-08-08T05:30:00.000Z"
  );
  try {
    const result = await selectV3LineupFinalizeCandidate(createDbAdapter(database), {
      internalGameId: "c099db0c-da34-425c-bd38-69e29ddc1064"
    });
    assert.equal(result.ok, true);
    assert.equal(result.diagnostics.selectedRevisionId, "c099db0c-da34-425c-bd38-69e29ddc1064:1");
    assert.doesNotMatch(workerSource, /game_lineup_revisions[\s\S]{0,180}ORDER BY version DESC, id DESC/);
  } finally {
    database.close();
  }
});

test("lineup fetch classifies unannounced data as retryable waiting", () => {
  const error = normalizeV3LineupFetchError({
    code: "LINEUP_INVALID_PLAYER_COUNT",
    validation: { parsedCount: 0 }
  }, new Date("2026-08-08T05:40:00.000Z"));
  assert.equal(error.code, "LINEUP_NOT_ANNOUNCED");
  assert.equal(error.retryable, true);
  assert.equal(error.reasonCode, "LINEUP_DATA_NOT_ANNOUNCED");
});

test("late V3 lineup fetch is allowed while legacy provisional capture remains suppressed", () => {
  const afterStart = new Date("2026-09-01T12:00:00.000Z");
  const startAt = new Date("2026-09-01T09:00:00.000Z");
  assert.equal(shouldSkipV3LineupFetchAfterStart({ source: "v3", phase: "provisional", startAt, now: afterStart }), false);
  assert.equal(shouldSkipV3LineupFetchAfterStart({ source: "legacy", phase: "provisional", startAt, now: afterStart }), true);
  assert.equal(shouldSkipV3LineupFetchAfterStart({ source: "legacy", phase: "final", startAt, now: afterStart }), false);
  assert.equal(shouldSkipV3LineupFetchAfterStart({ source: "v3", phase: "provisional", startAt, now: new Date("2026-09-01T08:59:00.000Z") }), false);
});

test("V3 late lineup fetch uses the same 24-hour boundary as planning", () => {
  const startAt = new Date("2026-09-01T09:00:00.000Z");
  assert.deepEqual(
    getV3LateLineupFetchWindowDecision({ startAt, now: new Date("2026-09-02T08:59:59.999Z") }),
    { available: true, allowed: true, reasonCode: null, deadline: "2026-09-02T09:00:00.000Z" }
  );
  assert.deepEqual(
    getV3LateLineupFetchWindowDecision({ startAt, now: new Date("2026-09-02T09:00:00.001Z") }),
    { available: true, allowed: false, reasonCode: "LINEUP_FETCH_LATE_WINDOW_EXPIRED", deadline: "2026-09-02T09:00:00.000Z" }
  );
});

test("publishのread-only検証timeoutはretryableな診断エラーになる", async () => {
  await assert.rejects(
    withV3ReadOnlyTimeout(
      () => new Promise((resolve) => setTimeout(() => resolve({ publication_status: "pending" }), 50)),
      {
        timeoutMs: 5,
        onTimeout: () => Object.assign(new Error("verification timed out"), {
          code: "PUBLISH_VERIFICATION_TIMEOUT",
          retryable: true,
          diagnostics: { verificationTimedOut: true }
        })
      }
    ),
    (error) => {
      assert.equal(error.code, "PUBLISH_VERIFICATION_TIMEOUT");
      assert.equal(error.retryable, true);
      assert.equal(error.diagnostics.verificationTimedOut, true);
      return true;
    }
  );
});

test("expired V3 late lineup fetch is rejected before NPB execution", async () => {
  const fixture = createV3ExecutorFixture();
  try {
    await assert.rejects(
      executeGameAutomationV3Job({
        env: fixture.env,
        internalGameId: fixture.internalGameId,
        now: new Date("2026-09-02T09:00:00.001Z"),
        job: { job_type: "lineup_fetch", scheduled_slot_at: "2026-09-01T09:10:00.000Z" }
      }),
      (error) => {
        assert.equal(error.code, "LINEUP_FETCH_LATE_WINDOW_EXPIRED");
        assert.equal(error.retryable, false);
        assert.equal(error.diagnostics.reasonCode, "LINEUP_FETCH_LATE_WINDOW_EXPIRED");
        assert.equal(error.diagnostics.artifactCreated, false);
        assert.equal(error.diagnostics.completedWithoutCandidate, false);
        return true;
      }
    );
    assert.equal(fixture.getFetchCount(), 0);
  } finally {
    fixture.database.close();
  }
});

test("zero lineup candidates retain parser diagnostics and invalid-count reason", () => {
  const parsed = createOfficialLineupFromNpb([]);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "LINEUP_INVALID_PLAYER_COUNT");
  assert.equal(parsed.validation.parsedCount, 0);
  assert.equal(parsed.validation.rawLineupSectionFound, true);
  assert.equal(parsed.parserDiagnostics.parserReason, "LINEUP_INVALID_PLAYER_COUNT");
  assert.equal(parsed.parserDiagnostics.totalCandidatePlayerCount, 0);
  const normalized = normalizeV3LineupFetchError({
    code: parsed.code,
    validation: parsed.validation,
    parserDiagnostics: parsed.parserDiagnostics
  }, new Date("2026-09-01T12:01:00.000Z"));
  assert.equal(normalized.code, "LINEUP_INVALID_PLAYER_COUNT");
  assert.equal(normalized.retryable, true);
  assert.equal(normalized.reasonCode, "LINEUP_PARSER_REJECTED");
});

test("nine valid NPB rows produce a verified candidate payload", () => {
  const rows = ["遊", "二", "三", "一", "左", "中", "右", "捕", "指"].map((position, index) => ({
    playerName: `候補選手${index + 1}`,
    uniformNumber: String(index + 1),
    order: index + 1,
    position
  }));
  const parsed = createOfficialLineupFromNpb(rows);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.lineup.length, 9);
  assert.equal(parsed.validation.valid, true);
  assert.equal(parsed.parserDiagnostics.parserReason, "VALID");
  assert.equal(parsed.parserDiagnostics.totalCandidatePlayerCount, 9);
});

test("V3 late executor saves a candidate and exposes continuation-ready artifact diagnostics", async () => {
  const fixture = createV3ExecutorFixture();
  try {
    const result = await executeGameAutomationV3Job({
      env: fixture.env,
      internalGameId: fixture.internalGameId,
      now: new Date("2026-09-01T12:00:00.000Z"),
      job: { job_type: "lineup_fetch", scheduled_slot_at: "2026-09-01T09:10:00.000Z" }
    });
    assert.equal(fixture.getFetchCount(), 1);
    assert.equal(result.status, "provisional");
    assert.equal(result.artifactCreated, true);
    assert.equal(result.completedWithoutCandidate, false);
    assert.equal(result.lineupDataHealth.ready, true);
    assert.equal(result.lineupDataHealth.candidateValid, true);
    const savedArtifact = fixture.database.prepare(
      "SELECT COUNT(*) AS count FROM game_lineup_revisions WHERE internal_game_id = ?"
    ).get(fixture.internalGameId);
    assert.equal(Number(savedArtifact.count), 1);

    const plan = buildStagePlan(buildV3PlanningState({
      game: {
        internalGameId: fixture.internalGameId,
        gameDate: "2026-09-01",
        startAt: "2026-09-01T09:00:00.000Z",
        homeTeam: "fighters",
        awayTeam: "hawks",
        gameCode: "f-h-21",
        npbGameCode: "f-h-21",
        npbIdentityStatus: "resolved"
      },
      artifacts: { lineup_fetch: { available: true, valid: true, candidateValid: true } },
      effectiveState: "prediction_closed",
      persistedState: "prediction_closed",
      now: new Date("2026-09-01T12:00:00.000Z")
    }), "lineup_finalize");
    assert.equal(plan.shouldCreateJob, true);
    assert.equal(plan.blocked, false);
  } finally {
    fixture.database.close();
  }
});

test("V3 parser rejection records artifact absence without retaining raw response", async () => {
  const fixture = createV3ExecutorFixture({ lineup: [] });
  try {
    await assert.rejects(
      executeGameAutomationV3Job({
        env: fixture.env,
        internalGameId: fixture.internalGameId,
        now: new Date("2026-09-01T12:00:00.000Z"),
        job: { job_type: "lineup_fetch", scheduled_slot_at: "2026-09-01T09:10:00.000Z" }
      }),
      (error) => {
        assert.equal(error.code, "LINEUP_INVALID_PLAYER_COUNT");
        assert.equal(error.retryable, true);
        assert.equal(error.diagnostics.artifactCreated, false);
      assert.equal(error.diagnostics.completedWithoutCandidate, true);
      assert.equal(error.diagnostics.lineupParserDiagnostics.totalCandidatePlayerCount, 0);
      assert.equal(Object.hasOwn(error.diagnostics.lineupParserDiagnostics, "rawHtml"), false);
      assert.ok(JSON.stringify(error.diagnostics).length < 4000);
      return true;
      }
    );
  } finally {
    fixture.database.close();
  }
});

test("NPB validation rejection records artifact absence flags", async () => {
  await assert.rejects(
    fetchNpbWorkerJson({
      NPB_FETCH_WORKER: {
        fetch: async () => new Response(JSON.stringify({
          ok: false,
          code: "LINEUP_INVALID_POSITION",
          error: "invalid position",
          debug: { failedAt: "validate_lineup", foundRows: 8 }
        }), { status: 422, headers: { "content-type": "application/json" } })
      }
    }, { mode: "lineup", date: "2026-09-01", gameCode: "f-h-21", debug: "1" }),
    (error) => {
      assert.equal(error.code, "LINEUP_INVALID_POSITION");
      assert.equal(error.diagnostics.artifactCreated, false);
      assert.equal(error.diagnostics.completedWithoutCandidate, true);
      assert.equal(error.npbDiagnostics.parserDiagnostics.parserStage, "validate_lineup");
      assert.equal(Object.hasOwn(error.npbDiagnostics.parserDiagnostics, "rawHtml"), false);
      return true;
    }
  );
});

test("ambiguous score source records artifact absence without adopting a candidate", async () => {
  await assert.rejects(
    fetchNpbWorkerJson({
      NPB_FETCH_WORKER: {
        fetch: async () => new Response(JSON.stringify({
          ok: false,
          code: "NPB_SCORE_PAGE_AMBIGUOUS",
          error: "multiple score pages match",
          diagnostics: {
            sourceIndexUrl: "https://npb.jp/scores/2026/0901/",
            fallbackCandidateCount: 2,
            fallbackRejectReasons: ["AMBIGUOUS_MATCH"],
            errorCode: "NPB_SCORE_PAGE_AMBIGUOUS"
          }
        }), { status: 502, headers: { "content-type": "application/json" } })
      }
    }, { mode: "lineup", date: "2026-09-01", gameCode: "f-h-21", debug: "1" }),
    (error) => {
      assert.equal(error.code, "NPB_SCORE_PAGE_AMBIGUOUS");
      assert.equal(error.retryable, true);
      assert.equal(error.diagnostics.artifactCreated, false);
      assert.equal(error.diagnostics.completedWithoutCandidate, true);
      assert.equal(error.diagnostics.sourceSelectionStage, "resolve_official_score_page");
      assert.equal(error.diagnostics.sourceSelectionReason, "NPB_SCORE_PAGE_AMBIGUOUS");
      assert.equal(error.diagnostics.candidateCount, 0);
      assert.equal(error.diagnostics.totalCandidatePlayerCount, 0);
      assert.equal(error.npbDiagnostics.errorCode, "NPB_SCORE_PAGE_AMBIGUOUS");
      assert.equal(error.npbDiagnostics.fallbackCandidateCount, 2);
      assert.equal(Object.hasOwn(error.npbDiagnostics, "rawHtml"), false);
      return true;
    }
  );
});

test("debugなしzero-candidate rejection keeps sanitized artifact diagnostics after normalization", async () => {
  let originalError;
  await assert.rejects(
    fetchNpbWorkerJson({
      NPB_FETCH_WORKER: {
        fetch: async () => new Response(JSON.stringify({
          ok: false,
          code: "LINEUP_INVALID_PLAYER_COUNT",
          error: "lineup is empty"
        }), { status: 422, headers: { "content-type": "application/json" } })
      }
    }, { mode: "lineup", date: "2026-09-01", gameCode: "f-h-21" }),
    (error) => {
      originalError = error;
      return true;
    }
  );

  const normalized = normalizeV3LineupFetchError(originalError, new Date("2026-09-01T12:01:00.000Z"));
  assert.equal(normalized.code, "LINEUP_NOT_ANNOUNCED");
  assert.equal(normalized.retryable, true);
  assert.equal(normalized.diagnostics.artifactCreated, false);
  assert.equal(normalized.diagnostics.completedWithoutCandidate, true);
  assert.equal(normalized.diagnostics.candidateCount, 0);
  assert.equal(normalized.diagnostics.totalCandidatePlayerCount, 0);
  assert.equal(normalized.diagnostics.parserStage, "npb_worker_validation");
  assert.equal(normalized.diagnostics.parserReason, "LINEUP_INVALID_PLAYER_COUNT");
  assert.equal(Object.hasOwn(normalized.diagnostics, "rawHtml"), false);
});

test("lineup failure normalization preserves runtime error metadata", () => {
  const normalized = normalizeV3LineupFetchError({
    code: "LINEUP_INVALID_PLAYER_COUNT",
    retryable: true,
    validation: { parsedCount: 0, validationReason: "LINEUP_INVALID_PLAYER_COUNT" },
    diagnostics: {
      artifactCreated: false,
      completedWithoutCandidate: true,
      candidateCount: 0,
      totalCandidatePlayerCount: 0,
      parserStage: "validate_lineup",
      parserReason: "LINEUP_INVALID_PLAYER_COUNT",
      validationReason: "LINEUP_INVALID_PLAYER_COUNT"
    }
  }, new Date("2026-09-01T12:01:00.000Z"));

  assert.equal(normalized.diagnostics.artifactCreated, false);
  assert.equal(normalized.diagnostics.completedWithoutCandidate, true);
  assert.equal(normalized.diagnostics.candidateCount, 0);
  assert.equal(normalized.diagnostics.totalCandidatePlayerCount, 0);
  assert.equal(normalized.diagnostics.parserStage, "validate_lineup");
  assert.equal(normalized.diagnostics.parserReason, "LINEUP_INVALID_PLAYER_COUNT");
  assert.equal(normalized.diagnostics.validationReason, "LINEUP_INVALID_PLAYER_COUNT");
  assert.equal(normalized.retryable, true);
});

test("NPB parser debug is retained in sanitized lineup diagnostics", async () => {
  const env = {
    NPB_FETCH_WORKER: {
      fetch: async () => new Response(JSON.stringify({
        ok: false,
        code: "LINEUP_INVALID_PLAYER_COUNT",
        error: "lineup is empty",
        httpStatus: 200,
        sourceUrl: "https://npb.jp/scores/2026/0901/f-h-21/",
        diagnostics: {
          attemptedUrl: "https://npb.jp/scores/2026/0901/f-h-21/",
          originStatus: 200,
          fetchWorkerStatus: 422,
          fallbackUsed: false
        },
        debug: {
          failedAt: "extract_order",
          foundOrderHeading: true,
          foundRows: 0
        }
      }), { status: 422, headers: { "content-type": "application/json" } })
    }
  };
  await assert.rejects(
    fetchNpbWorkerJson(env, { mode: "lineup", date: "2026-09-01", gameCode: "f-h-21", debug: "1" }),
    (error) => {
      assert.equal(error.code, "LINEUP_INVALID_PLAYER_COUNT");
      assert.equal(error.npbDiagnostics.parserDiagnostics.parserStage, "extract_order");
      assert.equal(error.npbDiagnostics.parserDiagnostics.rawLineupSectionFound, true);
      assert.equal(error.npbDiagnostics.parserDiagnostics.extractedHomePlayerCount, 0);
      assert.equal(error.npbDiagnostics.parserDiagnostics.totalCandidatePlayerCount, 0);
      return true;
    }
  );
});

test("lineup candidate verification exposes completed-without-candidate diagnostics", () => {
  assert.match(workerSource, /LINEUP_FETCH_COMPLETED_WITHOUT_CANDIDATE/);
  assert.match(workerSource, /completedWithoutCandidate: true/);
  assert.match(workerSource, /artifactCreated: false/);
});

test("lineup executor diagnostics retain unexpected exception context without secrets", () => {
  assert.match(workerSource, /executorStage/);
  assert.match(workerSource, /exceptionName/);
  assert.match(workerSource, /exceptionMessage/);
  assert.match(workerSource, /selectedSlot/);
  assert.match(workerSource, /NPB_GAME_CODE_NOT_AVAILABLE/);
});

test("terminal audit failure is not marked as completed and can be retried", async () => {
  const state = { recorded: false };
  let attempts = 0;
  const first = await writeV3TerminalAuditOnce(async () => {
    attempts += 1;
    return false;
  }, state, { eventType: "CRON_HANDLER_FINISHED" }, 1);

  assert.equal(first, false);
  assert.equal(state.recorded, false);
  assert.equal(attempts, 1);

  const second = await writeV3TerminalAuditOnce(async () => true, state, { eventType: "CRON_HANDLER_FINISHED" }, 1);
  assert.equal(second, true);
  assert.equal(state.recorded, true);
});

test("fatal V3 run emits execution summary, run error, and both terminal audits", async () => {
  const events = [];
  let criticalCount = 0;
  let handlerCount = 0;
  const fatal = Object.assign(new Error("publish failed"), {
    code: "V3_PUBLISH_FAILED",
    job: { id: 4787, internal_game_id: "game-1", job_type: "publish" },
    stage: "publish"
  });

  await writeV3FatalRunAudits({
    writeRuntimeAudit: async (payload) => {
      events.push({ eventType: payload.eventType, execution: payload.execution });
    },
    writeCriticalPathFinished: async (status, details) => {
      criticalCount += 1;
      assert.equal(status, "failed");
      assert.equal(details.jobId, 4787);
      assert.equal(details.stage, "publish");
    },
    writeHandlerFinished: async (status, details) => {
      handlerCount += 1;
      assert.equal(status, "failed");
      assert.equal(details.internalGameId, "game-1");
    },
    runId: "run-1",
    now: new Date("2026-09-02T01:43:00.000Z"),
    error: fatal
  });

  assert.deepEqual(events.map((event) => event.eventType), ["V3_EXECUTION_SUMMARY", "V3_RUN_ERROR"]);
  assert.equal(events[0].execution.status, "failed");
  assert.equal(events[0].execution.errorReason, "V3_PUBLISH_FAILED");
  assert.equal(events[0].execution.jobId, 4787);
  assert.equal(criticalCount, 1);
  assert.equal(handlerCount, 1);
});

test("fatal audit write failure does not block later terminal audit attempts", async () => {
  const calls = [];
  await writeV3FatalRunAudits({
    writeRuntimeAudit: async (payload) => {
      calls.push(payload.eventType);
      if (payload.eventType === "V3_EXECUTION_SUMMARY") throw new Error("audit unavailable");
    },
    writeCriticalPathFinished: async () => calls.push("CRON_CRITICAL_PATH_FINISHED"),
    writeHandlerFinished: async () => calls.push("CRON_HANDLER_FINISHED"),
    runId: "run-audit-failure",
    error: Object.assign(new Error("fatal"), { code: "V3_FATAL" })
  });

  assert.deepEqual(calls, [
    "V3_EXECUTION_SUMMARY",
    "V3_RUN_ERROR",
    "CRON_CRITICAL_PATH_FINISHED",
    "CRON_HANDLER_FINISHED"
  ]);
});

test("scheduled handlerのfatal V3経路でもterminal auditを試行する", async () => {
  const events = [];
  const failure = Object.assign(new Error("schema probe failed"), { code: "V3_SCHEMA_PROBE_FAILED" });
  const db = {
    prepare(sql) {
      if (sql.includes("sqlite_master")) {
        return { all: async () => { throw failure; } };
      }
      if (sql.includes("SELECT internal_game_id FROM games")) {
        return { first: async () => ({ internal_game_id: "anchor-game" }) };
      }
      if (sql.startsWith("PRAGMA table_info(game_automation_v3_audit)")) {
        return {
          bind: () => ({
            all: async () => ({ results: [{ name: "event_type" }, { name: "data_status" }] })
          })
        };
      }
      if (sql.includes("INSERT INTO game_automation_v3_audit")) {
        return {
          bind: (...values) => ({
            run: async () => {
              events.push(values[0]);
              return { meta: { changes: 1 } };
            }
          })
        };
      }
      throw new Error(`unexpected SQL in scheduler fatal fixture: ${sql}`);
    }
  };
  const waiters = [];
  const ctx = { waitUntil(promise) { waiters.push(Promise.resolve(promise)); } };
  await worker.scheduled(
    { scheduledTime: Date.parse("2026-09-02T01:43:00.000Z") },
    { AUTH_DB: db, ENABLE_GAME_AUTOMATION_V3: "true" },
    ctx
  );
  const settled = await Promise.allSettled(waiters);
  assert.equal(settled.some((result) => result.status === "rejected"), true);
  for (const eventType of [
    "V3_EXECUTION_SUMMARY",
    "V3_RUN_ERROR",
    "CRON_CRITICAL_PATH_FINISHED",
    "CRON_HANDLER_FINISHED"
  ]) {
    assert.ok(events.includes(eventType), eventType);
  }
});
