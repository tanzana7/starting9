# Admin V3 Features

## Access

Admin V3 uses the existing session and server-side `requireAdminUser` authorization. A signed-in non-admin user must not be able to read operational data or invoke mutation endpoints.

## Main Areas

- **Dashboard / Today Ops**: daily game coverage, Cron freshness, open jobs, retry and failure counts.
- **Games**: canonical game identity, schedule, NPB identity, and lifecycle state.
- **Progress**: per-game timeline and next action.
- **Lineup**: fetched lineup, revisions, finalization, and historical revisions.
- **Scoring and ranking**: scoring revisions, previews, rebuild jobs, eligibility, and publication readiness.
- **Schedule**: start time and schedule metadata with audit history.
- **Diagnostics and audit**: structured V3 audit, job detail, and safe failure context.

## Safe Operations

Operational changes require the canonical `internalGameId`, validate ownership and current revision, and write an audit entry with the operator and reason. Retry and cancel actions operate on the job row and preserve attempt history. Preview endpoints do not change production data.

## Special Preview

The perfect-score preview is admin-only, preview-only, and read-only. The release fixture key `release_full_score_debug_1` is intentionally isolated from normal scoring, ranking, publication, users, and V3 jobs. It exists only for release verification and is scheduled for removal before formal public release.

## Retired Surface

The legacy admin screen is retained only as a read-only compatibility notice. V1/V2 mutation routes return the explicit retired contract and are not alternate operational paths.
