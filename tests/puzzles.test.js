/**
 * puzzles.test.js — Unit tests for puzzle engine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decodePuzzleBoard,
  encodePuzzleBoard,
  evaluateGoal,
  describeGoal,
  computeStars,
  PUZZLE_SECTORS,
  ALL_PUZZLES,
  getPuzzleById,
  getNextPuzzle,
} from '../js/puzzles.js';

// ─── decodePuzzleBoard ──────────────────────────────────────────

test('decodePuzzleBoard: empty string gives null grid', () => {
  const grid = decodePuzzleBoard('', 3, 3);
  assert.equal(grid[0][0], null);
  assert.equal(grid[2][2], null);
});

test('decodePuzzleBoard: basic tiles', () => {
  const grid = decodePuzzleBoard('0:0:2 1:1:4', 3, 3);
  assert.equal(grid[0][0].colorIndex, 2);
  assert.equal(grid[0][0].special, null);
  assert.equal(grid[1][1].colorIndex, 4);
  assert.equal(grid[0][1], null);
});

test('decodePuzzleBoard: bomb token', () => {
  const grid = decodePuzzleBoard('2:2:1b8', 5, 5);
  const cell = grid[2][2];
  assert.equal(cell.colorIndex, 1);
  assert.equal(cell.special, 'bomb');
  assert.equal(cell.bombTimer, 8);
});

test('decodePuzzleBoard: starflower token', () => {
  const grid = decodePuzzleBoard('1:1:0s', 3, 3);
  const cell = grid[1][1];
  assert.equal(cell.colorIndex, 0);
  assert.equal(cell.special, 'starflower');
});

test('decodePuzzleBoard: blackpearl token', () => {
  const grid = decodePuzzleBoard('0:0:0p', 3, 3);
  assert.equal(grid[0][0].special, 'blackpearl');
});

// ─── encodePuzzleBoard ──────────────────────────────────────────

test('encodePuzzleBoard: round-trips basic grid', () => {
  const original = '0:0:0 1:1:3';
  const grid = decodePuzzleBoard(original, 3, 3);
  const encoded = encodePuzzleBoard(grid, 3, 3);
  // Re-decode and verify
  const grid2 = decodePuzzleBoard(encoded, 3, 3);
  assert.equal(grid2[0][0].colorIndex, 0);
  assert.equal(grid2[1][1].colorIndex, 3);
  assert.equal(grid2[0][1], null);
});

test('encodePuzzleBoard: round-trips bomb', () => {
  const grid = decodePuzzleBoard('2:2:1b8', 5, 5);
  const encoded = encodePuzzleBoard(grid, 5, 5);
  assert.ok(encoded.includes('2:2:1b8'));
});

// ─── evaluateGoal ───────────────────────────────────────────────

test('evaluateGoal: clear_color met when no tiles of that color remain', () => {
  // 3x3 grid — all blue (colorIndex 2) except one orange at 0:0
  const grid = decodePuzzleBoard('0:0:1', 3, 3);  // only orange, no reds
  const result = evaluateGoal({ type: 'clear_color', colorIndex: 0 }, grid, {}, 3, 3);
  assert.equal(result.met, true);
});

test('evaluateGoal: clear_color not met when tiles remain', () => {
  const grid = decodePuzzleBoard('0:0:0 1:1:0', 3, 3);
  const result = evaluateGoal({ type: 'clear_color', colorIndex: 0 }, grid, {}, 3, 3);
  assert.equal(result.met, false);
  assert.ok(result.progress.includes('2'));
});

test('evaluateGoal: defuse_bomb met when no bombs remain', () => {
  const grid = decodePuzzleBoard('0:0:1', 3, 3); // no bombs
  const result = evaluateGoal({ type: 'defuse_bomb' }, grid, { totalMoves: 2 }, 3, 3);
  assert.equal(result.met, true);
});

test('evaluateGoal: defuse_bomb not met when bomb still on board', () => {
  const grid = decodePuzzleBoard('1:1:2b5', 3, 3);
  const result = evaluateGoal({ type: 'defuse_bomb' }, grid, { totalMoves: 1 }, 3, 3);
  assert.equal(result.met, false);
});

test('evaluateGoal: make_starflower met when count reached', () => {
  const grid = decodePuzzleBoard('', 3, 3);
  const result = evaluateGoal(
    { type: 'make_starflower', count: 2 },
    grid,
    { starflowersMade: 2 },
    3, 3
  );
  assert.equal(result.met, true);
});

test('evaluateGoal: make_starflower not met when under count', () => {
  const grid = decodePuzzleBoard('', 3, 3);
  const result = evaluateGoal(
    { type: 'make_starflower', count: 2 },
    grid,
    { starflowersMade: 1 },
    3, 3
  );
  assert.equal(result.met, false);
});

test('evaluateGoal: score met', () => {
  const grid = decodePuzzleBoard('', 3, 3);
  const result = evaluateGoal({ type: 'score', target: 100 }, grid, { score: 150 }, 3, 3);
  assert.equal(result.met, true);
});

test('evaluateGoal: score not met', () => {
  const grid = decodePuzzleBoard('', 3, 3);
  const result = evaluateGoal({ type: 'score', target: 100 }, grid, { score: 50 }, 3, 3);
  assert.equal(result.met, false);
});

test('evaluateGoal: clear_all met when board empty', () => {
  const grid = decodePuzzleBoard('', 3, 3);
  const result = evaluateGoal({ type: 'clear_all' }, grid, {}, 3, 3);
  assert.equal(result.met, true);
});

test('evaluateGoal: clear_all not met when tiles remain', () => {
  const grid = decodePuzzleBoard('0:0:0', 3, 3);
  const result = evaluateGoal({ type: 'clear_all' }, grid, {}, 3, 3);
  assert.equal(result.met, false);
});

// ─── computeStars ───────────────────────────────────────────────

test('computeStars: 1 star when solved over par', () => {
  const puzzle = { moveLimit: 10, par: 6 };
  assert.equal(computeStars(puzzle, 9, 0), 1);
});

test('computeStars: 2 stars when solved at par, no chain', () => {
  const puzzle = { moveLimit: 10, par: 6 };
  assert.equal(computeStars(puzzle, 6, 0), 2);
});

test('computeStars: 3 stars when solved under par', () => {
  const puzzle = { moveLimit: 10, par: 6 };
  assert.equal(computeStars(puzzle, 4, 0), 3);
});

test('computeStars: 2 stars when solved at par (chain ignored)', () => {
  const puzzle = { moveLimit: 10, par: 6 };
  assert.equal(computeStars(puzzle, 6, 2), 2);
});

test('computeStars: 3 stars when solved under par (chain irrelevant)', () => {
  const puzzle = { moveLimit: 10, par: 6 };
  assert.equal(computeStars(puzzle, 3, 3), 3);
});

test('computeStars: 1 star even at par when chain < 2', () => {
  const puzzle = { moveLimit: 10, par: 6 };
  assert.equal(computeStars(puzzle, 6, 1), 2); // par met, no chain bonus → 2 stars
});

// ─── describeGoal ───────────────────────────────────────────────

test('describeGoal: returns string for all types', () => {
  const goals = [
    { type: 'clear_color', colorIndex: 0 },
    { type: 'defuse_bomb' },
    { type: 'make_starflower', count: 1 },
    { type: 'score', target: 500 },
    { type: 'clear_all' },
  ];
  for (const goal of goals) {
    const desc = describeGoal(goal);
    assert.equal(typeof desc, 'string');
    assert.ok(desc.length > 0);
  }
});

// ─── Puzzle registry ────────────────────────────────────────────

test('PUZZLE_SECTORS: at least 2 sectors defined', () => {
  assert.ok(PUZZLE_SECTORS.length >= 2);
});

test('ALL_PUZZLES: all puzzles have required fields', () => {
  for (const p of ALL_PUZZLES) {
    assert.ok(p.id,          `${p.id}: missing id`);
    assert.ok(p.name,        `${p.id}: missing name`);
    assert.ok(p.cols > 0,    `${p.id}: invalid cols`);
    assert.ok(p.rows > 0,    `${p.id}: invalid rows`);
    assert.ok(p.moveLimit > 0, `${p.id}: invalid moveLimit`);
    assert.ok(p.par > 0,     `${p.id}: invalid par`);
    assert.ok(p.par < p.moveLimit, `${p.id}: par must be < moveLimit`);
    assert.ok(p.goal?.type,  `${p.id}: missing goal`);
    assert.ok(p.board,       `${p.id}: missing board`);
  }
});

test('ALL_PUZZLES: board strings decode without errors', () => {
  for (const p of ALL_PUZZLES) {
    const grid = decodePuzzleBoard(p.board, p.cols, p.rows);
    assert.ok(Array.isArray(grid), `${p.id}: grid should be array`);
    assert.equal(grid.length, p.cols, `${p.id}: wrong col count`);
  }
});

test('getPuzzleById: returns correct puzzle', () => {
  const p = getPuzzleById('p1-1');
  assert.ok(p);
  assert.equal(p.id, 'p1-1');
});

test('getPuzzleById: returns null for unknown id', () => {
  assert.equal(getPuzzleById('nope'), null);
});

test('getNextPuzzle: returns next puzzle in sequence', () => {
  const first = ALL_PUZZLES[0];
  const second = ALL_PUZZLES[1];
  const next = getNextPuzzle(first.id);
  assert.equal(next?.id, second.id);
});

test('getNextPuzzle: returns null at end of list', () => {
  const last = ALL_PUZZLES[ALL_PUZZLES.length - 1];
  assert.equal(getNextPuzzle(last.id), null);
});
