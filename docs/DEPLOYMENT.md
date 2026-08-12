# Deployment Guide

## Configuration

- `wrangler.auth.example.jsonc` is the safe configuration template.
- `wrangler.auth.production.jsonc` is the production Worker configuration and must be handled as deployment configuration, not as an application secret store.
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
npx wrangler deploy --dry-run --config wrangler.auth.production.jsonc
```

Repository CI (`.github/workflows/ci.yml`) is intentionally limited to dependency installation, Node tests, syntax checks, `git diff --check`, and conflict-marker checks. It has no Cloudflare credentials and never deploys, writes D1, applies migrations, executes `scripts/`, or sends Discord notifications.

Check for conflict markers and confirm that only intended files are changed. Do not execute scripts under `scripts/` as part of a normal release check.

## Worker Deployment

Use the explicit production configuration:

```powershell
npx wrangler deploy --config wrangler.auth.production.jsonc
```

A bare `npx wrangler deploy` is not an acceptable production command because it may select the wrong configuration.

## Pages Deployment

When public or admin static assets change, deploy the main branch explicitly:

```powershell
npx wrangler pages deploy . --project-name=starting9 --branch=main
```

Verify both the deployment URL and the production alias. Confirm the expected `script.js` and `style.css` cache busters in the production HTML.

## Database Changes

Migrations are additive or explicitly reviewed schema changes. Review the full migration chain before applying it. Production D1 migration application and direct writes are separate approval steps and are never implied by a Worker or Pages deploy.

Do not run ranking reset markers, repair actions, or manual state updates as part of a static asset release.

## Rollback

If a release is unhealthy, stop new changes, capture the Worker version, Pages deployment, relevant job/audit identifiers, and user-visible symptoms. Roll back through the reviewed deployment mechanism. Do not use destructive Git commands or rewrite D1 data to hide an incident.
