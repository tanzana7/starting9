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

const start = client.indexOf("const TODAY_OPS_STATUS_LABELS");
const end = client.indexOf("function renderGameSummary", start);
const todayOpsSource = client.slice(start, end);
const context = {
  filteredV3Games(games, filter) {
    return filter === "today" ? games.filter((game) => game.gameDate === "2026-08-08") : games;
  },
  v3JstDate() { return "2026-08-08"; },
  gameDateForFilter(game) { return game.gameDate; },
  nextV3ActionText() { return "次の処理"; },
  formatV3Jst(value) { return String(value || "-"); },
  escapeV3(value) { return String(value ?? ""); }
};
vm.runInNewContext(`${todayOpsSource}; globalThis.buildTodayOpsModel = buildTodayOpsModel;`, context);

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
const payload = { todayOps: { cronLastRunAt: "2026-08-08T06:55:00.000Z" } };

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

test("overviewはCron監査時刻をToday Opsへ返し、管理画面は専用セクションを描画する", () => {
  assert.match(worker, /futureGamesDefinition: "game_date > JST today"/);
  assert.match(worker, /WHERE source = 'cron' ORDER BY occurred_at DESC LIMIT 1/);
  assert.match(client, /Today Ops \/ Automation Health/);
  assert.match(client, /futureShortage/);
  assert.match(client, /todayOpsStep/);
  assert.match(page, /admin-v3\.js\?v=automation-v3-7-phase1-today-ops-future-count/);
  assert.match(page, /admin-v3\.css\?v=automation-v3-7-phase1-today-ops/);
  assert.match(css, /today-ops-panel/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*today-ops-metrics, \.today-ops-steps \{ grid-template-columns: 1fr; \}/);
});
