/**
 * tween.js — Lightweight animation helper.
 *
 * Usage:
 *   const t = tween(300, progress => { hex.scale = 1 + 0.2 * progress; });
 *   t.promise   – resolves when done
 *   t.cancel()  – stop early
 */

const active = [];

export function tween(durationMs, onUpdate, easing = easeOutCubic) {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  const entry = { start: -1, duration: durationMs, onUpdate, easing, resolve, cancelled: false };
  active.push(entry);
  return {
    promise,
    cancel() { entry.cancelled = true; },
  };
}

/** Call once per frame from the game loop with the current timestamp. */
export function updateTweens(now) {
  for (let i = active.length - 1; i >= 0; i--) {
    const t = active[i];
    if (t.cancelled) { active.splice(i, 1); t.resolve(); continue; }
    if (t.start < 0) t.start = now;
    const elapsed = now - t.start;
    const raw = Math.min(elapsed / t.duration, 1);
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
