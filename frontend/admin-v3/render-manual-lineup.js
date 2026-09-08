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

    function playerCategory(player) {
      return String(player?.category || (player?.manualRosterEligible === false ? "投手" : "未分類")).trim();
    }

    function normalizePlayerName(value) {
      return String(value ?? "")
        .normalize("NFKC")
        .replace(/^\[\d{1,3}\]\s*/, "")
        .replace(/[\s\u3000]/g, "")
        .replace(/[．。]/g, ".")
        .toLowerCase();
    }

    function manualRosterEntries(manualRoster) {
      if (Array.isArray(manualRoster)) return manualRoster;
      return Array.isArray(manualRoster?.entries) ? manualRoster.entries : [];
    }

    function hasManualRosterData(manualRoster) {
      if (Array.isArray(manualRoster)) return true;
      return Boolean(manualRoster && manualRoster.schemaAvailable !== false && manualRoster.source !== "static-fallback");
    }

    function playerRosterState(player, manualRoster) {
      const entries = manualRosterEntries(manualRoster);
      const byId = new Map(entries
        .map((entry) => [String(entry?.playerId || entry?.player_id || "").trim(), entry])
        .filter(([playerId]) => playerId));
      const playerId = String(player?.playerId || "").trim();
      let entry = playerId ? byId.get(playerId) : null;
      if (!entry && (!playerId || byId.size === 0)) {
        const playerNameKey = normalizePlayerName(player?.playerName || player?.name || player?.displayName);
        if (playerNameKey) {
          entry = entries.find((candidate) => normalizePlayerName(candidate?.playerName || candidate?.name || candidate?.displayName) === playerNameKey) || null;
        }
      }
      if (entry) {
        const status = String(entry.status || "active").trim().toLowerCase();
        return { inRoster: true, active: status === "active", status: status || "inactive" };
      }
      if (hasManualRosterData(manualRoster)) return { inRoster: false, active: false, status: "outside" };

      const catalogStatus = String(player?.manualRosterStatus || "").trim().toLowerCase();
      if (catalogStatus === "active" || player?.manualRosterActive === true) return { inRoster: true, active: true, status: "active" };
      if (catalogStatus === "inactive") return { inRoster: true, active: false, status: "inactive" };
      return { inRoster: false, active: false, status: "outside" };
    }

    function numericUniformNumber(player) {
      const value = String(uniformNumber(player)).normalize("NFKC").trim();
      if (!/^\d+$/.test(value)) return Number.POSITIVE_INFINITY;
      const number = Number(value);
      return Number.isFinite(number) ? number : Number.POSITIVE_INFINITY;
    }

    function sortPlayersByRosterAndUniformNumber(players, manualRoster) {
      return [...players].map((player, index) => ({ player, index, roster: playerRosterState(player, manualRoster) })).sort((left, right) => {
        const leftRosterRank = left.roster.active ? 0 : 1;
        const rightRosterRank = right.roster.active ? 0 : 1;
        return leftRosterRank - rightRosterRank
          || numericUniformNumber(left.player) - numericUniformNumber(right.player)
          || String(left.player?.playerName || left.player?.displayName || "").localeCompare(String(right.player?.playerName || right.player?.displayName || ""), "ja")
          || left.index - right.index;
      }).map(({ player }) => player);
    }

    function playerRosterLabel(roster) {
      if (roster.active) return "ロースター内 / active";
      if (roster.inRoster) return "ロースター内 / inactive（確認要）";
      return "ロースター外（確認要） / 未登録";
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

    function renderCandidates(catalog, row, index, manualRoster = null) {
      const players = Array.isArray(catalog) ? catalog : [];
      const search = String(row?.search || "").trim().toLocaleLowerCase();
      const candidates = sortPlayersByRosterAndUniformNumber(players.filter((player) => !search
        || `${player.playerName} ${player.uniformNumber} ${playerCategory(player)}`.toLocaleLowerCase().includes(search)), manualRoster);
      const selected = players.find((player) => player.playerId === row?.playerId);
      return candidates.length
        ? candidates.map((player) => {
          const selectedPlayer = selected?.playerId === player.playerId;
          const rosterLabel = playerRosterLabel(playerRosterState(player, manualRoster));
          return `<div class="manual-player-candidate-row"><button type="button" class="manual-lineup-candidate${selectedPlayer ? " selected" : ""}" aria-pressed="${selectedPlayer ? "true" : "false"}" data-v3-manual-lineup-player="${escapeHtml(String(index))}" data-v3-manual-lineup-player-id="${escapeHtml(player.playerId)}">${playerName(player)}<small class="manual-player-candidate-meta">${escapeHtml(playerCategory(player))} / ${escapeHtml(rosterLabel)}</small></button>${playerDetailMarkup(player)}</div>`;
        }).join("")
        : `<span class="muted">候補がありません</span>`;
    }

    function manualLineupInteractionState(game, details, state = {}) {
      if (state.loading === true) {
        return { locked: true, loading: true, reason: "スタメン情報を保存中です。完了するまで編集できません。" };
      }
      if (!details || !Object.prototype.hasOwnProperty.call(details, "lineup")) {
        return { locked: true, loading: true, reason: "スタメン情報を読み込み中です。" };
      }
      if (details.lineup?.ok === false) {
        return { locked: true, loading: false, reason: "対象試合のスタメン情報を取得できませんでした。画面を更新してください。" };
      }
      const failedDetail = ["revisions", "publication", "schedule"].find((key) => details[key]?.ok === false);
      if (failedDetail) {
        return { locked: true, loading: false, reason: "試合詳細の取得に失敗したため編集を停止しています。画面を更新してください。" };
      }
      const gameId = String(game?.internalGameId || "");
      const detailGameId = String(details.internalGameId || "");
      if (gameId && detailGameId && gameId !== detailGameId) {
        return { locked: true, loading: false, reason: "対象試合の詳細が一致しないため編集を停止しています。画面を更新してください。" };
      }
      const workflowState = String(game?.state?.state || game?.workflowState || "").toLowerCase();
      const lineupDetails = details.lineup || {};
      const scoringStatus = String(lineupDetails.status || details.lineupStatus || "").toLowerCase();
      const publication = details.publication?.publication || {};
      if (workflowState === "published" || publication.publishedAt || publication.status === "published") {
        return { locked: true, loading: false, reason: "この試合は公開済みのため編集できません。訂正は「スタメン修正」から行ってください。" };
      }
      if (["scored", "ranked"].includes(workflowState) || scoringStatus === "scored") {
        return { locked: true, loading: false, reason: "採点済みのため編集できません。訂正は「スタメン修正」から行ってください。" };
      }
      if (scoringStatus === "processing") {
        return { locked: true, loading: false, reason: "採点処理が開始済みのため編集できません。訂正は「スタメン修正」から行ってください。" };
      }
      if (lineupDetails.finalRevision?.isFinal === true || details.finalRevision?.isFinal === true) {
        return { locked: true, loading: false, reason: "この試合はスタメン確定済みのため編集できません。訂正は「スタメン修正」から行ってください。" };
      }
      return { locked: false, loading: false, reason: "" };
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
      const interaction = manualLineupInteractionState(game, details, state);
      const locked = interaction.locked;
      const disabled = locked || state.loading === true;
      const interactionNotice = interaction.reason
        ? `<p class="manual-lineup-lock-notice${interaction.loading ? " loading" : ""}" role="status" data-v3-manual-lineup-lock-reason>${escapeHtml(interaction.reason)}</p>`
        : "";
      const cards = rows.map((row, index) => {
        const selected = catalog.find((player) => player.playerId === row.playerId);
        const positionOptions = POSITIONS.map((position) => `<option value="${escapeHtml(position)}" ${row.position === position ? "selected" : ""}>${escapeHtml(position || "守備位置を選択")}</option>`).join("");
        return `<article class="manual-lineup-card"><div class="manual-lineup-card-heading"><strong>${index + 1}人目</strong><span>${selected ? playerName(selected) : "未選択"}</span>${selected ? playerDetailMarkup(selected) : ""}</div><label>選手を検索<input type="search" value="${escapeHtml(row.search || "")}" placeholder="名前または背番号" data-v3-manual-lineup-search="${index}" ${locked ? "disabled" : ""}></label><div class="manual-lineup-candidates" aria-label="選手候補" data-v3-manual-lineup-candidates="${index}">${renderCandidates(catalog, row, index, lineupDetails.manualRoster)}</div><div class="manual-lineup-card-fields"><div class="manual-lineup-fixed-order" aria-label="打順 ${index + 1}番"><span>打順</span><strong>${index + 1}番</strong></div><label>守備位置<select data-v3-manual-lineup-position="${index}" ${locked ? "disabled" : ""}>${positionOptions}</select></label></div></article>`;
      }).join("");
      const message = state.error ? `<p class="manual-lineup-message error">${escapeHtml(state.error)}</p>` : state.message ? `<p class="manual-lineup-message success">${escapeHtml(state.message)}</p>` : "";
       const revision = state.latestRevision;
       const cancelableSource = ["manual", "manual-revision"].includes(String(revision?.source || ""));
       const futureScheduled = dayStatus.isFuture;
       const cancelMarkup = revision && cancelableSource && futureScheduled && !details?.publication?.publication?.publishedAt
         ? `<button type="button" class="secondary manual-lineup-cancel" data-v3-manual-lineup-revision-cancel="${escapeHtml(String(revision.revisionId || revision.version || ""))}">このmanual revisionを取消</button><small class="muted">未来のscheduled試合のみ。取消後は正式スタメン未確定に戻ります。</small>`
         : "";
       return `<section class="manual-lineup-editor${locked ? " is-locked" : ""}" data-v3-manual-lineup-editor data-v3-manual-lineup-interaction="${locked ? "locked" : "editable"}" data-v3-manual-lineup-loading="${interaction.loading ? "true" : "false"}">${targetMarkup}<div class="manual-lineup-header"><div><h3>Fighters 手動スタメン</h3><p>対象チーム1チーム・9人を選択します。選手名はマスター照合され、未登録名や重複は保存できません。ロースター外は警告のみで、スタメン確定の必須条件ではありません。</p></div><span class="manual-lineup-team">${escapeHtml(lineupDetails.managedTeam?.name || "Fighters")}</span></div>${interactionNotice}<div class="manual-lineup-grid">${cards}</div><div class="manual-lineup-confirmation-preview" data-v3-manual-lineup-confirmation-preview><strong>スタメン確認（入力中）</strong>${lineupSummary}</div><label class="manual-lineup-confirm"><input type="checkbox" data-v3-manual-lineup-confirm ${state.confirmed ? "checked" : ""} ${disabled ? "disabled" : ""}> 入力内容を確認しました</label>${safetyMarkup}<div class="manual-lineup-actions"><button type="button" data-v3-manual-lineup-save ${disabled ? "disabled" : ""}>下書きを保存</button><button type="button" class="primary-button" data-v3-manual-lineup-finalize ${disabled || !state.latestRevision || !finalizeSafety.allowed ? "disabled" : ""}>正式スタメンを確定</button>${cancelMarkup}</div>${locked ? `<p class="muted">採点開始後・公開後はスタメンを変更できません。</p>` : `<p class="muted">確定後はスコアjobを手動投入せず、次回の正式V3 Cronが採点へ進めます。</p>`}${message}</section>`;
    }

    return Object.freeze({ createBlankRows, manualLineupInteractionState, renderCandidates, render, sortPlayersByRosterAndUniformNumber });
  }

  global.Starting9AdminV3 = global.Starting9AdminV3 || {};
  global.Starting9AdminV3.createAdminV3ManualLineupRenderer = createAdminV3ManualLineupRenderer;
})(window);
