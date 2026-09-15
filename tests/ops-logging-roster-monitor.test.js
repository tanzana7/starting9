import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildV3RosterMonitor, shouldPersistV3Audit } from "../auth-worker.js";
import { buildV3CronJobAuditInsert, classifyV3AuditEvent } from "../backend/automation-v3/audit.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("position picker hidden state is stronger than the scoped display rule", () => {
  const css = fs.readFileSync(path.join(root, "admin-v3.css"), "utf8");
  assert.match(css, /\.manual-lineup-position-control \.position-menu\.hidden\s*\{\s*display:\s*none;/);
});

test("audit classification separates important categories without changing routine policy", () => {
  assert.deepEqual(classifyV3AuditEvent({ eventType: "roster_changed", jobType: "roster_fetch" }), { severity: "INFO", category: "ROSTER" });
  assert.deepEqual(classifyV3AuditEvent({ eventType: "score_attempt_stale", jobType: "score", execution: { status: "stale" } }), { severity: "ERROR", category: "ERROR" });
  assert.deepEqual(classifyV3AuditEvent({ eventType: "admin_operation", source: "admin" }), { severity: "INFO", category: "ADMIN" });
  const record = buildV3CronJobAuditInsert({
    auditColumns: new Set(["event_type", "severity", "category", "team_id", "revision_id", "attempt_id", "reason_code", "metadata_json"]),
    eventType: "roster_changed",
    internalGameId: "game-1",
    execution: { jobType: "roster_fetch", status: "changed", teamId: "fighters", revisionId: "rev-1", attemptId: "attempt-1", reasonCode: "ROSTER_CHANGED", metadata: { beforeCount: 25, afterCount: 26 } }
  });
  assert.equal(record.severity, "INFO");
  assert.equal(record.category, "ROSTER");
  assert.equal(record.values[record.columns.indexOf("team_id")], "fighters");
  assert.match(record.values[record.columns.indexOf("metadata_json")], /beforeCount/);
});

test("routine/no-op audit suppression remains bounded for repeated cron and roster checks", () => {
  for (let index = 0; index < 1000; index += 1) {
    assert.equal(shouldPersistV3Audit({ eventType: "job", job: { status: "completed" }, execution: { status: "completed" } }), false);
  }
  for (let index = 0; index < 100; index += 1) {
    assert.equal(shouldPersistV3Audit({ eventType: "roster_fetch", execution: { status: "unchanged" } }), false);
  }
  assert.equal(shouldPersistV3Audit({ eventType: "roster_changed", execution: { status: "changed" } }), true);
  assert.equal(shouldPersistV3Audit({ eventType: "roster_fetch_failed", execution: { status: "failed" } }), true);
});

test("roster monitor is a derived read model and exposes fallback/manual counts", () => {
  const monitor = buildV3RosterMonitor([
    {
      homeTeam: "fighters",
      rosterDiagnostics: {
        publicCandidateSource: "stale_snapshot",
        publicCandidateOfficialPlayerCount: 28,
        rosterSnapshotExists: true,
        rosterSnapshotCapturedAt: "2026-09-15T00:00:00.000Z",
        isSnapshotStale: true,
        staleReason: "ROSTER_SOURCE_STALE",
        previousSnapshotComparison: { mismatch: true },
        sourceFetchedAt: "2026-09-15T00:01:00.000Z"
      }
    }
  ], { manualRoster: { schemaAvailable: true, source: "manual", isManualSaved: true, entries: [{ status: "active" }, { status: "inactive" }] } });
  assert.equal(monitor.status, "WARN");
  assert.equal(monitor.source, "stale_snapshot");
  assert.equal(monitor.playerCount, 28);
  assert.equal(monitor.candidateCount, 1);
  assert.equal(monitor.rosterOutCandidateCount, 1);
  assert.equal(monitor.fallback, true);
});

test("roster monitor has no target game and remains safe instead of blocking overview", () => {
  const monitor = buildV3RosterMonitor([], { manualRoster: { schemaAvailable: false, entries: [] } });
  assert.equal(monitor.status, "WARN");
  assert.equal(monitor.playerCount, 0);
  assert.equal(monitor.candidateCount, null);
});
