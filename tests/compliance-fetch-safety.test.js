import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npbWorkerUrl = pathToFileURL(path.join(root, "cloudflare-worker.js")).href;
const authWorkerUrl = pathToFileURL(path.join(root, "auth-worker.js")).href;

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

test("NPB_FETCH_DISABLEDは外部NPB fetchを行わず停止状態を返す", async () => {
  const { default: worker } = await import(npbWorkerUrl);
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response("unexpected", { status: 200 });
  };
  try {
    const response = await worker.fetch(new Request("https://npb-fetch.internal/?mode=starter"), {
      NPB_FETCH_DISABLED: "true"
    });
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.code, "EXTERNAL_FETCH_DISABLED");
    assert.equal(payload.error, "公式情報の取得を一時停止しています。");
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("NPB fetchはStarting9の連絡先付きUser-Agentを付ける", async () => {
  const { default: worker } = await import(npbWorkerUrl);
  const originalFetch = globalThis.fetch;
  let userAgent = "";
  globalThis.fetch = async (_url, init = {}) => {
    userAgent = new Headers(init.headers).get("User-Agent") || "";
    return new Response("<!doctype html><html><body></body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=UTF-8" }
    });
  };
  try {
    await worker.fetch(new Request("https://npb-fetch.internal/?mode=starter"), {});
    assert.match(userAgent, /^Starting9\/1\.0 /);
    assert.match(userAgent, /https:\/\/starting9-app\.pages\.dev\/contact\.html/);
    assert.match(userAgent, /non-commercial fan-made lineup prediction service/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("同一目的・同一URLのNPB fetchは同時実行中に共有される", async () => {
  const { default: worker } = await import(npbWorkerUrl);
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async () => {
    fetchCount += 1;
    await gate;
    return new Response("<!doctype html><html><body></body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=UTF-8" }
    });
  };
  try {
    const first = worker.fetch(new Request("https://npb-fetch.internal/?mode=starter"), {});
    const second = worker.fetch(new Request("https://npb-fetch.internal/?mode=starter"), {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fetchCount, 1);
    release();
    await Promise.all([first, second]);
  } finally {
    release?.();
    globalThis.fetch = originalFetch;
  }
});

test("Auth Workerは外部NPB取得停止をretry可能な明示エラーとして扱う", async () => {
  const { fetchNpbWorkerJson } = await import(authWorkerUrl);
  await assert.rejects(
    fetchNpbWorkerJson({ NPB_FETCH_DISABLED: "true" }, { mode: "lineup" }),
    (error) => error?.code === "EXTERNAL_FETCH_DISABLED"
      && error?.httpStatus === 503
      && error?.retryable === true
  );
});

test("公開表示には非公式表記・出典・停止中表示があり、静的assetのcache busterが揃う", () => {
  const index = read("index.html");
  const script = read("script.js");
  const admin = read("admin-v3.js");
  for (const file of ["index.html", "how-to-play.html", "terms.html", "privacy.html", "contact.html"]) {
    const html = read(file);
    assert.match(html, /非公式ファンメイドサービス/);
    assert.match(html, /NPB・各球団とは関係のない/);
    assert.match(html, /NPB公式サイト/);
    assert.doesNotMatch(html, /NPB公認|公式連携|公式提供|NPB提携/);
  }
  assert.match(index, /public-compliance-disclaimer-and-fetch-safety-1/);
  assert.match(read("frontend/public/probable-starter.js"), /公式情報の取得を一時停止しています。/);
  assert.match(admin, /NPB公式情報の取得を一時停止しています。/);
  assert.match(read("admin-v3.html"), /v4-canonical-status-1/);
});
