const encoder = new TextEncoder();

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

function constantTimeEqual(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

export async function createAuthBridgeAssertion({ secret, user, method, path, now = Date.now() } = {}) {
  if (!String(secret || "").trim() || !user?.id || !method || !path) return "";
  const payload = encodeBase64Url(encoder.encode(JSON.stringify({
    v: 1,
    iat: Number(now),
    method: String(method).toUpperCase(),
    path: String(path),
    userId: String(user.id),
    username: String(user.username || "").slice(0, 80),
    role: String(user.role || "user").toLowerCase() === "admin" ? "admin" : "user"
  })));
  const message = `v1.${payload}`;
  return `${message}.${encodeBase64Url(await signature(secret, message))}`;
}

export async function verifyAuthBridgeAssertion(assertion, { secret, method, path, now = Date.now(), maxAgeMs = 60_000 } = {}) {
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
  if (payload?.v !== 1 || !Number.isFinite(age) || Math.abs(age) > maxAgeMs) return null;
  if (String(payload.method || "").toUpperCase() !== String(method || "").toUpperCase()) return null;
  if (String(payload.path || "") !== String(path || "")) return null;
  const expectedSignature = await signature(secret, message);
  if (!constantTimeEqual(expectedSignature, suppliedSignature)) return null;
  if (!String(payload.userId || "").trim()) return null;
  return { id: String(payload.userId), username: String(payload.username || payload.userId), role: payload.role === "admin" ? "admin" : "user", authSource: "starting9" };
}
