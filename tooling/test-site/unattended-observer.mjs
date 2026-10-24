import { pathToFileURL } from "node:url";

const SCENARIO_DATE = "2026-10-25";
const TEST_AUTH_ORIGIN = "https://starting9-test-auth.starting9.workers.dev";
const CHECKPOINT_BY_CRON = new Map([
  ["30 4 * * *", "before_cutoff"],
  ["5 5 * * *", "after_cutoff"],
  ["30 6 * * *", "after_lineup"],
  ["0 11 * * *", "final"]
]);

export function evaluateUnattendedCheckpoint(checkpoint, payload) {
  if (payload?.ok !== true || payload?.game?.providerGameId !== "g-t-4"
      || payload?.game?.date !== SCENARIO_DATE
      || Date.parse(payload?.game?.startAt) !== Date.parse("2026-10-25T06:00:00.000Z")) {
    return { ok: false, code: "schedule_not_discovered" };
  }
  const fighters = payload.fighters || {};
  const jobs = fighters.jobs || {};
  if (checkpoint === "before_cutoff") {
    return fighters.predictions === 10 && fighters.distinctPredictionUsers === 10
      ? { ok: true } : { ok: false, code: "predictions_not_seeded" };
  }
  if (checkpoint === "after_cutoff") {
    return ["prediction_closed", "lineup_ready", "scored", "ranked", "published"].includes(fighters.state)
      ? { ok: true } : { ok: false, code: "prediction_not_closed" };
  }
  if (checkpoint === "after_lineup") {
    if (!fighters.finalLineupRevisionPresent || fighters.officialLineupRows !== 9) {
      return { ok: false, code: "lineup_missing" };
    }
    return { ok: true };
  }
  if (checkpoint === "final") {
    if (fighters.state !== "published" || fighters.predictions !== 10 || fighters.scoredPredictions !== 10) {
      return { ok: false, code: "scoring_or_publication_missing" };
    }
    if (fighters.rankingReflected !== true || fighters.publicationStatus !== "published"
        || fighters.publicationArtifacts !== 1) return { ok: false, code: "ranking_or_publication_missing" };
    if (Number(jobs.failed || 0) || Number(jobs.retry_wait || 0) || Number(jobs.claimed || 0)
        || Number(jobs.pending || 0)) return { ok: false, code: "stuck_job" };
    const jobTypes = fighters.jobTypes || {};
    for (const type of ["prediction_close", "lineup_fetch", "lineup_finalize", "score", "ranking_rebuild", "publish"]) {
      if (Number(jobTypes[type]?.completed || 0) < 1) return { ok: false, code: `job_incomplete_${type}` };
    }
    if (payload.rosterCount !== 15) return { ok: false, code: "roster_missing" };
    if (payload.hawks?.state !== "published" || payload.hawks?.publicationStatus !== "published"
        || payload.hawks?.publicationCount !== 1) return { ok: false, code: "hawks_sibling_changed" };
    return { ok: true };
  }
  return { ok: false, code: "unknown_checkpoint" };
}

async function run() {
  const japanDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
  if (japanDate !== SCENARIO_DATE) {
    console.log(`UNATTENDED_OBSERVER_NOOP date=${japanDate}`);
    return;
  }
  const schedule = String(process.env.GITHUB_EVENT_SCHEDULE || "");
  const checkpoint = CHECKPOINT_BY_CRON.get(schedule);
  if (!checkpoint) throw new Error("observer_checkpoint_unmapped");

  const healthResponse = await fetch(`${TEST_AUTH_ORIGIN}/health`, { method: "GET", cache: "no-store" });
  if (!healthResponse.ok) throw new Error("test_worker_health_failed");
  const health = await healthResponse.json();
  if (health?.environment !== "test" || health?.service !== "starting9-test-auth") {
    throw new Error("test_worker_identity_mismatch");
  }

  const observerResponse = await fetch(`${TEST_AUTH_ORIGIN}/api/test/rehearsal/observer?testTeam=fighters`, {
    method: "GET", cache: "no-store", headers: { Accept: "application/json" }
  });
  if (!observerResponse.ok) throw new Error(`observer_read_failed_${observerResponse.status}`);
  const payload = await observerResponse.json();
  const result = evaluateUnattendedCheckpoint(checkpoint, payload);
  if (!result.ok) throw new Error(`${checkpoint}:${result.code}`);

  if (checkpoint === "final") {
    const source = await fetch("https://s9simu.pages.dev/simu-npb/scores/2026/1025/g-t-4/?team=fighters", {
      method: "GET", cache: "no-store"
    });
    const html = source.ok ? await source.text() : "";
    if (!source.ok || !/data-game-status="final"/.test(html)) throw new Error("final_result_source_unavailable");
    console.log("FIGHTERS 2026-10-25 UNATTENDED AUTOMATION PASS");
  } else {
    console.log(`UNATTENDED_OBSERVER_CHECKPOINT_PASS checkpoint=${checkpoint}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    const safe = /^[a-z0-9:_-]{1,100}$/i.test(String(error?.message || ""))
      ? error.message : "observer_failed";
    console.error(`UNATTENDED_OBSERVER_FAIL ${safe}`);
    process.exitCode = 1;
  });
}
