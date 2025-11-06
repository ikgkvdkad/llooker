const CACHE_VERSION = 'v1';
const CACHE_NAME = `camera-pwa-${CACHE_VERSION}`;
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
      .catch((error) => {
        console.error('Service worker precache failed:', error);
        throw error;
      })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((oldKey) => caches.delete(oldKey))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  const { origin } = new URL(event.request.url);
  if (origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME)
              .then((cache) => cache.put(event.request, responseClone))
              .catch((error) => {
                console.error('Failed to update cache entry:', error);
              });
          }
          return response;
        })
        .catch((error) => {
          if (!cachedResponse) {
            console.error('Network request failed and no cache available:', event.request.url, error);
            throw error;
          }
          return cachedResponse;
        });

      return cachedResponse || networkFetch;
    })
  );
});
