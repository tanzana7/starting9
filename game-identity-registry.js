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
  now = new Date()
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
  for (const identifier of normalizedIdentifiers) {
    await registerGameIdentifier(db, internalGameId, identifier, now);
  }
  return { status: "resolved", code: "", internalGameId };
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
