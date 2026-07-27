# hecknsic audio overhaul — design + implementation plan

Modelled on moon-lit's audio overhaul (moon-lit PRs #25/#28): physical-gesture
synthesis via the launcher's shared element library, a game-owned sound pack,
an offline-rendered audition WAV approved by ear BEFORE wiring, and a two-path
registration module so stale caches degrade to the old chiptune rather than
silence.

## Status

Shipped. `js/soundpack.js` was written against audition v1
(`tools/soundpack/render.mjs hecknsic` in the launcher repo, 4:47, peaks
≤0.83); retuning happens against a re-render, not against the wired game.

| phase | state |
|---|---|
| 1. Framework elements (`shatter`, `ratchet`, `drone`) in `../paulgibeault.github.io/arcade-audio.js` | done |
| 2. `js/soundpack.js` — 14 cues, 2 beds, 3 material tables | done |
| 3. Audition timeline + rendered WAV | done |
| 4. Ear pass / tuning loop | **open — retune the pack, re-render, repeat** |
| 5. `js/audio.js` two-path rewrite | done |
| 6. Call-site wiring, `index.html`, `sw.js`, `ago` | done |
| 7. Verification | done — see below |

### Verified

- **moon-lit is untouched by the shared-library change.** The renderer is not
  bit-deterministic run to run, so checksums prove nothing here; measured
  numerically instead. Two renders of *identical* code differ by 271 samples,
  1 LSB peak, −140.3 dBFS RMS. Original vs patched `arcade-audio.js` differs by
  266 samples, 1 LSB peak, −140.4 dBFS — indistinguishable from the renderer's
  own noise floor, 109 dB under the signal.
- **Graph path is live in the browser**, not silently falling back: the shared
  room bus exists (only `room()` creates it) and `start('pulse')` returns a
  handle carrying `retune`, which `setBedUrgency` depends on.
- **All 19 cue invocations** the game can emit play without throwing, including
  both parameter extremes of `match`, `combo` and `bomb-tick`.
- **Adaptive retune** steps 0 → 0.35 → 0.7 → 1.0 cleanly on a live bed.
- **Both registration paths** are pinned by `tests/audio.test.js`, including the
  case the gate exists for: an element library with `graph()`/`el()` present but
  missing any one of `shatter`/`ratchet`/`drone` must fall back rather than
  throw mid-cue. 74 tests pass.

### Known gaps

- The pack has not had its ear pass. That is phase 4 and it is the point of the
  audition workflow — quote a timestamp from the INDEX, retune, re-render.
- `render.mjs` documents reproducibility as a design goal, but only the pack
  code is seeded; Chromium's convolver render varies by ~1 LSB between runs.
  Worth a separate launcher issue — it makes checksum-based regression testing
  of sound packs impossible.
- The same `ago` staging gap fixed here (hardcoded launcher file list falling
  behind the SDK) exists in moon-lit's `ago`.

## The design

The place: **a dark room with a glass machine in it**. Board = saturated jewel
glass on near-black (`#0a0b0e`). Identity decisions, all encoded in
`js/soundpack.js`:

- **Tiles are glass** — every clear is a granular `shatter` scaled by cluster
  size; every formed piece *rings* (`body` with material-specific partial
  tables: `GLASS`, `CHROME` for starflower, `OBSIDIAN` for black pearl).
- **Rotation ratchets** — the one mechanical act. `ratchet` element,
  decelerating detents (3 cluster / 4 pearl-Y / 6 starflower-ring), glass
  seating knock. Fires per input → lives at `CONSTANT`, heavy per-play
  variation.
- **Formation = reversed shatter** — `skew < 1` runs the shard cloud as a
  converging crescendo: glass assembling, not breaking. The three specials are
  one gesture in three materials (chrome shimmer ↑ / obsidian mass ↓ / both).
- **The bomb is an event chain** — `bomb-arrive` (impact + fuse flare +
  beating dread pair), `bomb-tick` (per move, `urgency` 0..1 tightens it),
  `bomb-explode` (`blast` with `tone` — the board as struck bell — plus two
  outward shatter waves), then `game-over` (three obsidian tolls) ~0.8 s later.
- **The floor breathes** — two sustained beds: `pulse` (non-metrical sub
  heartbeat + 41 Hz drone; `intensity` per mode) and `tension` (beating drone
  + subdividing tick; `urgency` tracks the nearest bomb fuse; schedules
  *nothing* at 0). Deliberately not metrical: no tempo to fight the player's
  pacing. If the ear pass wants a musical pulse instead, that changes only the
  `pulse` function in the pack.

Register plan (bands, so overlapping cues don't mask): pulse 30–90 Hz · bomb
22–160 · ratchet pawl 200–1.4k · glass bodies 500–3k · shards 2.5–9k · UI
tink 3–6k. Mix anchors: `CONSTANT = 0.026` (per-input), `FREQUENT = 0.055`
(per-clear); everything else is balanced around those two.

## New framework elements (shipped in `arcade-audio.js`)

Additive only — moon-lit loads the same file. All follow library conventions:
seeded `rng`, `env()` exponential envelopes, `collect`/`track` for sustained
teardown.

### `shatter(ctx, dest, t, p)` → dur
Brittle fracture. Grain cloud synthesized into **one buffer per call** (like
`pluck`/`creak` — never N live oscillators). Params: `dur` (0.45), `grains`
(42), `f0` base shard freq (3200; log-uniform spread ±[−0.8,+1.4] octaves),
`bright` freq scale, `skew` grain-time exponent (2.2; **>1 front-loads =
breaking, <1 rear-loads = converging formation**), `ring` per-shard decay
scale, `crack` 0..1 leading fracture strikes (1), `hp` highpass under the
cloud (1500), `gain`, `seed`.

### `ratchet(ctx, dest, t, p)` → dur
Pawl over gear teeth — regular machined detents (vs `creak`'s irregular
stick-slip). Per detent: strike + 2-partial pawl `body`, jittered. Params:
`detents` (5), `dur` (0.35), `end` = last/first interval ratio (**>1
decelerates, <1 accelerates**), `f` pawl freq (640), `hp` (2600), `jitter`
(0.07), `gain`, `seed`, `collect`.

### `drone(ctx, dest, t, dur, p)` → dur
Sustained tonal pressure (tonal sibling of `stream`; explicit `dur`,
fade-in/out, `collect`-aware). Symmetric detuned pair beats at a rate set by
`detune` cents (**≤5 breathes, ≥30 dread**). Params: `f` (55), `detune` (8),
`type` ('sine'), `sub` octave-down level (0), `lp` (500) + drift LFO (`drift`
0.06 Hz, `driftAmt`), `gain`, `fade` (1.5), `collect`.

## Audition workflow (phase 4 — the loop we are in)

```bash
cd ../paulgibeault.github.io
node tools/soundpack/render.mjs hecknsic            # → tools/soundpack/out/hecknsic-v1.wav + INDEX.md
node tools/soundpack/render.mjs hecknsic --version v2   # after edits, keep v1 for A/B
```

The INDEX.md timestamps are exact — feedback arrives as "1:12 too bright";
edit `js/soundpack.js` (or the elements), re-render, diff by ear. The renderer
injects the *shipped* `arcade-audio.js`, so an approved audition is
bit-identical to what plays. v1 rendered 2026-07-26: 4:47, peaks ≤0.83, no
clipping.

## Phase 5 — `js/audio.js` rewrite (spec)

Follow `../moon-lit/js/sfx.js` **exactly** in shape: single registration site
(A1), guarded play-wrapper (A2), launcher owns volume/mute (A3), kebab-case
event-shaped names (A4).

- **Graph path** gate: `Arcade.audio.graph`, `.room`, `.start`, `.el()` all
  present AND every `NEEDED_ELEMENTS` entry is a function:
  `['strike','rustle','body','thump','flare','blast','shatter','ratchet','drone','teardown']`.
  On success: `a.room(HecknsicPack.ROOM)`, register each `CUES` entry with its
  `SENDS`, register `pulse`/`tension` with `{ sustained: true, send: 0.30 / 0.35 }`,
  set `graphMode = true`.
- **Fallback path**: the CURRENT chiptune cues, preserved **verbatim** as the
  archive (rotate, match, combo, special, bomb, game-over, ui-click — see git
  history of this file). A stale SW cache gets the old sound, never silence,
  never console noise.
- **Exports** (superset of today's, so call sites stay one-line):
  - `sfx(name, opts)` — unchanged guard.
  - `playRotate(kind)` — graph: `sfx('rotate', {kind})`; fallback: `sfx('rotate')`.
  - `playSelect()` — graph-only; fallback no-op (old profile had no cue).
  - `playMatch(count)` / `playCombo(depth)` — graph: params through; fallback:
    `sfx('match')` / `sfx('combo', {freq: comboFreq(depth)})` (keep
    `comboFreq` for the fallback only).
  - `playSpecial(type)` — graph: `sfx(type)` for
    `'starflower'|'blackpearl'|'grandpoobah'`; fallback: `sfx('special')`.
  - `playBombArrive()` — graph: `'bomb-arrive'`; fallback: `'bomb'`.
  - `playBombTick(urgency)` — graph-only; fallback no-op.
  - `playBombExplode()` — graph: `'bomb-explode'`; fallback no-op (the old
    profile folded the explosion into `game-over`, which still fires).
  - `playGameOver(isSessionEnd)` — graph: if `!isSessionEnd` play
    `'bomb-explode'` then `'game-over'` ~0.8 s later (`setTimeout` is fine —
    launcher mute makes late play a no-op); else `'game-over'` alone.
    Fallback: `sfx('game-over')` once, as today.
  - `playOverAchiever()`, `playGameWin()` — graph: own cues; fallback:
    `'game-over'` → keep silence for these two instead (they had no archived
    sound; a wrong-mood cue is worse than none).
  - `startBed()` / `stopBed(fade)` / `setBedUrgency(u)` — see below.
  - `wireUiClicks()` — unchanged.
- **Beds**: `startBed()` idempotent, graph-gated, `a.start('pulse', { dur: 420,
  intensity })` where intensity = 0.6 arcade / 0.25 chill / 0.4 puzzle (from
  `getActiveGameModeId()` — pass it in rather than importing modes.js into
  audio.js if that creates a cycle). `tension` starts at urgency 0 alongside.
  `setBedUrgency(u)` retunes the tension handle only (never the pulse), using
  moon-lit's quantised-steps-with-hysteresis pattern verbatim: steps
  `[0, 0.35, 0.7, 1.0]`, up `[0.30, 0.58, 0.84]`, down `[0.20, 0.48, 0.74]`,
  crossfade 2.0 s; no-op when `retune` is missing (pre-3.7.0 SDK). `stopBed`
  on game over / restart / mode switch; also call `startBed()` from the first
  user-gesture path so autoplay policy is satisfied.

## Phase 6 — call-site wiring (exact map)

| site | today | becomes |
|---|---|---|
| `js/main.js:836` (`animateRotation`) | `sfx('rotate')` | `playRotate(flowerCenter ? 'ring' : pearlCenter ? 'y' : 'cluster')` |
| `js/main.js:721`, `:742`, `:760` (`state = 'selected'`) | silent | `playSelect()` (once per pickup, not per re-render) |
| `js/main.js:907–918` bomb shake tween | visual only | before the tween: compute `minTimer` = min `bombTimer` over board; `playBombTick(clamp01(1 − (minTimer − 1) / 10))` |
| `js/main.js:927` | `sfx('bomb')` | `playBombArrive()` |
| `js/main.js:953` / `:966` / `:979` | `sfx('special')` ×3 | `playSpecial('grandpoobah' / 'blackpearl' / 'starflower')` |
| `js/main.js:995–996` | `sfx('combo', {freq})` / `sfx('match')` | `playCombo(getChainLevel())` / `playMatch(matches.size)` |
| `js/main.js:878` (`handleGameWin`) | silent | `playGameWin()` |
| `js/animations.js:516` (`handleGameOver`) | `sfx('game-over')` | `playGameOver(isSessionEnd)` |
| `js/animations.js:454` (`handleOverAchiever`) | silent | `playOverAchiever()` |
| bed lifecycle | — | `startBed()` on game start/first input; `setBedUrgency(...)` at the end of `postRotationCheck` (same `minTimer` math; 0 when no bombs); `stopBed()` in game-over/over-achiever/reset paths |

Plus:

- **`index.html:15`** — after the SDK line add, matching moon-lit's comment style:
  `<script src="/arcade-audio.js"></script>` then
  `<script src="js/soundpack.js"></script>` (before the `js/main.js` module).
- **`sw.js`** — add `./js/soundpack.js` to `STATIC_ASSETS`; bump
  `APP_VERSION` (CI check `check-sw-bump` will demand it).
- **`ago:120`** — the staged-launcher copy loop
  (`for f in index.html profile.html manifest.json arcade-sdk.js styles.css`)
  is missing `arcade-audio.js`; add it or local `ago` runs silently fall back
  to chiptune. (moon-lit's `ago` has the same latent gap.)
- **audio.js header** — remove the stale "sound aesthetics need a human ear
  pass" note; the pack got one.

## Phase 7 — verification

1. `./ago`, open the game, confirm the console-free graph path registers
   (temporarily `console.log(graphMode)` if needed — remove before commit).
2. Exercise: select, rotate (cluster + starflower ring), match, cascade,
   bomb spawn→tick→defuse and →explode, puzzle win, chill session end.
3. Kill `/arcade-audio.js` from the stage once to prove the chiptune fallback
   still plays.
4. Launcher repo: `npm run check-sw-bump`; hecknsic tests in `tests/` still
   pass (audio is import-inert without `window.Arcade`).
