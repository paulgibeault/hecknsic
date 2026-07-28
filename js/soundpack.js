// hecknsic sound pack — the game's own sound design.
//
// Loaded as a plain script after /arcade-audio.js. js/audio.js registers
// everything here with Arcade.audio; the launcher's tools/soundpack renderer
// loads this same file to produce audition WAVs, so what gets approved by ear
// is what plays.
//
// The place: a dark room with a glass machine in it. The board is saturated
// jewel glass on near-black (#0a0b0e); the one mechanical act in the game is
// the rotation, so the mechanism RATCHETS — precise metal detents, not wood
// creak. Everything destructive shatters; everything formed rings. Under it
// all, the room itself has a pulse: a slow sub heartbeat that leans in when
// bombs are on the board. Where moon-lit was discrete events over silence,
// hecknsic is discrete glass over a floor that breathes.
//
// The room is small and hard-surfaced — short predelay, tight decay, and much
// less top-shelf cut than an outdoor space, because glass IS its top end.
//
// Register plan, so simultaneous cues occupy different bands instead of
// masking each other:
//   pulse bed 30–90 · bomb boom/rumble 22–160 · ratchet pawl 200–1.4k
//   glass bodies 500–3k · shatter shards 2.5–9k · UI tink 3–6k
//
// Every cue takes an `r` (seeded random stream) and varies pitch, timing and
// layer balance per play. The rotate ratchet matters most: it fires on every
// single input, and a mechanism that makes the same noise every turn stops
// being furniture and starts being a beep.

(function (global) {
  'use strict';
  const S = global.ArcadeAudioElements;

  // Every cue here is built from the element library's gestures, so with the
  // library absent — a stale service-worker cache, or running standalone off
  // the launcher origin — there is nothing registrable and the game's audio
  // module takes its fallback path. Bail before dereferencing S: this file is
  // a plain script, and a throw here would surface as a page error even though
  // the fallback itself works. Also covers an OLDER library that predates
  // registerPack, which is the same stale-cache scenario one version on.
  if (!S || typeof S.registerPack !== 'function') return;

  // A small dark interior with hard walls. Reflections arrive almost at once
  // and die fast; the shelf barely touches the top end because a dark room
  // full of glass still glints. A long or dark tail would put the board
  // outdoors, or in a cathedral — both wrong.
  const ROOM = {
    dur: 1.15,
    decay: 0.30,
    preDelay: 0.009,
    wet: 0.5,
    shelfHz: 7800,
    shelfDb: -2.5,
    seed: 4111,
  };

  // Struck gem glass — the material every ordinary tile is made of. Stretched
  // inharmonic ratios (glass, unlike a string, is stiff), upper partials dying
  // fast: a tap, a glint, gone.
  const GLASS = [
    { ratio: 1.00, gain: 1.00, decay: 0.55, detune: 4 },
    { ratio: 2.32, gain: 0.55, decay: 0.30, detune: 6 },
    { ratio: 4.25, gain: 0.28, decay: 0.16, detune: 8 },
    { ratio: 6.63, gain: 0.13, decay: 0.09, detune: 10 },
    { ratio: 9.38, gain: 0.06, decay: 0.05, detune: 12 },
  ];

  // Chrome — the starflower's silver. Same family as GLASS but energy shifted
  // UP the series (the 2.76 partial outweighs the prime) and detuned harder,
  // so the whole stack beats and shimmers instead of settling.
  const CHROME = [
    { ratio: 1.00, gain: 0.90, decay: 0.90, detune: 6 },
    { ratio: 2.76, gain: 1.00, decay: 0.70, detune: 9 },
    { ratio: 5.40, gain: 0.50, decay: 0.45, detune: 12 },
    { ratio: 8.93, gain: 0.25, decay: 0.28, detune: 14 },
    { ratio: 13.34, gain: 0.10, decay: 0.15, detune: 16 },
  ];

  // Obsidian — the black pearl. Materially the inverse of CHROME: nearly
  // harmonic (dense volcanic glass rings almost pure), nearly no upper
  // partials, and a decay three times GLASS's. Dark, smooth, heavy.
  const OBSIDIAN = [
    { ratio: 1.00, gain: 1.00, decay: 1.90, detune: 3 },
    { ratio: 2.01, gain: 0.40, decay: 1.10, detune: 4 },
    { ratio: 3.02, gain: 0.15, decay: 0.55, detune: 5 },
    { ratio: 5.19, gain: 0.05, decay: 0.20, detune: 8 },
  ];

  // How much of the room each cue sits in. The ratchet is under your fingers
  // and stays nearly dry; the specials bloom out into the space; the bomb owns
  // the whole room when it goes.
  const SENDS = {
    'rotate': 0.14,
    'select': 0.15,
    'match': 0.30,
    'combo': 0.34,
    'starflower': 0.45,
    'blackpearl': 0.40,
    'grandpoobah': 0.50,
    'bomb-arrive': 0.38,
    'bomb-tick': 0.22,
    'bomb-explode': 0.55,
    'over-achiever': 0.55,
    'game-win': 0.50,
    'game-over': 0.48,
    'ui-click': 0.10,
  };

  // The two mix anchors, same discipline as moon-lit. CONSTANT is anything
  // that fires on every input (rotate, select): texture you could not swear
  // you heard. FREQUENT is the per-clear family (match, combo): present, but
  // it repeats many times a minute, so it must never announce itself.
  const CONSTANT = 0.026;
  const FREQUENT = 0.055;

  const clamp01 = (x) => Math.max(0, Math.min(1, typeof x === 'number' && isFinite(x) ? x : 0));

  // A tiny glass knock — the tile family's contact sound, used wherever a
  // piece seats or is touched. Two partials only: a full GLASS body at knock
  // level just reads as another match.
  function knock(ctx, o, t, r, f0, gain, collect) {
    S.strike(ctx, o, t, { dur: 0.004, hp: S.between(r, 1200, 1700), gain: gain * 0.8, seed: (r() * 1e6) | 0, collect });
    S.body(ctx, o, t, {
      f0: f0 * S.cents(r, 30), gain,
      partials: [
        { ratio: 1.0, gain: 1.0, decay: S.between(r, 0.04, 0.07), detune: 5 },
        { ratio: 2.32, gain: 0.3, decay: S.between(r, 0.02, 0.04), detune: 8 },
      ],
      collect,
    });
  }

  const CUES = {
    // The rotation mechanism. Glass tiles, but the AXLE is machined metal:
    // discrete pawl detents, decelerating (`end` > 1) because a hand settles a
    // dial rather than spinning it, ending on the glass knock of the cluster
    // seating in its new orientation. Fires on every press → CONSTANT, and
    // every turn pulls its own pawl pitch, brightness, detent count wobble and
    // seating weight so no two turns agree.
    //
    // p.kind: 'cluster' (3 detents) | 'y' (4) | 'ring' (6, longer — the
    // starflower turns six tiles at once and the mechanism has more to move).
    'rotate': function (ctx, o, t, p, r) {
      const kind = p && p.kind;
      const detents = kind === 'ring' ? 6 : kind === 'y' ? 4 : 3;
      const dur = kind === 'ring' ? S.between(r, 0.40, 0.50) : S.between(r, 0.22, 0.30);
      S.ratchet(ctx, o, t, {
        detents, dur,
        f: S.between(r, 520, 700), hp: S.between(r, 2200, 3000),
        end: S.between(r, 1.6, 2.2),
        gain: CONSTANT * S.between(r, 0.85, 1.15),
        jitter: 0.08, seed: (r() * 1e6) | 0,
      });
      // the cluster dropping into its detent — glass on glass, quiet, and not
      // every time: sometimes the mechanism just stops
      if (r() < 0.9) {
        knock(ctx, o, t + dur + 0.015, r, S.between(r, 300, 380), CONSTANT * S.between(r, 0.7, 1.0));
      }
      return dur + 0.18;
    },

    // Picking a cluster up: the three tiles lift, three micro-tinks a few
    // hundredths apart, rising slightly. Barely there — this and rotate are
    // the whole per-input texture of the game.
    'select': function (ctx, o, t, p, r) {
      const n = Math.min((p && p.tiles) || 3, 3);
      let at = t;
      for (let i = 0; i < n; i++) {
        S.body(ctx, o, at, {
          f0: S.between(r, 950, 1350) * (1 + 0.06 * i), gain: CONSTANT * 0.55,
          partials: [
            { ratio: 1.0, gain: 1.0, decay: 0.07, detune: 5 },
            { ratio: 2.32, gain: 0.25, decay: 0.04, detune: 8 },
          ],
        });
        at += S.between(r, 0.014, 0.026);
      }
      return 0.2;
    },

    // A match clearing — the tiles SHATTER. Cluster size scales the fracture,
    // not just the level: more shards, a longer cloud, and a base pitch that
    // sits lower (bigger panes ring deeper), plus the struck ring of the glass
    // that broke. p.count = tiles cleared (3..10+).
    'match': function (ctx, o, t, p, r) {
      const count = Math.max(3, ((p && p.count) | 0) || 3);
      const size = Math.min(count, 10);
      const sc = 1 + (size - 3) * 0.13;              // 3 → 1.0, 10 → ~1.9
      S.shatter(ctx, o, t, {
        dur: 0.30 * sc, grains: Math.round(26 * sc),
        f0: 3400 / Math.sqrt(sc),
        skew: 2.3, crack: 0.8, hp: 1600,
        gain: FREQUENT * (0.80 + 0.06 * (size - 3)),
        seed: (r() * 1e6) | 0,
      });
      S.body(ctx, o, t + 0.004, {
        f0: (S.between(r, 700, 780) / Math.pow(sc, 0.3)) * S.cents(r, 8),
        gain: FREQUENT * 0.7, partials: GLASS,
      });
      return 0.3 * sc + 0.5;
    },

    // A chained cascade step. Same fracture, but the LADDER is the message:
    // the glass ring climbs a semitone per chain level and the shards brighten
    // and thicken with it, so a deep cascade is heard going up a staircase.
    // p.depth = chain level (1, 2, 3, …).
    'combo': function (ctx, o, t, p, r) {
      const depth = Math.max(1, ((p && p.depth) | 0) || 1);
      const step = Math.min(depth, 12);
      const lift = Math.pow(2, step / 12);
      S.shatter(ctx, o, t, {
        dur: 0.26, grains: 24 + step * 2,
        f0: 3000 * Math.sqrt(lift),
        skew: 2.0, crack: 0.6, hp: 1800,
        gain: FREQUENT * (0.85 + 0.05 * step),
        seed: (r() * 1e6) | 0,
      });
      S.body(ctx, o, t + 0.004, {
        f0: 620 * lift * S.cents(r, 6),
        gain: FREQUENT * 0.75, partials: GLASS,
      });
      return 0.9;
    },

    // Starflower forming — six tiles collapsing INWARD into chrome. The
    // reversed shatter (skew < 1, no crack) is the whole idea: the same
    // granular cloud that means "breaking" everywhere else, run as a
    // crescendo that converges on the ring of the formed piece. Formation,
    // not destruction.
    'starflower': function (ctx, o, t, p, r) {
      S.shatter(ctx, o, t, {
        dur: 0.5, grains: 40, f0: 4200,
        skew: 0.6, crack: 0, hp: 2400, ring: 0.9,
        gain: 0.10, seed: (r() * 1e6) | 0,
      });
      S.strike(ctx, o, t + 0.42, { dur: 0.006, hp: 3200, gain: 0.10, seed: (r() * 1e6) | 0 });
      S.body(ctx, o, t + 0.42, { f0: S.between(r, 1180, 1300), gain: 0.20, partials: CHROME });
      return 2.0;
    },

    // Black pearl forming — the same convergence, but everything is DOWN:
    // darker shards, and the arrival is not a ring but a weight — a sub thump
    // under a long obsidian tone. The pair are deliberately opposite ends of
    // one gesture: starflower ascends into shimmer, pearl descends into mass.
    'blackpearl': function (ctx, o, t, p, r) {
      S.shatter(ctx, o, t, {
        dur: 0.4, grains: 26, f0: 2400,
        skew: 0.7, crack: 0, hp: 1400, ring: 1.4,
        gain: 0.06, seed: (r() * 1e6) | 0,
      });
      S.thump(ctx, o, t + 0.30, { f0: 72, f1: 34, dur: 0.7, gain: 0.16, attack: 0.02, seed: (r() * 1e6) | 0 });
      S.body(ctx, o, t + 0.32, { f0: S.between(r, 155, 175), gain: 0.22, partials: OBSIDIAN });
      return 2.8;
    },

    // Grand poobah — the rarest formation: both materials at once. A long
    // double convergence lands on obsidian AND chrome together (the low body
    // first, the shimmer a beat later, like a bell and its glint), over a
    // short drone swell that gives the moment a floor.
    'grandpoobah': function (ctx, o, t, p, r) {
      const collect = [];
      S.shatter(ctx, o, t, {
        dur: 0.7, grains: 60, f0: 3000,
        skew: 0.55, crack: 0, hp: 1600,
        gain: 0.09, seed: (r() * 1e6) | 0,
      });
      S.drone(ctx, o, t, 2.8, {
        f: 65, detune: 10, lp: 420, gain: 0.09, fade: 0.9,
        drift: 0.15, driftAmt: 90, collect,
      });
      S.thump(ctx, o, t + 0.55, { f0: 80, f1: 36, dur: 0.8, gain: 0.18, attack: 0.02, seed: (r() * 1e6) | 0 });
      S.body(ctx, o, t + 0.56, { f0: S.between(r, 125, 140), gain: 0.24, partials: OBSIDIAN });
      S.body(ctx, o, t + 0.68, { f0: S.between(r, 1500, 1650), gain: 0.14, partials: CHROME });
      return 3.6;
    },

    // A bomb LANDS on the board. Three things in order: the impact (it
    // arrives with weight — the glass around it complains), the fuse catching
    // (a flare, no crack: ignition, not impact), and then the dread — a low
    // detuned pair beating at ~3 Hz, unsettling before you can say why.
    'bomb-arrive': function (ctx, o, t, p, r) {
      S.thump(ctx, o, t, { f0: S.between(r, 110, 130), f1: 38, dur: 0.5, gain: 0.30, attack: 0.004, seed: (r() * 1e6) | 0 });
      S.body(ctx, o, t + 0.01, { f0: S.between(r, 280, 320), gain: 0.10, partials: GLASS });
      S.flare(ctx, o, t + 0.12, {
        f0: 1600, f1: 900, dur: 0.5, gain: 0.07,
        weight: 0.15, attack: 0.05, seed: (r() * 1e6) | 0,
      });
      // ~3 Hz beat at 92 Hz needs ~55 cents of detune — wide, and meant to be
      S.body(ctx, o, t + 0.15, {
        f0: 92, gain: 0.14,
        partials: [{ ratio: 1.0, gain: 1.0, decay: 1.5, detune: 28, attack: 0.06 }],
      });
      return 2.3;
    },

    // The fuse clock — one tick per move while a bomb is on the board.
    // p.urgency 0..1 (how close the nearest bomb is to zero): the tick
    // tightens, sharpens and gains weight as it rises. At 0 it is a dry
    // mechanism; at 1 it is a hammer on the room.
    'bomb-tick': function (ctx, o, t, p, r) {
      const u = clamp01(p && p.urgency);
      S.strike(ctx, o, t, {
        dur: 0.004, hp: 1800 + 1400 * u,
        gain: 0.10 + 0.08 * u, seed: (r() * 1e6) | 0,
      });
      S.body(ctx, o, t, {
        f0: (340 + 160 * u) * S.cents(r, 10), gain: 0.10 + 0.07 * u,
        partials: [
          { ratio: 1.0, gain: 1.0, decay: 0.05, detune: 6 },
          { ratio: 2.76, gain: 0.3, decay: 0.03, detune: 10 },
        ],
      });
      S.thump(ctx, o, t + 0.005, {
        f0: 88 + 30 * u, f1: 40, dur: 0.16 + 0.05 * u,
        gain: 0.09 + 0.09 * u, attack: 0.003, seed: (r() * 1e6) | 0,
      });
      return 0.5;
    },

    // The bomb goes. A detonation, not a fireball — full crack — with the
    // board itself as the resonating container (`tone`): a bell of glass
    // struck by the blast. Behind the front, the whole board's glass blows
    // outward in two waves: the near shards immediately, the late fragments
    // raining down after.
    'bomb-explode': function (ctx, o, t, p, r) {
      S.blast(ctx, o, t, {
        size: S.between(r, 1.15, 1.3), gain: 0.26,
        crack: 1, tone: 0.5, bf0: 96,
        f0: 2900, f1: 180, wf0: 120,
        seed: (r() * 1e6) | 0,
      });
      S.shatter(ctx, o, t + 0.03, {
        dur: 0.9, grains: 90, f0: 2600,
        skew: 1.6, crack: 0, hp: 1200,
        gain: 0.16, seed: (r() * 1e6) | 0,
      });
      S.shatter(ctx, o, t + 0.25, {
        dur: 1.1, grains: 40, f0: 1800,
        skew: 1.2, crack: 0, hp: 900, ring: 1.6,
        gain: 0.08, seed: (r() * 1e6) | 0,
      });
      return 3.6;
    },

    // The aftermath — three falling obsidian tolls and a last low breath.
    // Played alone for a chill-session end; after 'bomb-explode' for a real
    // game over (the wiring staggers them ~0.8s apart).
    'game-over': function (ctx, o, t, p, r) {
      const notes = [392, 311, 233];
      let at = t;
      for (const f of notes) {
        S.strike(ctx, o, at, { dur: 0.005, hp: 2000, gain: 0.07, seed: (r() * 1e6) | 0 });
        S.body(ctx, o, at, { f0: f * S.cents(r, 8), gain: 0.20, partials: OBSIDIAN });
        at += 0.55;
      }
      S.thump(ctx, o, at - 0.3, { f0: 60, f1: 28, dur: 1.2, gain: 0.16, attack: 0.05, seed: (r() * 1e6) | 0 });
      return 4.5;
    },

    // Over-achiever — the game's actual triumph condition, and the biggest
    // cue in the pack: a chrome staircase, a convergence, then the full chord
    // — obsidian floor, chrome crown, and a swell under it. Bright where
    // game-over is dark, ascending where it falls.
    'over-achiever': function (ctx, o, t, p, r) {
      const collect = [];
      const steps = [523.25, 659.26, 783.99, 1046.5];
      steps.forEach((f, i) => {
        S.strike(ctx, o, t + i * 0.16, { dur: 0.004, hp: 3000, gain: 0.06, seed: (r() * 1e6) | 0 });
        S.body(ctx, o, t + i * 0.16, { f0: f * S.cents(r, 6), gain: 0.13, partials: GLASS });
      });
      S.shatter(ctx, o, t + 0.2, {
        dur: 0.6, grains: 46, f0: 4000,
        skew: 0.6, crack: 0, hp: 2400,
        gain: 0.08, seed: (r() * 1e6) | 0,
      });
      S.drone(ctx, o, t, 3.2, {
        f: 65.4, detune: 7, lp: 460, gain: 0.10, fade: 0.8,
        drift: 0.12, driftAmt: 110, collect,
      });
      const land = t + 0.85;
      S.thump(ctx, o, land, { f0: 84, f1: 38, dur: 0.9, gain: 0.20, attack: 0.015, seed: (r() * 1e6) | 0 });
      S.body(ctx, o, land, { f0: 130.8, gain: 0.24, partials: OBSIDIAN });
      S.body(ctx, o, land + 0.1, { f0: 1046.5 * S.cents(r, 5), gain: 0.16, partials: CHROME });
      return 6.0;
    },

    // Puzzle solved — a small warm resolution: a rising glass triad landing
    // on one chrome note. Deliberately modest next to over-achiever; you may
    // solve forty of these in a sitting.
    'game-win': function (ctx, o, t, p, r) {
      const notes = [523.25, 659.26, 783.99];
      notes.forEach((f, i) => {
        S.strike(ctx, o, t + i * 0.12, { dur: 0.004, hp: 2800, gain: 0.06, seed: (r() * 1e6) | 0 });
        S.body(ctx, o, t + i * 0.12, { f0: f * S.cents(r, 6), gain: 0.15, partials: GLASS });
      });
      S.body(ctx, o, t + 0.5, { f0: 1046.5 * S.cents(r, 5), gain: 0.17, partials: CHROME });
      return 3.0;
    },

    // Menu / button tink — the quietest cue in the pack, nearly dry.
    'ui-click': function (ctx, o, t, p, r) {
      S.strike(ctx, o, t, { dur: 0.003, hp: 3200, gain: 0.10, seed: (r() * 1e6) | 0 });
      S.body(ctx, o, t, {
        f0: S.between(r, 1700, 1900), gain: 0.09,
        partials: [
          { ratio: 1.0, gain: 1.0, decay: 0.04, detune: 4 },
          { ratio: 2.32, gain: 0.2, decay: 0.02, detune: 7 },
        ],
      });
      return 0.1;
    },
  };

  // ── the beds ──────────────────────────────────────────────────────────────
  // Sustained cues in the SDK's shape: fn(ctx, out, when, params, rnd)
  // returning a teardown. Two layers on different clocks, so the tension can
  // be retuned (handle.retune) without restarting the pulse under it.

  // The room's heartbeat. NOT metrical: a puzzle game with no move clock has
  // no tempo to sync to, and a steady BPM fights the player's own pacing. So
  // it breathes instead — a low lub, usually answered by a softer dub, at a
  // spacing that wanders. `params.intensity` 0..1 (set per mode: chill low,
  // arcade higher) draws the beats closer and the answer more certain.
  function pulse(ctx, o, t, params, r) {
    const dur = (params && params.dur) || 420;
    const it = clamp01(params && params.intensity);
    const collect = [];
    S.drone(ctx, o, t, dur, {
      f: 41.2, detune: 5, lp: 260, gain: 0.020 + 0.015 * it,
      fade: 2.5, drift: 0.05, driftAmt: 70, collect,
    });
    let at = t + S.between(r, 0.8, 1.6);
    while (at < t + dur - 1.0) {
      const g = (0.035 + 0.030 * it) * S.between(r, 0.8, 1.1);
      S.thump(ctx, o, at, {
        f0: S.between(r, 54, 62), f1: 30, dur: 0.32, gain: g,
        attack: 0.012, seed: (r() * 1e6) | 0, collect,
      });
      if (r() < 0.5 + 0.4 * it) {
        S.thump(ctx, o, at + S.between(r, 0.30, 0.38), {
          f0: 48, f1: 27, dur: 0.26, gain: g * 0.55,
          attack: 0.014, seed: (r() * 1e6) | 0, collect,
        });
      }
      at += S.between(r, 1.7, 2.6) / (1 + 0.8 * it);
    }
    return S.teardown(collect);
  }

  // The bomb layer. `params.urgency` 0..1 tracks the nearest fuse: a beating
  // drone whose beat rate rises with urgency, and a dry tick subdividing the
  // pulse faster and harder as the fuse shortens. At 0 it schedules nothing —
  // no bombs, no tension, and the pulse alone is the whole floor.
  function tension(ctx, o, t, params, r) {
    const dur = (params && params.dur) || 420;
    const u = clamp01(params && params.urgency);
    const collect = [];
    if (u <= 0) return S.teardown(collect);
    S.drone(ctx, o, t, dur, {
      f: 82.4, detune: 18 + 26 * u, lp: 500,
      gain: 0.012 + 0.020 * u, fade: 1.2,
      drift: 0.09, driftAmt: 120, collect,
    });
    const step = 0.9 / (1 + 1.6 * u);
    let at = t + 0.5;
    while (at < t + dur - 0.5) {
      S.strike(ctx, o, at, {
        dur: 0.004, hp: S.between(r, 2400, 2900),
        gain: 0.020 + 0.030 * u, seed: (r() * 1e6) | 0, collect,
      });
      at += step * S.between(r, 0.92, 1.08);
    }
    return S.teardown(collect);
  }

  // Published under the framework's well-known handle (arcade-audio.js
  // registerPack) so the game's audio module and the launcher's soundpack
  // toolchain both reach it without either side knowing this game's name.
  S.registerPack({
    name: 'hecknsic', ROOM, SENDS, CUES,
    GLASS, CHROME, OBSIDIAN,
    pulse, tension,
  });
})(typeof window !== 'undefined' ? window : globalThis);
