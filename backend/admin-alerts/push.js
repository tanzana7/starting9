const textEncoder = new TextEncoder();

function b64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromB64url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function concat(...parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function safeActionPath(value) {
  const raw = String(value || "");
  if (!raw.startsWith("/admin-v3.html") || raw.startsWith("//") || raw.includes("\\")) return "/admin-v3.html";
  try {
    const url = new URL(raw, "https://starting9.invalid");
    return url.origin === "https://starting9.invalid" && url.pathname === "/admin-v3.html"
      ? `${url.pathname}${url.search}${url.hash}`
      : "/admin-v3.html";
  } catch { return "/admin-v3.html"; }
}

async function hkdf(ikm, salt, info, length) {
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, base, length * 8);
  return new Uint8Array(bits);
}

async function importVapidPrivateKey(privateKey, publicKey) {
  const d = fromB64url(privateKey);
  const publicBytes = fromB64url(publicKey);
  if (d.length !== 32 || publicBytes.length !== 65 || publicBytes[0] !== 4) throw new Error("VAPID_KEY_FORMAT_INVALID");
  return crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256", d: b64url(d), x: b64url(publicBytes.slice(1, 33)), y: b64url(publicBytes.slice(33, 65)),
    ext: true
  }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function createVapidAuthorization(endpoint, env, now = new Date()) {
  const privateKey = String(env?.VAPID_PRIVATE_KEY || "").trim();
  const publicKey = String(env?.VAPID_PUBLIC_KEY || "").trim();
  const subject = String(env?.VAPID_SUBJECT || "").trim();
  if (!privateKey || !publicKey || !subject) return null;
  const audience = new URL(endpoint).origin;
  const issuedAt = Math.floor((now instanceof Date ? now : new Date(now)).getTime() / 1000);
  const header = b64url(textEncoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64url(textEncoder.encode(JSON.stringify({ aud: audience, exp: issuedAt + 12 * 60 * 60, sub: subject })));
  const signingInput = `${header}.${payload}`;
  const key = await importVapidPrivateKey(privateKey, publicKey);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, textEncoder.encode(signingInput)));
  return `vapid t=${signingInput}.${b64url(signature)}, k=${publicKey}`;
}

async function encryptPayload(subscription, payload) {
  const receiverPublic = fromB64url(subscription.p256dh);
  const authSecret = fromB64url(subscription.auth);
  if (receiverPublic.length !== 65 || receiverPublic[0] !== 4 || authSecret.length < 16) throw new Error("PUSH_SUBSCRIPTION_KEY_INVALID");
  const receiverKey = await crypto.subtle.importKey("raw", receiverPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const senderKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const senderPublic = new Uint8Array(await crypto.subtle.exportKey("raw", senderKeys.publicKey));
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: receiverKey }, senderKeys.privateKey, 256));
  const keyInfo = concat(textEncoder.encode("WebPush: info\0"), receiverPublic, senderPublic);
  const prk = await hkdf(sharedSecret, authSecret, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(prk, salt, textEncoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(prk, salt, textEncoder.encode("Content-Encoding: nonce\0"), 12);
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plaintext = concat(textEncoder.encode(JSON.stringify(payload)), Uint8Array.of(2));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext));
  const recordSize = new Uint8Array([0, 0, 16, 0]);
  return concat(salt, recordSize, Uint8Array.of(senderPublic.length), senderPublic, encrypted);
}

export function buildPushPayload(incident) {
  return {
    title: String(incident?.title || "Starting9 運営通知").slice(0, 120),
    body: String(incident?.body || "管理画面を確認してください。").slice(0, 240),
    actionPath: safeActionPath(incident?.action_path || incident?.actionPath),
    dedupeKey: String(incident?.dedupe_key || incident?.dedupeKey || "admin-alert").slice(0, 240),
    severity: incident?.severity === "critical" ? "critical" : "warning"
  };
}

export async function sendWebPushSubscription(subscription, incident, env, { fetchImpl = fetch, now = new Date() } = {}) {
  const authorization = await createVapidAuthorization(subscription.endpoint, env, now);
  if (!authorization) return { ok: false, skipped: "VAPID_NOT_CONFIGURED" };
  const body = await encryptPayload(subscription, buildPushPayload(incident));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetchImpl(subscription.endpoint, {
      method: "POST",
      headers: {
        Authorization: authorization,
        TTL: "300",
        Urgency: incident?.severity === "critical" ? "high" : "normal",
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "aes128gcm"
      },
      body,
      signal: controller.signal
    });
    if (response.ok) return { ok: true, status: response.status };
    return { ok: false, status: response.status, stale: response.status === 404 || response.status === 410, code: `PUSH_HTTP_${response.status}` };
  } finally {
    clearTimeout(timer);
  }
}

export { b64url, fromB64url, createVapidAuthorization, encryptPayload, safeActionPath };
