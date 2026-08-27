// HoodMint Radar service worker — Web Push only (feature-backlog.md,
// shipped 2026-08-22). No asset caching, no offline mode: this app is a
// live, self-hosted radar where a stale cached page is worse than no
// cache at all (PRD's read-only-until-armed data must always be fresh).
// This worker's entire job is: receive a push event, show a notification;
// receive a click on that notification, focus or open the app.

self.addEventListener("install", () => {
  // Activate immediately rather than waiting for all tabs to close — a
  // notifications-only worker has no old-cache-vs-new-cache conflict to
  // worry about.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = { title: "HoodMint Radar", body: "" };
  try {
    if (event.data) {
      payload = { ...payload, ...event.data.json() };
    }
  } catch {
    // Malformed/non-JSON payload — fall back to the generic title/body
    // above rather than dropping the notification.
  }
  const title = typeof payload.title === "string" ? payload.title : "HoodMint Radar";
  const options = {
    body: typeof payload.body === "string" ? payload.body : "",
    // No icon/badge: this app has no PNG icon asset committed yet (only
    // the inline SVG mark used in the nav) — a missing icon degrades
    // gracefully to the browser's default, so this is a cosmetic gap to
    // fill later, not a broken reference now.
    data: { url: typeof payload.url === "string" ? payload.url : "/" },
    // Alerts are time-sensitive (a restricted-stage window can be
    // minutes wide) — never silently collapse two different alerts into
    // one notification by reusing the same tag.
    tag: `hoodmint-${Date.now()}`,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url ? event.notification.data.url : "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.endsWith(targetUrl) && "focus" in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return undefined;
    }),
  );
});
