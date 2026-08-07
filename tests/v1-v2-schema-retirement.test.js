import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = fs.readFileSync(path.join(root, "migrations", "0034_drop_retired_game_automation_health.sql"), "utf8");

test("0034 removes only the retired automation health table and is idempotent", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE game_automation_health (
      state_key TEXT PRIMARY KEY,
      cron_last_run_at TEXT,
      cron_last_success_at TEXT,
      cron_last_error_at TEXT,
      cron_last_error_code TEXT,
      processed_game_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    INSERT INTO game_automation_health (state_key, processed_game_count, updated_at)
    VALUES ('cron', 4, '2026-08-07T00:00:00.000Z');
    CREATE TABLE game_jobs_v3 (id INTEGER PRIMARY KEY, internal_game_id TEXT NOT NULL);
  `);

  database.exec(migration);
  database.exec(migration);

  assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'game_automation_health'").get(), undefined);
  assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'game_jobs_v3'").get());
});

test("current Worker has no runtime reference to game_automation_health", () => {
  const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
  assert.doesNotMatch(worker, /game_automation_health/);
  assert.doesNotMatch(worker, /AUTOMATION_HEALTH_STATE_KEY/);
});
