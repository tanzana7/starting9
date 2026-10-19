# Multi-Team Product Model — C-3

Status: **C-3 design recorded; C-4A1 contest schema foundation is local on `refactor/contest-identity-migration`; runtime migration and all production rollout remain blocked**.

This document records the product and persistence boundary needed to support more than one target NPB club without duplicating a physical NPB game. It does not enable another production team, change application behavior, add a selector, or authorize a production migration.

## Product identity

Starting9 has two different identities that must not be conflated:

1. **Physical game** — one real NPB event, identified by the existing canonical `internal_game_id` in `games` and its provider identifiers. Schedule, venue, actual start time, cancellation/postponement, and source-level probable starters belong here.
2. **Prediction contest** — one target club's Starting9 experience for that physical game. A Fighters contest and a Marines contest can refer to the same physical game while having independent target roster, lineup, prediction, score lineage, ranking reflection, publication, and formal jobs.

The stable target-team identity is an opaque canonical team ID/key from the team registry. A display name, provider code, alias, season-specific roster, or home/away side is metadata, not the contest identity. Before a contest is enabled, the server must verify that its target team is actually one of the physical game's participants.

The authenticated account, user ID, and session remain shared across teams. Team context selects which contest data is read or mutated; it is not an authorization boundary. Existing admin authentication remains account-wide, while each admin mutation must authorize the action and validate the contest/team/game relationship.

## Persistence decision

**Recommended model: explicit contest entity.** C-4A1 establishes `game_contests` with deterministic `contest_id`, a foreign key to the one physical `internal_game_id`, and a foreign key to the canonical target-team registry (`target_team_key`). It enforces uniqueness on `(internal_game_id, target_team_key)`. Contest lifecycle/eligibility remains a later runtime/schema decision and is independent from physical-game lifecycle.

Prediction and contest-owned artifacts should refer to `contest_id`. At minimum, inventory and migrate predictions, lineup revisions/final artifacts, scoring revisions/attempt lineage, ranking reflection/eligibility, publication artifacts, contest workflow state, and contest formal jobs. Keep physical source records such as `games`, provider game IDs, schedule/cancellation facts, and probable starters physical-game scoped. Roster data is team scoped; a game-day roster snapshot is scoped to the contest when it represents the target club's eligible players.

The distinction is intentional:

| Data | Identity scope |
|---|---|
| NPB game, schedule, venue, actual start, cancellation | Physical `internal_game_id` |
| Official game-level probable-starter source containing both sides | Physical `internal_game_id` |
| Target roster and game-day roster snapshot | Team / contest |
| Prediction | `(user_id, contest_id)` |
| Target lineup and its revision lineage | `contest_id` |
| Score and score attempts | `contest_id` plus lineup/scoring revision |
| Ranking reflection and publication | `contest_id` plus source revision |
| Contest automation state, jobs, idempotency and audit | `contest_id` |
| Shared user, account, session and admin role | Existing user/account identity |

Do not implement the model by creating duplicate `games` rows for each target team, or by encoding a team suffix into `internal_game_id`. Either approach would make physical schedule corrections, source identifiers, cancellation, and game-level data ambiguous and would risk double counting. A repeated composite `(internal_game_id, target_team_id)` key on every artifact is possible, but creates more repeated constraints and a larger surface for mismatched pairs; the contest foreign key is the preferred boundary.

## Current-schema blocker

The existing schema is game-scoped in ways that prevent two independent contests for one physical game:

- `migrations/0003_predictions.sql`: `UNIQUE(user_id, game_id)` permits only one prediction per user and physical game.
- `migrations/0005_game_lineups.sql`: `game_lineups.game_id` is unique, so there is only one lineup artifact per game.
- `migrations/0007_all_time_ranking.sql`: `ranking_games.game_id` is the ranking-game key; later ranking queries/reflections remain keyed by physical game and have no target-team partition.
- `migrations/0015_manual_rescore.sql`: lineup revision identity is `(game_id, version)`.
- `migrations/0028_game_scoring_ranking_eligibility.sql`: score and ranking-reflection uniqueness is based on `internal_game_id` and revision IDs, not target contest.
- `migrations/0029_game_automation_v3.sql`: automation state and audit use `internal_game_id`; job uniqueness is `(internal_game_id, job_type, scheduled_slot_at)`.
- `migrations/0036_manual_team_rosters.sql`: manual roster validation is Fighters-only.
- Earlier workflow and pregame tables also use game-only keys; each must be classified as physical-game or contest-owned before migration.

Therefore a same-physical-game/two-target-team E2E cannot be truthfully claimed against the current schema. The existing Test Site multi-team pipeline uses different synthetic physical game IDs per team; it proves team-context behavior along that path, not independent contests for one physical game. No production D1 was queried for this design decision.

## Product behavior decisions

### Public routes and team context

- `/` remains the Fighters experience for backward compatibility.
- The future shareable team route is `/teams/{teamSlug}`. The route is authoritative for team context; an explicit deep link must not be overridden by a remembered browser preference.
- An unknown or disabled team slug returns a not-found/disabled state. It must not silently fall back to Fighters.
- No selector or new public route is implemented in C-3. A selector can be considered in a later product phase and should update the URL.
- Shared authentication stays account-wide. No separate user/account per team is created.

### Predictions, results, and Best Nine

- Predictions and personal result artifacts are contest-scoped. A user's history may span teams, but each entry must carry its target-team identity; team filtering/display is a later UI/API implementation detail.
- Public result pages expose only the selected team's published contests.
- Daily Best Nine is an independent widget, not coupled to the currently selected personal result detail. On a team route it should resolve the latest published contest for that team; on `/` it retains the Fighters scope. This preserves the established independent-widget contract while making its future scope explicit.
- Existing result and Best Nine API contracts are not changed by this design document.

### Ranking

Initial product policy: **rankings are team-scoped**. A user's ranking in one target-team contest must not be changed by participation or publication in another team's contest. The same account may therefore appear independently in multiple team rankings. A cross-team/global ranking is deferred until its opportunity normalization and historical boundaries are explicitly designed; it must not arise accidentally from sharing a D1 aggregate.

### Admin and operations

- Keep one admin identity and one admin surface, with an explicit target-team context for contest-owned operations.
- Every lineup, roster, score, ranking, publication, and contest-job mutation is addressed by `contest_id`; the server checks that the contest belongs to the requested physical game and target team.
- Physical schedule edits and cancellation/postponement remain game-scoped and are audited against the physical game. Their effect on all attached contests is explicit and consistent; they must not create a separate physical schedule per team.
- Selecting a team is not a permission grant. Existing admin authorization plus server-side scope validation remains mandatory.

### Automation

- Discover/synchronize each physical NPB game once. Associate it with registered, enabled contests only after verifying each target participates.
- Run bounded contest-level due work with fairness and due-first ordering; claim, lease, idempotency, and revision guards must key contest-owned jobs by `contest_id`.
- Keep physical schedule/cancellation and game-level probable-starter source work deduplicated at physical-game scope.
- Do not add one Cron per team or an unbounded loop over all clubs. Enable a team's formal automation only after its roster/lineup sources, admin operations, and recovery procedures are ready.

## Migration, backfill, and compatibility plan

This was a plan-only section in C-3. C-4A1 has now added the first additive migration locally; it has not been applied to any remote database. The explicit C-4A migration-authoring exception allows this migration to be hand-authored for the phased feature branch and does not authorize any production/Test D1 apply.

1. **Preflight inventory:** in a later explicitly approved migration phase, take the approved backup/export and enumerate physical games, predictions, roster snapshots, lineups/revisions, score attempts/revisions, ranking reflections, publications, jobs, leases, and audit rows by all legacy IDs. Do not infer team identity from display labels alone.
2. **Expand schema:** C-4A1 adds a canonical team registry and additive contest table with deterministic IDs, physical-game/team foreign keys, `(internal_game_id, target_team_key)` uniqueness, and an explicit issue table for ambiguous legacy participant identity. It backfills only provable Fighters games in local fixtures. Participant validation and rebuilding game-only artifact tables remain in C-4A2/A3/A4. Keep the physical `games` identity unchanged.
3. **Deterministic legacy mapping:** map existing Fighters production records to a Fighters contest only when participant, stored home/away, roster, and related artifact evidence agree. Quarantine missing or contradictory records for explicit review; never guess, silently drop, or reassign them.
4. **Preserve lineage:** map each legacy game-owned artifact to exactly one contest while preserving primary IDs where possible, timestamps, users, attempts, revision numbers, claim/lease state, idempotency keys, audit lineage, and publication contents. Record a reversible old-game-to-contest mapping for verification.
5. **Compatibility rollout:** use an expand/backfill/verify/cutover sequence. During transition, legacy endpoints and stored IDs must resolve only to the Fighters contest; they must never select an arbitrary contest for a physical game. New APIs/actions require an explicit contest identity or trusted team route context. Do not run mixed-version Cron against partially migrated rows.
6. **Verification gates:** compare row counts and key sets per table; verify no orphaned references, duplicate `(user_id, contest_id)` predictions, cross-team artifacts, missing revisions, changed score/publication hashes, stale jobs, or invalid participants. Run the same physical game with two contests and one shared user through independent predictions, lineup, scoring, ranking, publication, retry, and result reads in isolated local databases.
7. **Rollback:** retain the source snapshot and old compatibility columns/tables through the observation window. Roll back by restoring the approved snapshot or switching reads/writes back before destructive cleanup. Do not combine irreversible cleanup with the initial cutover.

The C-4A migration-authoring exception explicitly permits hand-authoring the A1–A4 migration files on the long-lived feature branch. This exception is limited to source files and local fixture tests; it does not permit applying a migration to Test or production D1. Any remote apply requires a separately approved phase and account/profile verification.

## API and routing compatibility plan

| Concern | Future identity | Compatibility rule |
|---|---|---|
| Physical schedule and game facts | `internal_game_id` | Existing game reads remain physical-game reads |
| Team game collection | team route/context | Must return only enabled contests for that team |
| Prediction CRUD | `contest_id` | Existing game-only route maps to Fighters only; never guesses |
| Lineup/score/ranking/publish admin operations | `contest_id` | Authorization and participant checks on every mutation |
| Game cancellation/reschedule | `internal_game_id` | One physical update, explicit propagation/audit for attached contests |
| Probable starter | `internal_game_id` | Physical source record; UI chooses the selected team's side |
| Result history | contest identity per entry | Cross-team personal history may label/filter by team |
| Daily Best Nine | team context → latest published contest | Remains independent from selected personal result detail |

The exact endpoint paths and response additions are deferred to implementation. Any additions must be backward-compatible; no existing public API, HTTP status, Auth Worker route, or stored ID is changed in C-3.

## Impact and verification matrix

| Area | Required C-4+ change | Principal regression gate |
|---|---|---|
| Physical game registry | Keep one row and one provider identity | Schedule correction/cancellation updates one game |
| Contest identity | Add stable game/team relation | Same physical game has exactly one contest per participating team |
| Prediction | Unique by user and contest | Same user can predict both contests; duplicate within one contest rejected |
| Roster/lineup | Target-team membership and contest revisions | No cross-team player; independent finalize/correction lineage |
| Scoring | Contest + canonical lineup revision | Corrections reject stale executors and do not cross contests |
| Ranking | Contest-scoped reflection/generation | Same user has independent team ranks; no cross-team contamination |
| Publication/results | Contest + source revision | Only selected team's canonical published artifact is returned |
| Jobs/audit | Contest-level identity for formal work | Retries are idempotent; physical schedule work is not duplicated |
| Auth/admin | Shared account auth, explicit scope | Wrong-team mutation is rejected server-side |
| Public routing | URL-authoritative team context | Direct link, refresh, unknown/disabled slug, and root Fighters compatibility |
| Best Nine | Latest published contest for route's team | Opening an older personal result does not retarget the widget |

The required same-game collision test belongs after the local schema migration and compatibility layer exist. It is intentionally not represented as passing in C-3.

## Scope, deferred work, and readiness

**C-3 decides the product identity model; it does not establish multi-team readiness.** Deferred items include the real migration, backfill from production evidence, contest-aware repositories/APIs, team-scoped ranking implementation, admin team context, team routes/selector, source readiness for additional clubs, automation rollout, and deployment topology.

The next phase should be limited to:

1. Implement the contest identity schema locally using generated migrations and deterministic Fighters backfill fixtures.
2. Add isolated same-physical-game/two-contest E2E, including prediction, lineup, score, ranking, publication, stale retry, and result isolation.
3. Convert repository/API and admin mutations to explicit contest identity while preserving the legacy Fighters-only contract.

Do not add a third team, production selector, production migration, Cron activation, or multi-team release as part of C-3.
