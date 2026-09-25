import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const executor = fs.readFileSync(path.join(root, "backend/automation-v3/executor.js"), "utf8");

test("Cronの観測phaseはdue claimとexecutorを分離して開始・終了を記録する", () => {
  assert.match(executor, /phaseCheckpoint\?\.\("due_claim", "start"/);
  assert.match(executor, /phaseCheckpoint\?\.\("due_claim", "end"/);
  assert.match(executor, /phaseCheckpoint\?\.\("executor", "start"/);
  assert.match(executor, /phaseCheckpoint\?\.\("executor", "end"/);
  assert.match(worker, /phaseCheckpoint: \(phase, state, details\)/);
});

test("cancellationとprobable starterは通常のCron checkpointとして追跡される", () => {
  assert.match(worker, /phaseCheckpoint\.start\("cancellation"/);
  assert.match(executor, /phaseCheckpoint\?\.\("probable_starter", "start"/);
  assert.match(executor, /phaseCheckpoint\?\.\("probable_starter", "end"/);
  assert.match(worker, /phaseCheckpoint\.start\("schedule_sync"/);
  assert.match(worker, /phaseCheckpoint\.start\("maintenance"/);
});

test("version metadata bindingは本番Worker設定に定義される", () => {
  const config = fs.readFileSync(path.join(root, "wrangler.auth.production.jsonc"), "utf8");
  assert.match(config, /"version_metadata"/);
  assert.match(config, /"CF_VERSION_METADATA"/);
});
