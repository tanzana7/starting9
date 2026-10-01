import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTIONS,
  AUTH_CRONS,
  buildWranglerArgs,
  validatePagesConfig,
  validateWorkerConfig
} from "../tooling/production-deploy.cjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HEAD = "667beccf19a5d692c9aebbe099765f123c4d05be";

test("production deploy guard fixes Auth/NPB to TARGET config and profile", () => {
  validateWorkerConfig(root, "auth");
  validateWorkerConfig(root, "npb");

  assert.deepEqual(ACTIONS.auth, {
    config: "wrangler.auth.target.production.jsonc",
    profile: "starting9-target",
    worker: "starting9-auth",
    main: "auth-worker.js"
  });
  assert.deepEqual(ACTIONS.npb, {
    config: "wrangler.npb.target.jsonc",
    profile: "starting9-target",
    worker: "starting9-npb-fetch",
    main: "cloudflare-worker.js"
  });
  assert.deepEqual(AUTH_CRONS, [
    "* * * * *",
    "*/5 * * * *",
    "1,16,31,46 * * * *",
    "2,7,12,17,22,27,32,37,42,47,52,57 * * * *",
    "0,15,30,45 * * * *"
  ]);
});

test("production Worker deploy injects the Git commit as BUILD_COMMIT", () => {
  assert.deepEqual(buildWranglerArgs(root, "auth", HEAD), [
    "wrangler",
    "deploy",
    "--config",
    "wrangler.auth.target.production.jsonc",
    "--profile",
    "starting9-target",
    "--strict",
    "--var",
    `BUILD_COMMIT:${HEAD}`,
    "--message",
    "production auth 667beccf19a5"
  ]);
  assert.deepEqual(buildWranglerArgs(root, "npb", HEAD).slice(0, 8), [
    "wrangler",
    "deploy",
    "--config",
    "wrangler.npb.target.jsonc",
    "--profile",
    "starting9-target",
    "--strict",
    "--var"
  ]);
});

test("Pages deploy guard permits only the TARGET fail-closed proxy", () => {
  validatePagesConfig(root);
  assert.deepEqual(buildWranglerArgs(root, "pages", HEAD), [
    "wrangler",
    "pages",
    "deploy",
    ".",
    "--project-name",
    "starting9",
    "--branch",
    "main",
    "--profile",
    "starting9-source"
  ]);
});
