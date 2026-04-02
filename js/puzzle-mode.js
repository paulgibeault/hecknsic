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

import {
  getPuzzleProgress,
  savePuzzleProgress,
  isSectorUnlocked,
} from './storage.js';

// ─── Active puzzle state ────────────────────────────────────────

let activePuzzle   = null;  // current puzzle definition
let movesUsed      = 0;
let maxChain       = 0;     // highest chain level seen this run
let stats          = { totalMoves: 0, starflowersMade: 0, score: 0 };
let goalMet        = false;
let _onPuzzleLoad  = null;  // callback(grid, cols, rows, puzzle) — set by main.js
let _onPuzzleEnd   = null;  // callback(reason) — 'complete' | 'failed'

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
 * Load and start a puzzle by id.
 * Called when the player clicks a puzzle in the selector.
 */
export function startPuzzle(puzzleId) {
  const puzzle = getPuzzleById(puzzleId);
  if (!puzzle) { console.error('Unknown puzzle:', puzzleId); return; }

  activePuzzle = puzzle;
  movesUsed    = 0;
  maxChain     = 0;
  goalMet      = false;
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

  if (result.met && !goalMet) {
    goalMet = true;
    const stars = computeStars(activePuzzle, movesUsed, maxChain);
    savePuzzleProgress(activePuzzle.id, { stars, movesUsed });
    setTimeout(() => showPuzzleResult(stars), 600);
    return;
  }

  // Out of moves?
  if (movesUsed >= activePuzzle.moveLimit && !goalMet) {
    setTimeout(() => showPuzzleFailed(), 600);
    return;
  }

  updatePuzzleHUD();
}

/**
 * Track starflowers created during puzzle (for make_starflower goal).
 */
export function onStarflowerCreated() {
  if (!activePuzzle) return;
  stats.starflowersMade = (stats.starflowersMade ?? 0) + 1;
}

/**
 * Reset active puzzle state (e.g. when leaving puzzle mode).
 */
export function clearActivePuzzle() {
  activePuzzle = null;
  showPuzzleHUD(false);
  hidePuzzleModals();
}

// ─── Puzzle selector modal ──────────────────────────────────────

export function showPuzzleSelector() {
  const container = document.getElementById('puzzle-sector-list');
  if (!container) return;

  container.innerHTML = '';

  for (const sector of PUZZLE_SECTORS) {
    const unlocked = isSectorUnlocked(sector.id, PUZZLE_SECTORS);

    const sectorEl = document.createElement('div');
    sectorEl.style.cssText = 'margin-bottom: 20px;';

    const header = document.createElement('div');
    header.style.cssText = `
      font-size: 0.75rem; font-weight: 700; letter-spacing: 2px;
      color: ${unlocked ? '#b070f0' : '#555'}; text-transform: uppercase;
      margin-bottom: 8px; padding-bottom: 4px;
      border-bottom: 1px solid ${unlocked ? '#4a2070' : '#333'};
    `;
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
        btn.style.cssText = `
          display: flex; align-items: center; justify-content: space-between;
          width: 100%; padding: 10px 12px; margin-bottom: 6px;
          background: #1e2130; border: 1px solid #333; border-radius: 6px;
          color: #d0d0d8; font-size: 0.85rem; cursor: pointer;
          transition: border-color 0.15s, background 0.15s;
          text-align: left;
        `;
        btn.onmouseover = () => { btn.style.borderColor = '#8040c0'; btn.style.background = '#252840'; };
        btn.onmouseout  = () => { btn.style.borderColor = '#333';    btn.style.background = '#1e2130'; };

        const info = document.createElement('div');
        const title = document.createElement('div');
        title.style.cssText = 'font-weight: 600; margin-bottom: 2px;';
        title.textContent = puzzle.name;
        const desc = document.createElement('div');
        desc.style.cssText = 'color: #707080; font-size: 0.75rem;';
        desc.textContent = `${puzzle.moveLimit} moves · par ${puzzle.par}`;
        info.appendChild(title);
        info.appendChild(desc);

        const starDisplay = document.createElement('div');
        starDisplay.style.cssText = 'font-size: 0.9rem; flex-shrink: 0; margin-left: 8px;';
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
  let hud = document.getElementById('puzzle-hud');
  if (!hud) return;
  hud.style.display = visible ? 'flex' : 'none';
}

function updatePuzzleHUD() {
  if (!activePuzzle) return;

  const movesLeftEl = document.getElementById('puzzle-moves-left');
  const goalEl      = document.getElementById('puzzle-goal-text');
  const parEl       = document.getElementById('puzzle-par-text');

  const movesLeft = activePuzzle.moveLimit - movesUsed;
  if (movesLeftEl) {
    movesLeftEl.textContent = movesLeft;
    movesLeftEl.style.color = movesLeft <= 3 ? '#ff6060'
                            : movesLeft <= 6 ? '#ffaa30'
                            : '#d0d0d8';
  }
  if (goalEl)  goalEl.textContent  = describeGoal(activePuzzle.goal);
  if (parEl)   parEl.textContent   = `par ${activePuzzle.par}`;
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
  statsEl.innerHTML = `
    <div class="score-row"><span>Moves used</span><span class="val">${movesUsed} / ${activePuzzle.moveLimit}</span></div>
    <div class="score-row"><span>Par</span><span class="val">${activePuzzle.par}</span></div>
    <div class="score-row"><span>Best chain</span><span class="val">${maxChain}</span></div>
  `;

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

function showPuzzleFailed() {
  showPuzzleHUD(false);

  const movesLeft = activePuzzle.moveLimit - movesUsed;
  document.getElementById('puzzle-failed-msg').textContent =
    `You used all ${activePuzzle.moveLimit} moves. ${describeGoal(activePuzzle.goal)} — so close!`;

  document.getElementById('modal-puzzle-failed').classList.remove('hidden');

  if (_onPuzzleEnd) _onPuzzleEnd('failed');
}

function hidePuzzleModals() {
  ['modal-puzzle-select', 'modal-puzzle-result', 'modal-puzzle-failed'].forEach(id => {
    document.getElementById(id)?.classList.add('hidden');
  });
}

// ─── Modal button wiring ────────────────────────────────────────

export function initPuzzleModeUI() {
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
}
