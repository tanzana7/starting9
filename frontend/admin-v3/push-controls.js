(function registerAdminV3PushControls(global) {
  "use strict";

  function fromBase64Url(value) {
    const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }

  function formatIncidentTime(value) {
    const date = new Date(value || "");
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" });
  }

  function createAdminV3PushControls({ document, api, window }) {
    const panel = document.getElementById("adminPushPanel");
    const status = document.getElementById("adminPushStatus");
    const incidents = document.getElementById("adminPushIncidents");
    const subscribeButton = document.getElementById("adminPushSubscribe");
    const unsubscribeButton = document.getElementById("adminPushUnsubscribe");
    let pushStatus = null;

    function setStatus(message, isError = false) {
      if (!status) return;
      status.textContent = message;
      status.classList.toggle("error", isError);
    }

    function renderIncidents(rows = []) {
      if (!incidents) return;
      incidents.replaceChildren();
      const active = rows.filter((row) => row.status === "active");
      if (!active.length) {
        incidents.textContent = "現在の異常はありません。";
        return;
      }
      for (const incident of active.slice(0, 10)) {
        const item = document.createElement("li");
        const title = document.createElement("strong");
        title.textContent = incident.title || "運営通知";
        const body = document.createElement("span");
        body.textContent = `${incident.body || ""}${formatIncidentTime(incident.last_seen_at) ? `（${formatIncidentTime(incident.last_seen_at)}）` : ""}`;
        item.append(title, body);
        incidents.appendChild(item);
      }
    }

    function render() {
      if (!panel || !status || !subscribeButton || !unsubscribeButton) return;
      const supported = Boolean(window.Notification && window.navigator?.serviceWorker && window.PushManager);
      if (!supported) {
        setStatus("このブラウザは通知に対応していません。", true);
      } else if (window.Notification.permission === "denied") {
        setStatus("通知が拒否されています。ブラウザ設定から変更してください。", true);
      } else if (!pushStatus?.configured) {
        setStatus("運営通知は未設定です。", true);
      } else if (pushStatus.subscribed) {
        setStatus(`通知ON（登録済み端末 ${pushStatus.deviceCount || 1}）`);
      } else {
        setStatus("通知OFF");
      }
      subscribeButton.hidden = !supported || pushStatus?.subscribed === true;
      unsubscribeButton.hidden = !supported || pushStatus?.subscribed !== true;
      renderIncidents(pushStatus?.incidents || []);
    }

    async function refresh() {
      try {
        pushStatus = await api.getPushStatus();
        render();
      } catch (error) {
        setStatus(error?.status === 401 || error?.status === 403 ? "管理者ログインが必要です。" : "運営通知の状態を取得できません。", true);
      }
    }

    async function subscribe() {
      if (!window.Notification || !window.navigator?.serviceWorker || !window.PushManager) { render(); return; }
      if (!pushStatus?.configured) { render(); return; }
      if (window.Notification.permission === "denied") { render(); return; }
      subscribeButton.disabled = true;
      try {
        const permission = await window.Notification.requestPermission();
        if (permission !== "granted") { render(); return; }
        const registration = await window.navigator.serviceWorker.register("/admin-push-sw.js?v=v5-phase6-1", { scope: "/" });
        const existing = await registration.pushManager.getSubscription();
        const subscription = existing || await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: fromBase64Url(pushStatus.publicKey)
        });
        const key = (name) => {
          const value = subscription.getKey(name);
          let binary = "";
          for (const byte of new Uint8Array(value || [])) binary += String.fromCharCode(byte);
          return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
        };
        await api.subscribePush({ endpoint: subscription.endpoint, p256dh: key("p256dh"), auth: key("auth") });
        await refresh();
      } catch (error) {
        setStatus(error?.message || "通知登録に失敗しました。", true);
      } finally {
        subscribeButton.disabled = false;
      }
    }

    async function unsubscribe() {
      unsubscribeButton.disabled = true;
      try {
        const registration = await window.navigator.serviceWorker.getRegistration("/");
        const subscription = await registration?.pushManager?.getSubscription();
        await api.unsubscribePush(subscription?.endpoint ? { endpoint: subscription.endpoint } : {});
        await subscription?.unsubscribe?.();
        await refresh();
      } catch (error) {
        setStatus(error?.message || "通知解除に失敗しました。", true);
      } finally {
        unsubscribeButton.disabled = false;
      }
    }

    subscribeButton?.addEventListener("click", () => { void subscribe(); });
    unsubscribeButton?.addEventListener("click", () => { void unsubscribe(); });
    render();
    return Object.freeze({ refresh, render });
  }

  global.Starting9AdminV3 = global.Starting9AdminV3 || {};
  global.Starting9AdminV3.createAdminV3PushControls = createAdminV3PushControls;
})(window);
