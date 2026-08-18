/**
 * cancel.js — the mechanism that stops an async chain whose board is gone.
 *
 * WHAT THIS REPLACES
 *
 * The game's animations are long chains of awaited tweens: a rotation step is
 * three of them, a cascade several more, and the whole thing runs for a second
 * or two while the player can still restart, switch mode or load a puzzle.
 * Anything that replaces the board in that window leaves a chain running with
 * a stale grid reference, and if it commits, the player watches three cells of
 * a brand-new board scramble themselves.
 *
 * The old defence was an integer — `boardGeneration`, bumped on every board
 * replacement, captured at the top of each chain and compared after every
 * await: `if (ctx.boardGeneration !== gen) return;`, twenty-five times across
 * two modules. That is not a mechanism, it is a convention, and its failure
 * mode is silence: forget one and nothing breaks until the day a player
 * switches mode mid-rotation. Two of them were in fact missing (hecknsic#62).
 *
 * WHAT IT IS INSTEAD
 *
 * One token per board lifetime. Replacing the board cancels the outgoing
 * token, and every chain that started on that board carries it. The check
 * lives inside the things a chain already has to await:
 *
 *     await token.tween(300, t => …);   // instead of tween(…).promise
 *     await token.delay(100);
 *     token.guard();                    // loop heads, where nothing is awaited
 *
 * Each of those throws Cancelled the moment its board is gone, so the chain
 * unwinds from wherever it happened to be, and the entry point that started it
 * swallows that one error with catchCancelled(). A missed check is no longer
 * possible to write: the check is not a line anyone types, it is the await.
 *
 * The throw is what makes the seams composable — a `return` only ends the
 * function that wrote it, so the old idiom needed a fresh comparison in every
 * caller up the stack, and that is exactly where they went missing.
 *
 * CLEANUP still belongs to the code that allocated something. A chain that
 * throws mid-flight skips whatever came after it, so anything that must happen
 * either way — removing floating pieces, in practice — goes in a `finally`.
 */

import { tween } from './tween.js';

/**
 * The unwind signal. Deliberately its own class: catchCancelled() must swallow
 * this and nothing else, so a genuine bug thrown from inside an animation
 * still reaches the console.
 */
export class Cancelled extends Error {
  constructor(id) {
    super(`board ${id} was replaced mid-animation`);
    this.name = 'Cancelled';
    this.boardId = id;
  }
}

/** @param {unknown} err @returns {boolean} */
export function isCancelled(err) {
  return err instanceof Cancelled;
}

/**
 * Mint a token for a board.
 *
 * @param {number} [id] — the board's generation number. Carried only so the
 *        machine can still answer "which board is this?" for the save keys,
 *        the debug hook and the tests; cancellation itself never looks at it.
 */
export function createCancelToken(id = 0) {
  let cancelled = false;

  const token = {
    id,

    /** @returns {boolean} */
    get cancelled() { return cancelled; },

    /** The board this token belongs to has been replaced. Idempotent. */
    cancel() { cancelled = true; },

    /** Throw if the board is gone. For loop heads and any other point that
     *  resumes work without having awaited one of the seams below. */
    guard() {
      if (cancelled) throw new Cancelled(id);
    },

    /**
     * Run a tween to completion, then guard. The one-line replacement for
     * `await tween(…).promise; if (ctx.boardGeneration !== gen) return;`.
     *
     * Same arguments as js/tween.js's tween(); the handle is not returned
     * because a caller that wants to cancel a tween early wants tween()
     * itself, not this.
     */
    async tween(durationMs, onUpdate, easing) {
      await tween(durationMs, onUpdate, easing).promise;
      token.guard();
    },

    /** Sleep, then guard. A real timer, not a tween: it keeps running while
     *  the frame loop is parked, which is what the pauses between cascade
     *  steps are made of. */
    async delay(ms) {
      await new Promise(resolve => setTimeout(resolve, ms));
      token.guard();
    },
  };

  return token;
}

/** @param {unknown} value @returns {boolean} — is this a token and not, say,
 *  a bare generation number from an older call site? */
export function isCancelToken(value) {
  return !!value
    && typeof value.guard === 'function'
    && typeof value.cancel === 'function';
}

/** A token that was born cancelled. What a caller naming a board that no
 *  longer exists gets: the chain stops at its first seam. */
export function cancelledToken(id = -1) {
  const token = createCancelToken(id);
  token.cancel();
  return token;
}

/**
 * The entry-point half of the mechanism: run a chain and swallow its own
 * cancellation, which is a normal outcome and not an error. Everything else
 * propagates.
 *
 * @template T @param {Promise<T>} promise @returns {Promise<T|undefined>}
 */
export function catchCancelled(promise) {
  return promise.catch(err => {
    if (isCancelled(err)) return undefined;
    throw err;
  });
}
