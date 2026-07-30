/**
 * service-worker.test.js — the three sw.js invariants that have each already
 * cost us a production incident or come one step from it.
 *
 * 1. Cleanup is scoped to our own caches. `caches.keys()` is ORIGIN-scoped and
 *    the whole fleet shares paulgibeault.github.io, so the obvious
 *    `key !== CACHE_VERSION` filter deletes the launcher's cache and every
 *    sibling game's on every activation. Four of five fleet workers shipped
 *    that filter. Going cache-first fleet-wide makes it worse, not better.
 *
 * 2. The cache identity keeps the shape fleet CI rewrites, and derives from
 *    it. If that line stops matching CI's sed, the rewrite silently stops
 *    firing and every returning player is stranded on a stale cache — which
 *    is how #51 deployed green and reached nobody. This replaces the
 *    launcher's diff-based check-sw-bump gate with something that needs no
 *    git history and cannot be skipped on a shallow clone.
 *
 * 3. install() does not skipWaiting. The launcher's update flow depends on the
 *    new worker WAITING so the player can be offered a reload; a worker that
 *    activates unannounced swaps the cache under a running game.
 *
 * The worker is evaluated in a vm with a fake ServiceWorkerGlobalScope rather
 * than mocked, so the assertions run the real handler bodies.
 */

import assert from 'node:assert';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SW_SRC = readFileSync(join(ROOT, 'sw.js'), 'utf8');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')); // used for realistic cache keys

/** Evaluate sw.js against a fake global scope and return the handles. */
function loadWorker({ cacheKeys = [], failAdd = null } = {}) {
  const deleted = [];
  const handlers = {};
  const calls = { skipWaiting: 0, claim: 0, added: [] };

  const caches = {
    keys: async () => cacheKeys.slice(),
    delete: async (k) => { deleted.push(k); return true; },
    open: async () => ({
      // Per-asset add(), matching the shared template. `failAdd` makes one
      // entry 404 so a test can prove the rest still cache.
      add: async (asset) => {
        if (asset === failAdd) throw new Error('404');
        calls.added.push(asset);
      },
      put: async () => {},
    }),
    match: async () => undefined,
  };

  const self = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: () => { calls.skipWaiting++; },
    clients: { claim: () => { calls.claim++; } },
    registration: { scope: 'https://paulgibeault.github.io/hecknsic/' },
    location: { hostname: 'paulgibeault.github.io' },
    caches,
  };

  const ctx = vm.createContext({ self, caches, console });
  vm.runInContext(SW_SRC, ctx);

  // Drive an event and await whatever the handler passed to waitUntil.
  const fire = async (type, data) => {
    assert.ok(handlers[type], `sw.js registered no '${type}' handler`);
    let waited = null;
    await handlers[type]({ ...data, waitUntil: (p) => { waited = p; } });
    if (waited) await waited;
  };

  return { fire, deleted, calls, ctx };
}

test('activate deletes only this game\'s caches, never a sibling\'s', async () => {
  // A realistic origin: the launcher, two sibling games, our own stale cache,
  // our current one, and a legacy spelling of ours.
  const w = loadWorker({
    cacheKeys: [
      'paul-arcade-v67',      // launcher — must survive
      'pi-game-v7',           // sibling — must survive
      'sowduku-shell-v10',    // sibling — must survive
      'neck-pt-v7',           // sibling — must survive
      'hecknsic-v1.5.2',      // ours, stale — must go
      `hecknsic-v${PKG.version}`, // ours, current — must stay
    ],
  });

  await w.fire('activate');

  assert.deepStrictEqual(
    w.deleted, ['hecknsic-v1.5.2'],
    'activate must delete exactly our own stale caches — deleting anything ' +
    'else destroys another app\'s offline support, and keeping our own stale ' +
    'one is what serves players a fix they never execute');
  assert.strictEqual(w.calls.claim, 1, 'activate should claim clients');
});

test('the cache identity is in the shape CI rewrites, and derives from it', () => {
  // Deliberately a SHAPE check, not `APP_VERSION === PKG.version`. CI writes
  // both in one commit so they match on main, but any PR open across a deploy
  // merges a newer package.json onto an older sw.js — equality would fail on
  // branch staleness, which says nothing about whether the app is correct.
  //
  // The shape is the real invariant anyway: fleet-ci.yml rewrites via
  //   sed "s/^const APP_VERSION = '[^']*';/…/"
  // so if this line stops matching that pattern, the rewrite silently stops
  // firing and every returning player is stranded on a stale cache — which is
  // exactly how #51 shipped to nobody. Asserting the shape asserts the rewrite
  // will land.
  const declared = /^const APP_VERSION = '([^']*)';$/m.exec(SW_SRC);
  assert.ok(
    declared,
    "sw.js must declare `const APP_VERSION = '…';` at the start of a line, " +
    'single-quoted — that exact shape is what fleet-ci.yml rewrites on deploy');
  assert.match(
    declared[1], /^\d+\.\d+\.\d+$/,
    `APP_VERSION should be a bare semver (got '${declared[1]}')`);

  // …and the cache name must actually depend on it. A hardcoded literal here
  // is the original bug: the version advances, the cache identity doesn't, and
  // activate-time cleanup never runs.
  assert.match(
    SW_SRC, /^const CACHE_VERSION = `\$\{CACHE_PREFIX\}v\$\{APP_VERSION\}`;$/m,
    'CACHE_VERSION must interpolate CACHE_PREFIX and APP_VERSION, not hardcode ' +
    'a literal — otherwise bumping the version leaves the cache identity ' +
    'unchanged and no update ever fires');
});

test('install precaches and does NOT skipWaiting', async () => {
  const w = loadWorker();
  await w.fire('install');

  assert.ok(w.calls.added.length > 0, 'install should precache assets');
  // Only the shell is asserted here. WHAT gets precached is no longer written
  // in this file — tools/stage.mjs generates the list from the deploy artifact,
  // so the checked-in array is a placeholder and this test would be asserting
  // a fixture. Coverage of the real list lives in tools/verify-artifact.mjs,
  // which fails on any published file the worker does not cache.
  assert.ok(w.calls.added.includes('./index.html'),
    'the app shell should always be precached');
  assert.strictEqual(
    w.calls.skipWaiting, 0,
    'install must not skipWaiting — the launcher\'s update prompt depends on ' +
    'the new worker waiting, and activating unannounced swaps the cache under ' +
    'a running game');
});

test('one missing asset does not cost the player the whole offline shell', async () => {
  // The reason install() uses per-asset add() rather than addAll(): addAll()
  // rejects entirely on a single 404, so one unpublished file silently leaves
  // a returning player with no cache at all. A gap should cost one file.
  const w = loadWorker({ failAdd: './index.html' });
  await w.fire('install');
  assert.ok(w.calls.added.length > 0,
    'the surviving assets should still be cached when one entry 404s');
});

test('the launcher can activate a waiting worker on demand', async () => {
  const w = loadWorker();
  await w.fire('message', { data: { type: 'arcade:sw.skipWaiting' } });
  assert.strictEqual(w.calls.skipWaiting, 1, 'the update control must be able to activate the waiting worker');

  const ignored = loadWorker();
  await ignored.fire('message', { data: { type: 'something-else' } });
  assert.strictEqual(ignored.calls.skipWaiting, 0, 'unrelated messages must not activate the worker');
});
