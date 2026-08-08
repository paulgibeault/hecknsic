/**
 * power.js — the launcher's power-saver lever, cached and safe to read.
 *
 * GAME_INTEGRATION §5 / §6d. When the player turns power saver on, a game
 * drops ambient and decorative rendering and keeps only gameplay-essential
 * motion. The setting is pushed on every launcher settings write, so the
 * cached value is refreshed from onSettingsChange rather than re-read per
 * frame.
 *
 * The read is guarded on purpose. `Arcade.settings.powerSaver` only exists
 * from SDK 3.13.0; on anything older the property is `undefined` and calling
 * it throws `TypeError: ... is not a function`. Inside an onSettingsChange
 * handler that is a throw on *every* settings write, not just at boot — so an
 * unguarded read would break handedness/font-scale/theme along with it. With
 * the guard, an older SDK simply degrades to "not saving".
 */

let saving = readSetting();
const listeners = [];

function readSetting() {
  if (typeof Arcade === 'undefined' || !Arcade.settings) return false;
  return Arcade.settings.powerSaver ? Arcade.settings.powerSaver() : false;
}

/** True while the player has asked us to spend less battery. */
export function isPowerSaving() { return saving; }

/** Subscribe to transitions. Called with the new value, only when it changes. */
export function onPowerSaverChange(fn) { listeners.push(fn); }

/** Re-read and fan out. Exported for tests; wired to onSettingsChange below. */
export function refreshPowerSaver() {
  const next = readSetting();
  if (next === saving) return saving;
  saving = next;
  for (const fn of listeners) fn(saving);
  return saving;
}

if (typeof Arcade !== 'undefined' && typeof Arcade.onSettingsChange === 'function') {
  Arcade.onSettingsChange(refreshPowerSaver);
}
