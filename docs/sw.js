// Service worker: receives deadline alerts (Web Push) even when the dashboard
// is closed. The push itself carries no content, so on each one we fetch the
// current message from the Worker and show it. It deliberately doesn't cache
// anything, so it never makes the dashboard show stale pages.

const WORKER = "https://fpl-live.calubrow.workers.dev";

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let msg = { title: "FPL deadline soon", body: "The gameweek deadline is coming up." };
    try {
      const resp = await fetch(`${WORKER}/push/latest`, { cache: "no-store" });
      if (resp.ok) msg = await resp.json();
    } catch (err) {
      // offline or Worker unavailable: show the generic message
    }
    await self.registration.showNotification(msg.title, {
      body: msg.body,
      icon: "img/icon-192.png",
      tag: "fpl-deadline",  // a newer alert replaces an older one
    });
  })());
});

// Tapping the alert opens (or focuses) the dashboard
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (open.length) return open[0].focus();
    return self.clients.openWindow(self.registration.scope);
  })());
});
