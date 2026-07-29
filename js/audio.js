/**
 * audio.js — Sound for hecknsic, via the launcher SDK's managed `Arcade.audio`.
 * This is the game's single audio module.
 *
 * THE PACK IS THE SOUND. One registration path lives here:
 *
 *   GRAPH PATH (SDK 3.7.0's /arcade-audio.js loaded) — the sound design.
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
 * There is NO fallback. When the capability gate below fails (a stale
 * service-worker cache serving an older SDK/companion, or standalone without
 * /arcade-audio.js), this module registers nothing and the game plays silent.
 * That is deliberate, fleet-wide (2026-07-28): chiptune is an aesthetic a game
 * adopts as its identity, not a degraded mode a graph-pack game decays into.
 * The archived profile lives in audio/chiptune-archive.mjs as provenance only.
 * Silence on a stale cache is an expected state, not an error — no console
 * noise, and every play-wrapper below stays a safe no-op.
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

// True once the pack has registered successfully — which now means: true if
// this module registered anything at all. When it is false the game is
// deliberately silent, and every wrapper below is a no-op.
let graphMode = false;

// ─── the play wrappers (A2) ─────────────────────────────────────────────────
// Silent no-ops when Arcade.audio is absent, when the capability gate below
// failed (nothing is registered, so there is nothing to play), or when the
// launcher has muted (the SDK short-circuits before touching the
// AudioContext). Never a throw — these are called from the game loop, the
// input path and the move path.

export function sfx(name, opts) {
  if (!graphMode) return;
  const a = audio();
  if (a) a.play(name, opts);
}

/** Rotation — the ratchet. `kind` picks the mechanism's size:
 *  'ring' (starflower, 6 tiles), 'y' (black pearl), 'cluster' (the default 3). */
export function playRotate(kind) {
  sfx('rotate', { kind: kind || 'cluster' });
}

/** Picking a cluster up. */
export function playSelect() {
  sfx('select');
}

/** First clear of a cascade. `count` = tiles cleared, which scales the
 *  fracture: more shards, longer, deeper — a bigger break, not a louder one. */
export function playMatch(count) {
  sfx('match', { count });
}

/** A chained cascade step. `depth` climbs the ladder — the cue pitches the
 *  glass ring and brightens the shards together. */
export function playCombo(depth) {
  sfx('combo', { depth });
}

/** Special formation. Each gets its own material — chrome shimmer, obsidian
 *  weight, or both. An unknown type is silence, not a borrowed voice. */
export function playSpecial(type) {
  if (type === 'starflower' || type === 'blackpearl' || type === 'grandpoobah') {
    sfx(type);
  }
}

/** A bomb arrives on the board. */
export function playBombArrive() {
  sfx('bomb-arrive');
}

/** The fuse clock, one per move while a bomb is live. `urgency` 0..1 tightens
 *  it. */
export function playBombTick(urgency) {
  sfx('bomb-tick', { urgency });
}

/** Session end. A real game over is the detonation and then, a beat later,
 *  the aftermath tolls — two events, because the explosion and the loss are
 *  not the same moment. A peaceful chill-session end is the tolls alone.
 *
 *  The delayed second cue is fire-and-forget: if the player has muted or left
 *  in the meantime, `play()` is already a silent no-op. */
export function playGameOver(isSessionEnd) {
  if (isSessionEnd) {
    sfx('game-over');
    return;
  }
  sfx('bomb-explode');
  setTimeout(() => sfx('game-over'), 800);
}

/** Over-achiever — the game's triumph condition. */
export function playOverAchiever() {
  sfx('over-achiever');
}

/** Puzzle solved. */
export function playGameWin() {
  sfx('game-win');
}

let pulseHandle = null;
let tensionHandle = null;
let urgencyStep = 0;

/** Start the ambient beds. Idempotent — safe to call from the input path on
 *  every interaction, which is also what satisfies the browser's autoplay
 *  policy (the first real user gesture is what unlocks the AudioContext).
 *  A silent no-op whenever the pack is unregistered or audio is unavailable; it
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
// throw inside a cue at play time — a cue that half-plays is worse than
// silence, so the whole registration is gated on the pack's actual
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
  }
  // else: stale cached SDK, or standalone without /arcade-audio.js. Nothing
  // is registered and the game plays silent — expected and deliberate, not a
  // bug, so no console noise. The wrappers above all no-op off `graphMode`.
})();
