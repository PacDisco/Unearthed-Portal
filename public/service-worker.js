const CACHE_NAME = "unearthed-v2";
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
  // Always go to network for API calls
  if (e.request.url.includes("/.netlify/functions/")) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Network first for everything else
  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Update cache with fresh response
        const resClone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, resClone));
        return res;
      })
      .catch(() => caches.match(e.request)) // fall back to cache if offline
  );
});
