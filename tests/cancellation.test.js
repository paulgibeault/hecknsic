/**
 * cancellation.test.js — a chain whose board is gone stops at its next seam
 * (hecknsic#66).
 *
 * WHAT IS BEING PINNED
 *
 * Every animated move in this game is a chain of awaits that runs for a second
 * or two, and the player can replace the board in the middle of it: restart,
 * mode switch, puzzle load. The chain holds `ctx`, whose `grid` getter reads
 * the machine's CURRENT board — so a chain that keeps going after a
 * replacement does not write to a stale array harmlessly, it writes to the
 * board the player is now looking at.
 *
 * The old defence was `boardGeneration !== gen` copied in after every await,
 * twenty-five times, and two of them were missing (hecknsic#62). It is now one
 * cancellation token per board (js/cancel.js), carried by the chain and
 * cancelled when the board is replaced, with the check inside the awaits
 * themselves.
 *
 * tests/rotation-cancel.test.js pins the individual animators against a
 * hand-built context. These tests come at it from the other end: the real
 * state machine, its real board, and the real board-replacing entry points, so
 * what they exercise is the wiring — that the token minted for a rotation or a
 * cascade is the one the replacement cancels.
 *
 * The harness is the one from tests/game-state.test.js: reducedMotion collapses
 * every tween to zero duration, and pumping updateTweens() by hand plays the
 * part the game loop's rAF callback normally plays. That is what makes
 * "mid-flight" a deterministic moment rather than a race.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installArcade } from './helpers/fake-arcade.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

installArcade({ powerSaver: false, reducedMotion: true });

const store = new Map();
Object.assign(globalThis.Arcade, {
  state: {
    get: (k) => store.get(k),
    set: (k, v) => store.set(k, v),
    remove: (k) => store.delete(k),
    getOrInit: (k, d) => (store.has(k) ? store.get(k) : (store.set(k, d), d)),
    migrate: () => {},
  },
  scores: { add() {}, list: () => [] },
  stats: { update() {} },
  player: { name: () => 'TESTER', setName() {} },
});

// ─── Fake DOM ───────────────────────────────────────────────────

function fakeEl() {
  return {
    textContent: '', value: '', innerHTML: '',
    style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, addEventListener() {}, removeEventListener() {},
    querySelector: () => fakeEl(),
    getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
  };
}

function makeCanvasCtx() {
  const props = Object.create(null);
  return new Proxy(Object.create(null), {
    get(_t, prop) {
      if (prop in props) return props[prop];
      if (typeof prop === 'string' && /^create\w*Gradient$/.test(prop)) {
        return () => ({ addColorStop() {} });
      }
      if (prop === 'measureText') return () => ({ width: 10 });
      return () => {};
    },
    set(_t, prop, value) { props[prop] = value; return true; },
  });
}

function makeCanvas(w = 1280, h = 720) {
  const handlers = new Map();
  return {
    width: 0, height: 0,
    handlers,
    getContext: () => makeCanvasCtx(),
    getBoundingClientRect: () => ({ width: w, height: h, top: 0, left: 0 }),
    addEventListener: (type, fn) => { handlers.set(type, fn); },
  };
}

globalThis.window = {
  devicePixelRatio: 1,
  matchMedia: () => ({ matches: true }),
  requestAnimationFrame: () => 0,
  addEventListener() {},
};
globalThis.document = {
  documentElement: { style: { setProperty() {} } },
  body: { classList: { toggle() {} } },
  getElementById: (id) => (id === 'game-hud'
    ? { getBoundingClientRect: () => ({ height: 60 }) }
    : fakeEl()),
  querySelector: () => fakeEl(),
  querySelectorAll: () => [],
  createElement: () => fakeEl(),
  addEventListener() {},
};
globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;

// ─── Modules under test ─────────────────────────────────────────

const { GRID_COLS, GRID_ROWS } = await import('../js/constants.js');
const { getNeighbors, hexToPixel } = await import('../js/hex-math.js');
const renderer = await import('../js/renderer.js');
const input = await import('../js/input.js');
const { updateTweens } = await import('../js/tween.js');
const { setActiveGameMode } = await import('../js/modes.js');
const cancel = await import('../js/cancel.js');
const gs = await import('../js/game-state.js');

const canvas = makeCanvas();
renderer.initRenderer(canvas);
renderer.resize(canvas);
input.initInput(canvas);

// ─── Harness ────────────────────────────────────────────────────

/** One tick of the game loop's tween pump, plus a macrotask yield so the chain
 *  can run on to whatever it awaits next (including real setTimeout delays). */
let clock = 0;
async function tick(times = 1) {
  for (let i = 0; i < times; i++) {
    updateTweens((clock += 16));
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Run a chain to settlement, or fail loudly if it never settles. */
async function runOut(promise, { maxTicks = 4000 } = {}) {
  let settled = false;
  let error = null;
  const p = promise.then(() => { settled = true; }, (e) => { settled = true; error = e; });
  for (let i = 0; i < maxTicks && !settled; i++) await tick();
  await p;
  if (error) throw error;
  assert.ok(settled, 'the chain never settled — a cancelled chain must not hang');
}

/** Colouring by row mod 3: no hex has a same-coloured pair of neighbours, so
 *  nothing matches anywhere. */
function quietBoard(cols = GRID_COLS, rows = GRID_ROWS) {
  const g = [];
  for (let c = 0; c < cols; c++) {
    g[c] = [];
    for (let r = 0; r < rows; r++) g[c][r] = { colorIndex: r % 3, special: null };
  }
  return g;
}

/** A board that will cascade: six identical neighbours around a different
 *  centre is a starflower, and resolving it clears, drops and refills. */
function starflowerBoard() {
  const g = quietBoard();
  g[4][4] = { colorIndex: 0, special: null };
  for (const n of getNeighbors(4, 4)) g[n.col][n.row] = { colorIndex: 1, special: null };
  return g;
}

const snapshot = (grid) =>
  grid.map((col) => col.map((cell) => (cell ? { ...cell } : null)));

function arm(board, mode = 'chill') {
  setActiveGameMode(mode);
  gs.resetGameStateForTests();
  gs.setGrid(board);
  gs.setState('selected');
  renderer.setActiveGridSize(GRID_COLS, GRID_ROWS);
}

function clickHex(col, row) {
  const { originX, originY } = renderer.getOrigin();
  const p = hexToPixel(col, row, originX, originY);
  const s = renderer.getBoardScale();
  canvas.handlers.get('click')({ clientX: p.x * s, clientY: p.y * s, preventDefault() {} });
}

// ─── The token itself ───────────────────────────────────────────

test('a live token lets work through; a cancelled one throws at every seam', async () => {
  const token = cancel.createCancelToken(7);

  assert.strictEqual(token.cancelled, false);
  token.guard();                                   // must not throw

  // A tween only advances when the loop pumps it, so start it, pump, then
  // await — awaiting first would deadlock, here and in the real game.
  const live = token.tween(10, () => {});
  await tick();
  await live;
  await token.delay(0);

  token.cancel();
  assert.strictEqual(token.cancelled, true);

  assert.throws(() => token.guard(), cancel.Cancelled,
    'guard() is the seam for loop heads, where there is no await to hide in');

  await assert.rejects(token.delay(0), cancel.Cancelled,
    'a sleep that finishes on a board that is gone must not hand control back');

  // The handler is attached before the pump that settles it, which is what
  // every real caller does too — it is sitting in an `await`.
  const tweening = assert.rejects(token.tween(10, () => {}), cancel.Cancelled,
    'the tween seam is the one that replaces the twenty-five hand-written ' +
    'generation comparisons — it has to throw, not resolve');
  await tick();
  await tweening;
});

test('catchCancelled swallows a cancellation and nothing else', async () => {
  const token = cancel.cancelledToken(3);

  assert.strictEqual(await cancel.catchCancelled(token.delay(0)), undefined,
    'a chain stopping because its board was replaced is a normal outcome');

  const boom = new TypeError('a real bug inside an animation');
  await assert.rejects(
    cancel.catchCancelled(Promise.reject(boom)), /a real bug/,
    'anything that is not a Cancelled must still reach the console — an entry ' +
    'point that swallows everything is how a broken animation goes unnoticed');
});

// ─── Rotation: the chain the state machine mints a token for ────

test('a rotation whose board is replaced mid-flight never touches the replacement', async () => {
  arm(quietBoard(), 'chill');
  gs.setState('idle');
  clickHex(4, 4);
  gs.processInput();
  assert.strictEqual(gs.getState(), 'selected', 'precondition: a cluster is selected');

  const running = gs.animateRotation(true);
  await tick();   // one await retired: the rotation is in flight

  // What the player did: loaded a puzzle. loadPuzzleBoard() cancels the
  // outgoing board's token and swaps the grid — and ctx.grid is a getter on
  // the machine's live board, so an uncancelled rotation would commit its
  // three remembered cells onto THIS grid.
  const puzzle = quietBoard(5, 5);
  const before = snapshot(puzzle);
  gs.loadPuzzleBoard(puzzle, 5, 5);

  await runOut(running);

  assert.deepStrictEqual(snapshot(gs.getGrid()), before,
    'the rotation committed to the puzzle board that replaced the one it ' +
    'started on — the player watches a freshly loaded puzzle scramble itself');
  assert.strictEqual(gs.getGrid(), puzzle, 'and the puzzle board is still the board');
  assert.strictEqual(gs.getState(), 'idle',
    'a cancelled rotation must not write the state either: loadPuzzleBoard ' +
    "left the machine 'idle' and the stale chain has no business changing it");
});

// ─── Cascade: the longer chain, several animations deep ─────────

test('a cascade whose board is replaced mid-flight never touches the replacement', async () => {
  arm(starflowerBoard(), 'chill');

  const running = gs.postRotationCheck(gs.getBoardGeneration());
  await tick(3);   // into the starflower animation: flash, shrink, clear

  // What the player did: hit New Game. resetGame() deals a fresh board and
  // cancels the token the cascade is carrying.
  gs.resetGame();
  const fresh = gs.getGrid();
  const before = snapshot(fresh);

  await runOut(running);

  assert.strictEqual(gs.getGrid(), fresh, 'the fresh board is still the board');
  assert.deepStrictEqual(snapshot(fresh), before,
    'the cascade went on clearing, dropping and refilling cells on the board ' +
    'that replaced the one it started on');
  assert.strictEqual(gs.getState(), 'idle',
    "resetGame() left the machine 'idle'; the stale cascade must not put it " +
    "back into 'cascading' or deselect on the new board's behalf");
});

test('a cascade left alone still cascades — the control for both tests above', async () => {
  // Without this, the two tests above could pass because nothing ever runs.
  arm(starflowerBoard(), 'chill');

  await runOut(gs.postRotationCheck(gs.getBoardGeneration()));

  const board = gs.getGrid();
  let starflowers = 0;
  for (let c = 0; c < GRID_COLS; c++) {
    for (let r = 0; r < GRID_ROWS; r++) {
      if (board[c]?.[r]?.special === 'starflower') starflowers++;
    }
  }
  assert.ok(starflowers >= 1,
    'the cascade must actually reach the board when nobody replaces it');
});

// ─── Repo gates ─────────────────────────────────────────────────

/**
 * Strip line and block comments, leaving string literals alone. Both gates
 * below are about code: a comment that names the thing it is describing must
 * not fail the rule it is describing.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      out += c; i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') { out += src[i]; i++; }
        if (i < src.length) { out += src[i]; i++; }
      }
      out += c; i++;
    } else {
      out += c; i++;
    }
  }
  return out;
}

test('animations.js reaches no DOM: no document. / window. outside comments', () => {
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'js', 'animations.js'), 'utf8'));

  for (const token of ['document.', 'window.']) {
    assert.ok(!code.includes(token),
      `js/animations.js must not reference \`${token}\`. It used to write the ` +
      'game-over and over-achiever modals from inside the explosion sequence, ' +
      'which is how the end of a run ended up half-presentation and ' +
      'half-animation, unreachable from a test and impossible to restyle ' +
      'without touching an animation. Presentation goes through ' +
      "game-state.js's host, which main.js registers (hecknsic#66).");
  }
});

test('nothing compares board generations by hand any more', () => {
  const files = fs.readdirSync(path.join(ROOT, 'js')).filter((f) => f.endsWith('.js'));
  const violations = [];

  for (const file of files) {
    const code = stripComments(fs.readFileSync(path.join(ROOT, 'js', file), 'utf8'));
    // The idiom: any equality test against a generation, however it is spelled
    // (`ctx.boardGeneration !== gen`, `gen === boardGeneration`, …).
    const idiom = /(?:\w+\.)?\b(?:boardGeneration|gen)\b\s*(?:!==?|===?)\s*(?:\w+\.)?\b(?:boardGeneration|gen)\b/g;
    for (const m of code.matchAll(idiom)) {
      violations.push(`js/${file}: ${m[0]}`);
    }
  }

  assert.deepStrictEqual(violations, [],
    'cancellation is a mechanism now, not a convention: the board carries a ' +
    'token (js/cancel.js) and the check lives inside the awaits. A ' +
    'hand-written generation comparison is the idiom #66 removed — it worked ' +
    'only for as long as every author remembered it, and two of them did ' +
    'not (#62):\n' + violations.join('\n'));
});
