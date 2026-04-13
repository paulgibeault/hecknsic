/**
 * puzzles.js — Puzzle mode definitions and state management.
 *
 * A puzzle is a fixed board state + a goal + a move limit.
 * No random refills — every piece matters, no new tiles fall.
 *
 * Goal types:
 *   clear_color  — clear all tiles of a target colorIndex
 *   defuse_bomb  — board has a pre-placed bomb; clear it before it hits 0
 *   make_starflower — form at least N starflowers
 *   score        — reach a target score
 *   clear_all    — clear every tile from the board
 *
 * Star ratings (per puzzle):
 *   ⭐    — solved but over par
 *   ⭐⭐  — solved at exactly par
 *   ⭐⭐⭐ — solved under par (fewer moves than par)
 */

import { PIECE_COLORS } from './constants.js';

// ─── Board encoding helpers ─────────────────────────────────────

/**
 * Decode a compact board string into a grid array.
 *
 * Format: "col:row:colorIndex[:special] ..." space-separated tokens.
 * Special values: 's' = starflower, 'b{N}' = bomb with timer N, 'p' = blackpearl.
 * Empty cells are null (not listed).
 *
 * Example: "0:0:0 0:1:2 1:0:3b8"  — col 0 row 0 = red, col 0 row 1 = blue, col 1 row 0 = orange with bomb timer 8
 */
export function decodePuzzleBoard(encoded, cols, rows) {
  const grid = [];
  for (let c = 0; c < cols; c++) {
    grid[c] = [];
    for (let r = 0; r < rows; r++) grid[c][r] = null;
  }

  if (!encoded) return grid;

  for (const token of encoded.trim().split(/\s+/)) {
    const parts = token.split(':');
    if (parts.length < 3) continue;
    const c = parseInt(parts[0]);
    const r = parseInt(parts[1]);
    const raw = parts[2];

    // parse colorIndex and optional special suffix
    let colorIndex = -1;
    let special = null;
    let bombTimer = null;

    const bombMatch = raw.match(/^(\d+)b(\d+)$/);
    const sfMatch   = raw.match(/^(\d+)s$/);
    const bpMatch   = raw.match(/^(\d+)p$/);

    if (bombMatch) {
      colorIndex = parseInt(bombMatch[1]);
      special    = 'bomb';
      bombTimer  = parseInt(bombMatch[2]);
    } else if (sfMatch) {
      colorIndex = parseInt(sfMatch[1]);
      special    = 'starflower';
    } else if (bpMatch) {
      colorIndex = parseInt(bpMatch[1]);
      special    = 'blackpearl';
    } else {
      colorIndex = parseInt(raw);
    }

    if (c >= 0 && c < cols && r >= 0 && r < rows) {
      // Clamp colorIndex to valid range to guard against crafted share codes.
      // Special pieces (starflower/blackpearl) use colorIndex -1/-2 — those are fine.
      const MAX_COLOR = 5; // PIECE_COLORS.length + EXTRA_COLORS.length
      if (colorIndex >= 0) colorIndex = Math.min(colorIndex, MAX_COLOR - 1);
      grid[c][r] = { colorIndex, special };
      if (bombTimer !== null) grid[c][r].bombTimer = bombTimer;
    }
  }
  return grid;
}

/**
 * Encode a live grid back to compact string (for the puzzle editor).
 */
export function encodePuzzleBoard(grid, cols, rows) {
  const tokens = [];
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const cell = grid[c][r];
      if (!cell) continue;
      let token = `${c}:${r}:${cell.colorIndex}`;
      if (cell.special === 'bomb')       token += `b${cell.bombTimer ?? 15}`;
      else if (cell.special === 'starflower') token += 's';
      else if (cell.special === 'blackpearl') token += 'p';
      tokens.push(token);
    }
  }
  return tokens.join(' ');
}

// ─── Goal helpers ───────────────────────────────────────────────

/**
 * Evaluate whether the puzzle goal has been met.
 * Returns { met: bool, progress: string } so the UI can show progress.
 */
export function evaluateGoal(goal, grid, stats, cols, rows) {
  switch (goal.type) {
    case 'clear_color': {
      let remaining = 0;
      for (let c = 0; c < cols; c++)
        for (let r = 0; r < rows; r++)
          // Intentional: bombs/starflowers/blackpearls with a matching colorIndex are excluded.
          // A bomb of the target color must be defused separately; it doesn't satisfy clear_color.
          if (grid[c]?.[r] && grid[c][r].colorIndex === goal.colorIndex && !grid[c][r].special)
            remaining++;
      return {
        met: remaining === 0,
        progress: remaining === 0 ? 'Done!' : `${remaining} ${PIECE_COLORS[goal.colorIndex]?.name ?? 'color'} left`,
      };
    }

    case 'defuse_bomb': {
      let bombs = 0;
      for (let c = 0; c < cols; c++)
        for (let r = 0; r < rows; r++)
          if (grid[c][r]?.special === 'bomb') bombs++;
      return {
        met: bombs === 0 && stats.totalMoves > 0,
        progress: bombs === 0 ? 'Defused!' : `${bombs} bomb${bombs > 1 ? 's' : ''} active`,
      };
    }

    case 'make_starflower': {
      const needed = goal.count ?? 1;
      const made   = stats.starflowersMade ?? 0;
      return {
        met: made >= needed,
        progress: `${Math.min(made, needed)} / ${needed} starflower${needed > 1 ? 's' : ''}`,
      };
    }

    case 'score': {
      const target = goal.target;
      const current = stats.score ?? 0;
      return {
        met: current >= target,
        progress: `${current} / ${target} pts`,
      };
    }

    case 'clear_all': {
      let remaining = 0;
      for (let c = 0; c < cols; c++)
        for (let r = 0; r < rows; r++)
          if (grid[c][r]) remaining++;
      return {
        met: remaining === 0,
        progress: remaining === 0 ? 'Board cleared!' : `${remaining} tiles left`,
      };
    }

    default:
      return { met: false, progress: '?' };
  }
}

/**
 * Goal description for the HUD.
 */
export function describeGoal(goal) {
  switch (goal.type) {
    case 'clear_color':   return `Clear all ${PIECE_COLORS[goal.colorIndex]?.name ?? 'colored'} tiles`;
    case 'defuse_bomb':   return 'Defuse the bomb';
    case 'make_starflower': return `Form ${goal.count ?? 1} starflower${(goal.count ?? 1) > 1 ? 's' : ''}`;
    case 'score':         return `Reach ${goal.target} points`;
    case 'clear_all':     return 'Clear the board';
    default:              return 'Complete the goal';
  }
}

// ─── Star rating ────────────────────────────────────────────────

/**
 * Compute star rating 0–3.
 *   3 stars — solved under par
 *   2 stars — solved at par
 *   1 star  — solved but over par
 *   0 stars — exceeded move limit (shouldn't happen, but guarded)
 */
export function computeStars(puzzle, movesUsed, _maxChain) {
  if (movesUsed > puzzle.moveLimit) return 0; // shouldn't happen but guard it
  if (movesUsed > puzzle.par) return 1;
  if (movesUsed === puzzle.par) return 2;
  return 3;
}

// ─── Puzzle registry ────────────────────────────────────────────
// Sectors unlock in order. Each puzzle is hand-crafted.
// Board strings use the compact encoding above.
// colorIndex: 0=red 1=orange 2=blue 3=green 4=purple

export const PUZZLE_SECTORS = [
  {
    id: 'sector-1',
    name: 'Sector 1 — First Contact',
    description: 'Learn the basics. Small boards, simple goals.',
    puzzles: [
      {
        id: 'p1-1',
        name: 'Red Alert',
        description: 'A small cluster of red tiles blocks your path. Clear them all.',
        cols: 5,
        rows: 5,
        moveLimit: 10,
        par: 6,
        noRefill: true,
        goal: { type: 'clear_color', colorIndex: 0 },
        // 5x5 board: scattered reds in a loosely matchable arrangement
        board: '0:0:0 0:1:2 0:2:3 0:3:0 0:4:2 ' +
               '1:0:2 1:1:0 1:2:2 1:3:3 1:4:0 ' +
               '2:0:3 2:1:2 2:2:0 2:3:2 2:4:3 ' +
               '3:0:0 3:1:3 3:2:2 3:3:0 3:4:2 ' +
               '4:0:2 4:1:0 4:2:3 4:3:2 4:4:0',
      },
      {
        id: 'p1-2',
        name: 'Short Fuse',
        description: 'A bomb just landed. You have 8 moves to defuse it — match the tiles around it before it blows.',
        cols: 5,
        rows: 5,
        moveLimit: 8,
        par: 5,
        noRefill: true,
        goal: { type: 'defuse_bomb' },
        // bomb at 2:2, surrounded by orange (1) — player needs to match orange tiles to it
        board: '0:0:1 0:1:3 0:2:1 0:3:3 0:4:1 ' +
               '1:0:3 1:1:1 1:2:1 1:3:1 1:4:3 ' +
               '2:0:1 2:1:1 2:2:1b8 2:3:1 2:4:1 ' +
               '3:0:3 3:1:1 3:2:1 3:3:1 3:4:3 ' +
               '4:0:1 4:1:3 4:2:1 4:3:3 4:4:1',
      },
      {
        id: 'p1-3',
        name: 'Flower Child',
        description: 'Arrange the board to form a starflower. One rotation will do it — if you see it.',
        cols: 5,
        rows: 5,
        moveLimit: 5,
        par: 2,
        noRefill: true,
        goal: { type: 'make_starflower', count: 1 },
        // Near-starflower: center at 2:2 (green/3), ring is 5 greens + 1 almost-green
        // Player needs 1-2 rotations to complete the ring
        board: '0:0:2 0:1:0 0:2:3 0:3:0 0:4:2 ' +
               '1:0:0 1:1:3 1:2:3 1:3:3 1:4:0 ' +
               '2:0:2 2:1:3 2:2:0 2:3:3 2:4:2 ' +
               '3:0:0 3:1:3 3:2:3 3:3:2 3:4:0 ' +
               '4:0:2 4:1:0 4:2:3 4:3:0 4:4:2',
      },
    ],
  },
  {
    id: 'sector-2',
    name: 'Sector 2 — Rising Pressure',
    description: 'Tighter move limits. Bombs become tools, not just threats.',
    puzzles: [
      {
        id: 'p2-1',
        name: 'Score Rush',
        description: 'No timer, no bomb — just raw scoring. Build chains to hit the target.',
        cols: 7,
        rows: 7,
        moveLimit: 15,
        par: 10,
        noRefill: true,
        goal: { type: 'score', target: 200 },
        board: '0:0:0 0:1:1 0:2:0 0:3:2 0:4:0 0:5:1 0:6:0 ' +
               '1:0:2 1:1:0 1:2:1 1:3:0 1:4:2 1:5:0 1:6:2 ' +
               '2:0:1 2:1:2 2:2:0 2:3:1 2:4:0 2:5:2 2:6:1 ' +
               '3:0:0 3:1:1 3:2:2 3:3:0 3:4:1 3:5:0 3:6:2 ' +
               '4:0:2 4:1:0 4:2:1 4:3:2 4:4:0 4:5:1 4:6:0 ' +
               '5:0:1 5:1:2 5:2:0 5:3:1 5:4:2 5:5:0 5:6:1 ' +
               '6:0:0 6:1:1 6:2:2 6:3:0 6:4:1 6:5:2 6:6:0',
      },
      {
        id: 'p2-2',
        name: 'Controlled Burn',
        description: 'Two bombs, one color cluster. Let one detonate to clear the path for the other.',
        cols: 7,
        rows: 7,
        moveLimit: 12,
        par: 8,
        noRefill: true,
        goal: { type: 'defuse_bomb' },
        board: '0:0:2 0:1:0 0:2:2 0:3:0 0:4:2 0:5:0 0:6:2 ' +
               '1:0:0 1:1:2 1:2:0 1:3:2 1:4:0 1:5:2 1:6:0 ' +
               '2:0:2 2:1:0 2:2:2b10 2:3:0 2:4:2 2:5:0 2:6:2 ' +
               '3:0:0 3:1:2 3:2:0 3:3:2 3:4:0 3:5:2 3:6:0 ' +
               '4:0:2 4:1:0 4:2:2 4:3:0 4:4:2b10 4:5:0 4:6:2 ' +
               '5:0:0 5:1:2 5:2:0 5:3:2 5:4:0 5:5:2 5:6:0 ' +
               '6:0:2 6:1:0 6:2:2 6:3:0 6:4:2 6:5:0 6:6:2',
      },
      {
        id: 'p2-3',
        name: 'The Long Chain',
        description: 'The board is primed for cascades. Find the trigger — one rotation should start a chain reaction.',
        cols: 7,
        rows: 7,
        moveLimit: 8,
        par: 3,
        noRefill: true,
        goal: { type: 'score', target: 350 },
        // Pre-staged cascade: columns of matching colors arranged to fall into each other
        board: '0:0:0 0:1:0 0:2:0 0:3:1 0:4:1 0:5:2 0:6:2 ' +
               '1:0:1 1:1:1 1:2:1 1:3:0 1:4:0 1:5:3 1:6:3 ' +
               '2:0:2 2:1:2 2:2:2 2:3:3 2:4:3 2:5:0 2:6:0 ' +
               '3:0:3 3:1:3 3:2:3 3:3:2 3:4:2 3:5:1 3:6:1 ' +
               '4:0:0 4:1:0 4:2:1 4:3:1 4:4:2 4:5:2 4:6:3 ' +
               '5:0:1 5:1:2 5:2:0 5:3:3 5:4:1 5:5:0 5:6:2 ' +
               '6:0:2 6:1:3 6:2:1 6:3:0 6:4:3 6:5:1 6:6:0',
      },
    ],
  },
  {
    id: 'sector-3',
    name: 'Sector 3 — Expert Circuit',
    description: 'Larger boards. Every move counts. Some will take multiple attempts.',
    puzzles: [
      {
        id: 'p3-1',
        name: 'Purple Rain',
        description: 'The board is dominated by purple. Strip it down to nothing — 9 moves, no mercy.',
        cols: 7,
        rows: 7,
        moveLimit: 14,
        par: 9,
        noRefill: true,
        goal: { type: 'clear_color', colorIndex: 4 },
        board: '0:0:4 0:1:2 0:2:4 0:3:0 0:4:4 0:5:2 0:6:4 ' +
               '1:0:2 1:1:4 1:2:2 1:3:4 1:4:2 1:5:4 1:6:2 ' +
               '2:0:4 2:1:0 2:2:4 2:3:2 2:4:4 2:5:0 2:6:4 ' +
               '3:0:0 3:1:4 3:2:0 3:3:4 3:4:0 3:5:4 3:6:0 ' +
               '4:0:4 4:1:2 4:2:4 4:3:0 4:4:4 4:5:2 4:6:4 ' +
               '5:0:2 5:1:4 5:2:2 5:3:4 5:4:2 5:5:4 5:6:2 ' +
               '6:0:4 6:1:0 6:2:4 6:3:2 6:4:4 6:5:0 6:6:4',
      },
      {
        id: 'p3-2',
        name: 'Bloom',
        description: 'The board is seeded for a double starflower. Find the two centers — they\'re closer than you think.',
        cols: 7,
        rows: 7,
        moveLimit: 12,
        par: 7,
        noRefill: true,
        goal: { type: 'make_starflower', count: 2 },
        // Two near-starflower formations — one green ring at (2,3), one blue ring at (5,3)
        // Each needs 1–2 rotations to complete
        board: '0:0:1 0:1:0 0:2:3 0:3:3 0:4:3 0:5:0 0:6:1 ' +
               '1:0:0 1:1:3 1:2:0 1:3:0 1:4:0 1:5:2 1:6:0 ' +
               '2:0:3 2:1:0 2:2:3 2:3:1 2:4:3 2:5:0 2:6:3 ' +
               '3:0:3 3:1:0 3:2:0 3:3:3 3:4:0 3:5:0 3:6:3 ' +
               '4:0:3 4:1:2 4:2:3 4:3:1 4:4:3 4:5:2 4:6:3 ' +
               '5:0:0 5:1:2 5:2:0 5:3:0 5:4:0 5:5:2 5:6:0 ' +
               '6:0:1 6:1:0 6:2:2 6:3:2 6:4:2 6:5:0 6:6:1',
      },
      {
        id: 'p3-3',
        name: 'Dead Board Walking',
        description: 'The board is nearly locked. You have 6 moves to score 500 before it all freezes.',
        cols: 7,
        rows: 7,
        moveLimit: 10,
        par: 6,
        noRefill: true,
        goal: { type: 'score', target: 500 },
        // Dense same-color clusters ready to cascade if you can trigger the first break
        board: '0:0:0 0:1:0 0:2:0 0:3:0 0:4:1 0:5:1 0:6:1 ' +
               '1:0:0 1:1:0 1:2:0 1:3:1 1:4:1 1:5:1 1:6:2 ' +
               '2:0:0 2:1:0 2:2:1 2:3:1 2:4:1 2:5:2 2:6:2 ' +
               '3:0:0 3:1:1 3:2:1 3:3:1 3:4:2 3:5:2 3:6:2 ' +
               '4:0:1 4:1:1 4:2:1 4:3:2 4:4:2 4:5:2 4:6:3 ' +
               '5:0:1 5:1:1 5:2:2 5:3:2 5:4:2 5:5:3 5:6:3 ' +
               '6:0:1 6:1:2 6:2:2 6:3:2 6:4:3 6:5:3 6:6:3',
      },
      {
        id: 'p3-4',
        name: 'The Gauntlet',
        description: 'Three bombs. All different colors. All ticking. Welcome to the Gauntlet.',
        cols: 7,
        rows: 7,
        moveLimit: 15,
        par: 10,
        noRefill: true,
        goal: { type: 'defuse_bomb' },
        board: '0:0:0 0:1:1 0:2:2 0:3:3 0:4:2 0:5:1 0:6:0 ' +
               '1:0:1 1:1:0 1:2:1 1:3:2 1:4:1 1:5:0 1:6:1 ' +
               '2:0:2 2:1:1 2:2:0b12 2:3:1 2:4:0 2:5:1 2:6:2 ' +
               '3:0:3 3:1:2 3:2:1 3:3:3 3:4:1 3:5:2 3:6:3 ' +
               '4:0:2 4:1:1 4:2:2 4:3:1 4:4:2b12 4:5:1 4:6:2 ' +
               '5:0:1 5:1:0 5:2:3 5:3:2 5:4:3 5:5:3b12 5:6:1 ' +
               '6:0:0 6:1:1 6:2:2 6:3:3 6:4:2 6:5:1 6:6:0',
      },
    ],
  },
];

// ─── Flat puzzle lookup ─────────────────────────────────────────

export const ALL_PUZZLES = PUZZLE_SECTORS.flatMap(s => s.puzzles.map(p => ({ ...p, sectorId: s.id })));

export function getPuzzleById(id) {
  return ALL_PUZZLES.find(p => p.id === id) ?? null;
}

export function getNextPuzzle(currentId) {
  const idx = ALL_PUZZLES.findIndex(p => p.id === currentId);
  return idx >= 0 && idx + 1 < ALL_PUZZLES.length ? ALL_PUZZLES[idx + 1] : null;
}
