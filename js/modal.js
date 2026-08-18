/**
 * modal.js — the one place a modal opens and closes.
 *
 * Before this module, opening and closing a modal was hand-rolled at every
 * call site, and there were two incompatible conventions. main.js's modals set
 * `isPaused = true` on open and closed through `resumeFromPause()`; the puzzle
 * selector, result, failed and editor modals never touched the pause flag at
 * all, so the board went on animating and eating clicks behind them. The #57
 * commit records six handlers that cleared `isPaused` without waking the loop
 * — that class of bug recurs precisely because the sequence lives at the call
 * site instead of in one function.
 *
 * So: one seam, four responsibilities, no exceptions.
 *
 *   1. the `hidden` class on the modal root,
 *   2. the pause flag (per the policy table below),
 *   3. `resume()` on close — clearing the flag is not enough on its own, a
 *      parked loop does not restart because a boolean flipped (#55/#57),
 *   4. `clearPendingAction()` on close, so the click that dismissed the modal
 *      does not survive as a queued gesture the board answers on the next
 *      frame (ghost click; js/input.js).
 *
 * Two things this module deliberately does NOT do:
 *
 *   - It never starts the frame loop itself. The host's resume() calls
 *     `wakeFrameLoop()`, which asks the gate registered in main.js
 *     (`() => !isPaused`). That gate stays the sole authority on whether a
 *     redraw may put frames back on the schedule; a second path from here
 *     would be exactly the bug the gate exists to prevent.
 *   - It never touches the tween clock. `parkFrameLoop()` in main.js calls
 *     `suspendTweenClock()` on the frame that observes the pause, which is the
 *     only moment that knows a gap is about to open (#63). Suspending from
 *     here as well would be a second, earlier, redundant call.
 *
 * DOM-only and host-injected on purpose: it imports nothing from main.js, so
 * it stays importable in node and survives the state-machine extraction.
 */

import { clearPendingAction } from './input.js';

/**
 * Every modal root in index.html, and whether opening it parks the game loop.
 *
 * PAUSING (the default, and the right answer for anything the player opens on
 * a live board): the board must not animate or consume input behind a modal.
 * This includes the puzzle selector and the puzzle editor — both of them
 * replace the board outright the moment the player picks something, so there
 * is nothing behind them worth keeping warm, and leaving the loop running
 * meant a puzzle could tick its bomb fuses while the player browsed the menu.
 *
 * NON-PAUSING (the five end-of-run modals): these are opened *over a
 * running animation on purpose*. handleGameOver() and handleOverAchiever()
 * show the modal and then `await tween(1500, …)` to blow the board apart
 * behind it; handleGameWin() is the tail of animateGrandPoobahCreation(),
 * which its caller is still awaiting inside the cascade loop. Pausing any of
 * the three would park the loop that advances those tweens, the awaits would
 * never settle, and the game would hang — a strictly worse bug than the one
 * this module fixes. They do not need the pause anyway: they are only ever
 * shown with `state === 'gameover'`, which already refuses input, drains the
 * gesture queue and parks the loop as soon as the explosion has finished.
 * Their close handlers still go through closeModal() and so still resume and
 * clear the pending action like everything else.
 *
 * modal-puzzle-result and modal-puzzle-failed are non-pausing for the same
 * reason. Both call _onPuzzleEnd() the moment they open, which sets
 * `state = 'gameover'`, so input is already refused without the pause — and
 * both are opened from a setTimeout(600) scheduled by onPuzzleMove(). That
 * deferral is what makes pausing them actively harmful: a puzzle solved on the
 * same move a pre-placed bomb expires runs handleGameOver()'s 1500 ms
 * explosion, and the modal landing 600 ms into it would park the loop and
 * leave the board frozen mid-detonation until the player dismissed it.
 */
export const MODAL_POLICY = {
  'modal-help':          { pause: true },
  'modal-scores':        { pause: true },
  'modal-settings':      { pause: true },
  'modal-end-session':   { pause: true },
  'modal-puzzle-select': { pause: true },
  'modal-puzzle-editor': { pause: true },
  'modal-puzzle-result': { pause: false },
  'modal-puzzle-failed': { pause: false },
  'modal-gameover':      { pause: false },
  'modal-gamewin':       { pause: false },
  'modal-over-achiever': { pause: false },
};

/** @type {string[]} every id the seam knows about — the gate test reads this. */
export const MODAL_IDS = Object.keys(MODAL_POLICY);

// ─── Host ───────────────────────────────────────────────────────
//
// Same shape as frame.js: inert until the owner of the pause flag registers,
// so importing this module in node costs nothing and asserts nothing.

const NOOP_HOST = { pause() {}, resume() {} };
let host = NOOP_HOST;

/**
 * @param {{pause: () => void, resume: () => void}} h — `pause` sets the pause
 *        flag; `resume` is main.js's resumeFromPause() (clear flag, reset
 *        lastTime, wake the loop through the gate).
 */
export function registerModalHost(h) {
  host = {
    pause:  typeof h?.pause  === 'function' ? h.pause  : NOOP_HOST.pause,
    resume: typeof h?.resume === 'function' ? h.resume : NOOP_HOST.resume,
  };
}

/** Test seam: drop the host and forget which modals are open. */
export function resetModalSeam() {
  host = NOOP_HOST;
  openIds.clear();
}

// ─── Open / close ───────────────────────────────────────────────

/** @type {Set<string>} ids currently open, in the seam's own reckoning. */
const openIds = new Set();

function policyFor(id) {
  const policy = MODAL_POLICY[id];
  if (!policy) {
    // A modal the seam does not know about would silently skip the pause, which
    // is the exact failure this module exists to make impossible. Fail loudly
    // and treat it as pausing, the safe default.
    console.error(`modal.js: unknown modal id "${id}" — add it to MODAL_POLICY`);
    return { pause: true };
  }
  return policy;
}

function root(id) {
  return typeof document === 'undefined' ? null : document.getElementById(id);
}

/** True while any *pausing* modal is open — the condition that holds the pause. */
function pauseHeld() {
  for (const id of openIds) {
    if (MODAL_POLICY[id]?.pause !== false) return true;
  }
  return false;
}

/**
 * Show a modal. Pauses the game unless the policy table says otherwise.
 * @param {string} id — a key of MODAL_POLICY.
 */
export function openModal(id) {
  const { pause } = policyFor(id);
  root(id)?.classList.remove('hidden');
  openIds.add(id);
  if (pause) host.pause();
}

/**
 * Hide a modal and come back from it.
 *
 * Safe to call on a modal that is already closed: several paths close
 * defensively (startPuzzle() hides all three puzzle modals on its way in,
 * over whichever one the player actually clicked), and a resume must never
 * depend on which of two close calls happened to run first.
 *
 * The pause is lifted only once no pausing modal is left open, so closing a
 * modal that was never showing cannot unpause the game behind one that is.
 *
 * @param {string} id — a key of MODAL_POLICY.
 */
export function closeModal(id) {
  policyFor(id);
  root(id)?.classList.add('hidden');
  openIds.delete(id);

  // Ghost-click protection: unconditional, because the dismissing click is
  // queued whether or not this particular modal was the one showing.
  clearPendingAction();

  if (!pauseHeld()) host.resume();
}

/** @param {string} id @returns {boolean} */
export function isModalOpen(id) {
  return openIds.has(id);
}

/** @returns {string[]} open modal ids, for tests and debugging. */
export function getOpenModals() {
  return [...openIds];
}
