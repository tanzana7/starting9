# Starting9 2027 Rebuild — Phase A-2 audit and handoff

Audit date: 2026-10-18
Repository: `tanzana7/starting9`
Starting baseline: `ec76b455b30a712120997764c85fa06ec83c4dfe` (`origin/main`)
Branch: `refactor/npb-only-cleanup`

## Outcome

Phase A-1 already removed the Asia/APBC product, edition routing, Asia Admin, and Auth-to-Asia gateway. A fresh call-site and asset-reference audit for Phase A-2 found **no high-confidence product-code cleanup that can be removed without changing NPB semantics, weakening a safety assertion, or deleting a useful module/test boundary**. No product code or test coverage was changed in this phase. This is an intentional one-time cleanup closeout, not a proposal to continue speculative cleanup in another phase.

The only change in this phase is this audit and handoff. No application behavior, API, deployment configuration, test architecture, database, or production resource changed.

## Audit classification

### DELETE NOW

None. No remaining runtime edition/Asia dispatch, Asia endpoint gateway, or Asia-only module was found in the active product tree after Phase A-1.

### SIMPLIFY NOW

None at high confidence. Single-caller public/admin modules remain meaningful responsibility and load-order boundaries; removing their wrappers or inlining them would increase change surface rather than reduce it. The deployment script's `ASIA_CS_SERVICE` rejection is a deliberate fail-closed guard against accidentally restoring a removed binding, not an active service dependency. NPB-only negative assertions in the public/admin shell tests are retained as regression guards.

### KEEP

- Public modules for roster, probable starter, results, Daily Best Nine, prediction validation/persistence/form, shared state, and request/storage coordination. They are loaded from the current HTML and/or used as runtime/test boundaries.
- Admin V3 renderer/API/state modules and shared lineup/player presentation modules; they still have distinct behavior and explicit load order.
- `Asia/Tokyo` date/time formatting. Matches are locale/time-zone references, not Asia Edition behavior.
- NPB source, game identity, automation, scoring, ranking, publication, retry/lease, and authorization boundaries. Their current scope is part of the product contract.
- Tests asserting the absence of Asia/edition UI and routes, and the production deploy guard that rejects the removed service binding.
- Historical module-boundary audit text, explicitly labeled as a historical snapshot. It records former test evidence and is not current architecture documentation.

### DEFER TO MULTI-TEAM

- Fighters team identity, aliases, player master, team-specific schedule normalization, lineup/roster defaults, probable-starter selection, and admin copy.
- Existing schedule/team fields and home/away selection assumptions. Do not rename them or introduce a generalized team layer until the multi-team data contract is designed.
- Fighters visual tokens and Japanese player detail data.

### DEFER TO TEST SITE

- A controlled clock for prediction deadlines, schedule selection, and start-time transitions.
- Scenario injection for external NPB source responses, game selection, roster state, lineup readiness, scoring, ranking, and publication.
- A production-isolated environment for full-pipeline scenarios. Existing local/synthetic tools and tests are not a request to build that site in Phase A-2.

### KEEP UNTIL DATA AUDIT

- Persisted game/user/job/artifact identifiers, legacy field aliases, and historical workflow compatibility. No production D1 inspection or data rewrite was authorized or performed.
- Any compatibility behavior whose removal would require proving absence of older persisted data. Resolve only in a separately scoped data audit.

## Before / after metrics

Measurements are from the clean A-1 baseline and this documentation-only result. LOC uses tracked text files read by PowerShell `Get-Content`; counts are repository snapshots, not bundle size. Since no code or tests changed, code metrics are unchanged after this phase.

| Metric | Before | After |
|---|---:|---:|
| Tracked files | 403 | 403 |
| Total tracked lines | 123,892 | 123,966 |
| JavaScript files / lines | 311 / 84,681 | 311 / 84,681 |
| Test files / lines | 206 / 30,810 | 206 / 30,810 |
| `script.js` lines | 3,523 | 3,523 |
| `admin-v3.js` + `admin-v3.html` lines | 2,181 | 2,181 |
| `auth-worker.js` lines | 24,025 | 24,025 |
| Public frontend modules | 16 | 16 |
| Declaration-pattern matches (`script.js` / `admin-v3.js` / `auth-worker.js`) | 233 / 126 / 695 | unchanged |
| Runtime edition/`currentEdition`/`selectedEdition`/`isAsia`/`isNpb` branches | 0 | 0 |
| Runtime `competitionId` / competition-switching references | 0 | 0 |
| Asia product/gateway references in runtime | 0 | 0 |
| Test files | 206 | 206 |
| Test cases (`npm test`) | 1,534 | 1,534 |

The baseline scan has no current product `edition` or `competition` state. Remaining textual matches are Japanese time-zone formatting, the test assertions that forbid Asia UI, the fail-closed deploy assertion, and historical documentation. They are not runtime edition branches.

## Fighters hardcoding handoff

These are literal search counts over tracked JS/CJS/MJS/HTML/CSS/JSON/JSONC source, excluding tests, docs, dependencies, and lockfiles. Counts are an inventory, not a recommendation to replace every occurrence.

- `fighters` / `fighter` tokens: 486.
- `FIGHTERS_TEAM_CODE`: 30 references; `FIGHTERS_TEAM_ID`: 18; standalone `"F"` identity literals: 11.
- Team key literal `"fighters"`: 115.
- Fighters color tokens: 4 distinct CSS custom properties (`--fighters-blue`, `--fighters-deep-blue`, `--fighters-gold`, `--fighters-sky`), 129 source occurrences.
- Fighters/team-logo filenames under `assets/`: none matched. This does not assert that no generic image can contain a team mark; no asset was changed.
- Roster-related Fighters adjacency: 20 text matches. Team scope is also encoded in `migrations/0036_manual_team_rosters.sql`; schema changes are out of scope.
- Fighters/home-away adjacency: 86 matching source lines, principally schedule detection, public probable-starter display, and bounded NPB game selection.
- Fighters-specific URL/path assumptions: no team-specific HTTP route was found. The current APIs are NPB-wide and pass/derive team values within their existing payloads and queries.
- Admin surface: 22 matching lines across Admin V3 runtime/HTML modules, including explicit Fighters-only controls and operation descriptions.

Recommended first multi-team design boundary: inventory and define canonical team identity plus schedule/game-selection inputs across public, admin, and backend. Do not perform a mechanical rename first.

## Test-site readiness inventory

Difficulty is relative to current seams; this phase did not add injection points.

| Scenario | Current injection difficulty | Notes |
|---|---|---|
| Current time / deadline | Medium-high | Native `Date` is used in several paths; do not add a clock abstraction until a test-site contract is approved. |
| External NPB APIs | Medium | Source adapters/fetch stubs exist in tests; live source behavior remains external. |
| Game selection / schedule state | Medium | Fixtures cover many states, but current fixtures and selection assumptions are Fighters-centered. |
| Roster | Medium | Static master and persisted manual roster semantics both matter. |
| Lineup | Medium | Candidate/final revision and canonical lineage must remain aligned. |
| Scoring | Low-medium | Existing deterministic isolated fixtures cover core scoring. |
| Ranking | Medium | Revision/readiness and generation behavior need isolated state. |
| Publish | Medium-high | Must include canonical revision guards and artifact/publication state. |

Recommended test-site isolation boundary: disposable non-production Worker + isolated databases and synthetic data, driven through the existing public/admin APIs; no production data copy. Design and implementation remain deferred.

## Residual search explanation

- `Asia/Tokyo`: required formatting/time-zone behavior; keep.
- `Asia`/`APBC` in `docs/PUBLIC_SCRIPT_MODULE_BOUNDARY_AUDIT.md`: explicitly historical snapshots and old test names/results; keep as history, not current docs.
- `Asia`/`edition` in `tests/admin-v3-modules.test.js` and `tests/user-screen-baseball-ui.test.js`: negative assertions ensuring removed surfaces do not return; keep.
- `ASIA_CS_SERVICE` in `tooling/production-deploy.cjs`: fail-closed validation that rejects an obsolete service binding; keep as a safety check.
- No active `asia-cs` route, edition query handling, November override, Asia Worker source, or competition switch remains in the product runtime.

## Behavior and production boundary

No behavior baseline was altered. Existing tests cover public root/game selection, prediction validation and persistence, roster, probable starter, results, Best Nine, position/drag, Admin V3, auth/session, and formal automation/scoring/ranking/publication/correction. The Phase A-2 verification re-runs the full suite and repository check; it is not a production operation.

No production GETs or mutations are required for a docs-only change. No Worker/Pages deployment, Cloudflare account check, D1 operation, migration, Cron change, prediction, scoring, ranking, publication, repair, or remote Asia resource operation was performed.

## Recommended next product phase

Recommend **Test Site** before **Multi-Team Core**. A disposable isolated scenario environment reduces risk while later team identity, game selection, roster, lineup, scoring, ranking, and publication contracts are changed. This is a recommendation only; neither phase is started here.

**Phase A-2 closeout: 2027 Starting9 NPB-only baseline.**
