# Scoring Phase 1 migration contract

This document records the Phase 0 boundary before the admin scoring-confirm
route is moved to the V3 score job path. It is a migration guard, not a
runtime feature flag or a production operation procedure.

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

The V3 route currently validates the rescore preview and lineage, then calls
the legacy rescore preview/confirm core with `deferPublication: true`.
Therefore it is not yet equivalent to the V3 score executor:

| Contract | Automatic V3 | Admin confirm today |
|---|---|---|
| Invocation | claimed `game_jobs_v3` score job | authenticated HTTP admin route |
| Input identity | internal game ID + current job claim | game ID + preview ID + lineup version |
| Preconditions | current lease, canonical final lineup, V3 state gate | preview lineage, admin confirmation, legacy rescore rules |
| Write model | score attempt staging/commit | legacy rescore core and its history tables |
| Duplicate guard | job identity + claim token + committed attempt | preview/lineage checks; not the same job contract |
| Downstream | normal V3 ranking and publication jobs | publication deferred, then separate V3/admin continuation |

This difference is intentional in Phase 0. The admin route must not be
silently switched until the input conversion and historical-write behavior
are tested against the V3 contract.

## Phase 1 target

The smallest safe change is to add an internal scoring command service that
accepts the following normalized input:

```text
internalGameId
expectedCanonicalLineupRevisionId
actor/source
reason
idempotencyKey
requestedAt
```

The administrator controller should validate authentication, confirmation,
preview lineage, and the expected revision, then enqueue or resume the same
`game_jobs_v3` score job used by Cron. The heavy scoring write must remain in
the V3 executor. The response should be asynchronous (`202`) with the job
identity and current state, rather than performing a second scoring
implementation in the HTTP handler.

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
- rollback routes admin confirm back to the legacy path only while no V3
  attempt has been committed for that request.

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

- before a V3 attempt is committed, route a rejected admin request back to
  the existing legacy preview/confirm flow;
- after a V3 attempt is committed, continue through V3 ranking/publication;
- never run both scorers for the same canonical revision;
- retain the old route until contract tests and isolated correction/retry
  tests pass.

Production deployment is intentionally outside this Phase 0 change.
