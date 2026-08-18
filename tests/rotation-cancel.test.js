/**
 * rotation-cancel.test.js — a rotation that outlives its board must be a no-op.
 *
 * A rotation step is three awaited tweens long (~300 ms), and a cascade chains
 * several of them. Anything that replaces the board in that window — a mode
 * switch, a puzzle load, a restart — leaves an animation running with a stale
 * `ctx.grid` reference. Before hecknsic#62 the animators committed their
 * rotation unconditionally when the tweens finished, so the three cells they
 * had picked out of the *old* board were scrambled on the *new* one, and the
 * trailing clearAllOverrides() wiped whatever the new board had just set.
 *
 * The entry-point guards (isProcessing() on the mode switch and the puzzle
 * start paths) close the common door; these tests pin the backstop, which is
 * what makes a door someone forgets to close harmless.
 *
 * The backstop changed shape in hecknsic#66 and these tests changed with it.
 * It used to be a generation number the animator compared by hand after its
 * last await; it is now the board's cancellation token (js/cancel.js), which
 * the animator awaits *through*, so replacing the board throws Cancelled out
 * of whichever tween is in flight. The thing being pinned is the same and the
 * assertions below are unchanged: whatever the mechanism, a rotation must not
 * commit to a board that replaced the one it started on. What the mid-flight
 * swap does is now `token.cancel()` instead of `ctx.boardGeneration = 2` —
 * that is what the state machine itself does on a restart, mode switch or
 * puzzle load.
 *
 * Tweens normally advance from the game loop's rAF callback. There is no loop
 * here, so the pump below calls updateTweens() directly; reducedMotion makes
 * every tween zero-duration, so one pump call retires one await.
 */
import test from 'node:test';
import assert from 'node:assert';
import { installArcade } from './helpers/fake-arcade.mjs';

installArcade({ powerSaver: false, reducedMotion: true });

globalThis.window = {
  devicePixelRatio: 1,
  matchMedia: () => ({ matches: true }),
  requestAnimationFrame: () => 0,
};
globalThis.document = {
  documentElement: { style: { setProperty() {} } },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} } }),
};
globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;

const { animateClusterRotation, animateRingRotation, animateYRotation } =
  await import('../js/animations.js');
const { updateTweens } = await import('../js/tween.js');
const { createCancelToken, isCancelled } = await import('../js/cancel.js');

/**
 * Hand-cranked tween clock. `step()` retires exactly one await of the
 * animation under test and then yields a macrotask so the animator can run on
 * to its next tween; `runOut()` finishes whatever is left. Stepping is what
 * makes the mid-flight moment deterministic — a timer racing the animation
 * lands after it has already committed about as often as not.
 */
function makeClock() {
  let now = 0;
  const tick = () => updateTweens(now += 1000);
  return {
    async step() { tick(); await new Promise(r => setTimeout(r, 0)); },
    runOut(promise) {
      const id = setInterval(tick, 1);
      return promise.finally(() => clearInterval(id));
    },
  };
}

/** A grid whose every cell carries a unique colorIndex, so any swap shows up. */
function makeGrid(cols, rows, base) {
  const grid = [];
  for (let c = 0; c < cols; c++) {
    grid[c] = [];
    for (let r = 0; r < rows; r++) {
      grid[c][r] = { colorIndex: base + c * rows + r, special: null };
    }
  }
  return grid;
}

const snapshot = (grid) =>
  grid.map(col => col.map(cell => (cell ? { ...cell } : null)));

/** The slice of getAnimationContext() the rotation animators read. */
function makeCtx(grid) {
  return {
    grid,
    activeCols: grid.length,
    activeRows: grid[0].length,
    token: createCancelToken(1),
    selectedCluster: [
      { col: 2, row: 2 }, { col: 3, row: 2 }, { col: 2, row: 3 },
    ],
    flowerCenter: { col: 3, row: 3 },
    pearlCenter: { col: 3, row: 3 },
  };
}

/**
 * Run one animator, swapping the board out from under it after the first
 * await — exactly what switchGameMode()/startPuzzle() do to a live rotation.
 * Returns the replacement board and the snapshot it had before the swap.
 */
async function rotateWithBoardReplacedMidFlight(animate) {
  const oldGrid = makeGrid(7, 7, 0);
  const ctx = makeCtx(oldGrid);
  const clock = makeClock();

  const running = animate(ctx, true, 0, 0);

  // One await retired: the animator has read its cells off the old board and
  // is parked on its next tween, with the rest of the rotation still ahead.
  await clock.step();

  // What switchGameMode()/startPuzzle()/resetGame() do at this moment: the
  // outgoing board's token is cancelled and the grid is replaced.
  const newGrid = makeGrid(7, 7, 100);
  const before = snapshot(newGrid);
  ctx.grid = newGrid;
  ctx.token.cancel();

  // The animator unwinds with Cancelled rather than returning, which is the
  // point of the token: a `return` only ends the function that wrote it, so
  // every caller up the stack needed its own check and two of them were
  // missing (hecknsic#62). Anything else thrown here is a real failure and is
  // re-raised.
  let cancelled = false;
  await clock.runOut(running).catch((err) => {
    if (!isCancelled(err)) throw err;
    cancelled = true;
  });

  return { newGrid, before, oldGrid, cancelled };
}

for (const [name, animate] of [
  ['animateClusterRotation', animateClusterRotation],
  ['animateRingRotation', animateRingRotation],
  ['animateYRotation', animateYRotation],
]) {
  test(`${name} does not touch a board that replaced its own`, async () => {
    const { newGrid, before, cancelled } = await rotateWithBoardReplacedMidFlight(animate);

    assert.deepStrictEqual(
      snapshot(newGrid), before,
      `${name} committed its rotation to the board that replaced the one it ` +
      'started on — the player sees three cells of a fresh game scrambled');

    assert.strictEqual(cancelled, true,
      `${name} ran to completion on a cancelled board. It must unwind with ` +
      'Cancelled, so that everything awaiting it stops too rather than each ' +
      'caller having to remember a check of its own');
  });
}

test('the harness really does reach the mutation when the board survives', async () => {
  // Without this control the tests above could pass because the animation
  // never got as far as rotating anything.
  const grid = makeGrid(7, 7, 0);
  const ctx = makeCtx(grid);
  const before = snapshot(grid);

  const clock = makeClock();
  const running = animateClusterRotation(ctx, true, 0, 0);
  await clock.step();
  await clock.runOut(running);

  assert.notDeepStrictEqual(
    snapshot(grid), before,
    'a rotation on a board that was never replaced must still commit');
});
