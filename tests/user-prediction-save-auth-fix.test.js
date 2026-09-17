import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptSource = fs.readFileSync(path.join(root, "script.js"), "utf8");
const authSource = fs.readFileSync(path.join(root, "auth.js"), "utf8");
const predictionFormSource = fs.readFileSync(path.join(root, "frontend", "public", "prediction-form.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(root, "index.html"), "utf8");

function createController() {
  const context = {
    window: { Starting9Public: {} },
    document: { getElementById: () => null },
    console
  };
  vm.runInNewContext(predictionFormSource, context, { filename: "prediction-form.js" });
  return context.window.Starting9Public.createPublicPredictionFormController;
}

function createDeps({ user = null, waitForAuthInitialization, getPredictionAccountStatus, savePredictionToAccount } = {}) {
  const calls = { localSave: 0, accountSave: 0, messages: [] };
  let currentUser = user;
  const deps = {
    state: {
      predictionRemote: { isSaving: false, isSubmitting: false, message: "" },
      prediction: null,
      activeOrder: { prediction: 0 }
    },
    ensurePredictionEditingAllowed: () => true,
    updatePredictionSaveButton: () => {},
    clearMessage: () => {},
    getLineupValues: () => Array.from({ length: 9 }, (_, index) => ({ order: index + 1, player: `選手${index + 1}`, position: "" })),
    validateLineup: () => "",
    showMessage: (_id, message) => { if (message) calls.messages.push(message); },
    markDuplicateSlots: () => {},
    getCurrentGameId: () => "game-1",
    preserveDisplayedResult: () => {},
    renderSavedPrediction: () => {},
    renderPredictionCta: () => {},
    renderPredictionAccountStatus: () => {},
    renderPublicGameSelectionMeta: () => {},
    renderPicker: () => {},
    getPredictionAccountUser: () => currentUser,
    getPredictionAccountStatus: getPredictionAccountStatus || (() => ({ errorCode: "", errorStatus: 0 })),
    waitForAuthInitialization: waitForAuthInitialization || (() => Promise.resolve()),
    showPredictionSaveMessage: (message) => calls.messages.push(message),
    savePredictionToAccount: async (...args) => {
      calls.accountSave += 1;
      if (typeof savePredictionToAccount === "function") return savePredictionToAccount(...args);
      return true;
    },
    storage: {
      save: () => { calls.localSave += 1; },
      remove: () => {}
    },
    storageKeys: { prediction: "prediction" },
    setLineupValues: () => {},
    closeAllPositionMenus: () => {},
    renderScoreResult: () => {},
    deletePredictionFromAccount: async () => {}
  };
  return { deps, calls, setUser: (nextUser) => { currentUser = nextUser; } };
}

async function submit(controller, deps) {
  await controller({ preventDefault: () => {} });
}

test("認証初期化完了前の保存でも、ログイン済みなら端末保存だけの表示へ落ちない", async () => {
  const create = createController();
  let resolveAuth;
  let initialized = false;
  const authReady = new Promise((resolve) => { resolveAuth = resolve; });
  const { deps, calls, setUser } = createDeps({
    waitForAuthInitialization: () => authReady,
    user: null
  });
  const controller = create({ ...deps, getPredictionAccountUser: () => (initialized ? { id: "user-1" } : null) });

  const pending = submit(controller.handleSubmit, deps);
  await Promise.resolve();
  assert.equal(calls.localSave, 1);
  assert.equal(calls.accountSave, 0);
  initialized = true;
  setUser({ id: "user-1" });
  resolveAuth();
  await pending;
  assert.equal(calls.accountSave, 1);
  assert.deepEqual(calls.messages, ["予想を保存しました。 ✓"]);
});

test("未ログイン保存は端末保存のみで、アカウント保存成功とは表示しない", async () => {
  const create = createController();
  const { deps, calls } = createDeps();
  await submit(create(deps).handleSubmit, deps);
  assert.equal(calls.localSave, 1);
  assert.equal(calls.accountSave, 0);
  assert.equal(calls.messages[0], "この端末に予想を保存しました。ログインするとアカウントにも保存できます。");
  assert.doesNotMatch(calls.messages[0], /アカウントにも予想を保存しました/);
});

test("ログイン済み保存成功はアカウント保存として表示し、ログイン促進文を出さない", async () => {
  const create = createController();
  const { deps, calls } = createDeps({ user: { id: "user-1" } });
  await submit(create(deps).handleSubmit, deps);
  assert.equal(calls.localSave, 1);
  assert.equal(calls.accountSave, 1);
  assert.deepEqual(calls.messages, ["予想を保存しました。 ✓"]);
});

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} が見つかりません`);
  let depth = 0;
  let opened = false;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") {
      depth += 1;
      opened = true;
    } else if (source[index] === "}") {
      depth -= 1;
      if (opened && depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`${name} の終端が見つかりません`);
}

test("ログイン済みアカウント保存失敗を401/403/409/503/通信失敗で区別する", () => {
  const source = extractFunction(scriptSource, "getPredictionAccountSaveErrorMessage");
  const getMessage = vm.runInNewContext(`(${source})`, {});
  assert.match(getMessage({ code: "AUTH_REQUIRED", status: 401 }), /ログイン状態が切れています/);
  assert.match(getMessage({ status: 403 }), /権限がありません/);
  assert.match(getMessage({ code: "PREDICTION_DEADLINE_PASSED", status: 409 }), /受付は終了しました/);
  assert.match(getMessage({ code: "D1_READ_LIMIT_EXCEEDED", status: 503 }), /データベースが一時的に混雑/);
  assert.match(getMessage({ code: "NETWORK_ERROR", status: 0 }), /通信状況を確認/);
  assert.doesNotMatch(getMessage({ code: "AUTH_REQUIRED", status: 401 }), /ログインするとアカウントにも保存できます/);
});

test("保存APIの401は認証状態を無効化し、credentials includeを維持する", () => {
  assert.match(scriptSource, /window\.starting9Auth\?\.markSessionExpired\?\./);
  assert.match(scriptSource.slice(scriptSource.indexOf("async function savePredictionToAccount")), /credentials: "include"/);
  assert.match(authSource, /markSessionExpired/);
  assert.match(authSource, /getStatus: \(\) =>/);
});

test("変更した公開assetのcache busterを更新する", () => {
  assert.match(htmlSource, /auth\.js\?v=d1-read-limit-resilience-20260902&user-prediction-save-auth-fix-20260903/);
  assert.match(htmlSource, /frontend\/public\/prediction-form\.js\?v=public-compliance-disclaimer-and-fetch-safety-1&user-save-auth-unavailable-fix-20260903/);
  assert.match(htmlSource, /script\.js\?v=public-single-game-1&user-save-auth-unavailable-fix-20260903/);
});

test("認証初期化失敗時も保存APIの成功をアカウント保存へ反映する", async () => {
  const create = createController();
  const { deps, calls } = createDeps({ getPredictionAccountStatus: () => ({ errorCode: "DB_UNAVAILABLE", errorStatus: 503 }) });
  await submit(create(deps).handleSubmit, deps);
  assert.equal(calls.accountSave, 1);
  assert.deepEqual(calls.messages, ["予想を保存しました。 ✓"]);
  assert.doesNotMatch(calls.messages[0], /ログインするとアカウントにも保存できます/);
});

test("認証確認不能時は保存APIを一度だけ試し、既存セッションの成功を反映する", async () => {
  const create = createController();
  let probeOptions = null;
  const { deps, calls } = createDeps({
    getPredictionAccountStatus: () => ({ errorCode: "AUTH_API_UNAVAILABLE", errorStatus: 0 }),
    savePredictionToAccount: async (_prediction, options) => {
      probeOptions = options;
      return true;
    }
  });
  await submit(create(deps).handleSubmit, deps);
  assert.equal(calls.accountSave, 1);
  assert.equal(probeOptions?.allowAuthProbe, true);
  assert.deepEqual(calls.messages, ["予想を保存しました。 ✓"]);
});

test("認証確認不能時の保存API失敗は端末保存成功とアカウント保存成功を混同しない", async () => {
  const create = createController();
  const { deps, calls } = createDeps({
    getPredictionAccountStatus: () => ({ errorCode: "D1_READ_LIMIT_EXCEEDED", errorStatus: 503 }),
    savePredictionToAccount: async () => {
      deps.state.predictionRemote.message = "端末には保存しましたが、データベースが一時的に混雑しています。";
      return false;
    }
  });
  await submit(create(deps).handleSubmit, deps);
  assert.equal(calls.accountSave, 1);
  assert.match(calls.messages[0], /データベースが一時的に混雑/);
  assert.doesNotMatch(calls.messages[0], /予想を保存しました。$/);
});
