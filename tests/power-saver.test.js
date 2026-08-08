/**
 * power-saver.test.js — GAME_INTEGRATION §5 / §6d, the parts a node test can
 * actually pin.
 *
 * The end-to-end claim (§6d: "a flat main thread and 0 fps between state
 * changes") is a browser measurement and lives in the Playwright acceptance
 * run, not here. What is testable in-process is everything that measurement
 * depends on:
 *
 *   - the decorative/informational split, so a later "just add a sparkle"
 *     lands on the gated side by default;
 *   - the wake seam, because a loop that parks and never comes back is a much
 *     worse bug than a loop that never parks;
 *   - the no-infinite-animations gate over the stylesheets.
 *
 * The guarded read against a pre-3.13 SDK is its own file, because it needs a
 * different Arcade installed before the module graph is evaluated and node
 * gives each test file its own process.
 *
 * Everything is imported once, at the top, against one fake launcher — the
 * modules under test import each other by plain specifier, so per-test cache
 * busting would hand each test a different copy of the seam it is asserting on.
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { ROOT } from '../tools/stage.mjs';
import { installArcade } from './helpers/fake-arcade.mjs';

const launcher = installArcade({ powerSaver: false });

const power    = await import('../js/power.js');
const frame    = await import('../js/frame.js');
const renderer = await import('../js/renderer.js');
const { tween } = await import('../js/tween.js');

/** Every decorative effect the game can throw, in one call. */
function spawnAllDecoration() {
  renderer.spawnCreationParticles(10, 10, 8);
  renderer.spawnExplosionParticles(10, 10, 8);
  renderer.spawnColorNukeParticles(10, 10, 0, 8);
  renderer.spawnRingShockwave(10, 10, 100, 255, 0, 0);
  renderer.flashScreenOverlay(255, 0, 0, 0.2, 30);
}

test('powerSaver tracks the launcher and notifies only on a real change', () => {
  launcher.push(false);
  const seen = [];
  power.onPowerSaverChange((v) => seen.push(v));

  assert.strictEqual(power.isPowerSaving(), false);
  launcher.push(true);
  assert.strictEqual(power.isPowerSaving(), true);
  launcher.push(true);   // a settings write that didn't touch this setting
  launcher.push(false);

  assert.deepStrictEqual(seen, [true, false],
    'subscribers should see transitions, not every settings write');
});

test('power saver drops decoration and keeps the readouts', () => {
  launcher.push(false);
  spawnAllDecoration();
  assert.strictEqual(renderer.hasActiveRendererAnimations(), true,
    'precondition: decorative effects are live with the lever off');

  // Flipping it on drops what is already in flight — otherwise the player pays
  // for the rest of the current cascade before the setting means anything.
  launcher.push(true);
  assert.strictEqual(renderer.hasActiveRendererAnimations(), false,
    'a live burst must be cleared when power saver comes on, not merely stopped ' +
    'from respawning — while any of it is alive the loop cannot park');

  spawnAllDecoration();
  assert.strictEqual(renderer.hasActiveRendererAnimations(), false,
    'every decorative spawner must be a no-op under power saver');

  // The informational half is untouched: a score popup is the only readout of
  // what a match was worth, and dropping it would drop information rather than
  // decoration.
  renderer.spawnScorePopup(10, 10, 500, 2);
  assert.strictEqual(renderer.hasActiveRendererAnimations(), true,
    'power saver must not silence the score popup');
  launcher.push(false);
  launcher.push(true);   // a full transition, which fires the clear
  assert.strictEqual(renderer.hasActiveRendererAnimations(), true,
    'the clear must take the confetti and leave the readout');
});

test('a parked loop is woken by a redraw request and by a new tween', () => {
  launcher.push(false);

  let running = false;
  let starts = 0;
  let gateOpen = true;
  frame.registerFrameLoop(
    { start() { running = true; starts++; }, running: () => running },
    () => gateOpen,
  );

  // Parked, as it is whenever the board is settled.
  running = false;
  renderer.requestRedraw();
  assert.strictEqual(starts, 1, 'requestRedraw() must restart a parked loop');

  running = false;
  tween(100, () => {});
  assert.strictEqual(starts, 2,
    'a tween started from a parked state would never advance and its promise ' +
    'would never resolve — the cascade chains await these');

  // Already running: no redundant start.
  running = true;
  renderer.requestRedraw();
  assert.strictEqual(starts, 2, 'waking a running loop should be a no-op');

  // A modal is a deliberate park, not an idle one: a stray redraw behind it
  // must not put frames back on the schedule.
  running = false;
  gateOpen = false;
  renderer.requestRedraw();
  tween(100, () => {});
  assert.strictEqual(starts, 2, 'the gate must hold the loop parked while paused');
});

test('no infinite CSS animation ships — §6d, "let the screen rest"', () => {
  const tracked = execSync('git ls-files -z', { cwd: ROOT, encoding: 'utf8' })
    .split('\0').filter(Boolean)
    .filter((f) => /\.(css|html)$/.test(f));
  assert.ok(tracked.length > 0, 'precondition: found stylesheets to check');

  const offenders = [];
  for (const f of tracked) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      // Either spelling: the shorthand's keyword, or the longhand property.
      if (/animation(-iteration-count)?\s*:[^;}]*\binfinite\b/.test(line)) {
        offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepStrictEqual(offenders, [],
    'An infinite animation is a rAF loop that never stops, written declaratively — ' +
    'a visible-but-idle game can never reach 0 fps while one runs. Pulse finitely ' +
    'with `animation-iteration-count: var(--arcade-pulse-count, 3)` and settle to a ' +
    'static resting treatment that still reads.');
});
