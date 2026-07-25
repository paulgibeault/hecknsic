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
 * Sound identity: struck glass on a dark board. The board is glassy coloured
 * gems, not an 8-bit cabinet, so tile events ring rather than beep — a short
 * noise strike transient followed by a triangle/sine fundamental with a bright
 * upper partial (the 3rd harmonic, a twelfth above) doing the shimmer, decaying
 * out over the whole tail. Rotation is the one *mechanical* act in the game
 * (tiles physically turning), so it is a dry ratchet click: noise plus a
 * pitch-dropping square blip, not a tone. Sawtooth is reserved for `bomb`, the
 * only destructive event, so it reads as materially unlike the glass around it.
 * Energy stays arcade — everything is short, snappy and bright; only the
 * material changed. Envelopes stay conservative: dur ≤0.25s, gain ≤0.35, and
 * summed simultaneous voices stay well under 1.0 (the SDK master has no
 * limiter). NOTE: sound aesthetics need a human ear pass.
 */

// ─── Cue registrations (A1 — one site) ──────────────────────────────
// Register only when the SDK's audio surface exists; harmless no-op otherwise.
if (typeof window !== 'undefined' && window.Arcade && Arcade.audio) {
  // Per-rotation press blip — one short tick per player rotation (not per step).
  // Mechanical ratchet detent: a noise scrape under a square blip whose pitch
  // drops across its 26ms, which reads as a click/thunk rather than a beep.
  Arcade.audio.cue('rotate', [
    { type: 'noise', dur: 0.018, gain: 0.09, attack: 0.001, release: 0.016, delay: 0 },
    { type: 'square', freq: 380, toFreq: 300, dur: 0.026, gain: 0.10, attack: 0.001, release: 0.024, delay: 0 },
  ]);

  // A match group clears (first clear of a cascade). Struck glass: strike tick,
  // C5 body, and the 3rd-harmonic shimmer on top, all decaying together. This
  // fires constantly, so it is the loudness reference for the whole file — the
  // three voices peak at 0.36 summed, still less energy than the old square.
  Arcade.audio.cue('match', [
    { type: 'noise', dur: 0.015, gain: 0.05, attack: 0.001, release: 0.013, delay: 0 },
    { type: 'triangle', freq: 523, dur: 0.14, gain: 0.24, attack: 0.002, release: 0.125, delay: 0 },
    { type: 'sine', freq: 1568, dur: 0.10, gain: 0.07, attack: 0.002, release: 0.095, delay: 0 },
  ]);

  // Chained cascade step — freq is overridden per-play (comboFreq) to step the
  // pitch up with chain depth. MUST stay a single spec object: Arcade.audio
  // merges per-play overrides onto object cues only, and ignores them on arrays.
  // Triangle puts it in the glass family; the rising ladder sells the escalation.
  Arcade.audio.cue('combo', { type: 'triangle', freq: 440, dur: 0.11, gain: 0.26, attack: 0.002, release: 0.095 });

  // Shared celebratory sparkle for special-piece formation (starflower / black
  // pearl / grand poobah) — the same strike tick as `match`, then a crystalline
  // sine arpeggio rolled at 50ms so the notes overlap into a ringing chord, with
  // a longer tail on top. Rare and celebratory, so it is the biggest cue here.
  Arcade.audio.cue('special', [
    { type: 'noise', dur: 0.012, gain: 0.05, attack: 0.001, release: 0.010, delay: 0 },
    { type: 'sine', freq: 660, dur: 0.09, gain: 0.22, attack: 0.002, release: 0.08, delay: 0 },
    { type: 'sine', freq: 990, dur: 0.09, gain: 0.22, attack: 0.002, release: 0.08, delay: 0.05 },
    { type: 'sine', freq: 1320, dur: 0.16, gain: 0.20, attack: 0.002, release: 0.145, delay: 0.05 },
  ]);

  // A bomb is queued to appear on the board — the one destructive event, and the
  // only place sawtooth survives: a noise rumble under a saw thud sagging
  // 120→80Hz, deliberately unlike the glass everything else is made of.
  Arcade.audio.cue('bomb', [
    { type: 'noise', dur: 0.15, gain: 0.12, attack: 0.005, release: 0.13, delay: 0 },
    { type: 'sawtooth', freq: 120, toFreq: 80, dur: 0.18, gain: 0.28, attack: 0.005, release: 0.15, delay: 0 },
  ]);

  // Game over / session end — descending three-voice motif, played back-to-back.
  // Triangle keeps it in-palette; gains rise as it descends because a low
  // triangle carries far less perceived weight than the saw it replaces.
  Arcade.audio.cue('game-over', [
    { type: 'triangle', freq: 330, dur: 0.14, gain: 0.30, release: 0.05 },
    { type: 'triangle', freq: 220, dur: 0.16, gain: 0.32, release: 0.06 },
    { type: 'triangle', freq: 110, dur: 0.24, gain: 0.34, release: 0.14 },
  ]);

  // Soft UI tick for menu / button interactions — a tiny high glass "tink", and
  // deliberately the quietest cue in the file.
  Arcade.audio.cue('ui-click', { type: 'triangle', freq: 880, dur: 0.025, gain: 0.10, attack: 0.001, release: 0.022 });
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
