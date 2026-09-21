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

## Not covered yet

The harness does not execute the complete prediction-close -> canonical
lineup -> score -> ranking -> publish pipeline. It also does not reproduce
JST calendar boundaries, correction/revision conflicts, CPU interruption,
parallel claims, or lease recovery across separate Worker invocations. Those
are the next phase and must not be inferred from the local query timings.

## Deferred items

Anything that needs an Auth Worker change, a production binding, production
Cron changes, or a production D1 write is intentionally not implemented in
this task. Those items require a separate review while the Auth Worker CPU
observation remains active.
