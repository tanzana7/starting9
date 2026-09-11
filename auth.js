// 本番のPages配下では同一オリジンのPages Functionを使い、Cookieを再読込でも維持します。
// file://で直接開く場合は認証APIを使わず、誤ったCookie境界を作りません。
const AUTH_API_BASE_URL = resolveAuthApiBaseUrl();
const AUTH_USERNAME_MIN_LENGTH = 1;
const AUTH_USERNAME_MAX_LENGTH = 16;
const AUTH_PASSWORD_MIN_LENGTH = 8;
const AUTH_PASSWORD_MAX_LENGTH = 72;

let resolveAuthInitialization;
const authInitializationPromise = new Promise((resolve) => {
  resolveAuthInitialization = resolve;
});

const authState = {
  user: null,
  mode: "login",
  isLoading: false,
  isInitialized: false,
  error: null
};

window.starting9Auth = {
  getUser: () => authState.user,
  getApiBaseUrl: () => AUTH_API_BASE_URL,
  openLogin: () => openAuthModal("login"),
  isInitialized: () => authState.isInitialized,
  getStatus: () => ({
    isInitialized: authState.isInitialized,
    isLoading: authState.isLoading,
    authenticated: Boolean(authState.user?.id && authState.user?.username),
    errorCode: authState.error?.code || "",
    errorStatus: Number(authState.error?.status || 0)
  }),
  markSessionExpired,
  whenInitialized: () => authInitializationPromise
};
window.starting9AuthReady = authInitializationPromise;

function resolveAuthApiBaseUrl() {
  const hostname = window.location.hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return "http://127.0.0.1:8787";
  }

  if (window.location.protocol === "http:" || window.location.protocol === "https:") {
    return window.location.origin;
  }

  return "";
}

document.addEventListener("DOMContentLoaded", initializeAuth);

function initializeAuth() {
  document.getElementById("openLoginButton").addEventListener("click", () => openAuthModal("login"));
  document.getElementById("openRegisterButton").addEventListener("click", () => openAuthModal("register"));
  document.getElementById("closeAuthButton").addEventListener("click", closeAuthModal);
  document.querySelectorAll("[data-auth-close]").forEach((element) => {
    element.addEventListener("click", closeAuthModal);
  });
  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    button.addEventListener("click", () => setAuthMode(button.dataset.authMode));
  });
  document.getElementById("authLoginForm").addEventListener("submit", handleLoginSubmit);
  document.getElementById("authRegisterForm").addEventListener("submit", handleRegisterSubmit);
  document.getElementById("logoutButton").addEventListener("click", handleLogout);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeAuthModal();
    }
  });

  // 初期描画では未ログイン確定のイベントを出さず、/api/auth/me の完了を待ちます。
  renderAuthState({ notify: false });
  loadCurrentUser();
}

async function loadCurrentUser() {
  if (window.location.protocol === "file:" && !AUTH_API_BASE_URL) {
    setAuthStatus("認証API未接続（予想機能は利用できます）", "info");
    finishAuthInitialization();
    return;
  }

  authState.isLoading = true;
  authState.error = null;
  try {
    const response = await requestAuth("/api/auth/me");
    authState.user = response.authenticated ? response.user : null;
  } catch (error) {
    console.error("認証状態の確認に失敗しました", error.message);
    authState.user = null;
    authState.error = { code: error?.code || "AUTH_API_UNAVAILABLE", status: Number(error?.status || 0) };
    setAuthStatus(toAuthConnectionStatus(error), "warning");
  } finally {
    authState.isLoading = false;
    finishAuthInitialization();
    if (!authState.user && shouldOpenLoginFromQuery()) {
      openAuthModal("login");
    }
  }
}

function finishAuthInitialization() {
  if (!authState.isInitialized) {
    authState.isInitialized = true;
    resolveAuthInitialization();
  }
  renderAuthState();
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  clearAuthError("login");

  const username = document.getElementById("authLoginUsername").value.trim();
  const password = document.getElementById("authLoginPassword").value;
  const validationError = validateAuthCredentials(username, password);
  if (validationError) {
    showAuthError("login", validationError);
    return;
  }

  setAuthLoading(true);
  try {
    const response = await requestAuth("/api/auth/login", {
      method: "POST",
      body: { username, password }
    });
    authState.user = response.user;
    authState.error = null;
    document.getElementById("authLoginForm").reset();
    closeAuthModal();
    renderAuthState();
    setAuthStatus("ログインしました。", "success");
    redirectToAuthReturnTo();
  } catch (error) {
    console.error("ログインに失敗しました", error.message);
    showAuthError("login", toUserAuthError(error));
  } finally {
    setAuthLoading(false);
  }
}

async function handleRegisterSubmit(event) {
  event.preventDefault();
  clearAuthError("register");

  const username = document.getElementById("authRegisterUsername").value.trim();
  const password = document.getElementById("authRegisterPassword").value;
  const passwordConfirmation = document.getElementById("authRegisterConfirmation").value;
  const validationError = validateAuthCredentials(username, password);
  if (validationError) {
    showAuthError("register", validationError);
    return;
  }
  if (password !== passwordConfirmation) {
    showAuthError("register", "パスワード確認が一致しません。");
    return;
  }

  setAuthLoading(true);
  try {
    const response = await requestAuth("/api/auth/register", {
      method: "POST",
      body: { username, password, passwordConfirmation }
    });
    authState.user = response.user;
    authState.error = null;
    document.getElementById("authRegisterForm").reset();
    closeAuthModal();
    renderAuthState();
    setAuthStatus("登録してログインしました。", "success");
    redirectToAuthReturnTo();
  } catch (error) {
    console.error("ユーザー登録に失敗しました", error.message);
    showAuthError("register", toUserAuthError(error));
  } finally {
    setAuthLoading(false);
  }
}

async function handleLogout() {
  if (authState.isLoading) {
    return;
  }

  setAuthLoading(true);
  try {
    await requestAuth("/api/auth/logout", { method: "POST" });
    authState.user = null;
    authState.error = null;
    renderAuthState();
    setAuthStatus("ログアウトしました。", "success");
  } catch (error) {
    console.error("ログアウトに失敗しました", error.message);
    setAuthStatus(toUserAuthError(error), "warning");
  } finally {
    setAuthLoading(false);
  }
}

function setAuthMode(mode) {
  authState.mode = mode === "register" ? "register" : "login";
  const isRegister = authState.mode === "register";
  document.getElementById("authDialogTitle").textContent = isRegister ? "新規登録" : "ログイン";
  document.getElementById("authLoginForm").classList.toggle("hidden", isRegister);
  document.getElementById("authRegisterForm").classList.toggle("hidden", !isRegister);
  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    const selected = button.dataset.authMode === authState.mode;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-selected", selected ? "true" : "false");
  });
  clearAuthError("login");
  clearAuthError("register");
}

function openAuthModal(mode) {
  setAuthMode(mode);
  const modal = document.getElementById("authModal");
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  const usernameInput = document.getElementById(authState.mode === "register" ? "authRegisterUsername" : "authLoginUsername");
  usernameInput.focus();
}

function shouldOpenLoginFromQuery() {
  return new URLSearchParams(window.location.search).get("auth") === "login";
}

function getSafeAuthReturnTo() {
  const value = new URLSearchParams(window.location.search).get("returnTo") || "";
  if (!value.startsWith("/") || value.startsWith("//")) return "";
  try {
    const target = new URL(value, window.location.origin);
    if (target.origin !== window.location.origin) return "";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "";
  }
}

function redirectToAuthReturnTo() {
  const returnTo = getSafeAuthReturnTo();
  if (returnTo) window.location.replace(returnTo);
}

function closeAuthModal() {
  const modal = document.getElementById("authModal");
  if (!modal || modal.classList.contains("hidden")) {
    return;
  }
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

function renderAuthState({ notify = true } = {}) {
  const isAuthenticated = Boolean(authState.user?.id && authState.user?.username);
  document.getElementById("authLoggedOut").classList.toggle("hidden", isAuthenticated);
  document.getElementById("authLoggedIn").classList.toggle("hidden", !isAuthenticated);
  document.getElementById("authUsername").textContent = isAuthenticated ? authState.user.username : "";
  if (isAuthenticated) {
    closeAuthModal();
  }
  if (notify) {
    window.dispatchEvent(new CustomEvent("starting9-auth-state-changed", {
      detail: { authenticated: isAuthenticated, user: authState.user }
    }));
  }
}

function markSessionExpired() {
  authState.user = null;
  authState.error = { code: "AUTH_SESSION_EXPIRED", status: 401 };
  renderAuthState();
  setAuthStatus("ログイン状態が切れています。再ログインしてください。", "warning");
}

function validateAuthCredentials(username, password) {
  if (!username || username.length < AUTH_USERNAME_MIN_LENGTH || username.length > AUTH_USERNAME_MAX_LENGTH) {
    return `ユーザー名は${AUTH_USERNAME_MIN_LENGTH}〜${AUTH_USERNAME_MAX_LENGTH}文字で入力してください。`;
  }
  if (!/^[\p{L}\p{N}_-]+$/u.test(username)) {
    return "ユーザー名は英数字、日本語、_、-のみ使用できます。";
  }
  if (password.length < AUTH_PASSWORD_MIN_LENGTH || password.length > AUTH_PASSWORD_MAX_LENGTH) {
    return `パスワードは${AUTH_PASSWORD_MIN_LENGTH}〜${AUTH_PASSWORD_MAX_LENGTH}文字で入力してください。`;
  }
  return "";
}

async function requestAuth(path, options = {}) {
  const baseUrl = AUTH_API_BASE_URL.replace(/\/+$/, "");
  const requestOptions = {
    method: options.method || "GET",
    credentials: "include",
    headers: {}
  };
  if (options.body !== undefined) {
    requestOptions.headers["Content-Type"] = "application/json";
    requestOptions.body = JSON.stringify(options.body);
  }

  const response = await fetch(`${baseUrl}${path}`, requestOptions);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.error || "認証APIの処理に失敗しました。");
    error.status = response.status;
    error.code = payload?.code || "";
    error.payload = payload;
    throw error;
  }
  return payload || {};
}

function setAuthLoading(isLoading) {
  authState.isLoading = isLoading;
  document.querySelectorAll("#authModal button, #authLoggedOut button, #logoutButton").forEach((button) => {
    button.disabled = isLoading;
  });
}

function showAuthError(mode, message) {
  document.getElementById(mode === "register" ? "authRegisterError" : "authLoginError").textContent = message;
}

function clearAuthError(mode) {
  document.getElementById(mode === "register" ? "authRegisterError" : "authLoginError").textContent = "";
}

function setAuthStatus(message, type) {
  const element = document.getElementById("authStatus");
  element.textContent = message;
  element.className = `auth-status${type ? ` is-${type}` : ""}`;
}

function toUserAuthError(error) {
  if (error?.code === "D1_READ_LIMIT_EXCEEDED" || Number(error?.status) === 503) {
    return "認証サービスが一時的に利用できません。時間をおいて再度お試しください。";
  }
  if ([401, 403].includes(Number(error?.status))) {
    return "ログイン状態を確認できません。ログイン情報を確認してください。";
  }
  if (error?.message && !error.message.includes("Failed to fetch")) {
    return error.message;
  }
  return "認証APIに接続できません。時間をおいて再度お試しください。";
}

function toAuthConnectionStatus(error) {
  if (error?.code === "D1_READ_LIMIT_EXCEEDED" || Number(error?.status) === 503) {
    return "認証サービスが一時的に利用できません。時間をおいて再試行してください。";
  }
  if ([401, 403].includes(Number(error?.status))) {
    return "ログイン状態を確認できません。未ログインとして利用できます。";
  }
  return "認証APIに接続できません。時間をおいて再試行してください。";
}
