(function registerAdminV3ManualLineupRenderer(global) {
  "use strict";

  const POSITIONS = Object.freeze(["", "捕", "一", "二", "三", "遊", "左", "中", "右", "指"]);

  function createBlankRows() {
    return Array.from({ length: 9 }, (_, index) => ({
      battingOrder: index + 1,
      position: "",
      playerId: "",
      playerName: "",
      uniformNumber: "",
      search: ""
    }));
  }

  function createAdminV3ManualLineupRenderer({ escapeHtml, formatJst, getFinalizeSafety }) {
    function battingClass(player) {
      if (global.Starting9Public?.getPlayerBattingClass) return global.Starting9Public.getPlayerBattingClass(player);
      const source = player && typeof player === "object" ? player : {};
      const value = source.bats ?? source.battingSide ?? source.batSide
        ?? source.handedness?.bats ?? source.metadata?.bats ?? source.meta?.bats;
      const normalized = String(value ?? "").normalize("NFKC").trim().toLowerCase();
      if (["r", "rh", "right", "右", "右打", "右打ち"].includes(normalized)) return "player-name--bat-right";
      if (["l", "lh", "left", "左", "左打", "左打ち"].includes(normalized)) return "player-name--bat-left";
      if (["s", "switch", "both", "両", "両打", "両打ち", "スイッチ"].includes(normalized)) return "player-name--bat-switch";
      return "";
    }

    function uniformNumber(player) {
      if (global.Starting9Public?.getPlayerUniformNumber) return global.Starting9Public.getPlayerUniformNumber(player);
      const source = player && typeof player === "object" ? player : {};
      const fields = ["uniformNumber", "jerseyNumber", "number", "playerNumber", "backNumber", "uniform_no", "jersey_no"];
      const sources = [source, source.metadata, source.meta, source.rawMetadata, source.raw];
      for (const entry of sources) {
        if (!entry || typeof entry !== "object") continue;
        for (const field of fields) {
          const value = String(entry[field] ?? "").normalize("NFKC").trim();
          if (/^\d{1,3}$/.test(value)) return value;
        }
      }
      return "";
    }

    function playerName(player) {
      const className = battingClass(player);
      const number = uniformNumber(player);
      const numberMarkup = number ? `<span class="player-number" aria-hidden="true">[${escapeHtml(number)}]</span> ` : "";
      return `<span class="player-name${className ? ` ${className}` : ""}">${numberMarkup}${escapeHtml(player?.playerName || "")}</span>`;
    }

    function playerDetailMarkup(player) {
      const detail = global.Starting9Public?.getPlayerDetails?.(player);
      if (!detail) return "";
      const rows = [
        ["背番号", detail.uniformNumber],
        ["登録区分", detail.registrationType],
        ["カテゴリ", detail.category],
        ["生年月日", detail.birthDate],
        ["身長/体重", detail.heightCm && detail.weightKg ? `${detail.heightCm}cm / ${detail.weightKg}kg` : ""],
        ["投打", detail.throwingHand && detail.battingHand ? `${detail.throwingHand}投${detail.battingHand}打` : ""],
        ["備考", detail.note]
      ].filter(([, value]) => String(value || "").trim());
      if (!rows.length) return "";
      return `<details class="player-inline-details"><summary>詳細</summary><dl>${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl></details>`;
    }

    function confirmationKey(row) {
      const playerId = String(row?.playerId || "").trim();
      if (playerId) return `id:${playerId}`;
      const playerName = String(row?.playerName || "").normalize("NFKC").replace(/\s+/g, "").trim();
      return playerName ? `name:${playerName}` : "";
    }

    function renderLineupConfirmation(rows, catalog) {
      const duplicateCounts = new Map();
      rows.forEach((row) => {
        const key = confirmationKey(row);
        if (key) duplicateCounts.set(key, (duplicateCounts.get(key) || 0) + 1);
      });
      const duplicateNames = new Set();
      const markup = rows.map((row, index) => {
        const selected = catalog.find((player) => player.playerId === row?.playerId);
        const displayPlayer = selected || row;
        const hasPlayer = Boolean(String(row?.playerName || "").trim());
        const key = confirmationKey(row);
        const duplicated = Boolean(key && duplicateCounts.get(key) > 1);
        if (duplicated) duplicateNames.add(String(row?.playerName || "選手未入力").trim());
        const playerMarkup = hasPlayer
          ? `${playerName(displayPlayer)}${selected ? playerDetailMarkup(selected) : ""}`
          : `<span class="manual-lineup-confirmation-empty">未入力</span>`;
        const rosterWarning = selected?.manualRosterActive === false ? `<small class="manual-lineup-confirmation-warning">ロースター外（確認要）</small>` : "";
        const duplicateWarning = duplicated ? `<small class="manual-lineup-confirmation-warning">重複</small>` : "";
        return `<li class="manual-lineup-confirmation-row${duplicated ? " is-duplicate" : ""}" data-v3-manual-lineup-confirmation-row><span class="manual-lineup-confirmation-order">${index + 1}番</span><span class="manual-lineup-confirmation-position">${escapeHtml(row?.position || "守備未設定")}</span><div class="manual-lineup-confirmation-player">${playerMarkup}${rosterWarning}${duplicateWarning}</div></li>`;
      }).join("");
      const duplicateNotice = duplicateNames.size
        ? `<p class="manual-lineup-duplicate-warning" data-v3-manual-lineup-duplicate-warning>同じ選手が複数の打順に入力されています: ${escapeHtml([...duplicateNames].join("、"))}</p>`
        : "";
      return `${duplicateNotice}<ol class="manual-lineup-confirmation-list" data-v3-manual-lineup-confirmation>${markup}</ol>`;
    }

    function renderCandidates(catalog, row, index) {
      const players = Array.isArray(catalog) ? catalog : [];
      const search = String(row?.search || "").trim().toLocaleLowerCase();
      const candidates = players.filter((player) => !search
        || `${player.playerName} ${player.uniformNumber}`.toLocaleLowerCase().includes(search)).slice(0, 6);
      const selected = players.find((player) => player.playerId === row?.playerId);
      return candidates.length
        ? candidates.map((player) => `<div class="manual-player-candidate-row"><button type="button" class="manual-lineup-candidate ${selected?.playerId === player.playerId ? "selected" : ""}" data-v3-manual-lineup-player="${escapeHtml(String(index))}" data-v3-manual-lineup-player-id="${escapeHtml(player.playerId)}">${playerName(player)}${player.manualRosterActive === false ? " <small>roster外（確認要）</small>" : ""}</button>${playerDetailMarkup(player)}</div>`).join("")
        : `<span class="muted">候補がありません</span>`;
    }

    function render(game, details, state = {}) {
      const lineupDetails = details?.lineup || {};
      const catalog = Array.isArray(lineupDetails.playerCatalog) ? lineupDetails.playerCatalog : [];
      const rows = Array.isArray(state.rows) && state.rows.length === 9 ? state.rows : createBlankRows();
      const finalizeSafety = typeof getFinalizeSafety === "function" ? getFinalizeSafety(game) : { allowed: true, message: "" };
      const gameDate = String(game?.gameDate || game?.game_date || "").slice(0, 10) || "不明";
      const startAt = typeof formatJst === "function" ? formatJst(game?.startAt || game?.start_time) : String(game?.startAt || game?.start_time || "-");
      const targetMarkup = `<div class="manual-lineup-target" data-v3-manual-lineup-target><strong>正式スタメン確定対象</strong><span>${escapeHtml(gameDate)} / ${escapeHtml(game?.homeTeam || "-")} vs ${escapeHtml(game?.awayTeam || "-")}</span><span>開始 ${escapeHtml(startAt)} JST</span><code>internalGameId: ${escapeHtml(game?.internalGameId || "-")}</code></div>`;
      const lineupSummary = renderLineupConfirmation(rows, catalog);
      const safetyMarkup = finalizeSafety.allowed ? "" : `<p class="manual-lineup-safety-warning" data-v3-manual-lineup-safety-warning>${escapeHtml(finalizeSafety.message)}</p>`;
      const locked = ["scored", "ranked", "published"].includes(String(game?.state?.state || game?.workflowState || "").toLowerCase())
        || ["processing", "scored"].includes(String(lineupDetails.lineupStatus || "").toLowerCase())
        || Boolean(lineupDetails.finalRevision?.isFinal)
        || Boolean(details?.publication?.publication?.publishedAt);
      const cards = rows.map((row, index) => {
        const selected = catalog.find((player) => player.playerId === row.playerId);
        const positionOptions = POSITIONS.map((position) => `<option value="${escapeHtml(position)}" ${row.position === position ? "selected" : ""}>${escapeHtml(position || "守備位置を選択")}</option>`).join("");
        const orderOptions = Array.from({ length: 9 }, (_, order) => order + 1).map((order) => `<option value="${order}" ${Number(row.battingOrder) === order ? "selected" : ""}>${order}番</option>`).join("");
        return `<article class="manual-lineup-card"><div class="manual-lineup-card-heading"><strong>${index + 1}人目</strong><span>${selected ? playerName(selected) : "未選択"}</span>${selected ? playerDetailMarkup(selected) : ""}</div><label>選手を検索<input type="search" value="${escapeHtml(row.search || "")}" placeholder="名前または背番号" data-v3-manual-lineup-search="${index}" ${locked ? "disabled" : ""}></label><div class="manual-lineup-candidates" aria-label="選手候補" data-v3-manual-lineup-candidates="${index}">${renderCandidates(catalog, row, index)}</div><div class="manual-lineup-card-fields"><label>打順<select data-v3-manual-lineup-order="${index}" ${locked ? "disabled" : ""}>${orderOptions}</select></label><label>守備位置<select data-v3-manual-lineup-position="${index}" ${locked ? "disabled" : ""}>${positionOptions}</select></label></div></article>`;
      }).join("");
      const message = state.error ? `<p class="manual-lineup-message error">${escapeHtml(state.error)}</p>` : state.message ? `<p class="manual-lineup-message success">${escapeHtml(state.message)}</p>` : "";
      const disabled = locked || state.loading;
      return `<section class="manual-lineup-editor" data-v3-manual-lineup-editor>${targetMarkup}<div class="manual-lineup-header"><div><h3>Fighters 手動スタメン</h3><p>対象チーム1チーム・9人を選択します。選手名はマスター照合され、未登録名や重複は保存できません。</p></div><span class="manual-lineup-team">${escapeHtml(lineupDetails.managedTeam?.name || "Fighters")}</span></div><div class="manual-lineup-grid">${cards}</div><div class="manual-lineup-confirmation-preview" data-v3-manual-lineup-confirmation-preview><strong>スタメン確認（入力中）</strong>${lineupSummary}</div><label class="manual-lineup-reason">入力理由<textarea rows="2" maxlength="240" placeholder="例: 公式発表を確認" data-v3-manual-lineup-reason ${disabled ? "disabled" : ""}>${escapeHtml(state.reason || "")}</textarea></label><label class="manual-lineup-confirm"><input type="checkbox" data-v3-manual-lineup-confirm ${state.confirmed ? "checked" : ""} ${disabled ? "disabled" : ""}> 入力内容を確認しました</label>${safetyMarkup}<div class="manual-lineup-actions"><button type="button" data-v3-manual-lineup-save ${disabled ? "disabled" : ""}>下書きを保存</button><button type="button" class="primary-button" data-v3-manual-lineup-finalize ${disabled || !state.latestRevision || !finalizeSafety.allowed ? "disabled" : ""}>正式スタメンを確定</button></div>${locked ? `<p class="muted">採点開始後・公開後はスタメンを変更できません。</p>` : `<p class="muted">確定後はスコアjobを手動投入せず、次回の正式V3 Cronが採点へ進めます。</p>`}${message}</section>`;
    }

    return Object.freeze({ createBlankRows, renderCandidates, render });
  }

  global.Starting9AdminV3 = global.Starting9AdminV3 || {};
  global.Starting9AdminV3.createAdminV3ManualLineupRenderer = createAdminV3ManualLineupRenderer;
})(window);
