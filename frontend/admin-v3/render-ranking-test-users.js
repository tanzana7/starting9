(function registerAdminV3RankingTestRenderer(global) {
  "use strict";

  const POSITION_TO_NUMBER = Object.freeze({ "指": "0", "投": "1", "捕": "2", "一": "3", "二": "4", "三": "5", "遊": "6", "左": "7", "中": "8", "右": "9" });

  function rowsForSlot(state) {
    const selected = (state.slots || []).find((slot) => Number(slot.slot) === Number(state.selectedSlot));
    const lineup = selected?.prediction?.lineup;
    return Array.from({ length: 9 }, (_, index) => {
      const item = Array.isArray(lineup) ? lineup[index] : null;
      return {
        battingOrder: index + 1,
        uniformNumber: item?.uniformNumber || "",
        position: item ? (POSITION_TO_NUMBER[item.position] || "") : "",
        playerName: item?.playerName || ""
      };
    });
  }

  function createAdminV3RankingTestRenderer({ state, escapeHtml }) {
    function render(game) {
      const current = state.rankingTestUsers;
      const slots = Array.from({ length: 9 }, (_, index) => index + 1);
      const rows = current.rows?.length === 9 ? current.rows : rowsForSlot(current);
      const settingOn = current.setting?.includeInPublicRanking === true;
      const slotButtons = slots.map((slot) => {
        const saved = current.slots?.find((item) => Number(item.slot) === slot);
        const active = Number(current.selectedSlot) === slot;
        const score = saved?.score === null || saved?.score === undefined ? "未採点" : `${saved.score}/${saved.maxScore}`;
        return `<button type="button" class="secondary ranking-test-slot${active ? " is-active" : ""}" data-v3-ranking-test-slot="${slot}" aria-pressed="${active ? "true" : "false"}">TEST ${slot}<small>${saved?.prediction ? escapeHtml(score) : "未登録"}</small></button>`;
      }).join("");
      const rowMarkup = rows.map((row, index) => `<tr><th scope="row">${index + 1}</th><td><input inputmode="numeric" pattern="[0-9]{1,3}" maxlength="3" value="${escapeHtml(row.uniformNumber || "")}" data-v3-ranking-test-field="uniformNumber" data-v3-ranking-test-row="${index}" aria-label="TEST ${current.selectedSlot} ${index + 1}番 背番号"></td><td><select data-v3-ranking-test-field="position" data-v3-ranking-test-row="${index}" aria-label="TEST ${current.selectedSlot} ${index + 1}番 守備位置"><option value="">選択</option>${Object.entries(current.positionLabels || { 0: "DH", 1: "投", 2: "捕", 3: "一", 4: "二", 5: "三", 6: "遊", 7: "左", 8: "中", 9: "右" }).map(([value, label]) => `<option value="${value}"${String(row.position) === String(value) ? " selected" : ""}>${value}=${escapeHtml(label)}</option>`).join("")}</select></td><td class="ranking-test-resolved">${row.playerName ? `#${escapeHtml(row.uniformNumber)} ${escapeHtml(row.playerName)}` : "未解決"}</td></tr>`).join("");
      const gameLabel = game ? `${game.gameDate || ""} / ${game.homeTeam || "-"} vs ${game.awayTeam || "-"}` : current.internalGameId;
      const status = current.error ? `<p class="ranking-test-message error">${escapeHtml(current.error)}</p>` : current.message ? `<p class="ranking-test-message success">${escapeHtml(current.message)}</p>` : "";
      return `<section class="v3-panel ranking-test-users-panel"><div class="view-heading"><div><h2>ランキング テストユーザー</h2><p>対象試合ごとにTEST 1〜9を保存し、必要な試合だけ公開期間ランキングへ表示します。</p></div><code>internalGameId: ${escapeHtml(current.internalGameId || "-")}</code></div><div class="ranking-test-warning"><strong>正式データから隔離</strong><span>TESTはusers・通常予想・個人統計・実績・結果履歴・Daily Best Nineには入りません。採点失敗も正式フローを停止しません。</span></div><div class="ranking-test-slots" role="tablist" aria-label="ランキングテストユーザー">${slotButtons}</div><div class="ranking-test-target"><strong>対象試合</strong><span>${escapeHtml(gameLabel)}</span><span>TEST ${current.selectedSlot} / ${escapeHtml(`S9_TEST_${current.selectedSlot}`)}</span></div><p class="muted">守備位置: 0=DH / 1=投 / 2=捕 / 3=一 / 4=二 / 5=三 / 6=遊 / 7=左 / 8=中 / 9=右</p><div class="ranking-test-table-wrap"><table class="ranking-test-table"><thead><tr><th>打順</th><th>背番号</th><th>守備</th><th>解決結果</th></tr></thead><tbody>${rowMarkup}</tbody></table></div><div class="ranking-test-actions"><button type="button" class="primary-button" data-v3-ranking-test-save ${current.loading ? "disabled" : ""}>TEST ${current.selectedSlot}を保存</button><button type="button" class="secondary" data-v3-ranking-test-clear ${current.loading || !current.slots?.find((item) => Number(item.slot) === Number(current.selectedSlot)) ? "disabled" : ""}>このTEST予想をクリア</button></div><div class="ranking-test-toggle"><strong>公開ランキング表示: ${settingOn ? "ON" : "OFF"}</strong><span>ONにすると、この試合の保存済み・現行revision採点済みTEST行だけがweekly/monthly/yearlyへ表示されます。</span><button type="button" class="${settingOn ? "secondary" : "primary-button"}" data-v3-ranking-test-toggle="${settingOn ? "off" : "on"}" ${current.loading ? "disabled" : ""}>${settingOn ? "公開ランキングから外す" : "TESTユーザーを公開ランキングへ表示"}</button></div>${status}</section>`;
    }
    return Object.freeze({ render, rowsForSlot });
  }

  global.Starting9AdminV3 = global.Starting9AdminV3 || {};
  global.Starting9AdminV3.createAdminV3RankingTestRenderer = createAdminV3RankingTestRenderer;
})(window);
