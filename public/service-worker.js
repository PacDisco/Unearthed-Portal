// Bump this string any time you ship a release that should bust the
// install-time cache for previously-installed PWA users. The activate
// handler below deletes any cache whose name doesn't match.
const CACHE_NAME = "unearthed-v4-admin";
const STATIC_FILES = ["/index.html", "/login.html", "/site.webmanifest"];

// Install — cache static files
self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_FILES))
  );
  self.skipWaiting(); // activate immediately
});

// Activate — delete old caches
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim(); // take control immediately
});

// Fetch — network first, fall back to cache
self.addEventListener("fetch", e => {
  const url = e.request.url;

  // Always go to network for API calls
  if (url.includes("/.netlify/functions/") || url.includes("/document-proxy")) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Don't try to handle requests we can't legally cache — Cache.put()
  // throws on non-http(s) schemes (chrome-extension://, data:, etc.).
  // Just pass them through to the network and stay out of the way.
  if (!/^https?:/i.test(url)) {
    return; // let the browser handle it normally
  }
  // Cross-origin POST/PUT requests etc. shouldn't be cached either.
  if (e.request.method !== "GET") return;

  // Network first for everything else
  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Only cache successful, basic (same-origin) responses.
        if (res && res.ok && res.type === "basic") {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, resClone))
            .catch(err => console.warn("[sw] cache.put skipped:", err && err.message));
        }
        return res;
      })
      .catch(() => caches.match(e.request)) // fall back to cache if offline
  );
});
