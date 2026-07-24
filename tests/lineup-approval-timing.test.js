import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const automationUrl = pathToFileURL(path.join(root, "pregame-automation.js")).href;
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const migration = fs.readFileSync(path.join(root, "migrations", "0015_lineup_candidates.sql"), "utf8");

test("正式スタメンは試合開始30分前まで候補として扱い、30分前以降だけ承認可能になる", async () => {
  const automation = await import(automationUrl);
  const timeline = automation.getPregameTimeline("2026-07-22-l-f-16");
  assert.equal(timeline.lineupAutoApprovalAt.toISOString(), "2026-07-22T08:30:00.000Z");
  assert.equal(automation.isLineupAutoApprovalDue(timeline, new Date("2026-07-22T08:29:59.000Z")), false);
  assert.equal(automation.isLineupAutoApprovalDue(timeline, new Date("2026-07-22T08:30:00.000Z")), true);
  assert.equal(automation.isLineupAutoApprovalDue(timeline, new Date("2026-07-22T09:00:00.000Z")), false);
});

test("開始時刻変更後は新しい日程から30分前の承認時刻を再計算する", async () => {
  const automation = await import(automationUrl);
  const gameId = "2026-09-01-f-e-1";
  automation.setDetectedScheduleGames([{ gameId, date: "2026-09-01", startTime: "18:00", status: "scheduled" }]);
  assert.equal(automation.getPregameTimeline(gameId).lineupAutoApprovalAt.toISOString(), "2026-09-01T08:30:00.000Z");
  automation.setDetectedScheduleGames([{ gameId, date: "2026-09-01", startTime: "19:00", status: "scheduled" }]);
  assert.equal(automation.getPregameTimeline(gameId).lineupAutoApprovalAt.toISOString(), "2026-09-01T09:30:00.000Z");
  automation.setDetectedScheduleGames([]);
});

test("Cronは候補をD1へ保存してから、30分前以降の有効な候補だけを本承認する", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS game_lineup_candidates/);
  assert.match(worker, /async function storeOfficialLineupCandidate/);
  assert.match(worker, /await storeOfficialLineupCandidate\(env\.AUTH_DB, gameId, actual, payload, detectedAt\)/);
  assert.match(worker, /if \(!isLineupAutoApprovalDue\(identity, now\)\) \{/);
  assert.match(worker, /return \{ status: "provisional"/);
  assert.match(worker, /approveActualLineupForAutoScoring\(env, gameId, actual\.lineup, detectedAt/);
});

test("不整合な候補は再試行対象として記録し、正式保存済みの試合は再承認しない", () => {
  assert.match(worker, /if \(!actual\.ok\) throw createPregameError\("INVALID_LINEUP"/);
  assert.match(worker, /recordPregameLineupAttempt\(env\.AUTH_DB, gameId, identity, now, error\)/);
  assert.match(worker, /if \(existing\) return \{ status: existing\.lineup_source/);
  assert.match(worker, /ctx\.waitUntil\(runScheduledGameAutomation\(env, scheduledAt\)\)/);
});
