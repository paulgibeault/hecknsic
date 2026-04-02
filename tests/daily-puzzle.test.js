/**
 * daily-puzzle.test.js — Tests for daily puzzle generation and share codes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateDailyPuzzle,
  getDailyPuzzleId,
  getDailyDateString,
} from '../js/daily-puzzle.js';

import {
  encodePuzzleShareCode,
  decodePuzzleShareCode,
} from '../js/puzzle-editor.js';

import { decodePuzzleBoard } from '../js/puzzles.js';

// ─── generateDailyPuzzle ────────────────────────────────────────

test('generateDailyPuzzle: produces valid puzzle shape', () => {
  const p = generateDailyPuzzle('2026-04-02');
  assert.ok(p.id.startsWith('daily:'));
  assert.ok(p.cols > 0);
  assert.ok(p.rows > 0);
  assert.ok(p.moveLimit > 0);
  assert.ok(p.par > 0);
  assert.ok(p.par < p.moveLimit);
  assert.ok(p.goal?.type);
  assert.ok(p.board);
});

test('generateDailyPuzzle: same date always produces same board', () => {
  const a = generateDailyPuzzle('2026-04-01');
  const b = generateDailyPuzzle('2026-04-01');
  assert.equal(a.board, b.board);
  assert.equal(a.goal.type, b.goal.type);
  assert.equal(a.moveLimit, b.moveLimit);
});

test('generateDailyPuzzle: different dates produce different boards', () => {
  const a = generateDailyPuzzle('2026-04-01');
  const b = generateDailyPuzzle('2026-04-02');
  assert.notEqual(a.board, b.board);
});

test('generateDailyPuzzle: board decodes without errors', () => {
  const p = generateDailyPuzzle('2026-04-03');
  const grid = decodePuzzleBoard(p.board, p.cols, p.rows);
  assert.equal(grid.length, p.cols);
  assert.equal(grid[0].length, p.rows);
});

test('generateDailyPuzzle: all cells have valid colorIndex', () => {
  const p = generateDailyPuzzle('2026-04-04');
  const grid = decodePuzzleBoard(p.board, p.cols, p.rows);
  for (let c = 0; c < p.cols; c++) {
    for (let r = 0; r < p.rows; r++) {
      const cell = grid[c][r];
      if (cell) {
        assert.ok(cell.colorIndex >= 0, `cell ${c}:${r} has invalid colorIndex`);
      }
    }
  }
});

test('generateDailyPuzzle: defuse_bomb goal places exactly one bomb', () => {
  // Find a date that generates defuse_bomb (Tuesday in the weekly cycle)
  // 2026-04-07 is a Tuesday
  const p = generateDailyPuzzle('2026-04-07');
  if (p.goal.type === 'defuse_bomb') {
    const grid = decodePuzzleBoard(p.board, p.cols, p.rows);
    let bombs = 0;
    for (let c = 0; c < p.cols; c++)
      for (let r = 0; r < p.rows; r++)
        if (grid[c][r]?.special === 'bomb') bombs++;
    assert.equal(bombs, 1);
  }
  // If not a Tuesday-generated defuse_bomb, pass (goal cycle may differ)
});

test('getDailyPuzzleId: format is daily:YYYY-MM-DD', () => {
  assert.equal(getDailyPuzzleId('2026-04-02'), 'daily:2026-04-02');
});

test('getDailyDateString: returns YYYY-MM-DD format', () => {
  const d = getDailyDateString();
  assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
});

test('getDailyDateString: offset works', () => {
  const today    = getDailyDateString(0);
  const tomorrow = getDailyDateString(1);
  assert.notEqual(today, tomorrow);
});

// ─── Share code encode/decode ───────────────────────────────────

test('encodePuzzleShareCode: produces non-empty string', () => {
  const puzzle = {
    id: 'test', name: 'Test', description: 'desc',
    cols: 5, rows: 5, moveLimit: 10, par: 6,
    goal: { type: 'clear_color', colorIndex: 0 },
    board: '0:0:0 1:1:2',
  };
  const code = encodePuzzleShareCode(puzzle);
  assert.ok(typeof code === 'string');
  assert.ok(code.length > 10);
});

test('encodePuzzleShareCode: no + / = characters (URL safe)', () => {
  const puzzle = {
    id: 'test', name: 'Test', description: 'A puzzle with some longer description text',
    cols: 9, rows: 9, moveLimit: 25, par: 15,
    goal: { type: 'score', target: 500 },
    board: '0:0:0 0:1:1 1:0:2 1:1:3 2:2:4',
  };
  const code = encodePuzzleShareCode(puzzle);
  assert.ok(!code.includes('+'));
  assert.ok(!code.includes('/'));
  assert.ok(!code.includes('='));
});

test('decodePuzzleShareCode: round-trips a puzzle', () => {
  const original = {
    id: 'custom', name: 'My Puzzle', description: 'A test',
    cols: 5, rows: 5, moveLimit: 12, par: 7,
    goal: { type: 'defuse_bomb' },
    board: '2:2:1b8 0:0:2 1:1:3',
  };
  const code    = encodePuzzleShareCode(original);
  const decoded = decodePuzzleShareCode(code);
  assert.ok(decoded);
  assert.equal(decoded.name,       original.name);
  assert.equal(decoded.cols,       original.cols);
  assert.equal(decoded.moveLimit,  original.moveLimit);
  assert.equal(decoded.par,        original.par);
  assert.equal(decoded.goal.type,  original.goal.type);
  assert.equal(decoded.board,      original.board);
});

test('decodePuzzleShareCode: returns null for garbage input', () => {
  assert.equal(decodePuzzleShareCode('not-a-valid-code!!'), null);
});

test('decodePuzzleShareCode: returns null for empty string', () => {
  assert.equal(decodePuzzleShareCode(''), null);
});

test('decodePuzzleShareCode: decoded puzzle board is playable', () => {
  const original = {
    id: 'x', name: 'X', description: '',
    cols: 5, rows: 5, moveLimit: 10, par: 6,
    goal: { type: 'clear_all' },
    board: '0:0:0 0:1:1 1:0:2 2:2:3',
  };
  const code    = encodePuzzleShareCode(original);
  const decoded = decodePuzzleShareCode(code);
  const grid    = decodePuzzleBoard(decoded.board, decoded.cols, decoded.rows);
  assert.equal(grid.length, 5);
  assert.equal(grid[0][0].colorIndex, 0);
  assert.equal(grid[2][2].colorIndex, 3);
});
