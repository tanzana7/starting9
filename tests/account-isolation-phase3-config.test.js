import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readConfig = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));

const SOURCE_AUTH_DB = "0ad8ada3-f50a-4e83-be8a-15a0b24324c6";
const SOURCE_AUDIT_DB = "8bf24658-d9d3-4ba9-870e-3b92d660543f";
const TARGET_ACCOUNT = "02580fab1c09e144db7da89478e252c8";
const TARGET_STAGING_AUTH_DB = "c5137bcc-0fcc-4822-95b8-996dffaf0818";
const TARGET_STAGING_AUDIT_DB = "9d97a0fb-9767-4ef2-9ba2-dcf0bd92774f";
const TARGET_PRODUCTION_AUTH_DB = "326f97c3-768d-4df6-ada2-129fdb1865a1";
const TARGET_PRODUCTION_AUDIT_DB = "acfac47d-1963-433a-b16b-36cd3afe9db4";

test("account isolation staging config has no Cron and target-only resources", () => {
  const staging = readConfig("wrangler.auth.target.jsonc");

  assert.equal(staging.account_id, TARGET_ACCOUNT);
  assert.equal(Object.hasOwn(staging, "triggers"), false);
  assert.equal(staging.vars.MIGRATION_MAINTENANCE, "false");
  assert.deepEqual(staging.services, [{ binding: "NPB_FETCH_WORKER", service: "starting9-npb-fetch" }]);
  assert.deepEqual(
    staging.d1_databases.map(({ binding, database_id }) => ({ binding, database_id })),
    [
      { binding: "AUTH_DB", database_id: TARGET_STAGING_AUTH_DB },
      { binding: "AUDIT_DB", database_id: TARGET_STAGING_AUDIT_DB }
    ]
  );
  assert.doesNotMatch(JSON.stringify(staging), new RegExp(`${SOURCE_AUTH_DB}|${SOURCE_AUDIT_DB}`));
});

test("account isolation cutover config carries the exact source Cron set without source IDs", () => {
  const source = readConfig("wrangler.auth.production.jsonc");
  const cutover = readConfig("wrangler.auth.target.production.jsonc");

  assert.equal(source.vars.MIGRATION_MAINTENANCE, "false");
  assert.equal(cutover.account_id, TARGET_ACCOUNT);
  assert.equal(cutover.vars.MIGRATION_MAINTENANCE, "false");
  assert.equal(cutover.vars.REQUIRE_CONTEST_SCHEMA, "true");
  assert.deepEqual(
    cutover.d1_databases.map(({ binding, database_name }) => ({ binding, database_name })),
    [
      { binding: "AUTH_DB", database_name: "starting9-auth-prod" },
      { binding: "AUDIT_DB", database_name: "starting9-audit-prod" }
    ]
  );
  assert.deepEqual(cutover.triggers, source.triggers);
  assert.deepEqual(cutover.services, [
    { binding: "NPB_FETCH_WORKER", service: "starting9-npb-fetch" }
  ]);
  assert.deepEqual(
    cutover.d1_databases.map(({ binding, database_id }) => ({ binding, database_id })),
    [
      { binding: "AUTH_DB", database_id: TARGET_PRODUCTION_AUTH_DB },
      { binding: "AUDIT_DB", database_id: TARGET_PRODUCTION_AUDIT_DB }
    ]
  );
  assert.doesNotMatch(JSON.stringify(cutover), new RegExp(`${SOURCE_AUTH_DB}|${SOURCE_AUDIT_DB}|${TARGET_STAGING_AUTH_DB}|${TARGET_STAGING_AUDIT_DB}`));
});

test("target production maintenance config freezes the production databases without Cron", () => {
  const production = readConfig("wrangler.auth.target.production.jsonc");
  const maintenance = readConfig("wrangler.auth.target.maintenance.jsonc");

  assert.equal(maintenance.account_id, TARGET_ACCOUNT);
  assert.deepEqual(maintenance.triggers, { crons: [] });
  assert.equal(maintenance.vars.MIGRATION_MAINTENANCE, "true");
  assert.deepEqual(
    maintenance.d1_databases.map(({ binding, database_name }) => ({ binding, database_name })),
    [
      { binding: "AUTH_DB", database_name: "starting9-auth-prod" },
      { binding: "AUDIT_DB", database_name: "starting9-audit-prod" }
    ]
  );
  assert.deepEqual(maintenance.services, production.services);
  assert.deepEqual(
    maintenance.d1_databases.map(({ binding, database_id }) => ({ binding, database_id })),
    production.d1_databases.map(({ binding, database_id }) => ({ binding, database_id }))
  );
  assert.doesNotMatch(JSON.stringify(maintenance), new RegExp(`${SOURCE_AUTH_DB}|${SOURCE_AUDIT_DB}|${TARGET_STAGING_AUTH_DB}|${TARGET_STAGING_AUDIT_DB}`));
});

test("source maintenance config clears Cron and freezes writes", () => {
  const source = readConfig("wrangler.auth.production.jsonc");
  const maintenance = readConfig("wrangler.auth.source.maintenance.jsonc");

  assert.equal(maintenance.account_id, "c81eb6d12b9be16f800f0bd1fc8a1c8a");
  assert.deepEqual(maintenance.triggers, { crons: [] });
  assert.equal(maintenance.vars.MIGRATION_MAINTENANCE, "true");
  assert.deepEqual(maintenance.services, source.services);
  assert.deepEqual(
    maintenance.d1_databases.map(({ binding, database_id }) => ({ binding, database_id })),
    source.d1_databases.map(({ binding, database_id }) => ({ binding, database_id }))
  );
  assert.doesNotMatch(JSON.stringify(maintenance), /02580fab1c09e144db7da89478e252c8|c5137bcc-0fcc-4822-95b8-996dffaf0818|9d97a0fb-9767-4ef2-9ba2-dcf0bd92774f/);
});
