import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createTestTeamWorker } from "../../tooling/test-site/worker.js";

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      const bind = (...args) => ({
        all: async () => ({ results: statement.all(...args) }),
        first: async () => statement.get(...args),
        run: async () => ({ meta: { changes: Number(statement.run(...args).changes || 0) } })
      });
      return { ...bind(), bind };
    },
    async batch(statements) {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

export async function createTestSiteMultiTeamFixture({ rosterPlayersByTeam = {} } = {}) {
  const database = new DatabaseSync(":memory:");
  const audit = new DatabaseSync(":memory:");
  try {
    for (const [directory, db] of [["migrations", database], ["migrations-audit", audit]]) {
      for (const file of fs.readdirSync(new URL(`../../${directory}/`, import.meta.url))
        .filter((name) => name.endsWith(".sql")).sort()) {
        db.exec(fs.readFileSync(new URL(`../../${directory}/${file}`, import.meta.url), "utf8"));
      }
    }
    const now = new Date().toISOString();
    const token = "multi-team-synthetic-session";
    const tokenHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString("base64url");
    database.prepare(`INSERT INTO users (id, username, username_normalized, password_hash, password_salt, password_iterations, status, role, created_at, updated_at)
      VALUES ('team-test-user', 'teamtest', 'teamtest', 'test', 'test', 1, 'active', 'admin', ?, ?)`).run(now, now);
    database.prepare(`INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_used_at)
      VALUES ('team-test-session', 'team-test-user', ?, ?, '2099-01-01T00:00:00.000Z', ?)`).run(tokenHash, now, now);
    const config = JSON.parse(fs.readFileSync(new URL("../../wrangler.test-auth.jsonc", import.meta.url)));
    const env = { ...config.vars, S9SIMU_ENABLED: "false", AUTH_DB: d1(database), AUDIT_DB: d1(audit) };
    async function request(team, path, body, method = body === undefined ? "GET" : "POST") {
      const worker = createTestTeamWorker(team, { rosterPlayers: rosterPlayersByTeam[team] || null });
      const response = await worker.fetch(new Request(`https://starting9-test-auth.internal${path}`, {
        method,
        headers: { Cookie: `s9_session=${token}`, Origin: "https://s9simu.pages.dev", "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      }), env, { waitUntil() {} });
      const result = await response.json();
      assertOk(response, result, `${team} ${method} ${path}`);
      return result;
    }
    return { database, audit, request, close() { database.close(); audit.close(); } };
  } catch (error) {
    database.close();
    audit.close();
    throw error;
  }
}

function assertOk(response, result, context = "request") {
  if (!response.ok) throw new Error(`Test Site ${context} failed (${response.status}): ${JSON.stringify(result)}`);
}
