import { TEST_AUTH_DB_ID, TEST_AUDIT_DB_ID, TEST_CLOUDFLARE_ACCOUNT_ID, TEST_SITE_ID, TEST_AUTH_WORKER,
  TEST_CRON_TRIGGERS, isIsolatedTestEnvironment } from "./isolation.js";

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

export function isArmedFightersTestEnvironment(env = {}) {
  return isIsolatedTestEnvironment(env)
    && env.TEST_EXPECTED_ACCOUNT_ID === TEST_CLOUDFLARE_ACCOUNT_ID
    && env.TEST_SITE_ID === TEST_SITE_ID
    && env.TEST_WORKER_NAME === TEST_AUTH_WORKER
    && env.TEST_AUTH_DB_ID === TEST_AUTH_DB_ID
    && env.TEST_AUDIT_DB_ID === TEST_AUDIT_DB_ID;
}

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

export function shouldSeedFightersRehearsal({ env = {}, now, game = null, predictionCount = 0 } = {}) {
  if (!isArmedFightersTestEnvironment(env)) return { allowed: false, reason: "test_environment_required" };
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) return { allowed: false, reason: "invalid_time" };
  if (!isFightersRehearsalSeedWindow(current)) return { allowed: false, reason: "outside_seed_window" };
  if (game?.game_date !== FIGHTERS_REHEARSAL.date
      || game?.provider_game_id !== FIGHTERS_REHEARSAL.gameCode
      || game?.target_team_key !== FIGHTERS_REHEARSAL.targetTeam
      || Date.parse(String(game?.start_time || "")) !== Date.parse(FIGHTERS_REHEARSAL.startAt)) {
    return { allowed: false, reason: "target_identity_mismatch" };
  }
  if (game?.state !== "scheduled") return { allowed: false, reason: "prediction_window_not_open" };
  const count = Number(predictionCount);
  if (!Number.isInteger(count) || count < 0 || count >= FIGHTERS_REHEARSAL.userCount) {
    return { allowed: false, reason: count >= FIGHTERS_REHEARSAL.userCount ? "already_seeded" : "invalid_prediction_count" };
  }
  return { allowed: true, reason: count ? "resume_partial_seed" : "seed" };
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
