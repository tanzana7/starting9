import { createScheduleGameIdentifiers, getOrCreateInternalGame } from "../../game-identity-registry.js";
import { normalizeExternalGameStatus } from "../npb-source-adapter.js";
import { normalizeScheduleTeamCode } from "../../game-schedule-detection.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/;
const GAME_CODE_PATTERN = /^[a-z0-9]{1,2}-[a-z0-9]{1,2}-\d+$/i;
const NORMAL_EXTERNAL_STATUSES = new Set(["scheduled", "live", "final", "completed"]);
const TERMINAL_EXTERNAL_STATUSES = new Set(["cancelled", "postponed", "no_game"]);

function candidateError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function text(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

function normalizeDate(value) {
  const date = text(value);
  if (!DATE_PATTERN.test(date)) return "";
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : "";
}

function normalizeStartAt(rawValue, gameDate) {
  const raw = text(rawValue);
  if (!raw) return "";
  const local = TIME_PATTERN.test(raw) ? new Date(`${gameDate}T${raw}+09:00`) : new Date(raw);
  if (Number.isNaN(local.getTime())) return "";
  const jstDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(local);
  return jstDate === gameDate ? local.toISOString() : "";
}

function normalizedStatus(value) {
  return normalizeExternalGameStatus(value) || "unknown";
}

function externalGameId(value) {
  return text(value?.gameId || value?.externalGameId || value?.external_game_id);
}

function gameCodeFromGameId(value) {
  const match = /^\d{4}-\d{2}-\d{2}-([a-z0-9]+-[a-z0-9]+-\d+)$/i.exec(text(value));
  return match ? match[1].toLowerCase() : "";
}

function seriesFromGameCode(value) {
  const match = /-(\d+)$/.exec(text(value));
  return match ? Number(match[1]) : NaN;
}

function replacementTargetId(value) {
  return text(value?.replacementGame?.gameId
    || value?.replacementGameId
    || value?.replacement_game_id);
}

function candidateIdentityKey(candidate) {
  const base = `${candidate.gameDate}|${candidate.homeTeam}|${candidate.awayTeam}`;
  return candidate.npbGameCode ? `${base}|code:${candidate.npbGameCode}` : `${base}|start:${candidate.startAt}`;
}

function candidateSlotKey(candidate) {
  return `${candidate.gameDate}|${candidate.homeTeam}|${candidate.awayTeam}|start:${candidate.startAt}`;
}

export function scheduleCandidateKeys(candidate) {
  return [candidateIdentityKey(candidate), candidateSlotKey(candidate)];
}

export function normalizeScheduleCandidate(raw = {}, { source = "external" } = {}) {
  const gameDate = normalizeDate(raw.gameDate || raw.date);
  const startAt = normalizeStartAt(raw.startAt || raw.start_at || raw.startTime || raw.start_time, gameDate);
  const homeTeam = normalizeScheduleTeamCode(raw.homeTeam || raw.home_team);
  const awayTeam = normalizeScheduleTeamCode(raw.awayTeam || raw.away_team);
  const npbGameCode = text(raw.npbGameCode || raw.gameCode || raw.npb_game_code || gameCodeFromGameId(raw.gameId)).toLowerCase();
  const seriesNumber = Number(raw.seriesNumber ?? raw.round ?? seriesFromGameCode(npbGameCode));
  const status = normalizedStatus(raw.status || raw.gameStatus || raw.game_status);
  const externalId = externalGameId(raw);
  if (!gameDate || !startAt || !homeTeam || !awayTeam || homeTeam === awayTeam || !externalId) {
    throw candidateError("SCHEDULE_CANDIDATE_INVALID", "追加日程candidateの日付・開始時刻・対戦カード・外部IDが不正です。");
  }
  if (!npbGameCode || !GAME_CODE_PATTERN.test(npbGameCode)) {
    throw candidateError("SCHEDULE_CANDIDATE_GAME_CODE_INVALID", "追加日程candidateのNPB game codeが不正です。");
  }
  if (!Number.isInteger(seriesNumber) || seriesNumber < 1) {
    throw candidateError("SCHEDULE_CANDIDATE_SERIES_INVALID", "追加日程candidateのseries番号が不正です。");
  }
  return Object.freeze({
    source,
    sourceGameKey: `${source}:${externalId}`,
    externalGameId: externalId,
    gameDate,
    startAt,
    homeTeam,
    awayTeam,
    npbGameCode,
    seriesNumber,
    status,
    replacementGameId: replacementTargetId(raw),
    replacementOfExternalGameId: text(raw.replacementOfExternalGameId || raw.replacement_of_external_game_id),
    venue: text(raw.venue || raw.stadium) || null
  });
}

export function validateScheduleCandidate(candidate, { requiredTeam = "fighters" } = {}) {
  const errors = [];
  if (!candidate || typeof candidate !== "object") return { ok: false, errors: ["candidate_invalid"] };
  if (!DATE_PATTERN.test(candidate.gameDate || "")) errors.push("date_invalid");
  if (!candidate.startAt || Number.isNaN(new Date(candidate.startAt).getTime())) errors.push("start_at_invalid");
  if (!candidate.homeTeam || !candidate.awayTeam || candidate.homeTeam === candidate.awayTeam) errors.push("teams_invalid");
  if (requiredTeam && candidate.homeTeam !== requiredTeam && candidate.awayTeam !== requiredTeam) errors.push("target_team_missing");
  if (!GAME_CODE_PATTERN.test(candidate.npbGameCode || "")) errors.push("npb_game_code_invalid");
  if (!Number.isInteger(candidate.seriesNumber) || candidate.seriesNumber < 1) errors.push("series_number_invalid");
  if (!candidate.externalGameId) errors.push("external_game_id_missing");
  if (!NORMAL_EXTERNAL_STATUSES.has(candidate.status)) errors.push("status_not_registerable");
  return { ok: errors.length === 0, errors };
}

function hasDuplicate(candidate, knownCandidates) {
  const keys = new Set(scheduleCandidateKeys(candidate));
  return (knownCandidates || []).some((known) => scheduleCandidateKeys(known).some((key) => keys.has(key)));
}

export function discoverAdditionalScheduleCandidates(externalGames = [], knownGames = [], { requiredTeam = null, source = "external" } = {}) {
  const normalized = [];
  const rejected = [];
  const byExternalId = new Map();
  for (const raw of Array.isArray(externalGames) ? externalGames : []) {
    try {
      const candidate = normalizeScheduleCandidate(raw, { source });
      normalized.push(candidate);
      byExternalId.set(candidate.externalGameId, candidate);
    } catch (error) {
      rejected.push({ externalGameId: externalGameId(raw) || null, reason: error.code || "SCHEDULE_CANDIDATE_INVALID" });
    }
  }
  const known = [];
  for (const raw of Array.isArray(knownGames) ? knownGames : []) {
    try { known.push(normalizeScheduleCandidate(raw, { source: "starting9" })); } catch { /* existing incomplete rows do not block discovery */ }
  }
  const candidates = [];
  const cancelledOriginals = [];
  for (const candidate of normalized) {
    if (TERMINAL_EXTERNAL_STATUSES.has(candidate.status)) {
      if (candidate.status === "cancelled" || candidate.status === "no_game") cancelledOriginals.push(candidate);
      continue;
    }
    if (requiredTeam && candidate.homeTeam !== requiredTeam && candidate.awayTeam !== requiredTeam) continue;
    const replacementOf = normalized.find((source) => source.replacementGameId === candidate.externalGameId);
    const linked = replacementOf ? { ...candidate, replacementOfExternalGameId: replacementOf.externalGameId } : candidate;
    if (hasDuplicate(linked, [...known, ...candidates])) continue;
    candidates.push(Object.freeze(linked));
  }
  return { candidates, cancelledOriginals, rejected, observed: normalized, externalIndex: byExternalId };
}

async function findDatabaseDuplicates(db, candidate) {
  const rows = await db.prepare(
    `SELECT internal_game_id, game_date, start_time, home_team, away_team, npb_game_code
       FROM games
      WHERE game_date = ?1 AND lower(trim(home_team)) = ?2 AND lower(trim(away_team)) = ?3`
  ).bind(candidate.gameDate, candidate.homeTeam, candidate.awayTeam).all();
  return (rows.results || []).filter((row) => {
    const existing = {
      gameDate: row.game_date,
      startAt: row.start_time,
      homeTeam: row.home_team,
      awayTeam: row.away_team,
      npbGameCode: row.npb_game_code || ""
    };
    return scheduleCandidateKeys(candidate).some((key) => scheduleCandidateKeys(existing).includes(key));
  });
}

export async function registerDevelopmentScheduleCandidate(db, candidate, {
  environment = "test",
  createId = () => crypto.randomUUID(),
  now = new Date(),
  requiredTeam = "fighters"
} = {}) {
  if (!["development", "dev", "test", "local"].includes(String(environment).toLowerCase())) {
    throw candidateError("SCHEDULE_CANDIDATE_REGISTRATION_DISABLED", "追加日程の自動登録はdevelopment/test環境でのみ許可されています。");
  }
  const validation = validateScheduleCandidate(candidate, { requiredTeam });
  if (!validation.ok) throw candidateError("SCHEDULE_CANDIDATE_REJECTED", validation.errors.join(","));
  const duplicates = await findDatabaseDuplicates(db, candidate);
  if (duplicates.length) return { status: "duplicate", internalGameId: duplicates[0].internal_game_id, duplicates };
  const identifiers = createScheduleGameIdentifiers({ sourceGameKey: candidate.sourceGameKey });
  const result = await getOrCreateInternalGame(db, {
    game: {
      gameDate: candidate.gameDate,
      startAt: candidate.startAt,
      homeTeam: candidate.homeTeam,
      awayTeam: candidate.awayTeam,
      gameStatus: "scheduled"
    },
    identifiers,
    allowCreate: true,
    createId,
    now,
    skipScheduleMutation: false
  });
  if (result.status !== "resolved" || !result.internalGameId) {
    throw candidateError("SCHEDULE_CANDIDATE_REGISTRATION_FAILED", result.code || "internal_game_resolution_failed");
  }
  return {
    status: "registered",
    internalGameId: result.internalGameId,
    candidate,
    replacementOfExternalGameId: candidate.replacementOfExternalGameId || null,
    plannerInput: {
      internalGameId: result.internalGameId,
      gameStatus: "scheduled",
      isActive: 1,
      deletedAt: null
    }
  };
}
