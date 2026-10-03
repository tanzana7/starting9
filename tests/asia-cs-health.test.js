import test from "node:test";
import assert from "node:assert/strict";
import worker from "../asia-cs/worker.js";

test("GET /health is D1-independent and returns only service status", async () => {
  const response = await worker.fetch(new Request("https://asia-cs.test/health"), {}, {});

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "starting9-asia-cs-api"
  });
});
