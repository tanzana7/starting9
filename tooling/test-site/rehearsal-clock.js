export const FIGHTERS_REHEARSAL = Object.freeze({
  scenario: "fighters-2026-10-25-1500",
  seed: 20261025,
  date: "2026-10-25",
  startAt: "2026-10-25T06:00:00.000Z",
  gameCode: "g-t-4",
  targetTeam: "fighters",
  userCount: 10,
  seedOpensAt: "2026-10-25T04:00:00.000Z",
  seedClosesAt: "2026-10-25T05:00:00.000Z",
  lineupAvailableAt: "2026-10-25T05:20:00.000Z",
  resultAvailableAt: "2026-10-25T09:30:00.000Z"
});

export function isFightersRehearsalDay(now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) return false;
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(current);
  return date === FIGHTERS_REHEARSAL.date;
}

export function isFightersRehearsalSeedWindow(now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  return !Number.isNaN(current.getTime())
    && current >= new Date(FIGHTERS_REHEARSAL.seedOpensAt)
    && current < new Date(FIGHTERS_REHEARSAL.seedClosesAt);
}

export function simulatorRehearsalLifecycle(now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) return { lineupAvailable: false, status: "scheduled", final: false };
  return {
    lineupAvailable: current >= new Date(FIGHTERS_REHEARSAL.lineupAvailableAt),
    status: current >= new Date(FIGHTERS_REHEARSAL.resultAvailableAt) ? "final"
      : current >= new Date(FIGHTERS_REHEARSAL.startAt) ? "live" : "scheduled",
    final: current >= new Date(FIGHTERS_REHEARSAL.resultAvailableAt)
  };
}
