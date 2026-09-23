export const GAME_IDENTIFIER_TYPES = Object.freeze(new Set([
  "descriptive_game_id",
  "legacy_compact_game_id",
  "npb_game_code",
  "source_game_key",
  "static_schedule_game_id"
]));

function createRegistryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeText(value) {
  return String(value || "").normalize("NFKC").trim();
}

function normalizeTeam(value) {
  return normalizeText(value).toLocaleLowerCase("en-US");
}

export function normalizeGameIdentity(game = {}) {
  const gameDate = normalizeText(game.gameDate || game.game_date);
  const startTime = normalizeText(game.startTime || game.start_time || game.startAt || game.start_at);
  const homeTeam = normalizeTeam(game.homeTeam || game.home_team);
  const awayTeam = normalizeTeam(game.awayTeam || game.away_team);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(gameDate) || !startTime || !homeTeam || !awayTeam) {
    throw createRegistryError("INTERNAL_GAME_IDENTITY_INVALID", "内部試合IDの照合に必要な日程情報が不足しています。");
  }
  const start = new Date(startTime);
  if (Number.isNaN(start.getTime())) {
    throw createRegistryError("INTERNAL_GAME_IDENTITY_INVALID", "内部試合IDの照合に必要な開始時刻が不正です。");
  }
  return {
    gameDate,
    startTime: start.toISOString(),
    homeTeam,
    awayTeam,
    gameStatus: normalizeText(game.gameStatus || game.game_status) || "scheduled"
  };
}

export function inferGameIdentifierType(value) {
  const identifier = normalizeText(value);
  if (/^\d{4}-\d{2}-\d{2}-[a-z]{1,2}-[a-z]{1,2}-\d+$/i.test(identifier)) {
    return "legacy_compact_game_id";
  }
  if (/^\d{4}-\d{2}-\d{2}-[a-z]+-[a-z]+-\d{3,4}$/i.test(identifier)) {
    return "descriptive_game_id";
  }
  return "";
}

export function normalizeGameIdentifier(identifier = {}) {
  const provider = normalizeText(identifier.provider).toLocaleLowerCase("en-US");
  const identifierType = normalizeText(identifier.identifierType || identifier.identifier_type);
  const identifierValue = normalizeText(identifier.identifierValue || identifier.identifier_value);
  if (!provider || !GAME_IDENTIFIER_TYPES.has(identifierType) || !identifierValue) {
    throw createRegistryError("GAME_IDENTIFIER_INVALID", "試合識別子が不正です。");
  }
  return { provider, identifierType, identifierValue };
}

export async function resolveGameIdentifier(db, identifier) {
  const normalized = normalizeGameIdentifier(identifier);
  const result = await db.prepare(
    `SELECT internal_game_id
       FROM game_identifiers
      WHERE provider = ?1 AND identifier_type = ?2 AND identifier_value = ?3
      LIMIT 2`
  ).bind(normalized.provider, normalized.identifierType, normalized.identifierValue).all();
  const ids = [...new Set((result.results || []).map((row) => normalizeText(row.internal_game_id)).filter(Boolean))];
  if (ids.length > 1) {
    throw createRegistryError("GAME_IDENTIFIER_AMBIGUOUS", "試合識別子が複数の内部試合IDに紐付いています。");
  }
  return ids[0] || null;
}

export async function resolveInternalGameId(db, identifiers) {
  const resolvedIds = new Set();
  for (const identifier of identifiers || []) {
    const internalGameId = await resolveGameIdentifier(db, identifier);
    if (internalGameId) resolvedIds.add(internalGameId);
  }
  if (resolvedIds.size > 1) {
    throw createRegistryError("INTERNAL_GAME_ID_AMBIGUOUS", "複数の内部試合ID候補が見つかりました。");
  }
  return [...resolvedIds][0] || null;
}

export async function registerGameIdentifier(db, internalGameId, identifier, now = new Date()) {
  const normalizedId = normalizeText(internalGameId);
  if (!normalizedId) throw createRegistryError("INTERNAL_GAME_ID_INVALID", "内部試合IDが不正です。");
  const normalized = normalizeGameIdentifier(identifier);
  const existing = await resolveGameIdentifier(db, normalized);
  if (existing) {
    if (existing !== normalizedId) {
      throw createRegistryError("GAME_IDENTIFIER_CONFLICT", "外部試合識別子が別の内部試合IDに登録済みです。");
    }
    return { registered: false, internalGameId: normalizedId, identifier: normalized };
  }
  const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
  await db.prepare(
    `INSERT INTO game_identifiers
      (internal_game_id, provider, identifier_type, identifier_value, is_primary, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)`
  ).bind(normalizedId, normalized.provider, normalized.identifierType, normalized.identifierValue, timestamp).run();
  return { registered: true, internalGameId: normalizedId, identifier: normalized };
}

async function findGamesByIdentity(db, identity) {
  const result = await db.prepare(
    `SELECT internal_game_id
       FROM games
      WHERE game_date = ?1 AND start_time = ?2 AND home_team = ?3 AND away_team = ?4
      ORDER BY created_at ASC
      LIMIT 2`
  ).bind(identity.gameDate, identity.startTime, identity.homeTeam, identity.awayTeam).all();
  return [...new Set((result.results || []).map((row) => normalizeText(row.internal_game_id)).filter(Boolean))];
}

async function createInternalGame(db, identity, createId, now) {
  const internalGameId = createId();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(internalGameId)) {
    throw createRegistryError("INTERNAL_GAME_ID_GENERATION_FAILED", "内部試合IDをUUIDとして生成できませんでした。");
  }
  const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
  await db.prepare(
    `INSERT INTO games
      (internal_game_id, game_date, start_time, home_team, away_team, game_status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`
  ).bind(internalGameId, identity.gameDate, identity.startTime, identity.homeTeam, identity.awayTeam, identity.gameStatus, timestamp).run();
  return internalGameId;
}

export async function getOrCreateInternalGame(db, {
  game,
  identifiers = [],
  allowCreate = false,
  createId = () => crypto.randomUUID(),
  now = new Date(),
  auditDb = null,
  skipScheduleMutation = false
} = {}) {
  const identity = normalizeGameIdentity(game);
  const normalizedIdentifiers = identifiers.map(normalizeGameIdentifier);
  let internalGameId = await resolveInternalGameId(db, normalizedIdentifiers);
  if (!internalGameId) {
    const candidates = await findGamesByIdentity(db, identity);
    if (candidates.length > 1) {
      return { status: "ambiguous", code: "INTERNAL_GAME_IDENTITY_AMBIGUOUS", internalGameId: null };
    }
    internalGameId = candidates[0] || null;
  }
  if (!internalGameId) {
    if (!allowCreate) return { status: "not_found", code: "INTERNAL_GAME_NOT_FOUND", internalGameId: null };
    internalGameId = await createInternalGame(db, identity, createId, now);
  }
  if (!skipScheduleMutation) {
    await updateGameScheduleMetadata(db, internalGameId, identity, game, now, auditDb);
  }
  for (const identifier of normalizedIdentifiers) {
    await registerGameIdentifier(db, internalGameId, identifier, now);
  }
  return { status: "resolved", code: "", internalGameId };
}

// Keep the schedule row's derived timestamps beside the canonical start time.
// Older environments simply skip columns introduced after the registry.
export async function updateGameScheduleMetadata(db, internalGameId, identity, source = {}, now = new Date(), auditDb = null) {
  let columnsResult;
  try {
    columnsResult = await db.prepare("PRAGMA table_info(games)").bind().all();
  } catch {
    // Older adapters may not expose schema metadata; registry resolution still works.
    return false;
  }
  const columns = new Set((columnsResult.results || []).map((row) => String(row.name || "")));
  const startAt = new Date(identity?.startTime || "");
  if (!internalGameId || Number.isNaN(startAt.getTime())) return false;
  const identityColumns = [
    "npb_game_url",
    "source_schedule_key",
    "npb_identity_status",
    "npb_identity_resolved_at",
    "npb_identity_source"
  ].filter((column) => columns.has(column));
  let currentGame = null;
  if (identityColumns.length || columns.has("npb_game_code")) {
    try {
      const selectColumns = ["npb_game_code", ...identityColumns].filter((column, index, list) => list.indexOf(column) === index);
      currentGame = await db.prepare(
        `SELECT ${selectColumns.join(", ")} FROM games WHERE internal_game_id = ?1 LIMIT 1`
      ).bind(internalGameId).first();
    } catch {
      currentGame = null;
    }
  }
  const isManualOverride = String(currentGame?.npb_identity_status || "") === "manually_overridden";
  const hasSourceGameCode = Object.prototype.hasOwnProperty.call(source || {}, "npbGameCode")
    || Object.prototype.hasOwnProperty.call(source || {}, "gameCode");
  const sourceGameCode = String(source?.npbGameCode ?? source?.gameCode ?? "").trim().toLowerCase();
  const nextGameCode = isManualOverride
    ? (String(currentGame?.npb_game_code || "").trim().toLowerCase() || null)
    : (hasSourceGameCode ? (sourceGameCode || null) : (String(currentGame?.npb_game_code || "").trim().toLowerCase() || null));
  const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
  const fields = [];
  const values = [];
  const add = (column, value) => {
    if (!columns.has(column)) return;
    fields.push(`${column} = ?${values.length + 1}`);
    values.push(value);
  };
  add("game_date", identity.gameDate);
  add("start_time", identity.startTime);
  add("home_team", identity.homeTeam);
  add("away_team", identity.awayTeam);
  add("game_status", identity.gameStatus || "scheduled");
  add("npb_game_code", nextGameCode);
  add("season", /^\d{4}$/.test(String(source?.season || "")) ? Number(source.season) : Number(identity.gameDate.slice(0, 4)));
  add("stadium", String(source?.stadium || source?.venue || "").trim() || null);
  const iso = (offset) => new Date(startAt.getTime() + offset * 60000).toISOString();
  add("roster_fetch_at1", iso(-120));
  add("roster_fetch_at2", iso(-110));
  add("publication_at", iso(10));
  add("updated_by", String(source?.updatedBy || "system").slice(0, 120));
  if (!isManualOverride) {
    add("npb_game_url", String(source?.npbGameUrl || source?.npb_game_url || "").trim() || null);
    add("source_schedule_key", String(source?.sourceScheduleKey || source?.sourceGameKey || "").trim() || null);
    add("npb_identity_status", String(source?.npbIdentityStatus || (nextGameCode ? "resolved" : "unresolved")));
    add("npb_identity_resolved_at", nextGameCode ? String(source?.npbIdentityResolvedAt || timestamp) : null);
    add("npb_identity_source", String(source?.npbIdentitySource || (nextGameCode ? "npb_schedule_sync" : "npb_schedule_unresolved")));
  }
  add("updated_at", timestamp);
  if (!fields.length) return false;
  values.push(internalGameId);
  const updateStatement = db.prepare(`UPDATE games SET ${fields.join(", ")} WHERE internal_game_id = ?${values.length}`).bind(...values);
  const auditColumnsResult = auditDb && identityColumns.length
    ? await auditDb.prepare("PRAGMA table_info(game_automation_v3_audit)").bind().all().catch(() => ({ results: [] }))
    : { results: [] };
  const auditColumns = new Set((auditColumnsResult.results || []).map((row) => String(row.name || "")));
  const canAuditIdentityChange = Boolean(auditDb)
    && !isManualOverride
    && auditColumns.has("event_type")
    && auditColumns.has("previous_npb_game_code")
    && auditColumns.has("next_npb_game_code")
    && auditColumns.has("previous_npb_game_url")
    && auditColumns.has("next_npb_game_url")
    && auditColumns.has("previous_npb_identity_status")
    && auditColumns.has("next_npb_identity_status")
    && auditColumns.has("previous_npb_identity_source")
    && auditColumns.has("next_npb_identity_source");
  if (canAuditIdentityChange) {
    const nextUrl = String(source?.npbGameUrl || source?.npb_game_url || "").trim() || null;
    const nextStatus = String(source?.npbIdentityStatus || (nextGameCode ? "resolved" : "unresolved"));
    const nextSource = String(source?.npbIdentitySource || (nextGameCode ? "npb_schedule_sync" : "npb_schedule_unresolved"));
    const changed = String(currentGame?.npb_game_code || "") !== String(nextGameCode || "")
      || String(currentGame?.npb_game_url || "") !== String(nextUrl || "")
      || String(currentGame?.npb_identity_status || "unresolved") !== nextStatus
      || String(currentGame?.npb_identity_source || "") !== nextSource;
    if (changed) {
      const auditStatement = auditDb.prepare(
        `INSERT INTO game_automation_v3_audit
           (internal_game_id, job_type, event_type, previous_npb_game_code, next_npb_game_code,
            previous_npb_game_url, next_npb_game_url, previous_npb_identity_status,
            next_npb_identity_status, previous_npb_identity_source, next_npb_identity_source,
            occurred_at, source)
         VALUES (?1, 'schedule_identity', 'npb_identity_resolved', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'schedule_sync')`
      ).bind(
        internalGameId,
        currentGame?.npb_game_code || null,
        nextGameCode,
        currentGame?.npb_game_url || null,
        nextUrl,
        currentGame?.npb_identity_status || "unresolved",
        nextStatus,
        currentGame?.npb_identity_source || null,
        nextSource,
        timestamp
      );
      await updateStatement.run();
      try {
        await auditStatement.run();
      } catch {
        // Audit is diagnostic-only; a core schedule update must remain durable
        // even when the separate audit database is unavailable.
      }
      return true;
    }
  }
  await updateStatement.run();
  return true;
}

export function createScheduleGameIdentifiers({ gameId = "", gameCode = "", sourceGameKey = "", staticScheduleGameId = "" } = {}) {
  const identifiers = [];
  const legacyType = inferGameIdentifierType(gameId);
  if (legacyType) identifiers.push({ provider: "starting9", identifierType: legacyType, identifierValue: gameId });
  if (normalizeText(gameCode)) identifiers.push({ provider: "npb", identifierType: "npb_game_code", identifierValue: gameCode });
  if (normalizeText(sourceGameKey)) identifiers.push({ provider: "schedule_worker", identifierType: "source_game_key", identifierValue: sourceGameKey });
  if (normalizeText(staticScheduleGameId)) identifiers.push({ provider: "static_schedule", identifierType: "static_schedule_game_id", identifierValue: staticScheduleGameId });
  return identifiers;
}
