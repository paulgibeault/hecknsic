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
 * Call after rotations, gravity, or refill.
 * @returns {Array<{col, row}>} positions that became starflowers
 */
export function detectStarflowers(grid) {
  const created = [];
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
        cell.colorIndex = ringColor;
        cell.special = 'starflower';
        created.push({ col: c, row: r });
      }
    }
  }
  return created;
}

/**
 * Post-match starflower detection: check cleared cells to see if
 * removing them created a ring of 6 same-color around the gap.
 * Call after removing matched cells, before gravity.
 * @param {Set<string>} clearedKeys - "col,row" keys of just-cleared cells
 */
export function detectStarflowersAtCleared(grid, clearedKeys) {
  const created = [];
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
      grid[c][r] = { colorIndex: color, special: 'starflower' };
      created.push({ col: c, row: r });
    }
  }
  return created;
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
