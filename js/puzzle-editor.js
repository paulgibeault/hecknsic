/**
 * puzzle-editor.js — In-game puzzle editor.
 *
 * Lets you:
 *   1. Capture the current live board state as a puzzle definition
 *   2. Set goal type, move limit, par
 *   3. Get a shareable code (base64-encoded JSON)
 *   4. Load a puzzle from a share code
 *
 * Share codes are URL-safe base64 of a compact JSON blob.
 * No server required.
 */

import { encodePuzzleBoard, decodePuzzleBoard, describeGoal } from './puzzles.js';
import { GRID_COLS, GRID_ROWS, PIECE_COLORS } from './constants.js';

// ─── Share code encode/decode ───────────────────────────────────

/**
 * Encode a puzzle definition to a URL-safe share code.
 */
export function encodePuzzleShareCode(puzzle) {
  const compact = {
    v: 1,
    id:  puzzle.id   ?? 'custom',
    n:   puzzle.name ?? 'Custom Puzzle',
    d:   puzzle.description ?? '',
    c:   puzzle.cols,
    r:   puzzle.rows,
    m:   puzzle.moveLimit,
    p:   puzzle.par,
    g:   puzzle.goal,
    b:   puzzle.board,
  };
  const json  = JSON.stringify(compact);
  // Use TextEncoder for full Unicode support (emoji, CJK safe)
  const bytes = new TextEncoder().encode(json);
  const b64   = btoa(String.fromCharCode(...bytes));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode a share code back to a puzzle definition.
 * Returns null on failure.
 */
export function decodePuzzleShareCode(code) {
  try {
    const padded = code.replace(/-/g, '+').replace(/_/g, '/');
    const pad    = padded.length % 4;
    const b64    = pad ? padded + '='.repeat(4 - pad) : padded;
    // Use TextDecoder for full Unicode support (emoji, CJK safe)
    const bytes  = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
    const json   = new TextDecoder().decode(bytes);
    const c      = JSON.parse(json);
    if (!c.v || !c.b || !c.g) return null;
    return {
      id:          c.id   ?? 'custom',
      name:        c.n    ?? 'Custom Puzzle',
      description: c.d    ?? '',
      cols:        c.c    ?? GRID_COLS,
      rows:        c.r    ?? GRID_ROWS,
      moveLimit:   c.m    ?? 20,
      par:         c.p    ?? 12,
      noRefill:    true,
      goal:        c.g,
      board:       c.b,
      isCustom:    true,
    };
  } catch (e) {
    return null;
  }
}

// ─── Editor UI ─────────────────────────────────────────────────

let _getGrid       = null;   // () => grid — injected by main.js
let _startPuzzleFn = null;   // (puzzle) => void — from puzzle-mode.js

export function registerEditorCallbacks(getGrid, startPuzzle) {
  _getGrid       = getGrid;
  _startPuzzleFn = startPuzzle;
}

export function initPuzzleEditorUI() {
  // Load from share code button
  document.getElementById('btn-load-share-code')?.addEventListener('click', () => {
    const input = document.getElementById('share-code-input');
    if (!input) return;
    const puzzle = decodePuzzleShareCode(input.value.trim());
    if (!puzzle) {
      showEditorStatus('❌ Invalid code', '#ff6060');
      return;
    }
    document.getElementById('modal-puzzle-editor').classList.add('hidden');
    if (_startPuzzleFn) _startPuzzleFn(puzzle);
  });

  // Capture board button
  document.getElementById('btn-capture-board')?.addEventListener('click', () => {
    if (!_getGrid) return;
    const grid = _getGrid();
    const board = encodePuzzleBoard(grid, GRID_COLS, GRID_ROWS);
    const ta = document.getElementById('editor-board-string');
    if (ta) ta.value = board;
    showEditorStatus('✅ Board captured', '#60d060');
  });

  // Generate share code button
  document.getElementById('btn-generate-code')?.addEventListener('click', () => {
    const board = document.getElementById('editor-board-string')?.value?.trim();
    if (!board) { showEditorStatus('❌ Capture a board first', '#ff6060'); return; }

    const name      = document.getElementById('editor-name')?.value || 'Custom Puzzle';
    const desc      = document.getElementById('editor-desc')?.value || '';
    const cols      = parseInt(document.getElementById('editor-cols')?.value) || GRID_COLS;
    const rows      = parseInt(document.getElementById('editor-rows')?.value) || GRID_ROWS;
    const moveLimit = parseInt(document.getElementById('editor-moves')?.value) || 20;
    const par       = parseInt(document.getElementById('editor-par')?.value) || 12;
    const goalType  = document.getElementById('editor-goal-type')?.value || 'clear_color';
    const goalParam = document.getElementById('editor-goal-param')?.value;

    const goal = buildGoalFromEditor(goalType, goalParam);

    const puzzle = { id: 'custom', name, description: desc, cols, rows, moveLimit, par, noRefill: true, goal, board };
    const code = encodePuzzleShareCode(puzzle);

    const codeBox = document.getElementById('share-code-output');
    if (codeBox) {
      codeBox.textContent = code;
      codeBox.onclick = () => {
        navigator.clipboard?.writeText(code).then(() => {
          showEditorStatus('📋 Copied!', '#b070f0');
        });
      };
    }
    showEditorStatus('✅ Code ready — tap to copy', '#60d060');
  });

  // Play from editor button
  document.getElementById('btn-play-from-editor')?.addEventListener('click', () => {
    const board     = document.getElementById('editor-board-string')?.value?.trim();
    if (!board) { showEditorStatus('❌ Capture a board first', '#ff6060'); return; }

    const name      = document.getElementById('editor-name')?.value || 'Custom Puzzle';
    const cols      = parseInt(document.getElementById('editor-cols')?.value) || GRID_COLS;
    const rows      = parseInt(document.getElementById('editor-rows')?.value) || GRID_ROWS;
    const moveLimit = parseInt(document.getElementById('editor-moves')?.value) || 20;
    const par       = parseInt(document.getElementById('editor-par')?.value) || 12;
    const goalType  = document.getElementById('editor-goal-type')?.value || 'clear_color';
    const goalParam = document.getElementById('editor-goal-param')?.value;
    const goal      = buildGoalFromEditor(goalType, goalParam);

    const puzzle = { id: 'custom', name, description: '', cols, rows, moveLimit, par, noRefill: true, goal, board };
    document.getElementById('modal-puzzle-editor').classList.add('hidden');
    if (_startPuzzleFn) _startPuzzleFn(puzzle);
  });

  // Goal type selector — show/hide param field
  document.getElementById('editor-goal-type')?.addEventListener('change', (e) => {
    updateGoalParamLabel(e.target.value);
  });

  // Close editor
  document.getElementById('btn-close-puzzle-editor')?.addEventListener('click', () => {
    document.getElementById('modal-puzzle-editor').classList.add('hidden');
  });
}

function buildGoalFromEditor(goalType, paramValue) {
  switch (goalType) {
    case 'clear_color':
      return { type: 'clear_color', colorIndex: parseInt(paramValue ?? '0') || 0 };
    case 'defuse_bomb':
      return { type: 'defuse_bomb' };
    case 'make_starflower':
      return { type: 'make_starflower', count: parseInt(paramValue ?? '1') || 1 };
    case 'score':
      return { type: 'score', target: parseInt(paramValue ?? '100') || 100 };
    case 'clear_all':
      return { type: 'clear_all' };
    default:
      return { type: 'clear_color', colorIndex: 0 };
  }
}

function updateGoalParamLabel(goalType) {
  const row   = document.getElementById('editor-goal-param-row');
  const label = document.getElementById('editor-goal-param-label');
  const input = document.getElementById('editor-goal-param');
  if (!row || !label || !input) return;

  switch (goalType) {
    case 'clear_color':
      row.style.display = 'flex';
      label.textContent = 'Color (0–4)';
      input.placeholder = '0=red 1=orange 2=blue 3=green 4=purple';
      input.value = '0';
      break;
    case 'make_starflower':
      row.style.display = 'flex';
      label.textContent = 'Count';
      input.placeholder = '1';
      input.value = '1';
      break;
    case 'score':
      row.style.display = 'flex';
      label.textContent = 'Target pts';
      input.placeholder = '200';
      input.value = '200';
      break;
    default:
      row.style.display = 'none';
  }
}

function showEditorStatus(msg, color = '#d0d0d8') {
  const el = document.getElementById('editor-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = color;
  el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; }, 2500);
}

export function showPuzzleEditor() {
  // Reset defaults
  const colsEl = document.getElementById('editor-cols');
  const rowsEl = document.getElementById('editor-rows');
  if (colsEl) colsEl.value = GRID_COLS;
  if (rowsEl) rowsEl.value = GRID_ROWS;
  updateGoalParamLabel(document.getElementById('editor-goal-type')?.value ?? 'clear_color');
  document.getElementById('modal-puzzle-editor').classList.remove('hidden');
}
