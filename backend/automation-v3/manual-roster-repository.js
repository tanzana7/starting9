const MAX_MANUAL_ROSTER_ENTRIES = 100;
const MAX_NOTE_LENGTH = 240;

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

function normalizeStatus(value) {
  const status = String(value ?? "active").trim().toLowerCase();
  if (!["active", "inactive"].includes(status)) {
    throw manualRosterError("MANUAL_ROSTER_STATUS_INVALID", "ロースター状態はactiveまたはinactiveです。", 400);
  }
  return status;
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
    return { playerId, status: normalizeStatus(entry?.status), note };
  });
}

function rowToEntry(row) {
  return {
    playerId: String(row?.player_id || ""),
    status: String(row?.status || "active"),
    note: String(row?.note || ""),
    rosterSource: String(row?.roster_source || "manual"),
    updatedAt: row?.updated_at || null,
    updatedBy: row?.updated_by || null
  };
}

export function serializeManualRosterRows(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, MAX_MANUAL_ROSTER_ENTRIES).map(rowToEntry);
}

export function prioritizeManualRosterCatalog(catalog, rosterRows = []) {
  if (rosterRows == null) return Array.isArray(catalog) ? catalog.map((player) => ({ ...player, manualRosterStatus: null, manualRosterActive: null, manualRosterNote: "", manualRosterSource: null })) : [];
  if (rosterRows?.schemaAvailable === false) return (Array.isArray(catalog) ? catalog : []).map((player) => ({ ...player, manualRosterStatus: null, manualRosterActive: null, manualRosterNote: "", manualRosterSource: null }));
  const rows = Array.isArray(rosterRows) ? rosterRows : rosterRows?.entries || [];
  const byId = new Map(rows.map((row) => [String(row?.playerId || row?.player_id || "").trim(), row]));
  return (Array.isArray(catalog) ? catalog : []).map((player, index) => {
    const row = byId.get(String(player?.playerId || ""));
    const status = row ? String(row.status || "active").toLowerCase() : null;
    return {
      ...player,
      manualRosterStatus: status,
      manualRosterActive: status === "active",
      manualRosterNote: row?.note || "",
      manualRosterSource: row ? "manual" : null,
      _manualRosterRank: row ? (status === "active" ? 0 : 1) : 2,
      _catalogIndex: index
    };
  }).sort((a, b) => a._manualRosterRank - b._manualRosterRank || a._catalogIndex - b._catalogIndex)
    .map(({ _manualRosterRank, _catalogIndex, ...player }) => player);
}

export async function getManualRoster(db, { teamCode = MANUAL_ROSTER_TEAM.teamCode } = {}) {
  const team = normalizeManualRosterTeam(teamCode);
  try {
    const result = await db.prepare(
      `SELECT team_code, team_id, player_id, status, roster_source, note, updated_at, updated_by
         FROM manual_team_rosters
        WHERE team_code = ?1
        ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, player_id
        LIMIT ${MAX_MANUAL_ROSTER_ENTRIES}`
    ).bind(team.teamCode).all();
    const entries = serializeManualRosterRows(result?.results);
    return {
      schemaAvailable: true,
      team,
      source: "manual",
      entries,
      updatedAt: entries.reduce((latest, entry) => entry.updatedAt > latest ? entry.updatedAt : latest, null),
      updatedBy: entries[0]?.updatedBy || null
    };
  } catch (error) {
    if (/no such table|manual_team_rosters/i.test(String(error?.message || error))) {
      return { schemaAvailable: false, team, source: "manual", entries: [], errorCode: "MANUAL_ROSTER_SCHEMA_UNAVAILABLE" };
    }
    throw error;
  }
}

export async function saveManualRoster(db, { teamCode = MANUAL_ROSTER_TEAM.teamCode, entries, updatedBy, now = new Date(), catalog = [] } = {}) {
  const team = normalizeManualRosterTeam(teamCode);
  const normalized = validateManualRosterEntries(entries, catalog);
  const actor = String(updatedBy || "").trim().slice(0, 160);
  if (!actor) throw manualRosterError("MANUAL_ROSTER_UPDATED_BY_REQUIRED", "更新者を特定できません。", 400);
  const updatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  try {
    const statements = normalized.map((entry) => db.prepare(
      `INSERT INTO manual_team_rosters
         (team_code, team_id, player_id, status, roster_source, note, updated_at, updated_by)
       VALUES (?1, ?2, ?3, ?4, 'manual', ?5, ?6, ?7)
       ON CONFLICT(team_code, player_id) DO UPDATE SET
         team_id = excluded.team_id,
         status = excluded.status,
         roster_source = excluded.roster_source,
         note = excluded.note,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`
    ).bind(team.teamCode, team.teamId, entry.playerId, entry.status, entry.note || null, updatedAt, actor));
    if (statements.length) await db.batch(statements);
    return getManualRoster(db, { teamCode: team.teamCode });
  } catch (error) {
    if (/no such table|manual_team_rosters/i.test(String(error?.message || error))) {
      throw manualRosterError("MANUAL_ROSTER_SCHEMA_UNAVAILABLE", "manual roster schemaが未適用です。", 503);
    }
    throw error;
  }
}

export const MANUAL_ROSTER_LIMITS = Object.freeze({ maxEntries: MAX_MANUAL_ROSTER_ENTRIES, maxNoteLength: MAX_NOTE_LENGTH });
