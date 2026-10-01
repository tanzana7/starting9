import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function applyMigrations(database, directory) {
  const migrationDirectory = path.join(root, directory);
  for (const filename of fs.readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(fs.readFileSync(path.join(migrationDirectory, filename), "utf8"));
  }
}

function tableNames(database) {
  return database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map(({ name }) => name);
}

function tableCount(database, table) {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count);
}

function seedSourceDatabases() {
  const auth = new DatabaseSync(":memory:");
  const audit = new DatabaseSync(":memory:");
  applyMigrations(auth, "migrations");
  applyMigrations(audit, "migrations-audit");

  auth.exec(`
    INSERT INTO users (id, username, username_normalized, password_hash, password_salt, password_iterations, created_at, updated_at)
    VALUES ('user-1', 'admin', 'admin', 'hash', 'salt', 100000, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_used_at)
    VALUES ('session-1', 'user-1', 'token-hash', '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    INSERT INTO admin_push_subscriptions (id, admin_user_id, endpoint, p256dh, auth, created_at, updated_at)
    VALUES ('push-1', 'user-1', 'https://push.example/subscription', 'p256dh', 'auth', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    INSERT INTO admin_alert_incidents (id, internal_game_id, alert_type, severity, dedupe_key, title, body, action_path, first_seen_at, last_seen_at)
    VALUES ('incident-1', 'game-1', 'cron_stalled', 'warning', 'game-1:cron_stalled', 'Cron stalled', 'Diagnostic history', '/admin-v3.html', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
  `);
  audit.prepare(`
    INSERT INTO game_automation_v3_audit
      (internal_game_id, job_type, occurred_at, source, event_type)
    VALUES (?, ?, ?, ?, ?)
  `).run("game-1", "score", "2026-10-01T00:00:00.000Z", "cron", "job");
  return { auth, audit };
}

test("full export into a new empty target preserves operational data, then cleans only push subscriptions", () => {
  const source = seedSourceDatabases();
  const targetSchema = { auth: new DatabaseSync(":memory:"), audit: new DatabaseSync(":memory:") };
  applyMigrations(targetSchema.auth, "migrations");
  applyMigrations(targetSchema.audit, "migrations-audit");

  // DatabaseSync serialization is a local stand-in for a full D1 export/import.
  // The real Cloudflare export/import remains intentionally unexecuted here.
  const imported = {
    auth: new DatabaseSync(":memory:"),
    audit: new DatabaseSync(":memory:")
  };
  imported.auth.deserialize(source.auth.serialize());
  imported.audit.deserialize(source.audit.serialize());

  assert.deepEqual(tableNames(imported.auth), tableNames(targetSchema.auth));
  assert.deepEqual(tableNames(imported.audit), tableNames(targetSchema.audit));
  for (const table of ["users", "sessions", "admin_alert_incidents"]) {
    assert.equal(tableCount(imported.auth, table), tableCount(source.auth, table), table);
  }
  assert.equal(tableCount(imported.audit, "game_automation_v3_audit"), 1);

  imported.auth.exec("DELETE FROM admin_push_subscriptions");
  assert.equal(tableCount(imported.auth, "admin_push_subscriptions"), 0);
  assert.equal(tableCount(imported.auth, "admin_alert_incidents"), 1);
  assert.equal(tableCount(imported.auth, "sessions"), 1);
  assert.deepEqual(imported.auth.prepare("PRAGMA foreign_key_check").all(), []);

  source.auth.close();
  source.audit.close();
  targetSchema.auth.close();
  targetSchema.audit.close();
  imported.auth.close();
  imported.audit.close();
});
