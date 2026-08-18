/**
 * main.js — Entry point: DOM lookup, listener wiring, Arcade lifecycle, boot
 * sequence, HUD rendering, and the frame loop that draws.
 *
 * The state machine it used to carry now lives in js/game-state.js, which has
 * no DOM in it and so can be exercised under `node --test`
 * (tests/game-state.test.js). What is left here is wiring: everything in this
 * file either touches the document, subscribes to the launcher SDK, or paints.
 * Game rules belong next door.
 */

import {
  initRenderer, resize, drawFrame,
  requestRedraw, clearDirty, getIsDirty, hasActiveRendererAnimations,
  setFontScale,
} from './renderer.js';
import {
  loadActiveMode, getActiveGameMode,
  getActiveGameModeId, setActiveGameMode, getAllGameModes
} from './modes.js';
import {
  initInput, getHoverCluster, triggerAction,
  setKeyBindings, clearPendingAction,
} from './input.js';
import { registerFrameLoop } from './frame.js';
import { openModal, closeModal, registerModalHost } from './modal.js';
import { shakeRefusal, prepopulateNameInputs } from './ui.js';

import { updateTweens, suspendTweenClock, hasActiveTweens } from './tween.js';
import {
  updateDisplayScore,
  getScore, getDisplayScore, getMaxCombo, isScoreAnimating
} from './score.js';
import {
  addHighScore, getHighScores,
  setPlayerName,
  loadSettings, saveSettings,
  recordModeScore, seedRecordsFromScores, recordGameEnd,
} from './storage.js';
import {
  wireUiClicks, playGameWin, playGameOver, playOverAchiever, stopBed,
} from './audio.js';
import {
  initPuzzleModeUI, showPuzzleSelector, registerPuzzleCallbacks,
  clearActivePuzzle,
} from './puzzle-mode.js';
import {
  registerGameStateHost,
  getGrid, getState, setState, getSelectedCluster,
  isGamePaused, setPaused,
  isProcessing, nothingLeftToDo, resumeFromPause, processInput,
  initBoardFromSave, loadPuzzleBoard,
  resetGame, resetBoardForNewMode, saveGame, postRotationCheck,
  handleGameOver,
} from './game-state.js';

// ─── Bootstrap ──────────────────────────────────────────────────

// The frame clock. It belongs to the loop below, which is why it stays here
// and game-state.js resets it through the host rather than owning it.
let lastTime = 0;

registerGameStateHost({
  closeModeDropdown: () => {
    if (!logoDropdown.classList.contains('hidden')) {
      logoDropdown.classList.add('hidden');
    }
  },
  resetFrameClock: () => { lastTime = 0; },
  onGameWin: () => {
    stopBed();
    playGameWin();
    prepopulateNameInputs();
    openModal('modal-gamewin');
  },

  // The end-of-run presentation. All of this used to run from inside
  // js/animations.js — the modal DOM, the lifetime stats and the audio — which
  // is what gave an animation module a document to write to (hecknsic#66).
  // game-state.js owns the transition and awaits the explosion; the pixels and
  // the persistence are main.js's, so they are here.
  //
  // Both hooks run BEFORE the explosion tween the caller then awaits, which is
  // the whole reason modal-gameover and modal-over-achiever are non-pausing in
  // js/modal.js: pausing here would park the loop that tween needs.
  onGameOver: (isSessionEnd) => {
    recordGameEnd(getMaxCombo());
    // A real game over is two events: the detonation, then the aftermath tolls
    // a beat behind it. A peaceful chill-session end is the tolls alone —
    // nothing exploded. The floor drops away under both.
    stopBed(1.5);
    playGameOver(isSessionEnd);

    // No modal for a peaceful chill session end; the board just clears.
    if (isSessionEnd) return;

    const heading = document.querySelector('#modal-gameover h2');
    if (heading) {
      heading.textContent = 'GAME OVER';
      heading.style.color = '#ff4444';
      heading.style.borderColor = '#ff4444';
    }
    const messageEl = document.querySelector('.gameover-message');
    if (messageEl) {
      messageEl.style.display = 'block';
      messageEl.textContent = '💣 A bomb exploded!';
    }
    document.getElementById('go-score').textContent = getScore().toLocaleString();
    document.getElementById('go-combo').textContent = `x${getMaxCombo()}`;
    prepopulateNameInputs();
    openModal('modal-gameover');
  },

  onOverAchiever: () => {
    stopBed(1.5);
    playOverAchiever();
    document.getElementById('go-oa-score').textContent = getScore().toLocaleString();
    document.getElementById('go-oa-combo').textContent = `x${getMaxCombo()}`;
    prepopulateNameInputs();
    openModal('modal-over-achiever');
  },
});

// Hand the pause flag to the modal seam. Every open/close in the game goes
// through js/modal.js from here on, so the pause/resume pairing is one
// function's problem rather than eleven call sites' — see the header there.
// resume() is resumeFromPause() itself, which wakes the loop via wakeFrameLoop()
// and therefore still through the gate registered below. The seam adds no
// second way to start the loop.
registerModalHost({
  pause: () => { setPaused(true); },
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
    getGrid,
    getState,
    runPostRotation: () => postRotationCheck(),
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
    setPaused(true);
    suspendTweenClock();
  });
  Arcade.onResume(() => {
    setPaused(false);
    lastTime = performance.now();
    gameFrameLoop.start();
  });

  // After the launcher imports a save, every persisted key the game reads at
  // boot has just changed. Re-bootstrap from a clean slate rather than trying
  // to surgically swap grid + score + active mode + settings mid-frame.
  Arcade.onStateReplaced(() => location.reload());
}

// ─── Puzzle mode setup ───────────────────────────────────────────
initPuzzleModeUI(getGrid, isProcessing);

registerPuzzleCallbacks(
  // onLoad: replace the board with the puzzle's fixed grid
  (puzzleGrid, cols, rows, puzzle) => loadPuzzleBoard(puzzleGrid, cols, rows),
  // onEnd: freeze input when puzzle ends
  (reason) => { setState('gameover'); }
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
  setState('idle');
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
  handleGameOver(true);
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
  if (getState() === 'selected' && !isGamePaused()) {
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

initBoardFromSave();

// The SDK owns the frame loop. Arcade.loop cancels on suspend and re-arms on
// resume, and start() is idempotent — it can never stack a second concurrent
// loop, which is what the restart path used to do.
const gameFrameLoop = Arcade.loop(gameLoop);
// Hand the loop to the wake seam so renderer.requestRedraw() and tween() can
// restart it after it parks. The gate keeps a stray redraw from reviving the
// loop behind an open modal — that is a deliberate park, not an idle one.
registerFrameLoop(gameFrameLoop, () => !isGamePaused());
gameFrameLoop.start();

// ─── Game loop ──────────────────────────────────────────────────

// GAME_INTEGRATION §6d — a visible-but-idle game must let the display pipeline
// reach 0 fps, which means the loop has to stop, not just skip its draw. The
// "is there any reason for another frame?" predicate is nothingLeftToDo(), and
// it lives in js/game-state.js because it reads the machine's state; the two
// halves of the arrangement — parking, and waking through js/frame.js — are
// here, because the loop handle is here.

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
  if (isGamePaused()) { parkFrameLoop(); return; }

  const dt = lastTime ? timestamp - lastTime : 16;
  lastTime = timestamp;

  updateTweens(timestamp);
  updateDisplayScore(dt);

  // Game over: just render, no input
  if (getState() === 'gameover') {
    // Drain rather than ignore. This branch returns before the consume block,
    // so a stray keypress behind the game-over modal would sit in the queue
    // forever — and a queued gesture is one of the reasons the loop refuses to
    // park, which would leave the longest idle screen in the game running at
    // full frame rate. It could never be acted on here anyway.
    clearPendingAction();

    const needsDraw = getIsDirty() || hasActiveTweens() || hasActiveRendererAnimations() || isScoreAnimating();
    if (needsDraw) {
      drawFrame(getGrid(), null, null);
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

  // Consume the queued gesture and apply it to the machine. The rules live in
  // js/game-state.js; the loop only decides *when* to ask.
  processInput();

  // Draw
  const needsDraw = getIsDirty() || hasActiveTweens() || hasActiveRendererAnimations() || isScoreAnimating();
  if (needsDraw) {
    const st = getState();
    const hover = (st === 'idle') ? getHoverCluster() : null;
    drawFrame(getGrid(), hover, (st === 'selected' ? getSelectedCluster() : null));
    clearDirty();
  }

  updateControlsVisibility();
  updateGameHUD();

  // Settled board, no pending gesture, nothing animating: 0 fps until the
  // player does something. requestRedraw() / tween() bring us back.
  if (nothingLeftToDo()) parkFrameLoop();
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

// ─── Game Over overlay ──────────────────────────────────────────

// ─── Game Over overlay ──────────────────────────────────────────

// drawGameOver removed; handled by DOM overlay.
