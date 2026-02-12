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

// ─── Multiplier Tile Detection ──────────────────────────────────

/**
 * Detects connected clusters of multiplier tiles (size >= 3).
 * Returns array of Sets, where each Set contains "col,row" keys of a connected components.
 * These can be same-color (Color Nuke) or mixed-color (Explosion).
 * @returns {Array<Set<string>>}
 */
export function detectMultiplierClusters(grid) {
  const clusters = [];
  const visited = new Set();

  for (let c = 0; c < GRID_COLS; c++) {
    for (let r = 0; r < GRID_ROWS; r++) {
      const key = `${c},${r}`;
      if (visited.has(key)) continue;

      const cell = grid[c][r];
      if (cell && cell.special === 'multiplier') {
        // Start a BFS/DFS to find component
        const cluster = new Set();
        const stack = [{ col: c, row: r }];
        visited.add(key);
        cluster.add(key);

        while (stack.length > 0) {
          const curr = stack.pop();
          const nbrs = getNeighbors(curr.col, curr.row);
          for (const n of nbrs) {
            if (n.col >= 0 && n.col < GRID_COLS && n.row >= 0 && n.row < GRID_ROWS) {
              const nKey = `${n.col},${n.row}`;
              if (!visited.has(nKey)) {
                const nCell = grid[n.col][n.row];
                if (nCell && nCell.special === 'multiplier') {
                  visited.add(nKey);
                  cluster.add(nKey);
                  stack.push(n);
                }
              }
            }
          }
        }

        if (cluster.size >= 3) {
          clusters.push(cluster);
        }
      }
    }
  }
  return clusters;
}

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
      if (!cell || cell.special === 'starflower' || cell.special === 'blackpearl') continue;

      const nbrs = getNeighbors(c, r);
      const valid = nbrs.filter(n =>
        inBounds(n) && grid[n.col][n.row] && grid[n.col][n.row].special !== 'starflower' && grid[n.col][n.row].special !== 'blackpearl'
      );
      if (valid.length !== 6) continue;

      const ringColor = grid[valid[0].col][valid[0].row].colorIndex;
      if (ringColor >= 0 && ringColor !== cell.colorIndex &&
          valid.every(n => grid[n.col][n.row].colorIndex === ringColor)) {
        // Mark center as starflower (silver chrome, unmatchable)
        cell.colorIndex = -1;
        cell.special = 'starflower';
        delete cell.bombTimer;  // clean up if center was a bomb
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

// ─── Black Pearl detection ──────────────────────────────────────

/**
 * Board-scan: if any hex has all 6 in-bounds neighbors as starflowers
 * → center becomes a black pearl, starflower ring is absorbed.
 *
 * Returns data for animation (ring positions to clear).
 * @returns {Array<{center, ring}>}
 */
export function detectBlackPearls(grid) {
  const results = [];
  for (let c = 0; c < GRID_COLS; c++) {
    for (let r = 0; r < GRID_ROWS; r++) {
      const cell = grid[c][r];
      if (!cell || cell.special === 'blackpearl') continue;

      const nbrs = getNeighbors(c, r);
      const validStars = nbrs.filter(n =>
        inBounds(n) && grid[n.col][n.row]?.special === 'starflower'
      );
      if (validStars.length !== 6) continue;

      // All 6 neighbors are starflowers → create black pearl
      cell.colorIndex = -2;
      cell.special = 'blackpearl';
      delete cell.bombTimer;
      results.push({
        center: { col: c, row: r },
        ring: validStars.map(n => ({ col: n.col, row: n.row })),
      });
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
      grid[n.col][n.row].special !== 'starflower' &&
      !clearedKeys.has(`${n.col},${n.row}`)
    );
    if (valid.length !== 6) continue;

    const color = grid[valid[0].col][valid[0].row].colorIndex;
    if (color >= 0 && valid.every(n => grid[n.col][n.row].colorIndex === color)) {
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
