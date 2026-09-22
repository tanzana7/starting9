# Off-season isolated test environment

This repository now has a local-only synthetic workload harness for capacity
and release testing. It does not connect to Cloudflare, the production Auth
Worker, production D1, or production NPB services.

## Isolation contract

The fixture uses the planned names `starting9-offseason-test` for a separate
Pages project and D1 database, but this change does not create either resource
or copy any production secret. The executable test path uses an in-memory
SQLite database and a local auth origin placeholder only. Production IDs,
cookies, API keys, and user records must never be placed in the fixture.

Run it with:

```powershell
npm test -- tests/offseason-test-environment.test.js tests/offseason-load.test.js
```

The fixture supports a configurable base timestamp, six simultaneous games,
twelve teams, 324 synthetic players, 1,200 predictions, and 240 queued jobs.
The prediction deadline is derived from the production `V3_TIMING` contract,
not a test-only 30-minute constant. Scoring calls the shared pure scorer in
`backend/domain/scoring.js`; the harness does not maintain a second scoring
implementation.

## Capacity result

The load test runs representative due-job, scored-prediction, and per-game
aggregation queries against an in-memory SQLite schema matching the relevant
production `game_jobs_v3` columns, statuses, constraints, and indexes. The
production repository is used for due-job selection and claim/completion
state transitions through a local D1-shaped adapter. The repository currently
uses four 50-row batches per Cron invocation, for an effective maximum of 200
claims. The 240-row test therefore verifies one round of `200`, followed by a
second round of `40`. A direct repository page request is still clamped at
100 rows; that is an implementation detail of the current repository, not a
new local limit.

The test also verifies expired claimed leases, retry-compatible statuses,
claim tokens, attempt counts, cursor pagination, priority ordering, no
duplicate processing, and no remaining due rows. It prints elapsed
milliseconds for representative queries so changes to query shape or indexes
are visible in CI. These are local regression measurements, not production
Workers CPU or D1 SLOs.

The local SQLite schema is not Cloudflare D1: SQLite engine/version,
transaction scheduling, Worker CPU accounting, D1 latency, and concurrent
claim behavior differ. A separately provisioned test D1 is required for
those measurements.
Production benchmarking requires a separately provisioned test D1 and an
explicit later task; no production configuration is changed here.

## Operations follow-up

- Completed `game_jobs_v3_next` rows should have a documented retention class,
  owner, and bounded cleanup window. Cleanup must be a reviewed maintenance
  operation, never an implicit Cron side effect.
- Keep job history and operational audit data separate from formal scoring,
  ranking, and publication truth. Monitor row counts by status and age before
  choosing retention windows.
- Use GitHub `main` as the only release source. Record the Git SHA, component
  version (for example, Worker version), and UTC deploy timestamp in the
  release record. A deploy record must not contain secrets.
- Before any future test Pages/D1 provisioning, configure test-only origins,
  test-only bindings, and synthetic accounts. Do not reuse production Auth
  Worker URLs or D1 IDs.

## Formal pipeline coverage

The formal-pipeline fixture uses the actual migration schema, the production
Auth Worker request handlers for canonical lineup finalization, the V3 planner
and orchestrator, and `executeGameAutomationV3Job` for six simultaneous
synthetic games. It verifies the deadline gate, canonical revision lineage,
score attempt activation, ranking reflection, publication, and the resulting
artifact evaluator state. A failure-injection test throws once from the real
ranking stage, then resumes at a later controlled clock so the production retry
path—not a test-only ranking or publication implementation—completes the run.

This is still an in-memory Node SQLite test. It does not prove Cloudflare
Workers CPU limits, D1 latency/locking, cross-invocation parallel claims, or
lease recovery on separate Worker instances. It also does not cover JST
calendar boundary cases, correction/revision conflicts, or production API
read behavior. Those remain separate tests and must not be inferred from the
local formal-pipeline result.

The formal-pipeline regression now uses three independent synthetic users for
each of the six games. One prediction is a perfect lineup (99 points), while
the other two keep the same nine players but rotate their order/position
assignment (45 points each), so the expected totals and the tied rank are
defined from the fixture input rather than copied from the ranking result.
The test reads the production ranking repository output and checks total,
average, games played, qualification, and rank for all three users.

The retry test also reads the job row directly. It checks the original
`ranking_rebuild` job ID, `UNEXPECTED_EXCEPTION`, `retry_wait`, attempt 1,
reclaim of that same ID at attempt 2, and final `completed` state. For every
game it independently checks one completed active scoring revision, one
reflected ranking revision, three prediction-score history rows, one committed
score attempt, and one published `game_lineups`/`ranking_games` artifact. The
schema has no separate append-only publication-history table; those two
published rows are the publication artifacts checked by this fixture.

The fixture intentionally does not claim to reproduce JST boundary behavior or
fully control every timestamp: Cron time is injected, but manual finalize
handlers still use their production request-time clock. It also does not test
simultaneous claims from multiple Worker instances, Cloudflare Workers CPU
limits, Cloudflare D1 latency/locking, or the complete production API read
surface. Those items remain unverified and require separate environment-level
tests.

## Deferred items

Anything that needs an Auth Worker change, a production binding, production
Cron changes, or a production D1 write is intentionally not implemented in
this task. Those items require a separate review while the Auth Worker CPU
observation remains active.
