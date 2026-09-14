import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { deriveAdminV3GameProgressStatus } from "../backend/automation-v3/admin-progress-status.js";
import { listV3Games } from "../backend/automation-v3/repository.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const baseFacts = {
  game: { gameDate: "2026-09-06", gameStatus: "completed" },
  now: new Date("2026-09-07T00:00:00.000Z"),
  workflowState: "published",
  lineup: { available: true, workflowStateAtLeastLineupReady: true, canonicalValid: true, finalizedValid: true },
  scoring: { ready: true, scoringRevisionId: "score-b" },
  ranking: { reflected: true },
  publication: { published: true },
  currentScoringRevisionId: "score-b",
  reflectedScoringRevisionId: "score-b",
  jobs: []
};

test("revision一致・公開成果物ありだけを完了と表示する", () => {
  const result = deriveAdminV3GameProgressStatus({
    ...baseFacts,
    lineup: { ...baseFacts.lineup, canonicalFinalRevisionValid: true },
    jobs: [
      { job_type: "roster_fetch", status: "pending" },
      { job_type: "lineup_fetch", status: "pending" },
      { job_type: "lineup_finalize", status: "pending" },
      { job_type: "publish", status: "failed", failure_code: "STALE_HISTORICAL_FAILURE" }
    ]
  });
  assert.equal(result.key, "completed");
  assert.equal(result.label, "完了");
  assert.equal(result.revisionMatches, true);
});

test("V4 semi-autoのROSTER_SNAPSHOT_MISSINGと補助stageのmissing jobは完了を上書きしない", () => {
  const result = deriveAdminV3GameProgressStatus({
    ...baseFacts,
    lineup: { ...baseFacts.lineup, canonicalFinalRevisionValid: true },
    phaseStatuses: {
      roster: { status: "missing", reasonCode: "ROSTER_SNAPSHOT_MISSING" },
      lineup_fetch: { status: "missing", reasonCode: "MISSING_DUE_JOB" },
      lineup_finalize: { status: "missing", reasonCode: "MISSING_JOB" }
    },
    operationalMode: { mode: "v4_semi_auto", isV4SemiAuto: true, autoRosterFetch: false, autoLineupFetch: false }
  });
  assert.equal(result.key, "completed");
});

test("manual lineup artifactが有効ならlineup_finalize jobがなくても完了になる", () => {
  const result = deriveAdminV3GameProgressStatus({
    ...baseFacts,
    lineup: { ...baseFacts.lineup, canonicalFinalRevisionValid: true },
    jobs: []
  });
  assert.equal(result.key, "completed");
});

test("公開済み試合でも現在revisionと旧reflectionが不一致なら要対応になる", () => {
  const result = deriveAdminV3GameProgressStatus({
    ...baseFacts,
    currentScoringRevisionId: "score-b",
    reflectedScoringRevisionId: "score-a",
    ranking: { reflected: true }
  });
  assert.equal(result.key, "needs_attention");
  assert.match(result.reason, /現在の採点・ランキング・公開成果物/);
  assert.equal(result.revisionMatches, false);
});

test("current ranking revision mismatchは要対応として表示する", () => {
  const result = deriveAdminV3GameProgressStatus({
    ...baseFacts,
    lineup: { ...baseFacts.lineup, canonicalFinalRevisionValid: true },
    currentScoringRevisionId: "score-b",
    reflectedScoringRevisionId: "score-a",
    publication: { published: true }
  });
  assert.equal(result.key, "needs_attention");
  assert.equal(result.revisionMatches, false);
});

test("publication artifactが無効ならpublished stateでも要対応になる", () => {
  const result = deriveAdminV3GameProgressStatus({
    ...baseFacts,
    lineup: { ...baseFacts.lineup, canonicalFinalRevisionValid: true },
    publication: { published: false }
  });
  assert.equal(result.key, "needs_attention");
});

test("現在revisionの途中jobがある場合は進行中より再処理中を優先する", () => {
  const result = deriveAdminV3GameProgressStatus({
    ...baseFacts,
    workflowState: "manual_action_required",
    reflectedScoringRevisionId: "score-a",
    publication: { published: false },
    jobs: [{ job_type: "publish", status: "retry_wait", attempt_count: 1, max_attempts: 5 }]
  });
  assert.equal(result.key, "waiting");
  assert.equal(result.label, "待機");
  assert.equal(result.stage, "publish");
});

test("terminalな再処理失敗は要対応として表示する", () => {
  const result = deriveAdminV3GameProgressStatus({
    ...baseFacts,
    publication: { published: false },
    jobs: [{ job_type: "ranking_rebuild", status: "retry_wait", attempt_count: 5, max_attempts: 5, failure_code: "V3_RANKING_REVISION_NOT_REFLECTED" }]
  });
  assert.equal(result.key, "needs_attention");
  assert.match(result.reason, /V3_RANKING_REVISION_NOT_REFLECTED/);
});

test("canonical final revisionの不整合は完了扱いにせず理由を表示する", () => {
  const result = deriveAdminV3GameProgressStatus({
    ...baseFacts,
    lineup: { ...baseFacts.lineup, canonicalFinalRevisionValid: false }
  });
  assert.equal(result.key, "needs_attention");
  assert.match(result.reason, /canonical正式スタメン/);
});

test("未来試合は予定、過去の未完了試合は進行中として表示する", () => {
  const future = deriveAdminV3GameProgressStatus({
    ...baseFacts,
    game: { gameDate: "2026-09-08", gameStatus: "scheduled" },
    workflowState: "scheduled",
    scoring: { ready: false, scoringRevisionId: null },
    currentScoringRevisionId: null,
    reflectedScoringRevisionId: null,
    ranking: { reflected: false },
    publication: { published: false }
  });
  const past = deriveAdminV3GameProgressStatus({
    ...baseFacts,
    game: { gameDate: "2026-09-06", gameStatus: "scheduled" },
    workflowState: "scored",
    scoring: { ready: false, scoringRevisionId: null },
    currentScoringRevisionId: null,
    reflectedScoringRevisionId: null,
    ranking: { reflected: false },
    publication: { published: false }
  });
  assert.equal(future.key, "scheduled");
  assert.equal(past.key, "in_progress");
});

function createListDb(calls) {
  return {
    prepare(sql) {
      const statement = {
        all: async () => sql.startsWith("PRAGMA") ? { results: [] } : { results: [] },
        first: async () => sql.includes("sqlite_master") ? { name: "game_jobs_v3" } : null,
        bind(...params) {
          calls.push({ sql, params });
          return { all: async () => ({ results: [] }) };
        }
      };
      return statement;
    }
  };
}

test("管理履歴モードは公開済みを残してFightersだけを新しい順で取得し、既定探索条件は維持する", async () => {
  const historyCalls = [];
  await listV3Games(createListDb(historyCalls), new Date("2026-09-07T00:00:00.000Z"), { limit: 10, recentFirst: true, includeRecentHistory: true });
  const historySql = historyCalls.find((call) => call.sql.includes("FROM games"))?.sql || "";
  assert.match(historySql, /IN \('f', 'fighters'\)/);
  assert.doesNotMatch(historySql, /AND \(COALESCE\(lineup\.published_at/);
  assert.match(historySql, /ORDER BY games\.start_time DESC/);

  const automationCalls = [];
  await listV3Games(createListDb(automationCalls), new Date("2026-09-07T00:00:00.000Z"), { limit: 10, recentFirst: true });
  const automationSql = automationCalls.find((call) => call.sql.includes("FROM games"))?.sql || "";
  assert.match(automationSql, /AND \(COALESCE\(lineup\.published_at/);
  assert.doesNotMatch(automationSql, /IN \('f', 'fighters'\)/);
});

test("試合進行UIはrevision-aware statusと履歴表示を使用する", () => {
  const renderer = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-game-progress.js"), "utf8");
  const client = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
  const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
  assert.match(renderer, /displayStatusForGame/);
  assert.match(renderer, /progress\.label/);
  assert.match(renderer, /進行中/);
  assert.match(renderer, /公開済み試合も履歴として残し/);
  assert.match(client, /if \(!isV3FightersGame\(game\)\) return false/);
  assert.match(worker, /includeRecentHistory: true/);
  assert.match(worker, /currentScoringRevisionId/);
  assert.match(worker, /reflectedScoringRevisionId/);
});

test("試合進行UIは完了・再処理中・要対応・進行中・予定を実際のbadgeで描画する", () => {
  const context = { window: {}, Intl, Date };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-game-progress.js"), "utf8"), context);
  const modules = context.window.Starting9AdminV3;
  const renderer = modules.createAdminV3GameProgressRenderer({
    escapeHtml: (value) => String(value ?? ""),
    formatJst: (value) => String(value || "-"),
    gameDateForFilter: (game) => game.gameDate,
    gameHasAttention: () => false,
    identityStatusLabel: () => "解決済み",
    nextActionText: () => "-"
  });
  const games = ["completed", "reprocessing", "needs_attention", "in_progress", "scheduled"].map((key, index) => ({
    internalGameId: `game-${index}`,
    gameDate: `2026-09-0${index + 1}`,
    startAt: `2026-09-0${index + 1}T09:00:00.000Z`,
    homeTeam: "fighters",
    awayTeam: "hawks",
    displayStatus: { key, label: { completed: "完了", reprocessing: "再処理中", needs_attention: "要対応", in_progress: "進行中", scheduled: "予定" }[key], reason: "理由", stage: "publish" },
    state: { state: "scheduled" },
    npbIdentityStatus: "resolved",
    npbIdentityState: "resolved"
  }));
  const html = renderer.renderGamesView(games);
  for (const label of ["完了", "再処理中", "要対応", "進行中", "予定"]) assert.match(html, new RegExp(label));
  assert.match(html, /data-v3-game-progress-status="reprocessing"/);
  assert.match(html, /最近のFighters戦を新しい順に表示します/);
});

test("完了jobのtimelineは予定slotではなく完了日時を表示する", () => {
  const context = { window: {}, Intl, Date };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-game-progress.js"), "utf8"), context);
  const renderer = context.window.Starting9AdminV3.createAdminV3GameProgressRenderer({
    formatJst: (value) => String(value || "-"),
    formatTimelineTime: (value) => String(value || ""),
    statusLabel: (value) => String(value || ""),
    statusClass: (value) => value === "completed" ? "complete" : String(value || "wait"),
    npbIdentityDisplay: () => ({ jobStatus: "resolved", code: "2026090601" }),
    latestJob: (game, jobType) => (game.jobs || []).find((job) => job.job_type === jobType) || null,
    normalizedPhaseState: () => null,
    rosterDisplayState: () => ({ fallbackStatus: "complete", job: null }),
    lineupDisplayState: () => ({ fallbackStatus: "complete", job: null }),
    rosterDisplaySlots: () => [],
    rosterTimelineDetails: () => "",
    escapeHtml: (value) => String(value ?? "")
  });
  const html = renderer.renderTimeline({
    state: { state: "published" },
    npbIdentityStatus: "resolved",
    npbIdentityState: "resolved",
    probableStarterDiagnostics: { candidateCount: null },
    schedule: { startAt: "2026-09-06T09:00:00.000Z", publicationAt: "2026-09-06T07:10:00.000Z" },
    jobs: [{ job_type: "publish", status: "completed", scheduled_at: "2026-09-06T07:10:00.000Z", completed_at: "2026-09-07T07:47:00.000Z" }]
  });
  assert.match(html, /完了日時: 2026-09-07T07:47:00\.000Z/);
  assert.doesNotMatch(html, /完了日時: 2026-09-06T07:10:00\.000Z/);
});
