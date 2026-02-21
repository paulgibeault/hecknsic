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
import { findMatches } from '../js/board.js';

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
