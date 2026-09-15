(function registerStarting9LineupBuilder(global) {
  "use strict";

  const publicFrontend = global.Starting9Public || {};
  const NUMBER_FIELDS = Object.freeze(["uniformNumber", "jerseyNumber", "number", "playerNumber", "backNumber", "uniform_no", "jersey_no"]);

  function playerName(player) {
    if (player && typeof player === "object") return player.playerName || player.displayName || player.name || "";
    return String(player || "");
  }

  function playerId(player) {
    return String(player?.playerId || player?.id || "").trim();
  }

  function uniformNumber(player) {
    if (typeof publicFrontend.getPlayerUniformNumber === "function") {
      const known = publicFrontend.getPlayerUniformNumber(player);
      if (known) return known;
    }
    const source = player && typeof player === "object" ? player : {};
    const sources = [source, source.metadata, source.meta, source.rawMetadata, source.raw];
    for (const entry of sources) {
      if (!entry || typeof entry !== "object") continue;
      for (const field of NUMBER_FIELDS) {
        const value = String(entry[field] ?? "").normalize("NFKC").trim();
        if (/^\d{1,3}$/.test(value)) return value;
      }
    }
    return "";
  }

  function battingClass(player) {
    if (typeof publicFrontend.getPlayerBattingClass === "function") return publicFrontend.getPlayerBattingClass(player);
    return "";
  }

  // Candidate visibility is shared so the public prediction picker and the
  // admin official-lineup picker cannot silently drift apart. The server
  // remains the authority for validation; this helper only filters display.
  function isLineupCandidate(player) {
    if (!player || typeof player !== "object") return false;
    if (player.candidateVisibility === "hide") return false;
    if (typeof player.isBatterCandidate === "boolean") return player.isBatterCandidate;
    return true;
  }

  function reorderLineupRows(rows, sourceIndex, targetIndex) {
    const source = Array.isArray(rows) ? rows : [];
    const from = Number(sourceIndex);
    const to = Number(targetIndex);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= source.length || to >= source.length || from === to) {
      return source.slice();
    }
    const next = source.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next.map((row, index) => {
      if (!row || typeof row !== "object") return row;
      const updated = { ...row };
      if (Object.prototype.hasOwnProperty.call(updated, "order")) updated.order = index + 1;
      if (Object.prototype.hasOwnProperty.call(updated, "battingOrder")) updated.battingOrder = index + 1;
      return updated;
    });
  }

  function sortPlayers(players) {
    return [...(Array.isArray(players) ? players : [])].sort((left, right) => {
      const leftActive = left?.manualRosterActive === true || left?.rosterStatus === "active";
      const rightActive = right?.manualRosterActive === true || right?.rosterStatus === "active";
      const activeRank = Number(rightActive) - Number(leftActive);
      if (activeRank) return activeRank;
      const leftNumber = Number.parseInt(uniformNumber(left), 10);
      const rightNumber = Number.parseInt(uniformNumber(right), 10);
      const leftRank = Number.isFinite(leftNumber) ? leftNumber : Number.POSITIVE_INFINITY;
      const rightRank = Number.isFinite(rightNumber) ? rightNumber : Number.POSITIVE_INFINITY;
      return leftRank - rightRank || playerName(left).localeCompare(playerName(right), "ja");
    });
  }

  function escape(value, escapeHtml) {
    return typeof escapeHtml === "function" ? escapeHtml(value) : String(value ?? "");
  }

  function renderPlayerName(player, escapeHtml, baseClass = "player-name") {
    const classNames = [baseClass, battingClass(player)].filter(Boolean).join(" ");
    const number = uniformNumber(player);
    const numberMarkup = number ? `<span class="player-number" aria-hidden="true">[${escape(number, escapeHtml)}]</span> ` : "";
    const displayName = typeof publicFrontend.formatPlayerNameForDisplay === "function"
      ? publicFrontend.formatPlayerNameForDisplay(player)
      : playerName(player);
    return `<span class="${escape(classNames, escapeHtml)}">${numberMarkup}${escape(displayName, escapeHtml)}</span>`;
  }

  global.Starting9LineupBuilder = Object.freeze({
    playerName,
    playerId,
    uniformNumber,
    battingClass,
    isLineupCandidate,
    reorderLineupRows,
    sortPlayers,
    renderPlayerName
  });
})(typeof window !== "undefined" ? window : globalThis);
