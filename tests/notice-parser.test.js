import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerModuleUrl = pathToFileURL(path.join(root, "cloudflare-worker.js")).href;

function noticeHtml(body = "") {
  return `<!doctype html><html><head><meta charset="UTF-8"><title>公示 | NPB.jp</title></head><body>${body}</body></html>`;
}

test("公示パーサーはセ・パ両リーグの登録・抹消を集計し、選手名を正規化する", async () => {
  const { parseNoticePage } = await import(workerModuleUrl);
  const html = noticeHtml(`
    <h4>2026年7月23日の出場選手登録、登録抹消</h4>
    <h4>セントラル・リーグ</h4>
    <h5>出場選手登録</h5><table><tr><td>阪神タイガース</td><td>投手</td><td>01</td><td><a>山田　太郎</a></td></tr></table>
    <h5>出場選手登録抹消</h5><table><tr><td>読売ジャイアンツ</td><td>内野手</td><td>8</td><td>佐藤\n 次郎</td></tr></table>
    <h4>パシフィック・リーグ</h4>
    <h5>出場選手登録</h5><table><tr><td>北海道日本ハムファイターズ</td><td>外野手</td><td>66</td><td>万波　中正 <span>※注釈</span></td></tr></table>
    <h5>出場選手登録抹消</h5><table><tr><td>オリックス・バファローズ</td><td>投手</td><td>00</td><td>田嶋　大樹</td></tr></table>
    <h5>育成選手</h5><table><tr><td>北海道日本ハムファイターズ</td><td>投手</td><td>999</td><td>対象外 選手</td></tr></table>
  `);
  const parsed = parseNoticePage(html);

  assert.equal(parsed.isValid, true);
  assert.equal(parsed.date, "2026-07-23");
  assert.equal(parsed.registrations.length, 2);
  assert.equal(parsed.removals.length, 2);
  assert.deepEqual(parsed.registrations[1], { teamCode: "fighters", position: "外野手", number: "66", name: "万波中正" });
  assert.deepEqual(parsed.removals[0], { teamCode: "giants", position: "内野手", number: "8", name: "佐藤次郎" });
  assert.equal(parsed.debug.selectorCounts.registrationSections, 2);
  assert.equal(parsed.debug.selectorCounts.removalSections, 2);
});

test("公示ゼロの日は有効な日付見出しがあれば空配列として解析する", async () => {
  const { parseNoticePage } = await import(workerModuleUrl);
  const parsed = parseNoticePage(noticeHtml("<h4>2026年7月23日の出場選手登録、登録抹消</h4><p>本日の公示はありません。</p>"));

  assert.equal(parsed.isValid, true);
  assert.deepEqual(parsed.registrations, []);
  assert.deepEqual(parsed.removals, []);
});

test("登録のみ・抹消のみの公示も、それぞれ空でない側だけを返す", async () => {
  const { parseNoticePage } = await import(workerModuleUrl);
  const registeredOnly = parseNoticePage(noticeHtml("<h4>2026年7月23日の出場選手登録、登録抹消</h4><h5>出場選手登録</h5><table><tr><td>北海道日本ハムファイターズ</td><td>投手</td><td>12</td><td>矢澤 宏太</td></tr></table>"));
  const removedOnly = parseNoticePage(noticeHtml("<h4>2026年7月23日の出場選手登録、登録抹消</h4><h5>出場選手登録抹消</h5><table><tr><td>北海道日本ハムファイターズ</td><td>投手</td><td>12</td><td>矢澤 宏太</td></tr></table>"));

  assert.equal(registeredOnly.registrations.length, 1);
  assert.deepEqual(registeredOnly.removals, []);
  assert.deepEqual(removedOnly.registrations, []);
  assert.equal(removedOnly.removals.length, 1);
});

test("公示領域がないHTMLはNOTICE_PARSE_FAILEDになる", async () => {
  const { default: worker } = await import(workerModuleUrl);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(noticeHtml("<h2>メンテナンス中</h2>"), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=UTF-8" }
  });

  try {
    const response = await worker.fetch(new Request("https://npb-fetch.internal/?mode=notice&debug=1"), {});
    const payload = await response.json();
    assert.equal(response.status, 422);
    assert.equal(payload.code, "NOTICE_PARSE_FAILED");
    assert.equal(payload.debug.selectorCounts.dateHeading, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTML以外の公示レスポンスはNOTICE_CONTENT_TYPE_INVALIDになる", async () => {
  const { default: worker } = await import(workerModuleUrl);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });

  try {
    const response = await worker.fetch(new Request("https://npb-fetch.internal/?mode=notice&debug=1"), {});
    const payload = await response.json();
    assert.equal(response.status, 422);
    assert.equal(payload.code, "NOTICE_CONTENT_TYPE_INVALID");
    assert.equal(payload.debug.contentType, "application/json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("依頼日に公示がない場合は直近日付のページを空公示として返し、UTF-8日本語を保つ", async () => {
  const { default: worker, decodeNoticeHtml } = await import(workerModuleUrl);
  const utf8 = new TextEncoder().encode(noticeHtml("<h4>2026年7月22日の出場選手登録、登録抹消</h4><h5>出場選手登録</h5><table><tr><td>北海道日本ハムファイターズ</td><td>投手</td><td>12</td><td>矢澤 宏太</td></tr></table>"));
  assert.match(decodeNoticeHtml(utf8, "text/html; charset=UTF-8").html, /矢澤 宏太/);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(utf8, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=UTF-8" }
  });

  try {
    const response = await worker.fetch(new Request("https://npb-fetch.internal/?mode=notice&date=2026-07-23&debug=1"), {});
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.noticeDate, "2026-07-23");
    assert.deepEqual(payload.registrations, []);
    assert.equal(payload.debug.pageDate, "2026-07-22");
    assert.equal(payload.debug.noticeState, "no-notice-for-requested-date");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Shift_JISの公示HTMLも文字化けさせずに解析する", async () => {
  const { decodeNoticeHtml, parseNoticePage } = await import(workerModuleUrl);
  const shiftJisBytes = Uint8Array.from(Buffer.from("PGh0bWw+PGhlYWQ+PG1ldGEgY2hhcnNldD0iU2hpZnRfSklTIj48L2hlYWQ+PGJvZHk+PGg0PjIwMjaUTjeMjjIzk/qCzI9vj+qRSY7ok2+YXoFBk2+YXpaVj8E8L2g0PjxoNT6Pb4/qkUmO6JNvmF48L2g1Pjx0YWJsZT48dHI+PHRkPpZrikOTuZP6lnuDboOAg3SDQINDg16BW4NZPC90ZD48dGQ+k4qO6DwvdGQ+PHRkPjEyPC90ZD48dGQ+lu7gViCNR5G+PC90ZD48L3RyPjwvdGFibGU+PC9ib2R5PjwvaHRtbD4=", "base64"));
  const decoded = decodeNoticeHtml(shiftJisBytes, "text/html; charset=Shift_JIS");
  const parsed = parseNoticePage(decoded.html);

  assert.equal(decoded.charset, "windows-31j");
  assert.equal(parsed.date, "2026-07-23");
  assert.equal(parsed.registrations[0].name, "矢澤宏太");
});
