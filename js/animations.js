import {
  MATCH_FLASH_MS, GRAVITY_MS,
  ROTATION_POP_MS, ROTATION_SETTLE_MS
} from './constants.js';
import { rotateCluster, rotateRing, applyGravity, fillEmpty } from './board.js';
import {
  setCellOverride, clearCellOverride, clearAllOverrides,
  addFloatingPiece, removeFloatingPiece,
  spawnCreationParticles, spawnRingShockwave, requestRedraw,
  spawnColorNukeParticles, spawnExplosionParticles, spawnScorePopup, flashScreenOverlay,
  getOrigin
} from './renderer.js';
import { getActiveGameMode } from './modes.js';
import { hexToPixel, getNeighbors } from './hex-math.js';
import { tween, easeOutCubic, easeOutBounce } from './tween.js';
import { awardMatch, advanceChain, getDisplayScore, getChainLevel, getScore, getComboCount, getMaxCombo } from './score.js';
import {
  detectStarflowersAtCleared, detectBlackPearls, detectMultiplierClusters
} from './specials.js';
import { onStarflowerCreated } from './puzzle-mode.js';


/** Animate 3-hex cluster rotation (original pop-thunk) */
export async function animateClusterRotation(ctx, clockwise, originX, originY) {
  const cluster = ctx.selectedCluster;
  const pixelPos = cluster.map(h => hexToPixel(h.col, h.row, originX, originY));
  const cx = (pixelPos[0].x + pixelPos[1].x + pixelPos[2].x) / 3;
  const cy = (pixelPos[0].y + pixelPos[1].y + pixelPos[2].y) / 3;
  const cells = cluster.map(h => ctx.grid[h.col]?.[h.row]);
  if (cells.some(c => !c)) { ctx.setState('idle'); return; }
  const colors = cells.map(c => c.colorIndex);
  const specials = cells.map(c => c.special);

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
  rotateCluster(ctx.grid, cluster, clockwise);
}

/** Animate 6-hex ring rotation around flower center */
export async function animateRingRotation(ctx, clockwise, originX, originY) {
  const center = ctx.flowerCenter;
  const ring = getNeighbors(center.col, center.row);
  const centerPx = hexToPixel(center.col, center.row, originX, originY);
  const cx = centerPx.x;
  const cy = centerPx.y;

  const pixelPos = ring.map(h => hexToPixel(h.col, h.row, originX, originY));
  const ringCells = ring.map(h => ctx.grid[h.col]?.[h.row]);
  if (ringCells.some(c => !c)) { ctx.setState('idle'); return; }
  const colors = ringCells.map(c => c.colorIndex);
  const specials = ringCells.map(c => c.special);

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
  rotateRing(ctx.grid, ring, clockwise);
}

/** Animate 3-hex Y-shape rotation around black pearl center */
export async function animateYRotation(ctx, clockwise, originX, originY) {
  const center = ctx.pearlCenter;
  const nbrs = getNeighbors(center.col, center.row);
  // Y-shape uses alternating neighbors (0, 2, 4)
  const yRing = [nbrs[0], nbrs[2], nbrs[4]];
  const centerPx = hexToPixel(center.col, center.row, originX, originY);
  const cx = centerPx.x;
  const cy = centerPx.y;

  const pixelPos = yRing.map(h => hexToPixel(h.col, h.row, originX, originY));
  const yCells = yRing.map(h => ctx.grid[h.col]?.[h.row]);
  if (yCells.some(c => !c)) { ctx.setState('idle'); return; }
  const colors = yCells.map(c => c.colorIndex);
  const specials = yCells.map(c => c.special);

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

  // Apply the Y-rotation to the ctx.grid: rotate the 3 cells
  const saved = yRing.map(h => ctx.grid[h.col]?.[h.row]);
  if (saved.some(c => !c)) return; // board was replaced or cells cleared
  if (clockwise) {
    ctx.grid[yRing[0].col][yRing[0].row] = saved[2];
    ctx.grid[yRing[1].col][yRing[1].row] = saved[0];
    ctx.grid[yRing[2].col][yRing[2].row] = saved[1];
  } else {
    ctx.grid[yRing[0].col][yRing[0].row] = saved[1];
    ctx.grid[yRing[1].col][yRing[1].row] = saved[2];
    ctx.grid[yRing[2].col][yRing[2].row] = saved[0];
  }
}

/**
 * Animate black pearl creation: starflower ring implodes into center,
 * dramatic particle burst, pearl scale-pulse.
 */
export async function animateBlackPearlCreation(ctx, bpResults) {
  const gen = ctx.boardGeneration;
  const { originX, originY } = getOrigin();

  let queuedBlackpearls = 0;
  for (const bp of bpResults) {
    const centerPx = hexToPixel(bp.center.col, bp.center.row, originX, originY);

    if (bp.centerAlreadySpecial) {
      queuedBlackpearls++;
    } else {
      const centerCell = ctx.grid[bp.center.col]?.[bp.center.row];
      if (centerCell) {
        centerCell.colorIndex = -2;
        centerCell.special = 'blackpearl';
        delete centerCell.bombTimer;
      }
    }

    // Phase 1: Ring implodes — starflower pieces shrink toward center (400ms)
    await tween(400, t => {
      for (const pos of bp.ring) {
        if (ctx.grid[pos.col]?.[pos.row]) {
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
    if (ctx.boardGeneration !== gen) return;

    // Clear the absorbed starflowers
    for (const pos of bp.ring) {
      if (ctx.grid[pos.col]?.[pos.row] && ctx.grid[pos.col][pos.row].special !== 'grandpoobah') {
        ctx.grid[pos.col][pos.row] = null;
      }
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
    if (ctx.boardGeneration !== gen) return;

    clearAllOverrides();
  }

  // Gravity and refill
  const fallMap = computeFallDistances(ctx);
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
    if (ctx.boardGeneration !== gen) { for (const f of fallers) removeFloatingPiece(f.fp); return; }

    for (const f of fallers) removeFloatingPiece(f.fp);
    clearAllOverrides();
  }

  applyGravity(ctx.grid, ctx.activeCols, ctx.activeRows);
  const mode = getActiveGameMode();
  const filled = fillEmpty(ctx.grid, ctx.activeCols, ctx.activeRows, undefined, mode.hasBombs && ctx.bombQueued, { starflowers: 0, blackpearls: queuedBlackpearls }, mode.isPuzzle);
  if (mode.hasBombs && ctx.bombQueued && filled.length > 0) ctx.setBombQueued(false);
}

export async function animateGrandPoobahCreation(ctx, gpResults) {
  const gen = ctx.boardGeneration;
  const { originX, originY } = getOrigin();
  let queuedGrandPoobahs = 0;

  for (const gp of gpResults) {
    const centerPx = hexToPixel(gp.center.col, gp.center.row, originX, originY);

    if (gp.centerAlreadySpecial) {
      queuedGrandPoobahs++;
    } else {
      const centerCell = ctx.grid[gp.center.col]?.[gp.center.row];
      if (centerCell) {
        centerCell.colorIndex = -3;
        centerCell.special = 'grandpoobah';
        delete centerCell.bombTimer;
      }
    }

    // Phase 1: Ring implodes
    await tween(400, t => {
      for (const pos of gp.ring) {
        if (ctx.grid[pos.col]?.[pos.row]) {
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
    if (ctx.boardGeneration !== gen) return;

    for (const pos of gp.ring) {
      if (ctx.grid[pos.col]?.[pos.row] && ctx.grid[pos.col][pos.row].special !== 'grandpoobah') {
        ctx.grid[pos.col][pos.row] = null;
      }
    }
    clearAllOverrides();

    // Phase 2: Majestic particle burst
    spawnCreationParticles(centerPx.x, centerPx.y, 40);

    // Phase 3: Pulse
    await tween(800, t => {
      let scale;
      if (t < 0.2) {
        scale = 1 + 0.8 * (t / 0.2);
      } else {
        const settleT = (t - 0.2) / 0.8;
        scale = 1.8 - 0.8 * settleT;
      }
      setCellOverride(gp.center.col, gp.center.row, { scale });
    }, easeOutCubic).promise;
    if (ctx.boardGeneration !== gen) return;

    clearAllOverrides();
  }

  // Gravity and refill
  const fallMap = computeFallDistances(ctx);
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
      for (const f of fallers) f.fp.y = f.startY + (f.endY - f.startY) * t;
    }, easeOutBounce).promise;
    if (ctx.boardGeneration !== gen) { for (const f of fallers) removeFloatingPiece(f.fp); return; }

    for (const f of fallers) removeFloatingPiece(f.fp);
    clearAllOverrides();
  }

  applyGravity(ctx.grid, ctx.activeCols, ctx.activeRows);
  const mode = getActiveGameMode();
  const filled = fillEmpty(ctx.grid, ctx.activeCols, ctx.activeRows, undefined, mode.hasBombs && ctx.bombQueued, { starflowers: 0, blackpearls: 0, grandpoobahs: queuedGrandPoobahs }, mode.isPuzzle);
  if (mode.hasBombs && ctx.bombQueued && filled.length > 0) ctx.setBombQueued(false);

  ctx.handleGameWin();
}

export async function handleOverAchiever(ctx) {
  ctx.setState('gameover');
  const combinedId = ctx.getCombinedModeId();
  ctx.clearGameState(combinedId);
  ctx.addHighScore(combinedId, getScore(), 'over-achiever');

  document.getElementById('go-oa-score').textContent = getScore().toLocaleString();
  document.getElementById('go-oa-combo').textContent = `x${getMaxCombo()}`;
  document.getElementById('modal-over-achiever').classList.remove('hidden');

  // Board explosion (reuse game-over explosion aesthetic)
  const { originX, originY } = getOrigin();
  const floaters = [];

  for (let c = 0; c < ctx.activeCols; c++) {
    for (let r = 0; r < ctx.activeRows; r++) {
      if (ctx.grid[c][r]) {
        const px = hexToPixel(c, r, originX, originY);
        const dx = px.x - (originX + (ctx.activeCols * 30));
        const dy = px.y - (originY + (ctx.activeRows * 30));
        const angle = Math.atan2(dy, dx);
        const speed = 10 + Math.random() * 20;

        const fp = addFloatingPiece({
          x: px.x, y: px.y,
          colorIndex: ctx.grid[c][r].colorIndex,
          special: ctx.grid[c][r].special,
          scale: 1, alpha: 1, shadow: false
        });

        floaters.push({
          fp,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          rot: (Math.random() - 0.5) * 0.5
        });

        ctx.grid[c][r] = null;
      }
    }
  }

  await tween(1500, t => {
    for (const item of floaters) {
      item.fp.x += item.vx;
      item.fp.y += item.vy;
      item.fp.vy += 0.5;
      item.fp.alpha = 1 - t;
    }
  }, easeOutCubic).promise;

  for (const item of floaters) {
    removeFloatingPiece(item.fp);
  }
}

export async function handleGameOver(ctx, isSessionEnd = false) {
  ctx.setState('gameover');
  const combinedId = ctx.getCombinedModeId();
  ctx.clearGameState(combinedId);
  ctx.addHighScore(combinedId, getScore());
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
    document.getElementById('go-combo').textContent = `x${getMaxCombo()}`;
    document.getElementById('modal-gameover').classList.remove('hidden');
  }

  // 2. Explode the board!
  const { originX, originY } = getOrigin();
  const floaters = [];

  for (let c = 0; c < ctx.activeCols; c++) {
    for (let r = 0; r < ctx.activeRows; r++) {
      if (ctx.grid[c][r]) {
        const px = hexToPixel(c, r, originX, originY);
        
        // Create a floater that flies away from center
        const dx = px.x - (originX + (ctx.activeCols * 30)); // Rough center approx
        const dy = px.y - (originY + (ctx.activeRows * 30));
        const angle = Math.atan2(dy, dx);
        const speed = 10 + Math.random() * 20;

        const fp = addFloatingPiece({
          x: px.x, y: px.y,
          colorIndex: ctx.grid[c][r].colorIndex,
          special: ctx.grid[c][r].special,
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
        
        // Clear ctx.grid cell immediately so drawFrame doesn't show it
        ctx.grid[c][r] = null;
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
    ctx.resetGame();
  }
}

/**
 * Animate a starflower being created: flash ring tiles, shrink/fade them,
 * clear them, gravity, refill.
 * @param {Array<{center, ring, ringColor}>} sfResults
 */
export async function animateStarflowerCreation(ctx, sfResults) {
  const gen = ctx.boardGeneration;
  // Track for puzzle goals
  for (const _ of sfResults) onStarflowerCreated();

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
      if (ctx.grid[pos.col]?.[pos.row]) {
        setCellOverride(pos.col, pos.row, {
          scale: 1 + 0.15 * t,
        });
      }
    }
  }, easeOutCubic).promise;
  if (ctx.boardGeneration !== gen) return;

  // Phase 2: Shrink and fade ring tiles (300ms)
  await tween(300, t => {
    for (const pos of allRing) {
      if (ctx.grid[pos.col]?.[pos.row]) {
        setCellOverride(pos.col, pos.row, {
          scale: (1.15) * (1 - t * 0.9),
          alpha: 1 - t,
        });
      }
    }
  }, easeOutCubic).promise;
  if (ctx.boardGeneration !== gen) return;

  // Clear ring tiles
  for (const pos of allRing) {
    if (ctx.grid[pos.col]?.[pos.row] && ctx.grid[pos.col][pos.row].special !== 'grandpoobah') {
      ctx.grid[pos.col][pos.row] = null;
    }
  }
  clearAllOverrides();

  // ── Phase 3: CELEBRATION — star piece appears with flair ──────

  // Spawn particle bursts from each star center
  for (const center of centers) {
    const px = hexToPixel(center.col, center.row, originX, originY);
    spawnCreationParticles(px.x, px.y, 20);
  }

  let queuedStarflowers = 0;
  // Mutate center to be a Starflower
  for (const sf of sfResults) {
    if (sf.centerAlreadySpecial) {
      queuedStarflowers++;
    } else {
      const center = sf.center;
      if (ctx.grid[center.col] && ctx.grid[center.col][center.row]) {
        ctx.grid[center.col][center.row].colorIndex = -1;
        ctx.grid[center.col][center.row].special = 'starflower';
        delete ctx.grid[center.col][center.row].bombTimer;
      }
    }
  }

  // Star piece pulse: scale up big then settle
  await tween(500, t => {
    for (const center of centers) {
      let scale;
      if (t < 0.25) {
        scale = 1 + 0.5 * (t / 0.25);
      } else {
        const settleT = (t - 0.25) / 0.75;
        scale = 1.5 - 0.5 * settleT;
      }
      setCellOverride(center.col, center.row, { scale });
    }
  }, easeOutCubic).promise;
  if (ctx.boardGeneration !== gen) return;

  clearAllOverrides();

  // Animated gravity
  const fallMap = computeFallDistances(ctx);
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
    if (ctx.boardGeneration !== gen) { for (const f of fallers) removeFloatingPiece(f.fp); return; }

    for (const f of fallers) removeFloatingPiece(f.fp);
    clearAllOverrides();
  }

  applyGravity(ctx.grid, ctx.activeCols, ctx.activeRows);
  {
    const mode = getActiveGameMode();
    const filled = fillEmpty(ctx.grid, ctx.activeCols, ctx.activeRows, undefined, mode.hasBombs && ctx.bombQueued, { starflowers: queuedStarflowers, blackpearls: 0 }, mode.isPuzzle);
    if (mode.hasBombs && ctx.bombQueued && filled.length > 0) ctx.setBombQueued(false);
  }
}

export async function runCascade(ctx, initialMatches, gen = ctx.boardGeneration) {
  const pendingMatches = new Set(initialMatches);
  const multiplierClusters = detectMultiplierClusters(ctx.grid);

  // 1. Merge multiplier clusters into pendingMatches
  const explosionSources = [];
  const colorNukeColors = new Set();
  let scoreBonus = 1;

  for (const cluster of multiplierClusters) {
    const clusterArr = Array.from(cluster);
    for (const key of cluster) pendingMatches.add(key);

    const colors = new Set(clusterArr.map(k => {
      const [c,r] = k.split(',').map(Number);
      return ctx.grid[c]?.[r]?.colorIndex;
    }));

    if (colors.size === 1) {
      colorNukeColors.add(colors.values().next().value);
    } else {
      for (const k of cluster) explosionSources.push(k);
    }
    scoreBonus += 0.5 * cluster.size;
  }

  // 2. Check for Bomb + Multiplier (Same Color) in pendingMatches
  const colorPresence = {};
  for (const key of pendingMatches) {
    const [c,r] = key.split(',').map(Number);
    const cell = ctx.grid[c]?.[r];
    if (!cell) continue;
    const color = cell.colorIndex;
    if (!colorPresence[color]) colorPresence[color] = { hasBomb: false, hasMultiplier: false };

    if (cell.special === 'bomb') colorPresence[color].hasBomb = true;
    if (cell.special === 'multiplier') {
      colorPresence[color].hasMultiplier = true;
      scoreBonus += 0.5;
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
    for (let c = 0; c < ctx.activeCols; c++) {
      for (let r = 0; r < ctx.activeRows; r++) {
        if (ctx.grid[c][r] && colorNukeColors.has(ctx.grid[c][r].colorIndex)) {
            if (ctx.grid[c][r].colorIndex >= 0) {
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
      if (n.col >= 0 && n.col < ctx.activeCols && n.row >= 0 && n.row < ctx.activeRows) {
        if (ctx.grid[n.col]?.[n.row] &&
            ctx.grid[n.col][n.row].special !== 'blackpearl' &&
            ctx.grid[n.col][n.row].special !== 'starflower' &&
            ctx.grid[n.col][n.row].special !== 'grandpoobah') {
             pendingMatches.add(`${n.col},${n.row}`);
        }
      }
    }
  }

  const matches = pendingMatches;

  // ── Star match special effects (play BEFORE the flash-and-clear) ─
  const { originX, originY } = getOrigin();

  if (colorNukeColors.size > 0 && multiplierClusters.length > 0) {
    const nukeColor = colorNukeColors.values().next().value;
    const nukeCluster = multiplierClusters.find(cluster => {
      const arr = Array.from(cluster);
      const colors = new Set(arr.map(k => { const [c,r] = k.split(',').map(Number); return ctx.grid[c][r]?.colorIndex; }));
      return colors.size === 1 && colors.has(nukeColor);
    });
    if (nukeCluster) {
      const arr = Array.from(nukeCluster);
      let sumX = 0, sumY = 0;
      for (const k of arr) {
        const [c,r] = k.split(',').map(Number);
        const px = hexToPixel(c, r, originX, originY);
        sumX += px.x; sumY += px.y;
      }
      const cx = sumX / arr.length, cy = sumY / arr.length;
      spawnColorNukeParticles(cx, cy, nukeColor, 50);
      const colorRGBs = [[224,48,48],[232,128,32],[32,128,224],[48,168,64],[128,64,192],[32,176,176]];
      const [rr,gg,bb] = colorRGBs[nukeColor] || [255,255,255];
      flashScreenOverlay(rr, gg, bb, 0.18, 35);
      spawnRingShockwave(cx, cy, 200, rr, gg, bb);
      spawnRingShockwave(cx, cy, 140, rr, gg, bb);
      await new Promise(res => setTimeout(res, 250));
      if (ctx.boardGeneration !== gen) return;
    }
  } else if (explosionSources.length > 0) {
    let sumX = 0, sumY = 0;
    for (const k of explosionSources) {
      const [c,r] = k.split(',').map(Number);
      const px = hexToPixel(c, r, originX, originY);
      sumX += px.x; sumY += px.y;
    }
    const cx = sumX / explosionSources.length, cy = sumY / explosionSources.length;

    spawnExplosionParticles(cx, cy, 70);
    flashScreenOverlay(255, 200, 80, 0.20, 30);
    spawnRingShockwave(cx, cy, 260, 255, 200, 80);
    spawnRingShockwave(cx, cy, 180, 255, 240, 160);

    await tween(280, t => {
      for (let c = 0; c < ctx.activeCols; c++) {
        for (let r = 0; r < ctx.activeRows; r++) {
          if (!ctx.grid[c]?.[r]) continue;
          const px = hexToPixel(c, r, originX, originY);
          const dist = Math.hypot(px.x - cx, px.y - cy);
          const delay = dist / 400;
          const localT = Math.max(0, Math.min(1, (t - delay) / (1 - delay)));
          const shake = Math.sin(localT * Math.PI * 3) * 5 * (1 - t);
          setCellOverride(c, r, { offsetX: shake, offsetY: shake * 0.5 });
        }
      }
      requestRedraw();
    }, linear).promise;
    if (ctx.boardGeneration !== gen) return;
    clearAllOverrides();
  }

  // ── Scenario 3: Bomb + Star nuke — detect and add extra effect ─
  {
    let bombNukeColor = -1;
    for (const color in colorPresence) {
      if (colorPresence[color].hasBomb && colorPresence[color].hasMultiplier) {
        bombNukeColor = Number(color);
        break;
      }
    }
    if (bombNukeColor >= 0) {
      let bombPx = null;
      for (const key of matches) {
        const [c,r] = key.split(',').map(Number);
        if (ctx.grid[c]?.[r]?.special === 'bomb' && ctx.grid[c]?.[r]?.colorIndex === bombNukeColor) {
          bombPx = hexToPixel(c, r, originX, originY);
          break;
        }
      }
      if (bombPx) {
        flashScreenOverlay(255, 30, 30, 0.28, 40);
        spawnExplosionParticles(bombPx.x, bombPx.y, 50);
        spawnRingShockwave(bombPx.x, bombPx.y, 220, 255, 60, 30);
        spawnRingShockwave(bombPx.x, bombPx.y, 130, 255, 120, 60);
        await new Promise(res => setTimeout(res, 200));
        if (ctx.boardGeneration !== gen) return;
      }
    }
  }

  // ── Flash matched cells ────────────────────────────────────
  await tween(MATCH_FLASH_MS, t => {
    for (const key of matches) {
      const [c, r] = key.split(',').map(Number);
      if (ctx.grid[c]?.[r]) {
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
  if (ctx.boardGeneration !== gen) return;

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
    if (ctx.grid[c]) ctx.grid[c][r] = null;
  }
  clearAllOverrides();
  requestRedraw();

  // ── Starflower detection at cleared positions ──────────────
  const sfMid = detectStarflowersAtCleared(ctx.grid, matches);
  if (sfMid.length > 0) {
    await animateStarflowerCreation(ctx, sfMid);
    if (ctx.boardGeneration !== gen) return;

    const bpMid = detectBlackPearls(ctx.grid);
    if (bpMid.length > 0) {
      await animateBlackPearlCreation(ctx, bpMid);
      if (ctx.boardGeneration !== gen) return;
    }
  }

  // ── Gravity: animate pieces falling ────────────────────────
  const fallMap = computeFallDistances(ctx);

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
    if (ctx.boardGeneration !== gen) return;

    for (const f of fallers) removeFloatingPiece(f.fp);
    clearAllOverrides();
  }

  // Commit gravity and fill
  applyGravity(ctx.grid, ctx.activeCols, ctx.activeRows);
  {
    const mode = getActiveGameMode();
    const filled = fillEmpty(ctx.grid, ctx.activeCols, ctx.activeRows, undefined, mode.hasBombs && ctx.bombQueued, undefined, mode.isPuzzle);
    if (mode.hasBombs && ctx.bombQueued && filled.length > 0) ctx.setBombQueued(false);
  }
  requestRedraw();

}

/**
 * Compute how far each non-null cell needs to fall.
 * Returns [{ col, fromRow, toRow, dist, colorIndex }]
 */
export function computeFallDistances(ctx) {
  const result = [];
  for (let c = 0; c < ctx.activeCols; c++) {
    if (!ctx.grid[c]) continue;
    let writeRow = ctx.activeRows - 1;
    for (let r = ctx.activeRows - 1; r >= 0; r--) {
      if (ctx.grid[c][r] !== null) {
        if (r !== writeRow) {
          result.push({
            col: c,
            fromRow: r,
            toRow: writeRow,
            dist: writeRow - r,
            colorIndex: ctx.grid[c][r].colorIndex,
            special: ctx.grid[c][r].special,
            bombTimer: ctx.grid[c][r].bombTimer,
          });
        }
        writeRow--;
      }
    }
  }
  return result;
}

export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}