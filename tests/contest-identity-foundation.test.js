import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createContestId } from "../backend/contest-identity.js";
import teamContext from "../frontend/shared/team-context.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = path.join(ROOT, "migrations");
const FOUNDATION_NAME = "0046_contest_identity_foundation.sql";
const FOUNDATION_SQL = fs.readFileSync(path.join(MIGRATIONS, FOUNDATION_NAME), "utf8");
const LEGACY_GAMES = [
  ["fighters-home", "北海道日本ハムファイターズ", "千葉ロッテマリーンズ"],
  ["fighters-away", "千葉ロッテマリーンズ", "日本ハム"],
  ["marines-only", "千葉ロッテマリーンズ", "福岡ソフトバンクホークス"],
  ["ambiguous", "ファイターズ", "日本ハム"],
  ["missing-team", "", "千葉ロッテマリーンズ"]
];

function migrationFiles({ through = null } = {}) {
  return fs.readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql") && (!through || name <= through)).sort();
}

function applyMigrations(database, { through = null, foundationSql = FOUNDATION_SQL } = {}) {
  for (const name of migrationFiles({ through })) {
    database.exec(name === FOUNDATION_NAME ? foundationSql : fs.readFileSync(path.join(MIGRATIONS, name), "utf8"));
  }
}

function seedLegacyDatabase(database) {
  const now = "2026-10-19T00:00:00.000Z";
  database.prepare(`INSERT INTO users
    (id, username, username_normalized, password_hash, password_salt, password_iterations, status, role, created_at, updated_at)
    VALUES ('fixture-user', 'fixture', 'fixture', 'hash', 'salt', 1, 'active', 'user', ?, ?)`).run(now, now);
  const insertGame = database.prepare(`INSERT INTO games
    (internal_game_id, game_date, start_time, home_team, away_team, game_status, created_at, updated_at)
    VALUES (?, '2026-10-19', '18:00', ?, ?, 'scheduled', ?, ?)`);
  for (const [id, home, away] of LEGACY_GAMES) insertGame.run(id, home, away, now, now);
  database.prepare(`INSERT INTO predictions
    (id, user_id, game_id, internal_game_id, prediction_json, schema_version, game_date, home_team, away_team,
     opponent_code, is_home, submitted_at, updated_at)
    VALUES ('legacy-prediction', 'fixture-user', 'fighters-home', 'fighters-home', '{}', 1, '2026-10-19',
      '北海道日本ハムファイターズ', '千葉ロッテマリーンズ', 'm', 1, ?, ?)`).run(now, now);
  database.prepare(`INSERT INTO game_lineups
    (id, game_id, internal_game_id, actual_lineup_json, lineup_fingerprint, schema_version,
     lineup_detected_at, scoring_due_at, scoring_status, created_at, updated_at)
    VALUES ('legacy-lineup', 'fighters-home', 'fighters-home', '[]', 'fingerprint', 1, ?, ?, 'pending', ?, ?)`)
    .run(now, now, now, now);
  database.prepare(`INSERT INTO game_lineup_revisions
    (game_id, version, actual_lineup_json, lineup_fingerprint, source, created_at, reason, is_current, is_final)
    VALUES ('fighters-home', 1, '[]', 'fingerprint', 'manual', ?, 'fixture', 1, 1)`).run(now);
  database.prepare(`INSERT INTO game_automation_v3_state
    (internal_game_id, state, created_at, updated_at) VALUES ('fighters-home', 'scheduled', ?, ?)`)
    .run(now, now);
  database.prepare(`INSERT INTO game_jobs_v3
    (internal_game_id, job_type, scheduled_at, scheduled_slot_at, status, created_at, updated_at)
    VALUES ('fighters-home', 'score', ?, ?, 'pending', ?, ?)`)
    .run(now, now, now, now);
  database.prepare(`INSERT INTO game_scoring_revisions
    (id, internal_game_id, game_id, revision_number, lineup_revision_id, status, reason, created_by, created_at, is_active)
    VALUES ('legacy-score-rev', 'fighters-home', 'fighters-home', 1, 'fighters-home:1', 'completed', 'fixture', 'test', ?, 1)`)
    .run(now);
  database.prepare(`INSERT INTO ranking_reflection_revisions
    (id, internal_game_id, scoring_revision_id, ranking_eligibility_version, ranking_update_revision, status, created_at)
    VALUES ('legacy-ranking-rev', 'fighters-home', 'legacy-score-rev', 1, 1, 'reflected', ?)`)
    .run(now);
  database.prepare(`INSERT INTO ranking_games (game_id, game_status, created_at, updated_at)
    VALUES ('fighters-home', 'scored', ?, ?)`).run(now, now);
}

function makeLegacyDatabase() {
  const database = new DatabaseSync(":memory:");
  applyMigrations(database, { through: "0045_cron_heartbeat.sql" });
  seedLegacyDatabase(database);
  return database;
}

function tableSnapshot(database) {
  const schemas = database.prepare(`SELECT type, name, sql FROM sqlite_master
    WHERE type IN ('table', 'index', 'view', 'trigger')
      AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name`).all();
  const tables = schemas.filter((schema) => schema.type === "table");
  const rows = Object.fromEntries(tables.map(({ name }) => {
    const values = database.prepare(`SELECT * FROM "${name}"`).all().map((row) => ({ ...row }));
    values.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return [name, values];
  }));
  return { schemas, rows };
}

function insertContest(database, internalGameId, targetTeamKey, contestId = createContestId(internalGameId, targetTeamKey)) {
  database.prepare(`INSERT INTO game_contests (contest_id, internal_game_id, target_team_key)
    VALUES (?, ?, ?)`).run(contestId, internalGameId, targetTeamKey);
}

function assertIdentityContract(database) {
  const contests = database.prepare("SELECT internal_game_id, target_team_key FROM game_contests ORDER BY internal_game_id, target_team_key").all();
  assert.equal(contests.some((row) => row.internal_game_id === "marines-only" && row.target_team_key === "fighters"), false,
    "non-Fighters physical game got a Fighters contest");
  assert.equal(contests.some((row) => row.internal_game_id === "ambiguous"), false,
    "ambiguous legacy game got a contest");
  assert.equal(contests.some((row) => row.internal_game_id === "missing-team"), false,
    "missing participant identity got a contest");
  assert.equal(database.prepare("SELECT reason_code FROM contest_identity_backfill_issues WHERE internal_game_id = 'ambiguous'").get()?.reason_code,
    "multiple_fighters_sides");
  assert.equal(database.prepare("SELECT reason_code FROM contest_identity_backfill_issues WHERE internal_game_id = 'missing-team'").get()?.reason_code,
    "missing_participant_identity");
  assert.deepEqual(contests.filter((row) => row.target_team_key === "fighters").map((row) => row.internal_game_id),
    ["fighters-away", "fighters-home"]);
}

function assertDuplicateRejected(database, gameId, teamKey) {
  try {
    insertContest(database, gameId, teamKey, `duplicate-probe-${gameId}-${teamKey}`);
  } catch (error) {
    assert.match(error.message, /UNIQUE constraint failed/);
    return;
  }
  throw new Error("duplicate (physical game, target team) identity was accepted");
}

function assertUnknownTeamRejected(database, gameId) {
  assert.throws(() => database.prepare(`INSERT INTO game_contests (contest_id, internal_game_id, target_team_key)
    VALUES ('unknown-team-probe', ?, 'unknown-team')`).run(gameId), /FOREIGN KEY constraint failed/,
  "unregistered target team was accepted");
}

function assertUnknownGameRejected(database) {
  assert.throws(() => insertContest(database, "missing-game", "marines"), /FOREIGN KEY constraint failed/,
    "contest without a physical game was accepted");
}

test("fresh migration chain creates contest foundation and validates its foreign keys", () => {
  const database = new DatabaseSync(":memory:");
  try {
    applyMigrations(database);
    assert.deepEqual(database.prepare("PRAGMA table_info(game_contests)").all().map((row) => row.name),
      ["contest_id", "internal_game_id", "target_team_key", "created_at"]);
    assert.deepEqual(database.prepare("SELECT team_key FROM contest_identity_teams ORDER BY team_key").all().map((row) => row.team_key),
      ["fighters", "marines"]);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { database.close(); }
});

test("legacy migration preserves every existing table definition and row count while backfilling only proven Fighters games", () => {
  const database = makeLegacyDatabase();
  try {
    const before = tableSnapshot(database);
    database.exec(FOUNDATION_SQL);
    const after = tableSnapshot(database);
    assert.deepEqual(after.schemas.filter((table) => before.schemas.some((entry) => entry.name === table.name)), before.schemas);
    const existingRowsAfter = Object.fromEntries(Object.keys(before.rows).map((table) => [table, after.rows[table]]));
    assert.deepEqual(existingRowsAfter, before.rows, "an existing legacy row changed during the additive migration");
    assertIdentityContract(database);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_contests").get().count, 2);
    for (const { internal_game_id, contest_id } of database.prepare("SELECT internal_game_id, contest_id FROM game_contests").all()) {
      assert.equal(contest_id, createContestId(internal_game_id, "fighters"));
    }
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { database.close(); }
});

test("same physical game supports Fighters and Marines contests without duplicate identity", () => {
  const database = makeLegacyDatabase();
  try {
    database.exec(FOUNDATION_SQL);
    insertContest(database, "fighters-home", "marines");
    const rows = database.prepare("SELECT contest_id, target_team_key FROM game_contests WHERE internal_game_id = ? ORDER BY target_team_key").all("fighters-home");
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { contest_id: createContestId("fighters-home", "fighters"), target_team_key: "fighters" },
      { contest_id: createContestId("fighters-home", "marines"), target_team_key: "marines" }
    ]);
    assertDuplicateRejected(database, "fighters-home", "fighters");
    database.prepare(`INSERT INTO games
      (internal_game_id, game_date, start_time, home_team, away_team, game_status, created_at, updated_at)
      VALUES ('next-game', '2026-10-20', '18:00', '北海道日本ハムファイターズ', '千葉ロッテマリーンズ', 'scheduled', 'now', 'now')`).run();
    insertContest(database, "next-game", "fighters");
    assertUnknownTeamRejected(database, "fighters-home");
    assertUnknownGameRejected(database);
  } finally { database.close(); }
});

test("contest identity is deterministic, injective across components, and matches canonical Team Context keys", () => {
  assert.equal(teamContext.FIGHTERS.key, "fighters");
  assert.equal(teamContext.MARINES.key, "marines");
  const id = createContestId("m-f-25", teamContext.FIGHTERS.key);
  assert.equal(id, createContestId("m-f-25", "fighters"));
  assert.notEqual(id, createContestId("m-f-25", "marines"));
  assert.notEqual(createContestId("a_b", "fighters"), createContestId("a", "fighters"));
  assert.throws(() => createContestId("m-f-25", "f"), /Unknown canonical contest team/);
  assert.throws(() => createContestId("", "fighters"), /internalGameId is required/);
});

test("migration fault injection proves the uniqueness assertion catches a removed composite constraint", () => {
  const faultySql = FOUNDATION_SQL.replace("  UNIQUE (internal_game_id, target_team_key),\n", "");
  assert.notEqual(faultySql, FOUNDATION_SQL);
  const database = makeLegacyDatabase();
  try {
    database.exec(faultySql);
    assert.throws(() => assertDuplicateRejected(database, "fighters-home", "fighters"), /duplicate .* was accepted/);
  } finally { database.close(); }
});

test("migration fault injection proves the team registry FK rejects unregistered target keys", () => {
  const faultySql = FOUNDATION_SQL.replace(
    "  FOREIGN KEY (internal_game_id) REFERENCES games(internal_game_id) ON DELETE RESTRICT,\n  FOREIGN KEY (target_team_key) REFERENCES contest_identity_teams(team_key) ON DELETE RESTRICT",
    "  FOREIGN KEY (internal_game_id) REFERENCES games(internal_game_id) ON DELETE RESTRICT"
  );
  assert.notEqual(faultySql, FOUNDATION_SQL);
  const database = makeLegacyDatabase();
  try {
    database.exec(faultySql);
    assert.throws(() => assertUnknownTeamRejected(database, "fighters-home"), /unregistered target team was accepted/);
  } finally { database.close(); }
});

test("migration fault injection proves non-Fighters exclusion catches a blanket Fighters backfill", () => {
  const faultySql = FOUNDATION_SQL.replace("WHERE home_is_fighters + away_is_fighters = 1;", "WHERE 1 = 1;");
  assert.notEqual(faultySql, FOUNDATION_SQL);
  const database = makeLegacyDatabase();
  try {
    database.exec(faultySql);
    assert.throws(() => assertIdentityContract(database), /non-Fighters physical game got a Fighters contest/);
  } finally { database.close(); }
});

test("migration fault injection proves physical-game FK rejects contests without a registered game", () => {
  const faultySql = FOUNDATION_SQL.replace(
    "  FOREIGN KEY (internal_game_id) REFERENCES games(internal_game_id) ON DELETE RESTRICT,\n  FOREIGN KEY (target_team_key)",
    "  FOREIGN KEY (target_team_key)"
  );
  assert.notEqual(faultySql, FOUNDATION_SQL);
  const database = makeLegacyDatabase();
  try {
    database.exec(faultySql);
    assert.throws(() => assertUnknownGameRejected(database), /contest without a physical game was accepted/);
  } finally { database.close(); }
});
