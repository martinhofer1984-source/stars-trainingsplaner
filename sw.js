// Service worker: keeps the app shell and the Firebase SDK cached so the app starts without network.
// Strategy: the page is loaded network first (cache when offline), so an update is used at the
// next start; icons and other files are served from cache and refreshed in the background.
// Bump CACHE when files are added or removed; keep SDK in sync with index.html.
const CACHE = "stars-trainingsplaner-v3";
const SDK = "https://www.gstatic.com/firebasejs/12.6.0/";
const FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
  SDK + "firebase-app.js",
  SDK + "firebase-auth.js",
  SDK + "firebase-firestore.js",
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Firestore and sign-in traffic goes straight to the network; only the app files and the SDK are cached.
  const isSdk = req.url.startsWith(SDK);
  if (url.origin !== self.location.origin && !isSdk) return;
  // The page itself: network first (3 s), so a fixed version is used at the next start; cache when offline
  if (req.mode === "navigate") {
    event.respondWith(
      caches.open(CACHE).then(async cache => {
        try {
          const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000))]);
          if (res.ok) cache.put("./index.html", res.clone());
          return res;
        } catch {
          return (await cache.match("./index.html")) || (await cache.match(req, { ignoreSearch: true })) || Response.error();
        }
      })
    );
    return;
  }
  event.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(req, { ignoreSearch: !isSdk });
      if (cached && isSdk) return cached;   // versioned SDK files never change
      const network = fetch(req)
        .then(res => { if (res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => cached);
      return cached || network;
    })
  );
});
