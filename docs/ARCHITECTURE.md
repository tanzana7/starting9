# Starting9 Architecture

## Purpose

Starting9 is a web application for predicting the Hokkaido Nippon-Ham Fighters starting lineup, comparing predictions with the official lineup, and publishing scored results and rankings.

The current execution path is Game Automation V3. V1/V2 runners and legacy mutation paths are retired and must not be reintroduced as fallbacks.

## Runtime Components

```text
Browser
  index.html + script.js + style.css
        |
        | HTTPS API / session cookie
        v
Auth Worker (auth-worker.js)
  - authentication and admin authorization
  - canonical games, predictions, results, rankings
  - V3 planner, job claim, and executor
        |
        +--> D1 (AUTH_DB)
        +--> NPB Fetch Worker (NPB_FETCH_WORKER)

Admin V3
  admin-v3.html + admin-v3.js + admin-v3.css
  - read-only monitoring and authenticated operational actions
```

The Pages site serves the static public and admin assets. The Auth Worker owns the application API and the V3 Cron trigger. The NPB Fetch Worker isolates upstream NPB page retrieval and parsing from application state.

## Backend Responsibility Boundaries

`auth-worker.js` is the composition root: it owns request authentication, route dispatch, response headers, and orchestration of the existing V3 workflow. Domain rules and D1 query groups are kept in focused modules so a route can be read as authorization -> domain/repository call -> response.

- `backend/domain/scoring.js` contains the 100-point lineup scoring rules, breakdown, perfect-score preview, and the release-only debug fixture input. It has no Worker, D1, job, or request dependency.
- `backend/domain/ranking.js` contains participation-threshold math, public row shaping, the future `hideIneligibleRankings` switch, and reset request validation/confirmation text.
- `backend/domain/public-results.js` contains public team labels, matchup labels, and the five-result history limit. It does not resolve games or read private state.
- `backend/admin/preview.js` defines the admin preview response contract (`previewOnly` and write flags); it is deliberately not an authorization or execution module.
- `backend/repositories/ranking-repository.js` contains ranking CTEs and ranking/reset-marker SELECT/INSERT operations. Read-only preview queries and the explicit reset-marker write are separate named functions.
- Admin authentication and route-specific confirmation remain in the Worker boundary. The repository never authorizes a caller, and domain modules never perform a write.

The current Worker keeps the full route table in one file because it is the deployment entrypoint and because moving dispatch wholesale would change a large, high-risk surface. The extracted modules are therefore intentionally incremental: they reduce domain/query duplication without changing route paths, bindings, schema, or V3 job execution.

## Canonical Identity

`games.internal_game_id` is the canonical identifier for current application behavior. Public prediction, roster, lineup, scoring, ranking, publication, and V3 job paths use this UUID. Legacy IDs may appear in historical compatibility or audit data, but they are not valid substitutes for current mutation paths.

## Public Frontend Flow

`script.js` is the compatibility entrypoint for the public page. It loads the browser modules in `frontend/public/` before starting `PublicAppCoordinator`; no build step is required. The modules are classic, namespaced scripts so the existing static Pages deployment and legacy global event handlers keep working.

| Module | Responsibility |
| --- | --- |
| `state.js` | Public state shape and synchronization boundary |
| `request-guard.js` | Request sequence tokens and `AbortController` ownership |
| `storage.js` | Safe localStorage read/write/remove handling |
| `api-client.js` | Public API request and JSON response boundary |
| `app-coordinator.js` | Ordered browser initialization and auth-dependent refreshes |
| `render-results.js` / `render-ranking.js` | Result preservation/history limit and ranking rendering/copy |
| `roster.js` | Current-game roster synchronization and candidate-list presentation |
| `prediction-form.js` | Public prediction save/reset interactions |

The compatibility entrypoint keeps only thin delegates for these public contracts while legacy admin-only UI remains isolated from the public startup path.

`PublicAppCoordinator` remains the single browser initialization entrypoint:

1. Bind the DOM and restore local presentation state.
2. Fetch the canonical public game catalog.
3. Select the current game from canonical API data.
4. Initialize schedule-derived display state.
5. Load probable starter and roster data for that game.
6. Load authenticated account, ranking, and result history data.
7. Render the stable public surface.

The public state is split into `gameCatalog`, `currentGame`, `predictionForm`, `roster`, `results`, `ranking`, `account`, and `requests`. Request sequence checks and `AbortController` instances discard stale responses when the target game changes.

## V3 Workflow

V3 separates auxiliary jobs from main workflow jobs. The Cron path plans due jobs, claims them atomically with a lease, and invokes the registered executor. A job failure is recorded against its job type and target game; it must not stop unrelated auxiliary jobs or other games.

### Automation Module Boundaries

`game-automation-v3.js` is a compatibility facade. It deliberately preserves existing Worker and test imports while the implementation is organized under `backend/automation-v3`:

| Module | Responsibility | Does not own |
| --- | --- | --- |
| `constants.js` | V3 job/state registry, timing constants, transition and error taxonomy | D1 or Worker bindings |
| `domain.js` | JST schedule derivation, slot eligibility, identity and phase decisions | SQL or HTTP execution |
| `probable-starter-planner.js` / `planner.js` | probable-starter, roster, identity, and main-workflow planning decisions | claim or job execution |
| `repository.js` / `roster-repository.js` | canonical V3 game/state/job and roster-snapshot persistence queries | authorization or job rules |
| `orchestrator.js` | auxiliary/main plan aggregation and atomic due-job claiming | job-type executor implementation |
| `executor.js` | planner -> claim -> injected job-executor lifecycle and retry completion | application-specific lineup/scoring/publish work |
| `audit.js` / `diagnostics.js` | pure structured audit-record and Cron-summary construction | D1 writes, routes, or secrets |

`auth-worker.js` remains the composition root. It supplies `AUTH_DB`, authorization, schedule sync, job-type executors, and the thin D1 audit adapter. This is intentional: those are deployment- and application-specific concerns, while the V3 modules remain independently testable.

The normal progression is:

```text
schedule / identity
  -> probable starter / roster
  -> prediction close
  -> lineup fetch / finalize
  -> scoring
  -> ranking rebuild
  -> publication
```

Each step is state-gated and idempotent. Zero-prediction scoring is a valid completed no-op and still produces the revision state required by downstream ranking and publication.

The scheduler must not use a legacy ID, V1/V2 runner, or manual production mutation as a fallback. NPB identity hydration may read the canonical `game_identifiers` record when a `games` identity field is absent; that normalization is part of the V3 repository read path and leaves the underlying game row unchanged.

## Data and Revision Boundaries

- Games and V3 state identify the target and lifecycle.
- Lineup revisions preserve historical lineup changes.
- Scoring revisions preserve active and completed scoring results.
- Ranking reflection and publication use completed active revisions only.
- `game_automation_v3_audit` records structured operational decisions.

The ranking reset marker is a non-destructive boundary for future aggregation. It is not a deletion command and must be reviewed and explicitly confirmed before production execution.

## Security Boundaries

Admin endpoints call `requireAdminUser` before returning or mutating operational data. Preview endpoints, including the perfect-score preview, are read-only simulations and do not create predictions, rankings, publications, users, or V3 jobs. The release fixture is intentionally isolated to the admin preview path and is not a source for normal scoring.

`RELEASE_DEBUG_PERFECT_SCORE_FIXTURE` uses fixture-local player IDs and must be removed or disabled before formal release. It is never loaded by public results, normal predictions, ranking aggregation, publication, or V3 job planning.

Public responses should contain user-facing labels and result data only. Internal UUIDs, reason codes, cookies, tokens, and raw diagnostic payloads must not be rendered on the normal public page.
