/**
 * ui.js — the small DOM gestures that more than one module needs.
 *
 * Both helpers here existed twice, verbatim, in modules that cannot simply
 * import one from the other: main.js imports animations.js and puzzle-mode.js,
 * so neither of those can import main.js back. Copying was the path of least
 * resistance, and it is how the two copies of the shake ended up with
 * different null-handling and the two copies of the name prefill ended up
 * maintained in parallel.
 *
 * DOM-only and main.js-free on purpose, like js/modal.js — nothing in here
 * reaches for the game state, so it stays importable under `node --test`.
 *
 * This is a helpers module, not a UI layer. Rendering lives in renderer.js,
 * gestures in input.js, modals in modal.js; something that belongs to one of
 * those belongs there, not here.
 */

import { getPlayerName } from './storage.js';

// ─── Refusal shake ──────────────────────────────────────────────

/**
 * Must match `.shake-animation`'s duration in css/overlays.css
 * (`animation: shake 0.4s …`). Removing the class early would cut the
 * animation off mid-shake.
 */
const SHAKE_MS = 400;

/**
 * Shake an element once to signal a refused action.
 *
 * Two call sites refuse a board-replacing click while the board is
 * mid-animation — main.js's guardedAction() (new game, mode switch, the
 * game-win and over-achiever restarts) and puzzle-mode.js's
 * refuseWhileProcessing() (the puzzle selector, editor and restart buttons) —
 * and both have to make the refusal read as deliberate rather than as a
 * dropped tap.
 *
 * The sequence is not obvious and is easy to get subtly wrong, which is why
 * one copy beats two: removing the class and re-adding it in the same task
 * does nothing at all — the browser coalesces it and the animation never
 * restarts — so the forced reflow in between is load-bearing, and the trailing
 * removal is what leaves the element ready to shake again on the very next
 * click.
 *
 * The guards themselves stay at the call sites: they answer to different
 * busy-predicates (main.js owns the state machine; puzzle-mode.js has one
 * injected) and want different return shapes. Only the gesture is shared.
 *
 * Safe to call with null — every caller reads its element out of an event.
 * @param {Element|null|undefined} el
 */
export function shakeRefusal(el) {
  if (!el || !el.classList) return;
  el.classList.remove('shake-animation');
  void el.offsetWidth; // force reflow, so re-adding the class restarts it
  el.classList.add('shake-animation');
  setTimeout(() => el.classList.remove('shake-animation'), SHAKE_MS);
}

// ─── Name entry ─────────────────────────────────────────────────

/** Every modal that asks the player to sign a score. */
const NAME_INPUT_IDS = ['go-name', 'gw-name', 'oa-name', 'es-name'];

/**
 * Prefill all four score-signing inputs with the sticky player name, so a
 * returning player confirms rather than retypes.
 *
 * All four are filled every time rather than just the one modal about to open:
 * the modals are static in index.html and any of them can be the next one
 * shown, so which single id to touch is a question with no stable answer.
 */
export function prepopulateNameInputs() {
  const name = getPlayerName();
  for (const id of NAME_INPUT_IDS) {
    const el = document.getElementById(id);
    if (el) el.value = name;
  }
}
