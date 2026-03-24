self.addEventListener("install", e => {
  e.waitUntil(
    caches.open("unearthed-v1").then(cache => {
      return cache.addAll(["/index.html", "/site.manifest"]);
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
