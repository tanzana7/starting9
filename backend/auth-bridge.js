const encoder = new TextEncoder();
export const AUTH_BRIDGE_AUDIENCE = "asia-cs";
export const AUTH_BRIDGE_MAX_AGE_MS = 30_000;
const AUTH_BRIDGE_MAX_FUTURE_SKEW_MS = 5_000;
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ROLE_PATTERN = /^(admin|user)$/;

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function signature(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(String(secret || "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

export async function sha256Base64Url(value = "") {
  let bytes;
  if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    bytes = encoder.encode(String(value));
  }
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function constantTimeEqual(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

export async function createAuthBridgeAssertion({
  secret,
  user,
  method,
  path,
  query = "",
  bodyDigest = "",
  audience = AUTH_BRIDGE_AUDIENCE,
  csrfValidated = false,
  now = Date.now()
} = {}) {
  if (!String(secret || "").trim()
    || typeof user?.id !== "string"
    || !USER_ID_PATTERN.test(user.id.trim())
    || typeof user?.role !== "string"
    || !ROLE_PATTERN.test(user.role.trim().toLowerCase())
    || !method
    || !path
    || !audience
    || typeof query !== "string"
    || typeof bodyDigest !== "string") return "";
  const payload = encodeBase64Url(encoder.encode(JSON.stringify({
    v: 1,
    aud: String(audience),
    iat: Number(now),
    method: String(method).toUpperCase(),
    path: String(path),
    query,
    bodyDigest,
    csrfValidated: csrfValidated === true,
    userId: String(user.id),
    username: String(user.username || "").slice(0, 80),
    role: String(user.role || "user").toLowerCase() === "admin" ? "admin" : "user"
  })));
  const message = `v1.${payload}`;
  return `${message}.${encodeBase64Url(await signature(secret, message))}`;
}

export async function verifyAuthBridgeAssertion(assertion, {
  secret,
  method,
  path,
  query = "",
  bodyDigest = "",
  audience = AUTH_BRIDGE_AUDIENCE,
  requireCsrf = false,
  now = Date.now(),
  maxAgeMs = AUTH_BRIDGE_MAX_AGE_MS
} = {}) {
  if (!String(secret || "").trim() || !assertion) return null;
  const parts = String(assertion).split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const message = `${parts[0]}.${parts[1]}`;
  let payload;
  let suppliedSignature;
  try {
    payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1])));
    suppliedSignature = decodeBase64Url(parts[2]);
  } catch {
    return null;
  }
  const age = Number(now) - Number(payload?.iat);
  if (payload?.v !== 1
    || payload?.aud !== audience
    || !Number.isFinite(age)
    || age > maxAgeMs
    || age < -AUTH_BRIDGE_MAX_FUTURE_SKEW_MS
    || typeof payload?.method !== "string"
    || typeof payload?.path !== "string"
    || typeof payload?.query !== "string"
    || typeof payload?.bodyDigest !== "string"
    || typeof payload?.csrfValidated !== "boolean"
    || typeof payload?.userId !== "string"
    || !USER_ID_PATTERN.test(payload.userId.trim())
    || typeof payload?.role !== "string"
    || !ROLE_PATTERN.test(payload.role.trim().toLowerCase())) return null;
  if (String(payload.method || "").toUpperCase() !== String(method || "").toUpperCase()) return null;
  if (String(payload.path || "") !== String(path || "")) return null;
  if (payload.query !== query || payload.bodyDigest !== bodyDigest) return null;
  if (requireCsrf && payload.csrfValidated !== true) return null;
  const expectedSignature = await signature(secret, message);
  if (!constantTimeEqual(expectedSignature, suppliedSignature)) return null;
  if (typeof payload.username !== "string") return null;
  return { id: payload.userId.trim(), username: payload.username || payload.userId, role: payload.role.toLowerCase(), authSource: "starting9", csrfValidated: payload.csrfValidated };
}
