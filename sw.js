// Hecknsic Service Worker — offline-first cache
const CACHE_VERSION = 'hecknsic-v1.2.3';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './css/overlays.css',
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
  // Cache-first for static assets, network-first for everything else
  if (event.request.method !== 'GET') return;

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
