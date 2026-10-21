import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyEligibilityChange } from "../backend/automation-v3/eligibility-service.js";
import { applyScheduleChange, createScheduleVersion, deriveScheduleArtifacts } from "../backend/automation-v3/schedule-service.js";

const GAME_ID = "11111111-1111-4111-8111-111111111111";
const GAME_KEY = "2026-09-21-fighters-buffaloes-1800";

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        bind(...bindings) {
          return {
            async first() { return statement.get(...bindings) || null; },
            async all() { return { results: statement.all(...bindings) }; },
            async run() { return { meta: { changes: statement.run(...bindings).changes } }; }
          };
        }
      };
    }
  };
}

function createDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE games (
      internal_game_id TEXT PRIMARY KEY, game_date TEXT NOT NULL, start_time TEXT NOT NULL,
      home_team TEXT NOT NULL, away_team TEXT NOT NULL, game_status TEXT NOT NULL,
      npb_game_code TEXT, npb_game_url TEXT, source_schedule_key TEXT,
      npb_identity_status TEXT, npb_identity_resolved_at TEXT, npb_identity_source TEXT,
      stadium TEXT, season INTEGER, is_active INTEGER DEFAULT 1, deleted_at TEXT,
      prediction_deadline_at TEXT, roster_fetch_at1 TEXT, roster_fetch_at2 TEXT,
      lineup_polling_start_at TEXT, final_lineup_at TEXT, publication_at TEXT,
      updated_by TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE game_schedule_change_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT NOT NULL,
      previous_start_at TEXT, next_start_at TEXT NOT NULL, previous_status TEXT,
      next_status TEXT NOT NULL, reason TEXT NOT NULL, changed_by TEXT NOT NULL, changed_at TEXT NOT NULL
    );
    CREATE TABLE ranking_games (
      game_id TEXT PRIMARY KEY, internal_game_id TEXT, game_status TEXT, ranking_eligibility_status TEXT,
      ranking_eligibility_reason TEXT, ranking_eligibility_note TEXT,
      ranking_eligibility_version INTEGER, ranking_eligibility_updated_by TEXT
    );
    CREATE TABLE contest_ranking_games (
      contest_id TEXT PRIMARY KEY, internal_game_id TEXT NOT NULL, game_id TEXT NOT NULL, game_status TEXT NOT NULL,
      ranking_eligibility_status TEXT NOT NULL, ranking_eligibility_reason TEXT, ranking_eligibility_note TEXT,
      ranking_eligibility_version INTEGER NOT NULL, ranking_eligibility_updated_by TEXT NOT NULL, updated_at TEXT
    );
  `);
  database.prepare(`INSERT INTO games
    (internal_game_id, game_date, start_time, home_team, away_team, game_status, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(GAME_ID, "2026-09-21", "2026-09-21T09:00:00.000Z", "fighters", "buffaloes", "scheduled", "system", "2026-09-20T00:00:00.000Z");
  database.prepare(`INSERT INTO ranking_games
    (game_id, internal_game_id, game_status, ranking_eligibility_status, ranking_eligibility_version, ranking_eligibility_updated_by)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(GAME_KEY, GAME_ID, "scheduled", "eligible", 1, "system");
  return { database, db: d1(database) };
}

function schedule(overrides = {}) {
  return {
    gameDate: "2026-09-21",
    startAt: "2026-09-21T10:00:00.000Z",
    homeTeam: "fighters",
    awayTeam: "buffaloes",
    status: "scheduled",
    ...overrides
  };
}

test("管理者override中の古いCronはcanonical scheduleを巻き戻さない", async () => {
  const { database, db } = createDatabase();
  const admin = await applyScheduleChange(db, {
    internalGameId: GAME_ID,
    proposedSchedule: schedule({ startAt: "2026-09-21T11:00:00.000Z" }),
    derivedSchedule: deriveScheduleArtifacts("2026-09-21T11:00:00.000Z"),
    source: "admin", actor: "operator-1", reason: "管理者による開始時刻訂正", now: new Date("2026-09-20T01:00:00.000Z")
  });
  assert.equal(admin.status, "updated");
  const cron = await applyScheduleChange(db, {
    internalGameId: GAME_ID,
    proposedSchedule: schedule({ startAt: "2026-09-21T10:00:00.000Z" }),
    derivedSchedule: deriveScheduleArtifacts("2026-09-21T10:00:00.000Z"),
    source: "cron", actor: "npb-schedule-sync", reason: "NPB公式日程同期", now: new Date("2026-09-20T02:00:00.000Z")
  });
  assert.equal(cron.reason, "MANUAL_OVERRIDE_ACTIVE");
  assert.equal(database.prepare("SELECT start_time FROM games WHERE internal_game_id = ?").get(GAME_ID).start_time, "2026-09-21T11:00:00.000Z");
  database.close();
});

test("変更のないCron同期はgamesと履歴を更新しない", async () => {
  const { database, db } = createDatabase();
  const result = await applyScheduleChange(db, {
    internalGameId: GAME_ID,
    proposedSchedule: schedule({ startAt: "2026-09-21T09:00:00.000Z" }),
    source: "cron", actor: "npb-schedule-sync", reason: "NPB公式日程同期", now: new Date("2026-09-20T02:00:00.000Z")
  });
  assert.equal(result.status, "no_change");
  assert.equal(database.prepare("SELECT updated_at FROM games WHERE internal_game_id = ?").get(GAME_ID).updated_at, "2026-09-20T00:00:00.000Z");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_schedule_change_history").get().count, 0);
  database.close();
});

test("公式訂正は明示された場合だけoverrideを越え、override解除後は通常同期へ戻る", async () => {
  const { database, db } = createDatabase();
  await applyScheduleChange(db, {
    internalGameId: GAME_ID, proposedSchedule: schedule({ startAt: "2026-09-21T11:00:00.000Z" }),
    source: "admin", actor: "operator-1", reason: "手動override", now: new Date("2026-09-20T01:00:00.000Z")
  });
  const released = await applyScheduleChange(db, {
    internalGameId: GAME_ID, proposedSchedule: schedule({ startAt: "2026-09-21T11:00:00.000Z" }),
    source: "admin", actor: "operator-1", releaseManualOverride: true,
    reason: "公式同期へ復帰", now: new Date("2026-09-20T03:00:00.000Z")
  });
  assert.equal(released.manualOverrideReleased, true);
  assert.equal(createScheduleVersion(database.prepare("SELECT * FROM games WHERE internal_game_id = ?").get(GAME_ID)), "2026-09-20T03:00:00.000Z");
  const correction = await applyScheduleChange(db, {
    internalGameId: GAME_ID, proposedSchedule: schedule({ startAt: "2026-09-21T12:00:00.000Z" }),
    derivedSchedule: deriveScheduleArtifacts("2026-09-21T12:00:00.000Z"),
    source: "cron", actor: "official-correction",
    reason: "NPB公式訂正", now: new Date("2026-09-20T04:00:00.000Z")
  });
  assert.equal(correction.status, "updated");
  assert.equal(database.prepare("SELECT start_time FROM games WHERE internal_game_id = ?").get(GAME_ID).start_time, "2026-09-21T12:00:00.000Z");
  database.close();
});

test("管理者のeligibility変更中は通常Cronが復帰させず、公式訂正だけが明示的に復帰できる", async () => {
  const { database, db } = createDatabase();
  const persist = async ({ gameId, status, updatedBy }) => {
    database.prepare(`UPDATE ranking_games SET ranking_eligibility_status = ?, ranking_eligibility_version = ranking_eligibility_version + 1, ranking_eligibility_updated_by = ? WHERE game_id = ?`).run(status, updatedBy, gameId);
    return { rankingEligibilityStatus: status };
  };
  const admin = await applyEligibilityChange({ db, gameId: GAME_KEY, internalGameId: GAME_ID, status: "excluded", reason: "管理者確認", source: "admin", actor: "operator-1", persist });
  assert.equal(admin.status, "updated");
  const cron = await applyEligibilityChange({ db, gameId: GAME_KEY, internalGameId: GAME_ID, status: "eligible", source: "cron", actor: "reconcile", persist });
  assert.equal(cron.reason, "MANUAL_OVERRIDE_ACTIVE");
  const official = await applyEligibilityChange({ db, gameId: GAME_KEY, internalGameId: GAME_ID, status: "eligible", source: "cron", actor: "official-correction", officialCorrection: true, persist });
  assert.equal(official.status, "updated");
  database.close();
});

test("contest-scoped eligibility変更は同じ物理試合の別teamとlegacy ranking rowを変更しない", async () => {
  const { database, db } = createDatabase();
  database.prepare(`INSERT INTO contest_ranking_games
    (contest_id,internal_game_id,game_id,game_status,ranking_eligibility_status,ranking_eligibility_version,ranking_eligibility_updated_by)
    VALUES ('contest-f',?,'contest-f-game','scheduled','eligible',1,'system'),
           ('contest-m',?,'contest-m-game','scheduled','eligible',1,'system')`).run(GAME_ID, GAME_ID);
  const persist = async ({ contestId, status, reason, note, updatedBy }) => {
    database.prepare(`UPDATE contest_ranking_games SET ranking_eligibility_status=?, ranking_eligibility_reason=?,
      ranking_eligibility_note=?, ranking_eligibility_version=ranking_eligibility_version+1,
      ranking_eligibility_updated_by=? WHERE contest_id=?`).run(status, reason, note, updatedBy, contestId);
    return { rankingEligibilityStatus: status, contestId };
  };

  const result = await applyEligibilityChange({
    db, gameId: "contest-f-game", internalGameId: GAME_ID, contestId: "contest-f",
    status: "excluded", reason: "team-specific correction", source: "admin", actor: "operator-1",
    gameStatus: "cancelled", now: new Date("2026-09-20T02:00:00.000Z"), persist
  });

  assert.equal(result.status, "updated");
  assert.equal(result.eligibility.contestId, "contest-f");
  assert.deepEqual(
    database.prepare(`SELECT contest_id,game_status,ranking_eligibility_status FROM contest_ranking_games ORDER BY contest_id`).all().map(row => ({ ...row })),
    [
      { contest_id: "contest-f", game_status: "cancelled", ranking_eligibility_status: "excluded" },
      { contest_id: "contest-m", game_status: "scheduled", ranking_eligibility_status: "eligible" }
    ]
  );
  assert.deepEqual(
    { ...database.prepare("SELECT game_status,ranking_eligibility_status FROM ranking_games WHERE game_id=?").get(GAME_KEY) },
    { game_status: "scheduled", ranking_eligibility_status: "eligible" }
  );
  database.close();
});
