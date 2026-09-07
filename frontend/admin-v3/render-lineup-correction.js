(function registerAdminV3LineupCorrectionRenderer(global) {
  "use strict";

  const POSITIONS = Object.freeze(["", "捕", "一", "二", "三", "遊", "左", "中", "右", "指"]);

  function createAdminV3LineupCorrectionRenderer({ escapeHtml, formatJst, renderCandidates }) {
    function value(row, field) {
      return String(row?.[field] ?? "").trim();
    }

    function lineupByOrder(lineup) {
      return new Map((Array.isArray(lineup) ? lineup : []).map((row, index) => [
        Number(row?.battingOrder ?? row?.order) || index + 1,
        row
      ]));
    }

    function playerKey(row) {
      return value(row, "playerId") || `name:${value(row, "playerName").normalize("NFKC").replace(/[\s\u3000]/g, "")}`;
    }

    function diffLineup(original, edited) {
      const before = Array.isArray(original) ? original : [];
      const after = Array.isArray(edited) ? edited : [];
      const beforeByOrder = lineupByOrder(before);
      const afterByOrder = lineupByOrder(after);
      const beforeByPlayer = new Map(before.map((row) => [playerKey(row), row]));
      const changes = [];
      for (let order = 1; order <= 9; order += 1) {
        const oldRow = beforeByOrder.get(order) || {};
        const newRow = afterByOrder.get(order) || {};
        if (playerKey(oldRow) !== playerKey(newRow)) {
          changes.push(`${order}番の選手: ${value(oldRow, "playerName") || "未入力"} → ${value(newRow, "playerName") || "未入力"}`);
        }
        if (value(oldRow, "position") !== value(newRow, "position")) {
          changes.push(`${order}番の守備位置: ${value(oldRow, "position") || "未入力"} → ${value(newRow, "position") || "未入力"}`);
        }
      }
      for (const row of after) {
        const oldRow = beforeByPlayer.get(playerKey(row));
        const oldOrder = Number(oldRow?.battingOrder);
        const newOrder = Number(row?.battingOrder);
        if (oldRow && Number.isInteger(oldOrder) && Number.isInteger(newOrder) && oldOrder !== newOrder) {
          changes.push(`${value(row, "playerName") || "選手"}の打順: ${oldOrder}番 → ${newOrder}番`);
        }
      }
      return [...new Set(changes)];
    }

    function correctionRows(details, state) {
      if (Array.isArray(state?.rows) && state.rows.length === 9) return state.rows;
      const lineup = details?.canonicalRevision?.lineup || [];
      return Array.from({ length: 9 }, (_, index) => {
        const row = lineup.find((item) => Number(item?.battingOrder ?? item?.order) === index + 1) || {};
        return {
          battingOrder: Number(row.battingOrder ?? row.order) || index + 1,
          position: value(row, "position"),
          playerId: value(row, "playerId"),
          playerName: value(row, "playerName") || value(row, "displayName"),
          uniformNumber: value(row, "uniformNumber"),
          search: ""
        };
      });
    }

    function candidateMarkup(catalog, row, index, manualRoster) {
      return String(renderCandidates(catalog, row, index, manualRoster) || "")
        .replaceAll("data-v3-manual-lineup-player=", "data-v3-lineup-correction-player=")
        .replaceAll("data-v3-manual-lineup-player-id=", "data-v3-lineup-correction-player-id=")
        .replaceAll("data-v3-manual-lineup-candidates=", "data-v3-lineup-correction-candidates=");
    }

    function render(state = {}) {
      const games = Array.isArray(state.games) ? state.games : [];
      const selectedGameId = String(state.selectedGameId || "");
      const details = state.details;
      const rows = correctionRows(details, state);
      const catalog = details?.playerCatalog || [];
      const original = details?.canonicalRevision?.lineup || [];
      const edited = rows.map((row) => ({ ...row, battingOrder: Number(row.battingOrder) }));
      const changes = diffLineup(original, edited);
      const target = details?.targetGame || games.find((game) => String(game.internalGameId) === selectedGameId) || null;
      const gameButtons = games.length
        ? games.map((game) => {
          const active = String(game.internalGameId) === selectedGameId;
          return `<button type="button" class="lineup-correction-game${active ? " is-selected" : ""}" data-v3-lineup-correction-game="${escapeHtml(game.internalGameId)}" aria-pressed="${active ? "true" : "false"}"><strong>${escapeHtml(game.gameDate || "不明")}</strong><span>${escapeHtml(game.homeTeam || "-")} vs ${escapeHtml(game.awayTeam || "-")}</span><small>${escapeHtml(game.workflowState || "state不明")} / ${escapeHtml(game.publicationStatus || "未公開")}</small></button>`;
        }).join("")
        : `<p class="muted">canonical final lineupを持つ過去のFighters戦はありません。</p>`;
      const targetMarkup = target ? `<div class="lineup-correction-target"><strong>${escapeHtml(target.gameDate || "不明")} / ${escapeHtml(target.homeTeam || "-")} vs ${escapeHtml(target.awayTeam || "-")}</strong><span>開始: ${escapeHtml(formatJst(target.startAt) || "-")} JST</span><code>internalGameId: ${escapeHtml(target.internalGameId || "-")}</code><span>workflow: ${escapeHtml(target.workflowState || "-")} / scoring: ${escapeHtml(target.scoringStatus || "-")} / publish: ${escapeHtml(target.publicationStatus || "-")} / ranking: ${escapeHtml(target.rankingStatus || "-")}</span></div>` : "";
      if (state.loading && !details) return `<section class="lineup-correction-editor"><h2>スタメン修正</h2><p>過去のcanonical final lineupを読み込み中…</p></section>`;
      const cards = details ? rows.map((row, index) => {
        const positionOptions = POSITIONS.map((position) => `<option value="${escapeHtml(position)}" ${value(row, "position") === position ? "selected" : ""}>${escapeHtml(position || "守備位置を選択")}</option>`).join("");
        const orderOptions = Array.from({ length: 9 }, (_, order) => order + 1).map((order) => `<option value="${order}" ${Number(row.battingOrder) === order ? "selected" : ""}>${order}番</option>`).join("");
        return `<article class="lineup-correction-card"><div class="lineup-correction-card-heading"><strong>${index + 1}人目</strong><span>${escapeHtml(row.playerName || "未選択")}</span></div><label>選手を検索<input type="search" value="${escapeHtml(row.search || "")}" placeholder="名前または背番号" data-v3-lineup-correction-search="${index}"></label><div class="manual-lineup-candidates" aria-label="選手候補" data-v3-lineup-correction-candidates="${index}">${candidateMarkup(catalog, row, index, details.manualRoster)}</div><div class="lineup-correction-card-fields"><label>打順<select data-v3-lineup-correction-order="${index}">${orderOptions}</select></label><label>守備位置<select data-v3-lineup-correction-position="${index}">${positionOptions}</select></label></div></article>`;
      }).join("") : "";
      const diffMarkup = changes.length
        ? `<ul class="lineup-correction-diff">${changes.map((change) => `<li>${escapeHtml(change)}</li>`).join("")}</ul>`
        : `<p class="muted">変更はありません。現在と同じ内容は確定できません。</p>`;
      const message = state.error ? `<p class="manual-lineup-message error">${escapeHtml(state.error)}</p>` : state.message ? `<p class="manual-lineup-message success">${escapeHtml(state.message)}</p>` : "";
      const correctionMarkup = details ? `<div class="lineup-correction-status"><strong>現在の処理状況</strong><span>scoring: ${escapeHtml(details.readOnlyStatuses?.scoringStatus || "-")}</span><span>ranking: ${escapeHtml(details.readOnlyStatuses?.rankingStatus || "-")}</span><span>publish: ${escapeHtml(details.readOnlyStatuses?.publicationStatus || "-")}</span></div><div class="lineup-correction-diff-panel"><strong>変更内容</strong>${diffMarkup}</div><div class="lineup-correction-grid">${cards}</div><label>修正理由<input type="text" maxlength="240" value="${escapeHtml(state.reason || "")}" data-v3-lineup-correction-reason placeholder="1〜240文字"></label><label class="manual-lineup-confirm"><input type="checkbox" data-v3-lineup-correction-confirm ${state.confirmed ? "checked" : ""}> 内容を確認しました</label><p class="lineup-correction-warning">修正を確定すると現在の採点・ランキング・公開状態をいったん再処理待ちに戻し、正式V3 Cronの score → ranking_reflect → publish に引き継ぎます。予想入力データは変更しません。</p><button type="button" class="primary-button" data-v3-lineup-correction-submit ${state.loading || !changes.length ? "disabled" : ""}>修正を確定して再採点</button>${message}` : `<p class="muted">左の試合を選択すると、canonical final lineupと変更前後の比較を表示します。</p>`;
      return `<section class="lineup-correction-editor"><div class="manual-lineup-header"><div><h2>スタメン修正</h2><p>過去または確定済みのFighters戦だけを対象に、canonical final lineupの訂正を正式V3処理へ引き継ぎます。</p></div></div><div class="lineup-correction-layout"><aside class="lineup-correction-games"><h3>修正対象試合</h3>${gameButtons}</aside><div class="lineup-correction-form">${targetMarkup}${correctionMarkup}</div></div></section>`;
    }

    return Object.freeze({ correctionRows, diffLineup, render, renderCandidates: candidateMarkup });
  }

  global.Starting9AdminV3 = global.Starting9AdminV3 || {};
  global.Starting9AdminV3.createAdminV3LineupCorrectionRenderer = createAdminV3LineupCorrectionRenderer;
})(window);
