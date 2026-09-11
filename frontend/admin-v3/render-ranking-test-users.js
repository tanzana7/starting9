(function registerAdminV3RankingTestRenderer(global) {
  "use strict";

  const POSITION_LABELS = Object.freeze({
    0: "DH", 1: "P", 2: "C", 3: "1B", 4: "2B", 5: "3B", 6: "SS", 7: "LF", 8: "CF", 9: "RF"
  });

  function rowsForSlot(state) {
    const preset = state.presets?.[String(state.selectedSlot)];
    const lineup = preset?.lineup;
    return Array.from({ length: 9 }, (_, index) => {
      const item = Array.isArray(lineup) ? lineup[index] : null;
      const definition = preset?.definition?.[index];
      return {
        battingOrder: index + 1,
        uniformNumber: item?.uniformNumber || "",
        position: definition?.positionLabel || POSITION_LABELS[definition?.position] || "",
        playerName: item?.playerName || definition?.playerName || "",
        resolved: Boolean(item?.playerId)
      };
    });
  }

  function createAdminV3RankingTestRenderer({ state, escapeHtml }) {
    function render(game) {
      const current = state.rankingTestUsers;
      const slots = Array.from({ length: 9 }, (_, index) => index + 1);
      const selectedSlot = Number(current.selectedSlot) || 1;
      const rows = current.rows?.length === 9 ? current.rows : rowsForSlot(current);
      const settingOn = current.setting?.includeInPublicRanking === true;
      const globalOn = current.globalSettings?.globalEnabled === true;
      const customName = current.displayNameDraft || "";
      const effectiveName = current.globalSettings?.displayNames?.[String(selectedSlot)] || `S9_TEST_${selectedSlot}`;
      const preset = current.presets?.[String(selectedSlot)] || {};
      const slotButtons = slots.map((slot) => {
        const saved = current.slots?.find((item) => Number(item.slot) === slot);
        const candidate = current.presets?.[String(slot)] || {};
        const score = saved?.score === null || saved?.score === undefined ? "未採点" : `${saved.score}/${saved.maxScore}`;
        const status = candidate.ok ? (saved?.status === "scored" ? score : "固定・未採点") : "要確認";
        const active = Number(current.selectedSlot) === slot;
        return `<button type="button" class="secondary ranking-test-slot${active ? " is-active" : ""}" data-v3-ranking-test-slot="${slot}" aria-pressed="${active ? "true" : "false"}">TEST ${slot}<small>${escapeHtml(status)}</small></button>`;
      }).join("");
      const rowMarkup = rows.map((row, index) => `<tr><th scope="row">${index + 1}</th><td>${escapeHtml(row.uniformNumber || "未解決")}</td><td>${escapeHtml(row.position || "未解決")}</td><td class="ranking-test-resolved">${row.resolved ? escapeHtml(row.playerName) : `未解決: ${escapeHtml(row.playerName || "選手マスター未登録")}`}</td></tr>`).join("");
      const gameLabel = game ? `${game.gameDate || ""} / ${game.homeTeam || "-"} vs ${game.awayTeam || "-"}` : current.internalGameId;
      const status = current.error ? `<p class="ranking-test-message error">${escapeHtml(current.error)}</p>` : current.message ? `<p class="ranking-test-message success">${escapeHtml(current.message)}</p>` : "";
      const presetStatus = preset.ok
        ? "Fighters選手マスターから解決済み。active roster外でも固定予想として採点します。"
        : `要確認: ${preset.error || "固定プリセットを解決できません。"}`;
      return `<section class="v3-panel ranking-test-users-panel"><div class="view-heading"><div><h2>ランキング テストユーザー</h2><p>TEST 1〜9は固定プリセットを使い、正式採点時に自動生成・採点されます。試合ごとの予想入力は不要です。</p></div><code>internalGameId: ${escapeHtml(current.internalGameId || "-")}</code></div><div class="ranking-test-global"><strong>TESTランキング グローバル設定: ${globalOn ? "ON" : "OFF"}</strong><span>ONにすると、固定プリセットを使用する全対象試合を本番ランキングへ表示します。TEST予想やユーザーは作成しません。</span><button type="button" class="${globalOn ? "secondary" : "primary-button"}" data-v3-ranking-test-global ${current.loading ? "disabled" : ""}>${globalOn ? "グローバル表示をOFF" : "グローバル表示をON"}</button></div><div class="ranking-test-warning"><strong>正式データから隔離</strong><span>TESTはusers・通常予想・個人統計・実績・結果履歴・Daily Best Nineには入りません。TESTの解決失敗も正式フローを停止しません。</span></div><div class="ranking-test-slots" role="tablist" aria-label="ランキングテストユーザー">${slotButtons}</div><div class="ranking-test-target"><strong>対象試合</strong><span>${escapeHtml(gameLabel)}</span><span>TEST ${selectedSlot} / ${escapeHtml(effectiveName)}</span></div><div class="ranking-test-name"><label for="rankingTestDisplayName">表示名</label><input id="rankingTestDisplayName" value="${escapeHtml(customName)}" maxlength="16" autocomplete="off" data-v3-ranking-test-name data-v3-ranking-test-name-slot="${selectedSlot}" aria-describedby="rankingTestDisplayNameHint"><span id="rankingTestDisplayNameHint">未設定時は ${escapeHtml(`S9_TEST_${selectedSlot}`)} に戻ります。現在の公開名: ${escapeHtml(effectiveName)}</span><button type="button" class="secondary" data-v3-ranking-test-name-save="${selectedSlot}" ${current.loading ? "disabled" : ""}>表示名を保存</button></div><div class="ranking-test-fixed"><strong>TEST ${selectedSlot} 固定予想</strong><span>${escapeHtml(presetStatus)}</span><span>固定値はコード管理され、表示名変更では内容・score・lineageを変更しません。</span></div><div class="ranking-test-table-wrap"><table class="ranking-test-table"><thead><tr><th>打順</th><th>背番号</th><th>守備</th><th>選手</th></tr></thead><tbody>${rowMarkup}</tbody></table></div><div class="ranking-test-toggle"><strong>この試合の公開ランキング表示: ${settingOn ? "ON" : "OFF"}</strong><span>globalがOFFでも、この試合だけONにすると、固定プリセットの現行revision採点済みTEST行をweekly/monthly/yearlyへ表示します。</span><button type="button" class="${settingOn ? "secondary" : "primary-button"}" data-v3-ranking-test-toggle="${settingOn ? "off" : "on"}" ${current.loading ? "disabled" : ""}>${settingOn ? "公開ランキングから外す" : "この試合のTESTを表示"}</button></div>${status}</section>`;
    }
    return Object.freeze({ render, rowsForSlot });
  }

  global.Starting9AdminV3 = global.Starting9AdminV3 || {};
  global.Starting9AdminV3.createAdminV3RankingTestRenderer = createAdminV3RankingTestRenderer;
})(window);
