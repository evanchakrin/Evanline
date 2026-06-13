const CACHE_NAME = 'evanline-v8';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './assets/css/styles.css?v=8',
  './assets/js/app.js?v=8',
  './assets/js/domain.js',
  './assets/js/precision.js',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys
      .filter(key => key !== CACHE_NAME)
      .map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then(async response => {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(event.request, response.clone());
        return response;
      }).catch(async error => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        const fallback = await caches.match('./index.html');
        if (fallback) return fallback;
        console.warn('Navigation request failed with no cached fallback.', event.request.url, error);
        return Response.error();
      })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      return response;
    }).catch(error => {
      console.warn('Asset request failed.', event.request.url, error);
      return Response.error();
    }))
  );
});
