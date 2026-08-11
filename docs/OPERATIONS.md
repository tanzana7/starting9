# Operations Guide

## Normal Operation

The Auth Worker Cron runs every minute. When `ENABLE_GAME_AUTOMATION_V3=true`, it plans and executes V3 jobs for active canonical games. The public page is read-only with respect to workflow state; it does not run V3 jobs or repair data.

The Cron lifecycle is stable across the V3 modules: `repository` loads canonical games and state, `domain` derives JST timing, planners emit idempotent job decisions, `orchestrator` claims due rows under a lease, `executor` invokes the Worker-provided job handler, and pure `audit`/`diagnostics` builders feed the Worker persistence adapter. The decomposition must not change job type, scheduled slot, API contract, schema, or retry behavior.

Admin V3 is the operational surface for:

- Today Ops and per-game workflow status
- job state, attempts, leases, retry reasons, and audit entries
- lineup and scoring revision review
- ranking eligibility and publication review
- schedule and NPB identity diagnostics

## Read-Only First Troubleshooting

When a game appears stuck, inspect these in order:

1. The canonical `internalGameId` and game state.
2. The latest V3 overview and job timeline.
3. The job type, scheduled slot, status, attempt count, and failure code.
4. The relevant canonical row: roster snapshot, probable starter, lineup revision, or scoring revision.
5. The latest structured audit entry and Cron summary.

Do not edit D1 rows directly, re-run migrations, or use repair endpoints to bypass an unknown failure. A production repair requires a separately reviewed task with a dry-run, reason, audit record, and rollback plan.

Roster policy is likewise operational, not a manual data-fix flow: before the same-day NPB announcement window, a still-valid baseline roster can support prediction input. Fresh same-day snapshot data takes precedence once available. An expired, stale, or unknown snapshot is not presented as fresh data.

## Failure Classification

Prefer the most specific code available:

- `*_NOT_ANNOUNCED` or `*_UNAVAILABLE`: normal upstream waiting
- `*_FETCH_FAILED` or network errors: retryable upstream failure
- `*_PARSE_FAILED` or `*_INTEGRITY_ERROR`: data or parser attention
- `MISSING_EXECUTOR` or `UNEXPECTED_EXCEPTION`: application attention
- `manual_action_required`: terminal operational state requiring review

The admin UI should distinguish waiting, retrying, failed, and completed jobs. A future scheduled slot is not an existing job until a `game_jobs_v3` row exists.

## Logging Rules

Structured logs may include game UUIDs, job types, status, slot times, safe failure codes, and counts needed for diagnosis. Never log authentication tokens, full cookies, passwords, request bodies containing private user data, or raw secret values.

The NPB Fetch Worker has bounded debug diagnostics for parser investigation. These diagnostics are not a replacement for authorization and should not be copied into the public UI.

## Preflight Checklist

- Production Worker version and bindings match the intended release.
- Pages production alias returns the intended asset cache busters.
- The target game is canonical and has a valid JST start time.
- Due jobs are present once per game, type, and scheduled slot.
- No unexplained failed or `manual_action_required` job exists.
- The public page shows only user-facing game, prediction, and result information.
- No production D1 write, repair, or reset operation is performed during observation.
