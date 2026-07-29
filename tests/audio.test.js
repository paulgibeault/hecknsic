/**
 * audio.test.js — the capability gate in js/audio.js, and that no play-wrapper
 * can throw whichever way it goes.
 *
 * The gate is the whole safety story of this module. A player on a stale
 * service-worker cache gets an older /arcade-audio.js that still has `graph()`
 * and `el()` but is missing the elements the pack is built from — and a cue
 * that half-plays and then throws at play time is worse than silence. So
 * registration is gated on the pack's actual element dependencies, not on a
 * version number, and when the gate fails the module registers NOTHING: the
 * pack is the sound, there is no fallback, and silence on a stale cache is
 * deliberate (fleet decision 2026-07-28 — chiptune is an aesthetic a game
 * adopts, not a degraded mode).
 *
 * Every case also asserts the wrappers are safe no-ops when nothing is
 * registered: they are called from the game loop, the input path and the move
 * path, where a throw would take the game down with it.
 */

import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const AUDIO = join(dirname(fileURLToPath(import.meta.url)), '..', 'js', 'audio.js');

// The full element library as of the version this pack was written against.
const ALL_ELEMENTS = [
  'strike', 'rustle', 'pluck', 'creak', 'droplet', 'body', 'thump', 'flare',
  'blast', 'chirp', 'stream', 'shatter', 'ratchet', 'drone', 'teardown',
];

// What this game's pack actually needs beyond the pre-3.7.0 set.
const NEW_ELEMENTS = ['shatter', 'ratchet', 'drone'];

const PACK_CUES = [
  'rotate', 'select', 'match', 'combo', 'starflower', 'blackpearl',
  'grandpoobah', 'bomb-arrive', 'bomb-tick', 'bomb-explode', 'game-over',
  'over-achiever', 'game-win', 'ui-click',
];

/** A stub `window` with a recording Arcade.audio surface. */
function makeWindow({ elements, withPack }) {
  const seen = { cues: [], graphs: [], rooms: 0, plays: [] };
  const el = Object.fromEntries(elements.map((n) => [n, () => {}]));
  const audio = {
    cue(n) { seen.cues.push(n); return audio; },
    graph(n, fn, o) { seen.graphs.push({ n, sustained: !!(o && o.sustained) }); return audio; },
    room() { seen.rooms++; return audio; },
    start() { return { stop() {}, retune() {} }; },
    play(n) { seen.plays.push(n); },
    el: () => el,
  };
  const w = { Arcade: { audio } };
  if (withPack) {
    // The framework's well-known handle — js/soundpack.js publishes here via
    // ArcadeAudioElements.registerPack(), so the launcher's soundpack tooling
    // can reach any game's pack without knowing the game's name.
    w.ArcadeSoundPack = {
      ROOM: {}, SENDS: {},
      CUES: Object.fromEntries(PACK_CUES.map((n) => [n, () => {}])),
      pulse() {}, tension() {},
    };
  }
  return { w, seen };
}

// Each import needs a distinct query so the module re-evaluates: registration
// is a load-time side effect (convention A1), which is the thing under test.
async function loadAudio(w, tag) {
  global.window = w;
  return import(`${AUDIO}?${tag}`);
}

/** Every wrapper the game calls, with representative arguments. */
function callEveryWrapper(m) {
  m.playRotate('cluster'); m.playRotate('ring'); m.playRotate('y'); m.playRotate();
  m.playSelect();
  m.playMatch(3); m.playMatch(12);
  m.playCombo(1); m.playCombo(20);
  m.playSpecial('starflower'); m.playSpecial('blackpearl'); m.playSpecial('grandpoobah');
  m.playSpecial('nonsense');
  m.playBombArrive();
  m.playBombTick(0); m.playBombTick(1);
  m.playGameOver(false); m.playGameOver(true);
  m.playOverAchiever(); m.playGameWin();
  m.startBed('arcade'); m.startBed('chill'); m.startBed('puzzle'); m.startBed(undefined);
  m.setBedUrgency(0); m.setBedUrgency(0.9); m.setBedUrgency(NaN); m.setBedUrgency();
  m.stopBed(); m.stopBed(2);
}

test('graph path: modern element library + pack present', async () => {
  const { w, seen } = makeWindow({ elements: ALL_ELEMENTS, withPack: true });
  const m = await loadAudio(w, 'graph');

  assert.equal(seen.rooms, 1, 'the shared room is installed exactly once');
  assert.equal(seen.cues.length, 0, 'no spec cues — the pack is the sound');
  assert.equal(seen.graphs.length, PACK_CUES.length + 2, 'every pack cue plus both beds');
  assert.deepEqual(
    seen.graphs.filter((g) => g.sustained).map((g) => g.n).sort(),
    ['pulse', 'tension'],
    'the beds — and only the beds — register as sustained',
  );
  assert.doesNotThrow(() => callEveryWrapper(m));
});

// The case the gate exists for: `graph()` and `el()` are present, so a naive
// version check would register the pack and then throw inside a cue. Instead:
// nothing registers, nothing plays, nothing throws. Silence by design.
for (const missing of NEW_ELEMENTS) {
  test(`gate fails: element library missing '${missing}' — registers nothing`, async () => {
    const { w, seen } = makeWindow({
      elements: ALL_ELEMENTS.filter((n) => n !== missing),
      withPack: true,
    });
    const m = await loadAudio(w, `missing-${missing}`);

    assert.equal(seen.graphs.length, 0, 'must not register the pack');
    assert.equal(seen.rooms, 0, 'must not install a room it cannot use');
    assert.equal(seen.cues.length, 0, 'no fallback — nothing registered at all');
    assert.doesNotThrow(() => callEveryWrapper(m));
    assert.equal(seen.plays.length, 0, 'wrappers never reach play() with nothing registered');
  });
}

test('gate fails: pack script absent (standalone, no soundpack.js) — silence', async () => {
  const { w, seen } = makeWindow({ elements: ALL_ELEMENTS, withPack: false });
  const m = await loadAudio(w, 'nopack');

  assert.equal(seen.graphs.length, 0, 'no pack means nothing to register');
  assert.equal(seen.rooms, 0, 'no room either');
  assert.equal(seen.cues.length, 0, 'and no spec cues — no fallback exists');
  assert.doesNotThrow(() => callEveryWrapper(m));
  assert.equal(seen.plays.length, 0, 'every wrapper is a silent no-op');
});

test('no Arcade at all: import is inert and every wrapper is a safe no-op', async () => {
  global.window = {};
  const m = await loadAudio(global.window, 'noarcade');
  assert.doesNotThrow(() => callEveryWrapper(m));
});
