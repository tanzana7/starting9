# Multi-Team Core — C-1 boundary and handoff

Status: C-1 core plus C-2 Marines pilot implementation and local live-roster pipeline proof. Production remains Fighters-only.

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

## Test Site proof

The isolated Test Site defines two synthetic contexts and one real-team pilot in `tooling/test-site/teams.js`:

* TEST Fighters: clearly synthetic key/player ID/provider identity, using isolated fixtures (not production identity).
* TEST Foxes: separate key, player-team ID, provider code, aliases, colors, roster IDs, and canonical game ID.
* Marines pilot: the official `marines` context (`m` provider code, `M` player-team ID); its Test Site game/player IDs remain isolated from production canonical data.

The test-only Auth Worker creates a per-request Worker instance whose immutable closure owns that team's fixture identity. It does not keep mutable module-global team state. The Pages test build substitutes only its ignored `dist/test-site/frontend/shared/production-team.js` bootstrap; test Pages forwards an allowlisted `testTeam` from its test-only cookie/query to the exact isolated test Worker. Production Pages ignores that cookie and does not synthesize a team parameter. Unknown values do not become an arbitrary team; the Pages test surface uses the safe TEST Fighters default, while direct test-Worker requests reject unknown keys.

`tests/test-site-multi-team.test.js` uses in-memory SQLite databases initialized from repository migrations. It resets the three team fixtures and runs prediction save, formal lineup revision/finalize, score, ranking reflection, publication, and result read-back three times. `tooling/test-site/real-team-pilot.mjs` separately reads the public NPB provider's Marines roster, retains official `npb:########` player IDs, injects those rows into the same in-memory Test Site fixture, and repeats the complete pipeline three times before verifying the unpublished baseline. It does not save the source HTML or roster to the repository or call Cloudflare/D1 resources. The scenario uses the existing formal planner and executors, not a replacement scoring pipeline.

The NPB provider's `mode=schedule` and `mode=roster` retain Fighters as the default and accept only the explicit `team=marines` pilot scope in addition. The schedule parser returned the official 2026-10-01 Marines–Fighters game as `m-f-25`; the team-agnostic schedule normalizer handles both home and away and keeps that provider game code as metadata. The roster route scopes extraction to the selected club heading and returns an explicit parse/unsupported error rather than substituting Fighters. The shared probable-starter parser recognizes the Marines official team name. A read-only live request on 2026-10-18 returned the NPB page for 2026-10-19 with zero games, so a live Marines announcement was not available to verify that day; no empty state is replaced with Fighters data.

Production Pages still bootstraps Fighters directly, with no public selector or Marines route. The Test Site's explicit `testTeam=marines` selection is confined to Test Site assets and the guarded test Worker. The production Pages allowlist test continues to be the gate against scenario controls leaking into production artifacts.

## Identity and isolation limitations

Team context does not itself establish every future real-team data contract. Team B proof uses fixture rosters and synthetic player IDs. Existing player-ID prefixes and official NPB identity resolution remain NPB-specific. Manual roster storage still has a Fighters-only schema constraint, and several admin monitor/manual-roster, schedule-source, reconciliation, and provider parsing paths intentionally remain Fighters-only. The test-only roster source is a controlled fixture boundary, not a production roster adapter. Thus C-1 proves the reusable core across the exercised path; it does not certify a second real team's complete operations.

The following remain C-3 blockers or design decisions:

1. **Provider mapping and source behavior:** verify each additional club's official schedule, game identity, roster, lineup, probable-starter sources, aliases, and correction behavior; do not assume provider codes are uniform. The Marines roster and schedule path is proven, but its official lineup and live announced-starter paths still need an in-season/live-source check.
2. **Assets and colors:** obtain licensed/approved team logos/icons, exact accessible palette, metadata, and asset-cache/versioning strategy.
3. **Roster source and persistence:** choose an authoritative roster source and design team-scoped manual roster schema, validation, admin APIs, and migration/backfill after a data audit.
4. **Probable starter and lineup:** implement and test the club-specific source adapters while preserving canonical game/revision guards.
5. **Routes and production selection:** decide host/path routing, SEO/meta, account preference (if any), and ensure authentication remains account-wide. No selector or route is introduced here.
6. **Ranking semantics:** current weekly/monthly/yearly ranking queries aggregate eligible published `ranking_games` per user without a team predicate. Therefore, games from multiple clubs in the same D1 would contribute to the same user aggregate. This is technically non-crashing but the intended product meaning is unresolved; choose shared cross-club ranking or team-scoped ranking and define historical inclusion/publication boundaries before a multi-team release.
7. **Admin scope:** Admin V3 monitor/manual-roster and formal schedule/reconcile paths still contain Fighters-specific assumptions. There is no real-team admin scope in C-2; define operator authorization and prevent selecting or mutating the wrong club's schedule, roster, lineup, jobs, or result.
8. **Automation scope:** production planner and Cron continue to use the Fighters default. C-2 does not enable Marines discovery, roster, lineup, score, ranking, or publication automation in production. Per-team scheduling, fairness, bounded work, and failure isolation must be designed before activation.
9. **Deployment topology:** decide whether clubs share Worker/D1/Cron resources or use separated environments, then prove resource/account boundaries and deployment rollback.
10. **Persistence compatibility:** review existing game/player/job/artifact identifiers and legacy rows. Any required production migration is a separate gated phase.

## C-2 implementation boundary

* `frontend/shared/team-context.js` adds only the Marines real-team context: key/slug `marines`, provider code `m`, player-team ID `M`, official Japanese aliases, and a text/color identity without a copied logo.
* `game-schedule-detection.js` keeps the Fighters wrapper contract and adds target-context filtering for schedule games; the NPB Worker schedule endpoint remains Fighters-default and limits explicit alternate selection to Marines for this pilot.
* The NPB Worker roster endpoint requests a team-scoped official roster block. Auth public-roster retrieval passes its trusted environment target context and checks a returned team identity if supplied. Fighters-only manual-roster overlays/master audits are not applied to the Marines context. A missing or mismatched Marines source returns no roster rather than a Fighters fallback.
* The isolated Test Site can inject validated real NPB player records while preserving its guarded environment, distinct game IDs, and no-Cron/no-service-binding setup. The prediction shape, deadlines, scoring rules, ranking executor, publication contract, and schema are unchanged; no migration was added.
* Probable-starter parsing already models all NPB clubs at the official source boundary. Its live empty state remains empty. Admin roster, manual lineup, cancellation reconciliation, and formal production automation remain Fighters-scoped and are not represented as ready for Marines operations.

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
