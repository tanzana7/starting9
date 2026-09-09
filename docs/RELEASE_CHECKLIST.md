# Release Checklist

## Required Before Formal Public Release

- [x] Remove the release debug perfect-score fixture, its fixture-local player IDs, and its API branch.
- [ ] Confirm the ranking reset marker boundary and execute it only at the approved formal release time.
- [ ] Confirm the policy and cleanup plan for test accounts and test predictions.
- [ ] Verify that internal IDs, UUIDs, reason codes, raw API diagnostics, and job details do not appear on the normal public page.
- [ ] Remove or hide any admin-v3 debug display that is not required for production operations.
- [ ] Re-run a production-shaped end-to-end Cron completion check, including schedule, roster, lineup, scoring, ranking, and publication.

The reset marker is a non-destructive aggregation boundary and is executed only with the approved confirmation and reason; it is never a substitute for direct D1 cleanup.

## Before Each Deployment

- [ ] Start from a clean worktree based on the intended `origin/main`.
- [ ] Review the file list and exclude unrelated dirty changes.
- [ ] Run `node --test` with zero failures.
- [ ] Run `node --check` for every changed JavaScript file.
- [ ] Run `git diff --check` and conflict-marker checks.
- [ ] Run the Worker dry-run with `--config wrangler.auth.production.jsonc`.
- [ ] Run `npm ci --ignore-scripts` and `npm run check`, or confirm the GitHub Actions `CI` workflow passed.
- [ ] Update the relevant public or admin cache buster when static assets change.
- [ ] Confirm whether Worker and Pages deployments are both required.
- [ ] Do not run migrations, D1 writes, repair, reset, or Discord notifications unless explicitly approved.

## After Deployment

- [ ] Verify the production Worker version and bindings.
- [ ] Verify the production Pages alias, not only a preview hostname.
- [ ] Check the public page for canonical game selection, prediction save/read, roster display, results, and ranking copy.
- [ ] Check Admin V3 authentication, Today Ops, job timeline, and audit visibility.
- [ ] Confirm the next Cron creates at most one job per game, type, and scheduled slot.
- [ ] Record any residual risk and the next remediation task.
