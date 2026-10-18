# Deployment Guide

## Configuration

- `wrangler.auth.example.jsonc` is the safe configuration template.
- `wrangler.auth.target.production.jsonc` and `wrangler.npb.target.jsonc` are the only normal production Worker configurations. The required Wrangler profile is `starting9-target`.
- The permanent production Pages project is `starting9-app` in the TARGET account. Its canonical origin is `https://starting9-app.pages.dev/`.
- The legacy `https://starting9.pages.dev/` project and the validated migration project are retained for rollback/reference and are not deleted or redirected by this release.
- `wrangler.auth.production.jsonc` is a legacy SOURCE rollback/reference configuration. It must not be used for normal production deployment.
- Secrets and local credentials belong in Wrangler secrets or local ignored files such as `.dev.vars`; never commit them or place them in logs.
- `AUTH_DB` is the D1 binding used by `auth-worker.js`.
- `NPB_FETCH_WORKER` is the service binding to the NPB retrieval Worker.

## Verification Before Release

Run from a clean release worktree:

```powershell
node --test
node --check script.js
node --check auth-worker.js
git diff --check
npm run check
```

Repository CI (`.github/workflows/ci.yml`) is intentionally limited to dependency installation, Node tests, syntax checks, `git diff --check`, and conflict-marker checks. It has no Cloudflare credentials and never deploys, writes D1, applies migrations, executes `scripts/`, or sends Discord notifications.

Check for conflict markers and confirm that only intended files are changed. Do not execute scripts under `scripts/` as part of a normal release check.

## Production preflight and deployment

Production deployment is guarded by `tooling/production-deploy.cjs`. It refuses to run unless the current checkout is `main`, clean, and exactly equal to `origin/main`. It also validates the TARGET account, Worker name, D1 bindings, service binding, and the approved five Cron expressions.

Run only the fixed package scripts:

```powershell
npm run deploy:prod:npb
npm run deploy:prod:auth
npm run deploy:prod:pages
```

The scripts use these fixed commands internally:

```powershell
npx wrangler deploy --config wrangler.npb.target.jsonc --profile starting9-target --strict --var BUILD_COMMIT:<git-commit> --message production-npb-<git-commit>
npx wrangler deploy --config wrangler.auth.target.production.jsonc --profile starting9-target --strict --var BUILD_COMMIT:<git-commit> --message production-auth-<git-commit>
npx wrangler pages deploy dist/production-site --project-name starting9-app --branch main --profile starting9-target --commit-hash <git-commit> --commit-message production-pages-<git-commit>
```

The guarded Pages command first builds `dist/production-site` from the explicit production asset allowlist in `tooling/pages-assets.mjs`. Deploy only that generated artifact; never deploy the repository root, which also contains Test Site scenario assets.

Do not use a bare `npx wrangler deploy`, allow a user-supplied config path, or deploy from a feature branch/worktree.

The Auth Worker's `/health` response exposes only the non-secret `BUILD_COMMIT` value injected by the guard. It never exposes account IDs, D1 IDs, secrets, or branch names.

## Pages Deployment

When public or admin static assets change, deploy the main branch explicitly:

```powershell
npm run deploy:prod:pages
```

For a local packaging check without deployment, run `npm run build:prod:pages` and inspect only the generated allowlisted artifact.

The Pages Function requires `STARTING9_AUTH_ORIGIN` to be exactly `https://starting9-auth.starting9.workers.dev`. The permanent TARGET Pages project is configured with this non-secret variable. Missing, SOURCE, or invalid values fail closed with HTTP 503; SOURCE is retained only for an explicitly approved rollback procedure.

Verify both the deployment URL and the production alias. Confirm the expected `script.js` and `style.css` cache busters in the production HTML.

## Database Changes

Migrations are additive or explicitly reviewed schema changes. Review the full migration chain before applying it. Production D1 migration application and direct writes are separate approval steps and are never implied by a Worker or Pages deploy.

Do not run ranking reset markers, repair actions, or manual state updates as part of a static asset release.

## Rollback

If a release is unhealthy, stop new changes, capture the Worker version, Pages deployment, relevant job/audit identifiers, and user-visible symptoms. Roll back through the reviewed deployment mechanism. Do not use destructive Git commands or rewrite D1 data to hide an incident.
