/**
 * renderer.test.js — that drawing actually reaches the canvas, and that a
 * resize can't leave it blank.
 *
 * The suite covers board/puzzle/specials logic, all of which is pure and none
 * of which touches the renderer — so a game that draws nothing at all still
 * passes every other test, deploys green, and ships a black play area
 * (hecknsic#50). These two tests are the floor under that: one asserts a
 * populated grid produces per-cell draw calls, the other pins the dirty-flag
 * contract that decides whether those calls ever happen.
 *
 * The contract: gameLoop only calls drawFrame when something has marked the
 * renderer dirty. Assigning canvas.width/height — which resize() does on every
 * call — wipes the backing store. So any path that resizes MUST also request a
 * redraw, or an idle board (no tweens, no animations, nothing queued) stays
 * blank until the next input. moon-lit's resize handler calls requestFrame()
 * for exactly this reason; this game's resize() has to do the same itself,
 * because its debounced window listener doesn't.
 */

import assert from 'node:assert';
import test from 'node:test';

const CANVAS_W = 1280;
const CANVAS_H = 720;

/**
 * A 2D context that records every method call and remembers assigned
 * properties. Unknown methods return a recorder rather than throwing, so the
 * test doesn't have to track which of the ~30 canvas calls the draw path uses.
 */
function makeCtx(ops) {
  const props = Object.create(null);
  return new Proxy(Object.create(null), {
    get(_t, prop) {
      if (prop in props) return props[prop];
      if (typeof prop === 'string' && /^create\w*Gradient$/.test(prop)) {
        return () => ({ addColorStop() {} });
      }
      if (prop === 'measureText') return () => ({ width: 10 });
      return (...args) => { ops.push({ op: prop, args }); };
    },
    set(_t, prop, value) { props[prop] = value; return true; },
  });
}

function makeCanvas(ops, w = CANVAS_W, h = CANVAS_H) {
  return {
    width: 0,
    height: 0,
    getContext: () => makeCtx(ops),
    getBoundingClientRect: () => ({ width: w, height: h, top: 0, left: 0 }),
  };
}

/** Minimal window/document the renderer's layout math reads. */
function installDom() {
  const ops = [];
  globalThis.window = {
    devicePixelRatio: 2,
    matchMedia: () => ({ matches: true }),   // desktop branch
    requestAnimationFrame: () => 0,
  };
  globalThis.document = {
    documentElement: { style: { setProperty() {} } },
    getElementById: (id) =>
      id === 'game-hud' ? { getBoundingClientRect: () => ({ height: 60 }) } : null,
    createElement: () => makeCanvas(ops, 0, 0),
  };
  globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;
  return ops;
}

test('resize() leaves the renderer dirty — a settled board repaints after a resize', async () => {
  const ops = installDom();
  const renderer = await import('../js/renderer.js');
  const canvas = makeCanvas(ops);

  renderer.initRenderer(canvas);
  renderer.resize(canvas);

  // Simulate the loop drawing that frame and going quiescent: nothing is
  // tweening, no renderer animations, score settled — drawFrame will not be
  // called again until something marks the renderer dirty.
  renderer.clearDirty();
  assert.strictEqual(renderer.getIsDirty(), false, 'precondition: board is settled');

  // The debounced window-resize handler in main.js calls exactly this.
  renderer.resize(canvas);

  assert.strictEqual(
    renderer.getIsDirty(), true,
    'resize() wiped the canvas backing store without requesting a redraw — ' +
    'an idle board would stay blank until the next input');
});

test('drawFrame() draws every cell of a populated grid', async () => {
  const ops = installDom();
  const renderer = await import('../js/renderer.js');
  const { createGrid } = await import('../js/board.js');
  const { GRID_COLS, GRID_ROWS } = await import('../js/constants.js');

  // initRenderer's ctx is the one drawFrame writes to, so capture ops from it.
  const canvas = makeCanvas(ops);
  renderer.initRenderer(canvas);
  renderer.resize(canvas);
  renderer.setActiveGridSize(GRID_COLS, GRID_ROWS);

  const grid = createGrid();
  const cells = grid.flat().filter(Boolean).length;
  assert.ok(cells > 0, 'precondition: createGrid() produced a populated grid');

  ops.length = 0;
  renderer.drawFrame(grid, null, null);

  const cleared = ops.filter((o) => o.op === 'fillRect');
  assert.ok(cleared.length > 0, 'drawFrame did not clear the canvas');
  assert.ok(
    cleared.some((o) => o.args[2] > 0 && o.args[3] > 0),
    'the clear rect had zero area — canvas dimensions never reached the renderer');

  // One filled hex path per cell, at minimum.
  const fills = ops.filter((o) => o.op === 'fill').length;
  assert.ok(
    fills >= cells,
    `expected at least one fill per cell (${cells}), got ${fills} — ` +
    'the board is not reaching the canvas');
});
