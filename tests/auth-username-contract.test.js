import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import worker, { resetAuthRateLimitsForTests } from "../auth-worker.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authSource = fs.readFileSync(path.join(root, "auth.js"), "utf8");
const workerSource = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const indexSource = fs.readFileSync(path.join(root, "index.html"), "utf8");

function createAuthDb() {
  const users = new Map();
  const sessions = new Map();
  return {
    users,
    sessions,
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...boundValues) {
          values = boundValues;
          return statement;
        },
        async first() {
          if (sql.includes("SELECT id FROM users")) {
            const user = users.get(values[0]);
            return user ? { id: user.id } : null;
          }
          if (sql.includes("SELECT id, username, status, password_hash")) {
            return users.get(values[0]) || null;
          }
          if (sql.includes("SELECT sessions.id AS session_id")) {
            const session = sessions.get(values[0]);
            if (!session || session.expires_at <= values[1]) return null;
            const user = [...users.values()].find((candidate) => candidate.id === session.user_id);
            return user ? {
              session_id: session.id,
              id: user.id,
              username: user.username,
              status: user.status,
              role: "user"
            } : null;
          }
          return null;
        },
        async run() {
          if (sql.includes("INSERT INTO users")) {
            const [id, username, usernameNormalized, passwordHash, passwordSalt, passwordIterations] = values;
            users.set(usernameNormalized, {
              id,
              username,
              username_normalized: usernameNormalized,
              password_hash: passwordHash,
              password_salt: passwordSalt,
              password_iterations: passwordIterations,
              status: "active"
            });
          }
          if (sql.includes("INSERT INTO sessions")) {
            const [id, userId, tokenHash, createdAt, expiresAt] = values;
            sessions.set(tokenHash, { id, user_id: userId, created_at: createdAt, expires_at: expiresAt });
          }
          return { meta: { changes: 1 } };
        }
      };
      return statement;
    }
  };
}

function sessionRequest(cookie) {
  return new Request("https://starting9.test/api/auth/me", {
    headers: { Cookie: cookie }
  });
}

function authRequest(pathname, body, ip = "198.51.100.50") {
  return new Request(`https://starting9.test${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": ip
    },
    body: JSON.stringify(body)
  });
}

async function register(db, username, ip) {
  return worker.fetch(authRequest("/api/auth/register", {
    username,
    password: "password123",
    passwordConfirmation: "password123"
  }, ip), { AUTH_DB: db }, {});
}

test("通常usernameのfrontend/backend契約は1〜16文字で一致し、文字種は変更しない", () => {
  assert.match(authSource, /const AUTH_USERNAME_MIN_LENGTH = 1;/);
  assert.match(workerSource, /const USERNAME_MIN_LENGTH = 1;/);
  assert.match(indexSource, /id="authLoginUsername"[^>]*minlength="1"[^>]*maxlength="16"/);
  assert.match(indexSource, /id="authRegisterUsername"[^>]*minlength="1"[^>]*maxlength="16"/);
  assert.match(workerSource, /\^\[\\p\{L\}\\p\{N\}_-\]\+\$\/u\.test\(username\)/);
});

test("1〜16文字のusernameは登録でき、17文字・空・空白・禁止文字は拒否する", async () => {
  const db = createAuthDb();
  const validNames = ["A", "あ", "1", "AB", "a".repeat(16)];
  for (const [index, username] of validNames.entries()) {
    const response = await register(db, username, `198.51.100.${60 + index}`);
    assert.equal(response.status, 201, username);
  }

  for (const [index, username] of ["a".repeat(17), "", "   ", "a!"].entries()) {
    const response = await register(db, username, `198.51.100.${70 + index}`);
    assert.equal(response.status, 400, username || "empty");
  }
});

test("username uniqueness/normalizationは維持され、1文字usernameをloginできる", async () => {
  resetAuthRateLimitsForTests();
  const db = createAuthDb();
  const created = await register(db, "A", "198.51.100.80");
  assert.equal(created.status, 201);

  const duplicate = await register(db, "a", "198.51.100.81");
  assert.equal(duplicate.status, 409);

  const login = await worker.fetch(authRequest("/api/auth/login", {
    username: "A",
    password: "password123"
  }, "198.51.100.82"), { AUTH_DB: db }, {});
  assert.equal(login.status, 200);
  assert.equal((await login.json()).user.username, "A");
  const cookie = (login.headers.get("Set-Cookie") || "").split(";", 1)[0];
  assert.match(cookie, /^s9_session=/);

  const session = await worker.fetch(sessionRequest(cookie), { AUTH_DB: db }, { waitUntil() {} });
  assert.equal(session.status, 200);
  assert.deepEqual((await session.json()).user, { id: [...db.users.values()][0].id, username: "A" });
});
