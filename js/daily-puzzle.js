/**
 * daily-puzzle.js — Date-seeded daily puzzle generation.
 *
 * Every day everyone gets the same board. No server needed.
 * Board is deterministically generated from the date string as a seed.
 *
 * Goals rotate on a weekly cycle so each day has a different challenge type.
 */

import { PIECE_COLORS, GRID_COLS, GRID_ROWS } from './constants.js';
import { getPuzzleProgress, savePuzzleProgress } from './storage.js';

// ─── Seeded RNG (mulberry32) ────────────────────────────────────

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}

// ─── Daily puzzle ID ────────────────────────────────────────────

export function getDailyDateString(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

export function getDailyPuzzleId(dateStr) {
  return `daily:${dateStr}`;
}

// ─── Board generation ───────────────────────────────────────────

const DAILY_SIZES = [
  { cols: 7, rows: 7 },
  { cols: 7, rows: 7 },
  { cols: 9, rows: 9 },
];

const WEEKLY_GOAL_CYCLE = [
  'clear_color',     // Mon
  'defuse_bomb',     // Tue
  'make_starflower', // Wed
  'score',           // Thu
  'clear_color',     // Fri
  'clear_all',       // Sat
  'score',           // Sun
];

/**
 * Generate a daily puzzle definition from a date string.
 * @param {string} dateStr — "YYYY-MM-DD"
 * @returns puzzle object (same shape as PUZZLE_SECTORS entries)
 */
export function generateDailyPuzzle(dateStr) {
  const seed = hashString(dateStr);
  const rng  = mulberry32(seed);

  // Board size based on day-of-month thirds
  const dayOfMonth = parseInt(dateStr.slice(8));
  const sizeIdx    = dayOfMonth <= 10 ? 0 : dayOfMonth <= 20 ? 1 : 2;
  const { cols, rows } = DAILY_SIZES[sizeIdx];

  // Goal from weekly cycle
  const dayOfWeek = new Date(dateStr + 'T12:00:00Z').getUTCDay(); // 0=Sun
  const goalType  = WEEKLY_GOAL_CYCLE[dayOfWeek];

  // Move limit: scales with board size — generous enough to be solvable
  const cellCount  = cols * rows;
  const moveLimit  = Math.round(cellCount * 0.35 + 5);
  const par        = Math.round(moveLimit * 0.65);

  // Number of colors: 3 early month, 4 mid, 5 late
  const numColors  = sizeIdx === 0 ? 3 : sizeIdx === 1 ? 4 : 5;

  // Generate board with seeded RNG.
  // Use a Map keyed by "c,r" for O(1) neighbour lookup instead of O(n) Array.find.
  const gridData = [];
  const gridMap  = new Map();
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const cell = { c, r, colorIndex: Math.floor(rng() * numColors), special: null };
      gridData.push(cell);
      gridMap.set(`${c},${r}`, cell);
    }
  }

  // Break obvious 3-in-a-row (simple pass — won't be perfect but avoids instant clears)
  for (let pass = 0; pass < 3; pass++) {
    for (const cell of gridData) {
      const { c, r } = cell;
      const neighbors = [
        gridMap.get(`${c+1},${r}`),
        gridMap.get(`${c},${r+1}`),
        gridMap.get(`${c+1},${r-1}`),
      ];
      for (const n of neighbors) {
        if (n && n.colorIndex === cell.colorIndex) {
          n.colorIndex = (n.colorIndex + 1 + Math.floor(rng() * (numColors - 1))) % numColors;
        }
      }
    }
  }

  // Build goal
  let goal;
  let targetColorIndex = null;
  switch (goalType) {
    case 'clear_color': {
      // Pick the color with the most tiles
      const counts = Array(numColors).fill(0);
      gridData.forEach(c => counts[c.colorIndex]++);
      targetColorIndex = counts.indexOf(Math.max(...counts));
      goal = { type: 'clear_color', colorIndex: targetColorIndex };
      break;
    }
    case 'defuse_bomb': {
      // Place a bomb on a random cell
      const idx = Math.floor(rng() * gridData.length);
      gridData[idx].special = 'bomb';
      gridData[idx].bombTimer = Math.round(moveLimit * 0.6);
      goal = { type: 'defuse_bomb' };
      break;
    }
    case 'make_starflower': {
      goal = { type: 'make_starflower', count: 1 };
      break;
    }
    case 'score': {
      goal = { type: 'score', target: Math.round(cellCount * 3.5) };
      break;
    }
    case 'clear_all': {
      // clear_all on a 9×9 board is not reliably solvable.
      // Constrain to a 5×5 sub-region of the generated board so the goal is achievable.
      // gridData is already generated — just truncate to the top-left 5×5 cells.
      const clearCols = 5, clearRows = 5;
      gridData.splice(0, gridData.length,
        ...gridData.filter(({ c, r }) => c < clearCols && r < clearRows)
      );
      goal = { type: 'clear_all', _boardCols: clearCols, _boardRows: clearRows };
      break;
    }
    default:
      goal = { type: 'score', target: 100 };
  }

  // Encode board string
  const board = gridData.map(({ c, r, colorIndex, special, bombTimer }) => {
    let token = `${c}:${r}:${colorIndex}`;
    if (special === 'bomb') token += `b${bombTimer}`;
    else if (special === 'starflower') token += 's';
    else if (special === 'blackpearl') token += 'p';
    return token;
  }).join(' ');

  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const goalLabels = {
    clear_color:     `Clear all ${PIECE_COLORS[targetColorIndex]?.name ?? 'colored'} tiles`,
    defuse_bomb:     'Defuse the bomb',
    make_starflower: 'Form a starflower',
    score:           `Score ${goal.target} points`,
    clear_all:       'Clear the board',
  };

  // clear_all goal uses a smaller board — use overrides if present
  const finalCols = goal._boardCols ?? cols;
  const finalRows = goal._boardRows ?? rows;
  // Strip internal _board* hints from the goal before returning
  const { _boardCols, _boardRows, ...cleanGoal } = goal;
  // Recalculate move limit for smaller clear_all boards
  const finalMoveLimit = (finalCols !== cols)
    ? Math.round(finalCols * finalRows * 0.5 + 4)
    : moveLimit;
  const finalPar = Math.round(finalMoveLimit * 0.65);

  return {
    id:          getDailyPuzzleId(dateStr),
    name:        `Daily — ${dateStr}`,
    description: `${dayNames[dayOfWeek]}'s challenge: ${goalLabels[goalType]}`,
    cols:        finalCols,
    rows:        finalRows,
    moveLimit:   finalMoveLimit,
    par:         finalPar,
    noRefill: true,
    goal:        cleanGoal,
    board,
    isDaily: true,
    dateStr,
  };
}

// ─── Daily progress helpers ─────────────────────────────────────

export function getDailyProgress(dateStr) {
  return getPuzzleProgress(getDailyPuzzleId(dateStr));
}

export function saveDailyProgress(dateStr, result) {
  savePuzzleProgress(getDailyPuzzleId(dateStr), result);
}

export function getTodaysPuzzle() {
  return generateDailyPuzzle(getDailyDateString());
}
