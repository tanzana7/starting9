import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const page = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
const css = fs.readFileSync(path.join(root, "admin-v3.css"), "utf8");
const wrangler = JSON.parse(fs.readFileSync(path.join(root, "wrangler.auth.production.jsonc"), "utf8"));
const diagnosticsSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-diagnostics.js"), "utf8");
const moduleContext = { window: {} };
vm.runInNewContext(diagnosticsSource, moduleContext);
const context = {
  createRenderer() {
    const modules = moduleContext.window.Starting9AdminV3;
    return modules.createAdminV3DiagnosticsRenderer({
      state: { automationLogs: null, automationLogFilters: {} },
      escapeHtml(value) { return String(value ?? ""); },
      formatJst(value) { return String(value || "-"); },
      listItems(value, key = "items") { return Array.isArray(value) ? value : Array.isArray(value?.[key]) ? value[key] : []; },
      filterGames(games, filter) { return filter === "today" ? games.filter((game) => game.gameDate === "2026-08-08") : games; },
      jstDate() { return "2026-08-08"; },
      gameDateForFilter(game) { return game.gameDate; },
      currentFailedJobs(game) { return (Array.isArray(game?.jobs) ? game.jobs : []).filter((job) => ["failed", "permanently_failed"].includes(job.status)); },
      currentRetryWaitJobs(game) { return (Array.isArray(game?.jobs) ? game.jobs : []).filter((job) => job.status === "retry_wait"); },
      normalizedPhaseState() { return null; },
      rosterDisplayState(game) { return game.rosterDiagnostics?.rosterSnapshotExists ? { status: "ok", detail: "" } : { status: "waiting", detail: "" }; },
      lineupDisplayState() { return { status: "waiting", detail: "" }; },
      nextActionText() { return "次の処理"; },
      renderSelectedGameHeader() { return ""; },
      renderJobRows() { return ""; },
      latestJob() { return null; },
      jobTypes: [],
      statusLabel(value) { return String(value || ""); },
      identityStatusLabel(value) { return String(value || ""); }
    });
  }
};
const renderer = context.createRenderer();
context.buildTodayOpsModel = renderer.buildTodayOpsModel;

function game(overrides = {}) {
  return {
    internalGameId: "game-today",
    gameDate: "2026-08-08",
    startAt: "2026-08-08T09:00:00.000Z",
    homeTeam: "fighters",
    awayTeam: "eagles",
    isActive: 1,
    state: { state: "scheduled" },
    jobs: [],
    schedule: {
      lineupPollingStart: "2026-08-08T08:10:00.000Z",
      publicationAt: "2026-08-08T09:10:00.000Z"
    },
    probableStarter: { dataStatus: "announced" },
    rosterDiagnostics: { rosterSnapshotExists: true },
    ...overrides
  };
}

const now = new Date("2026-08-08T07:00:00.000Z");
const payload = { todayOps: { cronLastRunAt: "2026-08-08T06:59:00.000Z", cronSchedule: "* * * * *", cronIntervalMinutes: 1, cronGraceMinutes: 2 } };

test("Today Opsは公開済み・未来試合充足・直近CronをOKと判定する", () => {
  const model = context.buildTodayOpsModel(payload, [
    game({ state: { state: "published" }, jobs: [{ job_type: "publish", status: "completed", completed_at: "2026-08-08T06:50:00.000Z" }] }),
    game({ internalGameId: "future-1", gameDate: "2026-08-09" }),
    game({ internalGameId: "future-2", gameDate: "2026-08-10" }),
    game({ internalGameId: "future-3", gameDate: "2026-08-11" })
  ], now);
  assert.equal(model.overallStatus, "ok");
  assert.equal(model.futureGames, 3);
  assert.equal(model.failedJobs, 0);
  assert.equal(model.gameModels[0].steps.publication, "ok");
});

test("Today Opsは未完了の予定をWAITINGと判定する", () => {
  const model = context.buildTodayOpsModel(payload, [
    game({ jobs: [{ job_type: "lineup_fetch", status: "pending", scheduled_at: "2026-08-08T08:10:00.000Z" }] }),
    game({ internalGameId: "future-1", gameDate: "2026-08-09" }),
    game({ internalGameId: "future-2", gameDate: "2026-08-10" }),
    game({ internalGameId: "future-3", gameDate: "2026-08-11" })
  ], now);
  assert.equal(model.overallStatus, "waiting");
  assert.equal(model.openJobs, 1);
  assert.equal(model.gameModels[0].status, "waiting");
});

test("Today Opsはfailed job・未来試合不足・古いCronをATTENTIONと判定する", () => {
  const model = context.buildTodayOpsModel(
    { todayOps: { cronLastRunAt: "2026-08-08T05:00:00.000Z" } },
    [game({ jobs: [{ job_type: "score", status: "failed", failure_code: "V3_JOB_FAILED" }] }), game({ internalGameId: "future-1", gameDate: "2026-08-09" })],
    now
  );
  assert.equal(model.overallStatus, "attention");
  assert.equal(model.futureShortage, true);
  assert.equal(model.failedJobs, 1);
  assert.equal(model.gameModels[0].status, "attention");
});

test("Today OpsはoverviewのJST基準futureGamesCountをschedule syncと同じ正として使う", () => {
  const model = context.buildTodayOpsModel(
    { todayOps: { cronLastRunAt: "2026-08-08T06:55:00.000Z", futureGamesCount: 2, futureGamesMinimum: 3 } },
    [game(), game({ internalGameId: "future-1", gameDate: "2026-08-09" }), game({ internalGameId: "future-2", gameDate: "2026-08-11" })],
    now
  );
  assert.equal(model.futureGames, 2);
  assert.equal(model.futureShortage, true);
  assert.equal(model.overallStatus, "attention");
});

test("Cron設定とWorker定数がproduction設定に一致し、次Cron目安を計算する", () => {
  assert.deepEqual(wrangler.triggers.crons, ["* * * * *"]);
  assert.match(worker, /const V3_CRON_SCHEDULE = "\* \* \* \* \*"/);
  assert.match(worker, /const V3_CRON_INTERVAL_MINUTES = 1/);
  assert.match(worker, /const V3_CRON_GRACE_MINUTES = 2/);
  const model = context.buildTodayOpsModel({ todayOps: { ...payload.todayOps } }, [game(), game({ internalGameId: "future-1", gameDate: "2026-08-09" }), game({ internalGameId: "future-2", gameDate: "2026-08-10" }), game({ internalGameId: "future-3", gameDate: "2026-08-11" })], now);
  assert.equal(model.nextCronEstimate, "2026-08-08T07:00:00.000Z");
  assert.equal(model.cronStatus, "ok");
});

test("Cron監査なし・古い監査はATTENTIONになり、schedule sync診断の不足と失敗もATTENTIONになる", () => {
  const games = [game(), game({ internalGameId: "future-1", gameDate: "2026-08-09" }), game({ internalGameId: "future-2", gameDate: "2026-08-11" })];
  const missing = context.buildTodayOpsModel({ todayOps: { futureGamesCount: 2, futureGamesMinimum: 3 } }, games, now);
  assert.equal(missing.cronStatus, "attention");
  assert.equal(missing.overallStatus, "attention");
  const failed = context.buildTodayOpsModel({ todayOps: { ...payload.todayOps, futureGamesCount: 3, futureScheduleSync: { status: "failed", syncNeeded: true, futureGamesBefore: 2, futureGamesAfter: 2, futureGamesTarget: 3, gamesInserted: 0, gamesUpdated: 0, errorCode: "SCHEDULE_FETCH_FAILED" } } }, games, now);
  assert.equal(failed.futureScheduleSyncStatus, "attention");
  assert.equal(failed.overallStatus, "attention");
  const stale = context.buildTodayOpsModel({ todayOps: { ...payload.todayOps, cronLastRunAt: "2026-08-08T06:50:00.000Z", futureGamesCount: 3, futureScheduleSync: { status: "skipped", syncNeeded: false, futureGamesBefore: 3, futureGamesAfter: 3, futureGamesTarget: 3 } } }, [game(), ...games.slice(1)], now);
  assert.equal(stale.cronStatus, "attention");
  assert.equal(stale.overallStatus, "attention");
});

test("future schedule sync診断の成功・skip項目をToday Opsへ表示できる契約を持つ", () => {
  assert.match(worker, /event_type = 'schedule_sync'/);
  assert.match(worker, /futureGamesBefore/);
  assert.match(worker, /futureGamesAfter/);
  assert.match(worker, /expandedTo30Days/);
  assert.match(diagnosticsSource, /未来試合同期診断/);
  assert.match(diagnosticsSource, /lastScheduleSyncAt/);
  assert.match(diagnosticsSource, /futureScheduleSyncAttention/);
});

test("overviewはCron監査時刻をToday Opsへ返し、管理画面は専用セクションを描画する", () => {
  assert.match(worker, /futureGamesDefinition: "game_date > JST today"/);
  assert.match(worker, /WHERE source = 'cron' ORDER BY occurred_at DESC LIMIT 1/);
  assert.match(diagnosticsSource, /Today Ops \/ Automation Health/);
  assert.match(diagnosticsSource, /futureShortage/);
  assert.match(diagnosticsSource, /renderStep\("スタメン", steps\.lineup, steps\.lineupDetail\)/);
  assert.match(page, /admin-v3\.js\?v=admin-v3-v35-diagnostics-readability-1/);
  assert.match(page, /admin-v3\.css\?v=admin-v3-v35-shadow-recovery-plan-1/);
  assert.match(css, /today-ops-panel/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*today-ops-metrics, \.today-ops-steps \{ grid-template-columns: 1fr; \}/);
});
