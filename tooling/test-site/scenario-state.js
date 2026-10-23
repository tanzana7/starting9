// Test cleanup deletes workflow rows rather than writing a synthetic scheduled
// row. Match the product planner's absent-state fallback while retaining the
// raw value for cleanup diagnostics.
export function readScenarioState(game) {
  const rawState = typeof game?.state === "string" && game.state.trim()
    ? game.state.trim()
    : null;
  return {
    rawState,
    effectiveState: rawState || "scheduled"
  };
}
