/**
 * game-state.test.js — the state machine, without a browser (hecknsic#65).
 *
 * The point of WP4 was never the file split; it was that the band every recent
 * regression lived in had no test that could reach it. `idle` → `selected` →
 * `rotating` → `cascading`, the cascade's priority ladder, the bomb rules and
 * the game-over condition were all inside a module whose top level grabbed DOM
 * nodes and booted the game on import, so `node --test` could not load it at
 * all. js/game-state.js has no `document.` and no `window.` in it (the last
 * test in this file is the gate on that), which is what makes everything below
 * possible.
 *
 * WHAT THE HARNESS FAKES, AND WHY THAT IS HONEST
 *
 * The module under test is real, and so is everything it calls: board.js,
 * specials.js, animations.js, score.js. Only the edges are stubbed — the
 * launcher SDK, the canvas, and the document — and none of them carry game
 * rules. In particular the animations are the real ones: `reducedMotion: true`
 * collapses every tween to zero duration (js/tween.js), and pump() below plays
 * the part the game loop normally plays by calling updateTweens(). That is the
 * same trick tests/rotation-cancel.test.js uses.
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installArcade } from './helpers/fake-arcade.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ─── Fake launcher SDK ──────────────────────────────────────────
//
// installArcade covers the settings surface; modes.js and storage.js also read
// Arcade.state / .scores / .stats / .player. Deliberately NOT providing
// Arcade.audio: js/audio.js feature-detects it and registers nothing without
// it, so every play*() call in the machine is a documented no-op here.

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
//
// Permissive on purpose. animations.js still writes the end-of-run modals
// directly (moving that out is hecknsic#66), so handleGameOver() reaches for
// `document.querySelector('#modal-gameover h2').style.color`. Returning a
// live-ish element for every lookup keeps that path from throwing without
// asserting anything about it.

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

const canvasOps = [];
function makeCtx() {
  const props = Object.create(null);
  return new Proxy(Object.create(null), {
    get(_t, prop) {
      if (prop in props) return props[prop];
      if (typeof prop === 'string' && /^create\w*Gradient$/.test(prop)) {
        return () => ({ addColorStop() {} });
      }
      if (prop === 'measureText') return () => ({ width: 10 });
      return (...args) => { canvasOps.push({ op: prop, args }); };
    },
    set(_t, prop, value) { props[prop] = value; return true; },
  });
}

function makeCanvas(w = 1280, h = 720) {
  const handlers = new Map();
  return {
    width: 0, height: 0,
    handlers,
    getContext: () => makeCtx(),
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

const { GRID_COLS, GRID_ROWS, BOMB_INITIAL_TIMER } = await import('../js/constants.js');
const { findMatchesForMode } = await import('../js/board.js');
const { getNeighbors, hexToPixel } = await import('../js/hex-math.js');
const renderer = await import('../js/renderer.js');
const input = await import('../js/input.js');
const { updateTweens } = await import('../js/tween.js');
const { setActiveGameMode } = await import('../js/modes.js');
const gs = await import('../js/game-state.js');

const canvas = makeCanvas();
renderer.initRenderer(canvas);
// resize() is what computes the grid origin and the board scale; without it
// getOrigin() is {undefined, undefined} and every pixel→hex lookup is NaN.
renderer.resize(canvas);
input.initInput(canvas);

// ─── Harness helpers ────────────────────────────────────────────

/**
 * Play the game loop's part for one async chain.
 *
 * Tweens only advance when updateTweens() is called, which in the real game is
 * the rAF callback. reducedMotion makes each tween zero-duration, so one pump
 * tick retires one await; the setTimeout(0) yield is what lets animations.js's
 * `delay(100)` (a real timer) fire between cascade steps.
 */
async function pump(promise, { maxTicks = 4000 } = {}) {
  let settled = false;
  let error = null;
  const p = promise.then(() => { settled = true; }, (e) => { settled = true; error = e; });
  let t = 0;
  for (let i = 0; i < maxTicks && !settled; i++) {
    updateTweens((t += 16));
    await new Promise((r) => setTimeout(r, 0));
  }
  await p;
  if (error) throw error;
  assert.ok(settled, 'chain did not settle within the pump budget');
}

/** A board with no matches and no special formations anywhere on it.
 *  Colouring by row mod 3: every hex neighbour sits on an adjacent row, so no
 *  monochrome triangle can form. The `stable` precondition test below proves it
 *  rather than trusting it. */
function quietBoard(cols = GRID_COLS, rows = GRID_ROWS) {
  const g = [];
  for (let c = 0; c < cols; c++) {
    g[c] = [];
    for (let r = 0; r < rows; r++) g[c][r] = { colorIndex: r % 3, special: null };
  }
  return g;
}

/** A board with exactly one monochrome triangle on an otherwise quiet field. */
function boardWithOneMatch() {
  const g = quietBoard();
  // (4,4) and two mutually-adjacent neighbours of it.
  const [a, b] = getNeighbors(4, 4);
  const color = g[4][4].colorIndex;
  g[a.col][a.row] = { colorIndex: color, special: null };
  g[b.col][b.row] = { colorIndex: color, special: null };
  return g;
}

/** Put the machine in a known state on a given board, in `mode`. */
function arm(board, mode = 'arcade', { moveCount = 0 } = {}) {
  setActiveGameMode(mode);
  gs.resetGameStateForTests();
  gs.setGrid(board);
  gs.setMoveCount(moveCount);
  gs.setState('selected');
  renderer.setActiveGridSize(GRID_COLS, GRID_ROWS);
}

/** Click the canvas at a hex's centre and let the machine answer it. */
function clickHex(col, row) {
  const { originX, originY } = renderer.getOrigin();
  const p = hexToPixel(col, row, originX, originY);
  const s = renderer.getBoardScale();
  canvas.handlers.get('click')({
    clientX: p.x * s, clientY: p.y * s, preventDefault() {},
  });
}

// ─── Preconditions ──────────────────────────────────────────────

test('harness: the quiet board really is quiet', () => {
  const g = quietBoard();
  assert.strictEqual(findMatchesForMode(g, GRID_COLS, GRID_ROWS).size, 0);
  assert.strictEqual(gs.nextResolution(g, GRID_COLS, GRID_ROWS).kind, 'stable');
});

test('harness: the one-match board has a match and nothing above it on the ladder', () => {
  const g = boardWithOneMatch();
  assert.ok(findMatchesForMode(g, GRID_COLS, GRID_ROWS).size >= 3);
  assert.strictEqual(gs.nextResolution(g, GRID_COLS, GRID_ROWS).kind, 'match');
});

test('nothingLeftToDo refuses to park while the board is mid-animation', () => {
  input.clearPendingAction();
  renderer.clearDirty();
  gs.setState('idle');
  assert.strictEqual(gs.nothingLeftToDo(), true, 'settled board: the loop may park');

  gs.setState('cascading');
  assert.strictEqual(gs.nothingLeftToDo(), false,
    'a cascade awaits between tweens, so there are frames with nothing dirty — ' +
    'parking there would strand the chain on a stopped loop');

  gs.setState('idle');
  input.triggerAction('rotateCW');
  assert.strictEqual(gs.nothingLeftToDo(), false, 'a queued gesture still needs answering');
  input.clearPendingAction();
  renderer.clearDirty();
});

// ─── Selection transitions ──────────────────────────────────────

test('idle + click on a plain hex → selected, with a 3-hex cluster', async () => {
  arm(quietBoard());
  gs.setState('idle');
  clickHex(4, 4);
  gs.processInput();

  assert.strictEqual(gs.getState(), 'selected');
  const cluster = gs.getSelectedCluster();
  assert.strictEqual(cluster.length, 3);
  assert.ok(cluster.some((h) => h.col === 4 && h.row === 4),
    'the clicked hex is part of the selected cluster');
  assert.strictEqual(gs.getFlowerCenter(), null);
  assert.strictEqual(gs.getPearlCenter(), null);
});

test('clicking the same cluster again deselects', async () => {
  arm(quietBoard());
  gs.setState('idle');
  clickHex(4, 4);
  gs.processInput();
  const first = gs.getSelectedCluster();
  assert.ok(first);

  // Same pixel → same cluster → deselect.
  clickHex(4, 4);
  gs.processInput();
  assert.strictEqual(gs.getState(), 'idle');
  assert.strictEqual(gs.getSelectedCluster(), null);
});

test('clicking a different cluster stays selected and swaps the selection', async () => {
  arm(quietBoard());
  gs.setState('idle');
  clickHex(4, 4);
  gs.processInput();
  const first = gs.getSelectedCluster();

  clickHex(1, 1);
  gs.processInput();
  assert.strictEqual(gs.getState(), 'selected');
  assert.ok(!gs.clustersMatch(gs.getSelectedCluster(), first),
    'a click on a different cluster replaces the selection rather than clearing it');
});

test('clicking a starflower selects the whole ring; clicking a black pearl selects the Y', async () => {
  const g = quietBoard();
  g[4][4] = { colorIndex: -1, special: 'starflower' };
  arm(g);
  gs.setState('idle');
  clickHex(4, 4);
  gs.processInput();

  assert.strictEqual(gs.getState(), 'selected');
  assert.deepStrictEqual(gs.getFlowerCenter(), { col: 4, row: 4 });
  assert.strictEqual(gs.getPearlCenter(), null);
  assert.strictEqual(gs.getSelectedCluster().length, 7, 'centre + 6 ring hexes');

  const g2 = quietBoard();
  g2[4][4] = { colorIndex: -2, special: 'blackpearl' };
  arm(g2);
  gs.setState('idle');
  clickHex(4, 4);
  gs.processInput();

  assert.strictEqual(gs.getState(), 'selected');
  assert.deepStrictEqual(gs.getPearlCenter(), { col: 4, row: 4 });
  assert.strictEqual(gs.getFlowerCenter(), null);
  assert.strictEqual(gs.getSelectedCluster().length, 4, 'centre + 3 alternating hexes');
});

test("'rotating' and 'cascading' do not consume the queued gesture", () => {
  arm(quietBoard());
  for (const busy of ['rotating', 'cascading']) {
    gs.setState(busy);
    input.triggerAction('rotateCW');
    gs.processInput();
    assert.ok(input.hasPendingAction(),
      `${busy} must leave the gesture queued for the frame after it settles`);
    assert.strictEqual(gs.getState(), busy);
  }
  input.clearPendingAction();
});

// ─── Rotation outcome: retain vs. deselect ──────────────────────

test('a rotation that produces nothing retains the selection', async () => {
  arm(quietBoard());
  gs.setState('idle');
  clickHex(4, 4);
  gs.processInput();
  const cluster = gs.getSelectedCluster();
  assert.ok(cluster, 'precondition: something is selected');

  await pump(gs.postRotationCheck(gs.getBoardGeneration()));

  assert.strictEqual(gs.getState(), 'selected',
    'nothing cleared, so the player keeps the cluster and can turn it again');
  assert.ok(gs.clustersMatch(gs.getSelectedCluster(), cluster));
});

test('a rotation that produces a match deselects and returns to idle', async () => {
  arm(boardWithOneMatch());
  gs.setState('idle');
  clickHex(0, 0);
  gs.processInput();
  assert.ok(gs.getSelectedCluster(), 'precondition: something is selected');

  await pump(gs.postRotationCheck(gs.getBoardGeneration()));

  assert.strictEqual(gs.getState(), 'idle');
  assert.strictEqual(gs.getSelectedCluster(), null);
  assert.strictEqual(gs.getFlowerCenter(), null);
  assert.strictEqual(gs.getPearlCenter(), null);
});

// ─── Cascade resolution ordering ────────────────────────────────
//
// The ladder is poobah ring > poobah > pearl > starflower > match, and the
// order is load-bearing rather than arbitrary: the formations are built out of
// each other, so resolving a plain match first would clear the tiles a larger
// formation is standing on.

/** Neighbours of (4,4). */
const RING = getNeighbors(4, 4);

function ringOf(special, colorIndex) {
  const g = boardWithOneMatch();   // a plain match is present throughout
  for (const n of RING) g[n.col][n.row] = { colorIndex, special };
  return g;
}

test('ordering: a Grand Poobah ring outranks everything below it', () => {
  const g = ringOf('grandpoobah', -3);
  assert.strictEqual(gs.nextResolution(g, GRID_COLS, GRID_ROWS).kind, 'poobah-ring');
});

test('ordering: Grand Poobahs outrank pearls, starflowers and matches', () => {
  const g = ringOf('blackpearl', -2);
  // The pearl ring is simultaneously a black-pearl formation's worth of
  // specials and a plain-match board; the poobah must win.
  assert.strictEqual(gs.nextResolution(g, GRID_COLS, GRID_ROWS).kind, 'grandpoobah');
});

test('ordering: black pearls outrank starflowers and matches', () => {
  const g = ringOf('starflower', -1);
  assert.strictEqual(gs.nextResolution(g, GRID_COLS, GRID_ROWS).kind, 'blackpearl');
});

test('ordering: starflowers outrank plain matches', () => {
  const g = boardWithOneMatch();
  // Six identical neighbours around a differently-coloured centre.
  g[4][4] = { colorIndex: 0, special: null };
  for (const n of RING) g[n.col][n.row] = { colorIndex: 1, special: null };
  assert.strictEqual(gs.nextResolution(g, GRID_COLS, GRID_ROWS).kind, 'starflower');
});

test('ordering: a plain match is the last rung, and a quiet board is stable', () => {
  assert.strictEqual(gs.nextResolution(boardWithOneMatch(), GRID_COLS, GRID_ROWS).kind, 'match');
  assert.strictEqual(gs.nextResolution(quietBoard(), GRID_COLS, GRID_ROWS).kind, 'stable');
});

test('the over-achiever ring ends the run without cascading', async () => {
  arm(ringOf('grandpoobah', -3));
  await pump(gs.postRotationCheck(gs.getBoardGeneration()));
  assert.strictEqual(gs.getState(), 'gameover',
    'the poobah-ring branch returns straight out of postRotationCheck');
});

test('a cascade actually runs the ladder: a starflower board ends up holding one', async () => {
  const g = quietBoard();
  g[4][4] = { colorIndex: 0, special: null };
  for (const n of RING) g[n.col][n.row] = { colorIndex: 1, special: null };
  arm(g, 'chill');   // chill has no bombs and no game-over to interfere

  await pump(gs.postRotationCheck(gs.getBoardGeneration()));

  const board = gs.getGrid();
  let starflowers = 0;
  for (let c = 0; c < GRID_COLS; c++) {
    for (let r = 0; r < GRID_ROWS; r++) {
      if (board[c]?.[r]?.special === 'starflower') starflowers++;
    }
  }
  assert.ok(starflowers >= 1, 'the starflower rung created a starflower on the board');
  assert.strictEqual(gs.getState(), 'idle', 'something cleared, so the selection is dropped');
});

// ─── Bomb rules, gated by the mode flags ────────────────────────
//
// modes.js: arcade { hasBombs: true, ticksBombs: true }, chill { both false },
// puzzle { ticksBombs: true, hasBombs: false } — puzzles use pre-placed bombs
// and must never grow new ones.

function boardWithBomb(timer) {
  const g = quietBoard();
  g[0][0] = { colorIndex: 0, special: 'bomb', bombTimer: timer };
  return g;
}

test('arcade ticks the fuse on every move', async () => {
  arm(boardWithBomb(5), 'arcade');
  await pump(gs.postRotationCheck(gs.getBoardGeneration()));
  assert.strictEqual(gs.getGrid()[0][0].bombTimer, 4);
});

test('puzzle ticks the fuse too — pre-placed bombs are the puzzle', async () => {
  arm(boardWithBomb(5), 'puzzle');
  await pump(gs.postRotationCheck(gs.getBoardGeneration()));
  assert.strictEqual(gs.getGrid()[0][0].bombTimer, 4);
});

test('chill never ticks a fuse', async () => {
  arm(boardWithBomb(5), 'chill');
  await pump(gs.postRotationCheck(gs.getBoardGeneration()));
  assert.strictEqual(gs.getGrid()[0][0].bombTimer, 5);
});

test('arcade queues a new bomb on the spawn interval; puzzle and chill never do', async () => {
  // dynamicInterval is 15 at score 0, so the 15th move is a spawn move.
  arm(quietBoard(), 'arcade', { moveCount: 14 });
  await pump(gs.postRotationCheck(gs.getBoardGeneration()));
  assert.strictEqual(gs.getBombQueued(), true, 'arcade hasBombs → a bomb is queued');

  arm(quietBoard(), 'puzzle', { moveCount: 14 });
  await pump(gs.postRotationCheck(gs.getBoardGeneration()));
  assert.strictEqual(gs.getBombQueued(), false,
    'puzzle ticksBombs but does NOT hasBombs — pre-placed only');

  arm(quietBoard(), 'chill', { moveCount: 14 });
  await pump(gs.postRotationCheck(gs.getBoardGeneration()));
  assert.strictEqual(gs.getBombQueued(), false, 'chill has neither flag');
});

test('an arcade move that is not on the interval queues nothing', async () => {
  arm(quietBoard(), 'arcade', { moveCount: 0 });
  await pump(gs.postRotationCheck(gs.getBoardGeneration()));
  assert.strictEqual(gs.getBombQueued(), false);
});

// ─── Game over ──────────────────────────────────────────────────

test('an expired bomb ends the game in arcade', async () => {
  arm(boardWithBomb(1), 'arcade');
  await pump(gs.postRotationCheck(gs.getBoardGeneration()));
  assert.strictEqual(gs.getGrid()[0][0], null,
    'handleGameOver blew the board apart, so the cells are cleared');
  assert.strictEqual(gs.getState(), 'gameover');
});

test('an expired bomb ends the game in puzzle mode too (hasGameOver)', async () => {
  arm(boardWithBomb(1), 'puzzle');
  await pump(gs.postRotationCheck(gs.getBoardGeneration()));
  assert.strictEqual(gs.getState(), 'gameover');
});

test('a live fuse does not end the game', async () => {
  arm(boardWithBomb(5), 'arcade');
  await pump(gs.postRotationCheck(gs.getBoardGeneration()));
  assert.strictEqual(gs.getState(), 'selected', 'nothing cleared, selection retained');
});

// ─── Bomb urgency ───────────────────────────────────────────────

test('bombUrgency reads the shortest live fuse, and is 0 on a clear board', () => {
  arm(quietBoard(), 'arcade');
  assert.strictEqual(gs.bombUrgency(), 0);

  const g = quietBoard();
  g[0][0] = { colorIndex: 0, special: 'bomb', bombTimer: BOMB_INITIAL_TIMER + 1 };
  g[1][0] = { colorIndex: 0, special: 'bomb', bombTimer: 1 };
  arm(g, 'arcade');
  assert.strictEqual(gs.bombUrgency(), 1, 'the fuse about to end the game is the one that counts');
});

// ─── Board lifetime ─────────────────────────────────────────────

test('resetGame deals a fresh board, bumps the generation and clears the selection', () => {
  arm(boardWithOneMatch(), 'arcade', { moveCount: 7 });
  gs.setBombQueued(true);
  const before = gs.getBoardGeneration();

  gs.resetGame();

  assert.strictEqual(gs.getBoardGeneration(), before + 1,
    'the bump is what makes an in-flight rotation bail out at its next check');
  assert.strictEqual(gs.getState(), 'idle');
  assert.strictEqual(gs.getMoveCount(), 0);
  assert.strictEqual(gs.getBombQueued(), false);
  assert.strictEqual(gs.getSelectedCluster(), null);
  assert.strictEqual(gs.getActiveCols(), GRID_COLS);
  assert.strictEqual(gs.getActiveRows(), GRID_ROWS);
});

test('loadPuzzleBoard adopts the puzzle grid, its size, and the puzzle mode', () => {
  arm(quietBoard(), 'arcade', { moveCount: 3 });
  const before = gs.getBoardGeneration();
  const puzzle = quietBoard(5, 5);

  gs.loadPuzzleBoard(puzzle, 5, 5);

  assert.strictEqual(gs.getBoardGeneration(), before + 1);
  assert.strictEqual(gs.getGrid(), puzzle);
  assert.strictEqual(gs.getActiveCols(), 5);
  assert.strictEqual(gs.getActiveRows(), 5);
  assert.strictEqual(gs.getMoveCount(), 0);
  assert.strictEqual(gs.getState(), 'idle');

  renderer.setActiveGridSize(GRID_COLS, GRID_ROWS);   // put the renderer back
});

test('resumeFromPause clears the pause and resets the host frame clock', () => {
  let frameClockResets = 0;
  gs.registerGameStateHost({ resetFrameClock: () => { frameClockResets++; } });
  gs.setPaused(true);
  assert.strictEqual(gs.isGamePaused(), true);

  gs.resumeFromPause();

  assert.strictEqual(gs.isGamePaused(), false);
  assert.strictEqual(frameClockResets, 1,
    'a modal that was open for a minute must not hand the score counter a 60s delta');
  gs.registerGameStateHost({});
});

test('isProcessing is true exactly in the two animating states', () => {
  for (const s of ['rotating', 'cascading']) {
    gs.setState(s);
    assert.strictEqual(gs.isProcessing(), true, s);
  }
  for (const s of ['idle', 'selected', 'gameover']) {
    gs.setState(s);
    assert.strictEqual(gs.isProcessing(), false, s);
  }
});

// ─── Repo gate ──────────────────────────────────────────────────

test('game-state.js reaches no DOM: no document. / window. outside comments', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'game-state.js'), 'utf8');
  const code = stripComments(src);

  for (const token of ['document.', 'window.']) {
    assert.ok(!code.includes(token),
      `js/game-state.js must not reference \`${token}\` — the whole point of the ` +
      `module is that it runs under node. UI effects go through the host ` +
      `(registerGameStateHost) or through a node-safe seam like js/modal.js.`);
  }
});

/**
 * Strip line and block comments, leaving string literals alone.
 *
 * The gate has to ignore comments or the module's own header — which says in
 * so many words that it contains no `document.` — would fail it. Regex
 * literals are not tracked; game-state.js has none, and a future one would
 * only ever cause a false *pass*, never a false failure.
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
