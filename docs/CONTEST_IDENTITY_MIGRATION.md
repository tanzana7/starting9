# Contest Identity Migration — C-4A4

## Scope and safety boundary

C-4A1–A4 move prediction, lineup, score/result lineage, ranking, publication and formal automation to contest identity while retaining one physical `games.internal_game_id` row. The current A4 implementation is local/feature-branch only. No remote D1, Worker, Pages or Cron resource was changed.

## Identity and keys

- Physical game: `games.internal_game_id`.
- Contest: deterministic `(internal_game_id, target_team_key)` identity, represented by `contest_id`.
- Prediction: one non-test row per `(user_id, contest_id)`. `internal_game_id` remains in the row and is protected together with `contest_id` by the composite foreign key and write triggers.
- Canonical lineup: one row per `contest_id`, with the same composite physical-game guard.
- Contest revision history: `(contest_id, version)` with one current revision per contest. The old `game_lineup_revisions` table remains unchanged as a Fighters/Test Site compatibility bridge for A3/A4 consumers.

## Backfill policy

Migration 0047 maps a legacy prediction or canonical lineup only when its stored physical ID (or one unique historical identifier mapping) resolves to a `games` row with exactly one already-backfilled Fighters contest. Existing score fields, payloads, IDs, timestamps, defaults, checks, and A3 game-based lookup indexes are retained during table rebuild.

Test predictions keep a null `contest_id` and their legacy game/user uniqueness in a partial index. Normal predictions and canonical contest lineups fail closed if their contest is missing or points to a different physical game. Ambiguous/unmapped legacy normal rows cause the migration transaction to fail; they are not silently assigned to Fighters. Production export/backfill evidence is still required before any remote apply.

Fighters revision rows are copied into `contest_lineup_revisions` without rewriting their original lineage. Runtime writes to Fighters revisions are mirrored to the old revision table only because the current score executor still reads that table. Synthetic Test Site teams use the same isolated compatibility bridge; real non-Fighters lineups are never mirrored into Fighters game-scoped revisions.

## Runtime compatibility

- Existing Fighters callers that provide only `internalGameId` remain supported only when the selected Worker target team is Fighters and the physical game participation check succeeds.
- Multi-team callers send the current contest identity; the Worker independently derives the expected contest from its trusted target-team context and validates the supplied value. A request body/query parameter is not authorization.
- Local-storage draft keys include team identity. The prior unscoped Fighters draft may be read one-way for Fighters only; another team's route never imports that draft.
- Candidate/final/cancel/current-lineup reads and writes are contest-scoped. A2 does not change login, sessions, CSRF, admin authorization, scoring rules, ranking, publication, or job identity.
- Non-Fighters past lineup correction is rejected until A3 migrates the downstream score/revision path. This prevents a contest-specific correction from entering the old game-scoped rescore executor.

## A3 handoff (historical plan; superseded by completion note below)

C-4A3 must migrate scoring revisions, score attempts and their prediction snapshots, correction/rescore lineage, ranking eligibility/reflection and aggregates, publication artifacts/readback, and Daily Best Nine selection to contest identity. It must prove stale score attempts cannot commit across contest revisions. Until then, do not run multi-contest scoring or expose a non-Fighters correction as a completed downstream workflow. Formal job planning/claim/retry identity remains C-4A4.

## C-4A3 completion and C-4A4 handoff

- Migration `0048_contest_scoped_results.sql` adds contest-owned scoring revisions, score attempts/staged rows, prediction score history, ranking inputs/eligibility/reflection, perfect-achiever records, rescore preview/job/audit lineage, and per-contest ranking-test data.
- Legacy game-only rows are copied only when the physical game resolves to exactly one Fighters contest. Ambiguous or missing ownership aborts migration. Legacy tables remain because formal V3 job identity is deferred to A4.
- Eligibility-reflection history that predates the first score keeps its contest/game and status with a null scoring-revision link; legacy `none`/`excluded` sentinels link to the active copied score revision when one exists. This avoids inventing a revision or dropping an admin exclusion event.
- Score staging/commit fences contest + physical game, scoring revision, canonical/scoring lineup revision, claim token and lease. Correction appends revision lineage and reuses the score executor. Stale attempts cannot commit over a newer final; stale publication completion is a no-op.
- Ranking inputs/aggregates are team scoped. Public result list/detail/previous/history reads use trusted target-team context without changing response contracts. Daily Best Nine selects the latest published contest for that team and remains independent from personal result selection.
- Verification is local only. No remote migration, production backfill, Worker/Pages deployment, or production operation occurred.

C-4A4 owns formal job schema/identity and uniqueness, planner/discovery/enqueue, claim/lease, executor dispatch, retry/recovery, fairness/boundedness, physical source-work deduplication, and full interleaved same-game multi-team automation E2E. A4 migrates this boundary rather than weakening A3 contest-scoped artifacts.

## C-4A4 completion — formal jobs and automation

Migration `0049_contest_scoped_formal_jobs.sql` rebuilds V3 state and jobs together with the score-attempt FK chain. Contest-owned types are `prediction_close`, `lineup_fetch`, `lineup_finalize`, `score`, `ranking_rebuild`, and `publish`. Their identity is `(contest_id, job_type, scheduled_slot_at)`; the physical game ID remains present and is enforced with a composite FK. Physical source jobs (`npb_identity_resolve`, `probable_starter_fetch`, and the currently Fighters-only `roster_fetch`) keep `contest_id = NULL` and physical-game uniqueness. The latter is not evidence that Marines roster automation is enabled.

The migration copies job IDs, statuses, attempts, retry timestamps, claim tokens, lease expiry, completion/failure metadata, score attempts and staged rows without resetting execution history. Existing game-only formal jobs are assigned to the one unique contest only; ambiguous jobs, ambiguous progressed shared state, or score-attempt/job ownership mismatch abort the transaction. The new schema uses separate partial unique indexes for contest work and physical source work plus due/lease/contest lookup indexes. Audit records accept an optional contest ID, while source-level events may remain game-scoped.

Runtime detects whether migration 0049 is present. On the pre-0049 Fighters-only schema, legacy formal job/state shape remains usable; when more than one contest exists, attempting a formal write without the new identity schema is rejected. This compatibility gate is covered locally; it does not authorize production rollout before D1 migration. Planner discovery remains physical-game based and bounded; selected-team contest resolution and due claims are separate, so no all-team loop or Cron cadence change is introduced. Claim token, lease duration, retry/backoff and existing bounded batch limits are retained.

`executeV3PredictionCloseExecutor` scopes the lock update to `contest_id` where the schema supports it and only transitions predictions from the stored open states (`draft`/`submitted`). A shared user's sibling-contest prediction remains unchanged. Score/ranking/publish executors consume the claimed job's contest lineage rather than a game-only artifact lookup.

### C-4B production rollout preconditions (plan only; not executed)

1. **Production preflight:** identify the exact production DB/account/profile and schema version; take an approved recoverable backup/export; inventory every game, contest, formal job, progressed legacy state, score attempt, lease and audit row. Do not proceed if any ownership query is ambiguous.
2. **Compatibility Worker strategy:** while production is on the old schema, deploy only code proven to use the Fighters-only compatibility path; do not enable Marines formal work. Before 0049 is applied, verify the old production data can be classified using read-only evidence and compare Worker/schema compatibility. Do not run a mixed-version Cron during table rebuild.
3. **D1 migration order:** pause/coordinate the existing Cron through an approved operational window, apply 0049 to the verified target DB using the named production config, then check migration status, foreign keys, integrity, row counts and uniqueness before deploying code that requires contest job identity. Migration and Worker rollout require a separate explicit C-4B authorization.
4. **Validation:** verify backfilled unique Fighters ownership, preserved job IDs/status/attempts/tokens/leases/retry timestamps and score-attempt lineage; verify the physical-source jobs remain null-contest; check no duplicate scoped keys, no orphans and no unexpected state copies. Stop on any delta not accounted for by the migration plan.
5. **Worker deploy:** deploy the reviewed Auth Worker only after schema verification; keep production automation target Fighters-only. Do not enable a global team loop, alter Cron cadence, change NPB Worker or Pages, or enqueue manual jobs as a shortcut.
6. **Rollback / forward-fix boundary:** do not attempt to reverse the table rebuild with an ad hoc SQL rollback after writes occur. Before new-schema writes, rollback may restore the approved backup and old Worker as a coordinated operation. After any contest-scoped write, prefer an explicitly reviewed forward-fix; preserve the backup and stop automation until identity consistency is restored.
7. **GET-only smoke:** read `/health` and read-only Fighters prediction/lineup/results/ranking endpoints; verify expected legacy contract and no cross-contest disclosure. No prediction, lineup, job, scoring, ranking, or publish mutation during smoke.
8. **Fighters-only enablement:** monitor normal scheduled pipeline and error/job metrics over an agreed observation window. Marines remains disabled until a later release explicitly approves its schedule/roster/admin/source and automation contracts.

Verification queries for C-4B must be scoped to the selected production database and treated as SELECT-only evidence before migration. At minimum compare `game_jobs_v3` row count and grouped `(job_type,status)` before/after; check duplicate formal `(contest_id,job_type,scheduled_slot_at)` and physical `(internal_game_id,job_type,scheduled_slot_at)` keys; join `contest_score_attempts` to its job/contest/game and confirm no mismatches; run `PRAGMA foreign_key_check` and `PRAGMA integrity_check`. Do not run these against production until the separately authorized phase.

Local C-4A4 tests cover a fresh full migration chain, 0048→0049 legacy jobs across pending/claimed/retry_wait/failed/completed states, preservation of a staged scoring attempt and lease/retry fields, ambiguous ownership transaction failure, pre-0049 Fighters-only runtime compatibility, and same-physical-game dual-contest automation in serial/interleaved/retry modes. These tests do not prove production historical data is unambiguous.

Production operations remain explicitly **NOT DONE**: no remote migration/apply, D1 read/write, Worker/Pages deploy, Cron change, manual job trigger, or multi-team enablement.
