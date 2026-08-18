/**
 * tween.js — Lightweight animation helper.
 *
 * Usage:
 *   const t = tween(300, progress => { hex.scale = 1 + 0.2 * progress; });
 *   t.promise   – resolves when done
 *   t.cancel()  – stop early
 */

import { wakeFrameLoop } from './frame.js';

const active = [];

// ─── The tween clock ────────────────────────────────────────────
//
// Tweens run off an accumulated clock, not the raw rAF timestamp. The wall
// clock keeps running while frames do not: the loop parks itself on a settled
// board (§6d), it parks behind an open modal, and the launcher cancels it
// outright on suspend. A tween whose `start` is a raw timestamp counts that
// whole dead interval as elapsed animation — open help mid-cascade and every
// live tween snaps to its end state on the first frame back.
//
// So only time that actually passed *between rendered frames* is admitted.
// Deliberate parks call suspendTweenClock(), which makes the first frame back
// contribute nothing at all.

let clock = 0;
let lastFrame = -1;

// Backstop for gaps nobody announced — a backgrounded tab is throttled by the
// browser with none of our hooks firing. Longer than any frame a running game
// produces, short enough that an unreported gap costs a blink rather than the
// whole tween.
const MAX_FRAME_MS = 250;

/**
 * The loop is stopping; the next frame is a fresh start however far off it is.
 * Call from every deliberate park/suspend so the gap never reaches the tweens.
 */
export function suspendTweenClock() {
  lastFrame = -1;
}

export function tween(durationMs, onUpdate, easing = easeOutCubic) {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  const reducedMotion = typeof Arcade !== 'undefined' && Arcade.settings.reducedMotion();
  const entry = { start: -1, duration: reducedMotion ? 0 : durationMs, onUpdate, easing, resolve, cancelled: false };
  active.push(entry);
  // updateTweens only runs from the game loop, and the loop parks itself when
  // the board settles (§6d). A tween started from a parked state would never
  // advance and its promise would never resolve — which, since the cascade
  // chains await these, means a hung board. Wake it here.
  wakeFrameLoop();
  return {
    promise,
    cancel() { entry.cancelled = true; },
  };
}

/** Call once per frame from the game loop with the current timestamp. */
export function updateTweens(now) {
  if (lastFrame < 0) lastFrame = now;
  clock += Math.max(0, Math.min(now - lastFrame, MAX_FRAME_MS));
  lastFrame = now;

  for (let i = active.length - 1; i >= 0; i--) {
    const t = active[i];
    if (t.cancelled) { active.splice(i, 1); t.resolve(); continue; }
    if (t.start < 0) t.start = clock;
    const elapsed = clock - t.start;
    const raw = t.duration > 0 ? Math.min(elapsed / t.duration, 1) : 1;
    const progress = t.easing(raw);
    t.onUpdate(progress);
    if (raw >= 1) {
      active.splice(i, 1);
      t.resolve();
    }
  }
}

export function hasActiveTweens() {
  return active.length > 0;
}

// ─── Easing functions ───────────────────────────────────────────

export function easeOutCubic(t) { return 1 - (1 - t) ** 3; }
export function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}
export function easeOutBounce(t) {
  if (t < 1 / 2.75) return 7.5625 * t * t;
  if (t < 2 / 2.75) return 7.5625 * (t -= 1.5 / 2.75) * t + 0.75;
  if (t < 2.5 / 2.75) return 7.5625 * (t -= 2.25 / 2.75) * t + 0.9375;
  return 7.5625 * (t -= 2.625 / 2.75) * t + 0.984375;
}
export function linear(t) { return t; }
