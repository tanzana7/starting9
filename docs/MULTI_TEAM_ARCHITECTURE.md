# Multi-Team Core — C-1 boundary and handoff

Status: C-1 implementation and isolated synthetic-team proof. Production remains Fighters-only.

## Contract

Starting9 is organized as the existing prediction/scoring core plus an explicit target-team context at the boundaries that need team identity. This phase does not add a real second club, a production team selector, team-specific production routes, account preferences, or a multi-team ranking policy. The root production site continues to select Fighters, and the existing API paths and game identifiers remain canonical.

`frontend/shared/team-context.js` defines immutable, validated identity and presentation data: key, slug, full/short names, player-team ID, provider code, aliases, share hashtags, colors, and optional logo/icon references. It provides small identity operations (`matchesTeam`, `gameSide`, `gameTeams`) and a branding adapter. It is not a business-logic container. Existing CSS selectors and custom-property names are retained; production bootstrap applies the exact current Fighters values, while the isolated Test Site can apply its synthetic values.

`frontend/shared/production-team.js` is the explicit production bootstrap. Its default is the canonical Fighters context. `backend/target-team.js` is the backend bootstrap and rejects a non-Fighters context unless all isolated Test Worker identity guards match (`ENVIRONMENT=test`, the fixed test-site ID, and the test Worker name). An absent override intentionally means the deployed Fighters default; malformed or unauthorized overrides fail closed.

## Dependency boundaries

| Boundary | Team-sensitive input | Kept team-independent |
|---|---|---|
| Public bootstrap / branding | target identity, labels, palette, share text | layout and prediction interaction |
| Game selection / home-away | canonical game home/away values and target aliases | canonical `internalGameId` |
| Roster and lineup validation | target roster source, team code and player-team ID | 9 slots, positions, duplicate/order rules, persistence shape |
| Probable starter | target side of a home/away game | request lifecycle, stale-response guard, fetch contract |
| Result identity/labels | target context at result resolution/formatting | scoring and publication data/API contracts |
| Formal automation | validated target selector only in explicitly scoped test discovery | production planner, claims, retries, state transitions, executors and cadence |
| Authentication | none | user/session identity remains team-independent |

The prediction validation and persistence modules, scoring rules, result publication, ranking rebuild semantics, auth/session model, migrations, and Cron configuration are not generalized by C-1. Test fixtures pass target context only at discovery/selection boundaries; no team field was added to persisted predictions or game identity.

## Production Fighters configuration

The canonical production context is in `team-context.js`: key/slug `fighters`, player-team ID `F`, provider code `f`, existing Japanese names and aliases, and the four deployed color values. The default production page loads the context before `production-team.js` and the public application. The Auth Worker retains its exact Fighters SQL predicate when no isolated context is supplied. Production does not accept a team-selection query or cookie. No production data, routes, Workers, Pages settings, D1 schema, migrations, or Cron definitions are changed by the architecture itself.

Fighters-related literals that remain in CSS selectors/tokens, player master data, official NPB parsing, legacy game identity, admin-facing Fighters-only copy, schedule/reconcile logic, ranking test fixtures, migrations, and documentation are not blindly rewritten. Some are domain/source contracts rather than presentation identity. Existing NPB formal automation remains Fighters-only; C-1 does not silently turn a generic test selector into a multi-club production planner.

## Synthetic Test Site proof

The isolated Test Site defines two synthetic contexts in `tooling/test-site/teams.js`:

* TEST Fighters: clearly synthetic key/player ID/provider identity, using isolated fixtures (not production identity).
* TEST Foxes: separate key, player-team ID, provider code, aliases, colors, roster IDs, and canonical game ID.

The test-only Auth Worker creates a per-request Worker instance whose immutable closure owns that team's fixture identity. It does not keep mutable module-global team state. The Pages test build substitutes only its ignored `dist/test-site/frontend/shared/production-team.js` bootstrap; test Pages forwards an allowlisted `testTeam` from its test-only cookie/query to the exact isolated test Worker. Production Pages ignores that cookie and does not synthesize a team parameter. Unknown values do not become an arbitrary team; the Pages test surface uses the safe TEST Fighters default, while direct test-Worker requests reject unknown keys.

`tests/test-site-multi-team.test.js` uses in-memory SQLite databases initialized from repository migrations. It resets both synthetic fixtures and runs prediction save, formal lineup revision/finalize, score, ranking reflection, publication, and result read-back for both teams three times. It verifies distinct canonical game/player identities and no cross-team fixture state. The test uses the existing formal planner and executors; it does not simulate these results with a replacement scoring pipeline. No production user/game data is copied.

## Identity and isolation limitations

Team context does not itself establish every future real-team data contract. Team B proof uses fixture rosters and synthetic player IDs. Existing player-ID prefixes and official NPB identity resolution remain NPB-specific. Manual roster storage still has a Fighters-only schema constraint, and several admin monitor/manual-roster, schedule-source, reconciliation, and provider parsing paths intentionally remain Fighters-only. The test-only roster source is a controlled fixture boundary, not a production roster adapter. Thus C-1 proves the reusable core across the exercised path; it does not certify a second real team's complete operations.

The following remain explicit C-2 blockers or design decisions:

1. **Provider mapping and source behavior:** verify each real club's official schedule, game identity, roster, lineup, probable-starter sources, aliases, and correction behavior; do not assume provider codes are uniform.
2. **Assets and colors:** obtain licensed/approved team logos/icons, exact accessible palette, metadata, and asset-cache/versioning strategy.
3. **Roster source and persistence:** choose an authoritative roster source and design team-scoped manual roster schema, validation, admin APIs, and migration/backfill after a data audit.
4. **Probable starter and lineup:** implement and test the club-specific source adapters while preserving canonical game/revision guards.
5. **Routes and production selection:** decide host/path routing, SEO/meta, account preference (if any), and ensure authentication remains account-wide. No selector or route is introduced here.
6. **Ranking semantics:** decide whether ranking is per game, per club, or shared; define historical inclusion and publication boundaries before changing queries/schema.
7. **Admin scope:** define operator authorization and prevent selecting or mutating the wrong club's schedule, roster, lineup, jobs, or result.
8. **Deployment topology:** decide whether clubs share Worker/D1/Cron resources or use separated environments, then prove resource/account boundaries and deployment rollback.
9. **Persistence compatibility:** review existing game/player/job/artifact identifiers and legacy rows. Any required production migration is a separate gated phase.

## C-1 residual classification

* **Canonical Fighters configuration:** `team-context.js`, existing player master, provider code mapping.
* **Branding assets / production text:** Fighters CSS tokens, metadata, logo references, NPB-only copy.
* **Test fixtures:** TEST Fighters/TEST Foxes identities and scenario names.
* **Production-only decisions intentionally retained:** formal schedule discovery, official NPB parser, cancellation/reconcile, manual roster table/handlers, admin defaults, and current ranking semantics.
* **C-2 blockers:** real-team sources, roster persistence, admin scoping, ranking policy, and route/deployment decisions listed above.

## Identity-reference snapshot

The A-2 audit baseline counted 486 `fighters|fighter|日本ハム|ファイターズ` references across its stated tracked-source scope, 30 `FIGHTERS_TEAM_CODE` references, 18 `FIGHTERS_TEAM_ID` references, and 129 CSS color-token references. For a direct C-1 comparison, the six active runtime files that form the principal public/backend decision surface were recounted with the same case-insensitive identity-word search:

| File | Before | C-1 |
|---|---:|---:|
| `auth-worker.js` | 122 | 109 |
| `script.js` | 12 | 3 |
| `fighters-player-master.js` | 18 | 17 |
| `frontend/public/probable-starter.js` | 13 | 10 |
| `game-schedule-detection.js` | 15 | 8 |
| `backend/automation-v3/repository.js` | 17 | 15 |
| **Total in these decision surfaces** | **197** | **162** |

Across runtime source the named constants now occur 22 times (`FIGHTERS_TEAM_CODE`) and 14 times (`FIGHTERS_TEAM_ID`), compared with the audit's 30 and 18. CSS still has 129 existing literal references. The broad lexical identity count is not treated as a success metric: C-1 adds a canonical team-data module and isolated synthetic fixtures, while intentionally leaving NPB parsing/admin/schema contracts explicit. The useful change is the reduction in repeated team-dependent decisions in the six runtime surfaces, not reaching zero text matches.

## Verification boundaries

C-1 validates the default Fighters path through existing regression tests and exercises TEST Foxes in the isolated in-memory full pipeline. Browser-level Test Site deployment/visual smoke is separate from the local fixture proof. No production mutation is part of this phase. If an optional deploy is undertaken, only the explicit TARGET test resources may be used; production deployment is not implied by a passing synthetic test.
