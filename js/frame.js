/**
 * frame.js — the wake-up call for a parked render loop.
 *
 * GAME_INTEGRATION §6d: a visible-but-idle game must let the display pipeline
 * reach 0 fps. Dirty-checking inside a loop that still runs every frame does
 * not achieve that — the rAF callback itself is the wake-up. So the loop parks
 * itself (`stop()`) once the board is settled, and anything that creates new
 * work has to wake it again.
 *
 * This module is the seam that lets the low-level modules do that without
 * importing main.js (which imports them). main.js owns the loop and registers
 * it here; renderer.requestRedraw() and tween() call wakeFrameLoop().
 *
 * Deliberately inert until registered, so the renderer stays importable in
 * node for the unit tests, where there is no Arcade and no loop at all.
 */

let loop = null;
let canRun = () => true;

/**
 * @param {{start:Function, running:Function}} l — an Arcade.loop handle.
 * @param {() => boolean} [gate] — false while the game is deliberately parked
 *        (a modal is open), so a stray redraw can't restart the loop behind it.
 */
export function registerFrameLoop(l, gate) {
  loop = l;
  if (typeof gate === 'function') canRun = gate;
}

/** Restart the loop if it has parked. Idempotent and cheap; call it freely. */
export function wakeFrameLoop() {
  if (!loop || loop.running() || !canRun()) return;
  loop.start();
}
