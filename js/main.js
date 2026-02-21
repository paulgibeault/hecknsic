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
  initRenderer, resize, drawFrame, getOrigin,
  setCellOverride, clearAllOverrides,
  addFloatingPiece, removeFloatingPiece,
  spawnCreationParticles, spawnScorePopup,
  getLogoBounds,
} from './renderer.js';
import {
  loadActiveMode, getActiveGameMode, getActiveMatchMode, 
  getActiveGameModeId, getActiveMatchModeId, getCombinedModeId,
  setActiveGameMode, setActiveMatchMode, getAllGameModes, getAllMatchModes
} from './modes.js';
import { hexToPixel, getNeighbors, pixelToHex, findClusterAtPixel } from './hex-math.js';
import {
  initInput, getHoverCluster, consumeAction, getLastClickPos, getMousePos, triggerAction,
  setKeyBindings, clearPendingAction,
} from './input.js';
import { tween, updateTweens, easeOutCubic, easeOutBounce } from './tween.js';
import {
  resetScore, awardMatch, advanceChain, resetChain,
  updateDisplayScore, restoreScore,
  getScore, getDisplayScore, getChainLevel, getComboCount
} from './score.js';
import {
  detectStarflowers, detectStarflowersAtCleared,
  detectBlackPearls, detectMultiplierClusters,
  tickBombs, countBombs,
} from './specials.js';
import {
  saveGameState, loadGameState, clearGameState,
  addHighScore, getHighScores, loadSettings
} from './storage.js';

// ─── Game state ─────────────────────────────────────────────────
let grid;
let state = 'idle';  // 'idle' | 'selected' | 'rotating' | 'cascading' | 'gameover'
let isPaused = false;
let selectedCluster = null;
let flowerCenter = null;     // {col,row} if a starflower ring is selected
let pearlCenter = null;      // {col,row} if a black pearl Y-shape is selected
let lastTime = 0;
let moveCount = 0;           // total player moves (for bomb spawn timing)
let bombQueued = false;

// ─── Bootstrap ──────────────────────────────────────────────────

// DEBUG: Expose internals
window.debug = {
  getGrid: () => grid,
  getState: () => state,
  runPostRotation: () => postRotationCheck(),
};

const canvas = document.getElementById('game');
initRenderer(canvas);
initInput(canvas);

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

// Game Over Modal bindings
document.getElementById('btn-newgame').addEventListener('click', (e) => {
  e.stopPropagation();
  resetGame();
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
    document.querySelectorAll('[data-match]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.match === getActiveMatchModeId());
    });
  } else {
    logoDropdown.classList.add('hidden');
  }
}

// Close dropdown if clicking elsewhere
window.addEventListener('click', (e) => {
  if (!logoDropdown.contains(e.target) && state === 'idle') {
    // Rely on canvas click handler instead since standard clicks intercept on canvas
  }
});

document.querySelectorAll('[data-mode]').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    switchGameMode(btn.dataset.mode);
  });
});

document.querySelectorAll('[data-match]').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    switchMatchMode(btn.dataset.match);
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
  // allow board interactions again
});

document.getElementById('btn-confirm-end').addEventListener('click', (e) => {
  e.stopPropagation();
  endSessionModal.classList.add('hidden');
  isPaused = false; // Must unpause so the tween game-loop can tick!
  
  // End session logic: trigger explosion sequence
  handleGameOver(true);
});

function showHighScores() {
  const list = document.getElementById('high-scores-list');
  const combinedId = getCombinedModeId();
  const scores = getHighScores(combinedId);
  const modeLabelEl = document.getElementById('hs-mode-label');
  if (modeLabelEl) {
    modeLabelEl.textContent = `${getActiveGameMode().label} - ${getActiveMatchMode().label}`;
  }
  
  if (scores.length === 0) {
    list.innerHTML = '<li>No scores yet!</li>';
    return;
  }

  list.innerHTML = scores.map((s, i) => {
    const date = new Date(s.date).toLocaleDateString();
    return `
      <li>
        <span class="rank">#${i + 1}</span>
        <span class="score">${s.score.toLocaleString()}</span>
        <span class="date">${date}</span>
      </li>
    `;
  }).join('');
}

function updateControlsVisibility() {
  if (state === 'selected' && !isPaused) {
    controlsEl.classList.remove('hidden');
  } else {
    controlsEl.classList.add('hidden');
  }
}

window.addEventListener('resize', () => resize(canvas));

// Restore active mode then load per-mode saved state
loadActiveMode();

// ─── URL Configuration Parsing ──────────────────────────────────
const urlParams = new URLSearchParams(window.location.search);
let hasUrlConfig = false;

const urlGameMode = urlParams.get('game');
if (urlGameMode && getAllGameModes().some(m => m.id === urlGameMode)) {
  setActiveGameMode(urlGameMode);
  hasUrlConfig = true;
}

const urlMatchMode = urlParams.get('match');
if (urlMatchMode && getAllMatchModes().some(m => m.id === urlMatchMode)) {
  setActiveMatchMode(urlMatchMode);
  hasUrlConfig = true;
}

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
  // Game Over: just render, no input
  if (state === 'gameover') {
    drawFrame(grid, null, null);
    // drawGameOver(); // Handled by DOM overlay now
    
    // One-time game over handling (hacky: check if we just entered this state)
    // tailored for this loop pattern: we return early, so just check a flag or run once
    // We'll rely on the fact that we handle state transitions elsewhere
    
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
  const hover = (state === 'idle') ? getHoverCluster() : null;
  drawFrame(grid, hover, (state === 'selected' ? selectedCluster : null));

  updateControlsVisibility();

  // Update cursor affordance based on logo hover
  const mousePos = getMousePos();
  const logo = getLogoBounds();
  if (logo && mousePos.x >= logo.x && mousePos.x <= logo.x + logo.w && mousePos.y >= logo.y && mousePos.y <= logo.y + logo.h) {
    canvas.style.cursor = 'pointer';
  } else {
    canvas.style.cursor = '';
  }

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
    return;
  }

  // Logo hit-test: clicking the logo toggles the mode dropdown
  const logo = getLogoBounds();
  if (logo &&
      clickPos.x >= logo.x && clickPos.x <= logo.x + logo.w &&
      clickPos.y >= logo.y && clickPos.y <= logo.y + logo.h) {
    toggleModeDropdown();
    return;
  } else {
    // Clicking outside closes it
    if (!logoDropdown.classList.contains('hidden')) {
      logoDropdown.classList.add('hidden');
    }
  }

  const hex = pixelToHex(clickPos.x, clickPos.y, originX, originY);

  // Check if the clicked hex is a black pearl → Y-shape selection
  if (hex.col >= 0 && hex.col < GRID_COLS &&
      hex.row >= 0 && hex.row < GRID_ROWS &&
      grid[hex.col]?.[hex.row]?.special === 'blackpearl') {
    // Select a Y-shape: pearl center + 3 alternating neighbors
    const nbrs = getNeighbors(hex.col, hex.row);
    const inBoundsNbrs = nbrs.filter(n =>
      n.col >= 0 && n.col < GRID_COLS && n.row >= 0 && n.row < GRID_ROWS
    );
    if (inBoundsNbrs.length >= 3) {
      // Pick alternating neighbors (every other one) for Y-shape
      // Use even-indexed neighbors: 0, 2, 4 for one Y, 1, 3, 5 for inverted
      const yHexes = [nbrs[0], nbrs[2], nbrs[4]].filter(n =>
        n.col >= 0 && n.col < GRID_COLS && n.row >= 0 && n.row < GRID_ROWS
      );
      if (yHexes.length === 3) {
        pearlCenter = { col: hex.col, row: hex.row };
        flowerCenter = null;
        selectedCluster = [{ col: hex.col, row: hex.row }, ...yHexes];
        state = 'selected';
        return;
      }
    }
  }

  // Check if the clicked hex is a starflower → ring selection
  if (hex.col >= 0 && hex.col < GRID_COLS &&
      hex.row >= 0 && hex.row < GRID_ROWS &&
      grid[hex.col]?.[hex.row]?.special === 'starflower') {
    const nbrs = getNeighbors(hex.col, hex.row);
    const allInBounds = nbrs.every(n =>
      n.col >= 0 && n.col < GRID_COLS && n.row >= 0 && n.row < GRID_ROWS
    );
    if (allInBounds) {
      flowerCenter = { col: hex.col, row: hex.row };
      pearlCenter = null;
      selectedCluster = [{ col: hex.col, row: hex.row }, ...nbrs];
      state = 'selected';
      return;
    }
  }

  // Normal 3-hex cluster selection
  const cluster = findClusterAtPixel(
    clickPos.x, clickPos.y, 
    originX, originY, 
    GRID_COLS, GRID_ROWS
  );
  if (cluster) {
    flowerCenter = null;
    pearlCenter = null;
    selectedCluster = cluster;
    state = 'selected';
  } else {
    selectedCluster = null;
    flowerCenter = null;
    pearlCenter = null;
  }
}

// ─── Mode selector ──────────────────────────────────────────────

async function switchGameMode(newModeId) {
  if (newModeId === getActiveGameModeId()) return;
  saveGame();                     // persist current mode state
  setActiveGameMode(newModeId);       // persist new selection
  if (newModeId === 'chill') {
    document.getElementById('dropdown-btn-end-session').classList.remove('hidden');
  } else {
    document.getElementById('dropdown-btn-end-session').classList.add('hidden');
  }

  // Update UI active states
  document.querySelectorAll('[data-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === newModeId);
  });

  resetBoardForNewMode();
}

async function switchMatchMode(newModeId) {
  if (newModeId === getActiveMatchModeId()) return;
  saveGame();
  setActiveMatchMode(newModeId);

  document.querySelectorAll('[data-match]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.match === newModeId);
  });

  resetBoardForNewMode();
}

function resetBoardForNewMode() {
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
  state = 'idle';
  document.getElementById('modal-gameover').classList.add('hidden');
}

// ─── Rotation animation ────────────────────────────────────────

async function animateRotation(clockwise) {
  if (state !== 'selected') return;
  state = 'rotating';

  const { originX, originY } = getOrigin();
  
  // Determine max steps based on selection type
  // Starflower ring = 6 steps for full rotation
  // Cluster / Black Pearl (Y) = 3 steps for full rotation
  let maxSteps = 3;
  if (flowerCenter) maxSteps = 1;

  for (let step = 0; step < maxSteps; step++) {
    // 1. Animate one step
    if (flowerCenter) {
      await animateRingRotation(clockwise, originX, originY);
    } else if (pearlCenter) {
      await animateYRotation(clockwise, originX, originY);
    } else {
      await animateClusterRotation(clockwise, originX, originY);
    }

    // 2. Check for matches or specials
    const matchType = getActiveMatchMode().matchMode;
    // We hack the old findMatchesForMode by changing to `findMatchesForMode(grid, GRID_COLS, GRID_ROWS, matchType)`?
    // main.js imports `findMatchesForMode` which usually looks at `getActiveMode().matchMode`.
    // Wait, findMatchesForMode currently looks up `getActiveMode().matchMode` on its own. Let's fix that.
    // For now we'll just check `findMatchesForMode(grid, GRID_COLS, GRID_ROWS)`. We need to fix `board.js`.
    const matches = findMatchesForMode(grid, GRID_COLS, GRID_ROWS);
    const sfResults = detectStarflowers(grid);
    const bpResults = detectBlackPearls(grid);

    // If we found anything significant, proceed to post-rotation logic (cascade/etc)
    // and STOP rotating.
    if (matches.size > 0 || sfResults.length > 0 || bpResults.length > 0) {
      await postRotationCheck();
      return; 
    }
  }

  // If we loop through all steps without a match, we are back at the start.
  // Count as a move, tick bombs, etc.
  await postRotationCheck();
}

/** Animate 3-hex cluster rotation (original pop-thunk) */
async function animateClusterRotation(clockwise, originX, originY) {
  const cluster = selectedCluster;
  const pixelPos = cluster.map(h => hexToPixel(h.col, h.row, originX, originY));
  const cx = (pixelPos[0].x + pixelPos[1].x + pixelPos[2].x) / 3;
  const cy = (pixelPos[0].y + pixelPos[1].y + pixelPos[2].y) / 3;
  const colors = cluster.map(h => grid[h.col][h.row].colorIndex);
  const specials = cluster.map(h => grid[h.col][h.row].special);

  const floaters = cluster.map((h, i) => {
    setCellOverride(h.col, h.row, { hidden: true });
    return addFloatingPiece({
      x: pixelPos[i].x, y: pixelPos[i].y,
      colorIndex: colors[i], special: specials[i],
      scale: 1, alpha: 1, shadow: false,
    });
  });

  // Pop
  await tween(ROTATION_POP_MS, t => {
    for (const fp of floaters) { fp.scale = 1 + 0.2 * t; fp.shadow = t > 0.3; }
  }, easeOutCubic).promise;

  const targets = clockwise
    ? [pixelPos[1], pixelPos[2], pixelPos[0]]
    : [pixelPos[2], pixelPos[0], pixelPos[1]];
  const startPos = floaters.map(fp => ({ x: fp.x, y: fp.y }));

  // Arc
  await tween(ROTATION_SETTLE_MS * 0.6, t => {
    for (let i = 0; i < 3; i++) {
      const a0 = Math.atan2(startPos[i].y - cy, startPos[i].x - cx);
      const a1 = Math.atan2(targets[i].y - cy, targets[i].x - cx);
      let da = a1 - a0;
      if (clockwise && da > 0) da -= Math.PI * 2;
      if (!clockwise && da < 0) da += Math.PI * 2;
      const angle = a0 + da * t;
      const r0 = Math.hypot(startPos[i].x - cx, startPos[i].y - cy);
      const r1 = Math.hypot(targets[i].x - cx, targets[i].y - cy);
      const radius = r0 + (r1 - r0) * t;
      floaters[i].x = cx + Math.cos(angle) * radius;
      floaters[i].y = cy + Math.sin(angle) * radius;
    }
  }, easeOutCubic).promise;

  // Settle
  await tween(ROTATION_SETTLE_MS * 0.4, t => {
    for (let i = 0; i < 3; i++) {
      floaters[i].x = targets[i].x;
      floaters[i].y = targets[i].y;
      floaters[i].scale = 1 + 0.2 * (1 - t);
      floaters[i].shadow = t < 0.7;
    }
  }, easeOutBounce).promise;

  for (const fp of floaters) removeFloatingPiece(fp);
  clearAllOverrides();
  rotateCluster(grid, cluster, clockwise);
}

/** Animate 6-hex ring rotation around flower center */
async function animateRingRotation(clockwise, originX, originY) {
  const center = flowerCenter;
  const ring = getNeighbors(center.col, center.row);
  const centerPx = hexToPixel(center.col, center.row, originX, originY);
  const cx = centerPx.x;
  const cy = centerPx.y;

  const pixelPos = ring.map(h => hexToPixel(h.col, h.row, originX, originY));
  const colors = ring.map(h => grid[h.col][h.row].colorIndex);
  const specials = ring.map(h => grid[h.col][h.row].special);

  // Hide ring cells, create floating pieces
  const floaters = ring.map((h, i) => {
    setCellOverride(h.col, h.row, { hidden: true });
    return addFloatingPiece({
      x: pixelPos[i].x, y: pixelPos[i].y,
      colorIndex: colors[i], special: specials[i],
      scale: 1, alpha: 1, shadow: false,
    });
  });

  // Pop
  await tween(ROTATION_POP_MS, t => {
    for (const fp of floaters) { fp.scale = 1 + 0.15 * t; fp.shadow = t > 0.3; }
  }, easeOutCubic).promise;

  // Targets: each piece moves one position CW or CCW
  const targets = clockwise
    ? ring.map((_, i) => pixelPos[(i + 1) % 6])
    : ring.map((_, i) => pixelPos[(i + 5) % 6]);
  const startPos = floaters.map(fp => ({ x: fp.x, y: fp.y }));

  // Arc around center
  await tween(ROTATION_SETTLE_MS * 0.7, t => {
    for (let i = 0; i < 6; i++) {
      const a0 = Math.atan2(startPos[i].y - cy, startPos[i].x - cx);
      const a1 = Math.atan2(targets[i].y - cy, targets[i].x - cx);
      let da = a1 - a0;
      if (clockwise && da > 0) da -= Math.PI * 2;
      if (!clockwise && da < 0) da += Math.PI * 2;
      const angle = a0 + da * t;
      const r0 = Math.hypot(startPos[i].x - cx, startPos[i].y - cy);
      const r1 = Math.hypot(targets[i].x - cx, targets[i].y - cy);
      const radius = r0 + (r1 - r0) * t;
      floaters[i].x = cx + Math.cos(angle) * radius;
      floaters[i].y = cy + Math.sin(angle) * radius;
    }
  }, easeOutCubic).promise;

  // Settle
  await tween(ROTATION_SETTLE_MS * 0.3, t => {
    for (let i = 0; i < 6; i++) {
      floaters[i].x = targets[i].x;
      floaters[i].y = targets[i].y;
      floaters[i].scale = 1 + 0.15 * (1 - t);
      floaters[i].shadow = t < 0.7;
    }
  }, easeOutBounce).promise;

  for (const fp of floaters) removeFloatingPiece(fp);
  clearAllOverrides();
  rotateRing(grid, ring, clockwise);
}

/** Animate 3-hex Y-shape rotation around black pearl center */
async function animateYRotation(clockwise, originX, originY) {
  const center = pearlCenter;
  const nbrs = getNeighbors(center.col, center.row);
  // Y-shape uses alternating neighbors (0, 2, 4)
  const yRing = [nbrs[0], nbrs[2], nbrs[4]];
  const centerPx = hexToPixel(center.col, center.row, originX, originY);
  const cx = centerPx.x;
  const cy = centerPx.y;

  const pixelPos = yRing.map(h => hexToPixel(h.col, h.row, originX, originY));
  const colors = yRing.map(h => grid[h.col][h.row].colorIndex);
  const specials = yRing.map(h => grid[h.col][h.row].special);

  // Hide Y-ring cells, create floating pieces
  const floaters = yRing.map((h, i) => {
    setCellOverride(h.col, h.row, { hidden: true });
    return addFloatingPiece({
      x: pixelPos[i].x, y: pixelPos[i].y,
      colorIndex: colors[i], special: specials[i],
      scale: 1, alpha: 1, shadow: false,
    });
  });

  // Pop
  await tween(ROTATION_POP_MS, t => {
    for (const fp of floaters) { fp.scale = 1 + 0.15 * t; fp.shadow = t > 0.3; }
  }, easeOutCubic).promise;

  // Targets: each piece moves to the next position in the Y
  const targets = clockwise
    ? [pixelPos[1], pixelPos[2], pixelPos[0]]
    : [pixelPos[2], pixelPos[0], pixelPos[1]];
  const startPos = floaters.map(fp => ({ x: fp.x, y: fp.y }));

  // Arc around center
  await tween(ROTATION_SETTLE_MS * 0.7, t => {
    for (let i = 0; i < 3; i++) {
      const a0 = Math.atan2(startPos[i].y - cy, startPos[i].x - cx);
      const a1 = Math.atan2(targets[i].y - cy, targets[i].x - cx);
      let da = a1 - a0;
      if (clockwise && da > 0) da -= Math.PI * 2;
      if (!clockwise && da < 0) da += Math.PI * 2;
      const angle = a0 + da * t;
      const r0 = Math.hypot(startPos[i].x - cx, startPos[i].y - cy);
      const r1 = Math.hypot(targets[i].x - cx, targets[i].y - cy);
      const radius = r0 + (r1 - r0) * t;
      floaters[i].x = cx + Math.cos(angle) * radius;
      floaters[i].y = cy + Math.sin(angle) * radius;
    }
  }, easeOutCubic).promise;

  // Settle
  await tween(ROTATION_SETTLE_MS * 0.3, t => {
    for (let i = 0; i < 3; i++) {
      floaters[i].x = targets[i].x;
      floaters[i].y = targets[i].y;
      floaters[i].scale = 1 + 0.15 * (1 - t);
      floaters[i].shadow = t < 0.7;
    }
  }, easeOutBounce).promise;

  for (const fp of floaters) removeFloatingPiece(fp);
  clearAllOverrides();

  // Apply the Y-rotation to the grid: rotate the 3 cells
  const saved = yRing.map(h => grid[h.col][h.row]);
  if (clockwise) {
    grid[yRing[0].col][yRing[0].row] = saved[2];
    grid[yRing[1].col][yRing[1].row] = saved[0];
    grid[yRing[2].col][yRing[2].row] = saved[1];
  } else {
    grid[yRing[0].col][yRing[0].row] = saved[1];
    grid[yRing[1].col][yRing[1].row] = saved[2];
    grid[yRing[2].col][yRing[2].row] = saved[0];
  }
}

/**
 * Animate black pearl creation: starflower ring implodes into center,
 * dramatic particle burst, pearl scale-pulse.
 */
async function animateBlackPearlCreation(bpResults) {
  const { originX, originY } = getOrigin();

  for (const bp of bpResults) {
    const centerPx = hexToPixel(bp.center.col, bp.center.row, originX, originY);

    // Mutate center to black pearl now (detection was non-mutating)
    const centerCell = grid[bp.center.col][bp.center.row];
    if (centerCell) {
      centerCell.colorIndex = -2;
      centerCell.special = 'blackpearl';
      delete centerCell.bombTimer;
    }

    // Phase 1: Ring implodes — starflower pieces shrink toward center (400ms)
    await tween(400, t => {
      for (const pos of bp.ring) {
        if (grid[pos.col]?.[pos.row]) {
          const px = hexToPixel(pos.col, pos.row, originX, originY);
          const dx = (centerPx.x - px.x) * t * 0.4;
          const dy = (centerPx.y - px.y) * t * 0.4;
          setCellOverride(pos.col, pos.row, {
            scale: 1 - t * 0.6,
            alpha: 1 - t * 0.7,
            offsetX: dx,
            offsetY: dy,
          });
        }
      }
    }, easeOutCubic).promise;

    // Clear the absorbed starflowers
    for (const pos of bp.ring) {
      grid[pos.col][pos.row] = null;
    }
    clearAllOverrides();

    // Phase 2: Particle burst with deep purple hues
    spawnCreationParticles(centerPx.x, centerPx.y, 24);

    // Phase 3: Pearl scale-pulse (600ms)
    await tween(600, t => {
      let scale;
      if (t < 0.2) {
        scale = 1 + 0.6 * (t / 0.2);
      } else {
        const settleT = (t - 0.2) / 0.8;
        scale = 1.6 - 0.6 * settleT;
      }
      setCellOverride(bp.center.col, bp.center.row, { scale });
    }, easeOutCubic).promise;

    clearAllOverrides();
  }

  // Gravity and refill
  const fallMap = computeFallDistances();
  if (fallMap.length > 0) {
    const maxDist = Math.max(...fallMap.map(f => f.dist));
    const fallDuration = GRAVITY_MS * maxDist;

    const fallers = fallMap.map(f => {
      const startPx = hexToPixel(f.col, f.fromRow, originX, originY);
      const endPx = hexToPixel(f.col, f.toRow, originX, originY);
      setCellOverride(f.col, f.fromRow, { hidden: true });
      return {
        fp: addFloatingPiece({
          x: startPx.x, y: startPx.y,
          colorIndex: f.colorIndex,
          special: f.special,
          bombTimer: f.bombTimer,
          scale: 1, alpha: 1, shadow: false,
        }),
        startY: startPx.y,
        endY: endPx.y,
      };
    });

    await tween(fallDuration, t => {
      for (const f of fallers) {
        f.fp.y = f.startY + (f.endY - f.startY) * t;
      }
    }, easeOutBounce).promise;

    for (const f of fallers) removeFloatingPiece(f.fp);
    clearAllOverrides();
  }

  applyGravity(grid);
  const mode = getActiveGameMode();
  const filled = fillEmpty(grid, undefined, undefined, undefined, mode.hasBombs && bombQueued);
  if (mode.hasBombs && bombQueued && filled.length > 0) bombQueued = false;
}

/** Shared post-rotation logic: tick bombs, cascade or detect specials */
async function postRotationCheck() {
  moveCount++;

  const mode = getActiveGameMode();

  // Tick bomb timers and spawn new bombs only in modes that support them
  if (mode.hasBombs) {
    const bombExpired = tickBombs(grid);
    if (bombExpired && mode.hasGameOver) {
      handleGameOver(false);
      return;
    }
    // Difficulty scaling: dynamically calculate interval based on score
    // Max 15 moves per bomb initially, eventually scaling down to every 4 moves.
    const currentScore = getScore();
    // E.g. spawn interval decreases by 1 for every 5000 score, min 4
    let dynamicInterval = 15 - Math.floor(currentScore / 5000);
    if (dynamicInterval < 4) dynamicInterval = 4;
    
    if (moveCount % dynamicInterval === 0) bombQueued = true;
  }

  const matches = findMatchesForMode(grid, GRID_COLS, GRID_ROWS);
  if (matches.size > 0) {
    state = 'cascading';
    await runCascade(matches);
    selectedCluster = null;
    flowerCenter = null;
    pearlCenter = null;
    state = 'idle';
    resetChain();
    saveGame();
  } else {
    const sfResults = detectStarflowers(grid);
    if (sfResults.length > 0) {
      state = 'cascading';
      await animateStarflowerCreation(sfResults);

      // After starflowers created, check for black pearls
      const bpResults = detectBlackPearls(grid);
      if (bpResults.length > 0) {
        await animateBlackPearlCreation(bpResults);
      }

      // Check if the new arrangement creates matches
      const postMatches = findMatchesForMode(grid, GRID_COLS, GRID_ROWS);
      if (postMatches.size > 0) {
        await runCascade(postMatches);
        selectedCluster = null;
        flowerCenter = null;
        pearlCenter = null;
        state = 'idle';
        resetChain();
        saveGame();
        return;
      }
      state = 'selected';
      saveGame();
    } else {
      // No starflowers, but check for black pearls anyway
      const bpResults = detectBlackPearls(grid);
      if (bpResults.length > 0) {
        state = 'cascading';
        await animateBlackPearlCreation(bpResults);
        state = 'selected';
        saveGame();
      } else {
        state = 'selected';
        saveGame();
      }
    }
  }
}

async function handleGameOver(isSessionEnd = false) {
  state = 'gameover';
  const combinedId = getCombinedModeId();
  clearGameState(combinedId);
  addHighScore(combinedId, getScore());
  console.log('Game/Session Over. High score saved.');

  // 1. Show Game Over Modal (only if not a peaceful chill session end)
  const gameOverMsgEl = document.querySelector('.gameover-message');
  if (!isSessionEnd) {
    document.querySelector('#modal-gameover h2').textContent = 'GAME OVER';
    document.querySelector('#modal-gameover h2').style.color = '#ff4444';
    document.querySelector('#modal-gameover h2').style.borderColor = '#ff4444';
    if (gameOverMsgEl) {
      gameOverMsgEl.style.display = 'block';
      gameOverMsgEl.textContent = '💣 A bomb exploded!';
    }

    document.getElementById('go-score').textContent = getScore().toLocaleString();
    document.getElementById('go-combo').textContent = `x${getComboCount()}`;
    document.getElementById('modal-gameover').classList.remove('hidden');
  }

  // 2. Explode the board!
  const { originX, originY } = getOrigin();
  const floaters = [];

  for (let c = 0; c < GRID_COLS; c++) {
    for (let r = 0; r < GRID_ROWS; r++) {
      if (grid[c][r]) {
        const px = hexToPixel(c, r, originX, originY);
        
        // Create a floater that flies away from center
        const dx = px.x - (originX + (GRID_COLS * 30)); // Rough center approx
        const dy = px.y - (originY + (GRID_ROWS * 30));
        const angle = Math.atan2(dy, dx);
        const speed = 10 + Math.random() * 20;

        const fp = addFloatingPiece({
          x: px.x, y: px.y,
          colorIndex: grid[c][r].colorIndex,
          special: grid[c][r].special,
          scale: 1, alpha: 1, shadow: false
        });
        
        // We'll attach velocity to the floater object strictly for this animation loop
        // (renderer doesn't use vx/vy, so we'll tween or manually update)
        // Let's use a quick tween to blast them off
        floaters.push({
            fp, 
            vx: Math.cos(angle) * speed, 
            vy: Math.sin(angle) * speed,
            rot: (Math.random() - 0.5) * 0.5
        });
        
        // Clear grid cell immediately so drawFrame doesn't show it
        grid[c][r] = null;
      }
    }
  }

  // Animate the explosion
  // We can do a custom loop or just a tween that updates them
  await tween(1500, t => {
    for (const item of floaters) {
      item.fp.x += item.vx;
      item.fp.y += item.vy;
      item.fp.vy += 0.5; // Gravity
      item.fp.alpha = 1 - t; // Fade out
      // item.fp.rotation += item.rot; // Renderer doesn't support rotation yet, but that's fine
    }
  }, easeOutCubic).promise;

  // Cleanup
  for (const item of floaters) {
    removeFloatingPiece(item.fp);
  }

  if (isSessionEnd) {
    resetGame();
  }
}

function resetGame() {
  resetScore();
  resetChain();
  grid = createGrid();
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

/**
 * Animate a starflower being created: flash ring tiles, shrink/fade them,
 * clear them, gravity, refill.
 * @param {Array<{center, ring, ringColor}>} sfResults
 */
async function animateStarflowerCreation(sfResults) {
  // Collect all ring positions across all starflowers
  const allRing = [];
  const centers = [];
  for (const sf of sfResults) {
    centers.push(sf.center);
    for (const pos of sf.ring) {
      allRing.push(pos);
    }
  }
  if (allRing.length === 0) return;

  const { originX, originY } = getOrigin();

  // Phase 1: Flash ring tiles bright (200ms)
  await tween(200, t => {
    for (const pos of allRing) {
      if (grid[pos.col]?.[pos.row]) {
        setCellOverride(pos.col, pos.row, {
          scale: 1 + 0.15 * t,
        });
      }
    }
  }, easeOutCubic).promise;

  // Phase 2: Shrink and fade ring tiles (300ms)
  await tween(300, t => {
    for (const pos of allRing) {
      if (grid[pos.col]?.[pos.row]) {
        setCellOverride(pos.col, pos.row, {
          scale: (1.15) * (1 - t * 0.9),
          alpha: 1 - t,
        });
      }
    }
  }, easeOutCubic).promise;

  // Clear ring tiles
  console.log('Clearing ring tiles. Count:', allRing.length);
  for (const pos of allRing) {
    console.log(`Clearing ${pos.col},${pos.row}. Was:`, grid[pos.col][pos.row]);
    grid[pos.col][pos.row] = null;
  }
  clearAllOverrides();

  // ── Phase 3: CELEBRATION — star piece appears with flair ──────

  // Spawn particle bursts from each star center
  for (const center of centers) {
    const px = hexToPixel(center.col, center.row, originX, originY);
    spawnCreationParticles(px.x, px.y, 20);
  }

  // Mutate center to be a Starflower
  for (const center of centers) {
    if (grid[center.col] && grid[center.col][center.row]) {
      grid[center.col][center.row].colorIndex = -1;
      grid[center.col][center.row].special = 'starflower';
      delete grid[center.col][center.row].bombTimer;
    }
  }

  // Star piece pulse: scale up big then settle
  await tween(500, t => {
    for (const center of centers) {
      // Sharp pop then smooth settle
      let scale;
      if (t < 0.25) {
        // Rapid expand 1.0 → 1.5
        scale = 1 + 0.5 * (t / 0.25);
      } else {
        // Smooth settle 1.5 → 1.0
        const settleT = (t - 0.25) / 0.75;
        scale = 1.5 - 0.5 * settleT;
      }

      setCellOverride(center.col, center.row, {
        scale,
      });
    }
  }, easeOutCubic).promise;

  clearAllOverrides();

  // Animated gravity
  const fallMap = computeFallDistances();
  if (fallMap.length > 0) {
    const maxDist = Math.max(...fallMap.map(f => f.dist));
    const fallDuration = GRAVITY_MS * maxDist;

    const fallers = fallMap.map(f => {
      const startPx = hexToPixel(f.col, f.fromRow, originX, originY);
      const endPx = hexToPixel(f.col, f.toRow, originX, originY);
      setCellOverride(f.col, f.fromRow, { hidden: true });
      return {
        fp: addFloatingPiece({
          x: startPx.x, y: startPx.y,
          colorIndex: f.colorIndex,
          special: f.special,
          bombTimer: f.bombTimer,
          scale: 1, alpha: 1, shadow: false,
        }),
        startY: startPx.y,
        endY: endPx.y,
      };
    });

    await tween(fallDuration, t => {
      for (const f of fallers) {
        f.fp.y = f.startY + (f.endY - f.startY) * t;
      }
    }, easeOutBounce).promise;

    for (const f of fallers) removeFloatingPiece(f.fp);
    clearAllOverrides();
  }

  applyGravity(grid);
  {
    const mode = getActiveGameMode();
    const filled = fillEmpty(grid, undefined, undefined, undefined, mode.hasBombs && bombQueued);
    if (mode.hasBombs && bombQueued && filled.length > 0) bombQueued = false;
  }
}

async function startCascade() {
  state = 'cascading';

  const matches = findMatchesForMode(grid, GRID_COLS, GRID_ROWS);
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

async function runCascade(initialMatches) {
  const pendingMatches = new Set(initialMatches);
  const multiplierClusters = detectMultiplierClusters(grid);

  // 1. Merge multiplier clusters into pendingMatches
  const explosionSources = [];
  const colorNukeColors = new Set();
  let scoreBonus = 1;

  for (const cluster of multiplierClusters) {
    const clusterArr = Array.from(cluster);
    // Add to pending
    for (const key of cluster) pendingMatches.add(key);

    // Analyze colors
    const colors = new Set(clusterArr.map(k => {
      const [c,r] = k.split(',').map(Number);
      return grid[c][r].colorIndex;
    }));

    if (colors.size === 1) {
      // Same color -> Color Nuke
      colorNukeColors.add(colors.values().next().value);
    } else {
      // Mixed color -> Explosion
      const firstKey = clusterArr[0];
      const [c,r] = firstKey.split(',').map(Number);
      // Use center of mass or just all cells as source?
      // Requirement: "clear those pieces along with every single tile immediately surrounding them"
      // We will add all cluster cells as explosion sources
      for (const k of cluster) explosionSources.push(k);
    }
    scoreBonus += 0.5 * cluster.size; // Bonus for multiplier clusters
  }

  // 2. Check for Bomb + Multiplier (Same Color) in pendingMatches
  //    (This covers the case where findMatches caught them or they were added above)
  const colorPresence = {}; // colorIndex -> { hasBomb: bool, hasMultiplier: bool }
  for (const key of pendingMatches) {
    const [c,r] = key.split(',').map(Number);
    const cell = grid[c][r];
    if (!cell) continue;
    const color = cell.colorIndex;
    if (!colorPresence[color]) colorPresence[color] = { hasBomb: false, hasMultiplier: false };
    
    if (cell.special === 'bomb') colorPresence[color].hasBomb = true;
    if (cell.special === 'multiplier') {
      colorPresence[color].hasMultiplier = true;
      scoreBonus += 0.5; // Bonus for any cleared multiplier
    }
  }

  for (const color in colorPresence) {
    if (colorPresence[color].hasBomb && colorPresence[color].hasMultiplier) {
      colorNukeColors.add(Number(color));
    }
  }

  // 3. Apply Actions (expand pendingMatches)
  
  // Color Nuke
  if (colorNukeColors.size > 0) {
    for (let c = 0; c < GRID_COLS; c++) {
      for (let r = 0; r < GRID_ROWS; r++) {
        if (grid[c][r] && colorNukeColors.has(grid[c][r].colorIndex)) {
            // Exclude starflowers/blackpearls from color nuke?
            // "clearing the bomb and all other tiles of that color"
            // Usually specials like starflower (color -1) aren't targeted by normal colors (0-5).
            if (grid[c][r].colorIndex >= 0) {
              pendingMatches.add(`${c},${r}`);
            }
        }
      }
    }
  }

  // Explosion
  for (const srcKey of explosionSources) {
    const [c, r] = srcKey.split(',').map(Number);
    const nbrs = getNeighbors(c, r);
    for (const n of nbrs) {
      if (n.col >= 0 && n.col < GRID_COLS && n.row >= 0 && n.row < GRID_ROWS) {
        // Explode neighbors (unless they are indestuctible?)
        if (grid[n.col][n.row] && grid[n.col][n.row].special !== 'blackpearl') { // Assume pearls are hard
             pendingMatches.add(`${n.col},${n.row}`);
        }
      }
    }
  }

  const matches = pendingMatches;

  // ── Flash matched cells ────────────────────────────────────
  await tween(MATCH_FLASH_MS, t => {
    for (const key of matches) {
      const [c, r] = key.split(',').map(Number);
      if (grid[c][r]) { // Start check: cell might be null if processed? No, we haven't cleared yet.
        if (t < 0.3) {
          setCellOverride(c, r, { scale: 1 + 0.1 * (t / 0.3) });
        } else {
          const fadeT = (t - 0.3) / 0.7;
          setCellOverride(c, r, {
            scale: 1.1 * (1 - fadeT * 0.8),
            alpha: 1 - fadeT,
          });
        }
      }
    }
  }, easeOutCubic).promise;

  // ── Remove matched cells ───────────────────────────────────
  const points = awardMatch(matches.size, scoreBonus);

  // Floating score popup at centroid of cleared cells
  {
    const { originX, originY } = getOrigin();
    let sumX = 0, sumY = 0;
    for (const key of matches) {
      const [c, r] = key.split(',').map(Number);
      const px = hexToPixel(c, r, originX, originY);
      sumX += px.x;
      sumY += px.y;
    }
    spawnScorePopup(sumX / matches.size, sumY / matches.size, points, getChainLevel());
  }

  for (const key of matches) {
    const [c, r] = key.split(',').map(Number);
    grid[c][r] = null;
  }
  clearAllOverrides();

  // ── Starflower detection at cleared positions ──────────────
  const sfMid = detectStarflowersAtCleared(grid, matches);
  if (sfMid.length > 0) {
    await animateStarflowerCreation(sfMid);

    // Check for black pearls immediately formed by these new starflowers
    const bpMid = detectBlackPearls(grid);
    if (bpMid.length > 0) {
      await animateBlackPearlCreation(bpMid);
    }
  }

  // ── Gravity: animate pieces falling ────────────────────────
  const fallMap = computeFallDistances();

  if (fallMap.length > 0) {
    const maxDist = Math.max(...fallMap.map(f => f.dist));
    const fallDuration = GRAVITY_MS * maxDist;
    const { originX, originY } = getOrigin();

    const fallers = fallMap.map(f => {
      const startPx = hexToPixel(f.col, f.fromRow, originX, originY);
      const endPx = hexToPixel(f.col, f.toRow, originX, originY);
      setCellOverride(f.col, f.fromRow, { hidden: true });
      return {
        fp: addFloatingPiece({
          x: startPx.x,
          y: startPx.y,
          colorIndex: f.colorIndex,
          special: f.special,
          bombTimer: f.bombTimer,
          scale: 1,
          alpha: 1,
          shadow: false,
        }),
        startY: startPx.y,
        endY: endPx.y,
        x: startPx.x,
      };
    });

    await tween(fallDuration, t => {
      for (const f of fallers) {
        f.fp.y = f.startY + (f.endY - f.startY) * t;
      }
    }, easeOutBounce).promise;

    for (const f of fallers) removeFloatingPiece(f.fp);
    clearAllOverrides();
  }

  // Commit gravity and fill
  applyGravity(grid);
  {
    const mode = getActiveGameMode();
    const filled = fillEmpty(grid, undefined, undefined, undefined, mode.hasBombs && bombQueued);
    if (mode.hasBombs && bombQueued && filled.length > 0) bombQueued = false;
  }

  // ── Starflower detection (after board settles) ─────────────
  const sfPost = detectStarflowers(grid);
  if (sfPost.length > 0) {
    await animateStarflowerCreation(sfPost);

    // After starflowers created, check for black pearls
    const bpPost = detectBlackPearls(grid);
    if (bpPost.length > 0) {
      await animateBlackPearlCreation(bpPost);
    }
  } else {
    // If no new starflowers, existing ones might still have formed a black pearl
    // (e.g. if the rotation formed a pearl + a match elsewhere)
    const bpPost = detectBlackPearls(grid);
    if (bpPost.length > 0) {
      await animateBlackPearlCreation(bpPost);
    }
  }

  advanceChain();

  // ── Check for chain reactions ──────────────────────────────
  const newMatches = findMatchesForMode(grid, GRID_COLS, GRID_ROWS);
  if (newMatches.size > 0) {
    await delay(100);
    await runCascade(newMatches);
  }
}

/**
 * Compute how far each non-null cell needs to fall.
 * Returns [{ col, fromRow, toRow, dist, colorIndex }]
 */
function computeFallDistances() {
  const result = [];
  for (let c = 0; c < GRID_COLS; c++) {
    let writeRow = GRID_ROWS - 1;
    for (let r = GRID_ROWS - 1; r >= 0; r--) {
      if (grid[c][r] !== null) {
        if (r !== writeRow) {
          result.push({
            col: c,
            fromRow: r,
            toRow: writeRow,
            dist: writeRow - r,
            colorIndex: grid[c][r].colorIndex,
            special: grid[c][r].special,
            bombTimer: grid[c][r].bombTimer,
          });
        }
        writeRow--;
      }
    }
  }
  return result;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
