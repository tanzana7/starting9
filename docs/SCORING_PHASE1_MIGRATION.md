# Scoring Phase 1 migration contract

This document records the Phase 1 boundary where the admin scoring-confirm
route requests the same V3 score job used by Cron. It is a migration guard,
not a runtime feature flag or a production operation procedure.

## Current paths

### Automatic V3 scoring

`game_jobs_v3` claims a `score` job with a lease and claim token. The V3 score
executor then:

1. reads the canonical finalized lineup;
2. rejects missing or invalid canonical lineup data;
3. creates a `score_attempts` staging record bound to the job and claim token;
4. stages prediction and supplemental TEST rows;
5. marks the attempt ready;
6. commits the attempt atomically with the active scoring revision and score
   history; and
7. completes the same job or returns a stale no-op when the lease/revision is
   no longer current.

The downstream `ranking_rebuild` and `publish` jobs require the resulting
canonical lineage. They are not allowed to use an older scoring revision.

### Administrator scoring confirm

The administrator still creates a preview through the existing preview core,
because that preview is the confirmation record and lineage input. Confirm
then validates the actor, preview lineage, deadline, canonical finalized
lineup, and current revision before idempotently creating a `score` job. It
returns `202` with the job identity; it does not write scores itself.

The exact job recovery route claims the stored job through the same repository
claim/lease contract and invokes the registered V3 executor through
`executeClaimedJobs`. A completed job is a no-op, a concurrently claimed job
is rejected (or observed as completed), and retryable failures keep the normal
V3 retry state. Therefore the old direct confirm implementation is no longer
the normal admin path:

| Contract | Automatic V3 | Admin confirm/recovery |
|---|---|---|
| Invocation | claimed `game_jobs_v3` score job | confirm queues the same job; `/jobs/:id/run` claims and runs it |
| Input identity | internal game ID + current job claim | internal game ID + preview ID + expected lineup revision |
| Preconditions | current lease, canonical final lineup, V3 state gate | preview lineage, actor, deadline, canonical final lineup, revision guard |
| Write model | score-attempt staging/commit | the same V3 score-attempt staging/commit |
| Duplicate guard | job identity + claim token + committed attempt | open/completed job idempotency + the same claim/attempt fencing |
| Downstream | normal V3 ranking and publication jobs | the same downstream ranking/publication jobs remain separate |

The legacy rescore implementation remains available for compatibility and
rollback analysis, but is not called by the normal V3 confirm route. Existing
legacy history is retained for read/audit compatibility; no schema migration
is required for this phase.

## Phase 1 implemented contract

The normalized request boundary is:

```text
internalGameId
expectedCanonicalLineupRevisionId
actor/source
reason
idempotencyKey
requestedAt
```

The administrator controller validates authentication, confirmation, preview
lineage, deadline, and the expected canonical revision, then enqueues the
same `game_jobs_v3` score job used by Cron. The heavy scoring write remains in
the V3 executor. The response is asynchronous (`202`) with the job identity
and current state. The admin job detail view exposes an exact-ID manual run
and retry action; both use the existing authenticated admin/CSRF boundary.

The manual run is intentionally a small recovery operation. It does not
create a replacement job, bypass the lease, or call the legacy scorer. The
same `score_attempts` fencing, canonical revision check, downstream job
creation, and retry lifecycle are used as the Cron path.

No schema change is required for the first phase. The existing job identity,
lease, retry, score-attempt fencing, active scoring revision, and canonical
artifact evaluator are sufficient. The current `source` argument to
`createV3Job` is not persisted in `game_jobs_v3`; source/audit information
must not be used as a correctness guard until that limitation is addressed.

## Safety gates for the migration

The conversion is safe only if all of the following remain true:

- no finalized canonical lineup means no score attempt;
- prediction close and lineup-finalization gates remain enforced;
- a stale expected revision is rejected before enqueueing or committing;
- repeated admin requests resolve to the same open/completed job identity;
- a second claim cannot commit the same canonical revision;
- ranking and publication are not created from a failed or uncommitted attempt;
- old legacy rows are preserved for read/audit compatibility until the
  migration window is complete;
- once a V3 score job exists for the request, recovery uses that job rather
  than creating a second scorer path.

Once a V3 attempt is committed, rollback must not re-run the legacy scorer for
the same canonical revision. Recovery must use the V3 job/result already
recorded.

## Cron planning contract

Planner generation and due-job execution are separate phases. An optimization
that returns early merely because there are no currently due jobs would be
unsafe if it also skips planning a newly due `prediction_close`, `score`,
`ranking_rebuild`, or `publish` job.

The safe sequence is:

1. perform a bounded, indexed game/planner pass for eligible games;
2. create deterministic missing jobs;
3. claim due jobs with the existing lease/cursor budget;
4. execute claims and record retry/continuation state; and
5. return early only after the planner has run and found no new work and the
   due queue is empty.

The first Cron optimization should therefore separate the cheap “is there
work?” probe from planner generation, or make the planner itself a bounded
due-window query. It must not bypass job creation.

## Phase 1 rollback

Rollback is a routing decision, not a database rewrite:

- before a V3 attempt is committed, a request can be rejected or safely
  retried through the pending/retry job lifecycle; do not run both scorers;
- after a V3 attempt is committed, continue through V3 ranking/publication;
- never run both scorers for the same canonical revision;
- retain the legacy implementation for read/audit compatibility, but keep it
  out of the normal V3 confirm route. If a rollback is required, stop new V3
  requests and use the job/attempt lineage to decide recovery; do not rewrite
  committed rows.

Production deployment is intentionally outside this Phase 1 change.
