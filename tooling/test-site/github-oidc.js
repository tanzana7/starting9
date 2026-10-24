const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_JWKS_URL = `${GITHUB_ISSUER}/.well-known/jwks`;
const EXPECTED_REPOSITORY = "tanzana7/starting9";
const EXPECTED_REPOSITORY_ID = "1293016764";
const EXPECTED_WORKFLOW_REF = "tanzana7/starting9/.github/workflows/s9simu-remote-e2e.yml@refs/heads/main";
const EXPECTED_SUBJECT = `repo:${EXPECTED_REPOSITORY}:ref:refs/heads/main`;
const EXPECTED_AUDIENCE = "starting9-simu-e2e";
const FIGHTERS_DRIVER_WORKFLOW_REF = "tanzana7/starting9/.github/workflows/fighters-unattended-driver.yml@refs/heads/main";
const FIGHTERS_DRIVER_AUDIENCE = "starting9-fighters-scheduled-driver";
const MAX_TOKEN_BYTES = 8_192;
const MAX_TOKEN_AGE_SECONDS = 5 * 60;
const MAX_TOKEN_LIFETIME_SECONDS = 10 * 60;
const CLOCK_SKEW_SECONDS = 30;

function decodeSegment(segment) {
  const normalized = String(segment).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))));
}

function isAudienceAllowed(audience) {
  return audience === EXPECTED_AUDIENCE
    || (Array.isArray(audience) && audience.length === 1 && audience[0] === EXPECTED_AUDIENCE);
}

function validTimeClaims(claims, nowSeconds) {
  const issuedAt = Number(claims.iat);
  const expiresAt = Number(claims.exp);
  const notBefore = claims.nbf === undefined ? null : Number(claims.nbf);
  return Number.isSafeInteger(issuedAt)
    && Number.isSafeInteger(expiresAt)
    && expiresAt > nowSeconds
    && issuedAt <= nowSeconds + CLOCK_SKEW_SECONDS
    && issuedAt >= nowSeconds - MAX_TOKEN_AGE_SECONDS
    && expiresAt > issuedAt
    && expiresAt - issuedAt <= MAX_TOKEN_LIFETIME_SECONDS
    && (notBefore === null || (Number.isSafeInteger(notBefore) && notBefore <= nowSeconds + CLOCK_SKEW_SECONDS));
}

function validRunClaims(claims) {
  return claims.iss === GITHUB_ISSUER
    && isAudienceAllowed(claims.aud)
    && claims.sub === EXPECTED_SUBJECT
    && claims.repository === EXPECTED_REPOSITORY
    && String(claims.repository_id || "") === EXPECTED_REPOSITORY_ID
    && claims.ref === "refs/heads/main"
    && claims.event_name === "workflow_dispatch"
    && claims.workflow_ref === EXPECTED_WORKFLOW_REF
    && /^\d{1,20}$/.test(String(claims.run_id || ""))
    && /^[1-9]\d{0,5}$/.test(String(claims.run_attempt || ""))
    && typeof claims.jti === "string"
    && claims.jti.length >= 8
    && claims.jti.length <= 256;
}

function validWorkflowClaims(claims, { workflowRef, eventName, audience }) {
  return claims.iss === GITHUB_ISSUER
    && isAudienceAllowedFor(claims.aud, audience)
    && claims.sub === EXPECTED_SUBJECT
    && claims.repository === EXPECTED_REPOSITORY
    && String(claims.repository_id || "") === EXPECTED_REPOSITORY_ID
    && claims.ref === "refs/heads/main"
    && claims.event_name === eventName
    && claims.workflow_ref === workflowRef
    && /^\d{1,20}$/.test(String(claims.run_id || ""))
    && /^[1-9]\d{0,5}$/.test(String(claims.run_attempt || ""))
    && typeof claims.jti === "string"
    && claims.jti.length >= 8
    && claims.jti.length <= 256;
}

function isAudienceAllowedFor(audience, expectedAudience) {
  return audience === expectedAudience
    || (Array.isArray(audience) && audience.length === 1 && audience[0] === expectedAudience);
}

async function verifyGitHubWorkflowToken(token, policy, {
  fetcher = fetch,
  nowSeconds = Math.floor(Date.now() / 1000)
} = {}) {
  const raw = String(token || "");
  if (!raw || raw.length > MAX_TOKEN_BYTES) throw new Error("OIDC_TOKEN_INVALID");
  const parts = raw.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) throw new Error("OIDC_TOKEN_INVALID");

  let header;
  let claims;
  let signature;
  try {
    [header, claims, signature] = [decodeSegment(parts[0]), decodeSegment(parts[1]), parts[2]];
  } catch {
    throw new Error("OIDC_TOKEN_INVALID");
  }
  const claimsValid = policy.eventName === "workflow_dispatch" && policy.workflowRef === EXPECTED_WORKFLOW_REF
    ? validRunClaims(claims)
    : validWorkflowClaims(claims, policy);
  if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length > 256
      || !validTimeClaims(claims, nowSeconds) || !claimsValid) {
    throw new Error("OIDC_TOKEN_INVALID");
  }

  let response;
  try {
    response = await fetcher(GITHUB_JWKS_URL, {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: 300, cacheEverything: true }
    });
  } catch {
    throw new Error("OIDC_KEYSET_UNAVAILABLE");
  }
  if (!response?.ok) throw new Error("OIDC_KEYSET_UNAVAILABLE");
  let keySet;
  try {
    keySet = await response.json();
  } catch {
    throw new Error("OIDC_KEYSET_UNAVAILABLE");
  }
  const jwk = Array.isArray(keySet?.keys)
    ? keySet.keys.find((candidate) => candidate?.kid === header.kid
      && candidate?.kty === "RSA" && candidate?.use === "sig" && candidate?.alg === "RS256")
    : null;
  if (!jwk) throw new Error("OIDC_KEY_NOT_FOUND");

  let validSignature = false;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, {
      name: "RSASSA-PKCS1-v1_5", hash: "SHA-256"
    }, false, ["verify"]);
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signatureBytes = Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/")
      .padEnd(Math.ceil(signature.length / 4) * 4, "=")), (char) => char.charCodeAt(0));
    validSignature = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signatureBytes, signed);
  } catch {
    throw new Error("OIDC_SIGNATURE_INVALID");
  }
  if (!validSignature) throw new Error("OIDC_SIGNATURE_INVALID");

  return Object.freeze({
    runId: `${claims.run_id}:${claims.run_attempt}`,
    jti: claims.jti,
    expiresAt: new Date(Number(claims.exp) * 1000).toISOString()
  });
}

export async function verifyS9SimuRunToken(token, options = {}) {
  const identity = await verifyGitHubWorkflowToken(token, {
    workflowRef: EXPECTED_WORKFLOW_REF,
    eventName: "workflow_dispatch",
    audience: EXPECTED_AUDIENCE
  }, options);
  const runHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
    `${EXPECTED_REPOSITORY_ID}:${identity.runId}:${identity.jti}`
  ));
  const suffix = Array.from(new Uint8Array(runHash).slice(0, 6), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return Object.freeze({ ...identity, username: `e2e-${suffix}` });
}

export function verifyFightersScheduledDriverToken(token, options = {}) {
  return verifyGitHubWorkflowToken(token, {
    workflowRef: FIGHTERS_DRIVER_WORKFLOW_REF,
    eventName: "schedule",
    audience: FIGHTERS_DRIVER_AUDIENCE
  }, options);
}

export function verifyFightersDriverAuthCheckToken(token, options = {}) {
  return verifyGitHubWorkflowToken(token, {
    workflowRef: FIGHTERS_DRIVER_WORKFLOW_REF,
    eventName: "workflow_dispatch",
    audience: FIGHTERS_DRIVER_AUDIENCE
  }, options);
}
