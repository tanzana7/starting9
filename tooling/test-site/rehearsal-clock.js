const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const REHEARSAL_START_HOUR_JST = 15;

function jstDate(now) {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`;
}

function shift(base, minutes) {
  return new Date(base.getTime() + minutes * 60_000).toISOString();
}

/**
 * The unattended rehearsal is anchored to the current JST day, so the same
 * real-time scenario (Fighters at 15:00 JST against the Hawks sibling) can run
 * on any date without editing constants. Only the game start time and the
 * roster source are time-dependent facts; every window below derives from the
 * 15:00 JST first pitch.
 */
export function fightersRehearsal(now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  const date = jstDate(Number.isNaN(current.getTime()) ? new Date() : current);
  const startAt = new Date(`${date}T${String(REHEARSAL_START_HOUR_JST).padStart(2, "0")}:00:00+09:00`);
  return Object.freeze({
    // A stable scenario id and seed keep the same synthetic identities across
    // days; only the fixture date and first pitch move with the calendar.
    scenario: "fighters-rolling-1500",
    seed: 20261025,
    date,
    startAt: startAt.toISOString(),
    gameCode: "g-t-4",
    targetTeam: "fighters",
    userCount: 10,
    // Predictions seed two hours before first pitch and close one hour before.
    seedOpensAt: shift(startAt, -120),
    seedClosesAt: shift(startAt, -60),
    lineupAvailableAt: shift(startAt, -40),
    resultAvailableAt: shift(startAt, 210),
    driverOpensAt: shift(startAt, -180),
    driverClosesAt: shift(startAt, 420)
  });
}

const REHEARSAL_FIELDS = Object.keys(fightersRehearsal(new Date("2026-01-01T00:00:00Z")));

/**
 * Compatibility view: existing call sites read FIGHTERS_REHEARSAL.<field>.
 * Each access resolves the current day so long-lived Workers and chained runs
 * never carry a stale scenario date.
 */
export const FIGHTERS_REHEARSAL = Object.freeze(Object.defineProperties(
  {},
  Object.fromEntries(REHEARSAL_FIELDS.map((field) => [field, {
    enumerable: true,
    get: () => fightersRehearsal(new Date())[field]
  }]))
));

export function isFightersRehearsalDay(now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) return false;
  return jstDate(current) === fightersRehearsal(current).date;
}

export function isFightersRehearsalSeedWindow(now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) return false;
  const scenario = fightersRehearsal(current);
  return current >= new Date(scenario.seedOpensAt) && current < new Date(scenario.seedClosesAt);
}

export function isFightersRehearsalDriverWindow(now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) return false;
  const scenario = fightersRehearsal(current);
  return current >= new Date(scenario.driverOpensAt) && current < new Date(scenario.driverClosesAt);
}

export function simulatorRehearsalLifecycle(now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) return { lineupAvailable: false, status: "scheduled", final: false };
  const scenario = fightersRehearsal(current);
  return {
    lineupAvailable: current >= new Date(scenario.lineupAvailableAt),
    status: current >= new Date(scenario.resultAvailableAt) ? "final"
      : current >= new Date(scenario.startAt) ? "live" : "scheduled",
    final: current >= new Date(scenario.resultAvailableAt)
  };
}
