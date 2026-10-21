# Contest Identity Implementation Map — C-4A4

Status: **C-4A1–A4 implementation and local verification are complete on the long-lived feature branch. Formal contest work is contest-scoped; physical source work remains shared. Production D1 migration and all deploys remain out of scope.**

## Identity contract

One physical NPB event remains exactly one `games.internal_game_id` row. A Starting9 contest is the pair `(internal_game_id, target_team_key)`. The registered canonical keys are `fighters` and `marines`; provider codes (`f`, `m`), aliases, and display names are not persisted as contest identity. `contest_id` is deterministic and injective: `contest_` + lowercase UTF-8 hex of the physical ID + `_` + lowercase UTF-8 hex of the canonical team key. The SQL backfill and `backend/contest-identity.js` use the same representation. Team registration is the allowlist: a contest cannot reference an unregistered key. A1 does not yet enforce that an arbitrary newly-created contest's target is a physical participant; that server-side invariant must be enforced before A2 enables new runtime writes.

The additive schema is `contest_identity_teams`, `game_contests`, and `contest_identity_backfill_issues` in `migrations/0046_contest_identity_foundation.sql`. `game_contests` has a PK on `contest_id`, unique `(internal_game_id, target_team_key)`, and restrictive FKs to `games` and the team registry. The composite unique index also covers game/team lookup; the PK covers direct contest lookup. The issue table quarantines dual-Fighters-side rows and missing participant identity with explicit reason codes. Existing artifact tables, constraints, rows, APIs, and runtime queries are unchanged in A1.

## Actionable data/entity map

| Entity / Table | Current identity | Required identity | Phase | Migration | Runtime consumers / action |
|---|---|---|---|---|---|
| `games` | `internal_game_id` | Same physical-game key | PHYSICAL_GAME_ONLY | Keep unchanged | `migrations/0023_internal_game_registry.sql`; `auth-worker.js` schedule/read paths; `backend/automation-v3/repository.js` planner candidates. Never duplicate for team. |
| `game_identifiers`, `detected_game_schedule`, `game_schedule_change_history` | Provider ID or `internal_game_id` | Same physical-game key | PHYSICAL_GAME_ONLY | Keep unchanged | Schedule registration/reconciliation and NPB provider mapping; target contest is resolved after physical schedule identity. |
| `probable_starters`, `game_pregame_automation`, `game_day_notice_games` | Physical game ID / source schedule ID | Physical schedule and probable-starter facts remain game-scoped; pregame state is split by owner before any multi-team automation | PHYSICAL_GAME_ONLY / C-4A4 split | No A1 changes | `auth-worker.js` probable-starter routes and `backend/automation-v3/probable-starter-planner.js`; source retrieval must not be duplicated per contest. |
| `game_day_notices`, `game_schedule_check_state` | Schedule date / physical source event | Physical source/schedule identity | PHYSICAL_GAME_ONLY | Keep unchanged | `auth-worker.js` and schedule sync; one official notice/source check can update the single physical game and then fan out to eligible contests. |
| `game_workflow_state`, `game_workflow_controls`, `game_workflow_logs`, `game_job_runs` (V1/V2) | `internal_game_id`, `legacy_game_id`, or `game_id` | Historical physical workflow remains legacy; any active contest-owned workflow must move to `contest_id` | LEGACY_COMPAT then C-4A4 if active | No A1 rewrite | Legacy workflow adapters and `auth-worker.js`; inventory active callers before A4, preserve historical rows and prohibit mixed-identity execution. |
| `game_identity_repair_plans` | Physical `internal_game_id` and repair plan | Physical game identity | PHYSICAL_GAME_ONLY | Keep unchanged | Identity repair tooling; plan can alter only physical registry identity and must not guess contest ownership. |
| `admin_alert_incidents` | Physical `internal_game_id` + incident type/dedupe key | Physical operational incident; contest-specific alerts may additionally carry `contest_id` later | PHYSICAL_GAME_ONLY / C-4A4 follow-up | No A1 changes | `backend/admin-alerts/*`; do not duplicate schedule/source incidents per target team. |
| `contest_identity_teams` | New canonical `team_key` registry | Canonical target key | C-4A1 | 0046 | New allowlist/FK boundary. Seeded only with `fighters`, `marines`. |
| `game_contests` | New `contest_id`; unique physical game + team | `(internal_game_id, target_team_key)` | C-4A1/A2 | 0046 | A2 resolves/creates a contest only after registry and physical participant validation; SQL insert/update triggers enforce the same participant boundary. |
| `contest_identity_backfill_issues` | Physical `internal_game_id` | One explicit quarantine issue per ambiguous physical game | C-4A1 | 0046 | Records both-Fighters-side and blank participant cases; never silently backfill. |
| `predictions` | Prediction PK plus unique `(user_id, game_id)`; optional `internal_game_id` | Unique `(user_id, contest_id)`; physical game FK pair retained | CONTEST_SCOPED | C-4A2 migration 0047 | `auth-worker.js`: prediction GET/PUT/DELETE and row lookup use contest identity after participation proof. Frontend persistence sends active-team contest identity; legacy Fighters-only requests remain compatible. Score columns and game indexes stay for A3. |
| `game_lineups` | `game_id` is unique; current/final pointers are per physical game | One canonical artifact per `contest_id` | CONTEST_SCOPED | C-4A2 migration 0047 | Auth Worker admin/automatic candidate, read, finalize and cancel paths use contest identity. The unchanged scorer bridge remains Fighters-only; scoring/job identity is not migrated in A2. |
| `contest_lineup_revisions` | No contest revision table; revisions are `(game_id, version)` | `(contest_id, version)` with one current revision | CONTEST_SCOPED | C-4A2 migration 0047 | New authoritative candidate/final/correction lineage, backfilled from Fighters history. Fighters and isolated Test Site fixtures mirror writes to the legacy table while old consumers remain game-scoped. Non-Fighters past correction is blocked until A3. |
| `game_lineup_revisions` | `(game_id, version)` and current-row partial unique index by game | Legacy scoring bridge only; not authoritative for non-Fighters contests | LEGACY_COMPAT | Keep unchanged in A2 | Existing score executor/ranking consumers still read this table. Contest-aware reads must not fall back to it when contest identity is available. |
| `game_rescore_previews`, `game_rescore_jobs`, `game_rescore_audits` | Preview/job/audit keyed by `game_id` + lineup version | Contest-owned rescore lineage and execution identity | CONTEST_SCOPED | C-4A3 migration 0048 | Runtime correction lineage is contest-owned; formal score job remains game-scoped until A4. |
| `game_roster_snapshots`, `manual_team_rosters` | Game ID or team/player key (manual roster currently Fighters-only) | Team-scoped roster; contest snapshot where tied to one game's eligibility | CONTEST_SCOPED for snapshots / LEGACY_COMPAT for existing master | C-4A2 prerequisite/follow-up | `backend/automation-v3/roster-repository.js`, `manual-roster-repository.js`, roster admin APIs. Maintain one source capture per physical game where provider returns both teams; persist team-specific eligible roster distinctly. |
| `game_scoring_revisions`, `score_attempts`, `score_attempt_prediction_rows`, `score_attempt_test_rows`, `prediction_score_revisions`, `game_rescore_*` scoring outcomes | Unique/revision keys contain `internal_game_id` or `game_id` | Contest + canonical lineup/scoring revision | CONTEST_SCOPED | C-4A3 migration 0048 | Contest-owned revisions, attempts, staged rows, score history and correction lineage are runtime canonical; old tables remain only as A4 formal-job compatibility bridges. |
| `perfect_achievers`, score-derived `user_achievements` | `game_id` / achievement source metadata | Contest + scoring revision for score-earned records; account-wide achievements remain shared only if policy says so | DERIVED_FROM_CONTEST | C-4A3 migration 0048 | Contest perfect-achiever records are scoped; account-wide achievement semantics remain unchanged. |
| `ranking_games`, `ranking_eligibility_history`, `ranking_reflection_revisions`, ranking aggregates | `game_id` / unique `(internal_game_id, scoring_revision_id, eligibility_version)` | Contest-scoped eligibility/reflection and team-scoped generation | CONTEST_SCOPED | C-4A3 migration 0048 | Ranking inputs, eligibility/reflection lineage and aggregates are contest/team scoped; global settings retain explicit global scope. |
| `ranking_test_predictions`, `ranking_test_game_settings`, `ranking_test_global_settings`, `ranking_reset_markers` | Physical game ID or period key; test settings can include a game | Game-specific test rows bind to contest; global settings/reset markers remain global | MIXED | C-4A3 migration 0048 | Contest ranking-test predictions/game settings are scoped; global settings/reset markers retain account-wide behavior. |
| `test_games`, `auto_scoring_tests` | Synthetic/test `game_id` | Isolated test-game identity, never production contest identity | LEGACY_COMPAT / TEST_ONLY | No A1 | Admin test/scoring routes; A2–A4 must keep test rows and their predictions/results isolated from production contests. |
| Publication state/artifacts and result readback | Physical game ID and publication revision; result lookup by game ID | Published contest + source revision; result game ID resolves only under selected trusted team context | CONTEST_SCOPED / DERIVED_FROM_CONTEST | C-4A3 migration 0048 | Publication pointers and public result/history handlers are contest-scoped; public response shape remains compatible. |
| Daily Best Nine source | Latest published physical game/result, independent widget state | Latest published contest for selected route team; still independent of personal result selection | DERIVED_FROM_CONTEST | C-4A3 migration 0048 | Latest published contest resolves in team scope; personal result selection cannot steer this widget. |
| `contest_automation_v3_state`, `game_jobs_v3`, `game_automation_v3_audit` | Legacy state/job key was `internal_game_id`; legacy unique `(internal_game_id, job_type, scheduled_slot_at)` | Formal work keyed by `contest_id` plus game; physical source work keyed by game | CONTEST_SCOPED / LEGITIMATE_GAME_SCOPED / LEGACY_FIGHTERS_COMPAT | C-4A4 migration 0049 + audit migration 0002 | `repository.js`, `orchestrator.js`, `executor.js`, `auth-worker.js`: planning, enqueue, due-claim, state transitions, retry/lease and audit preserve contest identity. Discovery stays bounded and physical-game based; target-team formal planning is explicit. |
| Shared users, sessions, admin roles | `user_id` / session | Same account identity shared across target teams | PHYSICAL/ACCOUNT SCOPE | No contest migration | Existing Auth Worker session/auth; team context is not authorization. Mutation handlers independently enforce admin role and contest/game/team participation. |
| Test Site fixtures | Three separate synthetic `internal_game_id` values, one per team | One physical game with separate contest IDs | DERIVED_FROM_CONTEST | C-4A4 | `tooling/test-site/worker.js`, `tooling/test-site/teams.js`, `tests/test-site-multi-team.test.js`; replace the separate-game proof with interleaved same-game dual-contest pipeline only after A2/A3/A4 are complete. A1 intentionally does not rewrite it. |

## Cross-cutting game-only query inventory

| Code boundary | Current game-only operations | Classification / next owner |
|---|---|---|
| `auth-worker.js` prediction handlers | Resolve physical game, then read/insert/update/delete by `(user_id, contest_id)`; retain physical game for composite consistency | CONTEST_SCOPED — C-4A2 DONE |
| `auth-worker.js` lineup/admin handlers | Canonical row and revision reads/writes use `(contest_id, internal_game_id)` / `(contest_id, version)`; explicit Fighters/Test Site mirroring is compatibility-only | CONTEST_SCOPED — C-4A2 DONE |
| `backend/automation-v3/lineup-candidate-service.js` | Legacy game-scoped scorer/automation consumer | LEGACY_COMPAT until A3/A4; no non-Fighters revision is copied to the legacy table |
| `auth-worker.js` score/revision handlers and `backend/automation-v3/score-attempts.js` | Contest-fenced score artifact/commit; job contest identity is passed to the executor | CONTEST_SCOPED — C-4A3/A4 DONE |
| `auth-worker.js` ranking and `backend/repositories/ranking-repository.js` | Eligibility/reflection, ranking inputs and user aggregates | CONTEST_SCOPED — C-4A3 DONE; global settings retain explicit global scope |
| `auth-worker.js` publication/result handlers and `backend/domain/public-results.js` | Publication pointers and result selection | CONTEST_SCOPED — C-4A3 DONE; API shape preserved |
| `backend/automation-v3/repository.js` | Physical game candidate discovery; formal work resolves trusted contest identity before enqueue/claim/state | Physical discovery shared; formal due work and state contest-scoped — C-4A4 DONE |
| `backend/automation-v3/orchestrator.js`, `executor.js`, `planner.js`, `planning-engine.js` | Formal plan, claim, retry, transitions and dispatch | Contest ID propagates through formal work; physical source jobs remain shared — C-4A4 DONE |

## Migration and legacy contract

- `0046_contest_identity_foundation.sql` remains the additive A1 foundation; `0047_contest_scoped_predictions_lineups.sql` rebuilds only `predictions` and `game_lineups`, then creates the separate contest revision history.
- Fighters aliases used by the migration are aligned with `frontend/shared/team-context.js`: `fighters`, `f`, `北海道日本ハムファイターズ`, `北海道日本ハム`, `日本ハムファイターズ`, `日本ハム`, `ファイターズ`, after whitespace/middle-dot/period normalization.
- Backfill creates exactly one Fighters contest only when exactly one side matches. Non-Fighters games get no Fighters row. Both sides matching or either blank are explicit issues; other unknown labels are not assumed to be Fighters.
- A1 is not evidence that production historical rows are fully classifiable. Production evidence/export and any remote apply are outside scope.
- A2 preserves prediction score-related columns, timestamps, checks/defaults, and game-based indexes needed by A3; test predictions remain outside production contest identity.
- Legacy normal rows are backfilled only through a unique, proven Fighters contest. Ambiguous/unmapped rows abort the migration transaction; no silent assignment is made.
- Legacy game-only requests resolve only to the active target team's contest after physical participation is proven. They never select an arbitrary contest or default an unknown team to Fighters.

## C-4A handoff

### C-4A2 — Predictions + Lineups — IMPLEMENTED LOCALLY

`predictions` and canonical `game_lineups` are rebuilt with contest identity; `contest_lineup_revisions` is authoritative for candidate/final/correction lineage. Prediction CRUD, active-team persistence, admin and automatic lineup paths validate the target contest before reads/writes. The old revision table remains a Fighters/Test Site scoring bridge. Score, ranking, publication, rescore jobs and formal job keys remain for A3/A4; non-Fighters historical corrections are blocked until that downstream identity is migrated.

### C-4A3 — Score, revisions, ranking, publication, result reads — IMPLEMENTED LOCALLY

Status note: the following paragraph is the original phase plan; implementation is complete locally as described here. Migration 0048 scopes scoring attempts/revisions, correction lineage, ranking inputs/reflection, publication and public reads. Formal job identity is intentionally deferred to C-4A4. No production migration/deployment has occurred.

Convert `game_scoring_revisions`, score-attempt lineage/rows, eligibility/reflection, ranking generation inputs, publication source artifacts, result reads, and Best Nine selection to contest identity. Update `executeV3ScoreExecutor`, score-attempt staging/commit, ranking executor/repository, publication/recovery and public result handlers. Required proof: stale score attempts cannot commit after a contest correction; independent team rankings/publications; API result isolation; Daily Best Nine resolves latest published contest for the team route and remains independent of selected personal result detail.

### C-4A4 — Formal jobs, automation, same-game E2E — IMPLEMENTED LOCALLY

Migration `0049_contest_scoped_formal_jobs.sql` gives contest-owned jobs a partial unique key `(contest_id, job_type, scheduled_slot_at)` and keeps physical source work unique by `(internal_game_id, job_type, scheduled_slot_at)`. Contest state is stored in `contest_automation_v3_state`; old state/jobs are backfilled only when ownership is unique. Ambiguous ownership and progressed shared state fail closed. Audit migration `0002_contest_automation_audit.sql` adds optional contest identity without changing physical audit events.

Formal prediction-close, lineup, score, ranking and publish work carries the trusted target contest from planner through claim, lease/retry, executor and result read. Each target still uses the existing bounded due claim; physical game discovery/source retrieval is not duplicated per team. The prediction-close executor updates only the selected contest's rows. Old schema compatibility is intentionally Fighters-only until the separately gated C-4B migration; multi-contest writes fail closed when the schema is old.

| Job type | Identity classification | Rationale |
|---|---|---|
| `prediction_close`, `lineup_fetch`, `lineup_finalize`, `score`, `ranking_rebuild`, `publish` | CONTEST_SCOPED | Predictions, canonical lineup, scoring, ranking and publication belong to the user's selected target contest even when a physical game is shared. |
| `npb_identity_resolve`, `probable_starter_fetch` | LEGITIMATE_GAME_SCOPED | Provider identity and official probable-starter source data describe the one physical event; duplicate target-team fetches would waste bounded Cron work. |
| `roster_fetch` | LEGACY_FIGHTERS_COMPAT / TEAM-SOURCE FOLLOW-UP | Existing enabled automation remains Fighters-only; the job is not proof that team-specific roster automation is enabled for Marines. Reclassify only when that product path is explicitly built. |

Same-game E2E uses one physical game, two contest IDs and one shared synthetic user, with independent prediction-close→score→ranking→publish. It runs serial, interleaved and with one injected Marines score failure followed by retry. See C-4A4 tests for migration, bounded claim, failure isolation and public result read-back. Production remains Fighters-only; this proof does not enable a multi-team Cron loop, public selector or admin selector.

### Residual identity classification

- **LEGITIMATE_PHYSICAL_GAME:** schedule/provider identity, game start/end facts, cancellation/source checks, probable-starter source data and physical candidate discovery.
- **LEGACY_FIGHTERS_COMPAT:** game-only runtime fallback for pre-0049 schema, legacy V1/V2 tables, and Fighters scoring bridge. Multi-contest use is rejected until migration 0049 is applied.
- **NON_CONTEST_ENTITY:** shared user/session/account identity and physical source audit facts.
- **FUTURE_PRODUCT_ROUTING:** public team selection, team-specific production automation enablement and multi-team admin UX; intentionally deferred.
- **BLOCKER:** none identified for contest identity in the exercised C-4A formal pipeline. Production migration classification still requires C-4B data preflight.

## A2 verification boundary

Historical note: A2 fixtures originally proved prediction/lineup isolation only. A3 added scoring, ranking and publication lineage; A4 adds formal jobs and same-game automation. All evidence is isolated/local. No local fixture proves production historical data is classifiable or makes a remote D1 migration safe.
