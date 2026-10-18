const scenarioSelect = document.querySelector("#scenario");
const statusElement = document.querySelector("#scenarioStatus");
const applyButton = document.querySelector("#applyScenario");
const resetButton = document.querySelector("#resetScenario");

async function requestScenario(path, body = undefined) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.ok !== true) {
    const error = new Error(result?.error || result?.code || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return result;
}

async function refreshScenarioStatus() {
  try {
    const result = await requestScenario("/api/test/status");
    const game = result.game;
    statusElement.textContent = game
      ? `${game.state || "scheduled"} · ${game.game_date} ${game.start_time}`
      : "試合なし";
  } catch (error) {
    statusElement.textContent = error.status === 401 ? "管理者でログインしてください。" : "状態を取得できません。";
  }
}

async function run(action) {
  applyButton.disabled = true;
  resetButton.disabled = true;
  statusElement.textContent = "処理中…";
  try {
    const result = action === "reset"
      ? await requestScenario("/api/test/reset", {})
      : await requestScenario("/api/test/scenario", { scenario: scenarioSelect.value });
    const game = result.game;
    statusElement.textContent = game
      ? `${result.scenario} · ${game.state || "scheduled"}`
      : "試合なし";
  } catch (error) {
    statusElement.textContent = error.status === 401 ? "管理者でログインしてください。" : "処理に失敗しました。";
  } finally {
    applyButton.disabled = false;
    resetButton.disabled = false;
    await refreshScenarioStatus();
  }
}

applyButton.addEventListener("click", () => run("apply"));
resetButton.addEventListener("click", () => run("reset"));
refreshScenarioStatus();
