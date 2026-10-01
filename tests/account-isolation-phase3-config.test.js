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
const TARGET_AUTH_DB = "c5137bcc-0fcc-4822-95b8-996dffaf0818";
const TARGET_AUDIT_DB = "9d97a0fb-9767-4ef2-9ba2-dcf0bd92774f";

test("account isolation staging config has no Cron and target-only resources", () => {
  const staging = readConfig("wrangler.auth.target.jsonc");

  assert.equal(staging.account_id, TARGET_ACCOUNT);
  assert.equal(Object.hasOwn(staging, "triggers"), false);
  assert.deepEqual(staging.services, [{ binding: "NPB_FETCH_WORKER", service: "starting9-npb-fetch" }]);
  assert.deepEqual(
    staging.d1_databases.map(({ binding, database_id }) => ({ binding, database_id })),
    [
      { binding: "AUTH_DB", database_id: TARGET_AUTH_DB },
      { binding: "AUDIT_DB", database_id: TARGET_AUDIT_DB }
    ]
  );
  assert.doesNotMatch(JSON.stringify(staging), new RegExp(`${SOURCE_AUTH_DB}|${SOURCE_AUDIT_DB}`));
});

test("account isolation cutover config carries the exact source Cron set without source IDs", () => {
  const source = readConfig("wrangler.auth.production.jsonc");
  const cutover = readConfig("wrangler.auth.target.production.jsonc");

  assert.equal(cutover.account_id, TARGET_ACCOUNT);
  assert.deepEqual(cutover.triggers, source.triggers);
  assert.deepEqual(cutover.services, [{ binding: "NPB_FETCH_WORKER", service: "starting9-npb-fetch" }]);
  assert.deepEqual(
    cutover.d1_databases.map(({ binding, database_id }) => ({ binding, database_id })),
    [
      { binding: "AUTH_DB", database_id: TARGET_AUTH_DB },
      { binding: "AUDIT_DB", database_id: TARGET_AUDIT_DB }
    ]
  );
  assert.doesNotMatch(JSON.stringify(cutover), new RegExp(`${SOURCE_AUTH_DB}|${SOURCE_AUDIT_DB}`));
});
