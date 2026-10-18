const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TARGET_ACCOUNT_ID = "02580fab1c09e144db7da89478e252c8";
const TARGET_AUTH_D1 = "326f97c3-768d-4df6-ada2-129fdb1865a1";
const TARGET_AUDIT_D1 = "acfac47d-1963-433a-b16b-36cd3afe9db4";
const TARGET_PROFILE = "starting9-target";
const TARGET_PAGES_PROJECT = "starting9-app";
const AUTH_CRONS = [
  "* * * * *",
  "*/5 * * * *",
  "1,16,31,46 * * * *",
  "2,7,12,17,22,27,32,37,42,47,52,57 * * * *",
  "0,15,30,45 * * * *"
];

const ACTIONS = Object.freeze({
  auth: {
    config: "wrangler.auth.target.production.jsonc",
    profile: TARGET_PROFILE,
    worker: "starting9-auth",
    main: "auth-worker.js"
  },
  npb: {
    config: "wrangler.npb.target.jsonc",
    profile: TARGET_PROFILE,
    worker: "starting9-npb-fetch",
    main: "cloudflare-worker.js"
  },
  pages: {
    config: null,
    profile: TARGET_PROFILE,
    project: TARGET_PAGES_PROJECT,
    artifact: "dist/production-site"
  }
});

function fail(message) {
  throw new Error(`[production-deploy-guard] ${message}`);
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) fail(`git ${args.join(" ")} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`git ${args.join(" ")} failed: ${(result.stderr || "").trim()}`);
  return result.stdout.trim();
}

function parseJsonConfig(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  if (!fs.existsSync(absolutePath)) fail(`missing config: ${relativePath}`);
  try {
    return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    fail(`invalid JSON config ${relativePath}: ${error.message}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label}: expected ${expected}, got ${actual || "<empty>"}`);
}

function assertArray(actual, expected, label) {
  if (!Array.isArray(actual) || actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    fail(`${label} does not match the approved production value`);
  }
}

function assertRepositoryState(cwd, { branch = "main" } = {}) {
  assertEqual(runGit(cwd, ["branch", "--show-current"]), branch, "branch");
  assertEqual(runGit(cwd, ["status", "--porcelain"]), "", "working tree");
  const head = runGit(cwd, ["rev-parse", "HEAD"]);
  const originMain = runGit(cwd, ["rev-parse", "origin/main"]);
  assertEqual(head, originMain, "HEAD/origin/main");
  return head;
}

function validateWorkerConfig(cwd, actionName) {
  const action = ACTIONS[actionName];
  if (!action?.config) return;
  const config = parseJsonConfig(cwd, action.config);
  assertEqual(config.account_id, TARGET_ACCOUNT_ID, `${actionName} account_id`);
  assertEqual(config.name, action.worker, `${actionName} Worker name`);
  assertEqual(config.main, action.main, `${actionName} entrypoint`);
  if (actionName === "auth") {
    assertArray(config.triggers?.crons, AUTH_CRONS, "Auth production Cron");
    const databases = new Map((config.d1_databases || []).map((database) => [database.binding, database]));
    assertEqual(databases.get("AUTH_DB")?.database_name, "starting9-auth-prod", "Auth D1 name");
    assertEqual(databases.get("AUTH_DB")?.database_id, TARGET_AUTH_D1, "Auth D1 id");
    assertEqual(databases.get("AUDIT_DB")?.database_name, "starting9-audit-prod", "Audit D1 name");
    assertEqual(databases.get("AUDIT_DB")?.database_id, TARGET_AUDIT_D1, "Audit D1 id");
    if ((config.services || []).some((service) => service.binding === "ASIA_CS_SERVICE")) {
      fail("Auth production config must not include the removed service binding");
    }
    assertEqual(config.services?.find((service) => service.binding === "NPB_FETCH_WORKER")?.service, "starting9-npb-fetch", "NPB service binding");
  }
}

function validatePagesConfig(cwd) {
  const proxy = fs.readFileSync(path.join(cwd, "functions", "api", "[[path]].js"), "utf8");
  if (!proxy.includes("https://starting9-auth.starting9.workers.dev")) fail("Pages proxy target origin is missing");
  if (proxy.includes("SOURCE_AUTH_WORKER_ORIGIN") || proxy.includes("starting9-auth.tanzana7.workers.dev")) {
    fail("Pages proxy still contains a SOURCE runtime fallback");
  }
  const routes = parseJsonConfig(cwd, "_routes.json");
  if (JSON.stringify(routes) !== JSON.stringify({ version: 1, include: ["/api/*"], exclude: [] })) {
    fail("Pages API route boundary is not the approved /api/* boundary");
  }
}

function validateProductionState(cwd, actionName) {
  const head = assertRepositoryState(cwd);
  validateWorkerConfig(cwd, actionName);
  if (actionName === "pages") validatePagesConfig(cwd);
  return head;
}

function buildWranglerArgs(cwd, actionName, head) {
  const action = ACTIONS[actionName];
  if (!action) fail(`unknown deployment target: ${actionName}`);
  if (actionName === "pages") {
    return ["wrangler", "pages", "deploy", action.artifact, "--project-name", action.project, "--branch", "main", "--profile", action.profile, "--commit-hash", head, "--commit-message", `production-pages-${head.slice(0, 12)}`];
  }
  return [
    "wrangler",
    "deploy",
    "--config",
    action.config,
    "--profile",
    action.profile,
    "--strict",
    "--var",
    `BUILD_COMMIT:${head}`,
    "--message",
    `production-${actionName}-${head.slice(0, 12)}`
  ];
}

function deploy(cwd, actionName) {
  const head = validateProductionState(cwd, actionName);
  if (actionName === "pages") {
    const build = spawnSync(process.execPath, [path.join(cwd, "tooling", "production-pages", "build.mjs")], { cwd, stdio: "inherit" });
    if (build.error) fail(`Pages artifact build failed: ${build.error.message}`);
    if (build.status !== 0) process.exit(build.status || 1);
  }
  const args = buildWranglerArgs(cwd, actionName, head);
  // Windows exposes npx as a .cmd shim that Node cannot spawn directly with
  // inherited stdio (it returns EINVAL).  Shell execution is safe here because
  // every argument is generated from fixed config values or a validated commit
  // hash, and keeps the production guard usable on both platforms.
  const command = "npx";
  console.log(`[production-deploy-guard] ${actionName} approved for ${head}`);
  console.log(`[production-deploy-guard] executing: npx ${args.slice(1).join(" ")}`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) fail(`Wrangler execution failed: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status || 1);
}

if (require.main === module) {
  const actionName = process.argv[2];
  const cwd = process.cwd();
  try {
    deploy(cwd, actionName);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = {
  ACTIONS,
  AUTH_CRONS,
  buildWranglerArgs,
  validatePagesConfig,
  validateProductionState,
  validateWorkerConfig
};
