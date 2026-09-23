function eligibilityError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function text(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

function isAdminOverride(value) {
  return text(value).toLowerCase().startsWith("admin:");
}

export async function applyEligibilityChange({
  db,
  gameId,
  internalGameId = "",
  status,
  reason = null,
  note = null,
  actor = "system",
  source = "recovery",
  gameStatus = null,
  expectedEligibilityVersion = null,
  officialCorrection = false,
  now = new Date(),
  persist
} = {}) {
  if (!db || typeof persist !== "function") throw eligibilityError("ELIGIBILITY_SERVICE_INVALID", "EligibilityServiceの依存関係が不正です。", { httpStatus: 500 });
  const normalizedStatus = text(status).toLowerCase();
  if (!normalizedStatus) throw eligibilityError("ELIGIBILITY_STATUS_REQUIRED", "対象状態が必要です。", { httpStatus: 400 });
  const current = await db.prepare(
    `SELECT game_id, internal_game_id, game_status, ranking_eligibility_status, ranking_eligibility_reason,
            ranking_eligibility_note, ranking_eligibility_version, ranking_eligibility_updated_by
       FROM ranking_games WHERE game_id = ?1 LIMIT 1`
  ).bind(gameId).first();
  if (!current) throw eligibilityError("RANKING_GAME_NOT_FOUND", "対象試合が見つかりません。", { httpStatus: 404 });
  const currentVersion = Number(current.ranking_eligibility_version || 1);
  if (expectedEligibilityVersion !== null && Number(expectedEligibilityVersion) !== currentVersion) {
    throw eligibilityError("ELIGIBILITY_VERSION_CONFLICT", "対象状態が別の操作で更新されています。", { httpStatus: 409, currentVersion });
  }
  if (String(source).toLowerCase() === "cron" && isAdminOverride(current.ranking_eligibility_updated_by) && !officialCorrection) {
    return { status: "skipped", noOp: true, reason: "MANUAL_OVERRIDE_ACTIVE", current, currentVersion };
  }
  const unchanged = String(current.ranking_eligibility_status || "") === normalizedStatus
    && String(current.ranking_eligibility_reason || "") === String(reason || "")
    && String(current.ranking_eligibility_note || "") === String(note || "")
    && (!gameStatus || String(current.game_status || "") === text(gameStatus).toLowerCase());
  if (unchanged) return { status: "no_change", noOp: true, current, currentVersion };
  const persisted = await persist({
    gameId,
    internalGameId: internalGameId || current.internal_game_id || "",
    status: normalizedStatus,
    reason,
    note,
    updatedBy: `${text(source).toLowerCase() || "recovery"}:${text(actor) || "system"}`.slice(0, 120),
    now,
    officialCorrection
  });
  if (gameStatus) {
    await db.prepare(
      "UPDATE ranking_games SET game_status = ?1, updated_at = ?2 WHERE game_id = ?3"
    ).bind(text(gameStatus).toLowerCase(), (now instanceof Date ? now : new Date(now)).toISOString(), gameId).run();
  }
  return { status: "updated", noOp: false, current, currentVersion, eligibility: persisted };
}
