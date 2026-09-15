import { normalizeScheduleTeamCode } from "../../game-schedule-detection.js";

const JST_TIME_ZONE = "Asia/Tokyo";
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const NPB_GAME_CODE_PATTERN = /^[a-z0-9]+-[a-z0-9]+-\d{1,3}$/i;
const MAX_REASON_LENGTH = 240;
const MAX_VENUE_LENGTH = 120;
const REQUIRED_CURRENT_TABLES = Object.freeze([
  "games",
  "game_identifiers",
  "detected_game_schedule",
  "game_automation_v3_state",
  "game_jobs_v3"
]);
const REGISTRATION_SUPPORT_TABLES = Object.freeze([
  "manual_schedule_operations",
  "schedule_identity_locks"
]);
const INITIAL_JOBS = Object.freeze([
  "npb_identity_resolve",
  "probable_starter_fetch",
  "roster_fetch",
  "prediction_close"
]);
const FOLLOW_UP_JOBS = Object.freeze([
  "lineup_fetch",
  "lineup_finalize",
  "score",
  "ranking_rebuild",
  "publish"
]);

function previewError(code, message, httpStatus = 400) {
  const error = new Error(message);
  error.code = code;
  error.httpStatus = httpStatus;
  return error;
}

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isValidCalendarDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function normalizeStartAt(value, gameDate) {
  const raw = trimText(value);
  if (!raw) throw previewError("MANUAL_GAME_START_AT_REQUIRED", "startAtは必須です。");
  const localDateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/;
  const localDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw) ? `${raw}:00` : raw;
  const withTimeZone = localDateTimePattern.test(raw) ? `${localDateTime}+09:00` : raw;
  const parsed = new Date(withTimeZone);
  if (Number.isNaN(parsed.getTime())) {
    throw previewError("MANUAL_GAME_START_AT_INVALID", "startAtは有効な日時で指定してください。");
  }
  const jstParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: JST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(parsed).reduce((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});
  const jstDate = `${jstParts.year}-${jstParts.month}-${jstParts.day}`;
  if (jstDate !== gameDate) {
    throw previewError("MANUAL_GAME_DATE_START_AT_MISMATCH", "gameDateとstartAtの日付が一致していません。");
  }
  return parsed.toISOString();
}

function normalizeNpbGameCode(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw previewError("MANUAL_GAME_NPB_CODE_INVALID", "npbGameCodeは文字列またはnullで指定してください。");
  const normalized = value.trim().toLowerCase();
  if (!normalized || !NPB_GAME_CODE_PATTERN.test(normalized)) {
    throw previewError("MANUAL_GAME_NPB_CODE_INVALID", "npbGameCodeの形式が不正です。");
  }
  return normalized;
}

export function normalizeManualGamePreviewInput(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw previewError("MANUAL_GAME_INPUT_INVALID", "入力JSONが不正です。");
  }
  const gameDate = trimText(input.gameDate);
  if (!gameDate || !isValidCalendarDate(gameDate)) {
    throw previewError("MANUAL_GAME_DATE_INVALID", "gameDateは有効なYYYY-MM-DD形式で指定してください。");
  }
  const startAt = normalizeStartAt(input.startAt, gameDate);
  const homeTeam = normalizeScheduleTeamCode(input.homeTeam);
  const awayTeam = normalizeScheduleTeamCode(input.awayTeam);
  if (!homeTeam || !awayTeam) {
    throw previewError("MANUAL_GAME_TEAM_INVALID", "homeTeamとawayTeamは対応済みのteam keyで指定してください。");
  }
  if (homeTeam === awayTeam) {
    throw previewError("MANUAL_GAME_TEAM_DUPLICATE", "homeTeamとawayTeamは異なるチームを指定してください。");
  }
  const venue = trimText(input.venue);
  if (venue.length > MAX_VENUE_LENGTH) {
    throw previewError("MANUAL_GAME_VENUE_TOO_LONG", `venueは${MAX_VENUE_LENGTH}文字以内で指定してください。`);
  }
  const reason = trimText(input.reason);
  if (!reason || reason.length > MAX_REASON_LENGTH) {
    throw previewError("MANUAL_GAME_REASON_REQUIRED", `reasonを1〜${MAX_REASON_LENGTH}文字で指定してください。`);
  }
  if (typeof input.rankingEligible !== "boolean") {
    throw previewError("MANUAL_GAME_RANKING_ELIGIBLE_INVALID", "rankingEligibleはbooleanで指定してください。");
  }
  if (input.confirmPreview !== true) {
    throw previewError("MANUAL_GAME_PREVIEW_CONFIRM_REQUIRED", "preview実行にはconfirmPreview=trueが必要です。");
  }
  const npbGameCode = normalizeNpbGameCode(input.npbGameCode);
  return Object.freeze({
    gameDate,
    startAt,
    homeTeam,
    awayTeam,
    venue: venue || null,
    npbGameCode,
    rankingEligible: input.rankingEligible,
    reason,
    confirmPreview: true
  });
}

function idempotencyKey(input) {
  return [
    "manual-game:v1",
    input.gameDate,
    input.startAt,
    input.homeTeam,
    input.awayTeam,
    input.npbGameCode || "no-code"
  ].join(":");
}

function parseTime(value) {
  const time = new Date(String(value || "")).getTime();
  return Number.isFinite(time) ? time : null;
}

function normalizedRow(row = {}) {
  return {
    internalGameId: row.internal_game_id || row.internalGameId || null,
    gameDate: String(row.game_date || row.gameDate || "").slice(0, 10),
    startAt: row.start_time || row.startAt || null,
    homeTeam: normalizeScheduleTeamCode(row.home_team || row.homeTeam) || String(row.home_team || row.homeTeam || "").trim().toLowerCase(),
    awayTeam: normalizeScheduleTeamCode(row.away_team || row.awayTeam) || String(row.away_team || row.awayTeam || "").trim().toLowerCase(),
    npbGameCode: row.npb_game_code || row.npbGameCode || null,
    gameStatus: row.game_status || row.gameStatus || null
  };
}

function matchKey(match) {
  return `${match.source}:${match.internalGameId || match.identifierValue || "unknown"}:${match.matchType}`;
}

function addMatch(matches, match) {
  const key = matchKey(match);
  if (!matches.some((item) => matchKey(item) === key)) matches.push(match);
}

async function tableNames(db) {
  const result = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  return new Set((result.results || []).map((row) => String(row.name || "")));
}

async function tableColumns(db, table) {
  if (!/^[a-z0-9_]+$/.test(table)) return new Set();
  const result = await db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set((result.results || []).map((row) => String(row.name || "")));
}

async function loadGamesForDate(db, gameDate, columns) {
  const npbColumn = columns.has("npb_game_code") ? ", npb_game_code" : "";
  const result = await db.prepare(
    `SELECT internal_game_id, game_date, start_time, home_team, away_team, game_status${npbColumn}
       FROM games
      WHERE game_date = ?1
      ORDER BY start_time, internal_game_id
      LIMIT 100`
  ).bind(gameDate).all();
  return result.results || [];
}

function duplicateMatchesForGame(input, row) {
  const existing = normalizedRow(row);
  const sameCard = existing.gameDate === input.gameDate
    && existing.homeTeam === input.homeTeam
    && existing.awayTeam === input.awayTeam;
  const reverseCard = existing.gameDate === input.gameDate
    && existing.homeTeam === input.awayTeam
    && existing.awayTeam === input.homeTeam;
  const sameStart = parseTime(existing.startAt) === parseTime(input.startAt);
  const matches = [];
  if (sameCard && sameStart) matches.push({ matchType: "exact_duplicate", severity: "blocking" });
  else if (sameCard) matches.push({ matchType: "same_card_same_day", severity: "warning" });
  if (reverseCard) matches.push({ matchType: "reverse_home_away_same_day", severity: "warning" });
  if (input.npbGameCode && String(existing.npbGameCode || "").trim().toLowerCase() === input.npbGameCode) {
    matches.push({ matchType: "same_npb_game_code", severity: "blocking" });
  }
  return matches.map((match) => ({ source: "games", ...match, ...existing }));
}

async function loadIdentifierMatches(db, input, tables) {
  if (!input.npbGameCode || !tables.has("game_identifiers")) return [];
  try {
    const result = await db.prepare(
      `SELECT internal_game_id, provider, identifier_type, identifier_value
         FROM game_identifiers
        WHERE lower(trim(identifier_value)) = ?1
        LIMIT 20`
    ).bind(input.npbGameCode).all();
    return (result.results || []).map((row) => ({
      source: "game_identifiers",
      matchType: "same_npb_game_code",
      severity: "blocking",
      internalGameId: row.internal_game_id || null,
      identifierValue: row.identifier_value || input.npbGameCode,
      provider: row.provider || null,
      identifierType: row.identifier_type || null
    }));
  } catch {
    return [];
  }
}

async function loadDetectedScheduleCheck(db, input, tables, columns) {
  if (!tables.has("detected_game_schedule")) {
    return { status: "not_available", available: false, matches: [], reason: "detected_game_scheduleが存在しません。" };
  }
  const required = ["game_date", "start_at", "home_team", "away_team"].every((column) => columns.has(column));
  if (!required) {
    return { status: "not_available", available: false, matches: [], reason: "detected_game_scheduleの必要な読み取り列を確認できません。" };
  }
  const result = await db.prepare(
    `SELECT game_id, internal_game_id, game_date, start_at, home_team, away_team
       FROM detected_game_schedule
      WHERE game_date = ?1
      LIMIT 100`
  ).bind(input.gameDate).all();
  const matches = [];
  for (const row of result.results || []) {
    const homeTeam = normalizeScheduleTeamCode(row.home_team) || String(row.home_team || "").trim().toLowerCase();
    const awayTeam = normalizeScheduleTeamCode(row.away_team) || String(row.away_team || "").trim().toLowerCase();
    const sameStart = parseTime(row.start_at) === parseTime(input.startAt);
    const sameCard = homeTeam === input.homeTeam && awayTeam === input.awayTeam;
    const reverseCard = homeTeam === input.awayTeam && awayTeam === input.homeTeam;
    if (sameCard && sameStart) matches.push({ source: "detected_game_schedule", matchType: "exact_detected_schedule", severity: "blocking", ...row });
    else if (sameCard) matches.push({ source: "detected_game_schedule", matchType: "same_detected_card_same_day", severity: "warning", ...row });
    else if (reverseCard) matches.push({ source: "detected_game_schedule", matchType: "reverse_detected_home_away_same_day", severity: "warning", ...row });
  }
  return { status: "checked", available: true, matches };
}

export async function buildManualGamePreview(db, rawInput) {
  const input = normalizeManualGamePreviewInput(rawInput);
  const tables = await tableNames(db);
  const gamesColumns = await tableColumns(db, "games");
  if (!tables.has("games") || !gamesColumns.has("game_date") || !gamesColumns.has("start_time")) {
    throw previewError("MANUAL_GAME_PREVIEW_SCHEMA_UNAVAILABLE", "gamesの読み取りスキーマを確認できません。", 503);
  }
  const scheduleColumns = await tableColumns(db, "detected_game_schedule");
  const rows = await loadGamesForDate(db, input.gameDate, gamesColumns);
  const matches = [];
  const warnings = [];
  for (const row of rows) {
    duplicateMatchesForGame(input, row).forEach((match) => addMatch(matches, match));
  }
  const identifierMatches = await loadIdentifierMatches(db, input, tables);
  identifierMatches.forEach((match) => addMatch(matches, match));
  const detectedScheduleCheck = await loadDetectedScheduleCheck(db, input, tables, scheduleColumns);
  detectedScheduleCheck.matches.forEach((match) => addMatch(matches, match));

  const warningMessages = {
    same_card_same_day: "同日同カードの既存試合があります。ダブルヘッダーまたは時刻訂正か確認してください。",
    reverse_home_away_same_day: "同日同カードのhome/away逆向き候補があります。入力方向を確認してください。",
    same_detected_card_same_day: "検出日程に同日同カード候補があります。既存日程との紐付けを確認してください。",
    reverse_detected_home_away_same_day: "検出日程にhome/away逆向き候補があります。入力方向を確認してください。"
  };
  for (const match of matches) {
    if (match.severity === "warning" && warningMessages[match.matchType]) {
      warnings.push({ code: match.matchType.toUpperCase(), severity: "warning", message: warningMessages[match.matchType] });
    }
  }
  const hasBlockingDuplicate = matches.some((match) => match.severity === "blocking");
  const registrationTablesReady = REGISTRATION_SUPPORT_TABLES.every((table) => tables.has(table));
  const gameRegistrationColumnsReady = ["schedule_identity_key", "registration_status", "is_public_candidate", "manual_operation_id"]
    .every((column) => gamesColumns.has(column));
  const requiredTablesReady = REQUIRED_CURRENT_TABLES.every((table) => tables.has(table));
  const canRegisterWithCurrentSchema = false;
  const requiresMigration = !registrationTablesReady || !gameRegistrationColumnsReady;
  const registrationReadiness = {
    canRegisterWithCurrentSchema,
    requiresMigration,
    requiresIdempotencyTable: !tables.has("manual_schedule_operations"),
    requiresStagedRegistration: !tables.has("manual_schedule_operations") || !gameRegistrationColumnsReady,
    currentSchemaReadable: requiredTablesReady,
    detectedScheduleCheck: detectedScheduleCheck.status,
    reason: "本preview Phaseでは正式登録サービスが未実装のため、schemaが揃っていても書き込みません。"
  };
  const expectedPlan = {
    wouldCreateGame: !hasBlockingDuplicate,
    wouldInitializeWorkflow: !hasBlockingDuplicate,
    wouldUsePlannerForInitialJobs: true,
    wouldExposePublicAfterCommit: !hasBlockingDuplicate,
    expectedInitialState: "scheduled",
    expectedInitialJobs: [...INITIAL_JOBS],
    expectedFollowUpJobs: [...FOLLOW_UP_JOBS],
    expectedJobs: [...INITIAL_JOBS, ...FOLLOW_UP_JOBS],
    startAtChangeNote: "startAtを変更するとidempotencyKeyも変わるため、別previewとして重複を再確認します。"
  };
  return {
    ok: true,
    mode: "preview_only",
    willWrite: false,
    generatedAt: new Date().toISOString(),
    validation: { ok: true, errors: [] },
    idempotencyKey: idempotencyKey(input),
    normalizedInput: input,
    duplicateCheck: {
      hasBlockingDuplicate,
      warnings,
      matches,
      detectedScheduleCheck
    },
    registrationReadiness,
    expectedPlan,
    nextSafeAction: hasBlockingDuplicate ? "resolve_duplicate_before_commit" : "migration_required_before_commit"
  };
}
