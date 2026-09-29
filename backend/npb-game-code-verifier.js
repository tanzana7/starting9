import { NPB_TEAM_CODES } from "../game-schedule.js";
import { normalizeScheduleTeamCode } from "../game-schedule-detection.js";
import {
  buildSimulatorSourceUrl,
  fetchSimulatorSource,
  normalizeExternalGameStatus,
  parseSimulatorResponse
} from "./npb-source-adapter.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const GAME_CODE_PATTERN = /^[a-z0-9]{1,2}-[a-z0-9]{1,2}-\d+$/i;
const MAX_GAME_CODE_CANDIDATES = 7;
const ACCEPTED_PAGE_STATUSES = new Set([
  "scheduled", "live", "final", "completed", "cancelled", "postponed", "no_game",
  // S9simu exposes workflow milestones on its score page. They still identify
  // a real game page, so they are accepted without changing the game lifecycle.
  "probable_announced", "lineup_announced"
]);

function verifierError(code, message) {
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

function jstDate(value) {
  const parsed = value instanceof Date ? value : new Date(value || "");
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(parsed);
}

function normalizeCode(value) {
  const code = text(value).toLowerCase();
  return GAME_CODE_PATTERN.test(code) ? code : "";
}

function seriesFromCode(value) {
  const match = /-(\d+)$/.exec(text(value));
  return match ? Number(match[1]) : NaN;
}

function normalizeSeries(value) {
  const series = Number(value);
  return Number.isInteger(series) && series > 0 && series <= 999 ? series : NaN;
}

function normalizeTarget(target = {}) {
  const startAt = target.startAt || target.start_at || "";
  const suppliedDate = text(target.gameDate || target.game_date || target.date);
  const gameDate = suppliedDate ? normalizeDate(suppliedDate) : jstDate(startAt);
  const homeTeam = normalizeScheduleTeamCode(target.homeTeam || target.home_team);
  const awayTeam = normalizeScheduleTeamCode(target.awayTeam || target.away_team);
  const existingGameCode = normalizeCode(target.existingGameCode || target.npbGameCode || target.npb_game_code);
  const seriesNumberHint = normalizeSeries(target.seriesNumberHint ?? target.seriesNumber ?? target.round ?? seriesFromCode(existingGameCode));
  return {
    internalGameId: text(target.internalGameId || target.internal_game_id),
    gameDate, homeTeam, awayTeam, existingGameCode, seriesNumberHint, startAt
  };
}

function targetError(target, code, message) {
  return {
    status: "invalid_data",
    code,
    error: message,
    target,
    candidates: [],
    attempts: []
  };
}

export function discoverGameCodeCandidates(target = {}, { candidateWindow = 2, maxCandidates = MAX_GAME_CODE_CANDIDATES } = {}) {
  const normalized = normalizeTarget(target);
  if (!normalized.gameDate || !normalized.homeTeam || !normalized.awayTeam || normalized.homeTeam === normalized.awayTeam) {
    return targetError(normalized, "GAME_IDENTITY_INVALID", "gameDate・homeTeam・awayTeamが不正です。");
  }
  const homeCode = NPB_TEAM_CODES[normalized.homeTeam];
  const awayCode = NPB_TEAM_CODES[normalized.awayTeam];
  if (!homeCode || !awayCode) return targetError(normalized, "TEAM_CODE_UNKNOWN", "NPB team codeを解決できません。");
  if (!Number.isInteger(normalized.seriesNumberHint)) {
    return targetError(normalized, "SERIES_HINT_REQUIRED", "boundedな候補探索にはseriesNumber hintが必要です。");
  }

  const requestedLimit = Number.isInteger(Number(maxCandidates)) ? Number(maxCandidates) : MAX_GAME_CODE_CANDIDATES;
  const limit = Math.max(1, Math.min(MAX_GAME_CODE_CANDIDATES, requestedLimit));
  const width = Math.max(0, Math.min(3, Number.isInteger(Number(candidateWindow)) ? Number(candidateWindow) : 2));
  const candidates = [];
  const seen = new Set();
  const add = (gameCode, source) => {
    const normalizedCode = normalizeCode(gameCode);
    if (!normalizedCode || seen.has(normalizedCode) || candidates.length >= limit) return;
    seen.add(normalizedCode);
    candidates.push({ gameCode: normalizedCode, source, seriesNumber: seriesFromCode(normalizedCode) });
  };

  // Validate a persisted hint first. A verified existing identity avoids any
  // additional fetch and preserves the same internalGameId lineage.
  add(normalized.existingGameCode, "existing_hint");
  const prefix = `${homeCode}-${awayCode}-`;
  const seriesNumbers = [normalized.seriesNumberHint];
  for (let offset = 1; offset <= width; offset += 1) {
    seriesNumbers.push(normalized.seriesNumberHint - offset, normalized.seriesNumberHint + offset);
  }
  for (const seriesNumber of seriesNumbers) {
    if (seriesNumber >= 1 && seriesNumber <= 999) add(`${prefix}${seriesNumber}`, "bounded_series_window");
  }
  return {
    status: "candidates",
    target: normalized,
    candidates,
    limit,
    window: width
  };
}

function metadataFromPage(page = {}) {
  const payload = page?.payload || page;
  const status = normalizeExternalGameStatus(payload?.status || payload?.gameStatus || payload?.game_status);
  return {
    gameDate: text(payload?.gameDate || payload?.game_date || payload?.date),
    gameCode: normalizeCode(payload?.gameCode || payload?.npbGameCode || payload?.game_code || payload?.npb_game_code),
    homeTeam: normalizeScheduleTeamCode(payload?.homeTeam || payload?.home_team),
    awayTeam: normalizeScheduleTeamCode(payload?.awayTeam || payload?.away_team),
    seriesNumber: normalizeSeries(payload?.seriesNumber ?? payload?.series_number ?? payload?.round),
    status,
    startAt: payload?.startAt || payload?.start_at || payload?.startTime || payload?.start_time || ""
  };
}

export function validateGameCodeCandidate(target = {}, candidate = {}, page = {}) {
  const expected = normalizeTarget(target);
  const metadata = metadataFromPage(page);
  const reasons = [];
  const candidateCode = normalizeCode(candidate.gameCode);
  if (!candidateCode) reasons.push("CANDIDATE_CODE_INVALID");
  if (metadata.gameCode !== candidateCode) reasons.push("GAME_CODE_MISMATCH");
  if (!metadata.gameDate || metadata.gameDate !== expected.gameDate) reasons.push("DATE_MISMATCH");
  if (!metadata.homeTeam || metadata.homeTeam !== expected.homeTeam) reasons.push("HOME_TEAM_MISMATCH");
  if (!metadata.awayTeam || metadata.awayTeam !== expected.awayTeam) reasons.push("AWAY_TEAM_MISMATCH");
  if (Number.isInteger(expected.seriesNumberHint) && Number.isInteger(metadata.seriesNumber)
    && expected.seriesNumberHint !== metadata.seriesNumber) reasons.push("SERIES_MISMATCH");
  if (metadata.status && !ACCEPTED_PAGE_STATUSES.has(metadata.status)) reasons.push("STATUS_INVALID");
  return { ok: reasons.length === 0, metadata, rejectionReasons: reasons };
}

function attemptSummary(candidate, result, rejectionReasons = []) {
  return {
    gameCode: candidate.gameCode,
    source: candidate.source,
    httpStatus: Number(result?.httpStatus || result?.response?.status || 0) || null,
    url: typeof result?.url === "string" ? result.url.slice(0, 240) : null,
    rejectionReasons
  };
}

export async function resolveVerifiedGameCode(target = {}, { fetchCandidate, candidateWindow = 2, maxCandidates = MAX_GAME_CODE_CANDIDATES } = {}) {
  if (typeof fetchCandidate !== "function") throw verifierError("GAME_CODE_FETCHER_REQUIRED", "候補ページfetcherが必要です。");
  const discovered = discoverGameCodeCandidates(target, { candidateWindow, maxCandidates });
  if (discovered.status !== "candidates") return discovered;

  const attempts = [];
  const matches = [];
  let temporaryFailure = false;
  let invalidData = false;
  let notFound = 0;
  for (const candidate of discovered.candidates) {
    let result;
    try {
      result = await fetchCandidate(candidate, discovered.target);
    } catch (error) {
      temporaryFailure = true;
      attempts.push(attemptSummary(candidate, { httpStatus: 0, url: "" }, [error?.code || "FETCH_EXCEPTION"]));
      continue;
    }
    const httpStatus = Number(result?.httpStatus || result?.response?.status || 0) || 0;
    if (httpStatus >= 500 || result?.temporaryFailure === true) {
      temporaryFailure = true;
      attempts.push(attemptSummary(candidate, result, ["TEMPORARY_FAILURE"]));
      continue;
    }
    if (httpStatus === 404 || result?.notFound === true) {
      notFound += 1;
      attempts.push(attemptSummary(candidate, result, ["NOT_FOUND"]));
      continue;
    }
    if (httpStatus >= 400) {
      invalidData = true;
      attempts.push(attemptSummary(candidate, result, [`HTTP_${httpStatus}`]));
      continue;
    }
    const parsed = result?.parsed || result?.page || result;
    if (!parsed?.ok) {
      invalidData = true;
      attempts.push(attemptSummary(candidate, result, [parsed?.code || "PAGE_INVALID"]));
      continue;
    }
    const validation = validateGameCodeCandidate(discovered.target, candidate, parsed);
    attempts.push(attemptSummary(candidate, result, validation.rejectionReasons));
    if (!validation.ok) {
      invalidData = true;
      continue;
    }
    matches.push({ candidate, metadata: validation.metadata });
    if (candidate.source === "existing_hint") {
      return {
        status: "verified",
        code: "",
        gameCode: candidate.gameCode,
        target: discovered.target,
        candidate,
        metadata: validation.metadata,
        attempts
      };
    }
  }

  if (temporaryFailure) return { status: "temporary_failure", code: "GAME_CODE_TEMPORARY_FAILURE", target: discovered.target, attempts };
  if (matches.length > 1) return { status: "ambiguous", code: "GAME_CODE_AMBIGUOUS", target: discovered.target, matches, attempts };
  if (matches.length === 1) {
    return {
      status: "verified",
      code: "",
      gameCode: matches[0].candidate.gameCode,
      target: discovered.target,
      candidate: matches[0].candidate,
      metadata: matches[0].metadata,
      attempts
    };
  }
  return {
    status: notFound === discovered.candidates.length ? "not_found" : "invalid_data",
    code: notFound === discovered.candidates.length ? "GAME_CODE_NOT_FOUND" : "GAME_CODE_INVALID_DATA",
    target: discovered.target,
    attempts
  };
}

export function createSimulatorGameCodeFetcher(env, { fetchImpl = globalThis.fetch } = {}) {
  return async (candidate, target) => {
    const fetched = await fetchSimulatorSource(env, {
      mode: "score",
      date: target.gameDate,
      gameCode: candidate.gameCode
    }, { fetchImpl });
    const parsed = await parseSimulatorResponse(fetched.response, { mode: "score" });
    return { url: fetched.url, httpStatus: fetched.response.status, parsed };
  };
}

export function buildVerifiedScorePageUrl(gameDate, gameCode, origin = "https://npb.jp") {
  const date = normalizeDate(gameDate);
  const code = normalizeCode(gameCode);
  let base;
  try { base = new URL(origin); } catch { return ""; }
  if (!date || !code || !["npb.jp", "www.npb.jp"].includes(base.hostname.toLowerCase())
    || base.protocol !== "https:" || base.username || base.password || base.search || base.hash
    || (base.pathname !== "" && base.pathname !== "/")) return "";
  const [year, month, day] = date.split("-");
  return `${base.origin}/scores/${year}/${month}${day}/${encodeURIComponent(code)}/`;
}

export { MAX_GAME_CODE_CANDIDATES };
