// Offline support. The shell and questions are cached per build (__BUILD__ is
// replaced by build_web.py); pictures go to a long-lived cache, filled on first
// view or all at once from Settings -> Offline.
const SHELL = "pdr-shell-__BUILD__";
const IMG = "pdr-img-v1";
const FILES = ["./", "index.html", "style.css", "app.js", "telemetry.js", "config.js", "vendor/ts-fsrs-5.4.2.mjs",
               "questions.json", "manifest.webmanifest", "icon.svg", "icon-192.png", "privacy.html"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== IMG).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.includes("/img/")) {
    e.respondWith(caches.open(IMG).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok) c.put(e.request, r.clone());
      return r;
    }));
    return;
  }
  // Shell: network first so updates show up, cache when offline.
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })
    .then((hit) => hit || caches.match("index.html"))));
});
