# Public script module boundary audit (Phases 19–20)

Historical snapshot: references below describe the code and test suites at the time of each phase, not the current NPB-only product surface. Phase A-1 removed the Asia edition and its runtime; Asia-related test names/results are retained here only as historical evidence.

Baseline: `2aecf82aa6df5283fdc2d0f92ec6a1ef7c039aed`.
Scope: one public frontend domain; no server, API, scoring, CSS, storage-key or UX changes.

## Method and limitations

Inventory covers all 282 column-zero named function declarations in baseline `script.js`.
Each function body ends at its column-zero closing brace. The appendix records direct named function references as callers and syntactic calls as callees. Callback references are included as callers; calls through controller objects, dynamic state keys, aliases and generated DOM selectors require the manual boundary notes below. This is a source inventory, not a complete JS alias analysis or measured runtime cost.

State R lists direct `state.<key>` references (including references also written); W lists direct assignments to those keys or their children. Alias mutations such as `previous.game = ...` and dynamic `state[key]` are not included in the syntactic W sets. DOM lists unique literal ID/query selectors. API counts direct public client and roster-fetch call sites, not network traffic; event counts direct listener registrations, not browser runtime listeners. Storage counts local storage helper calls, not stored objects. These definitions are unchanged across the comparison.

## Domain inventory

| Domain | Functions | Outside named callers | Literal selectors | Direct API sites | Listener sites | Storage helper sites | Existing coverage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| storage | 14 | 5 | 0 | 0 | 0 | 22 | public-runtime-behavior / results / game-flow |
| bootstrap | 6 | 12 | 10 | 0 | 24 | 0 | public-frontend-coordinator / public-runtime-behavior |
| results | 30 | 7 | 6 | 3 | 0 | 1 | public-runtime-results / result-detail / daily-best-nine |
| auth/session | 8 | 19 | 0 | 0 | 1 | 0 | prediction-save-ui / public-runtime-behavior / Asia auth |
| notices / status | 11 | 14 | 4 | 0 | 0 | 0 | public-runtime-behavior / achievements / game-day notice |
| prediction | 59 | 32 | 16 | 1 | 24 | 4 | prediction-save-ui / position-menu-runtime / public-runtime |
| roster integration | 18 | 10 | 0 | 2 | 0 | 2 | public-runtime-behavior / public-roster / manual-roster |
| position menu | 13 | 9 | 3 | 0 | 5 | 0 | position-menu-runtime-behavior / position-menu-swap |
| drag / pointer / touch | 33 | 6 | 1 | 0 | 0 | 0 | drag-runtime-behavior / position-drag-mobile |
| probable starter | 21 | 2 | 1 | 1 | 0 | 0 | probable-starter-state-simplification / public-runtime-game-flow / probable-starter-display / probable-starter-module-runtime |
| game selection | 33 | 18 | 5 | 1 | 0 | 0 | public-runtime-game-flow / public-game-catalog |
| Daily Best Nine | 4 | 1 | 0 | 1 | 0 | 0 | daily-best-nine / public-runtime-results |
| shared formatting / player display | 26 | 33 | 3 | 0 | 3 | 0 | public-runtime / player display and details |
| local score comparison (unchanged) | 6 | 4 | 0 | 0 | 0 | 0 | scoring-rules / public results |

### State, DOM and cross-domain dependencies

- **storage**: R `predictionTargetGameId`, `predictionTargetGame`, `prediction`, `actual`, `result`, `gameInfo`, `candidateRosterFilter`; W `prediction`, `actual`, `result`, `gameInfo`, `candidateRosterFilter`. DOM —. Outside named callers `setPublicCurrentGame`, `setCandidateRosterFilter`, `syncPredictionFromAccount`, `getRosterSnapshotForCurrentGame`, `clearStoredPublicResult`.
- **bootstrap**: R —; W —. DOM `predictionForm`, `resetPredictionButton`, `refreshAchievementsButton`, `sharePredictionButton`, `saveSavedPredictionImageButton`, `predictionCtaButton`, `editSavedPredictionButton`, `publicGameSelectionMeta`, `resultHistoryList`, `[data-roster-filter]`. Outside named callers `setPublicCurrentGame`, `initializePublicGameCatalog`, `fetchPreviousResultGame`, `resolveResultHistorySelection`, `refreshResultHistory`, `loadResultHistoryGame`, `syncPredictionFromAccount`, `initializeProbableStarter`, `refreshProbableStarterTarget`, `refreshPredictionTarget`, `fetchStoredProbableStarter`, `initializeAuthDependentFeatures`.
- **results**: R `publicGameCatalog`, `resultHistory`, `previousResultGame`, `result`, `predictionTargetGame`; W `resultHistory`, `result`. DOM `resultHistoryList`, `scoreInsightsGrid`, `scoreInsightsNotice`, `[data-score-insight]`, `[data-score-insight-value]`, `tbody`. Outside named callers `setPublicCurrentGame`, `syncPredictionFromAccount`, `initializeAuthDependentFeatures`, `fetchDailyBestNine`, `bindEvents`, `renderAll`, `refreshGameDayNoticeStatus`.
- **auth/session**: R —; W —. DOM —. Outside named callers `buildAchievementsApiUrl`, `buildPublicGamesApiUrl`, `buildPreviousResultGameApiUrl`, `buildProbableStarterApiUrl`, `fetchDailyBestNine`, `buildResultGamesApiUrl`, `buildCurrentPredictionApiUrl`, `buildGameDayNoticeApiUrl`, `fetchGameDayRosterSnapshot`, `renderAchievements`, `fetchUserAchievements`, `maybeLoadFastPreviousResult`, `refreshResultHistory`, `handleResultHistoryClick`, `syncPredictionFromAccount`, `savePredictionToAccount`, `deletePredictionFromAccount`, `renderPredictionCta`, `renderAll`.
- **notices / status**: R `achievements`, `predictionTargetGame`, `probableStarter`, `gameDayNotice`; W `achievements`, `gameDayNotice`. DOM `achievementsPanel`, `achievementsList`, `gameDayNoticeStatus`, `predictionSaveMessage`. Outside named callers `renderAll`, `initializeAuthDependentFeatures`, `bindEvents`, `refreshPredictionDeadlineState`, `refreshPredictionTarget`, `ensurePredictionEditingAllowed`, `downloadPredictionImage`, `saveSavedPredictionImage`, `sharePrediction`, `createPositionControl`, `setActiveOrder`, `assignPlayerToSlot`, `movePositionBetweenSlots`, `moveLineupSlot`.
- **prediction**: R `pointerSuppressClickUntil`, `activeOrder`, `predictionRemote`, `prediction`, `result`, `publicGameCatalog`, `predictionTargetGame`, `gameInfo`; W `activeOrder`, `predictionRemote`, `prediction`, `result`. DOM `savePredictionButton`, `predictionEditor`, `.slot-player`, `.position-button`, `.slot-clear`, `.slot-drag-handle`, `.position-menu-option`, `[data-roster-filter]`, `savedPrediction`, `editSavedPredictionButton`, `sharePredictionButton`, `saveSavedPredictionImageButton`, `predictionCtaButton`, `predictionForm`, `button, input, select`, `#savedPrediction canvas.saved-lineup-canvas`. Outside named callers `showPlayerDetails`, `handleSlotDrop`, `handlePointerInteractionEnd`, `moveLineupSlot`, `renderPublicGameSelectionMeta`, `handleSlotDragOver`, `handlePositionPointerDown`, `beginPointerInteraction`, `activatePointerInteraction`, `createPositionControl`, `togglePositionMenu`, `selectPositionForSlot`, `handlePlayerDragStart`, `handleSlotDragStart`, `handlePositionDragStart`, `movePositionBetweenSlots`, `setPublicCurrentGame`, `loadResultHistoryGame`, `renderPredictionAccountStatus`, `bindEvents`, `updatePositionMenuState`, `createPositionSelectionLineup`, `moveLineupItem`, `moveLineupPosition`, `scoreLineup`, `normalizeScoringLineup`, `loadState`, `renderResultHistory`, `setCandidateRosterFilter`, `startPredictionDeadlineTicker`, `refreshPredictionDeadlineState`, `renderAll`.
- **roster integration**: R `publicRoster`, `predictionTargetGame`, `candidateRosterFilter`, `probableStarter`; W `candidateRosterFilter`. DOM —. Outside named callers `buildLineupPicker`, `createPredictionPayload`, `getUniquePlayerData`, `startPredictionDeadlineTicker`, `renderPredictionDeadline`, `updatePredictionSaveButton`, `bindEvents`, `getPlayerData`, `refreshPredictionTarget`, `renderPicker`.
- **position menu**: R `pointerSuppressClickUntil`; W —. DOM `.position-menu-option`, `.position-menu`, `.position-button`. Outside named callers `createLineupSlot`, `bindEvents`, `handlePositionDragStart`, `handlePositionDragEnd`, `handleSlotDrop`, `activatePointerInteraction`, `clearSlot`, `ensurePredictionEditingAllowed`, `renderPicker`.
- **drag / pointer / touch**: R `pointerInteraction`, `pointerSuppressClickUntil`, `activeOrder`; W `pointerInteraction`, `pointerSuppressClickUntil`, `activeOrder`. DOM `.lineup-slot.is-drop-target`. Outside named callers `createPlayerChip`, `createLineupSlot`, `createPositionControl`, `bindEvents`, `renderPicker`, `assignPlayerToSlot`.
- **probable starter**: R `publicGameCatalog`, `probableStarter`; W `probableStarter`. DOM `probableStarterDisplay`. Outside named callers `startPredictionDeadlineTicker`, `renderAll`.
- **game selection**: R `publicGameCatalog`, `predictionTargetGame`, `predictionTargetGameId`, `predictionTargetNotice`, `predictionRemote`, `prediction`, `actual`, `result`, `publicRoster`, `predictionDeadline`, `probableStarter`; W `predictionTargetNotice`, `predictionRemote`, `prediction`, `actual`, `result`, `predictionTargetGameId`, `predictionTargetGame`, `publicRoster`, `predictionDeadline`. DOM `predictionDeadlineStatus`, `savePredictionButton`, `resetPredictionButton`, `publicGameSelectionMeta`, `predictionTargetNotice`. Outside named callers `bindEvents`, `getFastPreviousResultGame`, `getProbableStarterReferenceDiagnostics`, `getProbableStarterCutoffAt`, `getPublicResultAvailability`, `selectProbableStarterGame`, `renderPublicPredictionSurface`, `isPredictionEditingLocked`, `ensurePredictionEditingAllowed`, `renderResultHistory`, `syncPredictionFromAccount`, `renderAll`, `getGameDayRosterTargetInternalGameId`, `savePredictionToAccount`, `loadState`, `formatPublicPredictionGameLabel`, `getPublicPredictionGameMetaLines`, `renderPredictionAccountStatus`.
- **Daily Best Nine**: R `dailyBestNine`; W `dailyBestNine`. DOM —. Outside named callers `renderAll`.
- **shared formatting / player display**: R `publicRoster`; W —. DOM `.player-detail-close`, `.player-detail-select`, `.player-detail-overlay`. Outside named callers `createPredictionPayload`, `getLineupPlayerId`, `createPositionSelectionLineup`, `resolveAutoFillPosition`, `remotePredictionToLocal`, `createLineupItem`, `createResultCanvas`, `createResultPositionTileHtml`, `createPredictionSummary`, `createSavedPredictionCanvas`, `getPredictionCandidatePlayers`, `createRosterEntryKey`, `rosterEntryMatchesPlayer`, `predictionsMatch`, `findActualLineupItem`, `createActualBasisDetails`, `renderPublicGameSelectionMeta`, `renderPredictionDeadline`, `createAchievementCardHtml`, `renderProbableStarterDisplay`, `renderProbableStarterNotice`, `createSavedPredictionPreview`, `renderResultHistory`, `createProbableStarterTeamHtml`, `createResultFallbackView`, `createHitBadge`, `autoFillPredictionPosition`, `renderPositionButton`, `createPlayerChip`, `renderPicker`, `createResultPlayerCardHtml`, `createLineupSlot`, `bindEvents`.
- **local score comparison (unchanged)**: R —; W —. DOM —. Outside named callers `loadResultHistoryGame`, `syncPredictionFromAccount`, `loadState`, `createResultViewModel`.

## Selection

Probable starter is selected: a single dedicated DOM container, one GET endpoint, no storage, no domain listener/timer installation, and existing real-runtime coverage of no-game/unannounced/announced states, actual versus planned start, midnight, cancellation, announcement retry and error fallback. Its only cross-domain named callers are `renderAll` and `startPredictionDeadlineTicker`; the coordinator's operations map is the third, non-function-declaration bootstrap connection.

Results have multiple caches, auth-sensitive personal history and canvas/detail dependencies. Prediction/game selection jointly manage persistence, deadlines and editing. Position/drag have geometry, portals, pointer capture and touch state. Roster already has its own controller and substantial candidate/shared-player dependencies. At the Phase 19 audit point, Daily Best Nine stayed in bootstrap because its renderer already lived beside Results. Phase 21 later moved its fetch and state lifecycle into a dedicated controller while keeping the renderer separate.

## Extraction and ownership

Existing pattern: classic deferred script -> `window.Starting9Public` factory -> explicitly supplied dependencies -> one bootstrap-owned controller. No module-system/bundler change.

`frontend/public/probable-starter.js` owns 19 moved functions:

- `getProbableStarterActualStartAt`
- `getProbableStarterCutoffAt`
- `selectProbableStarterGame`
- `getPreferredProbableStarterGame`
- `resetProbableStarterDisplay`
- `initializeProbableStarter`
- `refreshProbableStarterTarget`
- `buildProbableStarterApiUrl`
- `applyStoredProbableStarter`
- `getProbableStarterReferenceDiagnostics`
- `fetchStoredProbableStarter`
- `getFightersStarter`
- `formatScheduledGameForLog`
- `deriveProbableStarterViewState`
- `renderProbableStarterDisplay`
- `renderProbableStarterNotice`
- `createProbableStarterHeadingHtml`
- `createProbableStarterTeamHtml`
- `formatProbableStarterDate`

Removed: the old `renderProbableStarter` forwarding wrapper. There are no replacement function wrappers in `script.js`.

Public controller surface: `initialize`, `refreshTarget`, `render`. Only the factory is attached to the existing namespace; private helpers are not exported. There are no new window function contracts or inline-HTML callers.

The existing `state.probableStarter` object remains the sole state. `probableStarterState` is the identical object reference, not a copy or second cache. The catalog is read through `getGames`. Prediction, results, roster and Daily Best Nine states are never supplied to the controller. The existing request guard, request-state object and API client retain request sequence/abort/error behavior. The state initializer remains in app bootstrap; no caller replaces the probable-starter state object.

15 explicit dependency properties:

- Mutable reference: `probableStarter`.
- Catalog getter: `getGames`.
- Existing request/API references: `requestState`, `requestGuard`, `apiClient`.
- Existing source URL constant: `starterSourceUrl`.
- Shared helpers: `getAuthApiBaseUrl`, `parseJstScheduleDateTime`, `isNormalManagedSchedule`, `isScheduleGameUnavailable`, `getScheduleSortValue`, `normalizeScheduleTeamCode`, `escapeHtml`, `formatDateTime`, `formatPlayerNameForDisplay`.

Browser globals are limited to `document` for the dedicated widget, `Date` and `console`. JS built-ins are unchanged. There are no hidden references to app functions or app state. Shared callbacks do not call the controller; no cycle is introduced.

The sole selector `#probableStarterDisplay` moves to the module. Scheduling remains in the coordinator and the existing 30-second deadline ticker. The module creates no listeners/timers or requests during construction.

## Before / after metrics

Logical lines count includes blank lines but excludes the final newline's empty split entry. Named function counts use the same declaration pattern.

| Metric | Before | After |
| --- | ---: | ---: |
| script.js lines | 5294 | 4876 |
| script.js named top-level functions | 282 | 261 |
| Starter implementation functions in script.js | 20 + 1 forwarding wrapper | 0 |
| Starter literal selectors in script.js | 1 | 0 |
| Starter assignment sites in script.js | 55 | 0 (state initialization retained) |
| Starter network call sites in script.js | 1 | 0 |
| New module lines | 0 | 449 |
| New module functions | 0 | 20 + factory |
| Controller-facing orchestration connections | 3 | 3 |
| Dedicated runtime timer/listener installation | 0 / 0 | 0 / 0 |
| State copies or extra cache structures | 0 | 0 |

The 15 existing starter fields read/written are: `nextGame`, `matchedGame`, `games`, `fetchedGameId`, `status`, `message`, `nextCheckAt`, `errorCode`, `referenceDiagnostics`, `lastRefreshAt`, `fetchedAt`, `sourceUrl`, `fetchedGameCount`, `dataStatus`, `isLoading`. Initial unused fields are preserved, not cleaned up as part of extraction.

## Call flow and change surface

Before:

```text
coordinator.initializeProbableStarter / deadline ticker
 -> script.js target selection -> script.js GET /api/probable-starter
 -> script.js reference guard -> script.js state commit -> script.js renderer
renderAll -> script.js render wrapper -> same renderer
```

After:

```text
coordinator -> controller.initialize
existing deadline ticker -> controller.refreshTarget
renderAll -> controller.render
controller: target selection -> existing API client -> reference guard
          -> same app-owned state -> dedicated widget rendering
```

Example: changing the rule for displaying “未発表” formerly required finding the state derivation, response application and notice rendering among 282 functions in a 5294-line entry file. It now involves the same three private functions in a 449-line single-domain module. Files to edit remain one; the module's 20 implementation functions replace the need to inspect the full app entry file. A starter behavior change does not require editing the bootstrap, API client or another domain.

## Validation and review

- Before extraction: existing selected suite 31 passing; five added boundary/runtime cases also passed against the old implementation.
- After extraction: all existing observable behavior retained. Display tests formerly asserting internal function spelling now exercise the shipped runtime's actual widget DOM. Security/retired-endpoint assertions still inspect the shipped client sources; asset order/version assertions remain static.
- Eight synthetic snapshots (noGame, unannounced, announced, empty, error, disabled, mismatched reference, network failure) compare baseline and extracted runtime. Full DOM strings (including template whitespace), probable state, prediction selection, request URL/options/count, storage and interval sets are byte/structurally identical. Snapshot SHA-256: `33da60082ff8d570a1ed77953f7143305596b68d73dedf50bf7a9d0534140ac3`.
- Memory-only fault injection detects missing initialize wiring, wrong catalog callback and omitted response commit. No mutated source is saved in the repository.
- The original four state-runtime cases were also run under a memory-only read interceptor: missing initialization produced four failures, wrong callback three, and missing commit three (all nonzero exits). With the interceptor removed, the focused runtime suite passed 27 cases three times. All 20 moved function bodies match baseline after only the stated dependency/reference substitutions and indentation changes.
- Overlapping initialization performs one in-flight API call and adds no timer/storage. Old responses cannot overwrite a new target. Existing request timing and the single 30-second ticker are retained.
- Module asset and factory are each referenced once; the deferred module loads before script.js. Controller construction is side-effect free.
- Full test/check: 1660 passing after the changes (previous recorded main: 1655). Syntax passes. No server or API contract changes.
- Full run initially exposed a pre-existing date-dependent 10/16 dry-run acceptance test after its deadline. Only that test's Date clock is fixed at 2026-10-16 09:00 JST. Fixture dates, worker and production behavior are unchanged.

### Existing limitations found and preserved

A target switch while a probable GET is still in flight can leave `isLoading` true: initialization aborts the old request and begins a fresh request token before the loading guard, then the old request's finally is stale. This is reproduced against baseline and extracted code and is not introduced by this refactor. The old-response test locks only rejection of stale data; it does not claim successful new-target loading in this race. This merits a separate targeted bug fix, not a silent behavior change in a boundary extraction.

An announced response with no valid `fetchedAt` can reach the existing shared date formatter and throw. Synthetic announced fixtures therefore use the API's valid timestamp contract. This pre-existing behavior is preserved.

## Reusable extraction rules

1. Match the existing namespace/factory/deferred load pattern and keep one bootstrap instance.
2. Keep the same state object; supply only domain state, shared helpers and existing guarded I/O.
3. Move the implementation as one domain, preserve API/DOM/storage contracts, and remove forwarding wrappers.
4. Compare actual runtime snapshots and request counts; inject missing wiring/commit faults in memory.
5. Version/load the new asset before bootstrap; run shared public/Asia/admin regressions and GET-only deployment checks.

## Current Results boundary (Phase 20)

Baseline for this section: `5afd48d1b6ecafd37abe1e42ff2130344edfd7fa`. This section supersedes the Phase 19 Results ownership notes; the original function inventory below remains a historical baseline.

### Candidate reassessment

| Candidate | Script functions at baseline | State / I/O | Coverage and complexity | Decision |
| --- | ---: | --- | --- | --- |
| Results/history/detail | 30, plus 7 result renderer functions | history, previous game, persisted result projection; 3 GET sites; auth and scoped storage | Real-runtime list/detail/cache/race/error coverage; Canvas and shared comparison helpers | Selected after keeping shared catalog/identity helpers outside |
| Daily Best Nine | 4 plus existing renderer | independent latest-published state, 1 GET | Strong API and runtime coverage; lower coupling | Safe alternative, not needed; existing owner stays |
| Prediction | 59 | central prediction, auth, persistence, editing state | Strong runtime coverage but many cross-domain writes | Keep |
| Position menu | 13 | prediction state and menu/viewport ownership | Pointer/portal/browser concerns | Keep |
| Drag / pointer / touch | 33 | pointer state, prediction, geometry | Browser interaction complexity | Keep |
| Game flow | 33 | catalog, prediction deadlines, selection, persistence | Strong runtime coverage but shared orchestration | Keep |

Counts follow the original domain grouping, with callback/alias limitations described above. No second domain is extracted.

### Ownership and interface

`frontend/public/results.js` follows the existing classic-script namespace/factory pattern: `Starting9Public.createPublicResultsController`. It moves 25 functions from script.js and 7 functions from the existing renderer. The `renderScoreResult` and `preserveDisplayedPublicResult` entry-file forwarding wrappers are removed. No compatibility wrappers replace them.

The controller exposes only operational entry points used by real callers: `fetchPrevious`, `refresh`, `maybeLoadFastPrevious`, `render`, `renderHistory`, `preserveDisplayedResult`, `bindEvents`. Nothing is exported for private test access. The factory does not fetch or install listeners. Bootstrap calls the result event binder; its once flag prevents duplicate click/change registration.

The live state view has only `resultHistory`, `previousResultGame` and `result` accessors. Each getter returns the original app field/object; setters forward to that same app field. There is no copied state. This is important because anonymous refresh replaces the history object. Cache ownership remains `state.resultHistory.detailCache`; selection, canonical cache keys and the compatibility result projection retain their existing semantics. Existing request promises move into the controller instance without duplication.

Shared `getFastPreviousResultGame` remains the catalog selection boundary in script.js. `getResultHistoryGameId` remains shared with independent Best Nine metadata, and `getPublicResultAvailability` remains shared with prediction availability. These are real shared implementations, not module forwarding wrappers. Bootstrap/account integration may still update the existing persisted result projection; this refactor does not redesign that compatibility flow.

26 explicit dependency properties (including constants and the narrow state view):

- `state`
- `apiClient`
- `requestGuard`
- `storage`
- `resultStorageKey`
- `getAuthApiBaseUrl`
- `getFastPreviousResultGame`
- `getPredictionAccountUser`
- `syncPublicAppState`
- `getPublicResultAvailability`
- `getResultHistoryGameId`
- `remotePredictionToLocal`
- `scoreLineup`
- `normalizePlayerKey`
- `getHitCounts`
- `createScoreBreakdown`
- `normalizePosition`
- `getPositionCategory`
- `createPlayerNameHtml`
- `formatPlayerNameForDisplay`
- `createPredictionSummary`
- `formatPublicJstDateTime`
- `escapeHtml`
- `LINEUP_SIZE`
- `SCORE_MAX`
- `afterRenderHistory`

This is one property above the suggested 20–25 range, not an unbounded app context. Dependencies are the narrow result state view, existing API/request guard, scoped storage and its unchanged key, auth/API-base readers, catalog selection callback, shared identity/availability/formatting helpers, existing comparison helpers, display constants, and app-level synchronization callbacks. No window/document/all-functions bundle or cross-domain mutable state is supplied.

The result renderer functions are now in results.js. `render-results.js` retains its existing factory name solely for the independent Daily Best Nine renderer. Its GET, latest-published targeting, state lifecycle and rendering body are unchanged. Selecting or failing result A/B never writes Best Nine state. The controller has no reference to `state.dailyBestNine`, prediction, roster, probable-starter or pointer state.

The existing `scoreLineup`, `getHitCounts` and `createScoreBreakdown` implementations remain in script.js unchanged. Results calls these pre-existing comparison helpers where it already did before extraction; no server-scoring implementation, score write or new recomputation path is introduced. The existing API totalScore and legacy display-comparison behavior are preserved, not silently redesigned.

The sole app-wide rendering callback is `afterRenderHistory`, retaining the existing prediction-surface refresh after history rendering. It cannot mutate controller state or start result initialization. Factory construction and shared helper callbacks create no initialization cycle.

### Metrics and change surface

| Metric | Before | After |
| --- | ---: | ---: |
| script.js logical lines | 4876 | 4047 |
| script.js top-level named functions | 261 | 234 |
| Moved result implementation functions in script.js | 25 | 0 |
| Result forwarding wrappers in script.js | 2 | 0 |
| Shared catalog/identity/availability helpers retained | 3 | 3 |
| Moved implementation state assignment sites (including history/previous aliases) | 47 | 0 in script.js |
| Literal result selectors in moved script functions | 6 | 0 in script.js |
| Result API call sites in script.js | 3 | 0 |
| results.js lines | 0 | 1046 |
| results.js functions | 0 | 32 moved + event binder + factory |
| render-results.js lines | 190 | 46 |
| Additional caches / data-state copies / timers | 0 | 0 |
| Result root click/change listeners per instance | 2 | 2, including repeated binding |

Example: a personal-detail display-rule change previously crossed script.js view-model/Canvas/table helpers and render-results.js selection/header/empty-state logic (two files). Those private result helpers now share results.js (one file). Bootstrap, shared scoring/formatting, auth and Best Nine do not need editing. The new file remains one domain rather than creating extra abstraction layers.

### Validation and review

- Before extraction: 45 focused result/history/table/share/Best Nine cases passed.
- Eleven fixtures were recorded against baseline before edits: anonymous, authenticated, A open, A→B switch, A cache reopen, stale B response, empty list, list error, detail error, Best Nine error and HTTP 401. Baseline and extracted runtimes have identical full DOM strings, result/previous/Best Nine and other app states, request URLs/options/counts, storage, interval sets and result-root listener registrations. Snapshot SHA-256: `22180a5108045d8f3f471989b2b0db60c72fa255cdb7149b8c8bcc69e64cdfdf`.
- Existing 11 result-runtime behavior cases were not rewritten for the new implementation. Three added cases cover duplicate event binding, overlapping history reads and live history-object replacement. The Canvas execution check now follows actual public previous/list/detail operations in the existing runtime harness, with an optional Canvas factory; private renderer extraction/VM execution is removed from that case. Static geometry, CSS, retired-surface and asset checks are maintained against the shipped assets.
- In-memory faults made the result-runtime suite fail: no controller initialization (14 failures), disabled selected-result commit (3), removed stale-response guard (1), leaked selected ID into Best Nine (5). Interceptors are outside the repository and no mutated product source is saved.
- Repeated Results/Canvas suite: 28 cases passed three times, with no open handles. Pending race responses are explicitly completed. Ordinary history/detail request counts and scoped storage remain equal to baseline. Rebinding adds no result listener, action or request.
- 32 moved function bodies were compared mechanically; only explicit dependency references, private-call connections, the existing cross-domain render callback and indentation changed. No user-visible text/layout/API/storage/score policy changed.
- Full check: 1663 passing (baseline 1660), syntax 342 JS files, diff check passed. Public game/prediction/roster/probable-starter/result/Best Nine/position/drag, Asia sequential and admin tests are included.
- Self-review corrected an omitted coordinator method connection and a renderer call that still pointed to the old dependency slot. The unchanged behavior suite caught both before commit; snapshot comparison then passed.

The Phase 19 probable-starter limitations remain unrelated and unchanged. No new existing Results bug was fixed during extraction. The independent Daily Best Nine lifecycle was subsequently selected for Phase 21; no other domain is included here.

## Current Daily Best Nine boundary (Phase 21)

Baseline for this section: `019bd97443061f7ee584f7bcb969e5649a06fe7a`. This section supersedes earlier Daily Best Nine ownership notes; those counts remain as historical Phase 19/20 inventory.

### Contract and ownership

Daily Best Nine is one independent latest-published widget. Its request remains `GET /api/results/daily-best-nine` with the existing public API client and no selected-game query. The server chooses the latest published game. The controller never reads result selection, result detail/cache, prediction selection, roster, or probable-starter state. It records the canonical `internalGameId` returned by the endpoint, with the existing `gameId` field as compatibility fallback; no Results identity helper is needed.

`frontend/public/daily-best-nine.js` defines `Starting9Public.createDailyBestNineController`. It owns initialization, refresh, request sequencing in the existing canonical `state.dailyBestNine` object, loading/error/empty publication state, and the call to render. Its narrow dependencies are the live `dailyBestNine` state accessor, existing public API client, auth API base URL reader, and existing renderer callback (4). The module has no result-domain or DOM selector dependency and adds no cache, storage, event listener, or timer. Initialization retains its first request promise so duplicate initialization shares the same GET. Explicit refresh remains available through the controller's `refresh` method.

The existing `frontend/public/render-results.js` is retained as a separately usable renderer. It owns only `dailyBestNineCard` and `dailyBestNineContent` selectors and preserves the existing published/empty/loading/error markup. It receives the same canonical state object. The existing factory name is kept for compatibility; no renderer consolidation was needed.

`script.js` creates one controller and connects the existing coordinator initialization and render slots directly to its methods. `renderAll` calls the controller renderer. There are no forwarding functions. `frontend/public/results.js` remains independent in both directions. `frontend/public/state.js` continues to project the same state reference to app state.

### Metrics and verification

| Metric | Before Phase 21 | After extraction |
| --- | ---: | ---: |
| `script.js` logical lines | 4047 | 3990 |
| `script.js` top-level named functions | 234 | 230 |
| Best Nine functions in `script.js` | reset, initialize, fetch, render wrapper (4) | 0 |
| Best Nine forwarding wrappers | 1 render wrapper | 0 |
| Best Nine request sites in `script.js` | 1 | 0 |
| Controller API | inline functions | `initialize`, `refresh`, `render` |
| Controller dependencies | inline/shared | 4 explicit values |
| Direct Best Nine DOM selectors in controller | 0 | 0 |
| Renderer selectors | 2 | 2 (unchanged) |
| Added storage/timer/listener/cache paths | 0 | 0 |

The controller reads and writes only the canonical `state.dailyBestNine` object and the six existing fields (`isLoading`, `requestId`, `gameId`, `status`, `rows`, `message`); it keeps the same state object reference, including reset/error paths. The single renderer dependency keeps DOM ownership in the separately testable rendering file. The coordinator still starts the same optional initialization once after catalog load; duplicate controller initialization returns the same in-flight/completed promise and does not create a second GET.

Baseline runtime fixtures covered available, empty, API error, loading, personal result A, personal result B, personal result error, and explicit refresh. Post-extraction snapshots cover the same public DOM, widget state, request URL/options/count, storage, and timers. Result A/B selection and result errors leave the latest-published widget state and HTML unchanged. The controller idempotence test verifies a pending initialization is shared and makes one request. Daily Best Nine API and renderer contract tests remain in place.

The four requested failure injections are run against the runtime suite in memory: missing initialization, missing state commit, selected-result coupling, and non-idempotent duplicate initialization. Mutated source stays outside the repository. Daily Best Nine remains the only domain extracted in Phase 21; Prediction, game flow, position and drag are not part of this change.

## Function-level inventory (Phase 19 baseline)

Each row: domain, direct caller references, direct named callees, syntactic state R/W and literal DOM selectors. “—” means no direct match, not proof of no indirect dependency. Event registrations and I/O counts are summarized above; browser/global interaction follows the domain boundary notes.

| Function | Domain | Callers | Callees | State R / W | Literal DOM selectors |
| --- | --- | --- | --- | --- | --- |
| `getGameScopedStorageKey` | storage | `saveGameScopedStorage`, `loadGameScopedStorage`, `removeGameScopedStorage` | — | — / — | — |
| `getStorageValueGameId` | storage | `saveGameScopedStorage`, `loadGameScopedStorage` | — | — / — | — |
| `getActiveStorageGameId` | storage | `saveGameScopedStorage`, `loadGameScopedStorage`, `removeGameScopedStorage` | — | `predictionTargetGameId`, `predictionTargetGame` / — | — |
| `saveGameScopedStorage` | storage | `persistCurrentGameScopedState` | `getGameScopedStorageKey`, `getStorageValueGameId`, `getActiveStorageGameId` | — / — | — |
| `loadGameScopedStorage` | storage | `hydrateGameScopedState` | `getGameScopedStorageKey`, `getStorageValueGameId`, `getActiveStorageGameId` | — / — | — |
| `removeGameScopedStorage` | storage | — | `getGameScopedStorageKey`, `getActiveStorageGameId` | — / — | — |
| `syncPublicAppState` | bootstrap | `setPublicCurrentGame`, `initializePublicGameCatalog`, `fetchPreviousResultGame`, `resolveResultHistorySelection`, `refreshResultHistory`, `loadResultHistoryGame`, `syncPredictionFromAccount` | — | — / — | — |
| `beginPublicRequest` | bootstrap | `initializeProbableStarter`, `refreshProbableStarterTarget`, `refreshPredictionTarget`, `setPublicCurrentGame`, `initializePublicGameCatalog`, `fetchPreviousResultGame`, `fetchStoredProbableStarter`, `refreshResultHistory`, `loadResultHistoryGame`, `syncPredictionFromAccount` | — | — / — | — |
| `isCurrentPublicRequest` | bootstrap | `refreshPredictionTarget`, `initializePublicGameCatalog`, `fetchPreviousResultGame`, `fetchStoredProbableStarter`, `refreshResultHistory`, `loadResultHistoryGame`, `syncPredictionFromAccount` | — | — / — | — |
| `preserveDisplayedPublicResult` | results | `setPublicCurrentGame`, `syncPredictionFromAccount` | — | — / — | — |
| `discardStoredStateForGame` | storage | `setPublicCurrentGame` | `removeFromStorage` | — / — | — |
| `schedulePublicNonCritical` | bootstrap | `initializeAuthDependentFeatures` | — | — / — | — |
| `initializeAuthDependentFeatures` | auth/session | — | `schedulePublicNonCritical`, `fetchUserAchievements`, `fetchPreviousResultGame`, `refreshResultHistory` | — / — | — |
| `bindEvents` | bootstrap | — | `fetchUserAchievements`, `setCandidateRosterFilter`, `closeAllPositionMenus`, `closePlayerDetails` | — / — | `predictionForm`, `resetPredictionButton`, `refreshAchievementsButton`, `sharePredictionButton`, `saveSavedPredictionImageButton`, `predictionCtaButton`, `editSavedPredictionButton`, `publicGameSelectionMeta`, `resultHistoryList`, `[data-roster-filter]` |
| `buildAchievementsApiUrl` | notices / status | `fetchUserAchievements` | `getAuthApiBaseUrl` | — / — | — |
| `renderAchievements` | notices / status | `fetchUserAchievements`, `renderAll` | `createAchievementCardHtml`, `getPredictionAccountUser` | `achievements` / — | `achievementsPanel`, `achievementsList` |
| `createAchievementCardHtml` | notices / status | `renderAchievements` | `formatDateTime`, `escapeHtml` | — / — | — |
| `fetchUserAchievements` | notices / status | `initializeAuthDependentFeatures`, `bindEvents` | `buildAchievementsApiUrl`, `renderAchievements`, `getPredictionAccountUser` | `achievements` / `achievements` | — |
| `buildLineupPicker` | prediction | — | `getPredictionCandidateNames`, `createLineupSlot`, `createPlayerChip` | — / — | — |
| `getPredictionCandidateNames` | roster integration | `buildLineupPicker` | `getPredictionCandidatePlayers` | — / — | — |
| `isOfficialNpbPlayerId` | roster integration | `createTemporaryPublicPlayer`, `createPredictionPayload` | — | — / — | — |
| `temporaryPublicPlayerCategory` | roster integration | `createTemporaryPublicPlayer` | — | — / — | — |
| `createTemporaryPublicPlayer` | roster integration | `getPredictionCandidatePlayers` | `isOfficialNpbPlayerId`, `temporaryPublicPlayerCategory` | — / — | — |
| `getPredictionCandidatePlayers` | roster integration | `getPredictionCandidateNames`, `getUniquePlayerData` | `createTemporaryPublicPlayer`, `normalizeRosterEntries`, `normalizePlayerKey` | `publicRoster` / — | — |
| `hasUsablePublicRosterForCurrentGame` | roster integration | `isPlayerInCurrentRoster`, `startPredictionDeadlineTicker`, `renderPredictionDeadline`, `updatePredictionSaveButton` | `getGameDayRosterTargetInternalGameId` | `predictionTargetGame`, `publicRoster` / — | — |
| `setCandidateRosterFilter` | roster integration | `bindEvents` | `saveToStorage`, `renderPicker` | `candidateRosterFilter` / `candidateRosterFilter` | — |
| `createLineupSlot` | prediction | `buildLineupPicker` | `createPositionControl`, `handleSlotDragStart`, `handleSlotDragOver`, `handleSlotDrop`, `handleDragEnd`, `handleLineupPointerDown`, `setActiveOrder`, `clearSlot`, `ensurePredictionEditingAllowed`, `showSlotPlayerDetails` | `pointerSuppressClickUntil` / — | — |
| `createPositionControl` | position menu | `createLineupSlot` | `togglePositionMenu`, `selectPositionForSlot`, `closeAllPositionMenus`, `handlePositionDragStart`, `handlePositionDragEnd`, `handlePositionPointerDown`, `shouldUseNativeDrag`, `ensurePredictionEditingAllowed`, `clearMessage` | `pointerSuppressClickUntil` / — | — |
| `togglePositionMenu` | position menu | `createPositionControl` | `positionMobilePositionMenu`, `updatePositionMenuState`, `closeAllPositionMenus`, `ensurePredictionEditingAllowed` | — / — | — |
| `mountPositionMenuPortal` | position menu | `positionMobilePositionMenu` | — | — / — | — |
| `restorePositionMenuHost` | position menu | `closeAllPositionMenus` | — | — / — | — |
| `getViewportClampedMenuLeft` | position menu | `positionMobilePositionMenu` | — | — / — | — |
| `getPositionMenuViewportSize` | position menu | `positionMobilePositionMenu` | — | — / — | — |
| `positionMobilePositionMenu` | position menu | `togglePositionMenu`, `repositionOpenPositionMenu` | `mountPositionMenuPortal`, `getViewportClampedMenuLeft`, `getPositionMenuViewportSize` | — / — | — |
| `repositionOpenPositionMenu` | position menu | `bindEvents` | `positionMobilePositionMenu`, `closeAllPositionMenus` | — / — | — |
| `updatePositionMenuState` | position menu | `togglePositionMenu` | `getLineupValues` | — / — | `.position-menu-option` |
| `selectPositionForSlot` | position menu | `createPositionControl` | `createPositionSelectionLineup`, `ensurePredictionEditingAllowed`, `getLineupValues`, `setLineupValues` | — / — | — |
| `createPositionSelectionLineup` | position menu | `selectPositionForSlot` | `normalizePosition`, `createLineupItem`, `normalizeLineup` | — / — | — |
| `closeAllPositionMenus` | position menu | `bindEvents`, `createPositionControl`, `togglePositionMenu`, `repositionOpenPositionMenu`, `handlePositionDragStart`, `handlePositionDragEnd`, `handleSlotDrop`, `activatePointerInteraction`, `clearSlot`, `ensurePredictionEditingAllowed` | `restorePositionMenuHost` | — / — | `.position-menu`, `.position-button` |
| `createPlayerChip` | prediction | `buildLineupPicker` | `handlePlayerDragStart`, `handleDragEnd`, `handlePlayerPointerDown`, `shouldUseNativeDrag`, `assignPlayerToActiveSlot`, `ensurePredictionEditingAllowed`, `createPlayerLabelHtml`, `applyPlayerCategoryClass`, `showPlayerDetails` | `pointerSuppressClickUntil` / — | — |
| `handlePlayerDragStart` | drag / pointer / touch | `createPlayerChip` | `setDragData`, `ensurePredictionEditingAllowed` | — / — | — |
| `handleSlotDragStart` | drag / pointer / touch | `createLineupSlot` | `setDragData`, `ensurePredictionEditingAllowed` | — / — | — |
| `handlePositionDragStart` | drag / pointer / touch | `createPositionControl` | `closeAllPositionMenus`, `setDragData`, `ensurePredictionEditingAllowed` | — / — | — |
| `handlePositionDragEnd` | drag / pointer / touch | `createPositionControl` | `closeAllPositionMenus`, `handleDragEnd` | — / — | — |
| `setDragData` | drag / pointer / touch | `handlePlayerDragStart`, `handleSlotDragStart`, `handlePositionDragStart` | — | — / — | — |
| `handleSlotDragOver` | drag / pointer / touch | `createLineupSlot` | `isPredictionEditingLocked` | — / — | — |
| `handleSlotDrop` | drag / pointer / touch | `createLineupSlot` | `closeAllPositionMenus`, `getDragData`, `assignPlayerToSlot`, `movePositionBetweenSlots`, `ensurePredictionEditingAllowed` | — / — | — |
| `getDragData` | drag / pointer / touch | `handleSlotDrop` | — | — / — | — |
| `handleDragEnd` | drag / pointer / touch | `createLineupSlot`, `createPlayerChip`, `handlePositionDragEnd` | — | — / — | `.lineup-slot.is-drop-target` |
| `handlePlayerPointerDown` | drag / pointer / touch | `createPlayerChip` | `beginPointerInteraction` | — / — | — |
| `handleLineupPointerDown` | drag / pointer / touch | `createLineupSlot` | `beginPointerInteraction` | — / — | — |
| `handlePositionPointerDown` | drag / pointer / touch | `createPositionControl` | `beginPointerInteraction`, `isPredictionEditingLocked` | — / — | — |
| `beginPointerInteraction` | drag / pointer / touch | `handlePlayerPointerDown`, `handleLineupPointerDown`, `handlePositionPointerDown`, `handleTouchInteractionStart` | `activatePointerInteraction`, `clearPointerInteraction`, `isPredictionEditingLocked` | `pointerInteraction` / `pointerInteraction` | — |
| `activatePointerInteraction` | drag / pointer / touch | `beginPointerInteraction`, `handlePointerInteractionMove` | `closeAllPositionMenus`, `createMobileDragGhost`, `isPredictionEditingLocked` | `pointerInteraction` / — | — |
| `handlePointerInteractionMove` | drag / pointer / touch | `bindEvents`, `handleTouchInteractionMove` | `activatePointerInteraction`, `clearPointerInteraction`, `updateMobileDragGhost` | `pointerInteraction` / — | — |
| `handlePointerInteractionEnd` | drag / pointer / touch | `bindEvents`, `handleTouchInteractionEnd` | `clearPointerInteraction`, `assignPlayerToSlot`, `movePositionBetweenSlots`, `moveLineupSlot` | `pointerInteraction`, `pointerSuppressClickUntil` / `pointerSuppressClickUntil` | — |
| `handlePointerInteractionCancel` | drag / pointer / touch | `bindEvents`, `handleTouchInteractionCancel` | `clearPointerInteraction` | `pointerInteraction`, `pointerSuppressClickUntil` / `pointerSuppressClickUntil` | — |
| `clearPointerInteraction` | drag / pointer / touch | `beginPointerInteraction`, `handlePointerInteractionMove`, `handlePointerInteractionEnd`, `handlePointerInteractionCancel` | `clearMobileDragGhost` | `pointerInteraction` / `pointerInteraction` | `.lineup-slot.is-drop-target` |
| `createMobileDragGhost` | drag / pointer / touch | `activatePointerInteraction` | `updateMobileDragGhost` | — / — | — |
| `updateMobileDragGhost` | drag / pointer / touch | `handlePointerInteractionMove`, `createMobileDragGhost` | — | — / — | — |
| `clearMobileDragGhost` | drag / pointer / touch | `clearPointerInteraction` | — | — / — | — |
| `createTouchPointerEvent` | drag / pointer / touch | `handleTouchInteractionStart`, `handleTouchInteractionMove`, `handleTouchInteractionEnd`, `handleTouchInteractionCancel` | — | — / — | — |
| `getTouchInteractionTarget` | drag / pointer / touch | `handleTouchInteractionStart` | — | — / — | — |
| `handleTouchInteractionStart` | drag / pointer / touch | `bindEvents` | `beginPointerInteraction`, `createTouchPointerEvent`, `getTouchInteractionTarget` | `pointerInteraction` / — | — |
| `getChangedTouch` | drag / pointer / touch | `handleTouchInteractionMove`, `handleTouchInteractionEnd`, `handleTouchInteractionCancel` | — | — / — | — |
| `handleTouchInteractionMove` | drag / pointer / touch | `bindEvents` | `handlePointerInteractionMove`, `createTouchPointerEvent`, `getChangedTouch` | `pointerInteraction` / — | — |
| `handleTouchInteractionEnd` | drag / pointer / touch | `bindEvents` | `handlePointerInteractionEnd`, `createTouchPointerEvent`, `getChangedTouch` | `pointerInteraction` / — | — |
| `handleTouchInteractionCancel` | drag / pointer / touch | `bindEvents` | `handlePointerInteractionCancel`, `createTouchPointerEvent`, `getChangedTouch` | `pointerInteraction` / — | — |
| `shouldUseNativeDrag` | drag / pointer / touch | `createPositionControl`, `createPlayerChip`, `renderPicker` | — | — / — | — |
| `setActiveOrder` | prediction | `createLineupSlot` | `renderPicker`, `clearMessage` | `activeOrder` / `activeOrder` | — |
| `assignPlayerToActiveSlot` | prediction | `createPlayerChip`, `showPlayerDetails` | `getTargetOrder`, `findNextEmptyIndex`, `ensurePredictionEditingAllowed`, `getLineupValues`, `setLineupValues`, `createLineupItem`, `renderPicker` | `activeOrder` / `activeOrder` | — |
| `assignPlayerToSlot` | prediction | `handleSlotDrop`, `handlePointerInteractionEnd` | `moveLineupItem`, `autoFillPredictionPosition`, `findNextEmptyIndex`, `ensurePredictionEditingAllowed`, `getLineupValues`, `setLineupValues`, `renderPicker`, `clearMessage` | `activeOrder` / `activeOrder` | — |
| `moveLineupItem` | drag / pointer / touch | `assignPlayerToSlot` | `createLineupItem`, `normalizeLineup` | — / — | — |
| `movePositionBetweenSlots` | drag / pointer / touch | `handleSlotDrop`, `handlePointerInteractionEnd` | `moveLineupPosition`, `ensurePredictionEditingAllowed`, `getLineupValues`, `setLineupValues`, `renderPicker`, `clearMessage` | `activeOrder` / `activeOrder` | — |
| `moveLineupSlot` | drag / pointer / touch | `handlePointerInteractionEnd` | `findNextEmptyIndex`, `ensurePredictionEditingAllowed`, `getLineupValues`, `setLineupValues`, `createLineupItem`, `normalizeLineup`, `clearMessage` | `activeOrder` / `activeOrder` | — |
| `moveLineupPosition` | drag / pointer / touch | `movePositionBetweenSlots` | `createLineupItem`, `normalizeLineup` | — / — | — |
| `autoFillPredictionPosition` | prediction | `assignPlayerToSlot` | `resolveAutoFillPosition`, `createLineupItem`, `getPlayerData` | — / — | — |
| `resolveAutoFillPosition` | prediction | `autoFillPredictionPosition` | `normalizePosition`, `normalizeDisplayPosition` | — / — | — |
| `getTargetOrder` | prediction | `assignPlayerToActiveSlot` | `findFirstEmptyIndex` | `activeOrder` / — | — |
| `findNextEmptyIndex` | prediction | `assignPlayerToActiveSlot`, `assignPlayerToSlot`, `moveLineupSlot` | — | — / — | — |
| `findFirstEmptyIndex` | prediction | `getTargetOrder` | — | — / — | — |
| `clearSlot` | prediction | `createLineupSlot` | `closeAllPositionMenus`, `clearLineupItem`, `ensurePredictionEditingAllowed`, `getLineupValues`, `setLineupValues`, `normalizePickerName`, `renderPicker` | `activeOrder` / `activeOrder` | — |
| `clearLineupItem` | prediction | `clearSlot` | `createLineupItem`, `normalizeLineup` | — / — | — |
| `normalizeRosterSnapshot` | roster integration | `getRosterSnapshotForCurrentGame` | `normalizeRosterEntries` | — / — | — |
| `normalizeRosterEntries` | roster integration | `getPredictionCandidatePlayers`, `normalizeRosterSnapshot`, `getPlayerData` | `createRosterEntryKey` | — / — | — |
| `createRosterEntryKey` | roster integration | `normalizeRosterEntries` | `normalizePlayerKey` | — / — | — |
| `getGameDayRosterTargetInternalGameId` | roster integration | `hasUsablePublicRosterForCurrentGame`, `getRosterSnapshotForCurrentGame`, `fetchGameDayRosterSnapshot` | `getCurrentGameId` | `predictionTargetGame`, `probableStarter` / — | — |
| `getRosterSnapshotForCurrentGame` | roster integration | — | `normalizeRosterSnapshot`, `getGameDayRosterTargetInternalGameId`, `loadFromStorage` | `predictionTargetGame` / — | — |
| `isPlayerInCurrentRoster` | roster integration | `isRegisteredFielderCandidate` | `hasUsablePublicRosterForCurrentGame`, `rosterEntryMatchesPlayer` | `publicRoster` / — | — |
| `isRegisteredFielderCandidate` | roster integration | — | `isPlayerInCurrentRoster` | — / — | — |
| `rosterEntryMatchesPlayer` | roster integration | `isPlayerInCurrentRoster` | `normalizePlayerKey` | — / — | — |
| `initializeRosterCandidateSync` | roster integration | `refreshPredictionTarget` | — | — / — | — |
| `getProbableStarterActualStartAt` | probable starter | `getProbableStarterCutoffAt` | — | — / — | — |
| `getProbableStarterCutoffAt` | probable starter | `selectProbableStarterGame` | `getProbableStarterActualStartAt`, `parseJstScheduleDateTime` | — / — | — |
| `selectProbableStarterGame` | probable starter | `getPreferredProbableStarterGame` | `getProbableStarterCutoffAt`, `isScheduleGameUnavailable`, `isNormalManagedSchedule`, `getScheduleSortValue` | — / — | — |
| `getPreferredProbableStarterGame` | probable starter | `initializeProbableStarter`, `refreshProbableStarterTarget` | `selectProbableStarterGame` | `publicGameCatalog` / — | — |
| `resetProbableStarterDisplay` | probable starter | `initializeProbableStarter`, `refreshProbableStarterTarget` | — | `probableStarter` / `probableStarter` | — |
| `initializeProbableStarter` | probable starter | — | `beginPublicRequest`, `getPreferredProbableStarterGame`, `resetProbableStarterDisplay`, `fetchStoredProbableStarter`, `renderProbableStarter` | `probableStarter` / — | — |
| `refreshProbableStarterTarget` | probable starter | `startPredictionDeadlineTicker` | `beginPublicRequest`, `getPreferredProbableStarterGame`, `resetProbableStarterDisplay`, `fetchStoredProbableStarter`, `renderProbableStarter` | `probableStarter` / `probableStarter` | — |
| `refreshPredictionTarget` | game selection | `startPredictionDeadlineTicker` | `beginPublicRequest`, `isCurrentPublicRequest`, `initializeRosterCandidateSync`, `resolvePredictionTargetGame`, `getLoadedGameSchedule`, `getPreferredPublicGameSelection`, `setPublicCurrentGame`, `renderAll`, `refreshGameDayNoticeStatus` | `publicGameCatalog`, `predictionTargetGame`, `predictionTargetGameId`, `predictionTargetNotice` / `predictionTargetNotice` | — |
| `resolvePredictionTargetGame` | game selection | `refreshPredictionTarget` | — | — / — | — |
| `getLoadedGameSchedule` | game selection | `refreshPredictionTarget` | — | — / — | — |
| `buildPublicGamesApiUrl` | game selection | `initializePublicGameCatalog` | `getAuthApiBaseUrl` | — / — | — |
| `buildPreviousResultGameApiUrl` | results | `fetchPreviousResultGame` | `getAuthApiBaseUrl` | — / — | — |
| `getFastPreviousResultGame` | results | `maybeLoadFastPreviousResult` | `isPublicGamePublished`, `parseJstScheduleDateTime`, `getScheduleSortValue` | `publicGameCatalog` / — | — |
| `maybeLoadFastPreviousResult` | results | `refreshResultHistory` | `getFastPreviousResultGame`, `loadResultHistoryGame`, `getPredictionAccountUser` | `resultHistory` / — | — |
| `mergePublicGameSchedules` | game selection | `initializePublicGameCatalog` | `isNormalManagedSchedule`, `getScheduleSortValue` | — / — | — |
| `getPublicSelectableGames` | game selection | `selectInitialPublicGame` | `isScheduleGameUnavailable`, `isNormalManagedSchedule`, `getScheduleDate`, `getScheduleSortValue`, `getJapanDateString` | — / — | — |
| `selectInitialPublicGame` | game selection | `getPreferredPublicGameSelection` | `getPublicSelectableGames`, `isPublicGamePublished`, `parseJstScheduleDateTime`, `isScheduleGameUnavailable`, `resolvePredictionDeadline`, `getScheduleDate`, `getScheduleSortValue`, `getJapanDateString` | — / — | — |
| `getPreferredPublicGameSelection` | game selection | `refreshPredictionTarget`, `initializePublicGameCatalog` | `selectInitialPublicGame` | `publicGameCatalog` / — | — |
| `persistCurrentGameScopedState` | storage | `setPublicCurrentGame` | `saveGameScopedStorage` | — / — | — |
| `hydrateGameScopedState` | storage | `setPublicCurrentGame` | `loadGameScopedStorage` | `prediction`, `actual`, `result` / `prediction`, `actual`, `result` | — |
| `handlePublicGameSelectionMetaClick` | game selection | `bindEvents` | `initializePublicGameCatalog` | — / — | — |
| `formatPublicPredictionGameLabel` | prediction | `getPublicPredictionGameMetaLines` | `getScheduleDate`, `getScheduleStartTime` | — / — | — |
| `getPublicPredictionGameMetaLines` | prediction | `renderPublicGameSelectionMeta` | `formatPublicPredictionGameLabel`, `getScheduleDate`, `getScheduleStartTime` | — / — | — |
| `setPublicCurrentGame` | game selection | `refreshPredictionTarget`, `initializePublicGameCatalog` | `syncPublicAppState`, `beginPublicRequest`, `preserveDisplayedPublicResult`, `discardStoredStateForGame`, `persistCurrentGameScopedState`, `hydrateGameScopedState`, `createEmptyPredictionRemoteState` | `predictionTargetGame`, `predictionTargetGameId`, `predictionRemote`, `prediction`, `actual`, `result`, `predictionTargetNotice` / `predictionRemote`, `prediction`, `actual`, `result`, `predictionTargetGameId`, `predictionTargetGame`, `predictionTargetNotice` | — |
| `initializePublicGameCatalog` | game selection | `handlePublicGameSelectionMetaClick` | `syncPublicAppState`, `beginPublicRequest`, `isCurrentPublicRequest`, `buildPublicGamesApiUrl`, `mergePublicGameSchedules`, `getPreferredPublicGameSelection`, `setPublicCurrentGame`, `refreshPredictionDeadlineState`, `renderPublicGameSelectionMeta` | `publicGameCatalog` / — | — |
| `isPublicGamePublished` | game selection | `getFastPreviousResultGame`, `selectInitialPublicGame`, `getPublicGameStatusView` | — | `predictionRemote` / — | — |
| `fetchPreviousResultGame` | results | `initializeAuthDependentFeatures` | `syncPublicAppState`, `beginPublicRequest`, `isCurrentPublicRequest`, `buildPreviousResultGameApiUrl`, `resolveResultHistorySelection`, `renderScoreResult` | `previousResultGame` / — | — |
| `buildProbableStarterApiUrl` | probable starter | `fetchStoredProbableStarter` | `getAuthApiBaseUrl` | — / — | — |
| `applyStoredProbableStarter` | probable starter | `fetchStoredProbableStarter` | — | `probableStarter` / `probableStarter` | — |
| `getProbableStarterReferenceDiagnostics` | probable starter | `fetchStoredProbableStarter` | `normalizeScheduleTeamCode`, `parseJstScheduleDateTime` | — / — | — |
| `fetchStoredProbableStarter` | probable starter | `initializeProbableStarter`, `refreshProbableStarterTarget` | `beginPublicRequest`, `isCurrentPublicRequest`, `buildProbableStarterApiUrl`, `applyStoredProbableStarter`, `getProbableStarterReferenceDiagnostics`, `renderProbableStarter` | `probableStarter` / `probableStarter` | — |
| `normalizeScheduleTeamCode` | game selection | `getProbableStarterReferenceDiagnostics` | — | — / — | — |
| `getFightersStarter` | probable starter | `renderProbableStarterDisplay` | — | — / — | — |
| `formatScheduledGameForLog` | probable starter | `renderProbableStarterNotice` | — | — / — | — |
| `handleAuthStateChanged` | auth/session | `initializeAuthDependentFeatures` | — | — / — | — |
| `startPredictionDeadlineTicker` | game selection | — | `hasUsablePublicRosterForCurrentGame`, `refreshProbableStarterTarget`, `refreshPredictionTarget`, `refreshPredictionDeadlineState`, `renderPredictionDeadline`, `renderPicker` | `publicRoster` / `publicRoster` | — |
| `getPredictionDeadlineGameId` | game selection | `refreshPredictionDeadlineState` | `getCurrentGameId` | — / — | — |
| `parseJstScheduleDateTime` | game selection | `getProbableStarterCutoffAt`, `getFastPreviousResultGame`, `selectInitialPublicGame`, `getProbableStarterReferenceDiagnostics`, `resolvePredictionDeadline` | `getScheduleDate`, `getScheduleStartTime` | — / — | — |
| `getPredictionDeadlineMinutesBeforeStart` | game selection | `resolvePredictionDeadline` | — | — / — | — |
| `getPublicGameUnavailableKind` | game selection | `isScheduleGameUnavailable`, `getPublicResultAvailability`, `getPublicGameStatusView` | — | — / — | — |
| `isScheduleGameUnavailable` | game selection | `selectProbableStarterGame`, `getPublicSelectableGames`, `selectInitialPublicGame`, `resolvePredictionDeadline`, `renderPublicPredictionSurface` | `getPublicGameUnavailableKind` | — / — | — |
| `getPublicResultAvailability` | results | `resolveResultHistorySelection`, `loadResultHistoryGame`, `renderResultHistory` | `getPublicGameUnavailableKind` | — / — | — |
| `resolvePredictionDeadline` | game selection | `selectInitialPublicGame`, `refreshPredictionDeadlineState` | `parseJstScheduleDateTime`, `getPredictionDeadlineMinutesBeforeStart`, `isScheduleGameUnavailable` | `publicGameCatalog`, `predictionTargetGame` / — | — |
| `getEffectivePredictionDeadline` | game selection | `isPredictionEditingLocked`, `ensurePredictionEditingAllowed`, `renderPredictionDeadline`, `renderResultHistory`, `syncPredictionFromAccount`, `renderPublicPredictionSurface`, `renderPublicGameSelectionMeta` | — | `predictionDeadline` / — | — |
| `refreshPredictionDeadlineState` | game selection | `initializePublicGameCatalog`, `startPredictionDeadlineTicker` | `getPredictionDeadlineGameId`, `resolvePredictionDeadline`, `renderPredictionDeadline`, `renderGameDayNoticeStatus`, `renderPicker` | `predictionDeadline` / `predictionDeadline` | — |
| `isPredictionEditingLocked` | prediction | `handleSlotDragOver`, `handlePositionPointerDown`, `beginPointerInteraction`, `activatePointerInteraction`, `ensurePredictionEditingAllowed`, `updatePredictionSaveButton`, `renderPicker`, `renderSavedPrediction`, `renderPredictionCta` | `getEffectivePredictionDeadline` | — / — | — |
| `ensurePredictionEditingAllowed` | prediction | `createLineupSlot`, `createPositionControl`, `togglePositionMenu`, `selectPositionForSlot`, `createPlayerChip`, `handlePlayerDragStart`, `handleSlotDragStart`, `handlePositionDragStart`, `handleSlotDrop`, `assignPlayerToActiveSlot`, `assignPlayerToSlot`, `movePositionBetweenSlots`, `moveLineupSlot`, `clearSlot`, `savePredictionToAccount`, `deletePredictionFromAccount` | `closeAllPositionMenus`, `getEffectivePredictionDeadline`, `isPredictionEditingLocked`, `showMessage` | — / — | — |
| `formatPredictionDeadlineDateTime` | game selection | `renderPredictionDeadline` | — | — / — | — |
| `renderPredictionDeadline` | game selection | `startPredictionDeadlineTicker`, `refreshPredictionDeadlineState`, `renderAll` | `hasUsablePublicRosterForCurrentGame`, `getEffectivePredictionDeadline`, `formatPredictionDeadlineDateTime`, `formatPublicRemainingTime`, `renderPublicGameSelectionMeta`, `escapeHtml` | `predictionRemote` / — | `predictionDeadlineStatus`, `savePredictionButton`, `resetPredictionButton` |
| `getCurrentGameId` | game selection | `getGameDayRosterTargetInternalGameId`, `getPredictionDeadlineGameId`, `syncPredictionFromAccount`, `savePredictionToAccount`, `loadState`, `renderPublicGameSelectionMeta` | — | `predictionTargetGame`, `probableStarter` / — | — |
| `getAuthApiBaseUrl` | auth/session | `buildAchievementsApiUrl`, `buildPublicGamesApiUrl`, `buildPreviousResultGameApiUrl`, `buildProbableStarterApiUrl`, `fetchDailyBestNine`, `buildResultGamesApiUrl`, `buildCurrentPredictionApiUrl`, `buildGameDayNoticeApiUrl`, `fetchGameDayRosterSnapshot` | — | — / — | — |
| `resetDailyBestNine` | Daily Best Nine | `fetchDailyBestNine` | — | `dailyBestNine` / `dailyBestNine` | — |
| `initializeDailyBestNine` | Daily Best Nine | — | `fetchDailyBestNine` | — / — | — |
| `fetchDailyBestNine` | Daily Best Nine | `initializeDailyBestNine` | `getAuthApiBaseUrl`, `resetDailyBestNine`, `getResultHistoryGameId`, `renderDailyBestNine` | `dailyBestNine` / `dailyBestNine` | — |
| `initializePredictionRemoteSync` | prediction | — | `syncPredictionFromAccount` | — / — | — |
| `buildResultGamesApiUrl` | results | `refreshResultHistory`, `loadResultHistoryGame` | `getAuthApiBaseUrl` | — / — | — |
| `getResultHistoryGameId` | results | `fetchDailyBestNine`, `resolveResultHistorySelection`, `renderResultHistory` | — | — / — | — |
| `resolveResultHistorySelection` | results | `fetchPreviousResultGame`, `refreshResultHistory` | `syncPublicAppState`, `getPublicResultAvailability`, `getResultHistoryGameId`, `loadResultHistoryGame`, `clearStoredPublicResult`, `renderScoreResult` | `resultHistory`, `previousResultGame` / — | — |
| `formatResultHistoryTeamName` | results | `formatResultHistoryMatchup` | — | — / — | — |
| `formatResultHistoryMatchup` | results | `renderResultHistory` | `formatResultHistoryTeamName` | — / — | — |
| `refreshResultHistory` | results | `initializeAuthDependentFeatures`, `handleResultHistoryClick` | `syncPublicAppState`, `beginPublicRequest`, `isCurrentPublicRequest`, `maybeLoadFastPreviousResult`, `buildResultGamesApiUrl`, `resolveResultHistorySelection`, `renderResultHistory`, `getPredictionAccountUser`, `clearStoredPublicResult`, `renderScoreResult` | `resultHistory` / `resultHistory` | — |
| `handleResultHistoryClick` | results | `bindEvents` | `refreshResultHistory`, `renderResultHistory`, `getPredictionAccountUser` | `resultHistory` / `resultHistory` | — |
| `handleResultHistoryChange` | results | `bindEvents` | `loadResultHistoryGame` | — / — | — |
| `loadResultHistoryGame` | results | `maybeLoadFastPreviousResult`, `resolveResultHistorySelection`, `handleResultHistoryChange` | `syncPublicAppState`, `beginPublicRequest`, `isCurrentPublicRequest`, `getPublicResultAvailability`, `buildResultGamesApiUrl`, `renderResultHistory`, `remotePredictionToLocal`, `scoreLineup`, `renderScoreResult` | `resultHistory`, `result` / `result` | — |
| `renderResultHistory` | results | `refreshResultHistory`, `handleResultHistoryClick`, `loadResultHistoryGame`, `renderAll` | `getPublicResultAvailability`, `getEffectivePredictionDeadline`, `getResultHistoryGameId`, `formatResultHistoryMatchup`, `getPublicGameStatusView`, `renderPublicPredictionSurface`, `escapeHtml` | `resultHistory`, `predictionTargetGame` / — | `resultHistoryList` |
| `buildCurrentPredictionApiUrl` | prediction | `syncPredictionFromAccount`, `savePredictionToAccount`, `deletePredictionFromAccount` | `getAuthApiBaseUrl` | — / — | — |
| `getPredictionAccountUser` | auth/session | `renderAchievements`, `fetchUserAchievements`, `maybeLoadFastPreviousResult`, `refreshResultHistory`, `handleResultHistoryClick`, `getPredictionAccountStatus`, `syncPredictionFromAccount`, `savePredictionToAccount`, `deletePredictionFromAccount`, `renderPredictionCta` | — | — / — | — |
| `getPredictionAccountStatus` | auth/session | — | `getPredictionAccountUser` | — / — | — |
| `waitForPredictionAuthInitialization` | auth/session | — | — | — / — | — |
| `getPredictionAccountSaveErrorMessage` | auth/session | `savePredictionToAccount` | — | — / — | — |
| `syncPredictionFromAccount` | prediction | `initializePredictionRemoteSync` | `syncPublicAppState`, `beginPublicRequest`, `isCurrentPublicRequest`, `preserveDisplayedPublicResult`, `getEffectivePredictionDeadline`, `getCurrentGameId`, `buildCurrentPredictionApiUrl`, `getPredictionAccountUser`, `createEmptyPredictionRemoteState`, `remotePredictionToLocal`, `predictionsMatch`, `renderPredictionAccountStatus`, `normalizeLineup`, `scoreLineup`, `saveToStorage`, `removeFromStorage`, `renderPublicGameSelectionMeta`, `renderPicker`, `renderSavedPrediction`, `renderPredictionCta`, `renderScoreResult` | `predictionRemote`, `prediction`, `result` / `predictionRemote`, `prediction`, `result` | — |
| `createEmptyPredictionRemoteState` | prediction | `setPublicCurrentGame`, `syncPredictionFromAccount`, `deletePredictionFromAccount` | — | — / — | — |
| `createPlayerId` | shared formatting / player display | `createPredictionPayload`, `getLineupPlayerId` | — | — / — | — |
| `getUniquePlayerData` | shared formatting / player display | `createPredictionPayload`, `getLineupPlayerId` | `getPredictionCandidatePlayers`, `normalizePlayerKey` | — / — | — |
| `createPredictionPayload` | prediction | `savePredictionToAccount` | `isOfficialNpbPlayerId`, `createPlayerId`, `getUniquePlayerData`, `normalizeLineup` | — / — | — |
| `remotePredictionToLocal` | prediction | `loadResultHistoryGame`, `syncPredictionFromAccount` | `normalizePosition`, `normalizeLineup` | — / — | — |
| `predictionsMatch` | prediction | `syncPredictionFromAccount` | `normalizePlayerKey`, `normalizeLineup` | — / — | — |
| `savePredictionToAccount` | prediction | — | `ensurePredictionEditingAllowed`, `getCurrentGameId`, `buildCurrentPredictionApiUrl`, `getPredictionAccountUser`, `getPredictionAccountSaveErrorMessage`, `createPredictionPayload`, `updatePredictionSaveButton` | `prediction`, `predictionRemote` / `predictionRemote` | — |
| `deletePredictionFromAccount` | prediction | — | `ensurePredictionEditingAllowed`, `buildCurrentPredictionApiUrl`, `getPredictionAccountUser`, `createEmptyPredictionRemoteState`, `renderPredictionAccountStatus` | `predictionRemote` / `predictionRemote` | — |
| `renderPredictionAccountStatus` | auth/session | `syncPredictionFromAccount`, `deletePredictionFromAccount`, `renderAll` | `updatePredictionSaveButton`, `renderPublicGameSelectionMeta` | — / — | — |
| `updatePredictionSaveButton` | prediction | `savePredictionToAccount`, `renderPredictionAccountStatus` | `hasUsablePublicRosterForCurrentGame`, `isPredictionEditingLocked` | `predictionRemote` / — | `savePredictionButton` |
| `normalizePosition` | shared formatting / player display | `createPositionSelectionLineup`, `resolveAutoFillPosition`, `remotePredictionToLocal`, `createLineupItem`, `createResultCanvas`, `createResultPositionTileHtml`, `createPredictionSummary`, `createSavedPredictionCanvas`, `normalizeDisplayPosition` | `normalizePositionKey` | — / — | — |
| `normalizePositionKey` | shared formatting / player display | `normalizePosition`, `normalizeDisplayPosition` | — | — / — | — |
| `normalizePlayerName` | shared formatting / player display | `createLineupItem` | `normalizePlayerKey` | — / — | — |
| `normalizePlayerKey` | shared formatting / player display | `getPredictionCandidatePlayers`, `createRosterEntryKey`, `rosterEntryMatchesPlayer`, `getUniquePlayerData`, `predictionsMatch`, `normalizePlayerName`, `findActualLineupItem`, `createActualBasisDetails`, `getPlayerData` | — | — / — | — |
| `handlePredictionSubmit` | prediction | `bindEvents` | — | — / — | — |
| `resetPredictionInput` | prediction | `bindEvents` | — | — / — | — |
| `getLineupValues` | prediction | `updatePositionMenuState`, `selectPositionForSlot`, `assignPlayerToActiveSlot`, `assignPlayerToSlot`, `movePositionBetweenSlots`, `moveLineupSlot`, `clearSlot`, `renderPicker` | `createLineupItem`, `normalizePickerName` | — / — | — |
| `setLineupValues` | prediction | `selectPositionForSlot`, `assignPlayerToActiveSlot`, `assignPlayerToSlot`, `movePositionBetweenSlots`, `moveLineupSlot`, `clearSlot`, `renderSavedPrediction` | `normalizeLineup`, `normalizePickerName`, `renderPicker` | — / — | — |
| `createLineupItem` | prediction | `createPositionSelectionLineup`, `assignPlayerToActiveSlot`, `moveLineupItem`, `moveLineupSlot`, `moveLineupPosition`, `autoFillPredictionPosition`, `clearLineupItem`, `getLineupValues`, `normalizeLineup`, `scoreLineup` | `normalizePosition`, `normalizePlayerName` | — / — | — |
| `normalizeLineup` | prediction | `createPositionSelectionLineup`, `moveLineupItem`, `moveLineupSlot`, `moveLineupPosition`, `clearLineupItem`, `syncPredictionFromAccount`, `createPredictionPayload`, `remotePredictionToLocal`, `predictionsMatch`, `setLineupValues`, `hasCompletePositions`, `normalizeScoringLineup`, `loadState`, `isSavedPredictionComplete`, `createPredictionSummary`, `createSavedPredictionCanvas`, `createPredictionShareText` | `createLineupItem` | — / — | — |
| `normalizePickerName` | prediction | `clearSlot`, `getLineupValues`, `setLineupValues` | — | — / — | — |
| `validateLineup` | prediction | — | `hasDuplicatePlayers`, `hasDuplicatePositions` | — / — | — |
| `hasDuplicatePlayers` | prediction | `validateLineup` | — | — / — | — |
| `hasDuplicatePositions` | prediction | `validateLineup` | — | — / — | — |
| `hasCompletePositions` | prediction | `loadState` | `normalizeLineup` | — / — | — |
| `scoreLineup` | local score comparison (unchanged) | `loadResultHistoryGame`, `syncPredictionFromAccount`, `loadState` | `createLineupItem`, `normalizeScoringLineup`, `findActualLineupItem`, `getHitCounts`, `createScoreBreakdown` | — / — | — |
| `normalizeScoringLineup` | local score comparison (unchanged) | `scoreLineup` | `normalizeLineup`, `getLineupPlayerId` | — / — | — |
| `getLineupPlayerId` | local score comparison (unchanged) | `normalizeScoringLineup` | `createPlayerId`, `getUniquePlayerData` | — / — | — |
| `findActualLineupItem` | local score comparison (unchanged) | `scoreLineup` | `normalizePlayerKey` | — / — | — |
| `getHitCounts` | local score comparison (unchanged) | `scoreLineup`, `createResultViewModel` | — | — / — | — |
| `createScoreBreakdown` | local score comparison (unchanged) | `scoreLineup`, `createResultViewModel` | — | — / — | — |
| `loadState` | storage | — | `getCurrentGameId`, `normalizeLineup`, `hasCompletePositions`, `scoreLineup`, `normalizeGameInfo`, `saveToStorage`, `loadFromStorage`, `removeFromStorage` | `prediction`, `actual`, `result`, `gameInfo`, `candidateRosterFilter` / `prediction`, `actual`, `result`, `gameInfo`, `candidateRosterFilter` | — |
| `normalizeGameInfo` | storage | `loadState` | — | — / — | — |
| `isNormalManagedSchedule` | game selection | `selectProbableStarterGame`, `mergePublicGameSchedules`, `getPublicSelectableGames` | — | — / — | — |
| `getScheduleDate` | game selection | `getPublicSelectableGames`, `selectInitialPublicGame`, `formatPublicPredictionGameLabel`, `getPublicPredictionGameMetaLines`, `parseJstScheduleDateTime`, `getScheduleSortValue` | — | — / — | — |
| `getScheduleStartTime` | game selection | `formatPublicPredictionGameLabel`, `getPublicPredictionGameMetaLines`, `parseJstScheduleDateTime`, `getScheduleSortValue` | — | — / — | — |
| `getScheduleSortValue` | game selection | `selectProbableStarterGame`, `getFastPreviousResultGame`, `mergePublicGameSchedules`, `getPublicSelectableGames`, `selectInitialPublicGame` | `getScheduleDate`, `getScheduleStartTime` | — / — | — |
| `getJapanDateString` | game selection | `getPublicSelectableGames`, `selectInitialPublicGame` | — | — / — | — |
| `saveToStorage` | storage | `setCandidateRosterFilter`, `syncPredictionFromAccount`, `loadState` | — | — / — | — |
| `loadFromStorage` | storage | `getRosterSnapshotForCurrentGame`, `loadState` | — | — / — | — |
| `removeFromStorage` | storage | `discardStoredStateForGame`, `syncPredictionFromAccount`, `loadState`, `clearStoredPublicResult` | — | — / — | — |
| `clearStoredPublicResult` | results | `resolveResultHistorySelection`, `refreshResultHistory` | `removeFromStorage` | `result` / `result` | — |
| `renderAll` | bootstrap | `refreshPredictionTarget` | `renderAchievements`, `renderPredictionDeadline`, `renderResultHistory`, `renderPredictionAccountStatus`, `renderPublicGameSelectionMeta`, `renderPredictionTargetNotice`, `renderProbableStarter`, `renderPicker`, `renderSavedPrediction`, `renderPredictionCta`, `renderScoreResult`, `renderDailyBestNine` | — / — | — |
| `formatPublicJstDateTime` | shared formatting / player display | `renderPublicGameSelectionMeta` | — | — / — | — |
| `formatPublicRemainingTime` | shared formatting / player display | `renderPredictionDeadline` | — | — / — | — |
| `getPublicGameStatusView` | game selection | `renderResultHistory`, `renderPublicGameSelectionMeta` | `isPublicGamePublished`, `getPublicGameUnavailableKind` | `predictionRemote`, `prediction` / — | — |
| `renderPublicPredictionSurface` | prediction | `renderResultHistory`, `renderPublicGameSelectionMeta` | `isScheduleGameUnavailable`, `getEffectivePredictionDeadline`, `isSavedPredictionComplete` | `publicGameCatalog`, `prediction`, `predictionRemote` / — | `predictionEditor` |
| `renderPublicGameSelectionMeta` | game selection | `initializePublicGameCatalog`, `renderPredictionDeadline`, `syncPredictionFromAccount`, `renderPredictionAccountStatus`, `renderAll` | `getPublicPredictionGameMetaLines`, `getEffectivePredictionDeadline`, `getCurrentGameId`, `formatPublicJstDateTime`, `getPublicGameStatusView`, `renderPublicPredictionSurface`, `escapeHtml` | `predictionTargetGame`, `publicGameCatalog`, `predictionRemote`, `prediction` / — | `publicGameSelectionMeta` |
| `renderPredictionTargetNotice` | game selection | `renderAll` | — | `predictionTargetNotice` / — | `predictionTargetNotice` |
| `renderProbableStarter` | probable starter | `initializeProbableStarter`, `refreshProbableStarterTarget`, `fetchStoredProbableStarter`, `renderAll` | `renderProbableStarterDisplay` | — / — | — |
| `deriveProbableStarterViewState` | probable starter | `renderProbableStarterDisplay` | — | — / — | — |
| `renderProbableStarterDisplay` | probable starter | `renderProbableStarter` | `getFightersStarter`, `deriveProbableStarterViewState`, `renderProbableStarterNotice`, `createProbableStarterHeadingHtml`, `createProbableStarterTeamHtml`, `formatProbableStarterDate`, `formatDateTime`, `escapeHtml` | `probableStarter` / — | `probableStarterDisplay` |
| `renderProbableStarterNotice` | probable starter | `renderProbableStarterDisplay` | `formatScheduledGameForLog`, `createProbableStarterHeadingHtml`, `formatDateTime`, `escapeHtml` | `probableStarter` / — | — |
| `createProbableStarterHeadingHtml` | probable starter | `renderProbableStarterDisplay`, `renderProbableStarterNotice` | — | — / — | — |
| `createProbableStarterTeamHtml` | probable starter | `renderProbableStarterDisplay` | `escapeHtml` | — / — | — |
| `formatProbableStarterDate` | probable starter | `renderProbableStarterDisplay` | — | — / — | — |
| `getGameDayNoticeTarget` | notices / status | `refreshGameDayNoticeStatus` | — | `predictionTargetGame`, `probableStarter` / — | — |
| `buildGameDayNoticeApiUrl` | notices / status | `refreshGameDayNoticeStatus` | `getAuthApiBaseUrl` | — / — | — |
| `renderGameDayNoticeStatus` | notices / status | `refreshPredictionDeadlineState`, `refreshGameDayNoticeStatus` | — | `gameDayNotice` / — | `gameDayNoticeStatus` |
| `refreshGameDayNoticeStatus` | notices / status | `refreshPredictionTarget` | `getGameDayNoticeTarget`, `buildGameDayNoticeApiUrl`, `renderGameDayNoticeStatus`, `renderScoreResult` | `gameDayNotice` / `gameDayNotice` | — |
| `fetchGameDayRosterSnapshot` | roster integration | — | `getGameDayRosterTargetInternalGameId`, `getAuthApiBaseUrl` | — / — | — |
| `renderPicker` | prediction | `setCandidateRosterFilter`, `setActiveOrder`, `assignPlayerToActiveSlot`, `assignPlayerToSlot`, `movePositionBetweenSlots`, `clearSlot`, `startPredictionDeadlineTicker`, `refreshPredictionDeadlineState`, `syncPredictionFromAccount`, `setLineupValues`, `renderAll` | `shouldUseNativeDrag`, `isPredictionEditingLocked`, `getLineupValues`, `renderPredictionRosterFilter`, `renderPositionButton`, `getDuplicatedPlayers`, `getDuplicatedPositions`, `createPlayerLabelHtml`, `applyPlayerCategoryClass` | `activeOrder` / — | `.slot-player`, `.position-button`, `.slot-clear`, `.slot-drag-handle`, `.position-menu-option`, `[data-roster-filter]` |
| `renderPredictionRosterFilter` | roster integration | `renderPicker` | — | — / — | — |
| `renderPositionButton` | position menu | `renderPicker` | `getPositionCategory` | — / — | — |
| `markDuplicateSlots` | prediction | — | `getDuplicatedPlayers`, `getDuplicatedPositions` | — / — | — |
| `getDuplicatedPlayers` | prediction | `renderPicker`, `markDuplicateSlots` | — | — / — | — |
| `getDuplicatedPositions` | prediction | `renderPicker`, `markDuplicateSlots` | — | — / — | — |
| `isSavedPredictionComplete` | prediction | `renderPublicPredictionSurface`, `renderSavedPrediction` | `normalizeLineup` | — / — | — |
| `renderSavedPrediction` | prediction | `syncPredictionFromAccount`, `renderAll` | `isPredictionEditingLocked`, `setLineupValues`, `isSavedPredictionComplete`, `createSavedPredictionPreview` | `prediction` / — | `savedPrediction`, `editSavedPredictionButton`, `sharePredictionButton`, `saveSavedPredictionImageButton` |
| `renderPredictionCta` | prediction | `syncPredictionFromAccount`, `renderAll` | `isPredictionEditingLocked`, `getPredictionAccountUser` | `prediction`, `predictionRemote`, `predictionTargetGame` / — | `predictionCtaButton` |
| `handlePredictionCtaClick` | prediction | `bindEvents` | `scrollToPredictionForm` | — / — | — |
| `scrollToPredictionForm` | prediction | `bindEvents`, `handlePredictionCtaClick` | — | — / — | `predictionForm`, `button, input, select` |
| `renderScoreResult` | results | `fetchPreviousResultGame`, `resolveResultHistorySelection`, `refreshResultHistory`, `loadResultHistoryGame`, `syncPredictionFromAccount`, `renderAll`, `refreshGameDayNoticeStatus` | — | — / — | — |
| `renderDailyBestNine` | Daily Best Nine | `fetchDailyBestNine`, `renderAll` | — | — / — | — |
| `renderScoreInsights` | results | — | — | — / — | `scoreInsightsGrid`, `scoreInsightsNotice`, `[data-score-insight]`, `[data-score-insight-value]` |
| `createActualBasisDetails` | results | `createResultViewModel` | `normalizePlayerKey` | — / — | — |
| `mergeRawPredictionSlots` | results | `createResultViewModel` | — | — / — | — |
| `createResultViewModel` | results | — | `getHitCounts`, `createScoreBreakdown`, `createActualBasisDetails`, `mergeRawPredictionSlots` | — / — | — |
| `createResultView` | results | — | `createResultFallbackView`, `createResultCanvas`, `createResultTable` | — / — | — |
| `createResultFallbackView` | results | `createResultView` | `createBreakdownItem`, `createResultTable`, `escapeHtml` | — / — | — |
| `createResultCanvas` | results | `createResultView` | `normalizePosition`, `getPositionCategory` | — / — | — |
| `createBreakdownItem` | results | `createResultFallbackView` | — | — / — | — |
| `createResultTable` | results | `createResultView`, `createResultFallbackView` | `createResultPlayerCardHtml`, `createHitBadge` | — / — | `tbody` |
| `createResultPlayerCardHtml` | results | `createResultTable` | `createResultPositionTileHtml`, `createPlayerNameHtml` | — / — | — |
| `createHitBadge` | results | `createResultTable` | `escapeHtml` | — / — | — |
| `createResultPositionTileHtml` | results | `createResultPlayerCardHtml` | `normalizePosition`, `escapeHtml`, `getPositionCategory` | — / — | — |
| `createPredictionSummary` | prediction | — | `normalizePosition`, `normalizeLineup`, `formatDateTime`, `escapeHtml`, `getPositionCategory`, `createPlayerDetailTriggerHtml`, `createPlayerNameHtml`, `showPlayerDetails` | — / — | — |
| `formatDateTime` | shared formatting / player display | `createAchievementCardHtml`, `renderProbableStarterDisplay`, `renderProbableStarterNotice`, `createPredictionSummary`, `createSavedPredictionPreview` | — | — / — | — |
| `createSavedPredictionPreview` | prediction | `renderSavedPrediction` | `formatDateTime`, `createSavedPredictionCanvas` | — / — | — |
| `createSavedPredictionCanvas` | prediction | `createSavedPredictionPreview`, `saveSavedPredictionImage` | `normalizePosition`, `normalizeLineup`, `getPositionCategory` | — / — | — |
| `getSavedPredictionImageFilename` | prediction | `saveSavedPredictionImage` | — | — / — | — |
| `createPngBlob` | prediction | `saveSavedPredictionImage` | — | — / — | — |
| `downloadPredictionImage` | prediction | `saveSavedPredictionImage` | `showMessage` | — / — | — |
| `saveSavedPredictionImage` | prediction | `bindEvents` | `createSavedPredictionCanvas`, `getSavedPredictionImageFilename`, `createPngBlob`, `downloadPredictionImage`, `showMessage` | `prediction` / — | `#savedPrediction canvas.saved-lineup-canvas` |
| `sharePrediction` | prediction | `bindEvents` | `createPredictionShareText`, `openXShare`, `showMessage` | `prediction` / — | — |
| `createPredictionShareText` | prediction | `sharePrediction` | `normalizeLineup`, `getPredictionShareUrl` | `predictionTargetGame`, `gameInfo` / — | — |
| `getPredictionShareUrl` | prediction | `createPredictionShareText` | — | — / — | — |
| `openXShare` | prediction | `sharePrediction` | — | — / — | — |
| `showMessage` | notices / status | `ensurePredictionEditingAllowed`, `downloadPredictionImage`, `saveSavedPredictionImage`, `sharePrediction` | — | — / — | — |
| `showPredictionSaveMessage` | notices / status | — | — | — / — | `predictionSaveMessage` |
| `clearMessage` | notices / status | `createPositionControl`, `setActiveOrder`, `assignPlayerToSlot`, `movePositionBetweenSlots`, `moveLineupSlot` | — | — / — | — |
| `escapeHtml` | shared formatting / player display | `createAchievementCardHtml`, `renderPredictionDeadline`, `renderResultHistory`, `renderPublicGameSelectionMeta`, `renderProbableStarterDisplay`, `renderProbableStarterNotice`, `createProbableStarterTeamHtml`, `createResultFallbackView`, `createHitBadge`, `createResultPositionTileHtml`, `createPredictionSummary`, `createPlayerCategoryBadgeHtml`, `createPlayerPositionBadgesHtml`, `createPlayerDetailTriggerHtml`, `createPlayerNameHtml`, `showPlayerDetails` | — | — / — | — |
| `getPlayerData` | shared formatting / player display | `autoFillPredictionPosition`, `createPlayerCategoryBadgeHtml`, `createPlayerPositionBadgesHtml`, `createPlayerDetailTriggerHtml`, `createPlayerNameHtml`, `getPlayerCategoryClass`, `showPlayerDetails` | `normalizeRosterEntries`, `normalizePlayerKey` | `publicRoster` / — | — |
| `createPlayerCategoryBadgeHtml` | shared formatting / player display | `createPlayerPositionBadgesHtml` | `escapeHtml`, `getPlayerData` | — / — | — |
| `createPlayerPositionBadgesHtml` | shared formatting / player display | `showPlayerDetails` | `escapeHtml`, `getPlayerData`, `createPlayerCategoryBadgeHtml`, `normalizeDisplayPosition`, `getPositionCategory` | — / — | — |
| `normalizeDisplayPosition` | shared formatting / player display | `resolveAutoFillPosition`, `createPlayerPositionBadgesHtml` | `normalizePosition`, `normalizePositionKey` | — / — | — |
| `getPositionCategory` | shared formatting / player display | `renderPositionButton`, `createResultCanvas`, `createResultPositionTileHtml`, `createPredictionSummary`, `createSavedPredictionCanvas`, `createPlayerPositionBadgesHtml` | — | — / — | — |
| `createPlayerLabelHtml` | shared formatting / player display | `createPlayerChip`, `renderPicker` | `createPlayerNameHtml` | — / — | — |
| `createPlayerDetailTriggerHtml` | shared formatting / player display | `createPredictionSummary` | `escapeHtml`, `getPlayerData` | — / — | — |
| `createPlayerNameHtml` | shared formatting / player display | `createResultPlayerCardHtml`, `createPredictionSummary`, `createPlayerLabelHtml` | `escapeHtml`, `getPlayerData` | — / — | — |
| `getPlayerCategoryClass` | shared formatting / player display | `getPlayerCategoryClassNames` | `getPlayerData` | — / — | — |
| `getPlayerCategoryClassNames` | shared formatting / player display | `applyPlayerCategoryClass` | `getPlayerCategoryClass` | — / — | — |
| `applyPlayerCategoryClass` | shared formatting / player display | `createPlayerChip`, `renderPicker` | `getPlayerCategoryClassNames` | — / — | — |
| `showSlotPlayerDetails` | shared formatting / player display | `createLineupSlot` | `showPlayerDetails` | — / — | — |
| `showPlayerDetails` | shared formatting / player display | `createPlayerChip`, `createPredictionSummary`, `showSlotPlayerDetails` | `assignPlayerToActiveSlot`, `escapeHtml`, `getPlayerData`, `createPlayerPositionBadgesHtml`, `closePlayerDetails`, `getNpbasePlayerUrl` | — / — | `.player-detail-close`, `.player-detail-select` |
| `handlePlayerDetailsOverlayClick` | shared formatting / player display | `showPlayerDetails` | `closePlayerDetails` | — / — | — |
| `closePlayerDetails` | shared formatting / player display | `bindEvents`, `showPlayerDetails`, `handlePlayerDetailsOverlayClick` | — | — / — | `.player-detail-overlay` |
| `getNpbasePlayerUrl` | shared formatting / player display | `showPlayerDetails` | — | — / — | — |

## Residual re-audit (Phase 22)

### Scope and decision

This re-audit uses `69d3675dfa7eb8a373018c539f1429ce70ee92ac` as the clean feature-branch baseline. It is an audit-only outcome: no product code, API contract, production data, or deployment configuration is changed.

**Decision: defer extracting Public Game Flow.** The catalog selection helpers form a recognizable subdomain, but the actual selected-game transition is an orchestration transaction spanning prediction state, result preservation, game-scoped persistence, roster refresh, deadline/status rendering, and the shared public coordinator. Moving the apparent cluster as-is would relocate coupling rather than reduce it.

### Current inventory

At this baseline, `script.js` contains 3,990 lines and 230 named function declarations. Reclassifying the existing declarations against the Phase 19 domain inventory gives 24 candidate Game Flow functions within the 33-function game-selection group; the other nine are shared schedule, eligibility, and status helpers and should not be moved merely to make the count look smaller. The result is a candidate boundary, not 24 independent functions.

The candidate set is `refreshPredictionTarget`, `resolvePredictionTargetGame`, `getLoadedGameSchedule`, `buildPublicGamesApiUrl`, `getFastPreviousResultGame`, `mergePublicGameSchedules`, `getPublicSelectableGames`, `selectInitialPublicGame`, `getPreferredPublicGameSelection`, `persistCurrentGameScopedState`, `hydrateGameScopedState`, `handlePublicGameSelectionMetaClick`, `formatPublicPredictionGameLabel`, `getPublicPredictionGameMetaLines`, `setPublicCurrentGame`, `initializePublicGameCatalog`, `isPublicGamePublished`, `startPredictionDeadlineTicker`, `getPublicGameStatusView`, `renderPublicPredictionSurface`, `renderPublicGameSelectionMeta`, `renderPredictionTargetNotice`, `getGameDayNoticeTarget`, and `refreshGameDayNoticeStatus`. Listing these names records the audit boundary; it is not an instruction to move them together.

The current state authority remains distributed by purpose:

- `state.publicGameCatalog.games` is the canonical public game list.
- `state.predictionTargetGameId` and `state.predictionTargetGame` represent the selected prediction target and its current projection.
- `appState.currentGame` and `appState.predictionForm.gameId` mirror that target for existing application integrations.
- Result selection/cache and the Daily Best Nine widget remain separate. Daily Best Nine continues to represent the latest published game, regardless of the selected personal result.

Creating another controller-owned selected-game copy would introduce a competing authority. No new global cache or event bus is justified.

### Why extraction is not safe yet

`setPublicCurrentGame` is the key boundary crossing. It persists/hydrates game-scoped state, invalidates in-flight account work, resets selected-game prediction/result data, asks the results controller to preserve its displayed result, updates the prediction target and `appState` projections, and synchronizes stored state. `initializePublicGameCatalog` composes request freshness, the cached public API client, target selection, that transition, deadline refresh, application synchronization, and rendering.

The surrounding callers are not a one-way catalog-to-view chain:

- `refreshPredictionTarget` and the deadline ticker re-evaluate selection while also refreshing prediction/deadline state and invoking roster/probable-starter-related updates.
- `renderPublicGameStatusView`, `renderPublicPredictionSurface`, and `renderPublicGameSelectionMeta` combine game metadata with prediction/account/deadline semantics and update prediction-facing DOM.
- Previous-result preservation belongs to result history, while game-day notices read both the selected game and probable-starter state.
- The coordinator owns lifecycle/event setup, while `script.js` supplies the existing operations and domain callbacks.

Extracting the whole candidate cluster would therefore require a broad callback/dependency surface and leave either a wrapper forest or a cycle between selection, deadline/prediction rendering, roster, results, and coordinator lifecycle. Extracting only pure catalog helpers would be technically possible but would not achieve the requested reduction in result/game-flow state and ownership coupling. The current `script.js` orchestration boundary is safer until the selected-game transition can be given one explicit owner without duplicating prediction or result state.

The Daily Best Nine boundary from Phase 21 is preserved: it fetches/renders its own latest-published-game widget, does not adopt the personal result selection, and its API contract and Auth Worker remain untouched.

### Validation evidence

- `tests/public-runtime-game-flow.test.js`: 12 passed on each of three consecutive runs.
- Cross-domain focused regression command covering public runtime game flow/behavior, game hub and notices, next-game behavior, probable starter, coordinator, Asia integration, and Asia sequential prediction: 115 passed, 0 failed.
- Results, Best Nine, prediction-save, result-history, roster, position-menu, drag, and Asia regression group: 134 passed, 0 failed.
- Full `npm test`: 1,665 passed, 0 failed (17.56 s).
- `npm run check`: passed; its test phase also reported 1,665 passed, 0 failed, and syntax validation checked 343 JavaScript files.
- `git diff --check`: passed.
- No before/after runtime comparison is claimed because no product implementation changed.

The behavior fixtures exercise canonical public-game selection, chronological and deadline-based selection, empty/error catalogs, stale request handling, actual-start probable-starter transitions, personal result detail/cache isolation, latest-game Best Nine independence, roster response races, prediction save failures, and pointer/touch interactions. Existing tests continue to be the behavioral evidence; no new test hook or private-function extraction is introduced by this audit.

### Remaining recommendation

Do not start another Game Flow extraction from this shape. If this area is revisited, first define a single owner for the selected-game transition and an explicit one-way contract with prediction, results, roster, and coordinator lifecycle. Keep the current user-visible behavior and the independent latest-published Best Nine semantics as regression contracts. Phase 22 itself is documentation-only and has no deployment implication.

## Prediction leaf extraction (Phase 23)

### Baseline and decomposition

Baseline: `31525b97c4915a481393efadb18a6377952bb7da`, clean `main` fetched before the feature branch. The existing Phase 19 table's 59-function Prediction count was a historical inventory; this phase reclassified current declarations and did not treat that old count as a current metric.

Prediction responsibilities still in the application are grouped as follows:

| Responsibility | Current functions / state | Boundary assessment |
| --- | --- | --- |
| State and slot normalization | App-owned `state.prediction`, `state.predictionRemote`, `state.activeOrder`, `state.result`; `getLineupValues`, `setLineupValues`, `createLineupItem`, `normalizeLineup`, `normalizePickerName`, `isSavedPredictionComplete` | Keep state in app; the shared lineup normalizer also serves results, rendering, and slot interactions. |
| Validation and duplicate projection | `validateLineup`, `hasDuplicatePlayers`, `hasDuplicatePositions`, `hasCompletePositions`, `getDuplicatedPlayers`, `getDuplicatedPositions` | Selected: deterministic lineup-local rules with no state/DOM/API/storage ownership. The two duplicate projections previously repeated the same counting rules used by save validation. |
| Serialization and identity mapping | `createPredictionPayload`, `remotePredictionToLocal`, `predictionsMatch`, with `createPlayerId` / `getUniquePlayerData` support | Defer as a group: request serialization resolves against canonical roster/player identity, team ID prefixes, temporary-player constraints and shared normalizers. Moving the whole group would pull roster identity into the leaf; splitting out isolated conversions would be too small and would not own the payload contract. |
| Persistence and API coordination | `initializePredictionRemoteSync`, `buildCurrentPredictionApiUrl`, `getPredictionAccountUser`, `getPredictionAccountStatus`, `waitForPredictionAuthInitialization`, `getPredictionAccountSaveErrorMessage`, `syncPredictionFromAccount`, `createEmptyPredictionRemoteState`, `savePredictionToAccount`, `deletePredictionFromAccount` | Defer: 10 functions, approximately 311 LOC, account/auth state, request guards, API calls and local/remote conflict handling. Not a leaf. |
| Rendering | `renderPicker`, `renderPredictionRosterFilter`, `renderPredictionAccountStatus`, `updatePredictionSaveButton`, `renderSavedPrediction`, `renderPredictionCta`, `createPredictionSummary`, `createSavedPredictionPreview`, `createSavedPredictionCanvas`, `saveSavedPredictionImage` and related image helpers | Defer: DOM/canvas, app state, roster/player display and position controls are interleaved. The current slice is roughly 397 LOC across the listed core rendering/support declarations, before adjacent shared helpers. |
| User interaction | `handlePredictionSubmit` / `resetPredictionInput` application adapters, slot assignment/clear, CTA, share, and save-image actions | Form submit/reset lifecycle is already in `prediction-form.js`; keep remaining interaction orchestration in the app. |
| Position, drag and orchestration | Position-menu and pointer/touch/drag handlers; game switch, roster/deadline/status and result handoffs | Explicitly not extracted. Position/drag remain their own interaction concern; Game Flow remains the Phase 22 orchestration boundary. |

Candidate comparison:

| Candidate | Functions / approximate LOC | State / DOM / API / storage | Cross-domain dependency and risk |
| --- | --- | --- | --- |
| Validation + serialization | 9 declarations / about 115 LOC before extraction (six validation/duplicate functions, 51 LOC; three serialization functions, about 64 LOC) | Validation: no state, DOM, API, or storage. Serialization: no direct state/DOM/API/storage writes; it indirectly resolves the current roster/player identity. | Validation is low-risk. Whole serialization is not: roster identity and temporary-player policy are semantic dependencies. Extract only the validation leaf. |
| Persistence / API | 10 declarations / about 311 LOC | Reads/writes prediction and prediction-remote state; API and auth/request lifecycle; local storage is mediated by existing app storage. | Multiple cross-domain callbacks and error/commit sequencing make it a controller, not a leaf. |
| Rendering | Core group about 16 declarations / 397 LOC | Reads prediction/account/roster state; many DOM selectors and canvas; no direct API requirement for the selected core. | Calls shared player/position functions and changes prediction-facing DOM. A module would need broad callbacks or absorb position/render orchestration. |

The selected six-function set is `validateLineup`, `hasDuplicatePlayers`, `hasDuplicatePositions`, `hasCompletePositions`, `getDuplicatedPlayers`, and `getDuplicatedPositions`. It was 51 LOC across the validation and picker-rendering regions. The new `frontend/public/prediction-validation.js` is also 51 LOC and has six declarations including its factory and private counting helper. Its only injected dependency is the existing `normalizeLineup` function. It has no state, DOM, network, storage, Game Flow, Position or Drag dependency; it creates no listeners, timers or cache. Its four-method public surface is `validateLineup`, `hasCompletePositions`, `getDuplicatedPlayers`, and `getDuplicatedPositions`. It owns no state. No forwarding wrappers remain in `script.js`.

Duplicate marking and save validation now use one shared duplicate-set calculation. Existing rules are unchanged: every slot requires player and position; player names are unique; duplicate non-DH positions are rejected; repeated `指` remains allowed; registered roster position is not consulted. Server-owned competition status, eligibility, deadline, current target and sequential target rules are not copied into this module.

### Wiring, behavior and change surface

`index.html` loads the leaf before `prediction-form.js` and `script.js`; both shipped HTML and the runtime module loader preserve that order. The app passes its existing normalizer to the factory, the form controller receives the leaf's validator directly, and app render/load paths call the leaf's duplicate/complete-position methods. There is no app-owned duplicate validation implementation left and no second lineup/prediction state.

The pre-change runtime focused group passed 64 cases. After extraction, the same runtime/interaction group passed 65 cases; the added assertions cover duplicate defensive positions being rejected before local save/API PUT and repeated DH being accepted. Existing tests also keep empty slots, missing positions, duplicate players, success payload shape, 401/503 behavior, position selection, click-vs-drag autofill, pointer/touch/cancel/handoff and roster reflection observable. The form tests exercise the public runtime and do not extract private validator source. The former source-string assertion for `validateLineup` was removed.

Four memory-only fault probes were run and then removed from the repository: removing duplicate-player validation, required-position validation, or duplicate-position validation each allowed an invalid submit to become observable; removing the repeated-DH exception rejected a currently valid submit. All four probes detected the injected fault. No mutation fixture remains in the test tree.

Before: `script.js` 3,990 lines / 230 top-level functions; local validation and duplicate projections occupied 51 lines in `script.js`. After: `script.js` 3,939 lines / 224 top-level functions; the leaf contains 51 lines / six declarations; no validation wrapper declarations remain. The module's four public methods replace six local declarations, and duplicate counting no longer has separate save/UI implementations. Validation-rule changes now have one implementation file (`frontend/public/prediction-validation.js`); wiring remains in `script.js`, and the behavior contract remains in runtime tests.

Verification at implementation checkpoint:

- Prediction/position/drag focused runtime group: 65 passed on the final of three consecutive runs; all three runs passed.
- Broader regression group (modules, prediction save/auth/game ID/deadline, position, drag, game flow, results, Best Nine, roster, probable starter, coordinator, Asia sequential/integration, admin auth initialization): 207 passed, 0 failed.
- Four temporary fault-injection probes passed; the temporary probe file was deleted after the run.
- `node --check` passed for changed JavaScript/CJS files; `git diff --check` passed.

No API/Worker, scoring, deadline policy, public behavior, production data or deployment setting changed. This phase extracts exactly one leaf; it does not begin a second Prediction module, Game Flow, Position or Drag extraction.

## Prediction persistence API leaf (Phase 25)

### Re-audit and decision

The latest `origin/main` baseline for this phase is `30f4121e772645aeabad048a0fbfaa168aeadd4f`. The prior Phase 23 inventory correctly found that the whole persistence workflow is not a leaf: authentication readiness, selected-game identity, abort/request sequence, closed-deadline authority, local-vs-account conflict resolution, storage adoption, score result hydration and UI rendering remain coordinated by `script.js`. Moving that 10-function / roughly 311-LOC cluster would duplicate app state or introduce a callback-heavy controller. Phase 25 therefore extracts only the common API exchange boundary; it does not claim that the full persistence workflow moved.

The selected leaf is `frontend/public/prediction-persistence.js`, with exactly three operations: `load`, `save`, and `remove`. It depends on the existing `apiClient` only. It owns no prediction, game, eligibility, deadline, auth, cache, storage, DOM, timer or request-sequence state. It returns the parsed successful response payload; rejected HTTP/API responses preserve the existing errors, including the save error's `code` and `status`. The application retains URL selection, auth checks, 401 session expiry handling, save-message mapping, request abort/stale guards, response-to-state conversion, and every state/UI commit.

### Contract and wiring

- GET remains `GET /api/predictions/current?internalGameId=<canonical id>`, with `credentials: include`, API-client `cache: no-store`, and the existing abort signal. The payload remains server-authoritative; the caller decides whether a saved prediction exists and performs current-game/stale-response checks before committing it.
- PUT remains `PUT /api/predictions/current?internalGameId=<canonical id>`, with `credentials: include`, `Content-Type: application/json`, and `{ internalGameId, prediction }`. The module sends the already-normalized serialized prediction without understanding lineup slots or validation rules.
- DELETE remains `DELETE` on the same canonical endpoint with `credentials: include` and no body.
- The factory's single dependency is the existing API client. There are no server, API, validation, Game Flow or UI changes. `index.html` loads the module after `prediction-validation.js` and before `prediction-form.js` / `script.js`; the runtime loader matches that order.

The frontend still owns the only `prediction` and `predictionRemote` objects. The module has no state reads/writes and no DOM selectors. Save/API transport is no longer embedded in the state/UI orchestration functions; the endpoint URL remains assembled by the existing app helper because it uses the app's established Auth API base URL. No API abstraction or new global cache was added.

### Before / after measurements

Measurements use the same simple textual counting method on the phase baseline and resulting files (logical lines as returned by `Get-Content`, top-level named function declarations, and direct prediction API-client call expressions):

| Metric | Before | After |
| --- | ---: | ---: |
| `script.js` lines | 3,939 | 3,923 |
| `script.js` top-level functions | 224 | 224 |
| Raw account-prediction API call sites in `script.js` | 3 | 0 |
| API call sites in persistence leaf | 0 | 3 |
| Persistence leaf | absent | 42 lines / factory + 3 operations |
| Leaf dependencies | — | 1 (`apiClient`) |
| Leaf app-state reads/writes | — | 0 / 0 |
| Leaf DOM selectors | — | 0 |

This is an intentional transport-boundary extraction, not a claim of reducing the total app's function count. Changing the Prediction auth/state commit rules still belongs in `script.js` and the relevant existing state/runtime tests; changing the request method/body/credentials or payload success/error handling is now localized to the persistence leaf and its public-behavior tests.

### Behavior coverage and constraints

The pre-change focused runtime/auth group passed 47 cases. After the extraction, the expanded focused group passed 56 cases. Coverage includes anonymous load without fetch, no/saved prediction payloads, successful load adoption, stale old-game response rejection, PUT payload and credentials, save 401/403/409/500/network failures, DELETE success/failure, local draft retention, closed-deadline server authority, duplicate-player/position validation, repeated DH, and the existing position/drag/roster/game-flow/results/Best-Nine/probable-starter/Asia contracts. Daily Best Nine remains independent of personal result selection; no server-owned competition or prediction eligibility rule was copied into the frontend.

Four temporary in-memory fault probes all failed their behavior assertion as intended: wrong save endpoint, treating a 409 as success, removing the old-game response guard, and omitting the serialized prediction field. The mutated sources were never written to the worktree.

No Auth Worker, Asia Worker, NPB Worker, API contract, scoring, ranking, publication, D1, migration, Cron or production prediction data was changed. Production prediction POST/DELETE and other production mutations remain prohibited for this phase.

## Prediction rendering boundary (Phase 26)

### Inventory and decision

Baseline: `e5c03a0a9a4e058d1e4afa001e0f0ce42ded9dbb` (`origin/main` at audit start). The worktree was clean and the audit was performed on `refactor/public-prediction-renderer-boundary`.

Current `script.js` is 3,924 logical lines and has 224 top-level named function declarations. Thirteen rendering-focused declarations occupy approximately 372 LOC: `renderPredictionDeadline`, `updatePredictionSaveButton`, `renderPublicPredictionSurface`, `renderPublicGameSelectionMeta`, `renderPredictionTargetNotice`, `renderPicker`, `renderPositionButton`, `markDuplicateSlots`, `renderSavedPrediction`, `renderPredictionCta`, `createPredictionSummary`, `createSavedPredictionPreview`, and `createSavedPredictionCanvas`. `renderAll` and `renderPredictionAccountStatus` are orchestration entrypoints; `getPublicGameStatusView` is view-model/business-state derivation; `renderPredictionRosterFilter` delegates to the existing roster module. They are not counted as renderer implementations.

The renderer candidates have no direct app-state assignments, but they are not one independent leaf:

- `renderPicker` reads active-order state and edit-lock state, calls the validation module, and directly sets `draggable`, drag-handle, and position-menu disabled state. It calls Position and Drag helpers and refreshes the roster filter. Extracting it as a renderer would either move forbidden interaction/roster responsibility or require a broad callback/context surface.
- `renderSavedPrediction` calls `setLineupValues`, which mutates lineup-slot DOM data and invokes `renderPicker`; it also calls the edit-lock policy and creates the preview. This is a cross-boundary orchestration path, not state-to-DOM reflection alone.
- `createPredictionSummary` registers a player-detail click listener during rendering. Moving it would make the renderer own an event listener, contrary to the zero-listener goal, while separating the listener would require changing the existing interaction wiring.
- `createSavedPredictionCanvas` is about 106 LOC and depends on canvas APIs, viewport sizing, shared player/position formatters, and the existing image-render behavior. Extracting it alone would move an implementation detail without separating the surrounding saved-result view contract.
- `renderPredictionDeadline`, `renderPublicGameSelectionMeta`, and `renderPredictionCta` derive display state from deadline, selected-game, auth, saved-prediction and server-provided eligibility state. Copying those derivations into a leaf risks reimplementing Game Flow/server authority; passing every result through a new renderer API would add indirection without consolidating the rendering cluster.

Direct renderer-to-domain dependencies therefore remain: Position (position categories/menu state), Drag (native draggable state), Validation (duplicate sets), Game Flow (deadline, selected game, edit lock), Roster (candidate filter), and app-owned persisted prediction state. No persistence endpoint is used by renderer code. Rendering uses existing DOM selectors and includes one event-listener registration in `createPredictionSummary`. Candidate state is read-only at the app-object level; DOM slot `dataset` changes remain part of the current picker orchestration.

Decision: **DEFER extraction**. Moving only simple text/class setters would create a small module while leaving the meaningful renderer, state derivation, and interaction coupling in `script.js`; moving the meaningful group would violate the no-Position/no-Drag/no-listener boundary or require a callback-heavy façade. No product file, HTML load order, cache-buster, UI behavior, or production contract was changed in Phase 26.

### Current rendering contract to preserve for a future reassessment

- Empty, partially selected, and full lineups render their current player/position text, duplicate classes, active slot, and disabled state without changing app state.
- Save availability and text reflect the existing lock, roster, saving/submitting state; deadline and Asia eligibility remain caller/server-authoritative.
- Explicitly selected positions remain displayed as-is; rendering does not infer registered positions or perform autofill. Click-vs-drag behavior stays with the existing interaction handlers.
- Saved prediction preview, player-detail interaction, and canvas/image output remain on the current path. The Daily Best Nine widget remains independent from selected personal-result state.
- Position menu, pointer/touch/drag, roster candidate generation, Results, Best Nine, and probable-starter modules remain outside this boundary.

### Suggested prerequisite before another extraction attempt

First separate view-model derivation from DOM painting within the existing `script.js` ownership, and move player-detail listener registration to the existing interaction owner without changing the rendered DOM. Then add runtime fixtures that compare DOM attributes/text and relevant state for empty/partial/full lineups, missing/explicit positions, duplicate validation, saving/locked states, and saved prediction. Reassess whether `renderPicker` can then accept a small immutable view model without callbacks into Position, Drag, Roster, or Game Flow. Do not create a renderer module solely to satisfy a module-count target.

## Prediction rendering interaction ownership (Phase 27)

### Selected blocker and implementation

Candidate A was selected: the saved-prediction summary's player-detail click listener was registered on its `<ul>` during `createPredictionSummary`. That function is called from the Results renderer, so repeated replacement of the summary repeatedly created short-lived listeners and made rendering own an interaction. Candidates B and C were not changed.

The player-detail action now uses the existing document click interaction owner in `bindEvents`, alongside the existing outside-click close for position menus. It resolves the nearest `[data-player-detail-only]` from the event target, preserves the same `showPlayerDetails("prediction", playerName, { allowSelect: false })` call, and then performs the pre-existing position-menu close. The rendered summary markup, data attribute, click region, player identity, detail destination and non-selectable behavior are unchanged. No module, event bus, API, or app state was added.

### Runtime evidence and metrics

The public runtime harness now loads the player-detail/display assets used by the page and exposes listener counts for assertions. A runtime result fixture renders an unavailable game's saved prediction, verifies the existing detail-trigger markup, re-renders the result 100 times, and dispatches a nested-child click. It confirms zero click listeners on the generated summary list, one document click listener after all renders, the correct player detail opening with selection disabled, and identical summary markup across re-renders. Because the interaction listener no longer belongs to summary nodes, replacing those nodes cannot strand the action on stale nodes.

At this phase baseline, `script.js` was 3,924 lines with 209 top-level function declarations; afterward it is 3,923 lines with 209 declarations. The rendering-focused group remains the 13 Phase 26 candidates. Its render-owned listener sites changed from one (`createPredictionSummary`) to zero; the existing document-level click registration remains one and is now also the owner of player-detail interaction. The selected renderer has no direct app-state writes. This change does not remove DOM construction or the other Position, Drag, Roster, Validation, Game Flow, and app-owned prediction state dependencies. The renderer is not extracted in this phase.

The result-detail runtime test and `player-details.test.js` cover the delegated path. Candidate A is the only blocker addressed; renderer extraction remains deferred because the cross-domain dependencies and `renderSavedPrediction` DOM lifecycle described in Phase 26 remain.
