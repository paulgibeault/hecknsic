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
  createGrid, rotateCluster, rotateRing, findMatches,
  applyGravity, fillEmpty,
} from './board.js';
import {
  initRenderer, resize, drawFrame, getOrigin,
  setCellOverride, clearAllOverrides,
  addFloatingPiece, removeFloatingPiece,
  spawnCreationParticles,
} from './renderer.js';
import { hexToPixel, getNeighbors, pixelToHex, findClusterAtPixel } from './hex-math.js';
import { initInput, getHoverCluster, consumeAction, getLastClickPos, triggerAction } from './input.js';
import { tween, updateTweens, easeOutCubic, easeOutBounce } from './tween.js';
import {
  resetScore, awardMatch, advanceChain, resetChain,
  updateDisplayScore,
} from './score.js';
import {
  detectStarflowers, detectStarflowersAtCleared,
  detectBlackPearls, detectMultiplierClusters,
  tickBombs, countBombs,
} from './specials.js';

// ─── Game state ─────────────────────────────────────────────────
let grid;
let state = 'idle';  // 'idle' | 'selected' | 'rotating' | 'cascading' | 'gameover'
let selectedCluster = null;
let flowerCenter = null;     // {col,row} if a starflower ring is selected
let pearlCenter = null;      // {col,row} if a black pearl Y-shape is selected
let lastTime = 0;
let moveCount = 0;           // total player moves (for bomb spawn timing)
let bombQueued = false;

// ─── Bootstrap ──────────────────────────────────────────────────

const canvas = document.getElementById('game');
initRenderer(canvas);
initInput(canvas);

// UI bindings
const controlsEl = document.getElementById('controls');
document.getElementById('btn-ccw').addEventListener('click', (e) => {
  e.stopPropagation(); // prevent canvas click
  triggerAction('rotateCCW');
});
document.getElementById('btn-cw').addEventListener('click', (e) => {
  e.stopPropagation();
  triggerAction('rotateCW');
});

function updateControlsVisibility() {
  if (state === 'selected') {
    controlsEl.classList.remove('hidden');
  } else {
    controlsEl.classList.add('hidden');
  }
}

window.addEventListener('resize', () => resize(canvas));

resetScore();
grid = createGrid();
state = 'idle';

requestAnimationFrame(gameLoop);

// ─── Game loop ──────────────────────────────────────────────────

function gameLoop(timestamp) {
  const dt = lastTime ? timestamp - lastTime : 16;
  lastTime = timestamp;

  updateTweens(timestamp);
  updateDisplayScore(dt);

  // Game over: just render, no input
  if (state === 'gameover') {
    drawFrame(grid, null, null);
    drawGameOver();
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

// ─── Rotation animation ────────────────────────────────────────

async function animateRotation(clockwise) {
  if (state !== 'selected') return;
  state = 'rotating';

  const { originX, originY } = getOrigin();
  
  // Determine max steps based on selection type
  // Starflower ring = 6 steps for full rotation
  // Cluster / Black Pearl (Y) = 3 steps for full rotation
  let maxSteps = 3;
  if (flowerCenter) maxSteps = 6;

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
    const matches = findMatches(grid, GRID_COLS, GRID_ROWS);
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
  const filled = fillEmpty(grid, undefined, undefined, undefined, bombQueued);
  if (bombQueued && filled.length > 0) bombQueued = false;
}

/** Shared post-rotation logic: tick bombs, cascade or detect specials */
async function postRotationCheck() {
  moveCount++;

  // Tick bomb timers
  const bombExpired = tickBombs(grid);
  if (bombExpired) {
    state = 'gameover';
    return;
  }

  // Spawn bombs periodically (queue for next fill)
  if (moveCount > 0 && moveCount % BOMB_SPAWN_INTERVAL === 0) {
    bombQueued = true;
  }

  const matches = findMatches(grid, GRID_COLS, GRID_ROWS);
  if (matches.size > 0) {
    state = 'cascading';
    await runCascade(matches);
    selectedCluster = null;
    flowerCenter = null;
    pearlCenter = null;
    state = 'idle';
    resetChain();
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
      const postMatches = findMatches(grid, GRID_COLS, GRID_ROWS);
      if (postMatches.size > 0) {
        await runCascade(postMatches);
        selectedCluster = null;
        flowerCenter = null;
        pearlCenter = null;
        state = 'idle';
        resetChain();
        return;
      }
      state = 'selected';
    } else {
      // No starflowers, but check for black pearls anyway
      const bpResults = detectBlackPearls(grid);
      if (bpResults.length > 0) {
        state = 'cascading';
        await animateBlackPearlCreation(bpResults);
        state = 'selected';
      } else {
        state = 'selected';
      }
    }
  }
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
  for (const pos of allRing) {
    grid[pos.col][pos.row] = null;
  }
  clearAllOverrides();

  // ── Phase 3: CELEBRATION — star piece appears with flair ──────

  // Spawn particle bursts from each star center
  for (const center of centers) {
    const px = hexToPixel(center.col, center.row, originX, originY);
    spawnCreationParticles(px.x, px.y, 20);
  }

  // Star piece pulse: scale up big then settle (500ms)
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

      // White flash overlay that fades
      const flashAlpha = t < 0.2 ? (t / 0.2) * 0.6 : 0.6 * (1 - ((t - 0.2) / 0.8));

      setCellOverride(center.col, center.row, {
        scale,
        // We'll encode flash for the renderer as a "glow" via scale
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
  const filled = fillEmpty(grid, undefined, undefined, undefined, bombQueued);
  if (bombQueued && filled.length > 0) bombQueued = false;
}

async function startCascade() {
  state = 'cascading';

  const matches = findMatches(grid, GRID_COLS, GRID_ROWS);
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
  awardMatch(matches.size, scoreBonus);
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
  const filled = fillEmpty(grid, undefined, undefined, undefined, bombQueued);
  if (bombQueued && filled.length > 0) bombQueued = false;

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
  const newMatches = findMatches(grid, GRID_COLS, GRID_ROWS);
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

function drawGameOver() {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#FF4040';
  ctx.font = 'bold 48px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('GAME OVER', canvas.width / 2, canvas.height / 2 - 30);

  ctx.fillStyle = '#D0D0D8';
  ctx.font = '20px "Segoe UI", system-ui, sans-serif';
  ctx.fillText('💣 A bomb exploded!', canvas.width / 2, canvas.height / 2 + 20);
  ctx.fillText('Refresh to play again', canvas.width / 2, canvas.height / 2 + 50);
  ctx.restore();
}
