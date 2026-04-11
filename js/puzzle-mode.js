/**
 * puzzle-mode.js — Puzzle mode controller.
 *
 * Owns:
 *   - Puzzle selector UI (modal-puzzle-select)
 *   - Active puzzle HUD overlay (goal, moves remaining)
 *   - Puzzle result/failed modals
 *   - Integration hooks called from main.js game loop
 */

import {
  PUZZLE_SECTORS,
  ALL_PUZZLES,
  getPuzzleById,
  getNextPuzzle,
  decodePuzzleBoard,
  evaluateGoal,
  describeGoal,
  computeStars,
} from './puzzles.js';
import { getNeighbors } from './hex-math.js';
import { findMatchesForMode } from './board.js';
import { detectStarflowers, detectBlackPearls, detectGrandPoobahs } from './specials.js';

import {
  getPuzzleProgress,
  savePuzzleProgress,
  isSectorUnlocked,
} from './storage.js';
import { getTodaysPuzzle, getDailyDateString, getDailyProgress } from './daily-puzzle.js';
import { showPuzzleEditor, registerEditorCallbacks, initPuzzleEditorUI } from './puzzle-editor.js';

// ─── Active puzzle state ────────────────────────────────────────

let activePuzzle   = null;  // current puzzle definition
let movesUsed      = 0;
let maxChain       = 0;     // highest chain level seen this run
let stats          = { totalMoves: 0, starflowersMade: 0, score: 0 };
let goalMet        = false;
let puzzleDone     = false; // guard against double-fire from concurrent setTimeout branches
let _onPuzzleLoad  = null;  // callback(grid, cols, rows, puzzle) — set by main.js
let _onPuzzleEnd   = null;  // callback(reason) — 'complete' | 'failed'
// Custom/daily puzzle cache — capped at 14 entries (LRU by insertion order via Map)
let _customPuzzles = new Map();

// ─── Public API ─────────────────────────────────────────────────

export function registerPuzzleCallbacks(onLoad, onEnd) {
  _onPuzzleLoad = onLoad;
  _onPuzzleEnd  = onEnd;
}

export function getActivePuzzle()   { return activePuzzle; }
export function getPuzzleMovesLeft(){ return activePuzzle ? activePuzzle.moveLimit - movesUsed : 0; }
export function getPuzzleMovesUsed(){ return movesUsed; }
export function getPuzzleStats()    { return stats; }

/**
 * Load and start a puzzle by id or by puzzle object directly (custom/daily).
 */
export function startPuzzle(puzzleIdOrObject) {
  let puzzle;
  if (typeof puzzleIdOrObject === 'object') {
    puzzle = puzzleIdOrObject;
    // Register in LRU cache; evict oldest when over cap
    _customPuzzles.set(puzzle.id, puzzle);
    if (_customPuzzles.size > 14) _customPuzzles.delete(_customPuzzles.keys().next().value);
  } else {
    puzzle = getPuzzleById(puzzleIdOrObject) ?? _customPuzzles.get(puzzleIdOrObject);
  }
  if (!puzzle) { console.error('Unknown puzzle:', puzzleIdOrObject); return; }

  activePuzzle = puzzle;
  movesUsed    = 0;
  maxChain     = 0;
  goalMet      = false;
  puzzleDone   = false;
  stats        = { totalMoves: 0, starflowersMade: 0, score: 0 };

  hidePuzzleModals();

  const grid = decodePuzzleBoard(puzzle.board, puzzle.cols, puzzle.rows);

  if (_onPuzzleLoad) _onPuzzleLoad(grid, puzzle.cols, puzzle.rows, puzzle);

  updatePuzzleHUD();
  showPuzzleHUD(true);
}

/**
 * Called by main.js after every player move (postRotationCheck).
 * Pass the current grid, score, and chain level.
 */
export function onPuzzleMove(grid, score, chainLevel) {
  if (!activePuzzle) return;

  movesUsed++;
  stats.totalMoves = movesUsed;
  stats.score      = score;
  if (chainLevel > maxChain) maxChain = chainLevel;

  // Check goal
  const result = evaluateGoal(activePuzzle.goal, grid, stats, activePuzzle.cols, activePuzzle.rows);
  updateGoalProgress(result.progress);

  if (result.met && !goalMet && !puzzleDone) {
    goalMet = true;
    puzzleDone = true;
    const stars = computeStars(activePuzzle, movesUsed, maxChain);
    savePuzzleProgress(activePuzzle.id, { stars, movesUsed, score: stats.score ?? 0 });
    setTimeout(() => showPuzzleResult(stars), 600);
    return;
  }

  // Out of moves?
  if (movesUsed >= activePuzzle.moveLimit && !goalMet && !puzzleDone) {
    puzzleDone = true;
    setTimeout(() => showPuzzleFailed(), 600);
    return;
  }

  // No valid moves remaining? (deadlock)
  if (!goalMet && !puzzleDone && !hasValidMoves(grid, activePuzzle.cols, activePuzzle.rows)) {
    puzzleDone = true;
    setTimeout(() => showPuzzleFailed('No more valid moves!'), 600);
    return;
  }

  updatePuzzleHUD();
}

/**
 * Track starflowers created during puzzle (for make_starflower goal).
 */
export function onStarflowerCreated() {
  if (!activePuzzle) return;
  stats.starflowersMade++;
}

/**
 * Reset active puzzle state (e.g. when leaving puzzle mode).
 */
export function clearActivePuzzle() {
  activePuzzle = null;
  // Restore standard HUD layout (score group visible, puzzle group hidden)
  const scoreGroup = document.getElementById('hud-score-group');
  const puzzleGroup = document.getElementById('hud-puzzle-group');
  if (scoreGroup)  scoreGroup.style.display = '';
  if (puzzleGroup) puzzleGroup.style.display = 'none';
  // Restore icon buttons hidden by showPuzzleHUD
  const help = document.getElementById('btn-help');
  const scores = document.getElementById('scores-wrapper');
  if (help)   help.style.display = '';
  if (scores) scores.style.display = '';
  hidePuzzleModals();
}

// ─── Puzzle selector modal ──────────────────────────────────────

export function showPuzzleSelector() {
  // Populate daily puzzle row
  const daily = getTodaysPuzzle();
  const dailyProgress = getDailyProgress(getDailyDateString());
  const dailyStars = dailyProgress?.stars ?? 0;
  const nameEl = document.getElementById('daily-puzzle-name');
  const descEl = document.getElementById('daily-puzzle-desc');
  const starsEl = document.getElementById('daily-puzzle-stars');
  if (nameEl) nameEl.textContent = daily.name;
  if (descEl) descEl.textContent = daily.description;
  if (starsEl) starsEl.textContent = '⭐'.repeat(dailyStars) + '☆'.repeat(3 - dailyStars);

  // Populate sector list
  const container = document.getElementById('puzzle-sector-list');
  if (!container) return;
  container.innerHTML = '';

  for (const sector of PUZZLE_SECTORS) {
    const unlocked = isSectorUnlocked(sector.id, PUZZLE_SECTORS);

    const sectorEl = document.createElement('div');
    sectorEl.style.marginBottom = '20px';
    sectorEl.className = unlocked ? '' : 'puzzle-sector-locked';

    const header = document.createElement('div');
    header.className = 'puzzle-sector-header';
    header.textContent = unlocked ? sector.name : `🔒 ${sector.name}`;
    sectorEl.appendChild(header);

    if (!unlocked) {
      const lockMsg = document.createElement('p');
      lockMsg.style.cssText = 'color: #555; font-size: 0.8rem; margin: 4px 0 0 0;';
      lockMsg.textContent = 'Complete previous sector to unlock.';
      sectorEl.appendChild(lockMsg);
    } else {
      for (const puzzle of sector.puzzles) {
        const progress = getPuzzleProgress(puzzle.id);
        const stars    = progress?.stars ?? 0;
        const starStr  = '⭐'.repeat(stars) + '☆'.repeat(3 - stars);

        const btn = document.createElement('button');
        btn.className = 'puzzle-select-btn';

        const info = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'puzzle-btn-name';
        title.textContent = puzzle.name;
        const meta = document.createElement('div');
        meta.className = 'puzzle-btn-meta';
        meta.textContent = `${puzzle.moveLimit} moves · par ${puzzle.par} · ${puzzle.description.slice(0, 50)}…`;
        info.appendChild(title);
        info.appendChild(meta);

        const starDisplay = document.createElement('div');
        starDisplay.className = 'puzzle-btn-stars';
        starDisplay.textContent = starStr;

        btn.appendChild(info);
        btn.appendChild(starDisplay);

        btn.addEventListener('click', () => {
          document.getElementById('modal-puzzle-select').classList.add('hidden');
          startPuzzle(puzzle.id);
        });

        sectorEl.appendChild(btn);
      }
    }

    container.appendChild(sectorEl);
  }

  document.getElementById('modal-puzzle-select').classList.remove('hidden');
}

// ─── Puzzle HUD ─────────────────────────────────────────────────

function showPuzzleHUD(visible) {
  const hud = document.getElementById('game-hud');
  if (!hud) return;

  if (visible) {
    // Switch the unified HUD to puzzle layout
    hud.dataset.mode = 'puzzle';
    const scoreGroup = document.getElementById('hud-score-group');
    const puzzleGroup = document.getElementById('hud-puzzle-group');
    if (scoreGroup)  scoreGroup.style.display = 'none';
    if (puzzleGroup) puzzleGroup.style.display = '';

    const modeEl = document.getElementById('game-hud-mode');
    if (modeEl) modeEl.textContent = '🧩 Puzzle';
  }

  // Hide standalone icon buttons when puzzle HUD is showing (they overlap)
  const help = document.getElementById('btn-help');
  const scores = document.getElementById('scores-wrapper');
  if (help)   help.style.display   = visible ? 'none' : '';
  if (scores) scores.style.display = visible ? 'none' : '';
}

function updatePuzzleHUD() {
  if (!activePuzzle) return;

  const movesLeftEl = document.getElementById('puzzle-moves-left');
  const subtitleEl  = document.getElementById('game-hud-subtitle');
  const parEl       = document.getElementById('puzzle-par-text');

  const movesLeft = activePuzzle.moveLimit - movesUsed;
  if (movesLeftEl) {
    movesLeftEl.textContent = movesLeft;
    movesLeftEl.style.color = movesLeft <= 3 ? '#ff6060'
                            : movesLeft <= 6 ? '#ffaa30'
                            : '#d0d0d8';
  }
  if (subtitleEl) subtitleEl.textContent = describeGoal(activePuzzle.goal);
  if (parEl)      parEl.textContent      = `par ${activePuzzle.par}`;
}

function updateGoalProgress(progressText) {
  const el = document.getElementById('puzzle-goal-progress');
  if (el) el.textContent = progressText;
}

// ─── Result modals ──────────────────────────────────────────────

function showPuzzleResult(stars) {
  showPuzzleHUD(false);

  document.getElementById('puzzle-result-stars').textContent =
    '⭐'.repeat(stars) + '☆'.repeat(3 - stars);

  document.getElementById('puzzle-result-msg').textContent =
    stars === 3 ? 'Perfect — par-breaking solve with a chain combo!' :
    stars === 2 ? 'Efficient solve — hit par!' :
                  'Puzzle cleared! Try for par next time.';

  const statsEl = document.getElementById('puzzle-result-stats');
  statsEl.innerHTML = ''; // Clear securely

  const createRow = (label, valText) => {
    const row = document.createElement('div');
    row.className = 'score-row';
    const labelSpan = document.createElement('span');
    labelSpan.textContent = label;
    const valSpan = document.createElement('span');
    valSpan.className = 'val';
    valSpan.textContent = valText;
    row.appendChild(labelSpan);
    row.appendChild(valSpan);
    return row;
  };

  statsEl.appendChild(createRow('Moves used', `${movesUsed} / ${activePuzzle.moveLimit}`));
  statsEl.appendChild(createRow('Par', activePuzzle.par));
  statsEl.appendChild(createRow('Best chain', maxChain));

  const nextPuzzle = getNextPuzzle(activePuzzle.id);
  const nextBtn    = document.getElementById('btn-puzzle-next');
  if (nextBtn) {
    nextBtn.disabled = !nextPuzzle;
    nextBtn.style.opacity = nextPuzzle ? '1' : '0.4';
    nextBtn.dataset.nextId = nextPuzzle?.id ?? '';
  }

  document.getElementById('modal-puzzle-result').classList.remove('hidden');

  if (_onPuzzleEnd) _onPuzzleEnd('complete');
}

function showPuzzleFailed(reason) {
  showPuzzleHUD(false);

  const titleEl = document.getElementById('puzzle-failed-title');
  if (reason) {
    if (titleEl) titleEl.textContent = 'No Moves Left';
    document.getElementById('puzzle-failed-msg').textContent =
      `${reason} ${describeGoal(activePuzzle.goal)} — so close!`;
  } else {
    if (titleEl) titleEl.textContent = 'Out of Moves';
    document.getElementById('puzzle-failed-msg').textContent =
      `You used all ${activePuzzle.moveLimit} moves. ${describeGoal(activePuzzle.goal)} — so close!`;
  }

  // Score tracking
  const currentScore = stats.score ?? 0;
  const prevProgress = getPuzzleProgress(activePuzzle.id);
  const prevBest = prevProgress?.bestScore ?? 0;
  const isNewRecord = currentScore > 0 && currentScore > prevBest;

  // Save score (even on failure — tracks best score across all attempts)
  savePuzzleProgress(activePuzzle.id, { score: currentScore });

  // Populate score UI
  document.getElementById('puzzle-failed-score').textContent = currentScore.toLocaleString();
  document.getElementById('puzzle-failed-best').textContent =
    Math.max(currentScore, prevBest).toLocaleString();

  const recordEl = document.getElementById('puzzle-failed-new-record');
  if (recordEl) recordEl.style.display = isNewRecord ? 'block' : 'none';

  document.getElementById('modal-puzzle-failed').classList.remove('hidden');

  if (_onPuzzleEnd) _onPuzzleEnd('failed');
}

/**
 * Check if any valid move (cluster rotation) would produce a match or special formation.
 * Simulates CW and CCW rotations of every selectable cluster, ring, and Y-shape,
 * then checks if any rotation produces matches, starflowers, black pearls, or grand poobahs.
 */
function hasValidMoves(grid, cols, rows) {
  function rotateCW3(cells) {
    const s = { ci: cells[0].colorIndex, sp: cells[0].special, bt: cells[0].bombTimer };
    cells[0].colorIndex = cells[2].colorIndex; cells[0].special = cells[2].special; cells[0].bombTimer = cells[2].bombTimer;
    cells[2].colorIndex = cells[1].colorIndex; cells[2].special = cells[1].special; cells[2].bombTimer = cells[1].bombTimer;
    cells[1].colorIndex = s.ci; cells[1].special = s.sp; cells[1].bombTimer = s.bt;
  }
  function rotateCCW3(cells) {
    const s = { ci: cells[0].colorIndex, sp: cells[0].special, bt: cells[0].bombTimer };
    cells[0].colorIndex = cells[1].colorIndex; cells[0].special = cells[1].special; cells[0].bombTimer = cells[1].bombTimer;
    cells[1].colorIndex = cells[2].colorIndex; cells[1].special = cells[2].special; cells[1].bombTimer = cells[2].bombTimer;
    cells[2].colorIndex = s.ci; cells[2].special = s.sp; cells[2].bombTimer = s.bt;
  }
  function rotateCW6(cells) {
    const s = { ci: cells[5].colorIndex, sp: cells[5].special, bt: cells[5].bombTimer };
    for (let i = 5; i > 0; i--) {
      cells[i].colorIndex = cells[i-1].colorIndex; cells[i].special = cells[i-1].special; cells[i].bombTimer = cells[i-1].bombTimer;
    }
    cells[0].colorIndex = s.ci; cells[0].special = s.sp; cells[0].bombTimer = s.bt;
  }
  function rotateCCW6(cells) {
    const s = { ci: cells[0].colorIndex, sp: cells[0].special, bt: cells[0].bombTimer };
    for (let i = 0; i < 5; i++) {
      cells[i].colorIndex = cells[i+1].colorIndex; cells[i].special = cells[i+1].special; cells[i].bombTimer = cells[i+1].bombTimer;
    }
    cells[5].colorIndex = s.ci; cells[5].special = s.sp; cells[5].bombTimer = s.bt;
  }

  // Try a rotation, check for matches AND special formations, then undo.
  // try/finally guarantees undo runs even if a detection function throws,
  // so the live grid is never left in a partially-rotated state.
  function tryRotation(rotateFn, undoFn, cells) {
    rotateFn(cells);
    try {
      return (
        findMatchesForMode(grid, cols, rows).size > 0 ||
        detectStarflowers(grid).length > 0 ||
        detectBlackPearls(grid).length > 0 ||
        detectGrandPoobahs(grid).length > 0
      );
    } finally {
      undoFn(cells);
    }
  }

  function inBounds(n) {
    return n.col >= 0 && n.col < cols && n.row >= 0 && n.row < rows;
  }

  for (let c = 0; c < cols; c++) {
    if (!grid[c]) continue;
    for (let r = 0; r < rows; r++) {
      const cell = grid[c][r];
      if (!cell) continue;

      const nbrs = getNeighbors(c, r);

      // Starflower ring: try rotating the 6-neighbor ring
      if (cell.special === 'starflower') {
        if (nbrs.every(n => inBounds(n) && grid[n.col]?.[n.row])) {
          const cells = nbrs.map(n => grid[n.col][n.row]);
          if (tryRotation(rotateCW6, rotateCCW6, cells)) return true;
          if (tryRotation(rotateCCW6, rotateCW6, cells)) return true;
        }
      }

      // Black pearl Y-shape: try rotating the 3 alternating neighbors
      if (cell.special === 'blackpearl') {
        const yHexes = [nbrs[0], nbrs[2], nbrs[4]];
        if (yHexes.every(n => inBounds(n) && grid[n.col]?.[n.row])) {
          const cells = yHexes.map(n => grid[n.col][n.row]);
          if (tryRotation(rotateCW3, rotateCCW3, cells)) return true;
          if (tryRotation(rotateCCW3, rotateCW3, cells)) return true;
        }
      }

      // Normal 3-hex cluster — each triangle (center, b, d) is shared by 3 cells.
      // Only test when c is the canonical "lowest" cell in the cluster to avoid
      // testing each triangle 3× (once per vertex).
      for (let i = 0; i < 6; i++) {
        const b = nbrs[i];
        const d = nbrs[(i + 1) % 6];
        if (!inBounds(b) || !inBounds(d)) continue;
        if (!grid[b.col]?.[b.row] || !grid[d.col]?.[d.row]) continue;
        // Canonical check: only process this triangle when c is the top-left-most vertex
        if (b.col < c || (b.col === c && b.row < r)) continue;
        if (d.col < c || (d.col === c && d.row < r)) continue;

        const cells = [cell, grid[b.col][b.row], grid[d.col][d.row]];
        if (tryRotation(rotateCW3, rotateCCW3, cells)) return true;
        if (tryRotation(rotateCCW3, rotateCW3, cells)) return true;
      }
    }
  }
  return false;
}

function hidePuzzleModals() {
  ['modal-puzzle-select', 'modal-puzzle-result', 'modal-puzzle-failed'].forEach(id => {
    document.getElementById(id)?.classList.add('hidden');
  });
}

// ─── Modal button wiring ────────────────────────────────────────

export function initPuzzleModeUI(getGridFn, isProcessingFn = () => false) {
  // Init puzzle editor (pass grid capture + start callbacks)
  initPuzzleEditorUI();
  registerEditorCallbacks(getGridFn, startPuzzle);

  // Daily puzzle play button
  document.getElementById('btn-play-daily')?.addEventListener('click', () => {
    document.getElementById('modal-puzzle-select').classList.add('hidden');
    startPuzzle(getTodaysPuzzle());
  });

  // Open puzzle editor from selector
  document.getElementById('btn-open-puzzle-editor')?.addEventListener('click', () => {
    document.getElementById('modal-puzzle-select').classList.add('hidden');
    showPuzzleEditor();
  });

  // Restart puzzle (always-visible HUD button)
  document.getElementById('btn-puzzle-restart')?.addEventListener('click', () => {
    if (activePuzzle && !isProcessingFn()) startPuzzle(activePuzzle.id);
  });

  // Close puzzle selector
  document.getElementById('btn-close-puzzle-select')?.addEventListener('click', () => {
    document.getElementById('modal-puzzle-select').classList.add('hidden');
  });

  // Result modal: retry
  document.getElementById('btn-puzzle-retry')?.addEventListener('click', () => {
    document.getElementById('modal-puzzle-result').classList.add('hidden');
    if (activePuzzle) startPuzzle(activePuzzle.id);
  });

  // Result modal: next
  document.getElementById('btn-puzzle-next')?.addEventListener('click', (e) => {
    const nextId = e.currentTarget.dataset.nextId;
    if (nextId) {
      document.getElementById('modal-puzzle-result').classList.add('hidden');
      startPuzzle(nextId);
    }
  });

  // Result modal: back to menu
  document.getElementById('btn-puzzle-menu')?.addEventListener('click', () => {
    document.getElementById('modal-puzzle-result').classList.add('hidden');
    clearActivePuzzle();
    showPuzzleSelector();
  });

  // Failed modal: retry
  document.getElementById('btn-puzzle-failed-retry')?.addEventListener('click', () => {
    document.getElementById('modal-puzzle-failed').classList.add('hidden');
    if (activePuzzle) startPuzzle(activePuzzle.id);
  });

  // Failed modal: menu
  document.getElementById('btn-puzzle-failed-menu')?.addEventListener('click', () => {
    document.getElementById('modal-puzzle-failed').classList.add('hidden');
    clearActivePuzzle();
    showPuzzleSelector();
  });

  // Failed modal: dismiss (X button or click outside)
  const failedModal = document.getElementById('modal-puzzle-failed');
  const dismissFailed = () => {
    failedModal.classList.add('hidden');
    showPuzzleHUD(true);
  };
  document.getElementById('btn-puzzle-failed-dismiss')?.addEventListener('click', dismissFailed);
  failedModal?.addEventListener('click', (e) => {
    if (e.target === failedModal) dismissFailed();
  });
}
