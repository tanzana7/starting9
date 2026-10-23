(() => {
  const gameSelect = document.querySelector("#editor-game");
  const form = document.querySelector("#lineup-editor-form");
  const message = document.querySelector("#editor-message");
  const metadata = document.querySelector("#editor-game-meta");
  if (!gameSelect || !form || !message || !metadata) return;

  const labels = { away: "ビジター", home: "ホーム" };
  let currentGame = null;
  let busy = false;

  function setMessage(text, kind = "") {
    message.textContent = text;
    message.dataset.kind = kind;
  }

  function apiPath(gameCode) {
    return `/simu-npb/api/lineups/${encodeURIComponent(gameCode)}`;
  }

  function refreshDuplicateOptions(side) {
    const selects = [...form.querySelectorAll(`[data-editor-side="${side}"] select`)];
    const values = selects.map((select) => select.value);
    selects.forEach((select, index) => {
      const usedElsewhere = new Set(values.filter((value, otherIndex) => value && otherIndex !== index));
      for (const option of select.options) {
        option.disabled = Boolean(option.value && usedElsewhere.has(option.value));
      }
    });
  }

  function makeSlot(side, row, roster) {
    const wrapper = document.createElement("label");
    wrapper.className = "lineup-slot";
    const order = document.createElement("span");
    order.textContent = `${row.order}番`;
    const select = document.createElement("select");
    select.required = true;
    select.dataset.order = String(row.order);
    select.setAttribute("aria-label", `${labels[side]} ${row.order}番`);
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "選手を選択";
    select.append(empty);
    for (const player of roster) {
      const option = document.createElement("option");
      option.value = player.playerId;
      option.textContent = `#${player.number} ${player.name}`;
      select.append(option);
    }
    select.value = row.playerId || "";
    select.addEventListener("change", () => refreshDuplicateOptions(side));
    wrapper.append(order, select);
    return wrapper;
  }

  function renderSide(side, team) {
    const panel = form.querySelector(`[data-editor-side="${side}"]`);
    const heading = panel.querySelector("h2");
    heading.textContent = `${labels[side]} · ${team.name}`;
    const slots = panel.querySelector(".lineup-slots");
    slots.replaceChildren(...team.lineup.map((row) => makeSlot(side, row, team.roster)));
    refreshDuplicateOptions(side);
  }

  async function loadGame() {
    const gameCode = gameSelect.value;
    if (!gameCode) return;
    busy = true;
    gameSelect.disabled = true;
    form.querySelector("#save-lineup").disabled = true;
    setMessage("");
    try {
      const response = await fetch(apiPath(gameCode), { credentials: "same-origin", cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok !== true || !payload.game) throw new Error(payload?.code || "LOAD_FAILED");
      currentGame = payload.game;
      metadata.textContent = `${currentGame.gameDate} · ${currentGame.startAt.slice(11, 16)}`;
      renderSide("away", currentGame.away);
      renderSide("home", currentGame.home);
      form.querySelector("#save-lineup").disabled = false;
    } catch {
      currentGame = null;
      metadata.textContent = "";
      form.querySelector("#save-lineup").disabled = true;
      setMessage("試合データを読み込めませんでした。再読み込みしてください。", "error");
    } finally {
      busy = false;
      gameSelect.disabled = false;
    }
  }

  function collectLineup(side) {
    const selects = [...form.querySelectorAll(`[data-editor-side="${side}"] select`)];
    if (selects.length !== 9 || selects.some((select) => !select.value)) {
      const empty = selects.find((select) => !select.value);
      return { ok: false, message: `${empty?.dataset.order || "?"}番の選手を選択してください。` };
    }
    const players = selects.map((select) => select.value);
    if (new Set(players).size !== 9) return { ok: false, message: `${labels[side]}に同じ選手が複数選択されています。` };
    return { ok: true, lineup: selects.map((select) => ({ order: Number(select.dataset.order), playerId: select.value })) };
  }

  gameSelect.addEventListener("change", loadGame);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !currentGame) return;
    const away = collectLineup("away");
    const home = collectLineup("home");
    if (!away.ok || !home.ok) {
      setMessage(!away.ok ? away.message : home.message, "error");
      return;
    }
    busy = true;
    gameSelect.disabled = true;
    const saveButton = form.querySelector("#save-lineup");
    saveButton.disabled = true;
    setMessage("保存中…");
    try {
      const response = await fetch(apiPath(currentGame.providerGameId), {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Simu-NPB-Write": "1" },
        body: JSON.stringify({ providerGameId: currentGame.providerGameId, awayLineup: away.lineup, homeLineup: home.lineup })
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok !== true || !payload.game) {
        const messages = {
          ADMIN_REQUIRED: "Starting9 Test Siteにログインしてください。",
          ADMIN_ROLE_REQUIRED: "管理者権限が必要です。",
          TEST_AUTH_UNAVAILABLE: "認証を確認できません。時間をおいて再試行してください。",
          SIMULATOR_STATE_UNAVAILABLE: "保存先を利用できません。時間をおいて再試行してください。",
          SAME_ORIGIN_REQUIRED: "ページを再読み込みして再試行してください。",
          DUPLICATE_PLAYER: "同じ選手を複数の打順に設定できません。",
          PLAYER_NOT_ON_TEAM: "自球団の選手を選択してください。",
          LINEUP_INCOMPLETE: "1〜9番の選手をすべて設定してください。"
        };
        if (["DUPLICATE_PLAYER", "PLAYER_NOT_ON_TEAM", "LINEUP_INCOMPLETE"].includes(payload?.code)) {
          throw new Error(messages[payload.code]);
        }
        throw new Error(messages[payload?.code] || "保存できませんでした。再試行してください。");
      }
      currentGame = payload.game;
      renderSide("away", currentGame.away);
      renderSide("home", currentGame.home);
      setMessage("スタメンを保存しました", "success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存できませんでした。再試行してください。", "error");
    } finally {
      busy = false;
      gameSelect.disabled = false;
      saveButton.disabled = false;
    }
  });

  loadGame();
})();
