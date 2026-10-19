# Contest Identity Migration — C-4A2

## Scope and safety boundary

C-4A2 makes prediction ownership and canonical lineup ownership specific to a registered team contest for one physical game. The physical game remains one `games.internal_game_id` row. Scoring, ranking, publication, rescore jobs, and formal automation identities remain game-scoped for the later C-4A3/A4 phases. Migration 0047 is local-only in this phase; it has not been applied remotely and no production database or Worker was changed.

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

## A3 handoff

C-4A3 must migrate scoring revisions, score attempts and their prediction snapshots, correction/rescore lineage, ranking eligibility/reflection and aggregates, publication artifacts/readback, and Daily Best Nine selection to contest identity. It must prove stale score attempts cannot commit across contest revisions. Until then, do not run multi-contest scoring or expose a non-Fighters correction as a completed downstream workflow. Formal job planning/claim/retry identity remains C-4A4.
