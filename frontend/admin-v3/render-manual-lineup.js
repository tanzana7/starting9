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

  function createAdminV3ManualLineupRenderer({ escapeHtml, formatJst, getFinalizeSafety, getGameDayStatus }) {
    function battingClass(player) {
      if (global.Starting9LineupBuilder?.battingClass) return global.Starting9LineupBuilder.battingClass(player);
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
      if (global.Starting9LineupBuilder?.uniformNumber) return global.Starting9LineupBuilder.uniformNumber(player);
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
      if (global.Starting9LineupBuilder?.renderPlayerName) {
        return global.Starting9LineupBuilder.renderPlayerName(player, escapeHtml);
      }
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

    function playerCategory(player) {
      return String(player?.category || (player?.manualRosterEligible === false ? "投手" : "未分類")).trim();
    }

    function sortPlayersByUniformNumber(players) {
      if (global.Starting9LineupBuilder?.sortPlayers) return global.Starting9LineupBuilder.sortPlayers(players);
      return [...players].sort((left, right) => {
        const leftNumber = Number.parseInt(String(left?.uniformNumber || ""), 10);
        const rightNumber = Number.parseInt(String(right?.uniformNumber || ""), 10);
        const leftRank = Number.isFinite(leftNumber) ? leftNumber : Number.POSITIVE_INFINITY;
        const rightRank = Number.isFinite(rightNumber) ? rightNumber : Number.POSITIVE_INFINITY;
        return leftRank - rightRank
          || String(left?.playerName || "").localeCompare(String(right?.playerName || ""), "ja");
      });
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
      const candidates = sortPlayersByUniformNumber(players.filter((player) => !search
        || `${player.playerName} ${player.uniformNumber} ${playerCategory(player)}`.toLocaleLowerCase().includes(search)));
      const selected = players.find((player) => player.playerId === row?.playerId);
      return candidates.length
        ? candidates.map((player) => {
          const selectedPlayer = selected?.playerId === player.playerId;
          const rosterLabel = player.manualRosterActive === false ? "ロースター外（確認要）" : "ロースター内";
          return `<div class="manual-player-candidate-row"><button type="button" class="player-chip manual-lineup-candidate${selectedPlayer ? " selected" : ""}" aria-pressed="${selectedPlayer ? "true" : "false"}" data-v3-manual-lineup-player="${escapeHtml(String(index))}" data-v3-manual-lineup-player-id="${escapeHtml(player.playerId)}">${playerName(player)}<small class="manual-player-candidate-meta">${escapeHtml(playerCategory(player))} / ${escapeHtml(rosterLabel)}</small></button>${playerDetailMarkup(player)}</div>`;
        }).join("")
        : `<span class="muted">候補がありません</span>`;
    }

    function render(game, details, state = {}) {
      const lineupDetails = details?.lineup || {};
      const catalog = Array.isArray(lineupDetails.playerCatalog) ? lineupDetails.playerCatalog : [];
      const rows = Array.isArray(state.rows) && state.rows.length === 9 ? state.rows : createBlankRows();
      const finalizeSafety = typeof getFinalizeSafety === "function" ? getFinalizeSafety(game) : { allowed: true, message: "" };
      const gameDate = String(game?.gameDate || game?.game_date || "").slice(0, 10) || "不明";
      const startAt = typeof formatJst === "function" ? formatJst(game?.startAt || game?.start_time) : String(game?.startAt || game?.start_time || "-");
      const dayStatus = typeof getGameDayStatus === "function" ? getGameDayStatus(game) : { key: "unknown", label: "日付不明", tone: "warning" };
      const persistedState = String(game?.state?.state || game?.workflowState || "scheduled");
      const effectiveState = String(game?.effectiveState || game?.workflowDiagnostics?.effectiveState || persistedState);
      const stateMismatch = persistedState !== effectiveState;
      const targetWarning = dayStatus.isFuture
        ? "これは未来試合です。正式運用対象ではありません。read-only確認に留めてください。"
        : dayStatus.isPast ? "これは本日以外の試合です。対象日とinternalGameIdを確認してください。" : dayStatus.key === "unknown" ? "対象日を確認できないため、正式スタメン確定は行わないでください。" : "";
      const mismatchWarning = stateMismatch ? `effectiveState: ${effectiveState} / persistedState: ${persistedState}。成果物と状態の不一致を確認してください。` : "";
      const targetMarkup = `<div class="manual-lineup-target${dayStatus.tone === "future" ? " is-future" : dayStatus.tone === "past" ? " is-past" : ""}" data-v3-manual-lineup-target><strong>正式スタメン確定対象</strong><span class="manual-lineup-target-status">${escapeHtml(dayStatus.label || "日付不明")}</span><span>${escapeHtml(gameDate)} / ${escapeHtml(game?.homeTeam || "-")} vs ${escapeHtml(game?.awayTeam || "-")}</span><span>開始 ${escapeHtml(startAt)} JST</span><span>workflow: persisted ${escapeHtml(persistedState)} / effective ${escapeHtml(effectiveState)}</span><code>internalGameId: ${escapeHtml(game?.internalGameId || "-")}</code>${targetWarning ? `<p class="manual-lineup-target-warning">${escapeHtml(targetWarning)}</p>` : ""}${mismatchWarning ? `<p class="manual-lineup-target-mismatch">${escapeHtml(mismatchWarning)}</p>` : ""}</div>`;
      const lineupSummary = renderLineupConfirmation(rows, catalog);
      const safetyMarkup = finalizeSafety.allowed ? "" : `<p class="manual-lineup-safety-warning" data-v3-manual-lineup-safety-warning>${escapeHtml(finalizeSafety.message)}</p>`;
      const locked = ["scored", "ranked", "published"].includes(String(game?.state?.state || game?.workflowState || "").toLowerCase())
        || ["processing", "scored"].includes(String(lineupDetails.lineupStatus || "").toLowerCase())
        || Boolean(lineupDetails.finalRevision?.isFinal)
        || Boolean(details?.publication?.publication?.publishedAt);
      const activeIndex = Math.max(0, Math.min(rows.length - 1, Number(state.activeIndex) || 0));
      const activeRow = rows[activeIndex] || rows[0];
      const slots = rows.map((row, index) => {
        const selected = catalog.find((player) => player.playerId === row.playerId);
        const positionOptions = POSITIONS.map((position) => `<option value="${escapeHtml(position)}" ${row.position === position ? "selected" : ""}>${escapeHtml(position || "守備位置を選択")}</option>`).join("");
        const orderOptions = Array.from({ length: 9 }, (_, order) => order + 1).map((order) => `<option value="${order}" ${Number(row.battingOrder) === order ? "selected" : ""}>${order}番</option>`).join("");
        const slotClass = [
          "lineup-slot",
          "manual-lineup-slot",
          index === activeIndex ? "is-active" : "",
          selected ? "has-player" : ""
        ].filter(Boolean).join(" ");
        const playerMarkup = selected
          ? `${playerName(selected)}${playerDetailMarkup(selected)}`
          : '<span class="slot-player slot-empty">未選択</span>';
        return `<article class="${slotClass}" data-v3-manual-lineup-slot="${index}" aria-current="${index === activeIndex ? "true" : "false"}"><span class="slot-order">${index + 1}番</span><div class="manual-lineup-slot-player">${playerMarkup}</div><label class="manual-lineup-slot-order">打順<select data-v3-manual-lineup-order="${index}" ${locked ? "disabled" : ""}>${orderOptions}</select></label><label class="manual-lineup-slot-position">守備位置<select data-v3-manual-lineup-position="${index}" ${locked ? "disabled" : ""}>${positionOptions}</select></label></article>`;
      }).join("");
      const playerPanel = `<section class="player-panel manual-lineup-player-panel"><div class="player-list-heading"><div><h3>選手を選択</h3><p class="manual-lineup-player-target">${activeIndex + 1}番に追加</p></div><span class="manual-lineup-team">${catalog.length}人</span></div><label class="manual-lineup-search">選手を検索<input type="search" value="${escapeHtml(activeRow?.search || "")}" placeholder="選手名または背番号" data-v3-manual-lineup-search="${activeIndex}" ${locked ? "disabled" : ""}></label><div class="player-list manual-lineup-candidates" aria-label="選手候補" data-v3-manual-lineup-candidates="${activeIndex}">${renderCandidates(catalog, activeRow, activeIndex)}</div></section>`;
      const builder = `<div class="lineup-builder manual-lineup-builder manual-lineup-grid"><section class="lineup-panel manual-lineup-slots-panel"><div class="player-list-heading"><div><h3>正式スタメン</h3><p>行を選んでから、右の候補をタップします。</p></div><span class="manual-lineup-team">9人</span></div><div class="slot-list manual-lineup-slot-list">${slots}</div></section>${playerPanel}</div>`;
      const message = state.error ? `<p class="manual-lineup-message error">${escapeHtml(state.error)}</p>` : state.message ? `<p class="manual-lineup-message success">${escapeHtml(state.message)}</p>` : "";
      const disabled = locked || state.loading;
       const revision = state.latestRevision;
       const cancelableSource = ["manual", "manual-revision"].includes(String(revision?.source || ""));
       const futureScheduled = dayStatus.isFuture;
       const cancelMarkup = revision && cancelableSource && futureScheduled && !details?.publication?.publication?.publishedAt
         ? `<button type="button" class="secondary manual-lineup-cancel" data-v3-manual-lineup-revision-cancel="${escapeHtml(String(revision.revisionId || revision.version || ""))}">このmanual revisionを取消</button><small class="muted">未来のscheduled試合のみ。取消後は正式スタメン未確定に戻ります。</small>`
         : "";
       return `<section class="manual-lineup-editor" data-v3-manual-lineup-editor>${targetMarkup}<div class="manual-lineup-header"><div><h3>Fighters 手動スタメン</h3><p>ユーザー予想と同じ操作感で、9人の正式スタメンを組みます。ロースター外は警告のみで、スタメン確定の必須条件ではありません。</p></div><span class="manual-lineup-team">${escapeHtml(lineupDetails.managedTeam?.name || "Fighters")}</span></div>${builder}<div class="manual-lineup-confirmation-preview" data-v3-manual-lineup-confirmation-preview><strong>スタメン確認（入力中）</strong>${lineupSummary}</div><label class="manual-lineup-confirm"><input type="checkbox" data-v3-manual-lineup-confirm ${state.confirmed ? "checked" : ""} ${disabled ? "disabled" : ""}> 入力内容を確認しました</label>${safetyMarkup}<div class="manual-lineup-actions"><button type="button" data-v3-manual-lineup-save ${disabled ? "disabled" : ""}>下書きを保存</button><button type="button" class="primary-button" data-v3-manual-lineup-finalize ${disabled || !state.latestRevision || !finalizeSafety.allowed ? "disabled" : ""}>正式スタメンを確定</button>${cancelMarkup}</div>${locked ? `<p class="muted">採点開始後・公開後はスタメンを変更できません。</p>` : `<p class="muted">確定後はスコアjobを手動投入せず、次回の正式V3 Cronが採点へ進めます。</p>`}${message}</section>`;
    }

    return Object.freeze({ createBlankRows, renderCandidates, render });
  }

  global.Starting9AdminV3 = global.Starting9AdminV3 || {};
  global.Starting9AdminV3.createAdminV3ManualLineupRenderer = createAdminV3ManualLineupRenderer;
})(window);
