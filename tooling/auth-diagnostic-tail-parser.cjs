const readline = require("node:readline");

const SAFE_FIELDS = Object.freeze([
  "diagnosticId",
  "scope",
  "phase",
  "requestPath",
  "hasSessionCookie",
  "sessionCookieCount",
  "authUpstreamReached",
  "authUpstreamStatus",
  "authUpstreamAuthenticated",
  "authUpstreamUserPresent",
  "authUpstreamUserIdTypeValid",
  "finalAuthenticated",
  "finalIsAdmin"
]);

const BOOLEAN_FIELDS = new Set([
  "hasSessionCookie",
  "authUpstreamReached",
  "authUpstreamAuthenticated",
  "authUpstreamUserPresent",
  "authUpstreamUserIdTypeValid",
  "finalAuthenticated",
  "finalIsAdmin"
]);

const WRAPPER_FIELDS = new Set(["data", "event", "message", "payload", "logs"]);

function parseJsonLayer(value) {
  if (typeof value !== "string") return value;
  const text = value.trim().replace(/^data:\s*/, "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function decodeTailRecord(raw) {
  let value = raw;
  for (let depth = 0; depth < 4 && typeof value === "string"; depth += 1) {
    const parsed = parseJsonLayer(value);
    if (parsed === null) return null;
    value = parsed;
  }
  return value;
}

function findDiagnosticObject(value, depth = 0) {
  if (depth > 5 || value === null) return null;
  if (typeof value === "string") {
    const decoded = decodeTailRecord(value);
    return decoded === value ? null : findDiagnosticObject(decoded, depth + 1);
  }
  if (typeof value !== "object") return null;
  if (value.scope === "asia-cs-auth-diagnostic") return value;

  for (const key of WRAPPER_FIELDS) {
    const nested = value[key];
    if (Array.isArray(nested)) {
      for (const item of nested) {
        const found = findDiagnosticObject(item, depth + 1);
        if (found) return found;
      }
    } else {
      const found = findDiagnosticObject(nested, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function copySafeField(result, source, field) {
  if (!Object.prototype.hasOwnProperty.call(source, field)) return;
  const value = source[field];
  if (BOOLEAN_FIELDS.has(field)) {
    if (typeof value === "boolean") result[field] = value;
    return;
  }
  if (field === "sessionCookieCount") {
    if (Number.isInteger(value) && value >= 0 && value <= 99) result[field] = value;
    return;
  }
  if (field === "authUpstreamStatus") {
    if (Number.isInteger(value) && value >= 100 && value <= 599) result[field] = value;
    return;
  }
  if (typeof value === "string" && value.length <= 256) result[field] = value;
}

function projectSafeDiagnostic(source) {
  if (!source || typeof source !== "object") return null;
  const result = {};
  for (const field of SAFE_FIELDS) copySafeField(result, source, field);
  if (result.scope !== "asia-cs-auth-diagnostic") return null;
  return result;
}

function parseTailRecord(raw) {
  const decoded = decodeTailRecord(raw);
  return projectSafeDiagnostic(findDiagnosticObject(decoded));
}

function mergeDiagnosticEvents(events) {
  const grouped = new Map();
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const diagnosticId = event.diagnosticId;
    if (typeof diagnosticId !== "string" || diagnosticId.length === 0) continue;
    const current = grouped.get(diagnosticId) || {};
    grouped.set(diagnosticId, { ...current, ...event });
  }
  return [...grouped.values()];
}

if (require.main === module) {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    const event = parseTailRecord(line);
    if (event) process.stdout.write(`${JSON.stringify(event)}\n`);
  });
}

module.exports = {
  SAFE_FIELDS,
  decodeTailRecord,
  mergeDiagnosticEvents,
  parseTailRecord,
  projectSafeDiagnostic
};
