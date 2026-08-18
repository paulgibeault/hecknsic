/**
 * score-timing.test.js — the score counter runs on the clock, not on frames.
 *
 * updateDisplayScore(dt) took a delta and ignored it, closing a fixed 10% of
 * the remaining gap per *call*. That made the counter's speed a function of
 * the display: half speed on a 30 Hz panel, double on a 120 Hz one, and every
 * frame the loop dropped was time the counter simply did not count. The board
 * animates off the tween clock (#63); the counter was the one readout still
 * animating off the frame rate.
 *
 * These tests pin both halves of the fix: the 60 fps behaviour is unchanged to
 * the bit (so the feel everyone has been playing with is preserved), and any
 * other frame rate reaches the same place in the same wall-clock time.
 *
 * js/score.js is a pure module — constants in, numbers out, no Arcade and no
 * DOM — so it needs no launcher stub.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  awardMatch, resetScore, restoreScore,
  getScore, getDisplayScore, updateDisplayScore, isScoreAnimating,
} from '../js/score.js';

/** One frame at 60 fps — the rate the old per-frame constants were tuned at. */
const FRAME_60 = 1000 / 60;

/** Put the counter at a known distance behind a known score. */
function startAt(displayScore, score) {
  resetScore();
  restoreScore({ score, displayScore });
}

/** The exact expression updateDisplayScore used before it took the clock. */
function legacyStep(displayScore, score) {
  return Math.min(score, displayScore + Math.max(1, (score - displayScore) * 0.1));
}

/** Run `ms` of counter time in steps of `dt`, and report where it landed. */
function run(ms, dt) {
  let elapsed = 0;
  while (elapsed < ms - 1e-9) {
    updateDisplayScore(Math.min(dt, ms - elapsed));
    elapsed += dt;
  }
  return getDisplayScore();
}

test('a 60 fps frame does exactly what the per-frame version did', () => {
  // Every regime the old expression had: the eased branch far from the target,
  // the floor branch close to it, and the clamp on the final step.
  for (const [display, score] of [[0, 10000], [0, 5], [9995, 10000], [0, 1]]) {
    let legacy = display;
    startAt(display, score);

    for (let i = 0; i < 200; i++) {
      legacy = legacyStep(legacy, score);
      updateDisplayScore(FRAME_60);
      assert.equal(getDisplayScore(), Math.round(legacy),
        `frame ${i} diverged from the legacy curve for ${display}→${score}`);
    }
  }
});

test('the counter tracks wall-clock time, not frame count', () => {
  // 500 ms of counting, delivered three ways. A frame-rate-dependent counter
  // puts these 2x apart; a time-based one puts them within rounding.
  startAt(0, 10000);
  const at60 = run(500, FRAME_60);

  startAt(0, 10000);
  const at30 = run(500, FRAME_60 * 2);

  startAt(0, 10000);
  const at120 = run(500, FRAME_60 / 2);

  // Tolerance is for the discretisation of a continuous curve into steps, not
  // for a rate difference: 1% of the distance travelled.
  const tolerance = at60 * 0.01;
  assert.ok(Math.abs(at30 - at60) <= tolerance,
    `30 fps landed at ${at30}, 60 fps at ${at60}`);
  assert.ok(Math.abs(at120 - at60) <= tolerance,
    `120 fps landed at ${at120}, 60 fps at ${at60}`);
});

test('one long step matches many short ones over the same interval', () => {
  startAt(0, 10000);
  const stepped = run(400, FRAME_60);

  startAt(0, 10000);
  updateDisplayScore(400);
  const jumped = getDisplayScore();

  assert.ok(Math.abs(jumped - stepped) <= stepped * 0.01,
    `one 400 ms step landed at ${jumped}, twenty-four 60 fps steps at ${stepped}`);
});

test('the minimum-step floor scales with time as well', () => {
  // Close to the target the floor takes over from the eased curve — with a gap
  // of 5, easing offers 0.5 and the floor offers 1. That floor was "1 point per
  // frame", the other half of the frame-rate dependency, and it is now 1 point
  // per 16.667 ms. So three 60 fps frames and one frame three times as long
  // must land in the same place.
  startAt(0, 5);
  updateDisplayScore(FRAME_60 * 3);
  const oneLongFrame = getDisplayScore();

  startAt(0, 5);
  for (let i = 0; i < 3; i++) updateDisplayScore(FRAME_60);
  const threeShortFrames = getDisplayScore();

  assert.equal(threeShortFrames, 3, 'precondition: the floor branch is what is under test');
  assert.equal(oneLongFrame, threeShortFrames);
});

test('a small gap closes in the same wall-clock time at 30 and 60 fps', () => {
  const closeTime = (dt) => {
    startAt(0, 5);
    let ms = 0;
    while (isScoreAnimating() && ms < 5000) { updateDisplayScore(dt); ms += dt; }
    return ms;
  };

  const at60 = closeTime(FRAME_60);
  const at30 = closeTime(FRAME_60 * 2);

  assert.ok(at60 < 5000 && at30 < 5000, 'the counter must actually finish');
  // Within one step of each other — all that is left is where the final,
  // clamped step falls. Before the fix this was a clean factor of two.
  assert.ok(Math.abs(at30 - at60) <= FRAME_60 * 2,
    `30 fps took ${at30.toFixed(1)} ms, 60 fps took ${at60.toFixed(1)} ms`);
});

test('a frame that reports no elapsed time advances nothing', () => {
  // main.js resets lastTime to 0 when it parks the loop, and the first frame
  // back is the one that would otherwise hand us the whole idle interval.
  // Nothing here may invent progress from a dt it cannot trust.
  for (const dt of [0, -5, NaN, undefined, Infinity]) {
    startAt(0, 10000);
    updateDisplayScore(dt);
    assert.equal(getDisplayScore(), 0, `dt=${dt} moved the counter`);
  }
});

test('the counter never overshoots the score, however large the step', () => {
  startAt(0, 12345);
  updateDisplayScore(60_000);  // a minute in one go
  assert.equal(getDisplayScore(), 12345);
  assert.equal(isScoreAnimating(), false);
});

test('the counter still catches up to points awarded mid-flight', () => {
  resetScore();
  awardMatch(3);
  assert.ok(getScore() > 0, 'precondition: a match scores');
  assert.equal(isScoreAnimating(), true);

  let ms = 0;
  while (isScoreAnimating() && ms < 10_000) { updateDisplayScore(FRAME_60); ms += FRAME_60; }
  assert.equal(isScoreAnimating(), false, 'counter never reached the score');
  assert.equal(getDisplayScore(), getScore());
});
