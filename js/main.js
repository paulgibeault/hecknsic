/**
 * main.js — Entry point: canvas setup, game loop, state machine.
 *
 * States:
 *   'idle'       – waiting for player to select a cluster
 *   'selected'   – cluster selected, waiting for rotation or confirm
 *   'rotating'   – pop-thunk rotation animation in progress
 *   'cascading'  – match → flash → remove → gravity → refill → recheck
 */

import {
  GRID_COLS, GRID_ROWS, BOMB_INITIAL_TIMER,
} from './constants.js';
import { createGrid, findMatchesForMode } from './board.js';
import {
  initRenderer, resize, drawFrame, getOrigin,
  setCellOverride, clearCellOverride, clearAllOverrides,
  requestRedraw, clearDirty, getIsDirty, hasActiveRendererAnimations,
  setActiveGridSize, setFontScale,
} from './renderer.js';
import {
  loadActiveMode, getActiveGameMode,
  getActiveGameModeId, getCombinedModeId,
  setActiveGameMode, getAllGameModes
} from './modes.js';
import { hexToPixel, getNeighbors, pixelToHex, findClusterAtPixel } from './hex-math.js';
import {
  initInput, getHoverCluster, consumeAction, getLastClickPos, triggerAction,
  setKeyBindings, clearPendingAction, setClusterCenterPx, hasPendingAction,
} from './input.js';
import { registerFrameLoop, wakeFrameLoop } from './frame.js';
import { openModal, closeModal, registerModalHost } from './modal.js';
import { shakeRefusal, prepopulateNameInputs } from './ui.js';

import {
  animateClusterRotation, animateRingRotation, animateYRotation,
  animateBlackPearlCreation, animateGrandPoobahCreation, animateStarflowerCreation,
  handleOverAchiever, handleGameOver, runCascade, delay
} from './animations.js';
import { tween, updateTweens, suspendTweenClock, hasActiveTweens, linear } from './tween.js';
import {
  resetScore, advanceChain, resetChain,
  updateDisplayScore, restoreScore,
  getScore, getDisplayScore, getChainLevel, getComboCount, getMaxCombo, isScoreAnimating
} from './score.js';
import {
  detectStarflowers, detectBlackPearls, detectGrandPoobahs,
  detectGrandPoobahRing, tickBombs,
} from './specials.js';
import {
  saveGameState, loadGameState, clearGameState,
  addHighScore, getHighScores,
  setPlayerName,
  loadSettings, saveSettings,
  recordModeScore, seedRecordsFromScores,
} from './storage.js';
import {
  wireUiClicks,
  playRotate, playSelect, playMatch, playCombo, playSpecial,
  playBombArrive, playBombTick, playGameWin,
  startBed, stopBed, setBedUrgency,
} from './audio.js';
import {
  initPuzzleModeUI, showPuzzleSelector, registerPuzzleCallbacks,
  clearActivePuzzle, getActivePuzzle, onPuzzleMove,
} from './puzzle-mode.js';


// ─── Animation Context ───
export const getAnimationContext = () => ({
  get grid() { return grid; },
  set grid(g) { grid = g; },
  get activeCols() { return activeCols; },
  get activeRows() { return activeRows; },
  get state() { return state; },
  setState(s) { state = s; },
  get boardGeneration() { return boardGeneration; },
  get selectedCluster() { return selectedCluster; },
  get flowerCenter() { return flowerCenter; },
  get pearlCenter() { return pearlCenter; },
  get moveCount() { return moveCount; },
  get bombQueued() { return bombQueued; },
  setBombQueued(q) { bombQueued = q; },
  resetGame: () => resetGame(),
  handleGameWin: () => handleGameWin(),
  getCombinedModeId,
  clearGameState,
});
// ─── Game state ─────────────────────────────────────────────────
let grid;
let activeCols = GRID_COLS;  // may shrink for puzzle grids
let activeRows = GRID_ROWS;
let state = 'idle';  // 'idle' | 'selected' | 'rotating' | 'cascading' | 'gameover'
let isPaused = false;
let selectedCluster = null;
let flowerCenter = null;     // {col,row} if a starflower ring is selected
let pearlCenter = null;      // {col,row} if a black pearl Y-shape is selected
let lastTime = 0;
let moveCount = 0;           // total player moves (for bomb spawn timing)
let bombQueued = false;
let boardGeneration = 0;  // incremented on grid replacement; stale async chains bail out

// ─── Bootstrap ──────────────────────────────────────────────────

/** True while the board is mid-animation (rotating, cascading). UI should not restart. */
function isProcessing() {
  return state === 'rotating' || state === 'cascading';
}

/**
 * Come back from a modal. Every close goes through here — no longer because
 * eleven handlers each remember to call it, but because closeModal() in
 * js/modal.js is the only thing that closes a modal and this is its resume().
 *
 * Clearing isPaused is not enough on its own: a paused frame parks the loop,
 * and a parked loop does not restart just because a flag flipped. That was
 * already true before §6d — closing help or high-scores left the board frozen
 * until the next resize or suspend/resume — and the more the loop parks, the
 * more that bites. Resetting lastTime keeps the score counter from seeing the
 * whole time the modal was open as one delta.
 */
function resumeFromPause() {
  isPaused = false;
  lastTime = 0;
  wakeFrameLoop();
}

// Hand the pause flag to the modal seam. Every open/close in the game goes
// through js/modal.js from here on, so the pause/resume pairing is one
// function's problem rather than eleven call sites' — see the header there.
// resume() is resumeFromPause() itself, which wakes the loop via wakeFrameLoop()
// and therefore still through the gate registered below. The seam adds no
// second way to start the loop.
registerModalHost({
  pause: () => { isPaused = true; },
  resume: resumeFromPause,
});

// Developer hook, opt-in only: load the game with `?debug` or `#debug`.
//
// It was unconditional, which put a live handle on the state machine —
// including runPostRotation(), which drives the cascade — on every player's
// page, and left `window.debug` claimed against anything else that wants the
// name. Nothing in the game or the suite reads it, so a gate costs nothing;
// the URL is the gate because it is the one knob available from inside the
// launcher's iframe.
if (/(^|[?&#])debug\b/.test(window.location.search + window.location.hash)) {
  window.debug = {
    getGrid: () => grid,
    getState: () => state,
    runPostRotation: () => postRotationCheck(boardGeneration),
  };
}

const canvas = document.getElementById('game');
initRenderer(canvas);
initInput(canvas);

// Pause the game loop while the launcher hides the iframe — the existing
// isPaused flag already short-circuits gameLoop. Reset lastTime on resume so
// dt doesn't jump after a long suspension.
if (typeof window !== 'undefined' && window.Arcade) {
  Arcade.onSuspend(() => {
    // Arcade.loop parks itself on suspend; this only records intent. The loop
    // may be cancelled before gameLoop runs again, so parkFrameLoop() is not
    // guaranteed to fire — stop the tween clock here too.
    isPaused = true;
    suspendTweenClock();
  });
  Arcade.onResume(() => {
    isPaused = false;
    lastTime = performance.now();
    gameFrameLoop.start();
  });

  // After the launcher imports a save, every persisted key the game reads at
  // boot has just changed. Re-bootstrap from a clean slate rather than trying
  // to surgically swap grid + score + active mode + settings mid-frame.
  Arcade.onStateReplaced(() => location.reload());
}

// ─── Puzzle mode setup ───────────────────────────────────────────
initPuzzleModeUI(() => grid, isProcessing);

registerPuzzleCallbacks(
  // onLoad: replace the board with the puzzle's fixed grid
  (puzzleGrid, cols, rows, puzzle) => {
    boardGeneration++;
    setActiveGameMode('puzzle');
    clearAllOverrides();
    bombQueued = false;
    selectedCluster = flowerCenter = pearlCenter = null;
    moveCount = 0;
    resetScore();
    grid = puzzleGrid;
    activeCols = cols;
    activeRows = rows;
    setActiveGridSize(cols, rows);
    state = 'idle';
    requestRedraw();
  },
  // onEnd: freeze input when puzzle ends
  (reason) => {
    state = 'gameover';
  }
);

// Apply settings
const settings = loadSettings();
setKeyBindings(settings.keyBindings);

// UI bindings
const controlsEl = document.getElementById('controls');
document.getElementById('btn-ccw').addEventListener('click', (e) => {
  e.stopPropagation(); // prevent canvas click
  triggerAction('rotateCW');
});
document.getElementById('btn-cw').addEventListener('click', (e) => {
  e.stopPropagation();
  triggerAction('rotateCCW');
});

// Handedness — keeps buttons in the comfortable corner for each player.
// Single source of truth is arcade.v1.global.handedness; the in-game pill
// writes to it (standalone), and the launcher's settings UI writes to it
// (framed). Either way the SDK fires onSettingsChange and we re-apply.
const toggleLeft  = document.getElementById('hand-toggle-left');
const toggleRight = document.getElementById('hand-toggle-right');

function applyHandedness(handedness) {
  const leftHanded = handedness === 'left';
  controlsEl.classList.toggle('left-handed', leftHanded);
  toggleLeft.classList.toggle('hidden', leftHanded);
  toggleRight.classList.toggle('hidden', !leftHanded);
}

// Hide the in-game pills when framed — the launcher provides handedness UI.
// Arcade.context.framed only flips true after the welcome handshake.
Arcade.ready.then(() => {
  if (Arcade.context.framed) {
    toggleLeft.style.display = 'none';
    toggleRight.style.display = 'none';
  }
});

applyHandedness(Arcade.settings.handedness());
Arcade.onSettingsChange(() => applyHandedness(Arcade.settings.handedness()));

toggleLeft.addEventListener('click',  (e) => { e.stopPropagation(); Arcade.global.set('handedness', 'left'); });
toggleRight.addEventListener('click', (e) => { e.stopPropagation(); Arcade.global.set('handedness', 'right'); });

// Reduced motion — short-circuit CSS animations/transitions globally. Canvas
// tweens read Arcade.settings.reducedMotion() themselves (js/tween.js).
function applyReducedMotion() {
  document.body.classList.toggle('reduced-motion', Arcade.settings.reducedMotion());
}
applyReducedMotion();
Arcade.onSettingsChange(applyReducedMotion);

// Canvas text (score popups, bomb timers, combo labels) doesn't scale with the
// CSS --font-scale variable — cache it here and redraw on change.
function applyFontScale() {
  setFontScale(Arcade.settings.fontScale());
  requestRedraw();
}
applyFontScale();
Arcade.onSettingsChange(applyFontScale);


// Help Modal bindings
const nonGameUI = ['btn-help', 'modal-help', 'btn-close-help'];
document.getElementById('btn-help').addEventListener('click', (e) => {
  e.stopPropagation();
  openModal('modal-help');
});
document.getElementById('btn-close-help').addEventListener('click', (e) => {
  e.stopPropagation();
  closeModal('modal-help');
});

// Scores Modal bindings
document.getElementById('btn-scores').addEventListener('click', (e) => {
  e.stopPropagation();
  showHighScores();
  openModal('modal-scores');
});
document.getElementById('btn-close-scores').addEventListener('click', (e) => {
  e.stopPropagation();
  closeModal('modal-scores');
});

// Shared guard: shake a button and bail if board is mid-animation.
// Prevents restart clicks during cascade/rotation feeling like they're ignored.
// The shake itself lives in js/ui.js — puzzle-mode.js refuses the same
// way and the gesture is fiddly enough to be worth having exactly one of.
function guardedAction(btn, action) {
  if (isProcessing()) {
    shakeRefusal(btn);
    return;
  }
  action();
}

// Game Over Modal bindings
document.getElementById('btn-newgame').addEventListener('click', (e) => {
  e.stopPropagation();
  commitScoreFromInput('go-name');
  guardedAction(e.currentTarget, resetGame);
});

// Dropdown Mode Selector bindings
const logoDropdown = document.getElementById('logo-dropdown');

function toggleModeDropdown() {
  if (logoDropdown.classList.contains('hidden')) {
    logoDropdown.classList.remove('hidden');
    // Sync UI state
    document.querySelectorAll('[data-mode]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === getActiveGameModeId());
    });
    // match mode selector removed (classic-only)
  } else {
    logoDropdown.classList.add('hidden');
  }
  requestRedraw();
}

// Game HUD logo opens the mode dropdown
document.getElementById('game-hud-logo')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleModeDropdown();
});

document.querySelectorAll('[data-mode]').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Same refusal as the restart buttons: a mode switch mid-animation would
    // replace the board out from under the rotation still running on it.
    guardedAction(e.currentTarget, () => switchGameMode(btn.dataset.mode));
  });
});

// Settings Modal bindings
document.getElementById('dropdown-btn-settings').addEventListener('click', (e) => {
  e.stopPropagation();
  logoDropdown.classList.add('hidden'); // Close the menu (not a modal root)
  openModal('modal-settings');
});
document.getElementById('btn-close-settings').addEventListener('click', (e) => {
  e.stopPropagation();
  saveSettings(settings); // Persist updated bindings
  closeModal('modal-settings');
  requestRedraw();
});

// Setup keybind inputs
function bindKeyInput(id, keyName) {
  const el = document.getElementById(id);
  el.value = settings.keyBindings[keyName] || '';
  el.addEventListener('keydown', (e) => {
    e.preventDefault();
    if (e.key === 'Escape') {
      e.target.blur();
      return;
    }
    const key = e.key.toLowerCase();
    if (key.length === 1 || key.startsWith('arrow')) {
      settings.keyBindings[keyName] = key;
      el.value = key;
      setKeyBindings(settings.keyBindings);
    }
  });
}
bindKeyInput('bind-ccw', 'rotateCW');
bindKeyInput('bind-cw', 'rotateCCW');

// ─── End Session Modal ──────────────────────────────────────────

const endSessionModal = document.getElementById('modal-end-session');

document.getElementById('dropdown-btn-end-session').addEventListener('click', (e) => {
  e.stopPropagation();
  logoDropdown.classList.add('hidden');

  // Re-trigger CSS animation
  const content = endSessionModal.querySelector('.modal-content');
  content.classList.remove('shake-animation');
  void content.offsetWidth; // trigger reflow
  content.classList.add('shake-animation');

  prepopulateNameInputs();
  openModal('modal-end-session');
});

document.getElementById('btn-cancel-end').addEventListener('click', (e) => {
  e.stopPropagation();
  closeModal('modal-end-session');
  requestRedraw();
  // allow board interactions again
});

// Game Win Modal bindings — game-win does not record a leaderboard score,
// just save the sticky player name.
document.getElementById('btn-continue-gamewin').addEventListener('click', (e) => {
  e.stopPropagation();
  setNameFromInput('gw-name');
  state = 'idle';
  closeModal('modal-gamewin');
  requestRedraw();
});

document.getElementById('btn-newgame-gamewin').addEventListener('click', (e) => {
  e.stopPropagation();
  setNameFromInput('gw-name');
  guardedAction(e.currentTarget, () => {
    closeModal('modal-gamewin');
    resetGame();
  });
});

// Over-Achiever Modal binding
document.getElementById('btn-newgame-oa').addEventListener('click', (e) => {
  e.stopPropagation();
  commitScoreFromInput('oa-name', 'over-achiever');
  guardedAction(e.currentTarget, () => {
    closeModal('modal-over-achiever');
    resetGame();
  });
});

document.getElementById('btn-confirm-end').addEventListener('click', (e) => {
  e.stopPropagation();
  // Commit the chill-session score before the explosion sequence resets state.
  commitScoreFromInput('es-name');
  // closeModal() resumes: the explosion tween below only ticks on a running
  // loop, so the close must never leave the game parked.
  closeModal('modal-end-session');
  requestRedraw();

  // End session logic: trigger explosion sequence
  handleGameOver(getAnimationContext(), true);
});

function showHighScores() {
  const list = document.getElementById('high-scores-list');
  const scores = getHighScores(getActiveGameModeId());
  const modeLabelEl = document.getElementById('hs-mode-label');
  if (modeLabelEl) {
    modeLabelEl.textContent = `${getActiveGameMode().label}`;
  }
  
  list.innerHTML = '';

  if (scores.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No scores yet!';
    list.appendChild(li);
    return;
  }

  // Column headers
  const header = document.createElement('li');
  header.className = 'hs-header';
  header.innerHTML = '<span></span><span>Name</span><span>Score</span><span>Combo</span><span>Date</span>';
  list.appendChild(header);

  const topScore = scores[0].score;

  scores.forEach((s, i) => {
    const achievement = s.meta?.achievement;
    const maxCombo = s.meta?.maxCombo;
    const date = new Date(s.ts).toLocaleDateString();

    const li = document.createElement('li');
    if (achievement) li.classList.add('hs-achievement');
    if (i === 0) li.classList.add('hs-top');

    const rankSpan = document.createElement('span');
    rankSpan.className = 'rank';
    rankSpan.textContent = i === 0 ? '👑' : `#${i + 1}`;
    li.appendChild(rankSpan);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'name';
    nameSpan.textContent = s.name || '';
    li.appendChild(nameSpan);

    const scoreSpan = document.createElement('span');
    scoreSpan.className = 'score';
    scoreSpan.textContent = s.score.toLocaleString();
    if (achievement) {
      scoreSpan.textContent += ' 🏆';
    }
    li.appendChild(scoreSpan);

    const comboSpan = document.createElement('span');
    comboSpan.className = 'combo';
    comboSpan.textContent = maxCombo ? `x${maxCombo}` : '-';
    li.appendChild(comboSpan);

    const dateSpan = document.createElement('span');
    dateSpan.className = 'date';
    dateSpan.textContent = date;
    li.appendChild(dateSpan);

    list.appendChild(li);
  });
}

function updateControlsVisibility() {
  if (state === 'selected' && !isPaused) {
    controlsEl.classList.remove('hidden');
  } else {
    controlsEl.classList.add('hidden');
  }
}

// ─── Unified HTML HUD ──────────────────────────────────────────

const MODE_LABELS = { arcade: '💣 Arcade', chill: '✨ Chill', puzzle: '🧩 Puzzle' };

// updateGameHUD() runs on every rendered frame, so it used to do three
// getElementById lookups and three unconditional textContent/dataset writes per
// frame, for values that change a few times a second at most — and a write is a
// style invalidation whether or not the string actually differs.
//
// The three nodes are static in index.html and nothing ever replaces them, so
// they are resolved once and kept. Resolution is lazy only so that this block
// does not have to sit below the DOM-ready point; the first caller is
// syncHUDForMode() at bootstrap.
const hudEls = { resolved: false, hud: null, mode: null, score: null };
function hudElements() {
  if (!hudEls.resolved) {
    hudEls.resolved = true;
    hudEls.hud   = document.getElementById('game-hud');
    hudEls.mode  = document.getElementById('game-hud-mode');
    hudEls.score = document.getElementById('hud-score-value');
  }
  return hudEls;
}

// The score readout is the one node main.js writes exclusively, so the last
// value can be remembered — which also skips the toLocaleString() on an
// unchanged frame. The mode name and the layout attribute are NOT exclusive:
// puzzle-mode.js's showPuzzleHUD() writes both directly. Those are therefore
// compared against what the DOM actually holds rather than against a
// remembered value, because a remembered value would go stale the moment a
// puzzle started and the next real change would be skipped.
let hudLastScore = null;

/** Sync the HTML game-hud to the current mode and score. */
function updateGameHUD() {
  const mode = getActiveGameMode();
  const els = hudElements();
  if (!els.hud) return;

  // Skip score updates when puzzle mode owns the right-side group
  if (mode.isPuzzle) return;

  if (els.hud.dataset.mode !== mode.id) els.hud.dataset.mode = mode.id;

  const label = MODE_LABELS[mode.id] || mode.label;
  if (els.mode && els.mode.textContent !== label) els.mode.textContent = label;

  const score = getDisplayScore();
  if (els.score && score !== hudLastScore) {
    els.score.textContent = score.toLocaleString();
    hudLastScore = score;
  }
}

/** Called when switching modes to reconfigure the HUD layout. */
function syncHUDForMode(modeId) {
  const els = hudElements();
  const hud = els.hud;
  if (hud) hud.dataset.mode = modeId;

  const modeEl      = els.mode;
  const subtitleEl   = document.getElementById('game-hud-subtitle');
  const scoreGroup  = document.getElementById('hud-score-group');
  const puzzleGroup = document.getElementById('hud-puzzle-group');

  if (modeEl) modeEl.textContent = MODE_LABELS[modeId] || modeId;
  if (subtitleEl) subtitleEl.textContent = '';

  if (modeId === 'puzzle') {
    if (scoreGroup)  scoreGroup.style.display = 'none';
    if (puzzleGroup) puzzleGroup.style.display = '';
  } else {
    if (scoreGroup)  scoreGroup.style.display = '';
    if (puzzleGroup) puzzleGroup.style.display = 'none';
  }
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => resize(canvas), 150);
});

// Restore active mode then load per-mode saved state
loadActiveMode();

// One-shot: seed the per-mode best-score records from existing leaderboards so
// long-time players keep their history (idempotent). Then wire the soft
// ui-click cue onto menu/button interactions.
seedRecordsFromScores();
wireUiClicks();

// Puzzle mode is transient (board state isn't persisted), so it can't be
// meaningfully restored on reload.  Fall back to arcade.
if (getActiveGameModeId() === 'puzzle') {
  setActiveGameMode('arcade');
}

// ─── URL Configuration Parsing ──────────────────────────────────
const urlParams = new URLSearchParams(window.location.search);
let hasUrlConfig = false;

const urlGameMode = urlParams.get('game');
if (urlGameMode && getAllGameModes().some(m => m.id === urlGameMode)) {
  setActiveGameMode(urlGameMode);
  hasUrlConfig = true;
}

// line match mode URL param removed (classic-only)

// Strip URL params so refreshing doesn't lock the user into the linked config
if (hasUrlConfig) {
  const cleanUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
  window.history.replaceState({ path: cleanUrl }, '', cleanUrl);
}
const activeGameMode = getActiveGameMode();

if (activeGameMode.id === 'chill') {
  document.getElementById('dropdown-btn-end-session').classList.remove('hidden');
}

// Initialize the unified HTML HUD for the active mode
syncHUDForMode(activeGameMode.id);

const savedState = loadGameState(getCombinedModeId());
if (savedState) {
  grid = savedState.grid;
  restoreScore(savedState);
  moveCount = savedState.moveCount || 0;
  state = 'idle';
} else {
  resetScore();
  grid = createGrid();
  activeCols = GRID_COLS;
  activeRows = GRID_ROWS;
  setActiveGridSize(GRID_COLS, GRID_ROWS);
  state = 'idle';
}

// The SDK owns the frame loop. Arcade.loop cancels on suspend and re-arms on
// resume, and start() is idempotent — it can never stack a second concurrent
// loop, which is what the restart path used to do.
const gameFrameLoop = Arcade.loop(gameLoop);
// Hand the loop to the wake seam so renderer.requestRedraw() and tween() can
// restart it after it parks. The gate keeps a stray redraw from reviving the
// loop behind an open modal — that is a deliberate park, not an idle one.
registerFrameLoop(gameFrameLoop, () => !isPaused);
gameFrameLoop.start();

// ─── Game loop ──────────────────────────────────────────────────

/**
 * GAME_INTEGRATION §6d — is there any reason for another frame?
 *
 * Dirty-checking the *draw* was never enough: an rAF callback that decides not
 * to paint is still an rAF callback, so the main thread woke 60x a second on a
 * settled board and the display pipeline never reached 0 fps. This is the
 * condition that lets the loop stop entirely.
 *
 * isProcessing() ('rotating' / 'cascading') is in here as a deliberate blanket:
 * those states are driven by async chains that await sleeps between tweens, so
 * there are moments mid-cascade with nothing dirty and no tween live. Staying
 * awake through them is a handful of frames during motion the player asked
 * for, and it means no cascade can strand itself waiting on a parked loop.
 */
function nothingLeftToDo() {
  return !isProcessing()
    && !getIsDirty()
    && !hasActiveTweens()
    && !hasActiveRendererAnimations()
    && !isScoreAnimating()
    && !hasPendingAction();
}

/** Park until something wakes us. */
function parkFrameLoop() {
  gameFrameLoop.stop();
  // The next frame is a fresh start, however long from now that is — leaving
  // the old timestamp here would hand updateDisplayScore a dt of "however long
  // the player stared at the board".
  lastTime = 0;
  // Same reasoning one layer down. A park with tweens still in flight is the
  // damaging case (a modal opened mid-cascade); a park on a settled board has
  // nothing to compensate, and suspending an idle clock costs nothing.
  suspendTweenClock();
}

// Arcade.loop passes (deltaMs, timestamp); the local dt is kept because it
// carries this game's own 16 ms first-frame default.
function gameLoop(_deltaMs, timestamp) {
  // Paused means paused: park the loop rather than burning a frame slot each
  // tick to do nothing. onResume/restart start() it again.
  if (isPaused) { parkFrameLoop(); return; }

  const dt = lastTime ? timestamp - lastTime : 16;
  lastTime = timestamp;

  updateTweens(timestamp);
  updateDisplayScore(dt);

  // Game over: just render, no input
  if (state === 'gameover') {
    // Drain rather than ignore. This branch returns before the consume block,
    // so a stray keypress behind the game-over modal would sit in the queue
    // forever — and a queued gesture is one of the reasons the loop refuses to
    // park, which would leave the longest idle screen in the game running at
    // full frame rate. It could never be acted on here anyway.
    clearPendingAction();

    const needsDraw = getIsDirty() || hasActiveTweens() || hasActiveRendererAnimations() || isScoreAnimating();
    if (needsDraw) {
      drawFrame(grid, null, null);
      clearDirty();
    }
    // drawGameOver(); // Handled by DOM overlay now

    updateGameHUD();
    // Game over is the longest-lived idle screen there is — the modal sits
    // there while the player types a name. Once the score counter has caught
    // up, stop.
    if (nothingLeftToDo()) parkFrameLoop();
    return;
  }

  // Process input — only consume in states that can use it.
  //
  // A consumed action is a genuine user gesture, which is also what unlocks the
  // AudioContext under the browser's autoplay policy — so the ambient floor is
  // started from here rather than at load, where it would be blocked. Both
  // calls are idempotent and early-return once the bed is running.
  if (state === 'idle') {
    const action = consumeAction();
    if (action && action.type === 'select') {
      startBed(getActiveGameModeId());
      trySelect();
    }
  } else if (state === 'selected') {
    const action = consumeAction();
    if (action) {
      startBed(getActiveGameModeId());
      if (action.type === 'rotateCW' || action.type === 'rotateCCW') {
        animateRotation(action.type === 'rotateCW');
      } else if (action.type === 'select') {
        // Click: try to select something else, or deselect
        const prevCluster = selectedCluster;
        trySelect();
        if (selectedCluster === null) {
          // Nothing to select → deselect
          state = 'idle';
        } else if (clustersMatch(selectedCluster, prevCluster)) {
          // Clicked same thing → deselect
          selectedCluster = null;
          flowerCenter = null;
          pearlCenter = null;
          state = 'idle';
        }
        // else: selected something new, stay in 'selected'
      }
    }
  }
  // 'rotating' and 'cascading': input is NOT consumed (preserved for later)

  // Draw
  const needsDraw = getIsDirty() || hasActiveTweens() || hasActiveRendererAnimations() || isScoreAnimating();
  if (needsDraw) {
    const hover = (state === 'idle') ? getHoverCluster() : null;
    drawFrame(grid, hover, (state === 'selected' ? selectedCluster : null));
    clearDirty();
  }

  updateControlsVisibility();
  updateGameHUD();

  // Settled board, no pending gesture, nothing animating: 0 fps until the
  // player does something. requestRedraw() / tween() bring us back.
  if (nothingLeftToDo()) parkFrameLoop();
}

/**
 * Try to select whatever is under the cursor.
 * Prioritizes flower rings over normal 3-hex clusters.
 */
function trySelect() {
  const { originX, originY } = getOrigin();
  const clickPos = getLastClickPos();
  if (!clickPos) {
    selectedCluster = null;
    flowerCenter = null;
    pearlCenter = null;
    setClusterCenterPx(null, null);
    return;
  }

  // Close dropdown if clicking on canvas
  if (!logoDropdown.classList.contains('hidden')) {
    logoDropdown.classList.add('hidden');
  }

  const hex = pixelToHex(clickPos.x, clickPos.y, originX, originY);

  // Check if the clicked hex is a black pearl → Y-shape selection
  if (hex.col >= 0 && hex.col < activeCols &&
      hex.row >= 0 && hex.row < activeRows &&
      grid[hex.col]?.[hex.row]?.special === 'blackpearl') {
    // Select a Y-shape: pearl center + 3 alternating neighbors
    const nbrs = getNeighbors(hex.col, hex.row);
    const inBoundsNbrs = nbrs.filter(n =>
      n.col >= 0 && n.col < activeCols && n.row >= 0 && n.row < activeRows
    );
    if (inBoundsNbrs.length >= 3) {
      // Pick alternating neighbors (every other one) for Y-shape
      // Use even-indexed neighbors: 0, 2, 4 for one Y, 1, 3, 5 for inverted
      const yHexes = [nbrs[0], nbrs[2], nbrs[4]].filter(n =>
        n.col >= 0 && n.col < activeCols && n.row >= 0 && n.row < activeRows
      );
      if (yHexes.length === 3) {
        pearlCenter = { col: hex.col, row: hex.row };
        flowerCenter = null;
        selectedCluster = [{ col: hex.col, row: hex.row }, ...yHexes];
        state = 'selected';
        playSelect();
        // Pearl center is the center hex pixel
        const cp = hexToPixel(hex.col, hex.row, originX, originY);
        setClusterCenterPx(cp.x, cp.y);
        return;
      }
    }
  }

  // Check if the clicked hex is a starflower → ring selection
  if (hex.col >= 0 && hex.col < activeCols &&
      hex.row >= 0 && hex.row < activeRows &&
      grid[hex.col]?.[hex.row]?.special === 'starflower') {
    const nbrs = getNeighbors(hex.col, hex.row);
    const allInBounds = nbrs.every(n =>
      n.col >= 0 && n.col < activeCols && n.row >= 0 && n.row < activeRows
    );
    if (allInBounds) {
      flowerCenter = { col: hex.col, row: hex.row };
      pearlCenter = null;
      selectedCluster = [{ col: hex.col, row: hex.row }, ...nbrs];
      state = 'selected';
      playSelect();
      // Flower center pixel
      const cp = hexToPixel(hex.col, hex.row, originX, originY);
      setClusterCenterPx(cp.x, cp.y);
      return;
    }
  }

  // Normal 3-hex cluster selection
  const cluster = findClusterAtPixel(
    clickPos.x, clickPos.y,
    originX, originY,
    activeCols, activeRows
  );
  if (cluster) {
    flowerCenter = null;
    pearlCenter = null;
    selectedCluster = cluster;
    state = 'selected';
    playSelect();
    // Compute centroid of the 3 cluster hexes
    const px = cluster.map(h => hexToPixel(h.col, h.row, originX, originY));
    setClusterCenterPx(
      (px[0].x + px[1].x + px[2].x) / 3,
      (px[0].y + px[1].y + px[2].y) / 3
    );
  } else {
    selectedCluster = null;
    flowerCenter = null;
    pearlCenter = null;
    setClusterCenterPx(null, null);
  }
}

// ─── Mode selector ──────────────────────────────────────────────

async function switchGameMode(newModeId) {
  // Backstop for the click-site guard: resetBoardForNewMode() below swaps the
  // grid, and an in-flight rotation would land on the replacement.
  if (isProcessing()) return;

  // Puzzle mode: open selector instead of switching directly
  if (newModeId === 'puzzle') {
    logoDropdown.classList.add('hidden');
    showPuzzleSelector();
    return;
  }

  if (newModeId === getActiveGameModeId()) return;
  saveGame();
  clearActivePuzzle();
  setActiveGameMode(newModeId);
  if (newModeId === 'chill') {
    document.getElementById('dropdown-btn-end-session').classList.remove('hidden');
  } else {
    document.getElementById('dropdown-btn-end-session').classList.add('hidden');
  }

  // Update UI active states
  document.querySelectorAll('[data-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === newModeId);
  });

  syncHUDForMode(newModeId);
  resetBoardForNewMode();
}

// switchMatchMode removed — line variant deprecated, see tag feature/line-match-mode

function resetBoardForNewMode() {
  boardGeneration++;
  clearAllOverrides();
  bombQueued = false;
  selectedCluster = flowerCenter = pearlCenter = null;
  const combinedId = getCombinedModeId();
  const saved = loadGameState(combinedId);
  if (saved) {
    grid = saved.grid;
    restoreScore(saved);
    moveCount = saved.moveCount || 0;
  } else {
    resetScore();
    resetChain();
    grid = createGrid();
    moveCount = 0;
  }
  activeCols = GRID_COLS;
  activeRows = GRID_ROWS;
  setActiveGridSize(GRID_COLS, GRID_ROWS);
  state = 'idle';
  closeModal('modal-gameover');
  requestRedraw();
}

// ─── Rotation animation ────────────────────────────────────────

async function animateRotation(clockwise) {
  if (state !== 'selected') return;
  state = 'rotating';
  // One ratchet per player rotation press, not per internal step. The
  // mechanism's size follows what is actually turning: a starflower spins its
  // six-tile ring, a black pearl its Y, everything else the plain 3-cluster.
  playRotate(flowerCenter ? 'ring' : pearlCenter ? 'y' : 'cluster');
  const gen = boardGeneration;
  const ctx = getAnimationContext();

  const { originX, originY } = getOrigin();

  // Determine max steps based on selection type
  // Starflower ring = 6 steps for full rotation
  // Cluster / Black Pearl (Y) = 3 steps for full rotation
  let maxSteps = 3;
  if (flowerCenter || pearlCenter) maxSteps = 1;

  for (let step = 0; step < maxSteps; step++) {
    // 1. Animate one step
    if (flowerCenter) {
      await animateRingRotation(ctx, clockwise, originX, originY);
    } else if (pearlCenter) {
      await animateYRotation(ctx, clockwise, originX, originY);
    } else {
      await animateClusterRotation(ctx, clockwise, originX, originY);
    }
    if (boardGeneration !== gen) return; // board was replaced (e.g. restart)

    // 2. Check for matches or specials
    const matches = findMatchesForMode(grid, activeCols, activeRows);
    const sfResults = detectStarflowers(grid);
    const bpResults = detectBlackPearls(grid);
    const gpResults = detectGrandPoobahs(grid);

    // If we found anything significant, proceed to post-rotation logic (cascade/etc)
    // and STOP rotating.
    if (matches.size > 0 || sfResults.length > 0 || bpResults.length > 0 || gpResults.length > 0) {
      await postRotationCheck(gen);
      return;
    }
  }

  // If we loop through all steps without a match, we are back at the start.
  // Count as a move, tick bombs, etc.
  await postRotationCheck(gen);
}

function handleGameWin() {
  state = 'gameover';
  stopBed();
  playGameWin();
  prepopulateNameInputs();
  openModal('modal-gamewin');
}

/** How pressed the player is by bombs, 0..1, from the SHORTEST live fuse on the
 *  board — that is the one that ends the game. Arcade bombs spawn at
 *  BOMB_INITIAL_TIMER, so a fresh one sits near 0 and the last move before
 *  detonation is 1; a puzzle bomb placed on a shorter fuse simply starts
 *  further up the scale, which is the right reading. Returns 0 when the board
 *  is clear, which is what silences the tension bed entirely.
 *  @returns {number} */
function bombUrgency() {
  let min = Infinity;
  for (let c = 0; c < activeCols; c++) {
    for (let r = 0; r < activeRows; r++) {
      const cell = grid[c]?.[r];
      if (cell?.special === 'bomb' && typeof cell.bombTimer === 'number') {
        if (cell.bombTimer < min) min = cell.bombTimer;
      }
    }
  }
  if (min === Infinity) return 0;
  const u = 1 - (min - 1) / BOMB_INITIAL_TIMER;
  return Math.max(0, Math.min(1, u));
}

/** Shared post-rotation logic: tick bombs, cascade or detect specials.
 *  @param {number} gen — boardGeneration at call time; bail out if it changes.
 *                        Always pass explicitly — do not rely on a default capture. */
async function postRotationCheck(gen) {
  // Guard: callers must pass gen so stale async chains bail correctly.
  if (gen === undefined) gen = boardGeneration;
  moveCount++;
  const ctx = getAnimationContext();

  const mode = getActiveGameMode();

  // Tick bomb timers in any mode that has them (arcade + puzzle pre-placed bombs)
  // Only spawn new bombs in arcade (hasBombs). Puzzle uses pre-placed bombs only.
  if (mode.ticksBombs) {
    tickBombs(grid);

    // Animate bomb shake on tick
    const bombCells = [];
    for (let c = 0; c < activeCols; c++) {
      for (let r = 0; r < activeRows; r++) {
        if (grid[c][r]?.special === 'bomb') bombCells.push({ c, r });
      }
    }
    if (bombCells.length > 0) {
      // The fuse clock, with the shake. Urgency tracks the SHORTEST live fuse,
      // since that is the one about to end the game.
      playBombTick(bombUrgency());
      await tween(250, t => {
        const shakeX = Math.sin(t * Math.PI * 6) * 4 * (1 - t);
        for (const b of bombCells) {
          setCellOverride(b.c, b.r, { offsetX: shakeX });
        }
        requestRedraw();
      }, linear).promise;
      if (boardGeneration !== gen) return;
      for (const b of bombCells) clearCellOverride(b.c, b.r);
      requestRedraw();
    }

    // Spawn new bombs only in arcade mode
    if (mode.hasBombs) {
      const currentScore = getScore();
      let dynamicInterval = 15 - Math.floor(currentScore / 5000);
      if (dynamicInterval < 4) dynamicInterval = 4;
      if (moveCount % dynamicInterval === 0 && !bombQueued) {
        bombQueued = true;
        playBombArrive(); // a bomb is about to appear on the board
      }
    }
  }

  // Centralized Board State Resolution Logic
  let boardStable = false;
  let isFirstStep = true;

  while (!boardStable) {
    if (boardGeneration !== gen) return;
    boardStable = true;

    // Check for Grand Poobah Ring (Over-Achiever) before anything else
    const gpRing = detectGrandPoobahRing(grid);
    if (gpRing.length > 0) {
      await handleOverAchiever(ctx);
      return;
    }

    const gpResults = detectGrandPoobahs(grid);
    if (gpResults.length > 0) {
      if (!isFirstStep) { advanceChain(); await delay(100); }
      if (boardGeneration !== gen) return;
      isFirstStep = false;
      state = 'cascading';
      playSpecial('grandpoobah');
      await animateGrandPoobahCreation(ctx, gpResults);
      if (boardGeneration !== gen) return;
      boardStable = false;
      continue;
    }

    const bpResults = detectBlackPearls(grid);
    if (bpResults.length > 0) {
      if (!isFirstStep) { advanceChain(); await delay(100); }
      if (boardGeneration !== gen) return;
      isFirstStep = false;
      state = 'cascading';
      playSpecial('blackpearl');
      await animateBlackPearlCreation(ctx, bpResults);
      if (boardGeneration !== gen) return;
      boardStable = false;
      continue;
    }

    const sfResults = detectStarflowers(grid);
    if (sfResults.length > 0) {
      if (!isFirstStep) { advanceChain(); await delay(100); }
      if (boardGeneration !== gen) return;
      isFirstStep = false;
      state = 'cascading';
      playSpecial('starflower');
      await animateStarflowerCreation(ctx, sfResults);
      if (boardGeneration !== gen) return;
      boardStable = false;
      continue;
    }

    const matches = findMatchesForMode(grid, activeCols, activeRows);
    if (matches.size > 0) {
      const chained = !isFirstStep;
      if (chained) { advanceChain(); await delay(100); }
      if (boardGeneration !== gen) return;
      isFirstStep = false;
      state = 'cascading';
      // First clear = plain match, sized by how much glass broke; chained
      // cascade steps = combo, climbing the ladder with chain depth.
      if (chained) playCombo(getChainLevel());
      else playMatch(matches.size);
      await runCascade(ctx, matches, gen);
      if (boardGeneration !== gen) return;
      boardStable = false;
      continue;
    }
  }

  if (!isFirstStep) {
    // Only deselect if a cascade or special formation occurred
    selectedCluster = null;
    flowerCenter = null;
    pearlCenter = null;
    state = 'idle';
  } else {
    // Retain selection if nothing cleared
    state = 'selected';
  }

  resetChain();

  // The floor answers the board: the tension layer tracks the shortest live
  // fuse and goes silent when there are none. Quantised + hysteresis inside,
  // so calling it every move costs a retune only a handful of times a session.
  setBedUrgency(bombUrgency());

  // Puzzle move tracking
  const activePuzzle = getActivePuzzle();
  if (activePuzzle) {
    onPuzzleMove(grid, getScore(), getChainLevel());
    // Don't saveGame for puzzles — fixed board, no persistence needed
  } else {
    saveGame();
  }

  // Final check: did any un-cleared bombs expire?
  // ticksBombs covers both arcade (hasBombs) and puzzle (pre-placed bombs)
  if (mode.ticksBombs && mode.hasGameOver) {
    let exploded = false;
    for (let c = 0; c < activeCols; c++) {
      for (let r = 0; r < activeRows; r++) {
         if (grid[c]?.[r]?.special === 'bomb' && grid[c][r].bombTimer <= 0) {
             exploded = true;
             break;
         }
      }
    }
    if (exploded) {
       handleGameOver(ctx, false);
       return;
    }
  }
}

function resetGame() {
  boardGeneration++;
  resetScore();
  resetChain();
  grid = createGrid();
  activeCols = GRID_COLS;
  activeRows = GRID_ROWS;
  setActiveGridSize(GRID_COLS, GRID_ROWS);
  state = 'idle';
  moveCount = 0;
  bombQueued = false;
  selectedCluster = null;
  flowerCenter = null;
  pearlCenter = null;

  // A restart is a fresh room: drop the old floor and start one at the new
  // mode's intensity. startBed() is idempotent, so the stop matters more than
  // the start — without it a mode switch would leave the previous bed running.
  stopBed(0.4);
  startBed(getActiveGameModeId());

  // Ensure we are unpaused and running. closeModal() is the whole of it now:
  // it clears the pause and calls resumeFromPause(), which wakes the loop
  // through the gate. That used to be an open-coded `isPaused = false` plus a
  // direct gameFrameLoop.start() here — a second way to start the loop, which
  // is exactly what the gate exists to be the only one of.
  closeModal('modal-gameover');
}

function saveGame() {
  saveGameState(getCombinedModeId(), {
    grid,
    moveCount,
    score: getScore(),
    displayScore: getDisplayScore(),
    chainLevel: getChainLevel(),
    comboCount: getComboCount(),
    maxCombo: getMaxCombo(),
  });
}

// ─── Cascade logic ──────────────────────────────────────────────

async function startCascade() {
  state = 'cascading';

  const matches = findMatchesForMode(grid, activeCols, activeRows);
  if (matches.size === 0) {
    // No match — just deselect
    selectedCluster = null;
    state = 'idle';
    resetChain();
    return;
  }

  await runCascade(getAnimationContext(), matches);

  selectedCluster = null;
  state = 'idle';
  resetChain();
}

// ─── Helpers ────────────────────────────────────────────────────

/** Read the name from an input and persist it as the sticky player name. */
function setNameFromInput(inputId) {
  const el = document.getElementById(inputId);
  const name = el ? el.value.trim().slice(0, 20) : '';
  if (name) setPlayerName(name);
}

/** Save the player's name (if any) and add the current score to the leaderboard
 *  for the active game mode. Call once per game-over flow before resetGame. */
function commitScoreFromInput(inputId, achievement) {
  setNameFromInput(inputId);
  const modeId = getActiveGameModeId();
  addHighScore(modeId, getScore(), achievement, getMaxCombo());
  // Records: single best-ever score per mode, alongside the leaderboard (R4).
  recordModeScore(modeId, getScore());
}

function clustersMatch(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const setA = new Set(a.map(h => `${h.col},${h.row}`));
  return b.every(h => setA.has(`${h.col},${h.row}`));
}

// ─── Game Over overlay ──────────────────────────────────────────

// ─── Game Over overlay ──────────────────────────────────────────

// drawGameOver removed; handled by DOM overlay.
