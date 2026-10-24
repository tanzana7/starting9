# Starting9 isolated test site

## Purpose

`s9simu.pages.dev` is the public Simulated NPB source site. Its root, schedule, team, and game pages render the same six-game, twelve-team fixture used by the machine-readable schedule and existing parser-compatible roster/lineup pages. The duplicate Starting9 Test frontend is not published; legacy `/starting9/` and `/teams/*` document URLs redirect to `starting9-app.pages.dev`, the only public Starting9 UI. Test Worker, Test D1, API, simulator admin endpoint, fixtures, and E2E tooling remain isolated and are not production data sources.

## Resource boundary

- Pages project: `s9simu`; all remote Pages commands must use the explicit `starting9-target` Wrangler profile (Pages config does not support an `account_id` field).
- Auth Worker: `starting9-test-auth`, entrypoint `tooling/test-site/worker.js`.
- Databases: `starting9-test-auth-db` and `starting9-test-audit-db`.
- The Test Worker has no service bindings and keeps external NPB fetching disabled in its base configuration. The 2026-10-25 unattended Fighters rehearsal temporarily enables the five Production-equivalent Cron schedules in `wrangler.test-auth.jsonc`; its runtime identity guard allows only the isolated Test D1s, and the synthetic seeder is further limited to the rehearsal's exact one-hour window.
- The production site continues to use `starting9-app`, `starting9-auth`, and the production databases. Do not use production deployment configs for this site.

`tooling/test-site/isolation.js` and the config tests fail closed if test identity is missing or a production database ID is bound. The Pages API proxy chooses an exact Auth Worker origin from the explicit `SITE_ENVIRONMENT`; it never accepts an arbitrary URL.

## Synthetic scenario controls

The public schedule/team/source pages are read-only; the separately authorized Lineup Editor may update only synthetic lineup state. The site has no Starting9 login or scoring-pipeline UI. The scenario-control page and its client source remain in the repository for isolated development/CI, but are not copied to the public Pages artifact. `/simu-npb/control` remains a test-only endpoint used by the existing authorized E2E workflow; it is not linked from the public source pages. The parser-facing NPB-shaped schedule, roster, and lineup endpoints remain unchanged.

`node tooling/test-site/simu-e2e.mjs` runs the deployed 12-team simulator flow only from the manually dispatched `S9simu Remote E2E` workflow on `main`. The workflow requests a short-lived GitHub Actions OIDC token with audience `starting9-simu-e2e`; the Test Worker verifies GitHub's signature and pins the repository ID, main ref, workflow path, event type, and token time window before creating a run-derived, one-time E2E admin identity. A duplicate workflow proof is rejected by the reserved identity's unique username. The issued admin session expires after 30 minutes and is revoked during cleanup. Successful runs retain only the demoted ranking identity; failed runs retain a disabled replay marker until the OIDC proof expires, then the next authorized run removes that expired marker. No persistent setup secret, Cloudflare credential, or production account is used by the workflow.

The provision/cleanup route exists only in `tooling/test-site/worker.js` and fails closed unless the Worker environment, exact test D1 IDs, origin, and signed workflow identity match. It is not part of the production Auth Worker entrypoint. Existing test admins are not modified or required.

Scenarios:

1. No game
2. Future game / before predictions open
3. Prediction open
4. Five minutes before deadline
5. Deadline passed / lineup not finalized
6. Formal lineup finalized
7. Scored
8. Ranking reflected
9. Published
10. Ranking retry error
11. Probable starter: unannounced / announced / unavailable

The scenario controller uses the formal planner, existing admin lineup APIs, and existing score/ranking/publication executors. Applying a scenario re-bases the synthetic game timestamps relative to the current real clock so the transitions can be tested immediately; it does not replace or monkeypatch the runtime clock. Reset removes only rows keyed to the single fixed synthetic game and reseeds the open baseline. Reset before moving backward from a later completed scenario.

The fixture contains six deterministic physical games, pairing all twelve canonical NPB team contexts once, with one contest per participating team (twelve contests total). Each team receives its own 15-player `TEST Player` roster, and the synthetic roster route only answers for that team's canonical fixture game ID. The CLI E2E runner completes prediction→close→lineup→score→ranking→publish→result independently for every team contest, including both contests of each shared physical game, then returns all six games to the open, unpublished baseline and removes only scenario-scoped synthetic audit rows plus the disposable E2E identity/session.

## Build, validate, and deploy

Build static assets with `node tooling/test-site/build-pages.mjs`. The public artifact contains only the legacy-route redirects, Simulated NPB route manifest, and simulator styles/editor asset; its Pages Functions and isolated APIs are assembled separately under `dist/test-site-project`. Starting9 app files and private scenario-control UI sources are not published. Validate the test Worker with `npx wrangler deploy --dry-run --config wrangler.test-auth.jsonc --profile starting9-target`; deploy only with that exact config and profile. The build creates the Pages project root at `dist/test-site-project`, with its config and Pages Function proxy, and public files at `dist/test-site`. Run Pages commands with `--cwd dist/test-site-project --profile starting9-target`. Never omit the profile, and do not run `tooling/production-deploy.cjs` for test resources.

After the 2026-10-25 final observer checkpoint has been collected, remove the temporary `triggers.crons` block from `wrangler.test-auth.jsonc`, validate with `npm run check`, then deploy that Test-only config with `npx wrangler deploy --config wrangler.test-auth.jsonc --profile starting9-target` to detach the schedules. Do not perform this cleanup before the final observer result. This cleanup must never use a Production config or profile.

Apply the repository's existing Auth and Audit migrations only to the two test D1s, using the explicit test Worker config and `starting9-target` profile. Do not run source-account commands or production configs during setup.
