/**
 * audio.js — Sound effects via the managed Arcade.audio SFX engine.
 *
 * Single registration site (A1): all cues are registered once at module import,
 * which happens right after `Arcade.init({ gameId })` in index.html's <head>.
 * All play-sites go through the `sfx()` wrapper (A2), which feature-detects the
 * SDK so a stale launcher-served SDK (or standalone with an old cache) degrades
 * to silence instead of throwing.
 *
 * Hecknsic has no in-game sound toggle and does not add one (A3) — the launcher
 * owns volume + the global mute button, and Arcade.audio honours both for us.
 *
 * Palette: arcade-y square / sawtooth voices, all cues short (≤0.25s) and
 * conservative gain (≤0.35) per A5. NOTE: sound aesthetics need a human ear pass.
 */

// ─── Cue registrations (A1 — one site) ──────────────────────────────
// Register only when the SDK's audio surface exists; harmless no-op otherwise.
if (typeof window !== 'undefined' && window.Arcade && Arcade.audio) {
  // Per-rotation press blip — one short tick per player rotation (not per step).
  Arcade.audio.cue('rotate', { type: 'square', freq: 330, dur: 0.05, gain: 0.16 });

  // A match group clears (first clear of a cascade).
  Arcade.audio.cue('match', { type: 'square', freq: 520, dur: 0.09, gain: 0.26 });

  // Chained cascade step — freq is overridden per-play (comboFreq) to step the
  // pitch up with chain depth.
  Arcade.audio.cue('combo', { type: 'sawtooth', freq: 440, dur: 0.10, gain: 0.26 });

  // Shared celebratory sparkle for special-piece formation (starflower / black
  // pearl / grand poobah) — a quick two-voice arpeggio up.
  Arcade.audio.cue('special', [
    { type: 'square', freq: 660, dur: 0.08, gain: 0.30 },
    { type: 'square', freq: 990, dur: 0.12, gain: 0.30 },
  ]);

  // A bomb is queued to appear on the board — low, tense saw thud.
  Arcade.audio.cue('bomb', { type: 'sawtooth', freq: 120, dur: 0.18, gain: 0.30 });

  // Game over / session end — descending three-voice saw motif.
  Arcade.audio.cue('game-over', [
    { type: 'sawtooth', freq: 330, dur: 0.14, gain: 0.30 },
    { type: 'sawtooth', freq: 220, dur: 0.16, gain: 0.30 },
    { type: 'sawtooth', freq: 110, dur: 0.22, gain: 0.30, release: 0.08 },
  ]);

  // Soft UI tick for menu / button interactions.
  Arcade.audio.cue('ui-click', { type: 'square', freq: 440, dur: 0.03, gain: 0.12 });
}

// ─── Play wrapper (A2 — single guarded call site) ───────────────────
export const sfx = (name, opts) => {
  if (typeof window !== 'undefined' && window.Arcade && Arcade.audio) {
    Arcade.audio.play(name, opts);
  }
};

/**
 * Rising pitch for the 'combo' cue as chain depth increases. Semitone-ish steps
 * off A4, capped so deep cascades stay inside the audible/legal freq range.
 * @param {number} depth — chain level (1, 2, 3, …)
 */
export function comboFreq(depth) {
  const steps = Math.min(Math.max(depth, 0), 15);
  return Math.round(440 * Math.pow(2, steps / 12));
}

/**
 * Play a soft 'ui-click' on menu / button interactions. Uses one delegated
 * capture-phase listener so it fires even for handlers that stopPropagation,
 * and stays off the canvas + rotate arrows (those get their own 'rotate' cue).
 */
export function wireUiClicks() {
  if (typeof document === 'undefined') return;
  const SELECTOR =
    '.icon-btn, .start-btn, .dropdown-btn, .hand-toggle, .game-hud-restart, .game-hud-logo';
  document.addEventListener(
    'click',
    (e) => {
      const el = e.target;
      if (el && el.closest && el.closest(SELECTOR)) sfx('ui-click');
    },
    true,
  );
}
