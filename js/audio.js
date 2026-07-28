/**
 * audio.js — Sound for hecknsic, via the launcher SDK's managed `Arcade.audio`.
 * This is the game's single audio module.
 *
 * Two registration paths live here:
 *
 *   GRAPH PATH (SDK 3.7.0's /arcade-audio.js loaded) — the real sound design.
 *     js/soundpack.js holds the pack; every cue is a WebAudio node graph built
 *     from physical-gesture elements (strike, body, thump, flare, blast, and
 *     the shatter / ratchet / drone elements this game drove into the shared
 *     library), and every cue feeds one shared convolution room so overlapping
 *     sounds fuse into one place — a dark room with a glass machine in it —
 *     instead of stacking into a pile. That pack was rendered to an audition
 *     WAV and approved by ear — do not retune it from here.
 *
 *     NO SYNTHESIS LIVES IN THIS GAME. Every gesture the pack is built from is
 *     an element in the launcher's shared library, and the crossfade that makes
 *     the bed adaptive is `handle.retune()` in the SDK. What belongs to
 *     hecknsic is the design — which gestures, how loud, how far away, how
 *     often — and that is all js/soundpack.js contains. A gesture this game
 *     needs and the library lacks goes into the library.
 *
 *   FALLBACK PATH (older cached SDK/companion, or standalone without
 *     /arcade-audio.js) — the archived chiptune profile, copied verbatim from
 *     this file as it stood at 9169f43 ("Re-tune SFX: struck glass on a dark
 *     board, not chiptune"). Single-spec cues: the only thing a pre-3.6.0
 *     `Arcade.audio` can play. It exists because a player on a stale
 *     service-worker cache should get the old sound rather than silence; that
 *     is an expected state, not an error, so it is not logged. See
 *     NEEDED_ELEMENTS below for what decides the path.
 *
 * Both paths register cue names the play-wrappers below know how to reach, so
 * every call site in the game works unchanged either way — the wrappers, not
 * the call sites, absorb the difference (the graph path splits `special` into
 * three materially different formations, for instance, where the chiptune
 * profile has one).
 *
 * Conventions (fleet Arcade.audio conventions, launcher GAME_INTEGRATION.md §5):
 *   A1 — cues are registered ONCE here at module load. Audio is purely local,
 *        so no `await Arcade.ready` is needed; the SDK's classic <script> +
 *        `Arcade.init(...)` in index.html's <head> have already run by the time
 *        this ES module evaluates, so `window.Arcade.audio` and
 *        `window.ArcadeSoundPack` are both present.
 *   A2 — every play-site in the game goes through a wrapper below, which
 *        feature-detects `Arcade.audio`. hecknsic has NO in-game sound
 *        setting, so the wrappers are a pure feature detect.
 *   A3 — the launcher owns volume + the global mute button; this module adds
 *        no volume slider and no mute of its own. `play()` is free + silent
 *        when the user has muted.
 *   A4 — cue names are lowercase-kebab and event-shaped.
 */

const audio = () =>
  (typeof window !== 'undefined' && window.Arcade && window.Arcade.audio)
    ? window.Arcade.audio
    : null;

const pack = () =>
  (typeof window !== 'undefined' && window.ArcadeSoundPack) ? window.ArcadeSoundPack : null;

// ─── ambient beds ───────────────────────────────────────────────────────────
// The floor of the room, as two sustained cues on different clocks: the pulse,
// which only depends on the mode, and the tension, which answers how close the
// nearest bomb fuse is. Keeping them separate means the tension can be retuned
// without restarting the pulse, which would put an audible seam under the
// game's tensest moment.
const PULSE_CUE = 'pulse';
const TENSION_CUE = 'tension';
const PULSE_SEND = 0.30;
const TENSION_SEND = 0.35;
// Each bed schedules its whole timeline in one pass, so this is how long a
// single start() lasts before it fades out on its own. Well past any hecknsic
// session; the beds are stopped at game over long before it matters.
const BED_SECONDS = 420;

// How busy the floor is per mode. Chill is nearly still; arcade leans in.
const MODE_INTENSITY = { arcade: 0.6, chill: 0.25, puzzle: 0.4 };

// Urgency, quantised. The tension layer can only change by being re-scheduled,
// so this has to be a handful of steps rather than a continuous value — and the
// steps need hysteresis, because a board with two bombs on different fuses
// crosses back and forth over a threshold as they are cleared and respawned.
// Rising uses UP[i], falling uses the lower DOWN[i], so a board sitting near a
// boundary stays put.
const URGENCY_STEPS = [0, 0.35, 0.7, 1.0];
const URGENCY_UP = [0.30, 0.58, 0.84];
const URGENCY_DOWN = [0.20, 0.48, 0.74];
const URGENCY_CROSSFADE = 2.0;

// True once the graph path has registered successfully. Everything only the
// graph path can do (the beds, the split formations, the bomb chain) keys off
// this.
let graphMode = false;

// ─── the play wrappers (A2) ─────────────────────────────────────────────────
// Silent no-ops when Arcade.audio is absent, or when the launcher has muted
// (the SDK short-circuits before touching the AudioContext).

export function sfx(name, opts) {
  const a = audio();
  if (a) a.play(name, opts);
}

/** Rotation — the ratchet. `kind` picks the mechanism's size:
 *  'ring' (starflower, 6 tiles), 'y' (black pearl), 'cluster' (the default 3). */
export function playRotate(kind) {
  if (graphMode) sfx('rotate', { kind: kind || 'cluster' });
  else sfx('rotate');
}

/** Picking a cluster up. Graph path only — the chiptune profile has no cue for
 *  it, and a borrowed one at this rate would be a tick on every touch. */
export function playSelect() {
  if (graphMode) sfx('select');
}

/** First clear of a cascade. `count` = tiles cleared, which scales the
 *  fracture: more shards, longer, deeper — a bigger break, not a louder one. */
export function playMatch(count) {
  if (graphMode) sfx('match', { count });
  else sfx('match');
}

/** A chained cascade step. `depth` climbs the ladder — the graph cue pitches
 *  the glass ring and brightens the shards together; the chiptune cue keeps the
 *  archived per-play `freq` override (single-spec cues only — the SDK ignores
 *  overrides on array cues, which is why the archive's 'combo' is one voice). */
export function playCombo(depth) {
  if (graphMode) sfx('combo', { depth });
  else sfx('combo', { freq: comboFreq(depth) });
}

/** Special formation. The graph path gives each its own material — chrome
 *  shimmer, obsidian weight, or both — where the archive has one shared cue. */
export function playSpecial(type) {
  if (graphMode && (type === 'starflower' || type === 'blackpearl' || type === 'grandpoobah')) {
    sfx(type);
  } else {
    sfx('special');
  }
}

/** A bomb arrives on the board. */
export function playBombArrive() {
  if (graphMode) sfx('bomb-arrive');
  else sfx('bomb');
}

/** The fuse clock, one per move while a bomb is live. `urgency` 0..1 tightens
 *  it. Graph path only: the archive has no tick, and repeating its 'bomb' cue
 *  every move would be far too heavy. */
export function playBombTick(urgency) {
  if (graphMode) sfx('bomb-tick', { urgency });
}

/** Session end. On the graph path a real game over is the detonation and then,
 *  a beat later, the aftermath tolls — two events, because the explosion and
 *  the loss are not the same moment. A peaceful chill-session end is the tolls
 *  alone. The archive folds both into its single descending motif.
 *
 *  The delayed second cue is fire-and-forget: if the player has muted or left
 *  in the meantime, `play()` is already a silent no-op. */
export function playGameOver(isSessionEnd) {
  if (!graphMode) {
    sfx('game-over');
    return;
  }
  if (isSessionEnd) {
    sfx('game-over');
    return;
  }
  sfx('bomb-explode');
  setTimeout(() => sfx('game-over'), 800);
}

/** Over-achiever — the game's triumph condition. Graph path only: the archive
 *  never had a cue for it, and its descending game-over motif is exactly the
 *  wrong mood. Silence is the better loss. */
export function playOverAchiever() {
  if (graphMode) sfx('over-achiever');
}

/** Puzzle solved. Graph path only, for the same reason as above. */
export function playGameWin() {
  if (graphMode) sfx('game-win');
}

let pulseHandle = null;
let tensionHandle = null;
let urgencyStep = 0;

/** Start the ambient beds. Idempotent — safe to call from the input path on
 *  every interaction, which is also what satisfies the browser's autoplay
 *  policy (the first real user gesture is what unlocks the AudioContext).
 *  A silent no-op on the fallback path and whenever audio is unavailable; it
 *  must never throw, because the game loop and input handlers call it. */
export function startBed(modeId) {
  if (pulseHandle) return;
  const a = audio();
  if (!a || !graphMode || typeof a.start !== 'function') return;
  const intensity = MODE_INTENSITY[modeId] == null ? MODE_INTENSITY.arcade : MODE_INTENSITY[modeId];
  pulseHandle = a.start(PULSE_CUE, { dur: BED_SECONDS, intensity });
  urgencyStep = 0;
  tensionHandle = a.start(TENSION_CUE, { dur: BED_SECONDS, urgency: URGENCY_STEPS[0] });
}

/** Stop the beds, fading over `fade` seconds. Also idempotent. */
export function stopBed(fade) {
  const f = typeof fade === 'number' && fade > 0 ? fade : 1.2;
  const handles = [pulseHandle, tensionHandle];
  pulseHandle = null;
  tensionHandle = null;
  urgencyStep = 0;
  for (const h of handles) {
    if (!h) continue;
    try { h.stop(f); } catch (e) { /* never throw at a play-site */ }
  }
}

/** How pressed the player is, 0..1 — main.js derives it from the shortest live
 *  bomb fuse. The tension layer answers: the beating drone tightens and the dry
 *  tick subdivides faster, so the room itself leans in rather than a warning
 *  sound being added on top.
 *
 *  A sustained cue schedules its whole timeline up front, so changing it means
 *  running a second tension layer and fading the first out under it. The SDK
 *  owns that (`handle.retune`, 3.7.0+) — the game says what should change and
 *  how fast, not how to crossfade it. Only the tension is retuned; the pulse
 *  underneath is untouched, so there is no seam.
 *
 *  Safe to call every move: quantisation and hysteresis above mean an actual
 *  retune happens a handful of times per session at most. */
export function setBedUrgency(urgency) {
  // No retune on a pre-3.7.0 SDK: the bed simply stays at the density it
  // started with. That is a quieter loss than any workaround, and this runs in
  // the move path, so it must not throw.
  if (!tensionHandle || typeof tensionHandle.retune !== 'function') return;
  const u = typeof urgency === 'number' && isFinite(urgency) ? urgency : 0;

  let step = urgencyStep;
  while (step < URGENCY_STEPS.length - 1 && u >= URGENCY_UP[step]) step++;
  while (step > 0 && u < URGENCY_DOWN[step - 1]) step--;
  if (step === urgencyStep) return;
  urgencyStep = step;

  tensionHandle.retune({ dur: BED_SECONDS, urgency: URGENCY_STEPS[step] }, URGENCY_CROSSFADE);
}

// ─── registration ───────────────────────────────────────────────────────────

function registerPack(a, p) {
  // One room for the whole game: the dark interior the pack is set in.
  a.room(p.ROOM);
  Object.keys(p.CUES).forEach((name) => {
    a.graph(name, p.CUES[name], { send: p.SENDS[name] });
  });
  // The beds are written in the SDK's own sustained-cue shape —
  // fn(ctx, out, when, params, rnd) returning a teardown — so they register
  // directly. There is no adapter here on purpose: an argument-order shim in
  // the game is a small thing that quietly becomes the place bed behaviour
  // accumulates.
  a.graph(PULSE_CUE, p.pulse, { sustained: true, send: PULSE_SEND });
  a.graph(TENSION_CUE, p.tension, { sustained: true, send: TENSION_SEND });
}

// ─── fallback: the archived chiptune profile ────────────────────────────────
// Copied verbatim from this file at 9169f43, which froze the game's pre-graph
// sound. Keep it in sync with that archive rather than editing it here — it is
// what a player on a stale service-worker cache hears, and it was tuned as a
// whole.
//
// Cue names the graph pack has that do not appear below: 'select', 'bomb-tick',
// 'bomb-explode', 'over-achiever' and 'game-win'. Each is a deliberate silence
// on this path rather than a borrowed voice — see the wrappers above for why.

const COMBO_BASE_HZ = 440; // A4

function registerChiptune(a) {
  // Per-rotation press blip — one short tick per player rotation (not per step).
  // Mechanical ratchet detent: a noise scrape under a square blip whose pitch
  // drops across its 26ms, which reads as a click/thunk rather than a beep.
  a.cue('rotate', [
    { type: 'noise', dur: 0.018, gain: 0.09, attack: 0.001, release: 0.016, delay: 0 },
    { type: 'square', freq: 380, toFreq: 300, dur: 0.026, gain: 0.10, attack: 0.001, release: 0.024, delay: 0 },
  ]);

  // A match group clears (first clear of a cascade). Struck glass: strike tick,
  // C5 body, and the 3rd-harmonic shimmer on top, all decaying together. This
  // fires constantly, so it is the loudness reference for the whole profile.
  a.cue('match', [
    { type: 'noise', dur: 0.015, gain: 0.05, attack: 0.001, release: 0.013, delay: 0 },
    { type: 'triangle', freq: 523, dur: 0.14, gain: 0.24, attack: 0.002, release: 0.125, delay: 0 },
    { type: 'sine', freq: 1568, dur: 0.10, gain: 0.07, attack: 0.002, release: 0.095, delay: 0 },
  ]);

  // Chained cascade step — freq is overridden per-play (comboFreq) to step the
  // pitch up with chain depth. MUST stay a single spec object: Arcade.audio
  // merges per-play overrides onto object cues only, and ignores them on arrays.
  a.cue('combo', { type: 'triangle', freq: COMBO_BASE_HZ, dur: 0.11, gain: 0.26, attack: 0.002, release: 0.095 });

  // Shared celebratory sparkle for special-piece formation (starflower / black
  // pearl / grand poobah) — the same strike tick as `match`, then a crystalline
  // sine arpeggio rolled at 50ms so the notes overlap into a ringing chord.
  a.cue('special', [
    { type: 'noise', dur: 0.012, gain: 0.05, attack: 0.001, release: 0.010, delay: 0 },
    { type: 'sine', freq: 660, dur: 0.09, gain: 0.22, attack: 0.002, release: 0.08, delay: 0 },
    { type: 'sine', freq: 990, dur: 0.09, gain: 0.22, attack: 0.002, release: 0.08, delay: 0.05 },
    { type: 'sine', freq: 1320, dur: 0.16, gain: 0.20, attack: 0.002, release: 0.145, delay: 0.05 },
  ]);

  // A bomb is queued to appear on the board — the one destructive event, and the
  // only place sawtooth survives: a noise rumble under a saw thud sagging
  // 120→80Hz, deliberately unlike the glass everything else is made of.
  a.cue('bomb', [
    { type: 'noise', dur: 0.15, gain: 0.12, attack: 0.005, release: 0.13, delay: 0 },
    { type: 'sawtooth', freq: 120, toFreq: 80, dur: 0.18, gain: 0.28, attack: 0.005, release: 0.15, delay: 0 },
  ]);

  // Game over / session end — descending three-voice motif, played back-to-back.
  a.cue('game-over', [
    { type: 'triangle', freq: 330, dur: 0.14, gain: 0.30, release: 0.05 },
    { type: 'triangle', freq: 220, dur: 0.16, gain: 0.32, release: 0.06 },
    { type: 'triangle', freq: 110, dur: 0.24, gain: 0.34, release: 0.14 },
  ]);

  // Soft UI tick for menu / button interactions — a tiny high glass "tink", and
  // deliberately the quietest cue in the profile.
  a.cue('ui-click', { type: 'triangle', freq: 880, dur: 0.025, gain: 0.10, attack: 0.001, release: 0.022 });
}

/**
 * Rising pitch for the chiptune 'combo' cue as chain depth increases.
 * Semitone-ish steps off A4, capped so deep cascades stay inside the
 * audible/legal freq range. Graph path does its own laddering in the pack.
 * @param {number} depth — chain level (1, 2, 3, …)
 */
export function comboFreq(depth) {
  const steps = Math.min(Math.max(depth, 0), 15);
  return Math.round(COMBO_BASE_HZ * Math.pow(2, steps / 12));
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

// ─── A1 — the single registration site ──────────────────────────────────────
// Last in the file so every cue table above it is initialised. Runs once at
// module load, before main.js evaluates.

// The gestures and APIs the pack is built out of. A cached older SDK or element
// library has `graph()` and `el()` but not these, and a missing element would
// throw inside a cue at play time — a cue that half-plays is worse than the
// fallback profile, so the whole graph path is gated on the pack's actual
// dependencies rather than on a version number.
const NEEDED_ELEMENTS = [
  'strike', 'body', 'thump', 'flare', 'blast',
  'shatter', 'ratchet', 'drone', 'teardown',
];

(function registerCues() {
  const a = audio();
  if (!a) return;

  const p = pack();
  const el = (a && typeof a.el === 'function') ? a.el() : null;
  const graphable =
    !!p &&
    typeof a.graph === 'function' &&
    typeof a.room === 'function' &&
    typeof a.start === 'function' &&
    el !== null &&
    NEEDED_ELEMENTS.every((name) => typeof el[name] === 'function');

  if (graphable) {
    registerPack(a, p);
    graphMode = true;
  } else {
    // Stale cached SDK, or standalone without /arcade-audio.js. Expected, not
    // a bug — no console noise.
    registerChiptune(a);
  }
})();
