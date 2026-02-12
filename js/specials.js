/**
 * specials.js — Detection of special pieces.
 *
 * Starflower: a center tile surrounded by 6 identical tiles.
 *             Allows ring-rotation of the 6 surrounding tiles.
 *             Created when player arranges a ring pattern on the board.
 *
 * Bomb:       appears periodically as a timed threat.
 *             Must be matched (cleared) before its counter reaches 0.
 *             Defused by including it in a 3+ match of the same color.
 */

import { GRID_COLS, GRID_ROWS } from './constants.js';
import { getNeighbors } from './hex-math.js';

// ─── Starflower detection ───────────────────────────────────────

/**
 * Board-scan: if any hex has all 6 in-bounds neighbors the same color
 * AND different from itself → center becomes a starflower.
 *
 * Does NOT clear ring tiles — returns their data so the caller can animate.
 * @returns {Array<{center, ring, ringColor}>}
 */
export function detectStarflowers(grid) {
  const results = [];
  for (let c = 0; c < GRID_COLS; c++) {
    for (let r = 0; r < GRID_ROWS; r++) {
      const cell = grid[c][r];
      if (!cell || cell.special) continue;

      const nbrs = getNeighbors(c, r);
      const valid = nbrs.filter(n =>
        inBounds(n) && grid[n.col][n.row] && !grid[n.col][n.row].special
      );
      if (valid.length !== 6) continue;

      const ringColor = grid[valid[0].col][valid[0].row].colorIndex;
      if (ringColor !== cell.colorIndex &&
          valid.every(n => grid[n.col][n.row].colorIndex === ringColor)) {
        // Mark center as starflower (metallic bronze, no matchable color)
        cell.colorIndex = -1;
        cell.special = 'starflower';
        results.push({
          center: { col: c, row: r },
          ring: valid.map(n => ({ col: n.col, row: n.row })),
          ringColor,
        });
      }
    }
  }
  return results;
}

/**
 * Post-match starflower detection at cleared positions.
 * Does NOT clear ring tiles — returns data for animated clearing.
 * @param {Set<string>} clearedKeys - "col,row" keys of just-cleared cells
 * @returns {Array<{center, ring, ringColor}>}
 */
export function detectStarflowersAtCleared(grid, clearedKeys) {
  const results = [];
  for (const key of clearedKeys) {
    const [c, r] = key.split(',').map(Number);
    if (grid[c][r] !== null) continue;

    const nbrs = getNeighbors(c, r);
    const valid = nbrs.filter(n =>
      inBounds(n) &&
      grid[n.col][n.row] !== null &&
      !clearedKeys.has(`${n.col},${n.row}`)
    );
    if (valid.length !== 6) continue;

    const color = grid[valid[0].col][valid[0].row].colorIndex;
    if (valid.every(n => grid[n.col][n.row].colorIndex === color)) {
      // Create the starflower in the cleared position
      grid[c][r] = { colorIndex: -1, special: 'starflower' };
      results.push({
        center: { col: c, row: r },
        ring: valid.map(n => ({ col: n.col, row: n.row })),
        ringColor: color,
      });
    }
  }
  return results;
}

// ─── Bomb logic ─────────────────────────────────────────────────

/**
 * Spawn a bomb on a random non-special cell.
 * The bomb keeps its color — player must match it with same-color tiles.
 * @param {number} timer - countdown in moves
 * @returns {{col, row}|null}
 */
export function spawnBomb(grid, timer = 15) {
  // Collect eligible cells
  const candidates = [];
  for (let c = 0; c < GRID_COLS; c++) {
    for (let r = 0; r < GRID_ROWS; r++) {
      if (grid[c][r] && !grid[c][r].special) {
        candidates.push({ col: c, row: r });
      }
    }
  }
  if (candidates.length === 0) return null;

  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  grid[pick.col][pick.row].special = 'bomb';
  grid[pick.col][pick.row].bombTimer = timer;
  return pick;
}

/**
 * Tick all bomb timers down by 1.  Call once per player move.
 * @returns {boolean} true if any bomb expired (game over)
 */
export function tickBombs(grid) {
  let expired = false;
  for (let c = 0; c < GRID_COLS; c++) {
    for (let r = 0; r < GRID_ROWS; r++) {
      const cell = grid[c][r];
      if (cell && cell.special === 'bomb') {
        cell.bombTimer--;
        if (cell.bombTimer <= 0) {
          expired = true;
        }
      }
    }
  }
  return expired;
}

/**
 * Count active bombs on the board.
 */
export function countBombs(grid) {
  let count = 0;
  for (let c = 0; c < GRID_COLS; c++) {
    for (let r = 0; r < GRID_ROWS; r++) {
      if (grid[c][r]?.special === 'bomb') count++;
    }
  }
  return count;
}

// ─── Helpers ────────────────────────────────────────────────────

function inBounds(h) {
  return h.col >= 0 && h.col < GRID_COLS && h.row >= 0 && h.row < GRID_ROWS;
}
