/**
 * audio.test.js — which registration path js/audio.js takes, and that no
 * play-wrapper can throw on any of them.
 *
 * The path choice is the whole safety story of this module. A player on a
 * stale service-worker cache gets an older /arcade-audio.js that still has
 * `graph()` and `el()` but is missing the elements the pack is built from —
 * and a cue that half-plays and then throws at play time is worse than the
 * archived chiptune profile. So the graph path is gated on the pack's actual
 * element dependencies, not on a version number, and that gate is what these
 * tests pin down.
 *
 * Every case also asserts the graph-only wrappers are safe no-ops on the
 * fallback path: they are called from the game loop, the input path and the
 * move path, where a throw would take the game down with it.
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
  const seen = { cues: [], graphs: [], rooms: 0 };
  const el = Object.fromEntries(elements.map((n) => [n, () => {}]));
  const audio = {
    cue(n) { seen.cues.push(n); return audio; },
    graph(n, fn, o) { seen.graphs.push({ n, sustained: !!(o && o.sustained) }); return audio; },
    room() { seen.rooms++; return audio; },
    start() { return { stop() {}, retune() {} }; },
    play() {},
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
  assert.equal(seen.cues.length, 0, 'no chiptune cues registered on the graph path');
  assert.equal(seen.graphs.length, PACK_CUES.length + 2, 'every pack cue plus both beds');
  assert.deepEqual(
    seen.graphs.filter((g) => g.sustained).map((g) => g.n).sort(),
    ['pulse', 'tension'],
    'the beds — and only the beds — register as sustained',
  );
  assert.doesNotThrow(() => callEveryWrapper(m));
});

// The case this gate exists for: `graph()` and `el()` are present, so a naive
// version check would take the graph path and then throw inside a cue.
for (const missing of NEW_ELEMENTS) {
  test(`fallback: element library missing '${missing}'`, async () => {
    const { w, seen } = makeWindow({
      elements: ALL_ELEMENTS.filter((n) => n !== missing),
      withPack: true,
    });
    const m = await loadAudio(w, `missing-${missing}`);

    assert.equal(seen.graphs.length, 0, 'must not take the graph path');
    assert.equal(seen.rooms, 0, 'must not install a room it cannot use');
    assert.ok(seen.cues.includes('match'), 'archived chiptune profile registered instead');
    assert.doesNotThrow(() => callEveryWrapper(m));
  });
}

test('fallback: the archived chiptune profile registers its full cue set', async () => {
  const stale = ALL_ELEMENTS.filter((n) => !NEW_ELEMENTS.includes(n));
  const { w, seen } = makeWindow({ elements: stale, withPack: true });
  await loadAudio(w, 'stale-all');

  assert.deepEqual(
    seen.cues.slice().sort(),
    ['bomb', 'combo', 'game-over', 'match', 'rotate', 'special', 'ui-click'],
    'exactly the cues frozen at 9169f43',
  );
});

test('fallback: pack script absent (standalone, no soundpack.js)', async () => {
  const { w, seen } = makeWindow({ elements: ALL_ELEMENTS, withPack: false });
  const m = await loadAudio(w, 'nopack');

  assert.equal(seen.graphs.length, 0, 'no pack means no graph path');
  assert.ok(seen.cues.includes('match'), 'chiptune registered');
  assert.doesNotThrow(() => callEveryWrapper(m));
});

test('no Arcade at all: import is inert and every wrapper is a safe no-op', async () => {
  global.window = {};
  const m = await loadAudio(global.window, 'noarcade');
  assert.doesNotThrow(() => callEveryWrapper(m));
});

test('comboFreq: rises with depth and stays inside a sane range', async () => {
  const { w } = makeWindow({ elements: ALL_ELEMENTS, withPack: true });
  const { comboFreq } = await loadAudio(w, 'combofreq');

  assert.equal(comboFreq(0), 440, 'base note at depth 0');
  assert.ok(comboFreq(3) > comboFreq(1), 'monotonic in depth');
  assert.equal(comboFreq(12), 880, 'twelve semitones is exactly an octave');
  // capped at 15 semitones so a runaway cascade cannot walk out of the band
  assert.equal(comboFreq(15), comboFreq(99), 'clamped above 15 semitones');
  assert.equal(comboFreq(-5), 440, 'negative depth clamps to the base note');
});
