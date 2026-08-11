# Testing Guide

## Test Commands

The repository uses Node's built-in test runner and does not require a package manager script:

```powershell
node --test
node --check script.js
node --check auth-worker.js
git diff --check
```

For a focused change, run the relevant file first, then run the full suite before merge.

## Coverage Areas

The tests cover the following contracts:

- public game selection, result history, roster fallback, and `PublicAppCoordinator`
- account and admin authentication boundaries
- V3 planning, claiming, execution, retries, and state transitions
- lineup, probable starter, roster, scoring, ranking, and publication progression
- canonical UUID and NPB identity resolution
- ranking eligibility and non-destructive reset markers
- admin-only perfect-score preview and release fixture isolation
- migration application and schema compatibility using local test databases
- V1/V2 retirement and no-legacy-fallback guarantees

Backend domain modules are tested directly as well as through the Worker. Scoring, ranking, and public-results tests import the pure rules from `backend/domain`; ranking repository tests keep the D1-compatible CTE contract under `backend/repositories`. Compatibility tests still import the Worker exports to ensure existing callers keep their public symbols during the incremental split.

## Static Review Checks

Before a PR is considered ready:

1. The full test suite passes with zero failures.
2. Every changed JavaScript file passes `node --check`.
3. `git diff --check` passes.
4. No merge conflict markers remain.
5. No production D1 write, migration apply, repair, reset, or Discord notification was run unintentionally.

## Browser Smoke Test

For changes to static assets, verify the production-shaped page in a browser:

- the canonical game and prediction deadline are visible
- roster loading settles to fresh, baseline, or a user-facing unavailable state
- saving and resetting a prediction do not remove the latest result
- public ranking and result copy contain no internal IDs or reason codes
- admin V3 remains separately accessible and authenticated
- mobile lineup input remains usable
