# V3 schedule operations

## Implemented in this release

- The admin-v3 schedule endpoint accepts `scheduled`, `cancelled`, `postponed`, and `service_unavailable`.
- Every change requires a reason. Cancellation/target exclusion and changes after `prediction_closed` also require `confirmed: true`.
- Published games remain read-only. Changes after `lineup_ready` are rejected because they would invalidate finalized lineup and scoring lineage.
- Cancellation and service unavailability cancel only open V3 jobs (`pending` and `retry_wait`), exclude the workflow through the normal state transition, and preserve an audit record.
- Start-time changes recalculate the V3 timing contract and reschedule open jobs. Retry metadata is cleared so a stale retry does not survive the schedule change.
- NPB game-code and home/away administrative mutations now use the same published read-only boundary and require reason/confirmation where the mutation is manual.
- Manual job diagnosis reports artifact presence, the latest safe action, whether automatic recovery is expected, and whether manual attention is required.

## Deliberately not implemented here

### Adding a new game

Creating an additional or makeup game needs one canonical application service that owns the `games` row, identity registry, V3 state initialization, ranking eligibility, and initial job planning in one transaction-like operation. The current schedule sync path can discover games, but it is not a safe admin create contract. Adding a UI that writes only `games` would create a partially registered workflow, so this remains a follow-up design item and does not use a migration or direct SQL operation.

### Post-publication correction

Cancellation, rescheduling, and lineup/scoring mutation after publication remain read-only. A future correction flow must version the public result, ranking reflection, and audit record together; this release intentionally does not provide a rollback or republish shortcut.

## Safe operation sequence

1. Diagnose the internal game and inspect the artifact health and latest job.
2. Use a formal V3 retry or re-fetch when the artifact is missing or stale.
3. Use state reconcile only when the completed job and its required artifact both exist.
4. For schedule changes, provide a reason and confirmation, then verify the resulting state and open-job list in admin-v3.
5. Do not run scoring, ranking, or publication manually for a published game.
