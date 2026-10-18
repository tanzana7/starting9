# Starting9 isolated test site

## Purpose

`starting9-test.pages.dev` is an isolated environment for exercising the existing Starting9 public UI, authentication, prediction, lineup, scoring, ranking, publication, and admin paths with synthetic data. It is not a mock-only UI and must not use production records.

## Resource boundary

- Pages project: `starting9-test`; all remote Pages commands must use the explicit `starting9-target` Wrangler profile (Pages config does not support an `account_id` field).
- Auth Worker: `starting9-test-auth`, entrypoint `tooling/test-site/worker.js`.
- Databases: `starting9-test-auth-db` and `starting9-test-audit-db`.
- The test Worker has no Cron triggers and no service bindings. External NPB fetching is disabled.
- The production site continues to use `starting9-app`, `starting9-auth`, and the production databases. Do not use production deployment configs for this site.

`tooling/test-site/isolation.js` and the config tests fail closed if test identity is missing or a production database ID is bound. The Pages API proxy chooses an exact Auth Worker origin from the explicit `SITE_ENVIRONMENT`; it never accepts an arbitrary URL.

## Synthetic scenario controls

`node tooling/test-site/e2e.mjs` runs the deployed synthetic Team A/B flow without a human login. It requires the short-lived `TEST_E2E_SETUP_TOKEN` Worker secret to be supplied to the runner through `S9_TEST_E2E_SETUP_TOKEN`; the runner never prints it. The test-only provision route creates a random disposable identity through the ordinary registration handler, grants that identity the test admin role, and obtains its cookie through the ordinary login handler. Scenario operations still pass `/api/admin/me` authorization. The runner resets both game-scoped fixtures and deletes that exact disposable identity/session in `finally`; it does not reset existing users or sessions. Remove the setup secret immediately after the run. No production credential or account should be used.

The provision/cleanup route exists only in `tooling/test-site/worker.js` and fails closed unless the Worker environment, exact test D1 IDs, origin, and temporary server-side secret match. It is not part of the production Auth Worker entrypoint. Existing test admins are not modified or required.

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

The fixture contains one clearly marked TEST game per team and 15 `TEST Player` entries. The synthetic roster route only answers for that fixture's canonical internal game ID. Predictions and users persist normally in the isolated test database until the test admin resets the scenario. The CLI E2E runner performs three complete prediction→close→lineup→score→ranking→publish→result cycles for both isolated teams and returns both fixtures to the open, unpublished baseline.

## Build, validate, and deploy

Build static assets with `node tooling/test-site/build-pages.mjs`. Validate the test Worker with `npx wrangler deploy --dry-run --config wrangler.test-auth.jsonc --profile starting9-target`; deploy only with that exact config and profile. The build creates the Pages project root at `dist/test-site-project`, with its config and Pages Function proxy, and public files at `dist/test-site`. Run Pages commands with `--cwd dist/test-site-project --profile starting9-target`. Never omit the profile, and do not run `tooling/production-deploy.cjs` for test resources.

Apply the repository's existing Auth and Audit migrations only to the two test D1s, using the explicit test Worker config and `starting9-target` profile. Do not run source-account commands or production configs during setup.
