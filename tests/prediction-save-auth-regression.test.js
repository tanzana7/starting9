import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerSource = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const clientSource = fs.readFileSync(path.join(root, "script.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(root, "index.html"), "utf8");
const { default: worker } = await import(pathToFileURL(path.join(root, "auth-worker.js")).href);

function createPredictionSaveDb() {
  const internalGameId = "c099db0c-da34-425c-bd38-69e29ddc1064";
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            first: async () => {
              if (sql.includes("FROM sessions JOIN users")) {
                return { session_id: "session-1", id: "user-1", username: "tester", status: "active", role: "user" };
              }
              if (sql.includes("FROM games")) {
                return {
                  internal_game_id: internalGameId,
                  game_date: "2099-08-09",
                  start_time: "2099-08-09T05:00:00.000Z",
                  home_team: "fighters",
                  away_team: "eagles",
                  game_status: "scheduled",
                  npb_game_code: ""
                };
              }
              if (sql.includes("FROM predictions")) return null;
              return null;
            },
            all: async () => {
              if (sql.includes("PRAGMA table_info(predictions)")) return { results: [{ name: "internal_game_id" }] };
              return { results: [] };
            },
            run: async () => ({ meta: { changes: 1 } })
          };
        }
      };
    }
  };
}

function validPrediction() {
  const positions = ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"];
  return {
    schemaVersion: 1,
    lineup: positions.map((position, index) => ({
      battingOrder: index + 1,
      playerName: `選手${index + 1}`,
      playerId: `F-${index + 1}`,
      teamId: "F",
      teamCode: "fighters",
      uniformNumber: String(index + 1),
      position
    }))
  };
}

test("廃止済みadmin parserが通常の予想APIを妨げず、未認証はAUTH_REQUIREDになる", async () => {
  assert.doesNotMatch(workerSource, /parseAdminTestRoute\(path\)/);
  const requests = [
    new Request("https://starting9-auth.test/api/predictions/current?internalGameId=c099db0c-da34-425c-bd38-69e29ddc1064"),
    new Request("https://starting9-auth.test/api/predictions/current", { method: "PUT", body: "{}" }),
    new Request("https://starting9-auth.test/api/predictions/current?internalGameId=c099db0c-da34-425c-bd38-69e29ddc1064", { method: "DELETE" })
  ];
  const expectedMethods = ["GET", "PUT", "DELETE"];
  for (let index = 0; index < requests.length; index += 1) {
    const response = await worker.fetch(requests[index], { AUTH_DB: {} }, {});
    const payload = await response.json();
    assert.equal(requests[index].method, expectedMethods[index]);
    assert.equal(response.status, 401);
    assert.equal(payload.code, "AUTH_REQUIRED");
  }
});

test("ログイン済みユーザーはcanonical internalGameIdで予想を保存できる", async () => {
  const request = new Request("https://starting9-auth.test/api/predictions/current", {
    method: "PUT",
    headers: { Cookie: "s9_session=test-session", "Content-Type": "application/json" },
    body: JSON.stringify({ internalGameId: "c099db0c-da34-425c-bd38-69e29ddc1064", prediction: validPrediction() })
  });
  const response = await worker.fetch(request, { AUTH_DB: createPredictionSaveDb() }, {});
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.internalGameId, "c099db0c-da34-425c-bd38-69e29ddc1064");
});

test("予想保存はcookie credentialsとcanonical internalGameIdを使う", () => {
  const save = clientSource.slice(clientSource.indexOf("async function savePredictionToAccount"), clientSource.indexOf("function loadPredictionFromAccount"));
  assert.match(save, /credentials: "include"/);
  assert.match(save, /body: JSON\.stringify\(\{ internalGameId: gameId, prediction:/);
  assert.match(save, /error\.code = payload\?\.code/);
  assert.match(save, /getPredictionAccountSaveErrorMessage/);
});

test("認証・締切・対象試合エラーを画面側で分離し、local保存を保持する", () => {
  assert.match(clientSource, /AUTH_REQUIRED/);
  assert.match(clientSource, /SESSION_EXPIRED[\s\S]*再ログインしてください/);
  assert.ok(clientSource.indexOf("SESSION_EXPIRED") < clientSource.indexOf("AUTH_REQUIRED"));
  assert.match(clientSource, /PREDICTION_DEADLINE_PASSED/);
  assert.match(clientSource, /INVALID_GAME_ID/);
  assert.match(clientSource, /saveToStorage\(STORAGE_KEYS\.prediction, state\.prediction\)/);
  assert.match(htmlSource, /script\.js\?v=public-saved-lineup-canvas-readable-names-1/);
});
