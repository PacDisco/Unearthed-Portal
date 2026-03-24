self.addEventListener("install", e => {
  e.waitUntil(
    caches.open("unearthed-v1").then(cache => {
      return cache.addAll(["/portal.html", "/manifest.json"]);
    })
  );
});

self.addEventListener("fetch", e => {
  e.respondWith(
    caches.match(e.request).then(response => {
      return response || fetch(e.request);
    })
  );
});
