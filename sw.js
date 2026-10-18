/* ===========================================================================
   sw.js — service worker: makes OmniList installable and usable offline.
   Strategy: network-first for the app's own files (so you always get the
   latest version when online), falling back to the cached copy offline.
   The local eBay backend (/api/*) and other sites are never cached.
   Bump CACHE when the list of shell files changes.
   =========================================================================== */
const CACHE = "omnilist-v2";
const SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "assets/styles.css",
  "js/ui.js",
  "js/store.js",
  "js/fees.js",
  "js/connectors.js",
  "js/backend.js",
  "js/appraisal.js",
  "js/views.js",
  "js/inventory.js",
  "js/settings.js",
  "js/app.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.indexOf("/api/") !== -1) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === "navigate" ? caches.match("index.html") : Response.error()))
      )
  );
});
