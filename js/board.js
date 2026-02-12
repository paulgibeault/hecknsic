/**
 * board.js — Grid state management: create, fill, access.
 */

import { GRID_COLS, GRID_ROWS, PIECE_COLORS } from './constants.js';

/**
 * A cell in the grid.
 * @typedef {{ colorIndex: number, special: string|null }} Cell
 */

/**
 * Create a fresh grid filled with random colors.
 * grid[col][row]
 * @returns {Cell[][]}
 */
export function createGrid(cols = GRID_COLS, rows = GRID_ROWS, numColors = PIECE_COLORS.length) {
  const grid = [];
  for (let c = 0; c < cols; c++) {
    grid[c] = [];
    for (let r = 0; r < rows; r++) {
      grid[c][r] = {
        colorIndex: Math.floor(Math.random() * numColors),
        special: null,
      };
    }
  }
  // Break up any initial 3-in-a-row matches so the player starts clean
  eliminateInitialMatches(grid, cols, rows, numColors);
  return grid;
}

/**
 * Brute-force re-roll cells that participate in initial matches.
 */
function eliminateInitialMatches(grid, cols, rows, numColors) {
  let changed = true;
  let safety = 0;
  while (changed && safety++ < 100) {
    changed = false;
    // Check all three axes
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const color = grid[c][r].colorIndex;
        for (const dir of axialDirections) {
          if (countRun(grid, c, r, dir, cols, rows) >= 3) {
            grid[c][r].colorIndex = (color + 1 + Math.floor(Math.random() * (numColors - 1))) % numColors;
            changed = true;
          }
        }
      }
    }
  }
}

/**
 * The 3 axes in axial space we check for line-matches.
 * Only positive direction — we'll scan in both directions from each cell.
 */
const axialDirections = [
  { dq: 1, dr: 0 },   // east
  { dq: 0, dr: 1 },   // SE
  { dq: 1, dr: -1 },  // NE
];

/**
 * Count how many consecutive same-color cells extend from (col, row)
 * in a given axial direction (including the start cell).
 */
function countRun(grid, col, row, dir, cols, rows) {
  const color = grid[col][row].colorIndex;
  let count = 1;

  // Convert start to axial
  let q = col;
  let r = row - (col - (col & 1)) / 2;

  for (let step = 1; step < Math.max(cols, rows); step++) {
    const nq = q + dir.dq * step;
    const nr = r + dir.dr * step;
    // axial → offset
    const nc = nq;
    const nrow = nr + (nq - (nq & 1)) / 2;
    if (nc < 0 || nc >= cols || nrow < 0 || nrow >= rows) break;
    if (grid[nc][nrow].colorIndex !== color) break;
    count++;
  }
  return count;
}

/**
 * Get cell at (col, row), or null if out of bounds.
 */
export function getCell(grid, col, row) {
  if (col < 0 || col >= grid.length) return null;
  if (row < 0 || row >= grid[0].length) return null;
  return grid[col][row];
}

/**
 * Swap color values of cells at positions within a cluster (rotation).
 * CW:  [0,1,2] → colors shift: 2→0, 0→1, 1→2
 * CCW: [0,1,2] → colors shift: 1→0, 2→1, 0→2
 */
export function rotateCluster(grid, cluster, clockwise) {
  const cells = cluster.map(h => grid[h.col][h.row]);
  if (clockwise) {
    const saved = { ...cells[0] };
    cells[0].colorIndex = cells[2].colorIndex;
    cells[0].special = cells[2].special;
    cells[2].colorIndex = cells[1].colorIndex;
    cells[2].special = cells[1].special;
    cells[1].colorIndex = saved.colorIndex;
    cells[1].special = saved.special;
  } else {
    const saved = { ...cells[0] };
    cells[0].colorIndex = cells[1].colorIndex;
    cells[0].special = cells[1].special;
    cells[1].colorIndex = cells[2].colorIndex;
    cells[1].special = cells[2].special;
    cells[2].colorIndex = saved.colorIndex;
    cells[2].special = saved.special;
  }
}

/**
 * Rotate the 6 hex ring around a flower center.
 * CW:  each cell's data shifts one position forward in the ring.
 * CCW: each cell's data shifts one position backward.
 * @param {Array<{col, row}>} ring - 6 neighbor positions in clockwise order
 */
export function rotateRing(grid, ring, clockwise) {
  const cells = ring.map(h => grid[h.col][h.row]);
  if (clockwise) {
    const saved = { colorIndex: cells[5].colorIndex, special: cells[5].special };
    for (let i = 5; i > 0; i--) {
      cells[i].colorIndex = cells[i - 1].colorIndex;
      cells[i].special = cells[i - 1].special;
    }
    cells[0].colorIndex = saved.colorIndex;
    cells[0].special = saved.special;
  } else {
    const saved = { colorIndex: cells[0].colorIndex, special: cells[0].special };
    for (let i = 0; i < 5; i++) {
      cells[i].colorIndex = cells[i + 1].colorIndex;
      cells[i].special = cells[i + 1].special;
    }
    cells[5].colorIndex = saved.colorIndex;
    cells[5].special = saved.special;
  }
}

/**
 * Find all matches on the board.
 * Returns an array of Sets, each containing {col, row} keys ("col,row") of matched cells.
 * Also returns a flat Set of all matched cell keys.
 */
export function findMatches(grid, cols = GRID_COLS, rows = GRID_ROWS) {
  const allMatched = new Set();

  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      if (grid[c][r] === null) continue;
      if (grid[c][r].special === 'starflower') continue; // starflowers can't match
      const color = grid[c][r].colorIndex;

      for (const dir of axialDirections) {
        // Gather run in positive direction
        const run = [{ col: c, row: r }];
        let q = c;
        let rr = r - (c - (c & 1)) / 2;

        for (let step = 1; step < Math.max(cols, rows); step++) {
          const nq = q + dir.dq * step;
          const nr = rr + dir.dr * step;
          const nc = nq;
          const nrow = nr + (nq - (nq & 1)) / 2;
          if (nc < 0 || nc >= cols || nrow < 0 || nrow >= rows) break;
          if (grid[nc][nrow] === null || grid[nc][nrow].colorIndex !== color) break;
          run.push({ col: nc, row: nrow });
        }

        if (run.length >= 3) {
          for (const cell of run) {
            allMatched.add(`${cell.col},${cell.row}`);
          }
        }
      }
    }
  }

  return allMatched;
}

/**
 * Apply gravity — move pieces down to fill gaps.
 * Returns true if any pieces moved.
 */
export function applyGravity(grid, cols = GRID_COLS, rows = GRID_ROWS) {
  let moved = false;
  for (let c = 0; c < cols; c++) {
    // Walk from bottom up, shift non-null cells down
    let writeRow = rows - 1;
    for (let r = rows - 1; r >= 0; r--) {
      if (grid[c][r] !== null) {
        if (r !== writeRow) {
          grid[c][writeRow] = grid[c][r];
          grid[c][r] = null;
          moved = true;
        }
        writeRow--;
      }
    }
  }
  return moved;
}

/**
 * Fill null cells at the top of each column with new random pieces.
 * Returns array of {col, row} that were filled.
 */
export function fillEmpty(grid, cols = GRID_COLS, rows = GRID_ROWS, numColors = PIECE_COLORS.length) {
  const filled = [];
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      if (grid[c][r] === null) {
        grid[c][r] = {
          colorIndex: Math.floor(Math.random() * numColors),
          special: null,
        };
        filled.push({ col: c, row: r });
      }
    }
  }
  return filled;
}
