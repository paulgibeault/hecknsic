/**
 * power-saver-legacy.test.js — the guarded read, against a pre-3.13 SDK.
 *
 * Its own file because the fake launcher has to be installed before the module
 * graph is evaluated, and node's test runner gives each file its own process.
 *
 * Why this is worth a test of its own: `Arcade.settings.powerSaver` arrived in
 * SDK 3.13.0. Written the obvious way, the read is a TypeError on anything
 * older — and not just at boot. The subscription fires on *every* launcher
 * settings write, so an unguarded call throws inside the settings handler and
 * takes handedness, font scale and theme down with it, on a game that would
 * otherwise have degraded quietly to "not saving".
 */
import test from 'node:test';
import assert from 'node:assert';
import { installArcade } from './helpers/fake-arcade.mjs';

const launcher = installArcade({ sdk: 'legacy' });
const power = await import('../js/power.js');

test('a missing powerSaver method reads as false rather than throwing', () => {
  assert.strictEqual(power.isPowerSaving(), false);
});

test('a settings change against a legacy SDK does not throw', () => {
  assert.strictEqual(launcher.handlerCount(), 1,
    'precondition: power.js subscribed to onSettingsChange');
  assert.doesNotThrow(() => launcher.push(true));
  assert.strictEqual(power.isPowerSaving(), false,
    'an older SDK has no such setting — it degrades to "not saving"');
});
