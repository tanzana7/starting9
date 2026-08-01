import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertAllowedWorkflowTransition,
  claimWorkflowJob,
  completeWorkflowJob,
  createWorkflowJob,
  isWorkflowTransitionAllowed,
  listDueWorkflowJobs,
  retryWorkflowJob
} from "../game-workflow-jobs.js";

const internalGameId = "7fe6db3e-8a09-4d67-8f0e-18b6507d4b72";

function createJobDb() {
  const state = { jobs: [], nextId: 1 };
  return {
    state,
    prepare(sql) {
      return {
        bind(...bindings) {
          return {
            async run() {
              if (sql.includes("INSERT INTO game_job_runs")) {
                const [gameId, jobType, slot, source, maxAttempts] = bindings;
                if (state.jobs.some((job) => job.internal_game_id === gameId && job.job_type === jobType && job.scheduled_slot_at === slot)) return { meta: { changes: 0 } };
                state.jobs.push({ id: state.nextId++, internal_game_id: gameId, job_type: jobType, scheduled_slot_at: slot, status: "pending", source, attempt_count: 0, max_attempts: maxAttempts, next_attempt_at: null, lease_expires_at: null, claim_token: null });
                return { meta: { changes: 1 } };
              }
              if (sql.includes("SET status = 'claimed'")) {
                const [claimToken, now, lease, id] = bindings;
                const job = state.jobs.find((candidate) => candidate.id === id);
                const claimable = job && (job.status === "pending" || (job.status === "retry_wait" && job.next_attempt_at <= now) || (["claimed", "running"].includes(job.status) && job.lease_expires_at <= now));
                if (!claimable) return { meta: { changes: 0 } };
                Object.assign(job, { status: "claimed", claim_token: claimToken, claimed_at: now, started_at: now, lease_expires_at: lease, attempt_count: job.attempt_count + 1 });
                return { meta: { changes: 1 } };
              }
              if (sql.includes("SET status = 'succeeded'")) {
                const [now, , id, token] = bindings;
                const job = state.jobs.find((candidate) => candidate.id === id && candidate.claim_token === token && ["claimed", "running"].includes(candidate.status));
                if (!job) return { meta: { changes: 0 } };
                Object.assign(job, { status: "succeeded", completed_at: now, next_attempt_at: null, lease_expires_at: null });
                return { meta: { changes: 1 } };
              }
              if (sql.includes("SET status = ?1, completed_at")) {
                const [status, now, nextAttemptAt, errorCode, errorDetail, id, token] = bindings;
                const job = state.jobs.find((candidate) => candidate.id === id && candidate.claim_token === token && ["claimed", "running"].includes(candidate.status));
                if (!job) return { meta: { changes: 0 } };
                Object.assign(job, { status, completed_at: status === "permanently_failed" ? now : null, next_attempt_at: status === "retry_wait" ? nextAttemptAt : null, lease_expires_at: null, error_code: errorCode, error_detail: errorDetail });
                return { meta: { changes: 1 } };
              }
              throw new Error(`Unexpected write: ${sql}`);
            },
            async first() {
              if (sql.includes("SELECT * FROM game_job_runs")) {
                const [id, token] = bindings;
                return state.jobs.find((job) => job.id === id && job.claim_token === token) || null;
              }
              return null;
            },
            async all() {
              if (sql.includes("SELECT * FROM game_job_runs")) {
                const now = bindings[bindings.length - 2];
                const types = bindings.slice(0, -2);
                return { results: state.jobs.filter((job) => types.includes(job.job_type) && (job.status === "pending" || (job.status === "retry_wait" && job.next_attempt_at <= now) || (["claimed", "running"].includes(job.status) && job.lease_expires_at <= now))) };
              }
              return { results: [] };
            }
          };
        }
      };
    }
  };
}

test("same internal game, job type, and slot are created once", async () => {
  const db = createJobDb();
  const input = { internalGameId, jobType: "probable_starter_fetch", scheduledSlotAt: "2026-08-01T05:00:00.000Z" };
  assert.equal((await createWorkflowJob(db, input)).created, true);
  assert.equal((await createWorkflowJob(db, input)).created, false);
  assert.equal(db.state.jobs.length, 1);
});

test("succeeded and permanently failed jobs are not restarted automatically", async () => {
  const db = createJobDb();
  const input = { internalGameId, jobType: "probable_starter_fetch", scheduledSlotAt: "2026-08-01T05:00:00.000Z", maxAttempts: 1 };
  await createWorkflowJob(db, input);
  const claimed = await claimWorkflowJob(db, { jobId: 1, claimToken: "complete" });
  assert.equal(await completeWorkflowJob(db, { jobId: 1, claimToken: "complete" }), true);
  assert.equal((await createWorkflowJob(db, input)).created, false);
  assert.equal(await claimWorkflowJob(db, { jobId: 1, claimToken: "again" }), null);

  await createWorkflowJob(db, { ...input, jobType: "final_lineup_fetch" });
  const failed = await claimWorkflowJob(db, { jobId: 2, claimToken: "failure" });
  const outcome = await retryWorkflowJob(db, { job: failed, claimToken: "failure", errorCode: "RETRY_EXPIRED", nextAttemptAt: "2026-08-01T01:00:00.000Z" });
  assert.equal(outcome.status, "permanently_failed");
  assert.equal(await claimWorkflowJob(db, { jobId: 2, claimToken: "reopen" }), null);
});

test("only one runner claims a pending job and a matching token is required to complete it", async () => {
  const db = createJobDb();
  await createWorkflowJob(db, { internalGameId, jobType: "probable_starter_fetch", scheduledSlotAt: "2026-08-01T05:00:00.000Z" });
  const first = await claimWorkflowJob(db, { jobId: 1, now: new Date("2026-08-01T00:00:00.000Z"), claimToken: "first" });
  const second = await claimWorkflowJob(db, { jobId: 1, now: new Date("2026-08-01T00:00:01.000Z"), claimToken: "second" });
  assert.ok(first);
  assert.equal(second, null);
  assert.equal(await completeWorkflowJob(db, { jobId: 1, claimToken: "second" }), false);
  assert.equal(await completeWorkflowJob(db, { jobId: 1, claimToken: "first" }), true);
  assert.equal(await claimWorkflowJob(db, { jobId: 1, claimToken: "third" }), null);
});

test("expired lease is reclaimed and retry_wait is not due before next_attempt_at", async () => {
  const db = createJobDb();
  await createWorkflowJob(db, { internalGameId, jobType: "probable_starter_fetch", scheduledSlotAt: "2026-08-01T05:00:00.000Z" });
  const first = await claimWorkflowJob(db, { jobId: 1, now: new Date("2026-08-01T00:00:00.000Z"), leaseMilliseconds: 1_000, claimToken: "first" });
  assert.ok(first);
  const reclaimed = await claimWorkflowJob(db, { jobId: 1, now: new Date("2026-08-01T00:00:02.000Z"), claimToken: "second" });
  assert.equal(reclaimed.claim_token, "second");
  const retry = await retryWorkflowJob(db, { job: reclaimed, claimToken: "second", errorCode: "EXTERNAL_HTTP_ERROR", nextAttemptAt: "2026-08-01T01:00:00.000Z", now: new Date("2026-08-01T00:00:02.000Z") });
  assert.equal(retry.status, "retry_wait");
  assert.equal((await listDueWorkflowJobs(db, { jobTypes: ["probable_starter_fetch"], now: new Date("2026-08-01T00:30:00.000Z") })).length, 0);
  assert.equal((await listDueWorkflowJobs(db, { jobTypes: ["probable_starter_fetch"], now: new Date("2026-08-01T01:00:00.000Z") })).length, 1);
});

test("workflow transition table accepts recovery and rejects invalid jumps", () => {
  assert.equal(isWorkflowTransitionAllowed("lineup_pending", "retrying"), true);
  assert.equal(isWorkflowTransitionAllowed("service_unavailable", "lineup_pending"), true);
  assert.equal(isWorkflowTransitionAllowed("waiting", "published"), false);
  assert.throws(() => assertAllowedWorkflowTransition("waiting", "published"), { code: "WORKFLOW_TRANSITION_INVALID" });
});

test("Phase 2 migration and Worker use internal IDs without changing scoring or publication runners", async () => {
  const [migration, worker] = await Promise.all([
    readFile(new URL("../migrations/0024_game_workflow_jobs.sql", import.meta.url), "utf8"),
    readFile(new URL("../auth-worker.js", import.meta.url), "utf8")
  ]);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS game_workflow_state/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS game_job_runs/);
  assert.match(migration, /UNIQUE\(internal_game_id, job_type, scheduled_slot_at\)/);
  assert.match(worker, /shared\.probableStarter = await runDueProbableStarterWorkflowJobs\(env, now\)/);
  assert.match(worker, /maxAttempts: getProbableStarterJobMaxAttempts\(target\.startAt, now\)/);
  assert.match(worker, /mode: "legacy", \.\.\.\(await runDueProbableStarterJob\(env, now\)\)/);
  assert.match(worker, /runAdminProbableStarterWorkflowJob/);
  assert.match(worker, /handleAdminGameWorkflowAudit/);
  assert.match(worker, /path === "\/api\/admin\/audit\/game-workflows"/);
  assert.match(worker, /runDueAutoScoringJobs\(env, now, pausedGameIds\)/);
  assert.match(worker, /runDueGameDayPublicationJobs\(env, now, activeTimelines\)/);
});
