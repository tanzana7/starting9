import { deriveV3Schedule } from "./domain.js";

const UNAVAILABLE_STATUSES = new Set(["cancelled", "canceled", "postponed", "no_game", "service_unavailable"]);

function scheduleError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function text(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

function normalizeStatus(value) {
  const status = text(value).toLowerCase();
  return status === "canceled" ? "cancelled" : status || "scheduled";
}

function isoOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function createScheduleVersion(row = {}) {
  // `updated_at` is already written by every canonical schedule mutation and
  // is available in the pre-Phase-3 schema. The stable fallback keeps local
  // fixtures and older read-only environments diagnosable without a migration.
  return text(row.updated_at) || [
    row.game_date,
    row.start_time,
    row.home_team,
    row.away_team,
    row.game_status
  ].map(text).join("|");
}

export function normalizeScheduleProposal(input = {}) {
  const startAt = isoOrNull(input.startAt || input.start_at || input.startTime || input.start_time);
  if (!startAt) throw scheduleError("SCHEDULE_START_AT_INVALID", "日程情報の開始時刻が不正です。", { httpStatus: 400 });
  const gameDate = text(input.gameDate || input.game_date) || startAt.slice(0, 10);
  const homeTeam = text(input.homeTeam || input.home_team);
  const awayTeam = text(input.awayTeam || input.away_team);
  if (!gameDate || !homeTeam || !awayTeam) {
    throw scheduleError("SCHEDULE_INPUT_INVALID", "日程情報に必要な項目がありません。", { httpStatus: 400 });
  }
  const supplied = (...keys) => keys.some((key) => Object.prototype.hasOwnProperty.call(input, key));
  const optionalText = (...keys) => supplied(...keys)
    ? (text(keys.map((key) => input[key]).find((value) => value !== undefined)) || null)
    : undefined;
  const rawSeason = input.season;
  const season = rawSeason === undefined || rawSeason === null || rawSeason === "" ? null : Number(rawSeason);
  return {
    gameDate,
    startAt,
    homeTeam,
    awayTeam,
    status: normalizeStatus(input.status || input.gameStatus || input.game_status),
    npbGameCode: optionalText("npbGameCode", "npb_game_code"),
    npbGameUrl: optionalText("npbGameUrl", "npb_game_url"),
    sourceScheduleKey: optionalText("sourceScheduleKey", "source_schedule_key"),
    npbIdentityStatus: optionalText("npbIdentityStatus", "npb_identity_status"),
    npbIdentitySource: optionalText("npbIdentitySource", "npb_identity_source"),
    stadium: optionalText("stadium", "venue"),
    season: supplied("season") ? (Number.isInteger(season) ? season : null) : undefined,
    isActive: supplied("isActive") ? (input.isActive ? 1 : 0) : undefined,
    derived: input.derived || null
  };
}

export function isScheduleUnavailable(status) {
  return UNAVAILABLE_STATUSES.has(normalizeStatus(status));
}

export function deriveScheduleArtifacts(startAt) {
  const schedule = deriveV3Schedule({ startAt });
  return Object.fromEntries([
    ["predictionDeadline", schedule.predictionDeadline],
    ["rosterFetchAt1", schedule.rosterFetchAt1],
    ["rosterFetchAt2", schedule.rosterFetchAt2],
    ["lineupPollingStart", schedule.lineupPollingStart],
    ["finalLineupAt", schedule.finalLineupAt],
    ["publicationAt", schedule.publicationAt]
  ].map(([key, value]) => [key, value.toISOString()]));
}

function sourceActor(source, actor) {
  const normalizedSource = text(source).toLowerCase() || "recovery";
  const normalizedActor = text(actor) || "system";
  return `${normalizedSource}:${normalizedActor}`.slice(0, 120);
}

function isAdminOverride(row) {
  const changedBy = text(row?.changed_by).toLowerCase();
  return changedBy.startsWith("admin:") && !changedBy.endsWith(":override-release");
}

async function tableColumns(db, table) {
  const result = await db.prepare(`PRAGMA table_info(${table})`).bind().all();
  return new Set((result.results || []).map((row) => text(row.name)));
}

async function readCurrent(db, internalGameId, columns) {
  const optional = [
    "npb_game_code", "npb_game_url", "source_schedule_key", "npb_identity_status",
    "npb_identity_resolved_at", "npb_identity_source", "season", "stadium", "is_active",
    "deleted_at", "prediction_deadline_at", "roster_fetch_at1", "roster_fetch_at2",
    "lineup_polling_start_at", "final_lineup_at", "publication_at", "updated_by"
  ].filter((column) => columns.has(column));
  const select = ["internal_game_id", "game_date", "start_time", "home_team", "away_team", "game_status", "updated_at", ...optional];
  return db.prepare(`SELECT ${select.join(", ")} FROM games WHERE internal_game_id = ?1 LIMIT 1`).bind(internalGameId).first();
}

async function latestHistory(db, internalGameId) {
  try {
    return await db.prepare(
      `SELECT previous_start_at, next_start_at, previous_status, next_status, reason, changed_by, changed_at
         FROM game_schedule_change_history
        WHERE internal_game_id = ?1
        ORDER BY changed_at DESC, id DESC LIMIT 1`
    ).bind(internalGameId).first();
  } catch {
    return null;
  }
}

function valuesEqual(left, right) {
  return String(left ?? "") === String(right ?? "");
}

export async function applyScheduleChange(db, {
  internalGameId,
  proposedSchedule,
  derivedSchedule = null,
  actor = "system",
  source = "recovery",
  expectedScheduleVersion = null,
  reason = "",
  now = new Date(),
  officialCorrection = false,
  releaseManualOverride = false
} = {}) {
  const id = text(internalGameId);
  if (!id) throw scheduleError("INTERNAL_GAME_ID_REQUIRED", "内部試合IDが必要です。", { httpStatus: 400 });
  const columns = await tableColumns(db, "games");
  const current = await readCurrent(db, id, columns);
  if (!current) throw scheduleError("GAME_NOT_FOUND", "対象試合が見つかりません。", { httpStatus: 404 });
  const currentVersion = createScheduleVersion(current);
  if (expectedScheduleVersion !== null && text(expectedScheduleVersion) !== currentVersion) {
    throw scheduleError("SCHEDULE_VERSION_CONFLICT", "日程が別の操作で更新されています。", { httpStatus: 409, currentVersion });
  }
  const history = await latestHistory(db, id);
  const automatic = text(source).toLowerCase() === "cron";
  if (automatic && isAdminOverride(history) && !officialCorrection && !releaseManualOverride) {
    return { status: "skipped", noOp: true, reason: "MANUAL_OVERRIDE_ACTIVE", current, currentVersion, history };
  }

  const next = normalizeScheduleProposal(proposedSchedule);
  const at = (now instanceof Date ? now : new Date(now));
  if (Number.isNaN(at.getTime())) throw scheduleError("SCHEDULE_TIMESTAMP_INVALID", "日程更新時刻が不正です。", { httpStatus: 400 });
  const timestamp = at.toISOString();
  const derived = derivedSchedule || {};
  const normalizedActor = releaseManualOverride ? `${text(actor) || "admin"}:override-release` : actor;
  const nextHistoryActor = sourceActor(source, normalizedActor);
  const updates = new Map([
    ["game_date", next.gameDate], ["start_time", next.startAt], ["home_team", next.homeTeam],
    ["away_team", next.awayTeam], ["game_status", next.status], ["updated_at", timestamp],
    ["updated_by", nextHistoryActor], ["npb_game_code", next.npbGameCode], ["npb_game_url", next.npbGameUrl],
    ["source_schedule_key", next.sourceScheduleKey], ["npb_identity_status", next.npbIdentityStatus],
    ["npb_identity_resolved_at", next.npbGameCode ? timestamp : null], ["npb_identity_source", next.npbIdentitySource],
    ["stadium", next.stadium], ["season", next.season],
    ["is_active", next.isActive], ["deleted_at", next.isActive === undefined || next.isActive === null ? undefined : (next.isActive ? null : timestamp)],
    ["prediction_deadline_at", derived.predictionDeadline], ["roster_fetch_at1", derived.rosterFetchAt1],
    ["roster_fetch_at2", derived.rosterFetchAt2], ["lineup_polling_start_at", derived.lineupPollingStart],
    ["final_lineup_at", derived.finalLineupAt], ["publication_at", derived.publicationAt]
  ]);
  const changed = [...updates.entries()]
    .filter(([column, value]) => value !== undefined && columns.has(column) && !valuesEqual(current[column], value));
  const meaningfulChanged = changed.filter(([column]) => !["updated_at", "updated_by"].includes(column));
  const releaseOnly = releaseManualOverride && meaningfulChanged.length === 0;
  if (meaningfulChanged.length === 0 && !releaseOnly) {
    return { status: "no_change", noOp: true, current, currentVersion, schedule: next, history };
  }

  const fields = changed.map(([column], index) => `${column} = ?${index + 1}`);
  const updateValues = changed.map(([, value]) => value);
  const hasUpdatedAt = columns.has("updated_at");
  const whereValues = [id];
  let where = `internal_game_id = ?${updateValues.length + 1}`;
  if (hasUpdatedAt) {
    where += current.updated_at === null || current.updated_at === undefined
      ? " AND updated_at IS NULL"
      : ` AND updated_at = ?${updateValues.length + 2}`;
    if (current.updated_at !== null && current.updated_at !== undefined) whereValues.push(current.updated_at);
  }
  const updateStatement = db.prepare(`UPDATE games SET ${fields.length ? fields.join(", ") : "updated_at = updated_at"} WHERE ${where}`)
    .bind(...updateValues, ...whereValues);
  const historyStatement = db.prepare(
    `INSERT INTO game_schedule_change_history
       (internal_game_id, previous_start_at, next_start_at, previous_status, next_status, reason, changed_by, changed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  ).bind(id, current.start_time || null, next.startAt, current.game_status || null, next.status, text(reason) || "schedule update", nextHistoryActor, timestamp);
  const updateResult = await updateStatement.run();
  const changes = Number(updateResult?.meta?.changes ?? updateResult?.changes ?? 0);
  if (changes !== 1) throw scheduleError("SCHEDULE_VERSION_CONFLICT", "日程が別の操作で更新されています。", { httpStatus: 409, currentVersion });
  await historyStatement.run();
  return {
    status: "updated",
    noOp: false,
    previous: current,
    schedule: next,
    scheduleVersion: timestamp,
    changedFields: changed.map(([column]) => column),
    manualOverrideReleased: releaseOnly
  };
}

export const SCHEDULE_UNAVAILABLE_STATUSES = Object.freeze([...UNAVAILABLE_STATUSES]);
