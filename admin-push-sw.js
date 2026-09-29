const ADMIN_PATH = "/admin-v3.html";

function safeAdminPath(value) {
  const raw = String(value || "");
  if (!raw.startsWith(ADMIN_PATH) || raw.startsWith("//") || raw.includes("\\")) return ADMIN_PATH;
  try {
    const url = new URL(raw, self.location.origin);
    if (url.origin !== self.location.origin || url.pathname !== ADMIN_PATH) return ADMIN_PATH;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return ADMIN_PATH; }
}

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = String(data.title || "Starting9 運営通知").slice(0, 120);
  const body = String(data.body || "管理画面を確認してください。").slice(0, 240);
  const actionPath = safeAdminPath(data.actionPath);
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag: String(data.dedupeKey || "starting9-admin-alert").slice(0, 240),
    renotify: false,
    data: { actionPath }
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const actionPath = safeAdminPath(event.notification?.data?.actionPath);
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => client.url.startsWith(self.location.origin));
    if (existing) return existing.navigate(new URL(actionPath, self.location.origin).toString()).then(() => existing.focus());
    return self.clients.openWindow(new URL(actionPath, self.location.origin).toString());
  }));
});

// Exported only as a test-readable marker; the worker has no fetch handler or
// cache behavior and therefore cannot alter the public site's requests.
