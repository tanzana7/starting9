# Game Automation V3 Module Design

## Intent

V3 is the only runtime automation path. This layout makes the production lifecycle readable without changing its schema, job schedule, public API, or Cron behavior.

```text
Auth Worker composition root
  -> repository: canonical V3 rows and job persistence
  -> domain: JST timing and state/identity decisions
  -> planners: auxiliary and main job decisions
  -> orchestrator: aggregate and atomically claim due rows
  -> executor: invoke the Worker-provided job-type executor
  -> audit + diagnostics: construct safe operational records
```

## Contracts

- `internal_game_id` is the sole V3 game identity.
- A job is unique by `internal_game_id`, `job_type`, and `scheduled_slot_at`.
- Only `pending`, `claimed`, and `retry_wait` prevent a later planner from creating a duplicate open job.
- Main workflow progression is state-gated; auxiliary failures never prevent planning other job types or games.
- Audit builders do not perform D1 operations. The Worker adapter adds the configured binding and writes the returned record.
- Cron summaries report planned, created, claimed, processed, failed, and schedule-sync counts using the same planner output that produced the jobs.

## Operational Guarantees

- Existing `game-automation-v3.js` imports remain valid through the facade.
- Job type executors remain in `auth-worker.js` because they connect V3 lifecycle events to application-specific lineup, scoring, ranking, and publication services.
- No V1/V2 runner, legacy workflow fallback, direct production D1 mutation, or repair path is introduced by the module split.
- NPB identity hydration from `game_identifiers` is read-only normalization for a canonical game; it does not alter the existing game record.
