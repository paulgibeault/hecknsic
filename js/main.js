/**
 * main.js — Entry point: canvas setup, game loop, state machine.
 *
 * States:
 *   'idle'       – waiting for player to select a cluster
 *   'selected'   – cluster selected, waiting for rotation or confirm
 *   'rotating'   – pop-thunk rotation animation in progress
 *   'cascading'  – match → flash → remove → gravity → refill → recheck
 */

import {
  GRID_COLS, GRID_ROWS,
  MATCH_FLASH_MS, GRAVITY_MS,
  ROTATION_POP_MS, ROTATION_SETTLE_MS,
  BOMB_SPAWN_INTERVAL,
} from './constants.js';
import {
  createGrid, rotateCluster, rotateRing,
  findMatches, findMatchesForMode,
  applyGravity, fillEmpty,
} from './board.js';
import {
  initRenderer, resize, drawFrame, getOrigin, getBoardScale,
  setCellOverride, clearCellOverride, clearAllOverrides,
  addFloatingPiece, removeFloatingPiece,
  spawnCreationParticles, spawnScorePopup,
  spawnColorNukeParticles, spawnExplosionParticles,
  spawnRingShockwave, flashScreenOverlay,
  requestRedraw, clearDirty, getIsDirty, hasActiveRendererAnimations,
  setActiveGridSize,
} from './renderer.js';
import {
  loadActiveMode, getActiveGameMode, getActiveMatchMode,
  getActiveGameModeId, getCombinedModeId,
  setActiveGameMode, getAllGameModes
} from './modes.js';
import { hexToPixel, getNeighbors, pixelToHex, findClusterAtPixel } from './hex-math.js';
import {
  initInput, getHoverCluster, consumeAction, getLastClickPos, triggerAction,
  setKeyBindings, clearPendingAction, setClusterCenterPx,
} from './input.js';

import {
  animateClusterRotation, animateRingRotation, animateYRotation,
  animateBlackPearlCreation, animateGrandPoobahCreation, animateStarflowerCreation,
  handleOverAchiever, handleGameOver, runCascade, computeFallDistances, delay
} from './animations.js';
import { tween, updateTweens, easeOutCubic, easeOutBounce, hasActiveTweens, linear } from './tween.js';
import {
  resetScore, awardMatch, advanceChain, resetChain,
  updateDisplayScore, restoreScore,
  getScore, getDisplayScore, getChainLevel, getComboCount, isScoreAnimating
} from './score.js';
import {
  detectStarflowers, detectStarflowersAtCleared,
  detectBlackPearls, detectMultiplierClusters, detectGrandPoobahs,
  detectGrandPoobahRing, tickBombs, countBombs,
} from './specials.js';
import {
  saveGameState, loadGameState, clearGameState,
  addHighScore, getHighScores, loadSettings, saveSettings
} from './storage.js';
import {
  initPuzzleModeUI, showPuzzleSelector, registerPuzzleCallbacks,
  clearActivePuzzle, getActivePuzzle, getPuzzleMovesLeft,
  onPuzzleMove, onStarflowerCreated,
} from './puzzle-mode.js';


// ─── Animation Context ───
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
  resetGame: () => resetGame()
});
// ─── Game state ─────────────────────────────────────────────────
let grid;
let activeCols = GRID_COLS;  // may shrink for puzzle grids
let activeRows = GRID_ROWS;
let state = 'idle';  // 'idle' | 'selected' | 'rotating' | 'cascading' | 'gameover'
let isPaused = false;
let selectedCluster = null;
let flowerCenter = null;     // {col,row} if a starflower ring is selected
let pearlCenter = null;      // {col,row} if a black pearl Y-shape is selected
let lastTime = 0;
let moveCount = 0;           // total player moves (for bomb spawn timing)
let bombQueued = false;
let boardGeneration = 0;  // incremented on grid replacement; stale async chains bail out

// ─── Bootstrap ──────────────────────────────────────────────────

/** True while the board is mid-animation (rotating, cascading). UI should not restart. */
export function isProcessing() {
  return state === 'rotating' || state === 'cascading';
}

// DEBUG: Expose internals
window.debug = {
  getGrid: () => grid,
  getState: () => state,
  runPostRotation: () => postRotationCheck(boardGeneration),
};

const canvas = document.getElementById('game');
initRenderer(canvas);
initInput(canvas);

// ─── Puzzle mode setup ───────────────────────────────────────────
initPuzzleModeUI(() => grid, isProcessing);

registerPuzzleCallbacks(
  // onLoad: replace the board with the puzzle's fixed grid
  (puzzleGrid, cols, rows, puzzle) => {
    boardGeneration++;
    setActiveGameMode('puzzle');
    clearAllOverrides();
    bombQueued = false;
    selectedCluster = flowerCenter = pearlCenter = null;
    moveCount = 0;
    resetScore();
    grid = puzzleGrid;
    activeCols = cols;
    activeRows = rows;
    setActiveGridSize(cols, rows);
    state = 'idle';
    requestRedraw();
  },
  // onEnd: freeze input when puzzle ends
  (reason) => {
    state = 'gameover';
  }
);

// Apply settings
const settings = loadSettings();
setKeyBindings(settings.keyBindings);

// UI bindings
const controlsEl = document.getElementById('controls');
document.getElementById('btn-ccw').addEventListener('click', (e) => {
  e.stopPropagation(); // prevent canvas click
  triggerAction('rotateCW');
});
document.getElementById('btn-cw').addEventListener('click', (e) => {
  e.stopPropagation();
  triggerAction('rotateCCW');
});

// Handedness toggle — keeps buttons in the comfortable corner for each player
const toggleLeft  = document.getElementById('hand-toggle-left');
const toggleRight = document.getElementById('hand-toggle-right');

function applyHandedness(leftHanded) {
  controlsEl.classList.toggle('left-handed', leftHanded);
  toggleLeft.classList.toggle('hidden', leftHanded);   // left pill: shown when NOT left-handed
  toggleRight.classList.toggle('hidden', !leftHanded); // right pill: shown when left-handed
  localStorage.setItem('hecknsic_left_handed', leftHanded ? '1' : '0');
}

// Restore saved preference
applyHandedness(localStorage.getItem('hecknsic_left_handed') === '1');

toggleLeft.addEventListener('click', (e) => { e.stopPropagation(); applyHandedness(true); });
toggleRight.addEventListener('click', (e) => { e.stopPropagation(); applyHandedness(false); });


// Help Modal bindings
const nonGameUI = ['btn-help', 'modal-help', 'btn-close-help'];
document.getElementById('btn-help').addEventListener('click', (e) => {
  e.stopPropagation();
  isPaused = true;
  document.getElementById('modal-help').classList.remove('hidden');
});
document.getElementById('btn-close-help').addEventListener('click', (e) => {
  e.stopPropagation();
  isPaused = false;
  document.getElementById('modal-help').classList.add('hidden');
  // Reset lastTime to avoid huge dt jump
  lastTime = performance.now();
});

// Scores Modal bindings
document.getElementById('btn-scores').addEventListener('click', (e) => {
  e.stopPropagation();
  isPaused = true;
  showHighScores();
  document.getElementById('modal-scores').classList.remove('hidden');
});
document.getElementById('btn-close-scores').addEventListener('click', (e) => {
  e.stopPropagation();
  isPaused = false;
  document.getElementById('modal-scores').classList.add('hidden');
  lastTime = performance.now();
});

// Shared guard: shake a button and bail if board is mid-animation.
// Prevents restart clicks during cascade/rotation feeling like they're ignored.
function guardedAction(btn, action) {
  if (isProcessing()) {
    btn.classList.remove('shake-animation');
    void btn.offsetWidth; // force reflow to restart animation
    btn.classList.add('shake-animation');
    setTimeout(() => btn.classList.remove('shake-animation'), 400);
    return;
  }
  action();
}

// Game Over Modal bindings
document.getElementById('btn-newgame').addEventListener('click', (e) => {
  e.stopPropagation();
  guardedAction(e.currentTarget, resetGame);
});

// Dropdown Mode Selector bindings
const logoDropdown = document.getElementById('logo-dropdown');

function toggleModeDropdown() {
  if (logoDropdown.classList.contains('hidden')) {
    logoDropdown.classList.remove('hidden');
    // Sync UI state
    document.querySelectorAll('[data-mode]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === getActiveGameModeId());
    });
    // match mode selector removed (classic-only)
  } else {
    logoDropdown.classList.add('hidden');
  }
  requestRedraw();
}

// Close dropdown if clicking elsewhere
window.addEventListener('click', (e) => {
  if (!logoDropdown.contains(e.target) && state === 'idle') {
    // Rely on canvas click handler instead since standard clicks intercept on canvas
  }
});

// Game HUD logo opens the mode dropdown
document.getElementById('game-hud-logo')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleModeDropdown();
});

document.querySelectorAll('[data-mode]').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    switchGameMode(btn.dataset.mode);
  });
});

// Settings Modal bindings
document.getElementById('dropdown-btn-settings').addEventListener('click', (e) => {
  e.stopPropagation();
  isPaused = true;
  logoDropdown.classList.add('hidden'); // Close the menu
  document.getElementById('modal-settings').classList.remove('hidden');
});
document.getElementById('btn-close-settings').addEventListener('click', (e) => {
  e.stopPropagation();
  isPaused = false;
  document.getElementById('modal-settings').classList.add('hidden');
  saveSettings(settings); // Persist updated bindings
  lastTime = performance.now();
  requestRedraw();
});

// Setup keybind inputs
function bindKeyInput(id, keyName) {
  const el = document.getElementById(id);
  el.value = settings.keyBindings[keyName] || '';
  el.addEventListener('keydown', (e) => {
    e.preventDefault();
    if (e.key === 'Escape') {
      e.target.blur();
      return;
    }
    const key = e.key.toLowerCase();
    if (key.length === 1 || key.startsWith('arrow')) {
      settings.keyBindings[keyName] = key;
      el.value = key;
      setKeyBindings(settings.keyBindings);
    }
  });
}
bindKeyInput('bind-ccw', 'rotateCW');
bindKeyInput('bind-cw', 'rotateCCW');

// ─── End Session Modal ──────────────────────────────────────────

const endSessionModal = document.getElementById('modal-end-session');

document.getElementById('dropdown-btn-end-session').addEventListener('click', (e) => {
  e.stopPropagation();
  isPaused = true;
  logoDropdown.classList.add('hidden');
  
  // Re-trigger CSS animation
  const content = endSessionModal.querySelector('.modal-content');
  content.classList.remove('shake-animation');
  void content.offsetWidth; // trigger reflow
  content.classList.add('shake-animation');
  
  endSessionModal.classList.remove('hidden');
});

document.getElementById('btn-cancel-end').addEventListener('click', (e) => {
  e.stopPropagation();
  endSessionModal.classList.add('hidden');
  isPaused = false;
  requestRedraw();
  // allow board interactions again
});

// Game Win Modal bindings
document.getElementById('btn-continue-gamewin').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('modal-gamewin').classList.add('hidden');
  state = 'idle';
  isPaused = false;
  requestRedraw();
});

document.getElementById('btn-newgame-gamewin').addEventListener('click', (e) => {
  e.stopPropagation();
  guardedAction(e.currentTarget, resetGame);
});

// Over-Achiever Modal binding
document.getElementById('btn-newgame-oa').addEventListener('click', (e) => {
  e.stopPropagation();
  guardedAction(e.currentTarget, () => {
    document.getElementById('modal-over-achiever').classList.add('hidden');
    resetGame();
  });
});

document.getElementById('btn-confirm-end').addEventListener('click', (e) => {
  e.stopPropagation();
  endSessionModal.classList.add('hidden');
  isPaused = false; // Must unpause so the tween game-loop can tick!
  requestRedraw();
  
  // End session logic: trigger explosion sequence
  handleGameOver(true);
});

function showHighScores() {
  const list = document.getElementById('high-scores-list');
  const combinedId = getCombinedModeId();
  const scores = getHighScores(combinedId);
  const modeLabelEl = document.getElementById('hs-mode-label');
  if (modeLabelEl) {
    modeLabelEl.textContent = `${getActiveGameMode().label}`; // match mode label removed
  }
  
  list.innerHTML = '';

  if (scores.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No scores yet!';
    list.appendChild(li);
    return;
  }

  scores.forEach((s, i) => {
    const date = new Date(s.date).toLocaleDateString();
    const trophy = s.achievement ? ' 🏆' : '';
    
    const li = document.createElement('li');
    
    const rankSpan = document.createElement('span');
    rankSpan.className = 'rank';
    rankSpan.textContent = `#${i + 1}`;
    li.appendChild(rankSpan);
    
    const scoreSpan = document.createElement('span');
    scoreSpan.className = 'score';
    scoreSpan.textContent = `${s.score.toLocaleString()}${trophy}`;
    li.appendChild(scoreSpan);
    
    const dateSpan = document.createElement('span');
    dateSpan.className = 'date';
    dateSpan.textContent = date;
    li.appendChild(dateSpan);
    
    list.appendChild(li);
  });
}

function updateControlsVisibility() {
  if (state === 'selected' && !isPaused) {
    controlsEl.classList.remove('hidden');
  } else {
    controlsEl.classList.add('hidden');
  }
}

// ─── Unified HTML HUD ──────────────────────────────────────────

const MODE_LABELS = { arcade: '💣 Arcade', chill: '✨ Chill', puzzle: '🧩 Puzzle' };

/** Sync the HTML game-hud to the current mode and score. */
function updateGameHUD() {
  const mode = getActiveGameMode();
  const hud = document.getElementById('game-hud');
  if (!hud) return;

  // Skip score updates when puzzle mode owns the right-side group
  if (mode.isPuzzle) return;

  hud.dataset.mode = mode.id;
  const modeEl    = document.getElementById('game-hud-mode');
  const scoreEl   = document.getElementById('hud-score-value');

  if (modeEl)  modeEl.textContent  = MODE_LABELS[mode.id] || mode.label;
  if (scoreEl) scoreEl.textContent = getDisplayScore().toLocaleString();
}

/** Called when switching modes to reconfigure the HUD layout. */
function syncHUDForMode(modeId) {
  const hud = document.getElementById('game-hud');
  if (hud) hud.dataset.mode = modeId;

  const modeEl      = document.getElementById('game-hud-mode');
  const subtitleEl   = document.getElementById('game-hud-subtitle');
  const scoreGroup  = document.getElementById('hud-score-group');
  const puzzleGroup = document.getElementById('hud-puzzle-group');

  if (modeEl) modeEl.textContent = MODE_LABELS[modeId] || modeId;
  if (subtitleEl) subtitleEl.textContent = '';

  if (modeId === 'puzzle') {
    if (scoreGroup)  scoreGroup.style.display = 'none';
    if (puzzleGroup) puzzleGroup.style.display = '';
  } else {
    if (scoreGroup)  scoreGroup.style.display = '';
    if (puzzleGroup) puzzleGroup.style.display = 'none';
  }
}

window.addEventListener('resize', () => resize(canvas));

// Restore active mode then load per-mode saved state
loadActiveMode();

// Puzzle mode is transient (board state isn't persisted), so it can't be
// meaningfully restored on reload.  Fall back to arcade.
if (getActiveGameModeId() === 'puzzle') {
  setActiveGameMode('arcade');
}

// ─── URL Configuration Parsing ──────────────────────────────────
const urlParams = new URLSearchParams(window.location.search);
let hasUrlConfig = false;

const urlGameMode = urlParams.get('game');
if (urlGameMode && getAllGameModes().some(m => m.id === urlGameMode)) {
  setActiveGameMode(urlGameMode);
  hasUrlConfig = true;
}

// line match mode URL param removed (classic-only)

// Strip URL params so refreshing doesn't lock the user into the linked config
if (hasUrlConfig) {
  const cleanUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
  window.history.replaceState({ path: cleanUrl }, '', cleanUrl);
}
const activeGameMode = getActiveGameMode();
const activeMatchMode = getActiveMatchMode();

if (activeGameMode.id === 'chill') {
  document.getElementById('dropdown-btn-end-session').classList.remove('hidden');
}

// Initialize the unified HTML HUD for the active mode
syncHUDForMode(activeGameMode.id);

const savedState = loadGameState(getCombinedModeId());
if (savedState) {
  grid = savedState.grid;
  restoreScore(savedState);
  moveCount = savedState.moveCount || 0;
  state = 'idle';
  console.log('Game state loaded.');
} else {
  resetScore();
  grid = createGrid();
  activeCols = GRID_COLS;
  activeRows = GRID_ROWS;
  setActiveGridSize(GRID_COLS, GRID_ROWS);
  state = 'idle';
}

requestAnimationFrame(gameLoop);

// ─── Game loop ──────────────────────────────────────────────────

function gameLoop(timestamp) {
  if (isPaused) {
    requestAnimationFrame(gameLoop);
    return;
  }

  const dt = lastTime ? timestamp - lastTime : 16;
  lastTime = timestamp;

  updateTweens(timestamp);
  updateDisplayScore(dt);

  // Game over: just render, no input
  if (state === 'gameover') {
    const needsDraw = getIsDirty() || hasActiveTweens() || hasActiveRendererAnimations() || isScoreAnimating();
    if (needsDraw) {
      drawFrame(grid, null, null);
      clearDirty();
    }
    // drawGameOver(); // Handled by DOM overlay now
    
    updateGameHUD();
    requestAnimationFrame(gameLoop);
    return;
  }

  // Process input — only consume in states that can use it
  if (state === 'idle') {
    const action = consumeAction();
    if (action && action.type === 'select') {
      trySelect();
    }
  } else if (state === 'selected') {
    const action = consumeAction();
    if (action) {
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
          selectedCluster = null;
          flowerCenter = null;
          pearlCenter = null;
          state = 'idle';
        }
        // else: selected something new, stay in 'selected'
      }
    }
  }
  // 'rotating' and 'cascading': input is NOT consumed (preserved for later)

  // Draw
  const needsDraw = getIsDirty() || hasActiveTweens() || hasActiveRendererAnimations() || isScoreAnimating();
  if (needsDraw) {
    const hover = (state === 'idle') ? getHoverCluster() : null;
    drawFrame(grid, hover, (state === 'selected' ? selectedCluster : null));
    clearDirty();
  }

  updateControlsVisibility();
  updateGameHUD();

  requestAnimationFrame(gameLoop);
}

/**
 * Try to select whatever is under the cursor.
 * Prioritizes flower rings over normal 3-hex clusters.
 */
function trySelect() {
  const { originX, originY } = getOrigin();
  const clickPos = getLastClickPos();
  if (!clickPos) {
    selectedCluster = null;
    flowerCenter = null;
    pearlCenter = null;
    setClusterCenterPx(null, null);
    return;
  }

  // Close dropdown if clicking on canvas
  if (!logoDropdown.classList.contains('hidden')) {
    logoDropdown.classList.add('hidden');
  }

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
    // Compute centroid of the 3 cluster hexes
    const px = cluster.map(h => hexToPixel(h.col, h.row, originX, originY));
    setClusterCenterPx(
      (px[0].x + px[1].x + px[2].x) / 3,
      (px[0].y + px[1].y + px[2].y) / 3
    );
  } else {
    selectedCluster = null;
    flowerCenter = null;
    pearlCenter = null;
    setClusterCenterPx(null, null);
  }
}

// ─── Mode selector ──────────────────────────────────────────────

async function switchGameMode(newModeId) {
  // Puzzle mode: open selector instead of switching directly
  if (newModeId === 'puzzle') {
    logoDropdown.classList.add('hidden');
    showPuzzleSelector();
    return;
  }

  if (newModeId === getActiveGameModeId()) return;
  saveGame();
  clearActivePuzzle();
  setActiveGameMode(newModeId);
  if (newModeId === 'chill') {
    document.getElementById('dropdown-btn-end-session').classList.remove('hidden');
  } else {
    document.getElementById('dropdown-btn-end-session').classList.add('hidden');
  }

  // Update UI active states
  document.querySelectorAll('[data-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === newModeId);
  });

  syncHUDForMode(newModeId);
  resetBoardForNewMode();
}

// switchMatchMode removed — line variant deprecated, see tag feature/line-match-mode

function resetBoardForNewMode() {
  boardGeneration++;
  clearAllOverrides();
  bombQueued = false;
  selectedCluster = flowerCenter = pearlCenter = null;
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
  document.getElementById('modal-gameover').classList.add('hidden');
  requestRedraw();
}

// ─── Rotation animation ────────────────────────────────────────

async function animateRotation(clockwise) {
  if (state !== 'selected') return;
  state = 'rotating';
  const gen = boardGeneration;

  const { originX, originY } = getOrigin();

  // Determine max steps based on selection type
  // Starflower ring = 6 steps for full rotation
  // Cluster / Black Pearl (Y) = 3 steps for full rotation
  let maxSteps = 3;
  if (flowerCenter || pearlCenter) maxSteps = 1;

  for (let step = 0; step < maxSteps; step++) {
    // 1. Animate one step
    if (flowerCenter) {
      await animateRingRotation(clockwise, originX, originY);
    } else if (pearlCenter) {
      await animateYRotation(clockwise, originX, originY);
    } else {
      await animateClusterRotation(clockwise, originX, originY);
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

function handleGameWin() {
  state = 'gameover';
  document.getElementById('modal-gamewin').classList.remove('hidden');
}

/** Shared post-rotation logic: tick bombs, cascade or detect specials.
 *  @param {number} gen — boardGeneration at call time; bail out if it changes.
 *                        Always pass explicitly — do not rely on a default capture. */
async function postRotationCheck(gen) {
  // Guard: callers must pass gen so stale async chains bail correctly.
  if (gen === undefined) gen = boardGeneration;
  moveCount++;

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
      if (moveCount % dynamicInterval === 0) bombQueued = true;
    }
  }

  // Centralized Board State Resolution Logic
  let boardStable = false;
  let isFirstStep = true;

  while (!boardStable) {
    if (boardGeneration !== gen) return;
    boardStable = true;

    // Check for Grand Poobah Ring (Over-Achiever) before anything else
    const gpRing = detectGrandPoobahRing(grid);
    if (gpRing.length > 0) {
      await handleOverAchiever();
      return;
    }

    const gpResults = detectGrandPoobahs(grid);
    if (gpResults.length > 0) {
      if (!isFirstStep) { advanceChain(); await delay(100); }
      if (boardGeneration !== gen) return;
      isFirstStep = false;
      state = 'cascading';
      await animateGrandPoobahCreation(gpResults);
      if (boardGeneration !== gen) return;
      boardStable = false;
      continue;
    }

    const bpResults = detectBlackPearls(grid);
    if (bpResults.length > 0) {
      if (!isFirstStep) { advanceChain(); await delay(100); }
      if (boardGeneration !== gen) return;
      isFirstStep = false;
      state = 'cascading';
      await animateBlackPearlCreation(bpResults);
      if (boardGeneration !== gen) return;
      boardStable = false;
      continue;
    }

    const sfResults = detectStarflowers(grid);
    if (sfResults.length > 0) {
      if (!isFirstStep) { advanceChain(); await delay(100); }
      if (boardGeneration !== gen) return;
      isFirstStep = false;
      state = 'cascading';
      await animateStarflowerCreation(sfResults);
      if (boardGeneration !== gen) return;
      boardStable = false;
      continue;
    }

    const matches = findMatchesForMode(grid, activeCols, activeRows);
    if (matches.size > 0) {
      if (!isFirstStep) { advanceChain(); await delay(100); }
      if (boardGeneration !== gen) return;
      isFirstStep = false;
      state = 'cascading';
      await runCascade(matches, gen);
      if (boardGeneration !== gen) return;
      boardStable = false;
      continue;
    }
  }

  if (!isFirstStep) {
    // Only deselect if a cascade or special formation occurred
    selectedCluster = null;
    flowerCenter = null;
    pearlCenter = null;
    state = 'idle';
  } else {
    // Retain selection if nothing cleared
    state = 'selected';
  }

  resetChain();

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
       handleGameOver(false);
       return;
    }
  }
}

function resetGame() {
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
  selectedCluster = null;
  flowerCenter = null;
  pearlCenter = null;
  
  document.getElementById('modal-gameover').classList.add('hidden');
  
  // Ensure we are unpaused and running
  isPaused = false;
  lastTime = performance.now();
  requestAnimationFrame(gameLoop); // Might already be running, but safe to ensure
}

function saveGame() {
  saveGameState(getCombinedModeId(), {
    grid,
    moveCount,
    score: getScore(),
    displayScore: getDisplayScore(),
    chainLevel: getChainLevel(),
    comboCount: getComboCount(),
  });
}

// ─── Cascade logic ──────────────────────────────────────────────

async function startCascade() {
  state = 'cascading';

  const matches = findMatchesForMode(grid, activeCols, activeRows);
  if (matches.size === 0) {
    // No match — just deselect
    selectedCluster = null;
    state = 'idle';
    resetChain();
    return;
  }

  await runCascade(matches);

  selectedCluster = null;
  state = 'idle';
  resetChain();
}

// ─── Helpers ────────────────────────────────────────────────────

function clustersMatch(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const setA = new Set(a.map(h => `${h.col},${h.row}`));
  return b.every(h => setA.has(`${h.col},${h.row}`));
}

// ─── Game Over overlay ──────────────────────────────────────────

// ─── Game Over overlay ──────────────────────────────────────────

// drawGameOver removed; handled by DOM overlay.
