import { normalizeManualLineupInput, saveActualLineupForAutoScoring } from "../../auth-worker.js";
import {
  FIGHTERS_TEAM_CODE,
  FIGHTERS_TEAM_ID,
  FIGHTERS_PLAYER_MASTER,
  normalizeFightersPlayerName
} from "../../fighters-player-master.js";
import { normalizeScheduleTeamCode } from "../../game-schedule-detection.js";
import { ensureGameContest } from "../contest-identity.js";
import { targetTeamForEnvironment } from "../target-team.js";
import {
  fetchSimulatorSource,
  normalizeExternalGameStatus,
  parseSimulatorResponse,
  resolveNpbSource
} from "../npb-source-adapter.js";

const DEVELOPMENT_ENVIRONMENTS = new Set(["development", "dev", "test", "local"]);
const TRUSTED_SOURCES = new Set(["official", "simulator"]);
const TERMINAL_GAME_STATUSES = new Set(["cancelled", "postponed", "no_game", "service_unavailable"]);
const LINEUP_STATUSES = new Set(["scheduled", "live", "final", "completed", "probable_announced", "lineup_announced"]);
const SOURCE_COLUMN_VALUE = "npb-auto";

function text(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

function iso(value, fallback = new Date()) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value || fallback);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function isDevelopmentEnvironment(environment) {
  return DEVELOPMENT_ENVIRONMENTS.has(text(environment || "test").toLowerCase());
}

function normalizeDate(value) {
  const date = text(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date ? "" : date;
}

function normalizeTarget(target = {}) {
  return {
    internalGameId: text(target.internalGameId || target.internal_game_id),
    gameDate: normalizeDate(target.gameDate || target.game_date || target.date),
    homeTeam: normalizeScheduleTeamCode(target.homeTeam || target.home_team),
    awayTeam: normalizeScheduleTeamCode(target.awayTeam || target.away_team),
    npbGameCode: text(target.npbGameCode || target.npb_game_code || target.gameCode).toLowerCase(),
    status: normalizeExternalGameStatus(target.status || target.gameStatus || target.game_status)
  };
}

function normalizeSource(value) {
  const source = text(value).toLowerCase();
  if (source === "simulator") return "simulator";
  if (source === "npb" || source === "npb-auto" || !source) return "official";
  return source;
}

function normalizeRawLineup(lineup) {
  return (Array.isArray(lineup) ? lineup : []).map((row) => ({
    battingOrder: row?.battingOrder ?? row?.batting_order ?? row?.order,
    playerId: row?.playerId ?? row?.player_id ?? "",
    playerName: row?.playerName ?? row?.player_name ?? row?.name ?? "",
    position: row?.position ?? "",
    uniformNumber: row?.uniformNumber ?? row?.uniform_number ?? row?.jerseyNumber ?? row?.jersey_number ?? row?.number ?? "",
    handedness: row?.handedness ?? row?.bats ?? row?.throws ?? null,
    teamCode: normalizeScheduleTeamCode(row?.teamCode ?? row?.team_code) || FIGHTERS_TEAM_CODE,
    teamId: row?.teamId ?? row?.team_id ?? FIGHTERS_TEAM_ID
  }));
}

function normalizeCandidateMetadata(raw = {}, target = {}, { source = "official", fetchedAt = new Date() } = {}) {
  const payload = raw?.payload && typeof raw.payload === "object" ? raw.payload : raw;
  return {
    internalGameId: text(target.internalGameId || payload.internalGameId || payload.internal_game_id),
    gameDate: normalizeDate(payload.gameDate || payload.game_date || payload.date),
    homeTeam: normalizeScheduleTeamCode(payload.homeTeam || payload.home_team),
    awayTeam: normalizeScheduleTeamCode(payload.awayTeam || payload.away_team),
    npbGameCode: text(payload.npbGameCode || payload.npb_game_code || payload.gameCode || payload.game_code).toLowerCase(),
    source: normalizeSource(source),
    fetchedAt: iso(payload.fetchedAt || payload.fetched_at || fetchedAt),
    status: normalizeExternalGameStatus(payload.status || payload.gameStatus || payload.game_status),
    sourceUrl: text(payload.sourceUrl || payload.source_url).slice(0, 240),
    lineup: normalizeRawLineup(payload.lineup)
  };
}

function identityMismatch(target, candidate) {
  const reasons = [];
  if (!target.internalGameId || (candidate.internalGameId && candidate.internalGameId !== target.internalGameId)) reasons.push("INTERNAL_GAME_ID_MISMATCH");
  if (!target.gameDate || candidate.gameDate !== target.gameDate) reasons.push("DATE_MISMATCH");
  if (!target.homeTeam || candidate.homeTeam !== target.homeTeam) reasons.push("HOME_TEAM_MISMATCH");
  if (!target.awayTeam || candidate.awayTeam !== target.awayTeam) reasons.push("AWAY_TEAM_MISMATCH");
  if (!target.npbGameCode || candidate.npbGameCode !== target.npbGameCode) reasons.push("GAME_CODE_MISMATCH");
  return reasons;
}

function mapValidationStatus(code = "") {
  if (code === "LINEUP_PLAYER_UNKNOWN") return "unknown_player";
  if (code === "LINEUP_PLAYER_ID_MISMATCH") return "identity_mismatch";
  if (code === "LINEUP_PLAYER_AMBIGUOUS") return "ambiguous_player";
  return "invalid_lineup";
}

function unresolvedCandidateResult(candidate, validation) {
  const code = text(validation?.code) || "LINEUP_INVALID";
  return {
    ok: false,
    status: mapValidationStatus(code),
    code,
    candidate,
    validation
  };
}

function canonicalizeKnownPlayerIds(lineup) {
  const byId = new Map(FIGHTERS_PLAYER_MASTER.map((player) => [`${FIGHTERS_TEAM_ID}-${player.uniformNumber}`, player]));
  return lineup.map((row) => {
    const player = byId.get(text(row.playerId));
    if (!player || (row.uniformNumber && text(row.uniformNumber) !== player.uniformNumber)) return row;
    return { ...row, playerName: player.name, uniformNumber: player.uniformNumber };
  });
}

function hasAmbiguousExternalIdentity(lineup, trustedTemporaryPlayers) {
  const aliases = (Array.isArray(FIGHTERS_PLAYER_MASTER) ? FIGHTERS_PLAYER_MASTER : []).flatMap((player) =>
    [player.name, ...(Array.isArray(player.aliases) ? player.aliases : [])]
      .map((name) => [normalizeFightersPlayerName(name), player.uniformNumber])
  );
  for (const row of lineup) {
    const name = normalizeFightersPlayerName(row.playerName);
    if (name && new Set(aliases.filter(([alias]) => alias === name).map(([, number]) => number)).size > 1) return true;
    const temporaryMatches = (Array.isArray(trustedTemporaryPlayers) ? trustedTemporaryPlayers : [])
      .filter((entry) => normalizeFightersPlayerName(entry?.name || entry?.playerName) === name);
    if (temporaryMatches.length > 1) return true;
  }
  return false;
}

/**
 * Converts an external result into the existing Starting9 scoring shape. The
 * manual-lineup normalizer is intentionally reused here: it owns position
 * aliases, Fighters identity checks, duplicate detection, and temporary NPB
 * player handling. This service only adds external identity and lifecycle
 * rules around that canonical helper.
 */
export function createLineupCandidate(raw, target = {}, {
  source = "official",
  fetchedAt = new Date(),
  trustedTemporaryPlayers = []
} = {}) {
  const normalizedTarget = normalizeTarget(target);
  const candidate = normalizeCandidateMetadata(raw, normalizedTarget, { source, fetchedAt });
  const identityReasons = identityMismatch(normalizedTarget, candidate);
  if (identityReasons.length) {
    return {
      ok: false,
      status: "identity_mismatch",
      code: "LINEUP_IDENTITY_MISMATCH",
      candidate,
      validation: { ok: false, code: "LINEUP_IDENTITY_MISMATCH", rejectionReasons: identityReasons }
    };
  }
  if (TERMINAL_GAME_STATUSES.has(candidate.status)) {
    return {
      ok: false,
      status: candidate.status === "no_game" ? "no_game" : "cancelled",
      code: candidate.status === "no_game" ? "GAME_NO_GAME" : "GAME_CANCELLED",
      candidate,
      validation: { ok: false, code: candidate.status === "no_game" ? "GAME_NO_GAME" : "GAME_CANCELLED" }
    };
  }
  if (candidate.status && !LINEUP_STATUSES.has(candidate.status)) {
    return unresolvedCandidateResult(candidate, { ok: false, code: "LINEUP_STATUS_INVALID", rejectionReasons: ["LINEUP_STATUS_INVALID"] });
  }

  if (hasAmbiguousExternalIdentity(candidate.lineup, trustedTemporaryPlayers)) {
    return unresolvedCandidateResult(candidate, { ok: false, code: "LINEUP_PLAYER_AMBIGUOUS", rejectionReasons: ["LINEUP_PLAYER_AMBIGUOUS"] });
  }
  const normalized = normalizeManualLineupInput(canonicalizeKnownPlayerIds(candidate.lineup), { trustedTemporaryPlayers });
  if (!normalized.ok) return unresolvedCandidateResult(candidate, normalized);
  const rawByOrder = new Map(candidate.lineup.map((row) => [Number(row.battingOrder), row]));
  const canonicalCandidate = {
    ...candidate,
    lineup: normalized.lineup.map((row) => ({
      ...row,
      ...(rawByOrder.get(Number(row.battingOrder))?.handedness ? { handedness: rawByOrder.get(Number(row.battingOrder)).handedness } : {})
    })),
    validation: {
      ok: true,
      status: "verified",
      playerCount: normalized.lineup.length,
      unresolvedPlayerCount: normalized.lineup.filter((row) => !row.playerId).length
    }
  };
  return { ok: true, status: "verified", code: "LINEUP_VERIFIED", candidate: canonicalCandidate, validation: canonicalCandidate.validation };
}

export function isAutoFinalEligible({ candidate, verification, environment = "test", autoFinalEnabled = false, manualFinalExists = false, shadowMode = false } = {}) {
  const source = normalizeSource(candidate?.source);
  const status = normalizeExternalGameStatus(candidate?.status);
  const allowed = isDevelopmentEnvironment(environment)
    && autoFinalEnabled === true
    && verification?.status === "verified"
    && !manualFinalExists
    && !TERMINAL_GAME_STATUSES.has(status)
    && TRUSTED_SOURCES.has(source)
    && !shadowMode;
  return {
    eligible: allowed,
    reason: allowed ? "VERIFIED_TRUSTED_CANDIDATE" : (
      manualFinalExists ? "MANUAL_FINAL_EXISTS"
        : shadowMode ? "SHADOW_MODE_AUTO_FINAL_DISABLED"
        : !isDevelopmentEnvironment(environment) ? "PRODUCTION_AUTO_FINAL_DISABLED"
          : !autoFinalEnabled ? "AUTO_FINAL_DISABLED"
            : verification?.status !== "verified" ? "CANDIDATE_NOT_VERIFIED"
              : TERMINAL_GAME_STATUSES.has(status) ? "GAME_UNAVAILABLE"
                : "SOURCE_NOT_TRUSTED"
    )
  };
}

async function tableColumns(db, table) {
  const result = await db.prepare(`PRAGMA table_info(${table})`).bind().all();
  return new Set((result.results || []).map((row) => text(row.name)));
}

function revisionScope(columns, candidate) {
  if (columns.has("internal_game_id") && candidate.internalGameId) return { column: "internal_game_id", value: candidate.internalGameId };
  return { column: "game_id", value: candidate.internalGameId };
}

function candidateRevisionPayload(candidate, validation, lifecycleStatus, { shadowMode = false } = {}) {
  return JSON.stringify({
    phase: "v5-lineup-candidate",
    shadowMode: Boolean(shadowMode),
    lifecycleStatus,
    source: candidate.source,
    sourceTrust: TRUSTED_SOURCES.has(candidate.source) ? "trusted_development_source" : "untrusted",
    fetchedAt: candidate.fetchedAt,
    gameDate: candidate.gameDate,
    homeTeam: candidate.homeTeam,
    awayTeam: candidate.awayTeam,
    npbGameCode: candidate.npbGameCode,
    sourceUrl: candidate.sourceUrl || null,
    validation
  });
}

export async function persistLineupCandidate(db, candidate, validation, { now = new Date(), shadowMode = false } = {}) {
  if (!db || !candidate?.internalGameId) return { ok: false, status: "schema_unavailable", code: "LINEUP_CANDIDATE_DB_REQUIRED" };
  const columns = await tableColumns(db, "game_lineup_revisions");
  const required = ["game_id", "version", "actual_lineup_json", "lineup_fingerprint", "source", "created_at", "reason", "is_current"];
  if (required.some((column) => !columns.has(column)) || !columns.has("internal_game_id")) {
    return { ok: false, status: "schema_unavailable", code: "LINEUP_CANDIDATE_SCHEMA_NOT_READY" };
  }
  const scope = revisionScope(columns, candidate);
  const rows = await db.prepare(`SELECT * FROM game_lineup_revisions WHERE ${scope.column} = ?1 ORDER BY version DESC`).bind(scope.value).all();
  const existingRows = rows.results || [];
  const manualFinal = existingRows.find((row) => Number(row.is_final || 0) === 1
    && ["manual", "manual-revision", "restore"].includes(text(row.source).toLowerCase()));
  if (manualFinal) return { ok: false, status: "manual_final_exists", code: "MANUAL_FINAL_EXISTS", revision: manualFinal };

  const actualJson = JSON.stringify(Array.isArray(candidate.lineup) ? candidate.lineup : []);
  const fingerprintBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(actualJson));
  const fingerprint = btoa(String.fromCharCode(...new Uint8Array(fingerprintBuffer)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const same = existingRows.find((row) => text(row.lineup_fingerprint) === fingerprint);
  if (same) {
    if (candidate.contestId) await mirrorContestLineupRevision(db, candidate, same);
    return { ok: true, status: "no_op", noOp: true, revision: same };
  }

  const version = Number(existingRows[0]?.version || 0) + 1;
  const createdAt = iso(now);
  if (!createdAt) return { ok: false, status: "invalid_data", code: "LINEUP_CANDIDATE_TIME_INVALID" };
  const fields = ["game_id", "version", "actual_lineup_json", "lineup_fingerprint", "source", "created_at", "reason", "is_current"];
  const values = [candidate.internalGameId, version, actualJson, fingerprint, SOURCE_COLUMN_VALUE, createdAt, "Phase 7 automatic lineup candidate", 0];
  const optional = [
    ["revision_id", `${candidate.internalGameId}:${version}`],
    ["internal_game_id", candidate.internalGameId],
    ["captured_at", candidate.fetchedAt || createdAt],
    ["validation_json", candidateRevisionPayload(candidate, validation, validation?.ok ? "verified" : "rejected", { shadowMode })],
    ["unresolved_player_count", Array.isArray(candidate.lineup) ? candidate.lineup.filter((row) => !row?.playerId).length : 0],
    ["is_final", 0],
    ["superseded_at", null]
  ];
  for (const [column, value] of optional) {
    if (columns.has(column)) { fields.push(column); values.push(value); }
  }
  const placeholders = fields.map((_, index) => `?${index + 1}`).join(", ");
  try {
    await db.prepare(`INSERT INTO game_lineup_revisions (${fields.join(", ")}) VALUES (${placeholders})`).bind(...values).run();
  } catch (error) {
    if (!/constraint|unique|primary key/i.test(String(error?.message || ""))) throw error;
    const concurrent = await db.prepare(`SELECT * FROM game_lineup_revisions WHERE ${scope.column} = ?1 ORDER BY version DESC LIMIT 1`).bind(scope.value).first();
    if (concurrent && text(concurrent.lineup_fingerprint) === fingerprint) return { ok: true, status: "no_op", noOp: true, revision: concurrent };
    return { ok: false, status: "conflict", code: "LINEUP_CANDIDATE_REVISION_CONFLICT" };
  }
  const revision = await db.prepare(`SELECT * FROM game_lineup_revisions WHERE ${scope.column} = ?1 AND version = ?2 LIMIT 1`).bind(scope.value, version).first();
  if (candidate.contestId) await mirrorContestLineupRevision(db, candidate, revision);
  return { ok: true, status: "created", noOp: false, revision };
}

async function mirrorContestLineupRevision(db, candidate, revision) {
  const existing = await db.prepare(
    "SELECT lineup_fingerprint FROM contest_lineup_revisions WHERE contest_id = ?1 AND version = ?2 LIMIT 1"
  ).bind(candidate.contestId, Number(revision.version)).first();
  if (existing) {
    if (String(existing.lineup_fingerprint || "") !== String(revision.lineup_fingerprint || "")) {
      throw Object.assign(new Error("Contest lineup revision conflicts with the legacy bridge revision"), { code: "CONTEST_LINEUP_REVISION_CONFLICT" });
    }
    return;
  }
  await db.prepare(`INSERT INTO contest_lineup_revisions
    (contest_id,internal_game_id,game_id,version,revision_id,actual_lineup_json,lineup_fingerprint,
     source,created_at,created_by,reason,is_current,superseded_at,captured_at,validation_json,
     finalized_at,finalized_by,unresolved_player_count,is_final)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)`)
    .bind(candidate.contestId,candidate.internalGameId,revision.game_id,Number(revision.version),revision.revision_id,
      revision.actual_lineup_json,revision.lineup_fingerprint,revision.source,revision.created_at,
      revision.created_by ?? null,revision.reason,Number(revision.is_current || 0),revision.superseded_at ?? null,
      revision.captured_at ?? null,revision.validation_json ?? null,revision.finalized_at ?? null,
      revision.finalized_by ?? null,Number(revision.unresolved_player_count || 0),Number(revision.is_final || 0)).run();
}

export async function finalizeVerifiedLineupCandidate(db, { candidate, revision, now = new Date(), allowTestGame = false, contestId = "", targetTeam = null } = {}) {
  if (!db || !candidate?.internalGameId || !revision) return { ok: false, status: "invalid_data", code: "LINEUP_FINALIZE_INPUT_INVALID" };
  const lineupColumns = await tableColumns(db, "game_lineups");
  const resolvedTargetTeam = targetTeam || targetTeamForEnvironment({});
  if (lineupColumns.has("contest_id")) {
    const contest = await ensureGameContest(db, candidate.internalGameId, resolvedTargetTeam, contestId);
    if (!contest.ok) return { ok: false, status: "identity_mismatch", code: contest.code };
    contestId = contest.contestId;
  }
  const columns = await tableColumns(db, "game_lineup_revisions");
  if (!(columns.has("internal_game_id") && columns.has("is_final") && columns.has("is_current"))) {
    return { ok: false, status: "schema_unavailable", code: "LINEUP_CANDIDATE_SCHEMA_NOT_READY" };
  }
  const scope = "internal_game_id";
  const currentRows = await db.prepare(
    `SELECT * FROM game_lineup_revisions WHERE ${scope} = ?1 ORDER BY version DESC`
  ).bind(candidate.internalGameId).all();
  const manualFinal = (currentRows.results || []).find((row) => Number(row.is_final || 0) === 1
    && ["manual", "manual-revision", "restore"].includes(text(row.source).toLowerCase()));
  if (manualFinal) return { ok: false, status: "manual_final_exists", code: "MANUAL_FINAL_EXISTS", revision: manualFinal };

  const timestamp = iso(now);
  if (!timestamp) return { ok: false, status: "invalid_data", code: "LINEUP_CANDIDATE_TIME_INVALID" };
  const deactivate = db.prepare(
    `UPDATE game_lineup_revisions SET is_current = 0, superseded_at = ?1
      WHERE ${scope} = ?2 AND is_current = 1 AND is_final = 0`
  ).bind(timestamp, candidate.internalGameId);
  const activate = db.prepare(
    `UPDATE game_lineup_revisions
        SET is_current = 1, is_final = 1, finalized_at = ?1, finalized_by = 'phase7:auto'
      WHERE ${scope} = ?2 AND version = ?3 AND is_final = 0
        AND NOT EXISTS (
          SELECT 1 FROM game_lineup_revisions manual
           WHERE manual.${scope} = ?2 AND manual.is_final = 1
             AND manual.source IN ('manual', 'manual-revision', 'restore')
        )
        AND NOT EXISTS (
          SELECT 1 FROM game_lineup_revisions newer
           WHERE newer.${scope} = ?2 AND newer.version > ?3
        )`
  ).bind(timestamp, candidate.internalGameId, Number(revision.version));
  await db.batch([deactivate, activate]);
  const finalized = await db.prepare(
    `SELECT * FROM game_lineup_revisions WHERE ${scope} = ?1 AND version = ?2 LIMIT 1`
  ).bind(candidate.internalGameId, Number(revision.version)).first();
  if (Number(finalized?.is_final || 0) !== 1) {
    const manual = await db.prepare(
      `SELECT * FROM game_lineup_revisions WHERE ${scope} = ?1 AND is_final = 1 AND source IN ('manual', 'manual-revision', 'restore') LIMIT 1`
    ).bind(candidate.internalGameId).first();
    return manual
      ? { ok: false, status: "manual_final_exists", code: "MANUAL_FINAL_EXISTS", revision: manual }
      : { ok: false, status: "conflict", code: "LINEUP_FINALIZE_CONFLICT" };
  }

  if (contestId) {
    const timestamp = iso(now);
    await db.batch([
      db.prepare(`UPDATE contest_lineup_revisions SET is_current=0,superseded_at=?1
        WHERE contest_id=?2 AND is_current=1 AND is_final=0 AND version<>?3`).bind(timestamp,contestId,Number(revision.version)),
      db.prepare(`UPDATE contest_lineup_revisions SET is_current=1,is_final=1,finalized_at=?1,finalized_by='phase7:auto'
        WHERE contest_id=?2 AND version=?3 AND lineup_fingerprint=?4 AND actual_lineup_json=?5`)
        .bind(timestamp,contestId,Number(revision.version),revision.lineup_fingerprint,revision.actual_lineup_json)
    ]);
    const scopedFinal = await db.prepare(`SELECT is_current,is_final FROM contest_lineup_revisions
      WHERE contest_id=?1 AND version=?2 LIMIT 1`).bind(contestId,Number(revision.version)).first();
    if (Number(scopedFinal?.is_current || 0) !== 1 || Number(scopedFinal?.is_final || 0) !== 1) {
      return { ok: false, status: "conflict", code: "CONTEST_LINEUP_FINALIZE_CONFLICT" };
    }
  }

  try {
    // Manual finalization first creates the canonical game_lineups row through
    // the shared scoring-compatible writer. Reuse that boundary so an
    // automatic candidate has the same downstream artifact shape and scoring
    // metadata as a manual final, including when the row does not exist yet.
    await saveActualLineupForAutoScoring(
      db,
      candidate.internalGameId,
      candidate.lineup,
      new Date(timestamp),
      {
        allowTestGame,
        // Legacy fixtures without A2 schema keep their isolated game-only
        // writer. Once contest columns exist, even Test Site finalization must
        // identify the exact registered contest before touching the canonical row.
        isTestGame: !lineupColumns.has("contest_id"),
        allowAfterStart: allowTestGame,
        internalGameId: candidate.internalGameId,
        contestId,
        targetTeam: resolvedTargetTeam,
        source: SOURCE_COLUMN_VALUE,
        scoringDueAt: new Date(timestamp),
        now: new Date(timestamp)
      }
    );
    if (lineupColumns.has("internal_game_id") && lineupColumns.has("final_lineup_revision_id")) {
      const fields = ["actual_lineup_json", "lineup_fingerprint", "final_lineup_revision_id"];
      const values = [finalized.actual_lineup_json, finalized.lineup_fingerprint, finalized.revision_id || `${candidate.internalGameId}:${Number(revision.version)}`];
      if (lineupColumns.has("finalized_at")) { fields.push("finalized_at"); values.push(timestamp); }
      if (lineupColumns.has("finalized_by")) { fields.push("finalized_by"); values.push("phase7:auto"); }
      if (lineupColumns.has("lineup_source")) { fields.push("lineup_source"); values.push("npb-auto"); }
      if (lineupColumns.has("updated_at")) { fields.push("updated_at"); values.push(timestamp); }
      values.push(candidate.internalGameId);
      const contestFilter = lineupColumns.has("contest_id") ? ` AND contest_id = ?${values.length + 1}` : "";
      if (lineupColumns.has("contest_id")) values.push(contestId);
      await db.prepare(`UPDATE game_lineups SET ${fields.map((field, index) => `${field} = ?${index + 1}`).join(", ")} WHERE internal_game_id = ?${values.length - (lineupColumns.has("contest_id") ? 1 : 0)}${contestFilter}`).bind(...values).run();
    }
  } catch (error) {
    if (!/no such table|table .* not found/i.test(String(error?.message || ""))) throw error;
  }
  return { ok: true, status: "finalized", revision: finalized };
}

function classifyFetchFailure(error) {
  const code = text(error?.code).toUpperCase();
  if (["LINEUP_NOT_PUBLISHED", "NOT_PUBLISHED"].includes(code)) return { status: "not_published", code: "LINEUP_NOT_PUBLISHED" };
  if (["GAME_CANCELLED", "CANCELLED"].includes(code)) return { status: "cancelled", code: "GAME_CANCELLED" };
  if (["GAME_NO_GAME", "NO_GAME"].includes(code)) return { status: "no_game", code: "GAME_NO_GAME" };
  if (["NPB_RESPONSE_INVALID", "LINEUP_PARSE_FAILED", "LINEUP_INVALID"].includes(code)) return { status: "invalid_lineup", code };
  return { status: "temporary_failure", code: code || "LINEUP_FETCH_TEMPORARY_FAILURE" };
}

export async function fetchLineupCandidateForGame(env, target, { fetchOfficial, fetchImpl = globalThis.fetch, signal, now = new Date() } = {}) {
  const sourceSelection = resolveNpbSource(env);
  const source = sourceSelection.kind;
  let result;
  try {
    if (source === "simulator") {
      const fetched = await fetchSimulatorSource(env, { mode: "lineup", date: target?.gameDate, gameCode: target?.npbGameCode }, { fetchImpl, signal });
      const parsed = await parseSimulatorResponse(fetched.response, { mode: "lineup" });
      result = { ...parsed, httpStatus: fetched.response.status, sourceUrl: fetched.url };
    } else {
      if (typeof fetchOfficial !== "function") return { ok: false, status: "temporary_failure", code: "OFFICIAL_LINEUP_FETCHER_REQUIRED", source };
      result = await fetchOfficial({ target, signal });
    }
  } catch (error) {
    return { ok: false, ...classifyFetchFailure(error), source, error: text(error?.message).slice(0, 160) };
  }
  const httpStatus = Number(result?.httpStatus || result?.response?.status || 0);
  if (httpStatus === 404 || httpStatus >= 500) return { ok: false, status: "temporary_failure", code: `LINEUP_HTTP_${httpStatus || "ERROR"}`, source };
  if (result?.ok === false || result?.parsed?.ok === false) {
    const failure = result?.parsed?.code ? { code: result.parsed.code } : result;
    return { ok: false, ...classifyFetchFailure(failure), source, httpStatus: httpStatus || null };
  }
  const payload = result?.payload || result?.parsed?.payload || result;
  const externalStatus = normalizeExternalGameStatus(payload?.status || payload?.gameStatus || payload?.game_status);
  if (externalStatus === "cancelled") return { ok: false, status: "cancelled", code: "GAME_CANCELLED", source, payload };
  if (externalStatus === "no_game") return { ok: false, status: "no_game", code: "GAME_NO_GAME", source, payload };
  if (!Array.isArray(payload?.lineup) || payload.lineup.length === 0) return { ok: false, status: "not_published", code: "LINEUP_NOT_PUBLISHED", source, payload };
  return { ok: true, status: "fetched", source, payload: { ...payload, sourceUrl: payload.sourceUrl || result?.sourceUrl || "" }, fetchedAt: now };
}

export function buildLineupAlertSignal(result, { missingAfterGrace = false } = {}) {
  if (!result || ["cancelled", "no_game"].includes(result.status)) return {};
  if (result.status === "not_published" && missingAfterGrace) return { lineupAutoFailed: true };
  if (result.status === "temporary_failure" && missingAfterGrace) return { lineupAutoFailed: true };
  if (result.status === "invalid_lineup") return { lineupInvalid: true };
  if (result.status === "unknown_player") return { lineupInvalid: true };
  if (result.status === "ambiguous_player") return { lineupPlayerAmbiguous: true };
  if (result.status === "identity_mismatch") return { lineupIdentityMismatch: true };
  return {};
}

export async function runLineupCandidatePipeline({ env = {}, target = {}, db = null, fetchOfficial, fetchImpl, signal, now = new Date(), autoFinalEnabled = false, trustedTemporaryPlayers = [], shadowMode = false } = {}) {
  const fetched = await fetchLineupCandidateForGame(env, target, { fetchOfficial, fetchImpl, signal, now });
  if (!fetched.ok) return { ...fetched, alertSignal: buildLineupAlertSignal(fetched) };
  const normalized = createLineupCandidate(fetched.payload, target, {
    source: fetched.source,
    fetchedAt: fetched.fetchedAt || now,
    trustedTemporaryPlayers
  });
  if (!normalized.ok) {
    const persisted = db ? await persistLineupCandidate(db, normalized.candidate, normalized.validation, { now, shadowMode }) : null;
    return { ...normalized, persisted, alertSignal: buildLineupAlertSignal(normalized) };
  }
  let candidate = normalized.candidate;
  let targetTeam = null;
  if (db) {
    const lineupColumns = await tableColumns(db, "game_lineups");
    if (lineupColumns.has("contest_id")) {
      targetTeam = targetTeamForEnvironment(env);
      const contest = await ensureGameContest(db, candidate.internalGameId, targetTeam, target?.contestId || "");
      if (!contest.ok) return { ...normalized, ok: false, status: "identity_mismatch", code: contest.code, alertSignal: buildLineupAlertSignal({ status: "identity_mismatch" }) };
      candidate = { ...candidate, contestId: contest.contestId, targetTeamKey: targetTeam.key };
    }
  }
  const persisted = db ? await persistLineupCandidate(db, candidate, normalized.validation, { now, shadowMode }) : null;
  if (persisted?.status === "manual_final_exists") {
    return { ...normalized, status: "manual_final_exists", code: "MANUAL_FINAL_EXISTS", persisted, eligibility: { eligible: false, reason: "MANUAL_FINAL_EXISTS" } };
  }
  const manualFinalExists = Boolean(persisted?.revision && Number(persisted.revision.is_final || 0) === 1
    && ["manual", "manual-revision", "restore"].includes(text(persisted.revision.source).toLowerCase()));
  const verification = { status: "verified", candidate: normalized.candidate, validation: normalized.validation };
  const environment = env.ENVIRONMENT || env.APP_ENV
    || (String(env.ENABLE_DEVELOPMENT_MODE || "").trim().toLowerCase() === "false" ? "production" : "test");
  const eligibility = isAutoFinalEligible({ candidate: normalized.candidate, verification, environment, autoFinalEnabled, manualFinalExists, shadowMode });
  if (!eligibility.eligible || !autoFinalEnabled || !persisted?.revision || !db) return { ...normalized, source: normalized.candidate.source, persisted, verification, eligibility, alertSignal: {} };
  const finalized = await finalizeVerifiedLineupCandidate(db, {
    candidate,
    revision: persisted.revision,
    now,
    allowTestGame: true,
    contestId: candidate.contestId || "",
    targetTeam
  });
  return { ...normalized, source: normalized.candidate.source, persisted, verification, eligibility, finalized, alertSignal: {} };
}

export { DEVELOPMENT_ENVIRONMENTS, TERMINAL_GAME_STATUSES };
