import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authWorkerUrl = pathToFileURL(path.join(root, "auth-worker.js")).href;

function createNoticePayload(overrides = {}) {
  return {
    ok: true,
    httpStatus: 200,
    noticeDate: "2026-07-23",
    pageDate: "2026-07-22",
    registrations: [],
    removals: [],
    contentHash: "notice-hash",
    rosters: {},
    ...overrides
  };
}

test("空公示と前日ページは正常な変更なしとして扱う", async () => {
  const { normalizeGameDayNoticePayload } = await import(authWorkerUrl);
  const payload = normalizeGameDayNoticePayload(createNoticePayload(), "2026-07-23");

  assert.equal(payload.noticeDate, "2026-07-23");
  assert.equal(payload.pageDate, "2026-07-22");
  assert.deepEqual(payload.registrations, []);
  assert.deepEqual(payload.removals, []);
  assert.equal(payload.registrationCount, 0);
  assert.equal(payload.removalCount, 0);
  assert.equal(payload.isEmpty, true);
});

test("登録または抹消だけが空でも公示レスポンスを正常化する", async () => {
  const { normalizeGameDayNoticePayload } = await import(authWorkerUrl);

  const registrationOnly = normalizeGameDayNoticePayload(createNoticePayload({
    pageDate: "2026-07-23",
    registrations: [{ teamCode: "fighters", playerName: "選手A" }]
  }), "2026-07-23");
  assert.equal(registrationOnly.registrationCount, 1);
  assert.equal(registrationOnly.removalCount, 0);
  assert.equal(registrationOnly.isEmpty, false);

  const removalOnly = normalizeGameDayNoticePayload(createNoticePayload({
    removals: [{ teamCode: "fighters", playerName: "選手B" }]
  }), "2026-07-23");
  assert.equal(removalOnly.registrationCount, 0);
  assert.equal(removalOnly.removalCount, 1);
  assert.equal(removalOnly.isEmpty, false);
});

test("公示配列またはnoticeDateが不正な場合だけ構造エラーとして拒否する", async () => {
  const { normalizeGameDayNoticePayload } = await import(authWorkerUrl);

  assert.throws(
    () => normalizeGameDayNoticePayload(createNoticePayload({ registrations: {} }), "2026-07-23"),
    (error) => error?.code === "NOTICE_RESPONSE_INVALID"
  );
  assert.throws(
    () => normalizeGameDayNoticePayload(createNoticePayload({ removals: null }), "2026-07-23"),
    (error) => error?.code === "NOTICE_RESPONSE_INVALID"
  );
  assert.throws(
    () => normalizeGameDayNoticePayload(createNoticePayload({ noticeDate: "2026-07-32" }), "2026-07-23"),
    (error) => error?.code === "NOTICE_RESPONSE_INVALID"
  );
});

test("空の公示ロースターは保存済みロースターを上書きしない", async () => {
  const { resolveNoticeRostersForStorage } = await import(authWorkerUrl);
  const stored = JSON.stringify({
    fighters: [{ name: "水谷 瞬", number: "53", position: "外野手" }]
  });

  assert.deepEqual(resolveNoticeRostersForStorage({}, stored), JSON.parse(stored));
  assert.deepEqual(resolveNoticeRostersForStorage({ fighters: [] }, stored), JSON.parse(stored));
  assert.deepEqual(
    resolveNoticeRostersForStorage({ fighters: [{ name: "矢澤 宏太", number: "12", position: "投手" }] }, stored),
    { fighters: [{ name: "矢澤 宏太", number: "12", position: "投手" }] }
  );
});

test("空公示は初回保存でもcreated_at付きで成功し、既存ロースターを壊さない", async () => {
  const { normalizeGameDayNoticePayload, storeGameDayNotice } = await import(authWorkerUrl);
  const writes = [];
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (/SELECT content_hash, rosters_json/.test(sql)) {
                return {
                  content_hash: null,
                  rosters_json: JSON.stringify({ fighters: [{ name: "水谷 瞬", number: "53" }] })
                };
              }
              return null;
            },
            async run() {
              writes.push({ sql, values });
              return { meta: { changes: 1 } };
            }
          };
        }
      };
    }
  };
  const payload = normalizeGameDayNoticePayload(createNoticePayload(), "2026-07-23");
  const now = new Date("2026-07-23T03:00:00.000Z");
  const result = await storeGameDayNotice(db, payload, now);
  const insert = writes.find((entry) => /INSERT INTO game_day_notices/.test(entry.sql));

  assert.equal(result.status, "updated");
  assert.ok(insert);
  assert.equal(insert.values[0], "2026-07-23");
  assert.equal(insert.values[3], now.toISOString());
  assert.deepEqual(JSON.parse(insert.values[6]), { fighters: [{ name: "水谷 瞬", number: "53" }] });
  assert.equal(insert.values[7], 0);
  assert.equal(insert.values[8], 0);
});

test("公示保存の初回INSERTはcreated_atを含み、管理画面は空公示を成功表示する", () => {
  const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
  const script = fs.readFileSync(path.join(root, "script.js"), "utf8");

  assert.match(worker, /registered_count, removed_count, status, last_error_code, created_at, updated_at/);
  assert.match(worker, /VALUES \(\?1, \?2, \?3, \?4, \?5, \?6, \?7, \?8, \?9, 'success', NULL, \?4, \?4\)/);
  assert.match(worker, /isEmpty: registrations\.length === 0 && removals\.length === 0/);
  assert.match(worker, /NOTICE_RESPONSE_INVALID/);
  assert.match(script, /指定日の登録・抹消は0件です/);
});
