/**
 * game-state.js — the state machine, extracted from main.js so it can be run
 * without a browser (hecknsic#65).
 *
 * States:
 *   'idle'       – waiting for player to select a cluster
 *   'selected'   – cluster selected, waiting for rotation or confirm
 *   'rotating'   – pop-thunk rotation animation in progress
 *   'cascading'  – match → flash → remove → gravity → refill → recheck
 *   'gameover'   – input refused, board frozen behind an end-of-run modal
 *
 * WHY THIS MODULE EXISTS
 *
 * main.js was a 1,264-line script whose top level grabbed DOM nodes, installed
 * listeners and booted the game on import, so nothing in it could be imported
 * under `node --test`. The pure modules (board, specials, puzzles, daily) were
 * well covered; the state machine — the band every recent regression lived in
 * (#55 double-speed loop, #57 modal-close freeze, the parked-loop rotate
 * buttons) — had zero coverage, because reaching it meant booting a browser.
 *
 * THE BOUNDARY
 *
 * This module contains no `document.` and no `window.` (tests/game-state.test.js
 * holds that as a repo gate). It reaches the outside world three ways:
 *
 *   1. Imports of modules that are themselves node-safe by design — modal.js
 *      and frame.js are inert-until-registered seams built for exactly this
 *      (see their headers), and renderer/input/audio/score/storage/animations
 *      all already load under `node --test` today.
 *   2. `getAnimationContext()`, the object animations.js reads and writes the
 *      board through. Its shape is deliberately unchanged by the extraction —
 *      narrowing it is hecknsic#66.
 *   3. The host, below: the handful of effects that belong to main.js's own
 *      DOM and to main.js's own frame clock. Same pattern as
 *      `registerModalHost` / `registerFrameLoop`, and for the same reason —
 *      the module has to stay importable with nothing registered at all.
 *
 * IMPORT DIRECTION — one way, deliberately. main.js → game-state.js →
 * {animations, puzzle-mode, renderer, input, audio, …}. Nothing below imports
 * game-state.js back: animations.js is handed the context, puzzle-mode.js has
 * its callbacks registered into it. animations.js already imports
 * puzzle-mode.js, so a back-edge from either would close a cycle through this
 * module — one that ESM's live bindings would let pass in node and break in
 * the browser. Keep the arrow pointing one way.
 */

import { GRID_COLS, GRID_ROWS, BOMB_INITIAL_TIMER } from './constants.js';
import { createGrid, findMatchesForMode } from './board.js';
import {
  getIsDirty, hasActiveRendererAnimations, requestRedraw,
  setActiveGridSize, clearAllOverrides, getOrigin,
  setCellOverride, clearCellOverride,
} from './renderer.js';
import {
  getActiveGameMode, getActiveGameModeId, getCombinedModeId, setActiveGameMode,
} from './modes.js';
import { hexToPixel, getNeighbors, pixelToHex, findClusterAtPixel } from './hex-math.js';
import {
  hasPendingAction, consumeAction, getLastClickPos, setClusterCenterPx,
} from './input.js';
import { wakeFrameLoop } from './frame.js';
import { closeModal } from './modal.js';
import {
  animateClusterRotation, animateRingRotation, animateYRotation,
  animateBlackPearlCreation, animateGrandPoobahCreation, animateStarflowerCreation,
  handleOverAchiever, handleGameOver, runCascade, delay,
} from './animations.js';
import { tween, hasActiveTweens, linear } from './tween.js';
import {
  resetScore, restoreScore, advanceChain, resetChain,
  getScore, getDisplayScore, getChainLevel, getComboCount, getMaxCombo,
  isScoreAnimating,
} from './score.js';
import {
  detectStarflowers, detectBlackPearls, detectGrandPoobahs,
  detectGrandPoobahRing, tickBombs,
} from './specials.js';
import { saveGameState, loadGameState, clearGameState } from './storage.js';
import {
  playRotate, playSelect, playMatch, playCombo, playSpecial,
  playBombArrive, playBombTick, startBed, stopBed, setBedUrgency,
} from './audio.js';
import { getActivePuzzle, onPuzzleMove } from './puzzle-mode.js';

// ─── Host ───────────────────────────────────────────────────────
//
// Same shape as js/frame.js and js/modal.js: inert until main.js registers, so
// importing this module in node costs nothing and asserts nothing. Only three
// hooks, and each one is here because the thing it touches is main.js's, not
// the state machine's:
//
//   closeModeDropdown — the logo dropdown is a DOM node main.js owns.
//   resetFrameClock   — `lastTime` belongs to the game loop, which stays in
//                       main.js because it draws.
//   onGameWin         — the win modal's presentation (name prefill, modal
//                       open, audio). The transition itself is here.

const NOOP_HOST = {
  closeModeDropdown() {},
  resetFrameClock() {},
  onGameWin() {},
};
let host = NOOP_HOST;

/** @param {Partial<typeof NOOP_HOST>} h */
export function registerGameStateHost(h) {
  host = {};
  for (const key of Object.keys(NOOP_HOST)) {
    host[key] = typeof h?.[key] === 'function' ? h[key] : NOOP_HOST[key];
  }
}

/** Test seam: drop the host and put the machine back at boot conditions. */
export function resetGameStateForTests() {
  host = NOOP_HOST;
  grid = undefined;
  activeCols = GRID_COLS;
  activeRows = GRID_ROWS;
  state = 'idle';
  isPaused = false;
  selectedCluster = null;
  flowerCenter = null;
  pearlCenter = null;
  moveCount = 0;
  bombQueued = false;
  boardGeneration = 0;
}

// ─── Game state ─────────────────────────────────────────────────

let grid;
let activeCols = GRID_COLS;  // may shrink for puzzle grids
let activeRows = GRID_ROWS;
let state = 'idle';
let isPaused = false;
let selectedCluster = null;
let flowerCenter = null;     // {col,row} if a starflower ring is selected
let pearlCenter = null;      // {col,row} if a black pearl Y-shape is selected
let moveCount = 0;           // total player moves (for bomb spawn timing)
let bombQueued = false;
let boardGeneration = 0;     // incremented on grid replacement; stale async chains bail out

// ─── Animation Context ──────────────────────────────────────────
//
// The handle animations.js reads and writes the board through. Its shape is
// deliberately UNCHANGED by this extraction — the write accessors (`set grid`,
// `setState`, `setBombQueued`) are exactly the ones hecknsic#66 removes, and
// narrowing them here would collide with that package.

export const getAnimationContext = () => ({
  get grid() { return grid; },
  set grid(g) { grid = g; },
  get activeCols() { return activeCols; },
  get activeRows() { return activeRows; },
  get state() { return state; },
  setState(s) { state = s; },
  get boardGeneration() { return boardGeneration; },
  get selectedCluster() { return selectedCluster; },
  get flowerCenter() { return flowerCenter; },
  get pearlCenter() { return pearlCenter; },
  get moveCount() { return moveCount; },
  get bombQueued() { return bombQueued; },
  setBombQueued(q) { bombQueued = q; },
  resetGame: () => resetGame(),
  handleGameWin: () => handleGameWin(),
  getCombinedModeId,
  clearGameState,
});

// ─── Accessors ──────────────────────────────────────────────────

export function getGrid() { return grid; }
export function setGrid(g) { grid = g; }
export function getActiveCols() { return activeCols; }
export function getActiveRows() { return activeRows; }
export function getState() { return state; }
export function setState(s) { state = s; }
export function getSelectedCluster() { return selectedCluster; }
export function getFlowerCenter() { return flowerCenter; }
export function getPearlCenter() { return pearlCenter; }
export function getMoveCount() { return moveCount; }
export function setMoveCount(n) { moveCount = n; }
export function getBombQueued() { return bombQueued; }
export function setBombQueued(q) { bombQueued = q; }
export function getBoardGeneration() { return boardGeneration; }
export function isGamePaused() { return isPaused; }
export function setPaused(p) { isPaused = p; }

/** Clear the whole selection — cluster and both special centres together.
 *  They are always cleared as a set; splitting them is how a stale
 *  flowerCenter outlives its cluster. */
export function clearSelection() {
  selectedCluster = null;
  flowerCenter = null;
  pearlCenter = null;
}

// ─── Board replacement ──────────────────────────────────────────

/**
 * Boot: adopt the saved board for the active mode, or deal a fresh one.
 *
 * Order-sensitive — it reads getCombinedModeId(), so it must run after
 * loadActiveMode() and after any URL-param mode override. main.js calls it at
 * exactly that point in its boot sequence.
 *
 * No generation bump: nothing is in flight at boot, and the counter is the
 * signal to *running* async chains.
 */
export function initBoardFromSave() {
  const saved = loadGameState(getCombinedModeId());
  if (saved) {
    grid = saved.grid;
    restoreScore(saved);
    moveCount = saved.moveCount || 0;
    state = 'idle';
  } else {
    resetScore();
    grid = createGrid();
    activeCols = GRID_COLS;
    activeRows = GRID_ROWS;
    setActiveGridSize(GRID_COLS, GRID_ROWS);
    state = 'idle';
  }
}

/**
 * Swap the board for a puzzle's fixed grid. Registered as puzzle-mode.js's
 * onLoad callback from main.js.
 *
 * The generation bump is first and unconditional: a rotation or cascade still
 * in flight on the old board has to see a changed generation at its next
 * check, or it commits its three remembered cells onto this new grid.
 *
 * @param {any[][]} puzzleGrid
 * @param {number} cols @param {number} rows — puzzle grids may be smaller.
 */
export function loadPuzzleBoard(puzzleGrid, cols, rows) {
  boardGeneration++;
  setActiveGameMode('puzzle');
  clearAllOverrides();
  bombQueued = false;
  clearSelection();
  moveCount = 0;
  resetScore();
  grid = puzzleGrid;
  activeCols = cols;
  activeRows = rows;
  setActiveGridSize(cols, rows);
  state = 'idle';
  requestRedraw();
}

// ─── Predicates ─────────────────────────────────────────────────

/** True while the board is mid-animation (rotating, cascading). UI should not restart. */
export function isProcessing() {
  return state === 'rotating' || state === 'cascading';
}

/**
 * GAME_INTEGRATION §6d — is there any reason for another frame?
 *
 * Dirty-checking the *draw* was never enough: an rAF callback that decides not
 * to paint is still an rAF callback, so the main thread woke 60x a second on a
 * settled board and the display pipeline never reached 0 fps. This is the
 * condition that lets the loop stop entirely.
 *
 * isProcessing() ('rotating' / 'cascading') is in here as a deliberate blanket:
 * those states are driven by async chains that await sleeps between tweens, so
 * there are moments mid-cascade with nothing dirty and no tween live. Staying
 * awake through them is a handful of frames during motion the player asked
 * for, and it means no cascade can strand itself waiting on a parked loop.
 */
export function nothingLeftToDo() {
  return !isProcessing()
    && !getIsDirty()
    && !hasActiveTweens()
    && !hasActiveRendererAnimations()
    && !isScoreAnimating()
    && !hasPendingAction();
}

// ─── Pause / resume ─────────────────────────────────────────────

/**
 * Come back from a modal. Every close goes through here — no longer because
 * eleven handlers each remember to call it, but because closeModal() in
 * js/modal.js is the only thing that closes a modal and this is its resume().
 *
 * Clearing isPaused is not enough on its own: a paused frame parks the loop,
 * and a parked loop does not restart just because a flag flipped. That was
 * already true before §6d — closing help or high-scores left the board frozen
 * until the next resize or suspend/resume — and the more the loop parks, the
 * more that bites. Resetting the frame clock (main.js's `lastTime`, via the
 * host) keeps the score counter from seeing the whole time the modal was open
 * as one delta.
 *
 * wakeFrameLoop() asks the gate main.js registered — `() => !isPaused` — which
 * stays the sole authority on whether frames go back on the schedule. Nothing
 * here calls loop.start().
 */
export function resumeFromPause() {
  isPaused = false;
  host.resetFrameClock();
  wakeFrameLoop();
}

// ─── Selection ──────────────────────────────────────────────────

/**
 * Try to select whatever is under the cursor.
 * Prioritizes flower rings over normal 3-hex clusters.
 *
 * The pixel arithmetic reads the renderer's origin and the input module's last
 * click; neither is a DOM read, which is why this whole function moved intact.
 * The one genuinely DOM-shaped thing it did — closing the mode dropdown when
 * the player clicks the board — is now a host hook.
 */
export function trySelect() {
  const { originX, originY } = getOrigin();
  const clickPos = getLastClickPos();
  if (!clickPos) {
    clearSelection();
    setClusterCenterPx(null, null);
    return;
  }

  // Close dropdown if clicking on canvas
  host.closeModeDropdown();

  const hex = pixelToHex(clickPos.x, clickPos.y, originX, originY);

  // Check if the clicked hex is a black pearl → Y-shape selection
  if (hex.col >= 0 && hex.col < activeCols &&
      hex.row >= 0 && hex.row < activeRows &&
      grid[hex.col]?.[hex.row]?.special === 'blackpearl') {
    // Select a Y-shape: pearl center + 3 alternating neighbors
    const nbrs = getNeighbors(hex.col, hex.row);
    const inBoundsNbrs = nbrs.filter(n =>
      n.col >= 0 && n.col < activeCols && n.row >= 0 && n.row < activeRows
    );
    if (inBoundsNbrs.length >= 3) {
      // Pick alternating neighbors (every other one) for Y-shape
      // Use even-indexed neighbors: 0, 2, 4 for one Y, 1, 3, 5 for inverted
      const yHexes = [nbrs[0], nbrs[2], nbrs[4]].filter(n =>
        n.col >= 0 && n.col < activeCols && n.row >= 0 && n.row < activeRows
      );
      if (yHexes.length === 3) {
        pearlCenter = { col: hex.col, row: hex.row };
        flowerCenter = null;
        selectedCluster = [{ col: hex.col, row: hex.row }, ...yHexes];
        state = 'selected';
        playSelect();
        // Pearl center is the center hex pixel
        const cp = hexToPixel(hex.col, hex.row, originX, originY);
        setClusterCenterPx(cp.x, cp.y);
        return;
      }
    }
  }

  // Check if the clicked hex is a starflower → ring selection
  if (hex.col >= 0 && hex.col < activeCols &&
      hex.row >= 0 && hex.row < activeRows &&
      grid[hex.col]?.[hex.row]?.special === 'starflower') {
    const nbrs = getNeighbors(hex.col, hex.row);
    const allInBounds = nbrs.every(n =>
      n.col >= 0 && n.col < activeCols && n.row >= 0 && n.row < activeRows
    );
    if (allInBounds) {
      flowerCenter = { col: hex.col, row: hex.row };
      pearlCenter = null;
      selectedCluster = [{ col: hex.col, row: hex.row }, ...nbrs];
      state = 'selected';
      playSelect();
      // Flower center pixel
      const cp = hexToPixel(hex.col, hex.row, originX, originY);
      setClusterCenterPx(cp.x, cp.y);
      return;
    }
  }

  // Normal 3-hex cluster selection
  const cluster = findClusterAtPixel(
    clickPos.x, clickPos.y,
    originX, originY,
    activeCols, activeRows
  );
  if (cluster) {
    flowerCenter = null;
    pearlCenter = null;
    selectedCluster = cluster;
    state = 'selected';
    playSelect();
    // Compute centroid of the 3 cluster hexes
    const px = cluster.map(h => hexToPixel(h.col, h.row, originX, originY));
    setClusterCenterPx(
      (px[0].x + px[1].x + px[2].x) / 3,
      (px[0].y + px[1].y + px[2].y) / 3
    );
  } else {
    clearSelection();
    setClusterCenterPx(null, null);
  }
}

/** Same three hexes, in any order? @returns {boolean} */
export function clustersMatch(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const setA = new Set(a.map(h => `${h.col},${h.row}`));
  return b.every(h => setA.has(`${h.col},${h.row}`));
}

/**
 * Consume the queued gesture, if the current state can use one.
 *
 * Called once per frame from main.js's game loop. The loop decides *when* to
 * ask; which action means what is a rule, so it lives here.
 *
 * A consumed action is a genuine user gesture, which is also what unlocks the
 * AudioContext under the browser's autoplay policy — so the ambient floor is
 * started from here rather than at load, where it would be blocked. Both
 * calls are idempotent and early-return once the bed is running.
 *
 * 'rotating' and 'cascading' deliberately do NOT consume: a gesture made
 * mid-animation is preserved for the frame after it settles.
 */
export function processInput() {
  if (state === 'idle') {
    const action = consumeAction();
    if (action && action.type === 'select') {
      startBed(getActiveGameModeId());
      trySelect();
    }
    return;
  }

  if (state !== 'selected') return;

  const action = consumeAction();
  if (!action) return;
  startBed(getActiveGameModeId());

  if (action.type === 'rotateCW' || action.type === 'rotateCCW') {
    animateRotation(action.type === 'rotateCW');
  } else if (action.type === 'select') {
    // Click: try to select something else, or deselect
    const prevCluster = selectedCluster;
    trySelect();
    if (selectedCluster === null) {
      // Nothing to select → deselect
      state = 'idle';
    } else if (clustersMatch(selectedCluster, prevCluster)) {
      // Clicked same thing → deselect
      clearSelection();
      state = 'idle';
    }
    // else: selected something new, stay in 'selected'
  }
}

// ─── Restart / mode switch ──────────────────────────────────────

/**
 * Swap the board for the newly-selected mode's, adopting that mode's save if
 * it has one. Called from main.js's switchGameMode() after the HUD relayout.
 */
export function resetBoardForNewMode() {
  boardGeneration++;
  clearAllOverrides();
  bombQueued = false;
  clearSelection();
  const combinedId = getCombinedModeId();
  const saved = loadGameState(combinedId);
  if (saved) {
    grid = saved.grid;
    restoreScore(saved);
    moveCount = saved.moveCount || 0;
  } else {
    resetScore();
    resetChain();
    grid = createGrid();
    moveCount = 0;
  }
  activeCols = GRID_COLS;
  activeRows = GRID_ROWS;
  setActiveGridSize(GRID_COLS, GRID_ROWS);
  state = 'idle';
  closeModal('modal-gameover');
  requestRedraw();
}

/** Deal a fresh board in the current mode. Reached from every "new game" button
 *  and from ctx.resetGame() at the end of the explosion sequence. */
export function resetGame() {
  boardGeneration++;
  resetScore();
  resetChain();
  grid = createGrid();
  activeCols = GRID_COLS;
  activeRows = GRID_ROWS;
  setActiveGridSize(GRID_COLS, GRID_ROWS);
  state = 'idle';
  moveCount = 0;
  bombQueued = false;
  clearSelection();

  // A restart is a fresh room: drop the old floor and start one at the new
  // mode's intensity. startBed() is idempotent, so the stop matters more than
  // the start — without it a mode switch would leave the previous bed running.
  stopBed(0.4);
  startBed(getActiveGameModeId());

  // Ensure we are unpaused and running. closeModal() is the whole of it now:
  // it clears the pause and calls resumeFromPause(), which wakes the loop
  // through the gate. That used to be an open-coded `isPaused = false` plus a
  // direct gameFrameLoop.start() here — a second way to start the loop, which
  // is exactly what the gate exists to be the only one of.
  closeModal('modal-gameover');
}

/** Persist the board and score under the active mode's key. */
export function saveGame() {
  saveGameState(getCombinedModeId(), {
    grid,
    moveCount,
    score: getScore(),
    displayScore: getDisplayScore(),
    chainLevel: getChainLevel(),
    comboCount: getComboCount(),
    maxCombo: getMaxCombo(),
  });
}

/** The win transition. Only the state change is a rule; the modal, the name
 *  prefill and the fanfare are presentation and go through the host. */
export function handleGameWin() {
  state = 'gameover';
  host.onGameWin();
}

// ─── Rotation ───────────────────────────────────────────────────

/**
 * A player rotation press: spin, then look at what it produced.
 * @param {boolean} clockwise
 */
export async function animateRotation(clockwise) {
  if (state !== 'selected') return;
  state = 'rotating';
  // One ratchet per player rotation press, not per internal step. The
  // mechanism's size follows what is actually turning: a starflower spins its
  // six-tile ring, a black pearl its Y, everything else the plain 3-cluster.
  playRotate(flowerCenter ? 'ring' : pearlCenter ? 'y' : 'cluster');
  const gen = boardGeneration;
  const ctx = getAnimationContext();

  const { originX, originY } = getOrigin();

  // Determine max steps based on selection type
  // Starflower ring = 6 steps for full rotation
  // Cluster / Black Pearl (Y) = 3 steps for full rotation
  let maxSteps = 3;
  if (flowerCenter || pearlCenter) maxSteps = 1;

  for (let step = 0; step < maxSteps; step++) {
    // 1. Animate one step
    if (flowerCenter) {
      await animateRingRotation(ctx, clockwise, originX, originY);
    } else if (pearlCenter) {
      await animateYRotation(ctx, clockwise, originX, originY);
    } else {
      await animateClusterRotation(ctx, clockwise, originX, originY);
    }
    if (boardGeneration !== gen) return; // board was replaced (e.g. restart)

    // 2. Check for matches or specials
    const matches = findMatchesForMode(grid, activeCols, activeRows);
    const sfResults = detectStarflowers(grid);
    const bpResults = detectBlackPearls(grid);
    const gpResults = detectGrandPoobahs(grid);

    // If we found anything significant, proceed to post-rotation logic (cascade/etc)
    // and STOP rotating.
    if (matches.size > 0 || sfResults.length > 0 || bpResults.length > 0 || gpResults.length > 0) {
      await postRotationCheck(gen);
      return;
    }
  }

  // If we loop through all steps without a match, we are back at the start.
  // Count as a move, tick bombs, etc.
  await postRotationCheck(gen);
}

/** How pressed the player is by bombs, 0..1, from the SHORTEST live fuse on the
 *  board — that is the one that ends the game. Arcade bombs spawn at
 *  BOMB_INITIAL_TIMER, so a fresh one sits near 0 and the last move before
 *  detonation is 1; a puzzle bomb placed on a shorter fuse simply starts
 *  further up the scale, which is the right reading. Returns 0 when the board
 *  is clear, which is what silences the tension bed entirely.
 *  @returns {number} */
export function bombUrgency() {
  let min = Infinity;
  for (let c = 0; c < activeCols; c++) {
    for (let r = 0; r < activeRows; r++) {
      const cell = grid[c]?.[r];
      if (cell?.special === 'bomb' && typeof cell.bombTimer === 'number') {
        if (cell.bombTimer < min) min = cell.bombTimer;
      }
    }
  }
  if (min === Infinity) return 0;
  const u = 1 - (min - 1) / BOMB_INITIAL_TIMER;
  return Math.max(0, Math.min(1, u));
}

/**
 * The cascade's priority ladder, as one decision.
 *
 * The order is the rule: a Grand Poobah RING (the over-achiever win) outranks
 * everything, then Grand Poobahs, then black pearls, then starflowers, then
 * plain matches. It matters because the formations are built out of each other
 * — six pearls make a poobah, six starflowers make a pearl — so resolving a
 * plain match first would clear the tiles a larger formation is standing on.
 *
 * Pulled out of postRotationCheck's while-loop as a pure function purely so
 * the ladder can be asserted directly (tests/game-state.test.js). Semantics are
 * unchanged: same detectors, same order, same short-circuiting — each detector
 * still runs only if every higher one came back empty.
 *
 * @param {any[][]} g @param {number} [cols] @param {number} [rows]
 * @returns {{kind:'poobah-ring'|'grandpoobah'|'blackpearl'|'starflower'|'match'|'stable', results?:any}}
 */
export function nextResolution(g = grid, cols = activeCols, rows = activeRows) {
  const gpRing = detectGrandPoobahRing(g);
  if (gpRing.length > 0) return { kind: 'poobah-ring', results: gpRing };

  const gpResults = detectGrandPoobahs(g);
  if (gpResults.length > 0) return { kind: 'grandpoobah', results: gpResults };

  const bpResults = detectBlackPearls(g);
  if (bpResults.length > 0) return { kind: 'blackpearl', results: bpResults };

  const sfResults = detectStarflowers(g);
  if (sfResults.length > 0) return { kind: 'starflower', results: sfResults };

  const matches = findMatchesForMode(g, cols, rows);
  if (matches.size > 0) return { kind: 'match', results: matches };

  return { kind: 'stable' };
}

/** Shared post-rotation logic: tick bombs, cascade or detect specials.
 *  @param {number} gen — boardGeneration at call time; bail out if it changes.
 *                        Always pass explicitly — do not rely on a default capture. */
export async function postRotationCheck(gen) {
  // Guard: callers must pass gen so stale async chains bail correctly.
  if (gen === undefined) gen = boardGeneration;
  moveCount++;
  const ctx = getAnimationContext();

  const mode = getActiveGameMode();

  // Tick bomb timers in any mode that has them (arcade + puzzle pre-placed bombs)
  // Only spawn new bombs in arcade (hasBombs). Puzzle uses pre-placed bombs only.
  if (mode.ticksBombs) {
    tickBombs(grid);

    // Animate bomb shake on tick
    const bombCells = [];
    for (let c = 0; c < activeCols; c++) {
      for (let r = 0; r < activeRows; r++) {
        if (grid[c][r]?.special === 'bomb') bombCells.push({ c, r });
      }
    }
    if (bombCells.length > 0) {
      // The fuse clock, with the shake. Urgency tracks the SHORTEST live fuse,
      // since that is the one about to end the game.
      playBombTick(bombUrgency());
      await tween(250, t => {
        const shakeX = Math.sin(t * Math.PI * 6) * 4 * (1 - t);
        for (const b of bombCells) {
          setCellOverride(b.c, b.r, { offsetX: shakeX });
        }
        requestRedraw();
      }, linear).promise;
      if (boardGeneration !== gen) return;
      for (const b of bombCells) clearCellOverride(b.c, b.r);
      requestRedraw();
    }

    // Spawn new bombs only in arcade mode
    if (mode.hasBombs) {
      const currentScore = getScore();
      let dynamicInterval = 15 - Math.floor(currentScore / 5000);
      if (dynamicInterval < 4) dynamicInterval = 4;
      if (moveCount % dynamicInterval === 0 && !bombQueued) {
        bombQueued = true;
        playBombArrive(); // a bomb is about to appear on the board
      }
    }
  }

  // Centralized Board State Resolution Logic
  let boardStable = false;
  let isFirstStep = true;

  while (!boardStable) {
    if (boardGeneration !== gen) return;
    boardStable = true;

    const step = nextResolution(grid, activeCols, activeRows);

    // Grand Poobah Ring (Over-Achiever) short-circuits the whole run.
    if (step.kind === 'poobah-ring') {
      await handleOverAchiever(ctx);
      return;
    }
    if (step.kind === 'stable') break;

    const chained = !isFirstStep;
    if (chained) { advanceChain(); await delay(100); }
    if (boardGeneration !== gen) return;
    isFirstStep = false;
    state = 'cascading';

    if (step.kind === 'grandpoobah') {
      playSpecial('grandpoobah');
      await animateGrandPoobahCreation(ctx, step.results);
    } else if (step.kind === 'blackpearl') {
      playSpecial('blackpearl');
      await animateBlackPearlCreation(ctx, step.results);
    } else if (step.kind === 'starflower') {
      playSpecial('starflower');
      await animateStarflowerCreation(ctx, step.results);
    } else {
      // First clear = plain match, sized by how much glass broke; chained
      // cascade steps = combo, climbing the ladder with chain depth.
      if (chained) playCombo(getChainLevel());
      else playMatch(step.results.size);
      await runCascade(ctx, step.results, gen);
    }

    if (boardGeneration !== gen) return;
    boardStable = false;
  }

  if (!isFirstStep) {
    // Only deselect if a cascade or special formation occurred
    clearSelection();
    state = 'idle';
  } else {
    // Retain selection if nothing cleared
    state = 'selected';
  }

  resetChain();

  // The floor answers the board: the tension layer tracks the shortest live
  // fuse and goes silent when there are none. Quantised + hysteresis inside,
  // so calling it every move costs a retune only a handful of times a session.
  setBedUrgency(bombUrgency());

  // Puzzle move tracking
  const activePuzzle = getActivePuzzle();
  if (activePuzzle) {
    onPuzzleMove(grid, getScore(), getChainLevel());
    // Don't saveGame for puzzles — fixed board, no persistence needed
  } else {
    saveGame();
  }

  // Final check: did any un-cleared bombs expire?
  // ticksBombs covers both arcade (hasBombs) and puzzle (pre-placed bombs)
  if (mode.ticksBombs && mode.hasGameOver) {
    let exploded = false;
    for (let c = 0; c < activeCols; c++) {
      for (let r = 0; r < activeRows; r++) {
         if (grid[c]?.[r]?.special === 'bomb' && grid[c][r].bombTimer <= 0) {
             exploded = true;
             break;
         }
      }
    }
    if (exploded) {
       handleGameOver(ctx, false);
       return;
    }
  }
}
