import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const designPath = path.join(root, "docs", "v3-manual-game-registration.md");
const draftMigrationPath = path.join(root, "docs", "migrations", "0036_manual_game_registration.sql");

test("manual game registration is documented as a staged, idempotent design", () => {
  const design = fs.readFileSync(designPath, "utf8");
  assert.match(design, /scheduleIdentityKey/);
  assert.match(design, /schedule_identity_locks/);
  assert.match(design, /isPublicCandidate/);
  assert.match(design, /D1 `batch`/);
  assert.match(design, /重複検出SQL/);
  assert.match(design, /POST \/api\/admin\/v3\/schedule\/add-game\/preview/);
  assert.match(design, /STOP/);
});

test("manual game registration draft is kept outside executable migrations", () => {
  const draft = fs.readFileSync(draftMigrationPath, "utf8");
  assert.match(draft, /DESIGN DRAFT ONLY/);
  assert.match(draft, /manual_schedule_operations/);
  assert.match(draft, /schedule_identity_locks/);
  assert.match(draft, /idempotency_key TEXT NOT NULL UNIQUE/);
  assert.match(draft, /registration_status TEXT NOT NULL/);
  assert.match(draft, /is_public_candidate INTEGER NOT NULL/);
  assert.match(draft, /Do not add a unique index to games\.schedule_identity_key/);
  assert.equal(fs.existsSync(path.join(root, "migrations", "0036_manual_game_registration.sql")), false);
});
