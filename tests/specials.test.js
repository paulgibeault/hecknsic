/**
 * Unit tests for specials.js — detectBlackPearls and detectStarflowers.
 *
 * Uses the actual game modules (hex-math, constants) so coordinate math is real.
 *
 * Center (4,4) is an even column (4 & 1 === 0).
 * Its 6 NEIGHBORS_EVEN neighbors are: (5,4),(5,3),(4,3),(3,3),(3,4),(4,5)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRID_COLS, GRID_ROWS } from '../js/constants.js';
import { detectBlackPearls, detectStarflowers } from '../js/specials.js';

// ─── Helpers ────────────────────────────────────────────────────

function emptyGrid() {
  const g = [];
  for (let c = 0; c < GRID_COLS; c++) {
    g[c] = [];
    for (let r = 0; r < GRID_ROWS; r++) {
      g[c][r] = null;
    }
  }
  return g;
}

function fullGrid(colorIndex = 0) {
  const g = [];
  for (let c = 0; c < GRID_COLS; c++) {
    g[c] = [];
    for (let r = 0; r < GRID_ROWS; r++) {
      g[c][r] = { colorIndex, special: null };
    }
  }
  return g;
}

// Neighbors of (4,4) per NEIGHBORS_EVEN (col 4 is even: 4 & 1 === 0)
const CENTER = { col: 4, row: 4 };
const RING = [
  { col: 5, row: 4 },
  { col: 5, row: 3 },
  { col: 4, row: 3 },
  { col: 3, row: 3 },
  { col: 3, row: 4 },
  { col: 4, row: 5 },
];

function makeStarflower() { return { colorIndex: -1, special: 'starflower' }; }

// ─── detectBlackPearls ──────────────────────────────────────────

test('detectBlackPearls: returns empty when no formation exists', () => {
  const grid = fullGrid(0);
  const results = detectBlackPearls(grid);
  assert.equal(results.length, 0);
});

test('detectBlackPearls: detects a 6-starflower ring around a regular center', () => {
  const grid = fullGrid(0);
  // Place 6 starflowers around center (4,4)
  for (const pos of RING) grid[pos.col][pos.row] = makeStarflower();

  const results = detectBlackPearls(grid);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].center, CENTER);
  assert.equal(results[0].ring.length, 6);
});

test('detectBlackPearls: does NOT mutate the center cell (non-mutating)', () => {
  const grid = fullGrid(0);
  for (const pos of RING) grid[pos.col][pos.row] = makeStarflower();

  const originalColorIndex = grid[CENTER.col][CENTER.row].colorIndex;
  const originalSpecial    = grid[CENTER.col][CENTER.row].special;

  detectBlackPearls(grid);

  assert.equal(grid[CENTER.col][CENTER.row].colorIndex, originalColorIndex,
    'center colorIndex should be unchanged after detection');
  assert.equal(grid[CENTER.col][CENTER.row].special, originalSpecial,
    'center special should be unchanged after detection');
});

test('detectBlackPearls: can be called twice and still detects formation (idempotent)', () => {
  const grid = fullGrid(0);
  for (const pos of RING) grid[pos.col][pos.row] = makeStarflower();

  const first  = detectBlackPearls(grid);
  const second = detectBlackPearls(grid);

  assert.equal(first.length, 1, 'first call should detect the formation');
  assert.equal(second.length, 1, 'second call should also detect it (center was not mutated)');
});

test('detectBlackPearls: detects formation when center is itself a starflower (flower-of-starflowers)', () => {
  const grid = emptyGrid();
  // Center starflower
  grid[CENTER.col][CENTER.row] = makeStarflower();
  // 6 starflower ring neighbors
  for (const pos of RING) grid[pos.col][pos.row] = makeStarflower();

  const results = detectBlackPearls(grid);
  assert.equal(results.length, 1,
    'a starflower surrounded by 6 starflowers should trigger black pearl formation');
  assert.deepEqual(results[0].center, CENTER);
});

test('detectBlackPearls: skips center that is already a black pearl', () => {
  const grid = fullGrid(0);
  grid[CENTER.col][CENTER.row] = { colorIndex: -2, special: 'blackpearl' };
  for (const pos of RING) grid[pos.col][pos.row] = makeStarflower();

  const results = detectBlackPearls(grid);
  assert.equal(results.length, 0, 'already-formed black pearl should not be re-detected');
});

test('detectBlackPearls: does not detect when fewer than 6 starflower neighbors', () => {
  const grid = fullGrid(0);
  // Only 5 of 6 neighbors are starflowers
  for (let i = 0; i < 5; i++) grid[RING[i].col][RING[i].row] = makeStarflower();

  const results = detectBlackPearls(grid);
  assert.equal(results.length, 0);
});

// ─── detectStarflowers ──────────────────────────────────────────

test('detectStarflowers: detects a 6-same-color ring around a different-color center', () => {
  // Use a fresh mostly-filled grid so the center cell has all 6 in-bounds neighbors
  const grid = fullGrid(0); // all colorIndex 0
  // Center gets a different color
  grid[CENTER.col][CENTER.row].colorIndex = 1;
  // Ring already is colorIndex 0 (same as default)

  const results = detectStarflowers(grid);
  // Should find the formation at (4,4)
  const match = results.find(r => r.center.col === CENTER.col && r.center.row === CENTER.row);
  assert.ok(match, 'starflower formation at (4,4) should be detected');
  assert.equal(match.ring.length, 6);
});

test('detectStarflowers: does NOT mutate the grid', () => {
  const grid = fullGrid(0);
  grid[CENTER.col][CENTER.row].colorIndex = 1;

  detectStarflowers(grid);

  assert.equal(grid[CENTER.col][CENTER.row].colorIndex, 1,
    'center should still have its original colorIndex after detection');
  assert.equal(grid[CENTER.col][CENTER.row].special, null,
    'center should NOT be marked as starflower by detection alone');
});
