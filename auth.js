// 認証APIのURLです。同一オリジン配下に公開する場合は空文字のまま使います。
// 別Workerを直接呼ぶ場合は、末尾スラッシュなしのHTTPS URLを設定してください。
const AUTH_API_BASE_URL =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1"
    ? "http://localhost:8787"
    : "";
const AUTH_USERNAME_MIN_LENGTH = 3;
const AUTH_USERNAME_MAX_LENGTH = 16;
const AUTH_PASSWORD_MIN_LENGTH = 8;
const AUTH_PASSWORD_MAX_LENGTH = 72;

const authState = {
  user: null,
  mode: "login",
  isLoading: false
};

window.starting9Auth = {
  getUser: () => authState.user,
  getApiBaseUrl: () => AUTH_API_BASE_URL,
  openLogin: () => openAuthModal("login")
};

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

  renderAuthState();
  loadCurrentUser();
}

async function loadCurrentUser() {
  if (window.location.protocol === "file:" && !AUTH_API_BASE_URL) {
    setAuthStatus("認証API未接続（予想機能は利用できます）", "info");
    return;
  }

  try {
    const response = await requestAuth("/api/auth/me");
    authState.user = response.authenticated ? response.user : null;
    renderAuthState();
  } catch (error) {
    console.error("認証状態の確認に失敗しました", error.message);
    setAuthStatus("認証APIに接続できません（予想機能は利用できます）", "warning");
  }
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
    document.getElementById("authLoginForm").reset();
    closeAuthModal();
    renderAuthState();
    setAuthStatus("ログインしました。", "success");
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
    document.getElementById("authRegisterForm").reset();
    closeAuthModal();
    renderAuthState();
    setAuthStatus("登録してログインしました。", "success");
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

function closeAuthModal() {
  const modal = document.getElementById("authModal");
  if (!modal || modal.classList.contains("hidden")) {
    return;
  }
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

function renderAuthState() {
  const isAuthenticated = Boolean(authState.user?.id && authState.user?.username);
  document.getElementById("authLoggedOut").classList.toggle("hidden", isAuthenticated);
  document.getElementById("authLoggedIn").classList.toggle("hidden", !isAuthenticated);
  document.getElementById("authUsername").textContent = isAuthenticated ? authState.user.username : "";
  if (isAuthenticated) {
    closeAuthModal();
  }
  window.dispatchEvent(new CustomEvent("starting9-auth-state-changed", {
    detail: { authenticated: isAuthenticated, user: authState.user }
  }));
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
    throw new Error(payload?.error || "認証APIの処理に失敗しました。");
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
  if (error?.message && !error.message.includes("Failed to fetch")) {
    return error.message;
  }
  return "認証APIに接続できません。時間をおいて再度お試しください。";
}
