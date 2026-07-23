// Hecknsic Service Worker — offline-first cache
const APP_VERSION = '1.4.1';
const CACHE_VERSION = `hecknsic-v${APP_VERSION}`;

// WARNING: This list is manually maintained. When adding new static assets
// (JS files, CSS files, images, sounds, etc.), update this list too or
// offline mode will silently break for those assets.
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './css/overlays.css',
  './js/audio.js',
  './js/board.js',
  './js/constants.js',
  './js/daily-puzzle.js',
  './js/hex-math.js',
  './js/input.js',
  './js/main.js',
  './js/modes.js',
  './js/puzzle-editor.js',
  './js/puzzle-mode.js',
  './js/puzzles.js',
  './js/renderer.js',
  './js/score.js',
  './js/specials.js',
  './js/storage.js',
  './js/tween.js',
  './img/logo_header.png',
  './img/icon-192.png',
  './img/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Cache-first for all GET requests — serves static assets offline.
  if (event.request.method !== 'GET') return;

  // Only handle requests within this game's own scope — otherwise launcher
  // assets like /arcade-sdk.js get cached under our origin-wide fetch handler
  // and a stale SDK is served indefinitely.
  if (!event.request.url.startsWith(self.registration.scope)) return;

  const isLoopback = self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1';

  if (isLoopback) {
    // Network-first on localhost: prefer fresh files during development
    // (no stale-cache surprises while iterating without a version bump),
    // but still fall back to cache when actually offline, so this worker
    // exercises real offline behavior instead of stepping aside entirely.
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type !== 'opaque') {
            const cloned = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, cloned));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response;
        }
        const cloned = response.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, cloned));
        return response;
      });
    })
  );
});
