/**
 * fake-arcade.mjs — the slice of the launcher SDK the power-saver modules read.
 *
 * Must be installed on globalThis *before* the modules under test are
 * imported: they subscribe to onSettingsChange at evaluation time, which is
 * the whole point (a settings handler is where an unguarded read does its
 * damage).
 */

/**
 * @param {object}  [opts]
 * @param {boolean} [opts.powerSaver]  initial value of the setting
 * @param {boolean} [opts.reducedMotion]
 * @param {'current'|'legacy'} [opts.sdk] — 'legacy' models anything older than
 *        SDK 3.13.0, where `Arcade.settings.powerSaver` does not exist at all
 *        and calling it throws.
 */
export function installArcade({ powerSaver = false, reducedMotion = false, sdk = 'current' } = {}) {
  let value = powerSaver;
  const handlers = [];
  const settings = { reducedMotion: () => reducedMotion };
  if (sdk !== 'legacy') settings.powerSaver = () => value;

  globalThis.Arcade = {
    settings,
    onSettingsChange: (fn) => { handlers.push(fn); },
  };

  return {
    /** What the launcher does on a settings write: change, then fan out. */
    push(next) {
      value = next;
      for (const fn of handlers) fn({ powerSaver: next, reducedMotion });
    },
    handlerCount: () => handlers.length,
  };
}
