import { TEST_AUTH_DB_ID, TEST_AUDIT_DB_ID, TEST_CLOUDFLARE_ACCOUNT_ID, TEST_SITE_ID, TEST_AUTH_WORKER,
  isIsolatedTestEnvironment } from "./isolation.js";
import { FIGHTERS_REHEARSAL, isFightersRehearsalDriverWindow, isFightersRehearsalSeedWindow } from "./rehearsal-clock.js";
export { FIGHTERS_REHEARSAL, fightersRehearsal, isFightersRehearsalDay, isFightersRehearsalDriverWindow, isFightersRehearsalSeedWindow, simulatorRehearsalLifecycle }
  from "./rehearsal-clock.js";

export function isArmedFightersTestEnvironment(env = {}) {
  return isIsolatedTestEnvironment(env)
    && env.TEST_EXPECTED_ACCOUNT_ID === TEST_CLOUDFLARE_ACCOUNT_ID
    && env.TEST_SITE_ID === TEST_SITE_ID
    && env.TEST_WORKER_NAME === TEST_AUTH_WORKER
    && env.TEST_AUTH_DB_ID === TEST_AUTH_DB_ID
    && env.TEST_AUDIT_DB_ID === TEST_AUDIT_DB_ID;
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
