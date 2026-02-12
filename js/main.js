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
  BOMB_INITIAL_TIMER, BOMB_SPAWN_INTERVAL,
} from './constants.js';
import {
  createGrid, rotateCluster, rotateRing, findMatches,
  applyGravity, fillEmpty,
} from './board.js';
import {
  initRenderer, resize, drawFrame, getOrigin,
  setCellOverride, clearAllOverrides,
  addFloatingPiece, removeFloatingPiece,
} from './renderer.js';
import { hexToPixel, getNeighbors, pixelToHex } from './hex-math.js';
import { initInput, getHoverCluster, consumeAction, getLastClickPos } from './input.js';
import { tween, updateTweens, easeOutCubic, easeOutBounce } from './tween.js';
import {
  resetScore, awardMatch, advanceChain, resetChain,
  updateDisplayScore,
} from './score.js';
import {
  detectStarflowers, detectStarflowersAtCleared,
  spawnBomb, tickBombs, countBombs,
} from './specials.js';

// ─── Game state ─────────────────────────────────────────────────
let grid;
let state = 'idle';  // 'idle' | 'selected' | 'rotating' | 'cascading' | 'gameover'
let selectedCluster = null;
let flowerCenter = null;     // {col,row} if a starflower ring is selected
let lastTime = 0;
let moveCount = 0;           // total player moves (for bomb spawn timing)

// ─── Bootstrap ──────────────────────────────────────────────────

const canvas = document.getElementById('game');
initRenderer(canvas);
initInput(canvas);

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
    return;
  }

  // Check if the clicked hex is a flower
  const hex = pixelToHex(clickPos.x, clickPos.y, originX, originY);
  if (hex.col >= 0 && hex.col < GRID_COLS &&
      hex.row >= 0 && hex.row < GRID_ROWS &&
      grid[hex.col]?.[hex.row]?.special === 'starflower') {
    // Select the flower ring: center + 6 neighbors
    const nbrs = getNeighbors(hex.col, hex.row);
    const allInBounds = nbrs.every(n =>
      n.col >= 0 && n.col < GRID_COLS && n.row >= 0 && n.row < GRID_ROWS
    );
    if (allInBounds) {
      flowerCenter = { col: hex.col, row: hex.row };
      selectedCluster = [{ col: hex.col, row: hex.row }, ...nbrs];
      state = 'selected';
      return;
    }
  }

  // Normal 3-hex cluster selection
  const cluster = getHoverCluster();
  if (cluster) {
    flowerCenter = null;
    selectedCluster = cluster;
    state = 'selected';
  } else {
    selectedCluster = null;
    flowerCenter = null;
  }
}

// ─── Rotation animation ────────────────────────────────────────

async function animateRotation(clockwise) {
  if (state !== 'selected') return;
  state = 'rotating';

  const { originX, originY } = getOrigin();

  if (flowerCenter) {
    await animateRingRotation(clockwise, originX, originY);
  } else {
    await animateClusterRotation(clockwise, originX, originY);
  }
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

  await postRotationCheck();
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

  await postRotationCheck();
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

  // Spawn bombs periodically
  if (moveCount > 0 && moveCount % BOMB_SPAWN_INTERVAL === 0) {
    spawnBomb(grid, BOMB_INITIAL_TIMER);
  }

  const matches = findMatches(grid, GRID_COLS, GRID_ROWS);
  if (matches.size > 0) {
    state = 'cascading';
    await runCascade(matches);
    selectedCluster = null;
    flowerCenter = null;
    state = 'idle';
    resetChain();
  } else {
    detectStarflowers(grid);
    state = 'selected';
  }
}

// ─── Cascade logic ──────────────────────────────────────────────

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

async function runCascade(matches) {
  // ── Flash matched cells ────────────────────────────────────
  await tween(MATCH_FLASH_MS, t => {
    for (const key of matches) {
      const [c, r] = key.split(',').map(Number);
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
  }, easeOutCubic).promise;

  // ── Remove matched cells ───────────────────────────────────
  awardMatch(matches.size);
  for (const key of matches) {
    const [c, r] = key.split(',').map(Number);
    grid[c][r] = null;
  }
  clearAllOverrides();

  // ── Starflower detection at cleared positions ──────────────
  detectStarflowersAtCleared(grid, matches);

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
  fillEmpty(grid);

  // ── Starflower detection (after board settles) ─────────────
  detectStarflowers(grid);

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
