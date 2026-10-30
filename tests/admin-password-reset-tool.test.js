import test from "node:test";
import assert from "node:assert/strict";
import { assertConfigMatches, buildPasswordResetSql, derivePasswordRecord, normalizeUsername, parseArgs, resetAdminPassword } from "../tooling/reset-admin-password.mjs";

test("admin password reset uses the same normalized username contract", () => {
  assert.equal(normalizeUsername(" TQNZANADM "), "tqnzanadm");
  assert.deepEqual(parseArgs([
    "--username", "tqnzanadm",
    "--confirm-reset", "tqnzanadm",
    "--password-stdin",
    "--profile", "starting9-target",
    "--config", "wrangler.auth.target.production.jsonc",
    "--database", "starting9-auth-prod"
  ]), {
    username: "tqnzanadm",
    confirm_reset: "tqnzanadm",
    passwordStdin: true,
    profile: "starting9-target",
    config: "wrangler.auth.target.production.jsonc",
    database: "starting9-auth-prod"
  });
});

test("password is never accepted as a CLI option", () => {
  assert.throws(() => parseArgs([
    "--username", "tqnzanadm",
    "--confirm-reset", "tqnzanadm",
    "--password", "not-safe",
    "--profile", "starting9-target",
    "--config", "config.jsonc",
    "--database", "starting9-auth"
  ]), /Unknown option/);
});

test("PBKDF2 output is compatible in shape and SQL contains no plaintext password", () => {
  const record = derivePasswordRecord("not-a-production-password", { salt: Buffer.alloc(16, 7) });
  assert.equal(record.passwordHash.length > 0, true);
  assert.equal(record.passwordSalt, "BwcHBwcHBwcHBwcHBwcHBw");
  const sql = buildPasswordResetSql({
    userId: "admin-1",
    usernameNormalized: "tqnzanadm",
    ...record,
    updatedAt: "2026-10-07T00:00:00.000Z"
  });
  assert.match(sql, /role = 'admin'/);
  assert.match(sql, /DELETE FROM sessions/);
  assert.doesNotMatch(sql, /not-a-production-password/);
});

test("reset performs a read-only lookup before the write and verifies it afterward", async () => {
  const calls = [];
  const options = {
    username: "tqnzanadm",
    confirm_reset: "tqnzanadm",
    passwordStdin: true,
    profile: "starting9-target",
    config: "wrangler.auth.target.production.jsonc",
    database: "starting9-auth-prod"
  };
  const execute = async (args) => {
    calls.push(args);
    if (args.some((arg) => arg.startsWith("--file="))) return "{}";
    if (calls.length === 1) return JSON.stringify({ results: [{ id: "admin-1", username: "tqnzanadm", role: "admin" }] });
    return JSON.stringify({ results: [{ id: "admin-1", username: "tqnzanadm", role: "admin", updated_at: "2026-10-07T00:00:00.000Z" }] });
  };
  const result = await resetAdminPassword(options, { password: "new-safe-password", now: "2026-10-07T00:00:00.000Z", execute });
  assert.deepEqual(result, { username: "tqnzanadm", sessionsRevoked: true });
  assert.equal(calls.length, 3);
  assert.match(calls[0].at(-1), /^--command=SELECT/);
  assert.match(calls[1].at(-1), /^--file=/);
  assert.match(calls[2].at(-1), /^--command=SELECT/);
});

test("production config must explicitly bind the selected AUTH_DB", async () => {
  const result = await assertConfigMatches({ config: "wrangler.auth.target.production.jsonc", database: "starting9-auth-prod" });
  assert.equal(result.authDatabase, "starting9-auth-prod");
  await assert.rejects(
    () => assertConfigMatches({ config: "wrangler.auth.target.production.jsonc", database: "starting9-auth" }),
    /AUTH_DB database_name/
  );
});
