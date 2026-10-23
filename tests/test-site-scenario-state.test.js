import assert from "node:assert/strict";
import test from "node:test";
import { readScenarioState } from "../tooling/test-site/scenario-state.js";

test("scenario cleanup treats an absent workflow row as the scheduled baseline", () => {
  assert.deepEqual(readScenarioState(null), { rawState: null, effectiveState: "scheduled" });
  assert.deepEqual(readScenarioState({ state: null }), { rawState: null, effectiveState: "scheduled" });
  assert.deepEqual(readScenarioState({ state: "  " }), { rawState: null, effectiveState: "scheduled" });
  assert.deepEqual(readScenarioState({ state: "prediction_closed" }), {
    rawState: "prediction_closed",
    effectiveState: "prediction_closed"
  });
});
