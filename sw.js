/* Hecknsic Service Worker — offline-first cache.
 *
 * CANONICAL FLEET SHAPE. The structure here — version line, owned-prefix
 * cleanup, cache-first fetch, skip-waiting message — is meant to be identical
 * across every arcade app; only APP_VERSION, CACHE_PREFIX and ASSETS differ.
 * Fix a bug here and it has to be carried everywhere, the same rule as
 * tools/verify-artifact.mjs.
 */

// Written by fleet CI on every deploy (fleet-ci.yml, "Bump patch version").
// DO NOT EDIT BY HAND — a hand-maintained constant drifts, and when it drifts
// the origin serves a fix that no returning player ever executes. That is not
// hypothetical: it is what happened to #51, which deployed green and reached
// nobody until #52 bumped this line by hand.
//
// Tracks the app version now, so it moves on every deploy. The old private
// 1.5.x counter is abandoned deliberately: only string inequality matters for
// cache identity, so going "backwards" to 1.2.x still invalidates correctly.
const APP_VERSION = '1.2.31';

// Every cache this game has ever owned starts with this prefix. Cleanup is
// filtered to it — see the activate handler for why that is not optional.
const CACHE_PREFIX = 'hecknsic-';
const CACHE_VERSION = `${CACHE_PREFIX}v${APP_VERSION}`;

// WARNING: This list is manually maintained. When adding new static assets
// (JS files, CSS files, images, sounds, etc.), update this list too or
// offline mode will silently break for those assets.
// Everything this game needs to boot offline — GENERATED, not maintained.
// tools/stage.mjs rewrites the region below from the files the deploy actually
// publishes (tools/inject-precache.mjs), so the list cannot drift from the
// artifact and a content-hashed bundle name needs no hand edit. To leave a
// file out, name it in PRECACHE_EXCLUDE in tools/stage.mjs — never here.
//
// What is checked in is a placeholder: service workers are off on loopback, so
// a dev checkout never reads it.
// arcade:precache-begin
const ASSETS = [
  './',
  './index.html',
];
// arcade:precache-end

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => Promise.all(
      // Per-asset add(), not addAll(). addAll() rejects the WHOLE install on a
      // single 404, so one missing file costs a returning player their entire
      // offline shell — silently. A gap should cost one file and a log line.
      ASSETS.map(asset => cache.add(asset).catch(err =>
        console.warn('[sw] precache skipped', asset, err && err.message)))
    ))
  );
  // Deliberately NOT skipWaiting(). The new worker installs and waits; the
  // launcher spots it and offers the player an explicit "update ready" reload,
  // then sends the message below once they accept. Activating unannounced
  // would swap the cache under a running game, so anything fetched lazily
  // after the swap would come from a different build than the code asking.
});

self.addEventListener('message', (event) => {
  // Sent by the launcher's update control (settings → "Check for updates", or
  // the automatic prompt) once the player accepts the reload.
  if (event.data && event.data.type === 'arcade:sw.skipWaiting') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          // ONLY our own caches. caches.keys() is origin-scoped and the whole
          // fleet shares paulgibeault.github.io, so the bare `key !== current`
          // filter this used to have deleted the launcher's cache and every
          // sibling game's on each activation — every app silently destroying
          // every other app's offline support.
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION)
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
    caches.match(event.request, { ignoreSearch: true }).then((cached) => {
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
