import { normalizeFightersPlayerName } from "../../fighters-player-master.js";

const MAX_MANUAL_ROSTER_ENTRIES = 100;
const MAX_NOTE_LENGTH = 240;
const OFFICIAL_NPB_PLAYER_ID_PATTERN = /^npb:\d{8}$/;
const LIVE_FIELDER_CATEGORIES = new Set(["捕手", "内野手", "外野手"]);
const MANUAL_ROSTER_MODES = new Set(["auto", "active", "inactive"]);

// These are display/selection fallbacks only. They are never persisted until
// an operator explicitly saves a manual roster. Pitchers remain outside the
// fallback so the lineup catalog cannot present them as default batters.
export const STATIC_FIGHTERS_BATTER_CATALOG = Object.freeze([
  { playerName: "日渡騰輝", uniformNumber: "120", playerId: "F-120", category: "捕手" },
  { playerName: "濵田泰希", uniformNumber: "111", playerId: "F-111", category: "内野手" },
  { playerName: "藤田大清", uniformNumber: "125", playerId: "F-125", category: "外野手" },
  { playerName: "山口アタル", uniformNumber: "127", playerId: "F-127", category: "外野手" },
  { playerName: "星野ひので", uniformNumber: "168", playerId: "F-168", category: "外野手" }
]);

export const MANUAL_ROSTER_TEAM = Object.freeze({
  teamCode: "fighters",
  teamId: "F",
  teamName: "北海道日本ハムファイターズ",
  source: "manual"
});

export function manualRosterError(code, message, httpStatus = 400) {
  const error = new Error(message);
  error.code = code;
  error.httpStatus = httpStatus;
  return error;
}

export function normalizeManualRosterTeam(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (["fighters", "f"].includes(raw)) return MANUAL_ROSTER_TEAM;
  throw manualRosterError("MANUAL_ROSTER_TEAM_INVALID", "対応していないチームです。", 400);
}

function normalizeMode(value) {
  const mode = String(value ?? "active").trim().toLowerCase();
  if (!MANUAL_ROSTER_MODES.has(mode)) {
    throw manualRosterError("MANUAL_ROSTER_STATUS_INVALID", "ロースター状態はactive、inactive、またはautoです。", 400);
  }
  return mode;
}

function storedMode(row) {
  const mode = String(row?.mode || "").trim().toLowerCase();
  if (MANUAL_ROSTER_MODES.has(mode)) return mode;
  const legacyStatus = String(row?.status || "").trim().toLowerCase();
  return MANUAL_ROSTER_MODES.has(legacyStatus) ? legacyStatus : "active";
}

export function validateManualRosterEntries(entries, catalog = []) {
  if (!Array.isArray(entries)) {
    throw manualRosterError("MANUAL_ROSTER_ENTRIES_REQUIRED", "ロースター entries が必要です。", 400);
  }
  if (entries.length > MAX_MANUAL_ROSTER_ENTRIES) {
    throw manualRosterError("MANUAL_ROSTER_TOO_MANY_PLAYERS", "ロースター登録数が上限を超えています。", 400);
  }
  const knownIds = new Set((Array.isArray(catalog) ? catalog : []).map((player) => String(player?.playerId || "").trim()).filter(Boolean));
  const seen = new Set();
  return entries.map((entry) => {
    const playerId = String(entry?.playerId ?? entry?.player_id ?? "").trim();
    if (!playerId || !knownIds.has(playerId)) {
      throw manualRosterError("MANUAL_ROSTER_PLAYER_UNKNOWN", "選手カタログにない選手は登録できません。", 400);
    }
    if (seen.has(playerId)) {
      throw manualRosterError("MANUAL_ROSTER_DUPLICATE_PLAYER", "同じ選手を重複登録できません。", 400);
    }
    seen.add(playerId);
    const note = String(entry?.note ?? "").trim();
    if (note.length > MAX_NOTE_LENGTH) {
      throw manualRosterError("MANUAL_ROSTER_NOTE_TOO_LONG", "メモは240文字以内で入力してください。", 400);
    }
    const mode = normalizeMode(entry?.mode ?? entry?.status);
    return { playerId, mode, status: mode, note };
  });
}

function rowToEntry(row) {
  const mode = storedMode(row);
  return {
    playerId: String(row?.player_id || ""),
    mode,
    // status is retained as the legacy API alias. New callers must use mode.
    status: mode,
    note: String(row?.note || ""),
    rosterSource: String(row?.roster_source || "manual"),
    updatedAt: row?.updated_at || null,
    updatedBy: row?.updated_by || null
  };
}

export function serializeManualRosterRows(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, MAX_MANUAL_ROSTER_ENTRIES).map(rowToEntry);
}

export function normalizeManualRosterPlayerName(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/^\[\d{1,3}\]\s*/, "")
    .replace(/[\s\u3000]/g, "")
    .replace(/[．。]/g, ".")
    .toLowerCase();
}

function staticFallbackCatalog(catalog) {
  return (Array.isArray(catalog) ? catalog : []).map((player) => ({
    ...player,
    manualRosterMode: null,
    manualRosterStatus: player.manualRosterEligible === false ? null : "active",
    manualRosterActive: player.manualRosterEligible === false ? false : true,
    // Static fallback is not an official roster observation, so AUTO must not
    // be rendered as currently active merely because the fallback is usable.
    manualRosterEffectiveActive: null,
    manualRosterOfficialActive: null,
    manualRosterNote: "",
    manualRosterSource: player.manualRosterEligible === false ? null : "static-fallback",
    _manualRosterRank: player.manualRosterEligible === false ? 2 : 0,
    _catalogIndex: 0
  })).sort((a, b) => a._manualRosterRank - b._manualRosterRank || a._catalogIndex - b._catalogIndex)
    .map(({ _manualRosterRank, _catalogIndex, ...player }) => player);
}

export function prioritizeManualRosterCatalog(catalog, rosterRows = []) {
  if (rosterRows == null) return Array.isArray(catalog) ? catalog.map((player) => ({ ...player, manualRosterMode: null, manualRosterStatus: null, manualRosterActive: null, manualRosterEffectiveActive: null, manualRosterOfficialActive: null, manualRosterNote: "", manualRosterSource: null })) : [];
  const rows = Array.isArray(rosterRows) ? rosterRows : rosterRows?.entries || [];
  const source = String(rosterRows?.source || "");
  const isManualSaved = rosterRows?.isManualSaved === true || source === "manual";
  if (rosterRows?.schemaAvailable === false || source === "static-fallback" || (!isManualSaved && rows.length === 0)) return staticFallbackCatalog(catalog);
  if (isManualSaved && rows.length === 0) {
    return (Array.isArray(catalog) ? catalog : []).map((player, index) => ({
      ...player,
      manualRosterMode: null,
      manualRosterStatus: "inactive",
      manualRosterActive: false,
      manualRosterEffectiveActive: false,
      manualRosterOfficialActive: null,
      manualRosterNote: "",
      manualRosterSource: null,
      _manualRosterRank: 1,
      _catalogIndex: index
    })).map(({ _manualRosterRank, _catalogIndex, ...player }) => player);
  }
  const byId = new Map(rows.map((row) => [String(row?.playerId || row?.player_id || "").trim(), row]));
  const byName = new Map(rows.map((row) => [normalizeManualRosterPlayerName(row?.playerName || row?.name), row]).filter(([name]) => name));
  return (Array.isArray(catalog) ? catalog : []).map((player, index) => {
    const row = byId.get(String(player?.playerId || ""))
      || byName.get(normalizeManualRosterPlayerName(player?.playerName || player?.name))
      || byName.get(normalizeManualRosterPlayerName(player?.displayName));
    const mode = row ? storedMode(row) : null;
    // A saved roster still excludes players without a persisted row, matching
    // the legacy manual-roster contract. Explicit AUTO is the only persisted
    // row that delegates the effective state to the live official roster.
    const effectiveActive = mode === "active" ? true : mode === "inactive" ? false : null;
    const manualRosterActive = row ? effectiveActive : false;
    return {
      ...player,
      manualRosterMode: mode,
      manualRosterStatus: mode,
      manualRosterActive,
      manualRosterEffectiveActive: effectiveActive,
      manualRosterOfficialActive: null,
      manualRosterNote: row?.note || "",
      manualRosterSource: row ? (mode === "auto" ? "manual-auto" : "manual") : null,
      _manualRosterRank: row
        ? (mode === "active" ? 0 : mode === "auto" ? 1 : 2)
        : 3,
      _catalogIndex: index
    };
  }).sort((a, b) => a._manualRosterRank - b._manualRosterRank || a._catalogIndex - b._catalogIndex)
    .map(({ _manualRosterRank, _catalogIndex, ...player }) => player);
}

function rosterPlayerNumber(player) {
  return String(player?.number ?? player?.uniformNumber ?? player?.jerseyNumber ?? "").trim();
}

function rosterPlayerName(player) {
  return player?.name || player?.playerName || player?.displayName || "";
}

function matchesRosterPlayer(entry, player) {
  const entryNumber = rosterPlayerNumber(entry);
  const playerNumber = String(player?.uniformNumber || "").trim();
  if (entryNumber && playerNumber) return entryNumber === playerNumber;
  const entryName = normalizeManualRosterPlayerName(rosterPlayerName(entry));
  if (!entryName) return false;
  return [player?.playerName, player?.name, player?.displayName, ...(Array.isArray(player?.aliases) ? player.aliases : [])]
    .some((name) => normalizeManualRosterPlayerName(name) === entryName);
}

function findRosterEntry(entries, player) {
  const playerId = String(player?.playerId || "").trim();
  if (playerId) {
    const byId = entries.find((entry) => String(entry?.playerId || entry?.player_id || "").trim() === playerId);
    if (byId) return byId;
  }
  const playerNumber = String(player?.uniformNumber || "").trim();
  if (playerNumber) {
    const byNumber = entries.find((entry) => rosterPlayerNumber(entry) === playerNumber);
    if (byNumber) return byNumber;
  }
  return entries.find((entry) => matchesRosterPlayer(entry, player)) || null;
}

export function normalizeOfficialNpbPlayerId(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return OFFICIAL_NPB_PLAYER_ID_PATTERN.test(normalized) ? normalized : "";
}

function normalizedLiveName(value) {
  return normalizeFightersPlayerName(String(value ?? "").trim());
}

function matchesKnownCatalogPlayer(liveEntry, player) {
  const liveNumber = rosterPlayerNumber(liveEntry);
  const playerNumber = String(player?.uniformNumber || "").trim();
  const liveName = normalizedLiveName(rosterPlayerName(liveEntry));
  const knownNames = [player?.playerName, player?.name, player?.displayName, ...(Array.isArray(player?.aliases) ? player.aliases : [])]
    .map(normalizedLiveName)
    .filter(Boolean);
  // A live row is considered a known master row only when both independently
  // supplied fields agree. This deliberately prevents a new player's number
  // from being mistaken for an existing master identity.
  return Boolean(liveNumber && playerNumber && liveNumber === playerNumber && liveName && knownNames.includes(liveName));
}

function createTemporaryNpbPlayer(liveEntry) {
  const playerId = normalizeOfficialNpbPlayerId(liveEntry?.playerId);
  const name = String(rosterPlayerName(liveEntry) || "").trim();
  const uniformNumber = rosterPlayerNumber(liveEntry);
  const category = String(liveEntry?.position || "").trim();
  if (!playerId || !name || !/^\d{1,3}$/.test(uniformNumber) || !category) return null;
  const isFielder = LIVE_FIELDER_CATEGORIES.has(category);
  const officialPlayerUrl = typeof liveEntry?.officialPlayerUrl === "string"
    && /^https:\/\/npb\.jp\/bis\/players\/\d{8}\.html$/i.test(liveEntry.officialPlayerUrl)
    ? liveEntry.officialPlayerUrl
    : null;
  return {
    playerId,
    playerName: name,
    displayName: name,
    uniformNumber,
    teamCode: MANUAL_ROSTER_TEAM.teamCode,
    teamId: MANUAL_ROSTER_TEAM.teamId,
    category,
    registeredPosition: category,
    candidateVisibility: isFielder ? "auto" : "hide",
    isBatterCandidate: isFielder,
    predictionCandidateRole: isFielder ? "fielder" : "pitcher",
    manualRosterEligible: isFielder,
    isTemporaryCandidate: true,
    identitySource: "npb-live",
    ...(officialPlayerUrl ? { officialPlayerUrl } : {})
  };
}

// The public game-day roster is the current display source. A saved manual
// roster remains an explicit override layer: active/inactive rows are kept as
// operator intent, while players without an override follow the same live or
// snapshot roster used by the public page. This is display/selection state
// only; it never writes the live result into the manual roster table.
export function applyLiveRosterToManualLineupCatalog(catalog, liveRoster, manualRoster = null) {
  const liveEntries = Array.isArray(liveRoster) ? liveRoster : liveRoster?.players;
  if (!Array.isArray(liveEntries) || liveEntries.length === 0) return null;
  const manualEntries = Array.isArray(manualRoster) ? manualRoster : manualRoster?.entries || [];
  const source = String(liveRoster?.sourceOfTruth || liveRoster?.rosterUse || liveRoster?.displayRosterSource || "official_live");
  const baseCatalog = Array.isArray(catalog) ? catalog : [];
  const knownLiveEntries = new Set();
  const resolved = baseCatalog.map((player) => {
    const manualEntry = findRosterEntry(manualEntries, player);
    const liveEntry = liveEntries.find((entry) => matchesKnownCatalogPlayer(entry, player)) || null;
    if (liveEntry) knownLiveEntries.add(liveEntry);
    const mode = manualEntry ? storedMode(manualEntry) : null;
    const officialRosterActive = Boolean(liveEntry);
    const hasManualOverride = mode === "active" || mode === "inactive";
    const effectiveActive = mode === "active"
      ? true
      : mode === "inactive"
        ? false
        : officialRosterActive;
    return {
      ...player,
      manualRosterMode: mode,
      manualRosterStatus: mode,
      manualRosterActive: effectiveActive,
      manualRosterEffectiveActive: effectiveActive,
      manualRosterOfficialActive: officialRosterActive,
      effectiveRosterStatus: effectiveActive ? "active" : "inactive",
      effectiveRosterActive: effectiveActive,
      effectiveRosterSource: hasManualOverride ? "manual-override" : liveEntry ? source : "live-roster-out",
      effectiveRosterMatched: Boolean(liveEntry),
      effectiveRosterUpdatedAt: liveRoster?.capturedAt || liveRoster?.verifiedAt || null
    };
  });

  const existingIds = new Set(baseCatalog.map((player) => String(player?.playerId || "").trim()).filter(Boolean));
  const temporaryPlayers = liveEntries
    .filter((entry) => !knownLiveEntries.has(entry))
    .map(createTemporaryNpbPlayer)
    .filter((player) => player && !existingIds.has(player.playerId));
  const uniqueTemporaryPlayers = [];
  const temporaryIds = new Set();
  temporaryPlayers.forEach((player) => {
    if (!temporaryIds.has(player.playerId)) {
      temporaryIds.add(player.playerId);
      uniqueTemporaryPlayers.push({
        ...player,
        manualRosterMode: null,
        manualRosterStatus: null,
        manualRosterActive: true,
        manualRosterEffectiveActive: true,
        manualRosterOfficialActive: true,
        effectiveRosterStatus: "active",
        effectiveRosterActive: true,
        effectiveRosterSource: source,
        effectiveRosterMatched: true,
        effectiveRosterUpdatedAt: liveRoster?.capturedAt || liveRoster?.verifiedAt || null
      });
    }
  });
  const result = resolved.concat(uniqueTemporaryPlayers);
  Object.defineProperty(result, "unknownOfficialPlayers", {
    value: Object.freeze(uniqueTemporaryPlayers),
    enumerable: false
  });
  return result;
}

// Public candidate selection and admin lineup selection must see the same
// operator override. Keep the official live/snapshot payload as the base and
// only project manual active/inactive rows onto its display players; this does
// not change the formal roster snapshot or any scoring input.
export function applyManualRosterToPublicRoster(roster, manualRoster = null, catalog = []) {
  if (!roster || manualRoster?.isManualSaved !== true || !Array.isArray(roster.players)) return roster;
  const manualEntries = Array.isArray(manualRoster.entries) ? manualRoster.entries : [];
  const baseCatalog = Array.isArray(catalog) ? catalog : [];
  const projectedPlayers = [];
  const seenNumbers = new Set();

  roster.players.forEach((livePlayer) => {
    const catalogPlayer = baseCatalog.find((player) => matchesKnownCatalogPlayer(livePlayer, player)) || null;
    const manualEntry = catalogPlayer ? findRosterEntry(manualEntries, catalogPlayer) : null;
    if (manualEntry && storedMode(manualEntry) === "inactive") return;
    const number = rosterPlayerNumber(livePlayer);
    if (number) seenNumbers.add(number);
    projectedPlayers.push(livePlayer);
  });

  manualEntries
    .filter((entry) => storedMode(entry) === "active")
    .forEach((entry) => {
      const catalogPlayer = baseCatalog.find((player) => String(player?.playerId || "").trim() === String(entry?.playerId || "").trim()) || null;
      if (!catalogPlayer) return;
      const number = String(catalogPlayer.uniformNumber || "").trim();
      if (!number || seenNumbers.has(number)) return;
      seenNumbers.add(number);
      projectedPlayers.push({
        playerId: catalogPlayer.playerId,
        name: catalogPlayer.playerName,
        number,
        position: catalogPlayer.category || ""
      });
    });

  return {
    ...roster,
    players: projectedPlayers,
    playerCount: projectedPlayers.length,
    manualRosterApplied: true,
    manualRosterSource: "manual"
  };
}

export async function getManualRoster(db, { teamCode = MANUAL_ROSTER_TEAM.teamCode } = {}) {
  const team = normalizeManualRosterTeam(teamCode);
  try {
    const result = await db.prepare(
       `SELECT team_code, team_id, player_id, status, mode, roster_source, note, updated_at, updated_by
         FROM manual_team_rosters
        WHERE team_code = ?1
         ORDER BY CASE mode WHEN 'active' THEN 0 WHEN 'auto' THEN 1 ELSE 2 END, player_id
        LIMIT ${MAX_MANUAL_ROSTER_ENTRIES}`
    ).bind(team.teamCode).all();
    const entries = serializeManualRosterRows(result?.results);
    return {
      schemaAvailable: true,
      team,
      source: entries.length ? "manual" : "static-fallback",
      isManualSaved: entries.length > 0,
      entries,
      updatedAt: entries.reduce((latest, entry) => entry.updatedAt > latest ? entry.updatedAt : latest, null),
      updatedBy: entries[0]?.updatedBy || null
    };
  } catch (error) {
    if (/no such table/i.test(String(error?.message || error))) {
      return { schemaAvailable: false, team, source: "static-fallback", isManualSaved: false, entries: [], errorCode: "MANUAL_ROSTER_SCHEMA_UNAVAILABLE" };
    }
    if (/no such column: mode|manual_team_rosters.*mode/i.test(String(error?.message || error))) {
      return { schemaAvailable: false, team, source: "static-fallback", isManualSaved: false, entries: [], errorCode: "MANUAL_ROSTER_MODE_SCHEMA_UNAVAILABLE" };
    }
    throw error;
  }
}

export async function saveManualRoster(db, { teamCode = MANUAL_ROSTER_TEAM.teamCode, entries, updatedBy, now = new Date(), catalog = [] } = {}) {
  const team = normalizeManualRosterTeam(teamCode);
  const normalized = validateManualRosterEntries(entries, catalog);
  // The existing per-player table has no roster header row, so materialize an
  // explicit empty save as inactive eligible players instead of losing the
  // distinction between "saved empty" and "never saved".
  const persistedEntries = normalized.length
    ? normalized
    : (() => {
      const seen = new Set();
      return (Array.isArray(catalog) ? catalog : [])
        .filter((player) => player?.manualRosterEligible !== false)
        .map((player) => String(player?.playerId || "").trim())
        .filter((playerId) => playerId && !seen.has(playerId) && seen.add(playerId))
        .slice(0, MAX_MANUAL_ROSTER_ENTRIES)
        .map((playerId) => ({ playerId, mode: "inactive", status: "inactive", note: "" }));
    })();
  const actor = String(updatedBy || "").trim().slice(0, 160);
  if (!actor) throw manualRosterError("MANUAL_ROSTER_UPDATED_BY_REQUIRED", "更新者を特定できません。", 400);
  const updatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  try {
    const statements = persistedEntries.map((entry) => db.prepare(
      `INSERT INTO manual_team_rosters
         (team_code, team_id, player_id, status, mode, roster_source, note, updated_at, updated_by)
       VALUES (?1, ?2, ?3, ?4, ?5, 'manual', ?6, ?7, ?8)
       ON CONFLICT(team_code, player_id) DO UPDATE SET
         team_id = excluded.team_id,
         status = CASE
           WHEN excluded.mode = 'auto' THEN manual_team_rosters.status
           ELSE excluded.status
         END,
         mode = excluded.mode,
         roster_source = excluded.roster_source,
         note = excluded.note,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`
    ).bind(
      team.teamCode,
      team.teamId,
      entry.playerId,
      entry.mode === "auto" ? "inactive" : entry.mode,
      entry.mode,
      entry.note || null,
      updatedAt,
      actor
    ));
    if (statements.length) await db.batch(statements);
    return getManualRoster(db, { teamCode: team.teamCode });
  } catch (error) {
    if (/no such table/i.test(String(error?.message || error))) {
      throw manualRosterError("MANUAL_ROSTER_SCHEMA_UNAVAILABLE", "manual roster schemaが未適用です。", 503);
    }
    if (/no such column: mode|manual_team_rosters.*mode/i.test(String(error?.message || error))) {
      throw manualRosterError("MANUAL_ROSTER_MODE_SCHEMA_UNAVAILABLE", "manual roster mode schemaが未適用です。", 503);
    }
    throw error;
  }
}

export const MANUAL_ROSTER_LIMITS = Object.freeze({ maxEntries: MAX_MANUAL_ROSTER_ENTRIES, maxNoteLength: MAX_NOTE_LENGTH });
