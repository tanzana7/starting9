import assert from "node:assert/strict";
import test from "node:test";
import { classifyE2ECleanupResult } from "../tooling/test-site/cleanup-contract.js";

test("cleanup runner accepts only explicit safe outcomes", () => {
  const now = Date.parse("2026-10-22T00:00:00.000Z");
  assert.equal(classifyE2ECleanupResult({ ok: true, removed: true }, now), "deleted");
  assert.equal(classifyE2ECleanupResult({ ok: true, removed: false, retainedAsUser: true }, now), "retained-user");
  assert.equal(classifyE2ECleanupResult({ ok: true, removed: false, alreadyAbsent: true }, now), "already-absent");
  assert.equal(classifyE2ECleanupResult({ ok: true, removed: false,
    replayMarkerRetainedUntil: "2026-10-22T00:01:00.000Z" }, now), "replay-blocked");
  assert.equal(classifyE2ECleanupResult({ ok: true, removed: false,
    replayMarkerRetainedUntil: "not-a-date" }, now), null);
  assert.equal(classifyE2ECleanupResult({ ok: true, removed: false,
    replayMarkerRetainedUntil: "2026-10-21T23:59:59.000Z" }, now), null);
  assert.equal(classifyE2ECleanupResult({ ok: true, removed: true, retainedAsUser: true }, now), null);
  assert.equal(classifyE2ECleanupResult({ ok: false, removed: true }, now), null);
});
