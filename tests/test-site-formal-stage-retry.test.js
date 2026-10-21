import test from "node:test";
import assert from "node:assert/strict";
import {
  FORMAL_JOB_LEASE_RETRY_DELAY_MS,
  fetchReadWith503Retry,
  hasReachedFormalState,
  invokeFormalStageWithLeaseRetry
} from "../tooling/test-site/formal-stage-retry.mjs";

test("formal stage accepts canonical completion after an interrupted request without replaying", async () => {
  let invoked = 0;
  const result = await invokeFormalStageWithLeaseRetry({
    invoke: async () => { invoked += 1; throw Object.assign(new Error("worker limit"), { status: 503 }); },
    readGame: async () => ({ state: "published", publication_status: "published" }),
    expectedState: "scored",
    wait: async () => assert.fail("completed work must not wait for lease expiry")
  });
  assert.equal(invoked, 1);
  assert.equal(result.recoveredAfterWorkerLimit, true);
  assert.equal(result.payload.game.state, "published");
});

test("formal stage uses a caller predicate when the observable game state is already at its prior stage", async () => {
  let invoked = 0;
  const result = await invokeFormalStageWithLeaseRetry({
    invoke: async () => { invoked += 1; throw Object.assign(new Error("worker limit"), { status: 503 }); },
    readGame: async () => ({ state: "scored", failureInjected: true }),
    expectedState: "scored",
    isComplete: (game) => game?.failureInjected === true,
    wait: async () => assert.fail("the retry-state readback proves injection completed")
  });
  assert.equal(invoked, 1);
  assert.equal(result.recoveredAfterWorkerLimit, true);
  assert.equal(result.payload.game.failureInjected, true);
});

test("formal stage waits beyond the claim lease before retrying an incomplete 503", async () => {
  let invoked = 0;
  const waits = [];
  const result = await invokeFormalStageWithLeaseRetry({
    invoke: async () => {
      invoked += 1;
      if (invoked === 1) throw Object.assign(new Error("worker limit"), { status: 503 });
      return { payload: { game: { state: "scored" } } };
    },
    readGame: async () => ({ state: "lineup_ready" }),
    expectedState: "scored",
    wait: async (milliseconds) => waits.push(milliseconds)
  });
  assert.equal(invoked, 2);
  assert.deepEqual(waits, [FORMAL_JOB_LEASE_RETRY_DELAY_MS]);
  assert.equal(result.payload.game.state, "scored");
});

test("formal stage does not retry non-503 errors or exhausted worker failures", async () => {
  let invoked = 0;
  const wait = async () => assert.fail("non-503 errors must not wait");
  await assert.rejects(invokeFormalStageWithLeaseRetry({
    invoke: async () => { invoked += 1; throw Object.assign(new Error("unauthorized"), { status: 401 }); },
    readGame: async () => null,
    expectedState: "scored",
    wait
  }), { status: 401 });
  assert.equal(invoked, 1);

  invoked = 0;
  const leaseWaits = [];
  await assert.rejects(invokeFormalStageWithLeaseRetry({
    invoke: async () => { invoked += 1; throw Object.assign(new Error("worker limit"), { status: 503 }); },
    readGame: async () => ({ state: "lineup_ready" }),
    expectedState: "scored",
    wait: async (milliseconds) => leaseWaits.push(milliseconds),
    maxRetries: 1
  }), { status: 503 });
  assert.equal(invoked, 2);
  assert.deepEqual(leaseWaits, [FORMAL_JOB_LEASE_RETRY_DELAY_MS]);
});

test("formal stage ordering requires a published publication artifact for published", () => {
  assert.equal(hasReachedFormalState({ state: "lineup_ready" }, "prediction_closed"), true);
  assert.equal(hasReachedFormalState({ state: "ranked" }, "scored"), true);
  assert.equal(hasReachedFormalState({ state: "published", publication_status: "pending" }, "published"), false);
  assert.equal(hasReachedFormalState({ state: "published", publication_status: "published" }, "published"), true);
});

test("read-only GET retries transient 503s but stops after its bounded attempts", async () => {
  let calls = 0;
  const waits = [];
  const response = await fetchReadWith503Retry(async () => {
    calls += 1;
    return { status: calls === 1 ? 503 : 200 };
  }, { wait: async (milliseconds) => waits.push(milliseconds) });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1_000]);

  calls = 0;
  const finalResponse = await fetchReadWith503Retry(async () => {
    calls += 1;
    return { status: 503 };
  }, { wait: async () => {}, maxRetries: 2 });
  assert.equal(finalResponse.status, 503);
  assert.equal(calls, 3);
});
