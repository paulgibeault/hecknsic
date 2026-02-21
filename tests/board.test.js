/**
 * Unit tests for board.js — findMatches.
 *
 * Verifies that black pearls cannot be cleared by row/line matching,
 * and that regular pieces still match correctly.
 *
 * SE axial direction (dq=0, dr=1) maps to same-column, consecutive-row
 * positions in offset coords. For column 4 (even):
 *   q=4, r=0 → col=4, row=2
 *   q=4, r=1 → col=4, row=3
 *   q=4, r=2 → col=4, row=4
 * So (4,2), (4,3), (4,4) are a valid axial run of 3 (SE direction).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRID_COLS, GRID_ROWS } from '../js/constants.js';
import { findMatches, findTriangleMatches } from '../js/board.js';

// ─── Helpers ────────────────────────────────────────────────────

/** Grid filled with a color that won't form accidental runs */
function baseGrid() {
  const g = [];
  for (let c = 0; c < GRID_COLS; c++) {
    g[c] = [];
    for (let r = 0; r < GRID_ROWS; r++) {
      // Alternate colors so no accidental 3-in-a-row exists
      g[c][r] = { colorIndex: (c + r) % 5, special: null };
    }
  }
  return g;
}

// Three positions in an axial SE run (same column, consecutive rows)
const RUN = [
  { col: 4, row: 2 },
  { col: 4, row: 3 },
  { col: 4, row: 4 },
];

// ─── Black pearl exclusion ───────────────────────────────────────

test('findMatches: 3 black pearls in a row do NOT produce a match', () => {
  const grid = baseGrid();
  for (const pos of RUN) {
    grid[pos.col][pos.row] = { colorIndex: -2, special: 'blackpearl' };
  }

  const matched = findMatches(grid);

  for (const pos of RUN) {
    assert.equal(matched.has(`${pos.col},${pos.row}`), false,
      `black pearl at (${pos.col},${pos.row}) should not be in matched set`);
  }
});

test('findMatches: 5 black pearls in a row do NOT produce a match', () => {
  const grid = baseGrid();
  const longRun = [
    { col: 4, row: 1 },
    { col: 4, row: 2 },
    { col: 4, row: 3 },
    { col: 4, row: 4 },
    { col: 4, row: 5 },
  ];
  for (const pos of longRun) {
    grid[pos.col][pos.row] = { colorIndex: -2, special: 'blackpearl' };
  }

  const matched = findMatches(grid);

  for (const pos of longRun) {
    assert.equal(matched.has(`${pos.col},${pos.row}`), false,
      `black pearl at (${pos.col},${pos.row}) should not be matched`);
  }
});

// ─── Regression: regular pieces still match ──────────────────────

test('findMatches: 3 regular same-color pieces in a row DO produce a match', () => {
  const grid = baseGrid();
  // Override run with a single distinct color
  for (const pos of RUN) {
    grid[pos.col][pos.row] = { colorIndex: 3, special: null };
  }

  const matched = findMatches(grid);

  for (const pos of RUN) {
    assert.equal(matched.has(`${pos.col},${pos.row}`), true,
      `regular piece at (${pos.col},${pos.row}) should be matched`);
  }
});

// ─── Triangle matching ───────────────────────────────────────────
//
// Color 7 is used so no baseGrid cell (which uses (c+r)%5 ∈ {0..4}) can
// accidentally interfere with our triangle/line cells.
//
// For col=4 (even), getNeighbors returns:
//   N[0]=(5,3), N[1]=(5,2) — consecutive, so (4,3)+(5,3)+(5,2) is a valid triangle.
// The axial SE line RUN=(4,2),(4,3),(4,4) is NOT a triangle (ends not adjacent).

const TRIANGLE = [
  { col: 4, row: 3 },  // center C
  { col: 5, row: 3 },  // N[0] of C (NEIGHBORS_EVEN[0] = +1,0)
  { col: 5, row: 2 },  // N[1] of C (NEIGHBORS_EVEN[1] = +1,-1) — adjacent to N[0]
];
const TRIANGLE_COLOR = 7; // not in (c+r)%5 range

test('findTriangleMatches: 3 mutually-adjacent same-color cells DO produce a match', () => {
  const grid = baseGrid();
  for (const pos of TRIANGLE) {
    grid[pos.col][pos.row] = { colorIndex: TRIANGLE_COLOR, special: null };
  }

  const matched = findTriangleMatches(grid);

  for (const pos of TRIANGLE) {
    assert.equal(matched.has(`${pos.col},${pos.row}`), true,
      `triangle cell (${pos.col},${pos.row}) should be in matched set`);
  }
});

test('findTriangleMatches: axial 3-in-a-row does NOT produce a match', () => {
  const grid = baseGrid();
  // SE axial line: (4,2),(4,3),(4,4) — endpoints not mutually adjacent
  for (const pos of RUN) {
    grid[pos.col][pos.row] = { colorIndex: TRIANGLE_COLOR, special: null };
  }

  const matched = findTriangleMatches(grid);

  for (const pos of RUN) {
    assert.equal(matched.has(`${pos.col},${pos.row}`), false,
      `line cell (${pos.col},${pos.row}) should NOT be matched by triangle matcher`);
  }
});

test('findMatches: triangle cluster does NOT produce a line match', () => {
  const grid = baseGrid();
  // (4,3),(5,3),(5,2) are not collinear on any axial axis
  for (const pos of TRIANGLE) {
    grid[pos.col][pos.row] = { colorIndex: TRIANGLE_COLOR, special: null };
  }

  const matched = findMatches(grid);

  for (const pos of TRIANGLE) {
    assert.equal(matched.has(`${pos.col},${pos.row}`), false,
      `triangle cell (${pos.col},${pos.row}) should NOT produce a line match`);
  }
});

// ─── Starflower exclusion (pre-existing, regression guard) ────────

test('findMatches: starflowers in a row do NOT produce a match', () => {
  const grid = baseGrid();
  for (const pos of RUN) {
    grid[pos.col][pos.row] = { colorIndex: -1, special: 'starflower' };
  }

  const matched = findMatches(grid);

  for (const pos of RUN) {
    assert.equal(matched.has(`${pos.col},${pos.row}`), false,
      `starflower at (${pos.col},${pos.row}) should not be matched`);
  }
});
