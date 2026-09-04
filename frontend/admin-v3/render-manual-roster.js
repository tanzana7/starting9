(function registerAdminV3ManualRosterRenderer(global) {
  "use strict";

  function createAdminV3ManualRosterRenderer({ escapeHtml }) {
    const escape = escapeHtml || ((value) => String(value ?? ""));
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
      const numberMarkup = number ? `<span class="player-number" aria-hidden="true">[${escape(number)}]</span> ` : "";
      return `<span class="player-name${className ? ` ${className}` : ""}">${numberMarkup}${escape(player?.playerName || player?.displayName || "")}</span>`;
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
      return `<details class="player-inline-details"><summary>詳細</summary><dl>${rows.map(([label, value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join("")}</dl></details>`;
    }
    function catalogFor(state) { return Array.isArray(state?.catalog) ? state.catalog : []; }
    function entriesFor(state) { return Array.isArray(state?.entries) ? state.entries : []; }
    function rosterStats(state) {
      const catalog = catalogFor(state);
      const active = catalog.filter((player) => player.manualRosterActive === true).length;
      const inactive = catalog.filter((player) => player.manualRosterActive === false && player.manualRosterStatus === "inactive").length;
      const categories = new Map();
      catalog.filter((player) => player.manualRosterActive === true).forEach((player) => {
        const category = String(player.category || "").trim();
        if (category) categories.set(category, (categories.get(category) || 0) + 1);
      });
      return { active, inactive, categories };
    }
    function playerFor(state, playerId) {
      return catalogFor(state).find((player) => player.playerId === playerId) || { playerId, playerName: "不明な選手", uniformNumber: "-" };
    }
    function renderCandidates(state) {
      const query = String(state?.search || "").trim().toLowerCase();
      const selected = new Set(entriesFor(state).map((entry) => entry.playerId));
      const candidates = catalogFor(state).filter((player) => {
        const haystack = `${player.playerName} ${player.uniformNumber} ${player.displayName || ""}`.toLowerCase();
        return !query || haystack.includes(query);
      }).slice(0, 12);
      if (!candidates.length) return '<p class="muted">候補がありません。既知の選手名・背番号で検索してください。</p>';
      return candidates.map((player) => `<div class="manual-player-candidate-row"><button type="button" class="manual-roster-candidate${selected.has(player.playerId) ? " selected" : ""}" data-v3-manual-roster-add="${escape(player.playerId)}"${selected.has(player.playerId) ? " disabled" : ""}><strong>${playerName(player)}</strong>${player.manualRosterStatus === "inactive" ? "<small>inactive</small>" : ""}</button>${playerDetailMarkup(player)}</div>`).join("");
    }
    function render(state = {}) {
      const entries = entriesFor(state);
      const stats = rosterStats(state);
      const sourceLabel = state.isManualSaved === true || state.source === "manual" ? "manual保存済み" : "静的初期候補（未保存）";
      const categorySummary = [...stats.categories.entries()].map(([category, count]) => `${category} ${count}人`).join(" / ") || "カテゴリ情報なし";
      const rows = entries.length ? entries.map((entry) => {
        const player = playerFor(state, entry.playerId);
        return `<div class="manual-roster-row" data-v3-manual-roster-entry="${escape(entry.playerId)}"><div><strong>${playerName(player)}</strong>${playerDetailMarkup(player)}<small>ID: ${escape(player.playerId)}</small></div><label>状態<select data-v3-manual-roster-status="${escape(entry.playerId)}"><option value="active"${entry.status === "active" ? " selected" : ""}>active</option><option value="inactive"${entry.status === "inactive" ? " selected" : ""}>inactive</option></select></label><label>メモ<textarea maxlength="240" data-v3-manual-roster-note="${escape(entry.playerId)}">${escape(entry.note || "")}</textarea></label><button type="button" class="secondary" data-v3-manual-roster-remove="${escape(entry.playerId)}">inactiveにする</button></div>`;
      }).join("") : '<p class="muted">まだ登録されていません。候補から選手を追加してください。</p>';
      return `<section class="manual-roster-editor" data-v3-manual-roster><header class="manual-roster-header"><div><h2>Fighters ロースター管理</h2><p>Fighters全体を対象にしたV4半自動βの候補管理です。選択中の試合には依存しません。</p></div><span class="manual-roster-team">manual / Fighters</span></header>${state.schemaAvailable === false ? '<p class="manual-roster-message error">manual roster schemaが未適用です。保存にはmigrationが必要です。</p>' : ""}<div class="manual-roster-notice"><strong>重要:</strong> 正式スタメンの入力・確定は「スタメン」画面で別に行います。ロースターから自動でスタメン確定はされません。manual roster更新はmanual lineupを変更しません。</div><div class="manual-roster-meta"><span>表示元: ${escape(sourceLabel)}</span><span>active: ${stats.active}人 / inactive: ${stats.inactive}人</span><span>${escape(categorySummary)}</span></div><p class="muted">最終更新: ${escape(state.updatedAt || "-")} / 更新者: ${escape(state.updatedBy || "-")}</p><label class="manual-roster-search">選手を検索<input type="search" data-v3-manual-roster-search value="${escape(state.search || "")}" placeholder="選手名または背番号"></label><div class="manual-roster-candidates" data-v3-manual-roster-candidates>${renderCandidates(state)}</div><div class="manual-roster-list"><h3>手動登録済み（${entries.length}人）</h3>${rows}</div><label class="manual-roster-confirm"><input type="checkbox" data-v3-manual-roster-confirm${state.confirmed ? " checked" : ""}> 内容を確認しました（保存で既存行を更新します）</label><div class="manual-roster-actions"><button type="button" data-v3-manual-roster-save${state.loading ? " disabled" : ""}>${state.loading ? "保存中…" : "ロースターを保存"}</button></div>${state.error ? `<p class="manual-roster-message error">${escape(state.error)}</p>` : ""}${state.message ? `<p class="manual-roster-message success">${escape(state.message)}</p>` : ""}<p class="muted">未登録の選手は削除せず、状態をinactiveにして履歴を保持します。更新者・更新時刻・manual sourceを記録します。</p></section>`;
    }
    return Object.freeze({ render, renderCandidates });
  }
  global.Starting9AdminV3 = global.Starting9AdminV3 || {};
  global.Starting9AdminV3.createAdminV3ManualRosterRenderer = createAdminV3ManualRosterRenderer;
})(window);
