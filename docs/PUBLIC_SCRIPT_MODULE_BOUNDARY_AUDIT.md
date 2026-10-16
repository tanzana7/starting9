# Public script module boundary audit (Phase 19)

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

Results have multiple caches, auth-sensitive personal history and canvas/detail dependencies. Prediction/game selection jointly manage persistence, deadlines and editing. Position/drag have geometry, portals, pointer capture and touch state. Roster already has its own controller and substantial candidate/shared-player dependencies. Daily Best Nine has fewer functions, but its rendering already resides in the results module and its latest-published independence should not be split further just to reduce LOC. These domains remain untouched.

## Extraction and ownership

Existing pattern: classic deferred script -> `window.Starting9Public` factory -> explicitly supplied dependencies -> one bootstrap-owned controller. No module-system/bundler change.

`frontend/public/probable-starter.js` owns 20 moved functions:

- `getProbableStarterActualStartAt`
- `getProbableStarterCutoffAt`
- `selectProbableStarterGame`
- `getPreferredProbableStarterGame`
- `isNpbUserEditionActive`
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

Browser globals are limited to the existing `window.Starting9Edition`/location boundary, `document` for the dedicated widget, `Date` and `console`. JS built-ins are unchanged. There are no hidden references to app functions or app state. Shared callbacks do not call the controller; no cycle is introduced.

The sole selector `#probableStarterDisplay` moves to the module. Existing NPB/Asia visibility gates remain. Scheduling remains in the coordinator and the existing 30-second deadline ticker. The module creates no listeners/timers or requests during construction.

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

## Function-level inventory (baseline)

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
| `isNpbUserEditionActive` | probable starter | `initializeProbableStarter`, `refreshProbableStarterTarget`, `fetchStoredProbableStarter`, `renderProbableStarterDisplay` | — | — / — | — |
| `resetProbableStarterDisplay` | probable starter | `initializeProbableStarter`, `refreshProbableStarterTarget` | — | `probableStarter` / `probableStarter` | — |
| `initializeProbableStarter` | probable starter | — | `beginPublicRequest`, `getPreferredProbableStarterGame`, `isNpbUserEditionActive`, `resetProbableStarterDisplay`, `fetchStoredProbableStarter`, `renderProbableStarter` | `probableStarter` / — | — |
| `refreshProbableStarterTarget` | probable starter | `startPredictionDeadlineTicker` | `beginPublicRequest`, `getPreferredProbableStarterGame`, `isNpbUserEditionActive`, `resetProbableStarterDisplay`, `fetchStoredProbableStarter`, `renderProbableStarter` | `probableStarter` / `probableStarter` | — |
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
| `fetchStoredProbableStarter` | probable starter | `initializeProbableStarter`, `refreshProbableStarterTarget` | `beginPublicRequest`, `isCurrentPublicRequest`, `isNpbUserEditionActive`, `buildProbableStarterApiUrl`, `applyStoredProbableStarter`, `getProbableStarterReferenceDiagnostics`, `renderProbableStarter` | `probableStarter` / `probableStarter` | — |
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
| `renderProbableStarterDisplay` | probable starter | `renderProbableStarter` | `isNpbUserEditionActive`, `getFightersStarter`, `deriveProbableStarterViewState`, `renderProbableStarterNotice`, `createProbableStarterHeadingHtml`, `createProbableStarterTeamHtml`, `formatProbableStarterDate`, `formatDateTime`, `escapeHtml` | `probableStarter` / — | `probableStarterDisplay` |
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
