// V3.5 Phase 2.6: derive diagnostic due slots from the canonical game start.
// This module is pure and is only used to fill missing diagnostic timing data.
import { V3_TIMING } from "./constants.js";
import {
  deriveV3DisplaySchedule,
  getV3ProbableStarterSlots,
  jstV3Slot,
  shiftV3IsoDate
} from "./domain.js";

export const V35_DUE_SCHEDULE_SOURCE = "derived_from_game_start";

function asDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function iso(value) {
  const date = asDate(value);
  return date ? date.toISOString() : null;
}

function uniqueSorted(values) {
  return [...new Map((Array.isArray(values) ? values : [])
    .map(asDate)
    .filter(Boolean)
    .map((date) => [date.toISOString(), date]))
    .values()]
    .sort((left, right) => left.getTime() - right.getTime())
    .map((date) => date.toISOString());
}

function stage(slots, { includeSlots = true } = {}) {
  const normalizedSlots = uniqueSorted(slots);
  return {
    dueAt: normalizedSlots[0] || null,
    source: V35_DUE_SCHEDULE_SOURCE,
    ...(includeSlots ? { slots: normalizedSlots } : {})
  };
}

function identitySlots(game, schedule) {
  const gameDate = String(game?.gameDate || game?.game_date || "").slice(0, 10);
  const pollingSlots = Array.isArray(schedule?.lineupPollingSlots) ? schedule.lineupPollingSlots : [];
  return uniqueSorted([
    jstV3Slot(shiftV3IsoDate(gameDate, -1), 18, 0),
    jstV3Slot(gameDate, 16, 0),
    schedule?.lineupPollingStart,
    ...pollingSlots
  ]);
}

export function deriveV35StageDueSchedule({ game = {} } = {}) {
  const startAt = asDate(game?.startAt || game?.start_at || game?.startTime || game?.start_time);
  if (!startAt) {
    return {
      available: false,
      source: "unavailable",
      stages: {}
    };
  }

  const schedule = deriveV3DisplaySchedule(game);
  const identity = identitySlots(game, schedule);
  const probableStarter = uniqueSorted(getV3ProbableStarterSlots(game));
  const roster = uniqueSorted(schedule.rosterFetchSlots);
  const lineup = uniqueSorted(schedule.lineupPollingSlots);
  const single = (value) => stage([value], { includeSlots: false });

  return {
    available: true,
    source: V35_DUE_SCHEDULE_SOURCE,
    startAt: iso(startAt),
    stages: {
      schedule_registration: single(schedule.startAt),
      npb_game_identify: stage(identity),
      probable_starter: stage(probableStarter),
      roster_fetch: stage(roster),
      prediction_close: single(schedule.predictionDeadline),
      lineup_fetch: stage(lineup),
      lineup_finalize: single(schedule.finalLineupAt),
      scoring: single(schedule.finalLineupAt),
      ranking_reflect: single(schedule.publicationAt),
      publish: single(schedule.publicationAt)
    },
    timing: {
      predictionDeadlineMinutes: V3_TIMING.predictionDeadlineMinutes,
      lineupPollingStartMinutes: V3_TIMING.lineupPollingStartMinutes,
      finalLineupMinutesAfterStart: V3_TIMING.finalLineupMinutesAfterStart,
      publicationMinutesAfterStart: V3_TIMING.publicationMinutesAfterStart
    }
  };
}
