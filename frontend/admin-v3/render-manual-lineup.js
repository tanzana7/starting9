(function registerAdminV3ManualLineupRenderer(global) {
  "use strict";

  const POSITIONS = Object.freeze(["", "捕", "一", "二", "三", "遊", "左", "中", "右", "指"]);

  function createBlankRows() {
    return Array.from({ length: 9 }, (_, index) => ({ battingOrder: index + 1, position: "", playerId: "", playerName: "", uniformNumber: "", search: "" }));
  }

  function createAdminV3ManualLineupRenderer({ escapeHtml, formatJst, getFinalizeSafety, getGameDayStatus }) {
    function battingClass(player) {
      if (global.Starting9LineupBuilder?.battingClass) return global.Starting9LineupBuilder.battingClass(player);
      if (global.Starting9Public?.getPlayerBattingClass) return global.Starting9Public.getPlayerBattingClass(player);
      const source = player && typeof player === "object" ? player : {};
      const value = source.bats ?? source.battingSide ?? source.batSide ?? source.handedness?.bats ?? source.metadata?.bats ?? source.meta?.bats;
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
      for (const entry of [source, source.metadata, source.meta, source.rawMetadata, source.raw]) {
        if (!entry || typeof entry !== "object") continue;
        for (const field of fields) {
          const value = String(entry[field] ?? "").normalize("NFKC").trim();
          if (/^\d{1,3}$/.test(value)) return value;
        }
      }
      return "";
    }

    function playerName(player) {
      if (global.Starting9LineupBuilder?.renderPlayerName) return global.Starting9LineupBuilder.renderPlayerName(player, escapeHtml);
      const className = battingClass(player);
      const number = uniformNumber(player);
      const numberMarkup = number ? `<span class="player-number" aria-hidden="true">[${escapeHtml(number)}]</span> ` : "";
      return `<span class="player-name${className ? ` ${className}` : ""}">${numberMarkup}${escapeHtml(player?.playerName || "")}</span>`;
    }

    function playerDetailMarkup(player) {
      const detail = global.Starting9Public?.getPlayerDetails?.(player);
      if (!detail) return "";
      const rows = [
        ["背番号", detail.uniformNumber], ["登録区分", detail.registrationType], ["カテゴリ", detail.category], ["生年月日", detail.birthDate],
        ["身長/体重", detail.heightCm && detail.weightKg ? `${detail.heightCm}cm / ${detail.weightKg}kg` : ""],
        ["投打", detail.throwingHand && detail.battingHand ? `${detail.throwingHand}投${detail.battingHand}打` : ""], ["備考", detail.note]
      ].filter(([, value]) => String(value || "").trim());
      if (!rows.length) return "";
      return `<details class="player-inline-details"><summary>詳細</summary><dl>${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl></details>`;
    }

    function playerCategory(player) {
      return String(player?.category || (player?.manualRosterEligible === false ? "投手" : "未分類")).trim();
    }

    function positionCategory(position) {
      if (position === "捕") return "catcher";
      if (["一", "二", "三", "遊"].includes(position)) return "infielder";
      if (["左", "中", "右"].includes(position)) return "outfielder";
      if (position === "指") return "dh";
      return "empty";
    }

    function positionPicker(position, index, disabled) {
      const values = global.Starting9LineupBuilder?.positionValues || POSITIONS;
      const current = String(position || "");
      const menuId = `actual-position-menu-${index}`;
      const options = values.map((value) => {
        const label = value || "?";
        const ariaLabel = value ? `${value}を選択` : "守備位置を未選択にする";
        return `<button type="button" class="position-menu-option${value === current ? " is-current" : ""}" data-v3-manual-lineup-position-option="${index}" data-position="${escapeHtml(value)}" role="menuitem" aria-label="${escapeHtml(ariaLabel)}"${disabled ? " disabled" : ""}>${escapeHtml(label)}</button>`;
      }).join("");
      return `<div class="position-control manual-lineup-position-control"><button type="button" class="position-button is-${positionCategory(current)}" data-v3-manual-lineup-position-button="${index}" aria-label="${index + 1}番の守備位置を選択" aria-haspopup="menu" aria-expanded="false" aria-controls="${menuId}"${disabled ? " disabled" : ""}>${escapeHtml(current || "?")}</button><div id="${menuId}" class="position-menu manual-lineup-position-menu hidden" role="menu">${options}</div></div>`;
    }

    function normalizePlayerName(value) {
      return String(value ?? "").normalize("NFKC").replace(/^\[\d{1,3}\]\s*/, "").replace(/[\s\u3000]/g, "").replace(/[．。]/g, ".").toLowerCase();
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
      if (player?.effectiveRosterStatus === "active" || player?.effectiveRosterStatus === "inactive") {
        return {
          inRoster: true,
          active: player.effectiveRosterActive === true,
          status: player.effectiveRosterStatus
        };
      }
      const entries = manualRosterEntries(manualRoster);
      const byId = new Map(entries.map((entry) => [String(entry?.playerId || entry?.player_id || "").trim(), entry]).filter(([playerId]) => playerId));
      const playerId = String(player?.playerId || "").trim();
      let entry = playerId ? byId.get(playerId) : null;
      if (!entry && (!playerId || byId.size === 0)) {
        const playerNameKey = normalizePlayerName(player?.playerName || player?.name || player?.displayName);
        if (playerNameKey) entry = entries.find((candidate) => normalizePlayerName(candidate?.playerName || candidate?.name || candidate?.displayName) === playerNameKey) || null;
      }
      if (entry) {
        const mode = String(entry.mode || "").trim().toLowerCase();
        const status = String(entry.status || "").trim().toLowerCase();
        if (mode === "auto") {
          const effectiveActive = [
            entry.effectiveActive,
            entry.manualRosterEffectiveActive,
            entry.effectiveRosterActive,
            player?.manualRosterEffectiveActive,
            player?.effectiveRosterActive,
            player?.manualRosterActive
          ].find((value) => typeof value === "boolean");
          if (typeof effectiveActive === "boolean") {
            return { inRoster: true, active: effectiveActive, status: effectiveActive ? "active" : "inactive" };
          }
          const fallbackStatus = String(
            player?.effectiveRosterStatus
              || player?.manualRosterStatus
              || entry.status
              || ""
          ).trim().toLowerCase();
          if (fallbackStatus === "active" || fallbackStatus === "inactive") {
            return { inRoster: true, active: fallbackStatus === "active", status: fallbackStatus };
          }
          // AUTO without an effective roster signal must not promote a player
          // into the active group. Preserve the existing conservative fallback
          // until an effective roster value is available.
          return { inRoster: true, active: false, status: "inactive" };
        }
        const effectiveStatus = mode || status || "active";
        return { inRoster: true, active: effectiveStatus === "active", status: effectiveStatus };
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
        return leftRosterRank - rightRosterRank || numericUniformNumber(left.player) - numericUniformNumber(right.player)
          || String(left.player?.playerName || left.player?.displayName || "").localeCompare(String(right.player?.playerName || right.player?.displayName || ""), "ja") || left.index - right.index;
      }).map(({ player }) => player);
    }

    function sortPlayersByUniformNumber(players) {
      if (global.Starting9LineupBuilder?.sortPlayers) return global.Starting9LineupBuilder.sortPlayers(players);
      return [...players].sort((left, right) => Number.parseInt(String(left?.uniformNumber || ""), 10) - Number.parseInt(String(right?.uniformNumber || ""), 10)
        || String(left?.playerName || "").localeCompare(String(right?.playerName || ""), "ja"));
    }

    function confirmationKey(row) {
      const playerId = String(row?.playerId || "").trim();
      if (playerId) return `id:${playerId}`;
      const name = String(row?.playerName || "").normalize("NFKC").replace(/\s+/g, "").trim();
      return name ? `name:${name}` : "";
    }

    function renderLineupConfirmation(rows, catalog) {
      const duplicateCounts = new Map();
      rows.forEach((row) => { const key = confirmationKey(row); if (key) duplicateCounts.set(key, (duplicateCounts.get(key) || 0) + 1); });
      const duplicateNames = new Set();
      const markup = rows.map((row, index) => {
        const selected = catalog.find((player) => player.playerId === row?.playerId);
        const displayPlayer = selected || row;
        const hasPlayer = Boolean(String(row?.playerName || "").trim());
        const key = confirmationKey(row);
        const duplicated = Boolean(key && duplicateCounts.get(key) > 1);
        if (duplicated) duplicateNames.add(String(row?.playerName || "選手未入力").trim());
        const playerMarkup = hasPlayer ? `${playerName(displayPlayer)}${selected ? playerDetailMarkup(selected) : ""}` : `<span class="manual-lineup-confirmation-empty">未入力</span>`;
        const rosterWarning = selected && (selected.effectiveRosterStatus === "inactive" || (selected.effectiveRosterStatus === undefined && selected.manualRosterActive === false))
          ? `<small class="manual-lineup-confirmation-warning">ロースター外（確認要）</small>` : "";
        const duplicateWarning = duplicated ? `<small class="manual-lineup-confirmation-warning">重複</small>` : "";
        return `<li class="manual-lineup-confirmation-row${duplicated ? " is-duplicate" : ""}" data-v3-manual-lineup-confirmation-row><span class="manual-lineup-confirmation-order">${index + 1}番</span><span class="manual-lineup-confirmation-position">${escapeHtml(row?.position || "守備未設定")}</span><div class="manual-lineup-confirmation-player">${playerMarkup}${rosterWarning}${duplicateWarning}</div></li>`;
      }).join("");
      const duplicateNotice = duplicateNames.size ? `<p class="manual-lineup-duplicate-warning" data-v3-manual-lineup-duplicate-warning>同じ選手が複数の打順に入力されています: ${escapeHtml([...duplicateNames].join("、"))}</p>` : "";
      return `${duplicateNotice}<ol class="manual-lineup-confirmation-list" data-v3-manual-lineup-confirmation>${markup}</ol>`;
    }

    function renderCandidates(catalog, row, index, manualRoster = null, rosterFilter = "all") {
      const players = Array.isArray(catalog) ? catalog : [];
      const search = String(row?.search || "").trim().toLocaleLowerCase();
      const filter = rosterFilter === "inactive" ? "inactive" : rosterFilter === "active" ? "active" : "all";
      const candidates = sortPlayersByRosterAndUniformNumber(players.filter((player) => player?.candidateVisibility !== "hide")
        .filter((player) => global.Starting9LineupBuilder?.isLineupCandidate?.(player) !== false)
        .filter((player) => {
          if (filter === "all") return true;
          return filter === "active" ? playerRosterState(player, manualRoster).active : !playerRosterState(player, manualRoster).active;
        })
        .filter((player) => !search || `${player.playerName} ${player.uniformNumber} ${playerCategory(player)}`.toLocaleLowerCase().includes(search)), manualRoster);
      const selected = players.find((player) => player.playerId === row?.playerId);
      return candidates.length ? candidates.map((player) => {
        const selectedPlayer = selected?.playerId === player.playerId;
        return `<button type="button" class="player-chip manual-lineup-candidate${selectedPlayer ? " selected" : ""}" aria-pressed="${selectedPlayer ? "true" : "false"}" data-picker="actual" data-v3-manual-lineup-player="${escapeHtml(String(index))}" data-v3-manual-lineup-player-id="${escapeHtml(player.playerId)}" draggable="false">${playerName(player)}</button>`;
      }).join("") : `<span class="muted">候補がありません</span>`;
    }

    function manualLineupInteractionState(game, details, state = {}) {
      if (state.loading === true) return { locked: true, loading: true, reason: "スタメン情報を保存中です。完了するまで編集できません。" };
      if (!details || !Object.prototype.hasOwnProperty.call(details, "lineup")) return { locked: true, loading: true, reason: "スタメン情報を読み込み中です。" };
      if (details.lineup?.ok === false) return { locked: true, loading: false, reason: "対象試合のスタメン情報を取得できませんでした。画面を更新してください。" };
      if (["revisions", "publication", "schedule"].some((key) => details[key]?.ok === false)) return { locked: true, loading: false, reason: "試合詳細の取得に失敗したため編集を停止しています。画面を更新してください。" };
      const gameId = String(game?.internalGameId || "");
      const detailGameId = String(details.internalGameId || "");
      if (gameId && detailGameId && gameId !== detailGameId) return { locked: true, loading: false, reason: "対象試合の詳細が一致しないため編集を停止しています。画面を更新してください。" };
      const gameStatus = String(game?.gameStatus || game?.game_status || "").toLowerCase();
      const workflowState = String(game?.state?.state || game?.workflowState || "").toLowerCase();
      if (["cancelled", "canceled", "postponed", "no_game", "service_unavailable", "excluded"].includes(gameStatus) || workflowState === "excluded") return { locked: true, loading: false, reason: "中止・延期または対象外の試合は通常登録できません。" };
      const lineupDetails = details.lineup || {};
      const canonicalFinalLineupExists = details.canonicalFinalLineupExists === true || Boolean(details.canonicalFinalRevisionId)
        || (details.canonicalFinalLineupExists !== false && (lineupDetails.finalRevision?.isFinal === true || details.finalRevision?.isFinal === true));
      if (canonicalFinalLineupExists) return { locked: true, loading: false, reason: "この試合はスタメン確定済みのため編集できません。訂正は「スタメン修正」から行ってください。" };
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
      const targetWarning = dayStatus.isFuture ? "これは未来試合です。正式運用対象ではありません。read-only確認に留めてください。" : dayStatus.isPast ? "これは本日以外の試合です。対象日とinternalGameIdを確認してください。" : dayStatus.key === "unknown" ? "対象日を確認できないため、正式スタメン確定は行わないでください。" : "";
      const mismatchWarning = persistedState !== effectiveState ? `effectiveState: ${effectiveState} / persistedState: ${persistedState}。成果物と状態の不一致を確認してください。` : "";
      const targetMarkup = `<div class="manual-lineup-target${dayStatus.tone === "future" ? " is-future" : dayStatus.tone === "past" ? " is-past" : ""}" data-v3-manual-lineup-target><strong>正式スタメン確定対象</strong><span class="manual-lineup-target-status">${escapeHtml(dayStatus.label || "日付不明")}</span><span>${escapeHtml(game?.gameDate || game?.game_date || "-")} / ${escapeHtml(game?.homeTeam || "-")} vs ${escapeHtml(game?.awayTeam || "-")}</span><span>開始 ${escapeHtml(startAt)} JST</span><span>workflow: persisted ${escapeHtml(persistedState)} / effective ${escapeHtml(effectiveState)}</span><code>internalGameId: ${escapeHtml(game?.internalGameId || "-")}</code>${targetWarning ? `<p class="manual-lineup-target-warning">${escapeHtml(targetWarning)}</p>` : ""}${mismatchWarning ? `<p class="manual-lineup-target-mismatch">${escapeHtml(mismatchWarning)}</p>` : ""}</div>`;
      const interaction = manualLineupInteractionState(game, details, state);
      const locked = interaction.locked;
      const disabled = locked || state.loading === true;
      const activeIndex = Math.max(0, Math.min(rows.length - 1, Number(state.activeIndex) || 0));
      const activeRow = rows[activeIndex] || rows[0];
      const slots = rows.map((row, index) => {
        const selected = catalog.find((player) => player.playerId === row.playerId);
        const slotClass = ["lineup-slot", "manual-lineup-slot", index === activeIndex ? "is-active" : "", selected ? "has-player" : ""].filter(Boolean).join(" ");
        const playerMarkup = selected ? playerName(selected) : "未選択";
        return `<article class="${slotClass}" data-picker="actual" data-v3-manual-lineup-slot="${index}" data-v3-manual-lineup-player-id="${escapeHtml(row.playerId || "")}" aria-current="${index === activeIndex ? "true" : "false"}" draggable="false"><span class="slot-order" aria-label="打順 ${index + 1}番">${index + 1}番</span><div class="manual-lineup-slot-player"><span class="slot-player${selected ? "" : " slot-empty"}">${playerMarkup}</span></div>${positionPicker(row.position, index, disabled)}<button type="button" class="slot-clear" data-v3-manual-lineup-clear="${index}" aria-label="${index + 1}番を空にする"${disabled || !row.playerId ? " disabled" : ""}>×</button></article>`;
      }).join("");
      const rosterFilter = state.candidateRosterFilter === "inactive" ? "inactive" : state.candidateRosterFilter === "active" ? "active" : "all";
      const filterButtons = `<div class="roster-filter manual-lineup-roster-filter" role="group" aria-label="ロースター表示"><button type="button" class="roster-filter-button${rosterFilter === "active" ? " is-selected" : ""}" data-v3-manual-lineup-roster-filter="active" aria-pressed="${rosterFilter === "active" ? "true" : "false"}"${disabled ? " disabled" : ""}>出場候補</button><button type="button" class="roster-filter-button${rosterFilter === "inactive" ? " is-selected" : ""}" data-v3-manual-lineup-roster-filter="inactive" aria-pressed="${rosterFilter === "inactive" ? "true" : "false"}"${disabled ? " disabled" : ""}>その他</button></div>`;
      const playerPanel = `<section class="player-panel manual-lineup-player-panel"><div class="player-list-heading"><div><h3>選手を選択</h3><p class="manual-lineup-player-target">${activeIndex + 1}番に追加</p></div><div class="manual-lineup-player-heading-actions"><button type="button" class="secondary" data-v3-lineup-roster-refresh aria-label="ロースターを再確認">再確認</button><span class="manual-lineup-team">${catalog.length}人</span></div></div>${filterButtons}<label class="manual-lineup-search">選手を検索<input type="search" value="${escapeHtml(activeRow?.search || "")}" placeholder="選手名または背番号" data-v3-manual-lineup-search="${activeIndex}" ${disabled ? "disabled" : ""}></label><div class="player-list manual-lineup-candidates" aria-label="選手候補" data-v3-manual-lineup-candidates="${activeIndex}">${renderCandidates(catalog, activeRow, activeIndex, lineupDetails.manualRoster, rosterFilter)}</div></section>`;
      const builder = `<div class="lineup-builder manual-lineup-builder manual-lineup-grid"><section class="lineup-panel manual-lineup-slots-panel"><div class="player-list-heading"><div><h3>正式スタメン</h3><p>行を選んでから、右の候補をタップします。</p></div><span class="manual-lineup-team">9人</span></div><div class="slot-list manual-lineup-slot-list">${slots}</div></section>${playerPanel}</div>`;
      const confirmation = state.confirmation || {};
      const confirmationForGame = confirmation.internalGameId === String(game?.internalGameId || "") && confirmation.previewed === true;
      const confirmationReady = confirmationForGame && state.confirmed === true && Boolean(confirmation.revisionId) && Boolean(confirmation.lineupFingerprint)
        && String(confirmation.revisionId) === String(state.latestRevision?.revisionId || state.latestRevision?.version || "")
        && String(confirmation.lineupFingerprint) === String(state.latestRevision?.lineupFingerprint || "");
      const interactionNotice = interaction.reason ? `<p class="manual-lineup-lock-notice${interaction.loading ? " loading" : ""}" role="status" data-v3-manual-lineup-lock-reason>${escapeHtml(interaction.reason)}</p>` : "";
      const lineupSummary = renderLineupConfirmation(rows, catalog);
      const previewMarkup = confirmationForGame
        ? `<div class="manual-lineup-confirmation-preview" data-v3-manual-lineup-confirmation-preview><strong>登録内容を確認</strong><span>対象: ${escapeHtml(gameDate)} ${escapeHtml(game?.homeTeam || "-")} vs ${escapeHtml(game?.awayTeam || "-")}</span>${lineupSummary}</div>`
        : `<div class="manual-lineup-confirmation-preview is-draft" data-v3-manual-lineup-confirmation-preview><strong>入力中の下書き</strong><span>「登録内容を確認」を押すまで、正式確定の確認対象にはなりません。</span>${lineupSummary}</div>`;
      const message = state.error ? `<p class="manual-lineup-message error">${escapeHtml(state.error)}</p>` : state.message ? `<p class="manual-lineup-message success">${escapeHtml(state.message)}</p>` : "";
      const revision = state.latestRevision;
      const cancelableSource = ["manual", "manual-revision"].includes(String(revision?.source || ""));
      const cancelMarkup = revision && cancelableSource && dayStatus.isFuture && !details?.publication?.publication?.publishedAt
        ? `<button type="button" class="secondary manual-lineup-cancel" data-v3-manual-lineup-revision-cancel="${escapeHtml(String(revision.revisionId || revision.version || ""))}">このmanual revisionを取消</button><small class="muted">未来のscheduled試合のみ。取消後は正式スタメン未確定に戻ります。</small>` : "";
      const safetyMarkup = finalizeSafety.allowed ? "" : `<p class="manual-lineup-safety-warning" data-v3-manual-lineup-safety-warning>${escapeHtml(finalizeSafety.message)}</p>`;
      return `<section class="manual-lineup-editor${locked ? " is-locked" : ""}" data-v3-manual-lineup-editor data-v3-manual-lineup-interaction="${locked ? "locked" : "editable"}" data-v3-manual-lineup-loading="${interaction.loading ? "true" : "false"}">${targetMarkup}<div class="manual-lineup-header"><div><h3>Fighters 手動スタメン</h3><p>ユーザー予想と同じ操作感で、9人の正式スタメンを組みます。ロースター外は警告のみで、スタメン確定の必須条件ではありません。</p></div><span class="manual-lineup-team">${escapeHtml(lineupDetails.managedTeam?.name || "Fighters")}</span></div>${interactionNotice}${builder}${previewMarkup}${safetyMarkup}<div class="manual-lineup-actions"><button type="button" data-v3-manual-lineup-save data-v3-manual-lineup-preview ${disabled ? "disabled" : ""}>登録内容を確認</button><button type="button" class="primary-button" data-v3-manual-lineup-finalize ${disabled || !confirmationReady || !finalizeSafety.allowed ? "disabled" : ""}>この内容でスタメンを確定</button>${cancelMarkup}</div>${locked ? `<p class="muted">採点開始後・公開後はスタメンを変更できません。</p>` : `<p class="muted">正式確定後はスコアjobを手動投入せず、次回の正式V3 Cronが採点へ進めます。</p>`}${message}</section>`;
    }

    return Object.freeze({ createBlankRows, manualLineupInteractionState, renderCandidates, render, sortPlayersByRosterAndUniformNumber, sortPlayersByUniformNumber });
  }

  global.Starting9AdminV3 = global.Starting9AdminV3 || {};
  global.Starting9AdminV3.createAdminV3ManualLineupRenderer = createAdminV3ManualLineupRenderer;
})(window);
