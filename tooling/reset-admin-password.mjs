import { pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PBKDF2_ITERATIONS = 100_000;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 72;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const WRANGLER_TIMEOUT_MS = 120_000;
const USERNAME_PATTERN = /^[\p{L}\p{N}_-]+$/u;

function usage() {
  return [
    "Usage:",
    "  node tooling/reset-admin-password.mjs --username <admin> --password-stdin --confirm-reset <admin>",
    "    --profile <wrangler-profile> --config <production-config> --database <d1-name>",
    "",
    "The password is read only from stdin. No password value is accepted as a CLI argument.",
    "The command always targets a remote D1 and requires an explicit Wrangler profile/config/database."
  ].join("\n");
}

export function normalizeUsername(username) {
  return String(username).normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

export function validatePassword(password) {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new Error(`Password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters.`);
  }
  if (/[\r\n]/u.test(password)) throw new Error("Password must not contain line breaks.");
}

export function derivePasswordRecord(password, { salt = randomBytes(SALT_BYTES), iterations = PBKDF2_ITERATIONS } = {}) {
  validatePassword(password);
  const hash = pbkdf2Sync(Buffer.from(password, "utf8"), salt, iterations, HASH_BYTES, "sha256");
  return {
    passwordHash: hash.toString("base64url"),
    passwordSalt: Buffer.from(salt).toString("base64url"),
    passwordIterations: iterations
  };
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function buildPasswordResetSql({ userId, usernameNormalized, passwordHash, passwordSalt, passwordIterations, updatedAt }) {
  return [
    "BEGIN TRANSACTION;",
    `UPDATE users SET password_hash = ${sqlString(passwordHash)}, password_salt = ${sqlString(passwordSalt)}, password_iterations = ${Number(passwordIterations)}, status = 'active', updated_at = ${sqlString(updatedAt)} WHERE id = ${sqlString(userId)} AND username_normalized = ${sqlString(usernameNormalized)} AND role = 'admin';`,
    `DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE id = ${sqlString(userId)} AND username_normalized = ${sqlString(usernameNormalized)} AND role = 'admin');`,
    "COMMIT;",
    ""
  ].join("\n");
}

export function parseArgs(argv) {
  const options = { passwordStdin: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--password-stdin") {
      options.passwordStdin = true;
      continue;
    }
    const [key, inlineValue] = arg.split("=", 2);
    if (!["--username", "--confirm-reset", "--profile", "--config", "--database"].includes(key)) {
      throw new Error(`Unknown option: ${arg}`);
    }
    const value = inlineValue ?? argv[++index];
    if (!value) throw new Error(`${key} requires a value.`);
    options[key.slice(2).replaceAll("-", "_")] = value;
  }
  if (!options.username || options.confirm_reset !== options.username) throw new Error("--confirm-reset must exactly match --username.");
  if (!options.passwordStdin) throw new Error("--password-stdin is required.");
  if (!options.profile || !options.config || !options.database) throw new Error("--profile, --config, and --database are required.");
  if (!USERNAME_PATTERN.test(options.username) || normalizeUsername(options.username) !== options.username.normalize("NFKC").trim().toLocaleLowerCase("en-US")) {
    throw new Error("--username contains unsupported characters.");
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(options.profile) || !/^[A-Za-z0-9_.-]+$/.test(options.database)) {
    throw new Error("--profile and --database contain unsupported characters.");
  }
  return options;
}

export async function assertConfigMatches(options, { read = readFile } = {}) {
  const configText = await read(options.config, "utf8");
  const accountId = configText.match(/"account_id"\s*:\s*"([^"]+)"/u)?.[1] || "";
  if (!accountId) throw new Error("The Wrangler config must contain an explicit account_id.");
  const authBinding = configText.match(/\{(?=[^{}]*"binding"\s*:\s*"AUTH_DB")[^{}]*\}/su)?.[0] || "";
  const authDatabase = authBinding.match(/"database_name"\s*:\s*"([^"]+)"/u)?.[1] || "";
  if (!authDatabase || authDatabase !== options.database) {
    throw new Error("--database must match the AUTH_DB database_name in --config.");
  }
  return { accountId, authDatabase };
}

function runWrangler(args) {
  const executable = process.platform === "win32" ? "npx.cmd" : "npx";
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--yes", "wrangler", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Wrangler timed out. Check the selected profile authentication."));
    }, WRANGLER_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`Wrangler failed (${code}): ${stderr.trim() || stdout.trim()}`));
      else resolve(stdout);
    });
  });
}

function extractRows(output) {
  const parsed = JSON.parse(output);
  const candidates = [parsed, ...(Array.isArray(parsed) ? parsed : [])];
  for (const candidate of candidates) {
    if (Array.isArray(candidate?.results)) return candidate.results;
    if (Array.isArray(candidate?.result?.results)) return candidate.result.results;
  }
  return [];
}

function wranglerArgs(options, sqlOption) {
  return [
    "d1", "execute", options.database,
    "--remote", "--json", "--yes",
    "--config", options.config,
    "--profile", options.profile,
    sqlOption
  ];
}

async function readPassword() {
  const input = await readFile(0, "utf8");
  return input.replace(/\r?\n$/u, "");
}

export async function resetAdminPassword(options, { password, now = new Date().toISOString(), execute = runWrangler } = {}) {
  await assertConfigMatches(options);
  const usernameNormalized = normalizeUsername(options.username);
  console.error("[admin-reset] checking the selected admin account...");
  const lookupSql = `SELECT id, username, role FROM users WHERE username_normalized = ${sqlString(usernameNormalized)} AND role = 'admin' LIMIT 2;`;
  const lookupOutput = await execute(wranglerArgs(options, `--command=${lookupSql}`));
  const rows = extractRows(lookupOutput);
  if (rows.length !== 1) throw new Error(rows.length === 0 ? "Admin user was not found." : "More than one admin user matched.");

  const record = derivePasswordRecord(password);
  const sql = buildPasswordResetSql({
    userId: rows[0].id,
    usernameNormalized,
    ...record,
    updatedAt: now
  });
  const tempDir = await mkdtemp(path.join(tmpdir(), "starting9-admin-reset-"));
  const sqlPath = path.join(tempDir, "reset.sql");
  try {
    await writeFile(sqlPath, sql, { encoding: "utf8", mode: 0o600 });
    console.error("[admin-reset] updating the password hash and revoking sessions...");
    await execute(wranglerArgs(options, `--file=${sqlPath}`));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  const verifySql = `SELECT id, username, role, updated_at FROM users WHERE id = ${sqlString(rows[0].id)} AND username_normalized = ${sqlString(usernameNormalized)} AND role = 'admin' LIMIT 1;`;
  console.error("[admin-reset] verifying the update...");
  const verifyOutput = await execute(wranglerArgs(options, `--command=${verifySql}`));
  const verified = extractRows(verifyOutput);
  if (verified.length !== 1 || verified[0].updated_at !== now) throw new Error("Password reset could not be verified.");
  return { username: verified[0].username, sessionsRevoked: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      process.exit(0);
    }
    const result = await resetAdminPassword(options, { password: await readPassword() });
    console.log(`Admin password reset completed for ${result.username}. Existing sessions were revoked.`);
  } catch (error) {
    console.error(`Admin password reset failed: ${error.message}`);
    process.exitCode = 1;
  }
}
