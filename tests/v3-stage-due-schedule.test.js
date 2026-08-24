import test from "node:test";
import assert from "node:assert/strict";
import { deriveV35StageDueSchedule } from "../backend/automation-v3/stage-due-schedule.js";

const GAME = {
  internalGameId: "11111111-1111-4111-8111-111111111111",
  gameDate: "2026-08-25",
  startAt: "2026-08-25T09:00:00.000Z"
};

const jst = (value) => new Date(value).toLocaleString("ja-JP", {
  timeZone: "Asia/Tokyo",
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
});

test("derives Phase 2.6 due schedule from the canonical start time", () => {
  const schedule = deriveV35StageDueSchedule({ game: GAME });
  assert.equal(schedule.available, true);
  assert.equal(schedule.source, "derived_from_game_start");
  assert.equal(jst(schedule.stages.npb_game_identify.dueAt), "2026/08/24 18:00");
  assert.equal(jst(schedule.stages.probable_starter.dueAt), "2026/08/24 18:00");
  assert.deepEqual(schedule.stages.roster_fetch.slots.map(jst), [
    "2026/08/25 16:00",
    "2026/08/25 16:02",
    "2026/08/25 16:10"
  ]);
  assert.equal(jst(schedule.stages.prediction_close.dueAt), "2026/08/25 17:00");
  assert.deepEqual(schedule.stages.lineup_fetch.slots.map(jst), [
    "2026/08/25 17:10",
    "2026/08/25 17:20",
    "2026/08/25 17:30",
    "2026/08/25 17:40",
    "2026/08/25 17:50",
    "2026/08/25 18:00"
  ]);
  assert.equal(jst(schedule.stages.lineup_finalize.dueAt), "2026/08/25 18:02");
  assert.equal(jst(schedule.stages.scoring.dueAt), "2026/08/25 18:02");
  assert.equal(jst(schedule.stages.ranking_reflect.dueAt), "2026/08/25 18:10");
  assert.equal(jst(schedule.stages.publish.dueAt), "2026/08/25 18:10");
});

test("invalid start time produces an unavailable diagnostic schedule without side effects", () => {
  const schedule = deriveV35StageDueSchedule({ game: { internalGameId: "invalid" } });
  assert.deepEqual(schedule, { available: false, source: "unavailable", stages: {} });
});
