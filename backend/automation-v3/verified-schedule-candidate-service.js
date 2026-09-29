import {
  discoverAdditionalScheduleCandidates,
  normalizeScheduleCandidate,
  registerDevelopmentScheduleCandidate,
  scheduleCandidateKeys,
  validateScheduleCandidate
} from "./schedule-candidate-service.js";
import { resolveVerifiedGameCode } from "../npb-game-code-verifier.js";

const DEVELOPMENT_ENVIRONMENTS = new Set(["development", "dev", "test", "local"]);
const TERMINAL_PAGE_STATUSES = new Set(["cancelled", "postponed", "no_game"]);

function text(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

function errorCode(error, fallback = "SCHEDULE_CANDIDATE_INVALID") {
  return text(error?.code) || fallback;
}

function asEnvironment(value) {
  return text(value || "test").toLowerCase();
}

function isDevelopmentEnvironment(value) {
  return DEVELOPMENT_ENVIRONMENTS.has(asEnvironment(value));
}

function resultBase(candidate = null) {
  return {
    candidate,
    originalNpbGameCode: candidate?.npbGameCode || null,
    verifiedNpbGameCode: null,
    verification: null
  };
}

function normalizeKnownGames(knownGames) {
  return (Array.isArray(knownGames) ? knownGames : []).flatMap((raw) => {
    try { return [normalizeScheduleCandidate(raw, { source: "starting9" })]; } catch { return []; }
  });
}

function findCheapDuplicate(candidate, knownGames) {
  const candidateKeys = new Set(scheduleCandidateKeys(candidate));
  return normalizeKnownGames(knownGames).find((known) =>
    scheduleCandidateKeys(known).some((key) => candidateKeys.has(key))
  ) || null;
}

function registerability(candidate, verification, requiredTeam) {
  const candidateValidation = validateScheduleCandidate(candidate, { requiredTeam });
  if (!candidateValidation.ok) return candidateValidation.errors;
  const pageStatus = text(verification?.metadata?.status).toLowerCase();
  if (TERMINAL_PAGE_STATUSES.has(pageStatus)) return ["verified_page_terminal"];
  return [];
}

function verificationEvidence(verification) {
  return {
    requestedGameDate: verification?.target?.gameDate || null,
    verifiedPageDate: verification?.metadata?.gameDate || null,
    homeTeam: verification?.metadata?.homeTeam || null,
    awayTeam: verification?.metadata?.awayTeam || null,
    gameCode: verification?.metadata?.gameCode || verification?.gameCode || null,
    seriesNumber: Number.isInteger(verification?.metadata?.seriesNumber)
      ? verification.metadata.seriesNumber : null,
    status: verification?.metadata?.status || null,
    outcome: verification?.status || null
  };
}

function failedVerification(candidate, verification) {
  return {
    ...resultBase(candidate),
    status: "verification_failed",
    reason: verification?.status || "invalid_data",
    code: verification?.code || "GAME_CODE_VERIFICATION_FAILED",
    verification,
    evidence: verificationEvidence(verification)
  };
}

async function prepareVerifiedCandidate(candidate, {
  fetchCandidate,
  candidateWindow,
  maxCandidates,
  requiredTeam
} = {}) {
  let verification;
  try {
    verification = await resolveVerifiedGameCode(candidate, {
      fetchCandidate,
      candidateWindow,
      maxCandidates
    });
  } catch (error) {
    return {
      ...resultBase(candidate),
      status: "verification_failed",
      reason: "invalid_data",
      code: errorCode(error, "GAME_CODE_VERIFICATION_FAILED"),
      error: text(error?.message) || "game code verification failed"
    };
  }
  if (verification.status !== "verified") return failedVerification(candidate, verification);

  const verifiedCode = verification.gameCode;
  const verifiedSeries = Number.isInteger(verification.metadata?.seriesNumber)
    ? verification.metadata.seriesNumber : candidate.seriesNumber;
  const verifiedCandidate = normalizeScheduleCandidate({
    ...candidate,
    npbGameCode: verifiedCode,
    seriesNumber: verifiedSeries
  }, { source: candidate.source });
  const errors = registerability(verifiedCandidate, verification, requiredTeam);
  if (errors.length) {
    return {
      ...resultBase(candidate),
      status: "not_registerable",
      code: "SCHEDULE_CANDIDATE_NOT_REGISTERABLE",
      errors,
      verifiedCandidate,
      verifiedNpbGameCode: verifiedCode,
      verification,
      evidence: verificationEvidence(verification)
    };
  }
  return {
    ...resultBase(candidate),
    status: "verified",
    verifiedCandidate,
    verifiedNpbGameCode: verifiedCode,
    verification,
    evidence: verificationEvidence(verification)
  };
}

function observedCandidateResult(discovery, knownGames, requiredTeam) {
  const observed = discovery.observed?.[0] || null;
  if (!observed) {
    return {
      status: "verification_failed",
      reason: "invalid_data",
      code: discovery.rejected?.[0]?.reason || "SCHEDULE_CANDIDATE_INVALID",
      candidate: null,
      verification: null
    };
  }
  const duplicate = findCheapDuplicate(observed, knownGames);
  if (duplicate) {
    return {
      ...resultBase(observed),
      status: "duplicate",
      code: "SCHEDULE_CANDIDATE_DUPLICATE",
      existingInternalGameId: duplicate.internalGameId || duplicate.internal_game_id || null
    };
  }
  const validation = validateScheduleCandidate(observed, { requiredTeam });
  return {
    ...resultBase(observed),
    status: "not_registerable",
    code: "SCHEDULE_CANDIDATE_NOT_REGISTERABLE",
    errors: validation.errors.length ? validation.errors : ["no_registerable_candidate"]
  };
}

/**
 * Connects Phase 5 identity verification to the Phase 4 candidate lifecycle.
 * The returned candidate is a new value; the external observation is never
 * mutated, so replacement/original audit relationships remain intact.
 */
export async function registerVerifiedDevelopmentScheduleCandidates(db, externalGames = [], knownGames = [], {
  environment = "test",
  requiredTeam = "fighters",
  source = "external",
  fetchCandidate,
  candidateWindow = 2,
  maxCandidates = 7,
  createId,
  now
} = {}) {
  if (!isDevelopmentEnvironment(environment)) {
    return {
      status: "production_disabled",
      code: "SCHEDULE_CANDIDATE_REGISTRATION_DISABLED",
      results: []
    };
  }
  if (typeof fetchCandidate !== "function") {
    return {
      status: "verification_failed",
      code: "GAME_CODE_FETCHER_REQUIRED",
      results: []
    };
  }

  const discovery = discoverAdditionalScheduleCandidates(externalGames, knownGames, { requiredTeam, source });
  const results = [];
  for (const rejected of discovery.rejected || []) {
    results.push({
      status: "verification_failed",
      reason: "invalid_data",
      code: rejected.reason,
      externalGameId: rejected.externalGameId
    });
  }

  if (!discovery.candidates.length && !results.length && Array.isArray(externalGames) && externalGames.length) {
    results.push(observedCandidateResult(discovery, knownGames, requiredTeam));
  }

  for (const candidate of discovery.candidates) {
    const prepared = await prepareVerifiedCandidate(candidate, {
      fetchCandidate,
      candidateWindow,
      maxCandidates,
      requiredTeam
    });
    if (prepared.status !== "verified") {
      results.push(prepared);
      continue;
    }
    const duplicate = findCheapDuplicate(prepared.verifiedCandidate, knownGames);
    if (duplicate) {
      results.push({
        ...prepared,
        status: "duplicate",
        code: "SCHEDULE_CANDIDATE_DUPLICATE",
        existingInternalGameId: duplicate.internalGameId || duplicate.internal_game_id || null
      });
      continue;
    }
    try {
      const registered = await registerDevelopmentScheduleCandidate(db, prepared.verifiedCandidate, {
        environment,
        createId,
        now,
        requiredTeam
      });
      results.push({
        ...prepared,
        ...registered,
        candidate,
        status: registered.status,
        originalNpbGameCode: candidate.npbGameCode,
        verifiedNpbGameCode: prepared.verifiedNpbGameCode,
        verification: prepared.verification,
        evidence: prepared.evidence
      });
    } catch (error) {
      results.push({
        ...prepared,
        status: "not_registerable",
        code: errorCode(error, "SCHEDULE_CANDIDATE_REGISTRATION_FAILED"),
        error: text(error?.message) || "schedule candidate registration failed"
      });
    }
  }

  return { status: "completed", results, discovery };
}

export async function registerVerifiedDevelopmentScheduleCandidate(db, externalCandidate, knownGames = [], options = {}) {
  const result = await registerVerifiedDevelopmentScheduleCandidates(db, [externalCandidate], knownGames, options);
  return result.results[0] || {
    status: result.status,
    reason: result.status === "production_disabled" ? "production_disabled" : "invalid_data",
    code: result.code || "SCHEDULE_CANDIDATE_NOT_FOUND"
  };
}
