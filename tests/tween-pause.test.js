/**
 * tween-pause.test.js — a tween must survive the loop parking under it.
 *
 * The game loop stops far more often than it used to: it parks on a settled
 * board (§6d), it parks behind an open modal, and the launcher cancels it on
 * suspend. Tween progress used to be measured against the raw rAF timestamp,
 * so every one of those gaps counted as elapsed animation — open help
 * mid-cascade and the first frame back read progress 1.0 for everything still
 * in flight. These tests pin the clock that fixes it.
 *
 * Arcade has to be installed before js/tween.js is evaluated: tween() reads
 * Arcade.settings.reducedMotion(), and frame.js comes along with it.
 */
import test from 'node:test';
import assert from 'node:assert';
import { installArcade } from './helpers/fake-arcade.mjs';

installArcade({ powerSaver: false, reducedMotion: false });

const { tween, updateTweens, suspendTweenClock, hasActiveTweens, linear } =
  await import('../js/tween.js');

/**
 * Retire anything a previous test left live and hand the next one a clock that
 * has just been suspended — i.e. exactly the state a fresh park leaves behind.
 * Frames are stepped rather than jumped because the clock caps what one frame
 * may contribute.
 */
function drain() {
  suspendTweenClock();
  let t = 0;
  while (hasActiveTweens() && t < 1e6) { t += 200; updateTweens(t); }
  suspendTweenClock();
}

test('a tween parked mid-flight resumes from where it was, not from the end', () => {
  drain();

  let progress = -1;
  tween(300, p => { progress = p; }, linear);

  // Frame one: the tween takes its start from here.
  updateTweens(1000);
  assert.strictEqual(progress, 0, 'precondition: the tween is at 0% on its first frame');

  // 100 ms in — a third of the way through a 300 ms linear tween.
  updateTweens(1100);
  assert.ok(Math.abs(progress - 1 / 3) < 1e-9,
    `expected 0.333 a third of the way in, got ${progress}`);

  // The player opens a modal. The loop parks, sits there for eight seconds,
  // and the next frame arrives with a timestamp eight seconds later.
  suspendTweenClock();
  updateTweens(9100);

  assert.ok(Math.abs(progress - 1 / 3) < 1e-9,
    'an announced park must not advance the tween at all: expected the same ' +
    `0.333 on the first frame back, got ${progress}`);
  assert.strictEqual(hasActiveTweens(), true,
    'the tween must still be live after the park, not resolved by the gap');

  // ...and it carries on from there rather than sitting permanently offset.
  updateTweens(9200);
  assert.ok(Math.abs(progress - 2 / 3) < 1e-9,
    `progress should continue smoothly after the resume, got ${progress}`);

  updateTweens(9300);
  assert.strictEqual(progress, 1, 'the tween still finishes on its own duration');
  assert.strictEqual(hasActiveTweens(), false, 'and retires when it does');
});

test('an unannounced frame gap costs a blink, not the whole tween', () => {
  drain();

  // A backgrounded tab is throttled by the browser with none of our park hooks
  // firing, so the clock also caps what any single frame may contribute.
  let progress = -1;
  tween(2000, p => { progress = p; }, linear);

  updateTweens(1000);
  updateTweens(11000);   // ten seconds, unannounced

  assert.ok(progress > 0 && progress < 0.5,
    `an unreported ten-second gap must not run a 2 s tween to the end; got ${progress}`);
  assert.strictEqual(hasActiveTweens(), true, 'the tween is still in flight');
});

test('reduced motion still completes on the first frame', () => {
  drain();

  // Reduced motion collapses the duration to 0, and that has to stay a
  // property of the duration rather than of any elapsed time — the clock
  // change must not make a snap-to-end tween wait for a frame delta.
  const settings = globalThis.Arcade.settings;
  const wasReduced = settings.reducedMotion;
  settings.reducedMotion = () => true;

  const seen = [];
  try {
    tween(400, p => seen.push(p), linear);
  } finally {
    settings.reducedMotion = wasReduced;
  }

  updateTweens(5000);
  assert.deepStrictEqual(seen, [1],
    'under reduced motion the tween must fire once at full progress on its ' +
    'first frame, with no elapsed time at all');
  assert.strictEqual(hasActiveTweens(), false, 'and retire immediately');
});
