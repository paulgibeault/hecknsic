/**
 * storage.js — LocalStorage wrapper for persistence.
 *
 * Key scheme:
 *   hecknsic_activemode          – global, last used mode id
 *   hecknsic_state_{modeId}      – per-mode game state
 *   hecknsic_highscores_{modeId} – per-mode high scores
 *   hecknsic_settings            – global, unchanged
 */

const DEFAULT_SETTINGS = {
  theme: 'dark',
  soundVolume: 0.5,
  keyBindings: {
    rotateCW: 'q',
    rotateCCW: 'e',
  },
};

// ─── Game state (per-mode) ───────────────────────────────────────

/**
 * Save the current game state for the given mode.
 * @param {string} modeId
 * @param {Object} state
 */
export function saveGameState(modeId, state) {
  try {
    localStorage.setItem(`hecknsic_state_${modeId}`, JSON.stringify(state));
  } catch (e) {
    console.error('Failed to save game state:', e);
  }
}

/**
 * Load the saved game state for the given mode.
 * @param {string} modeId
 * @returns {Object|null}
 */
export function loadGameState(modeId) {
  try {
    const raw = localStorage.getItem(`hecknsic_state_${modeId}`);
    if (!raw) return null;
    const state = JSON.parse(raw);

    // Patch: fix bombs that have an invalid colorIndex (e.g. negative from a
    // displaced special piece).  Assign them a random valid color so they can
    // be matched.
    if (state && state.grid) {
      for (const col of state.grid) {
        if (!col) continue;
        for (const cell of col) {
          if (cell && cell.special === 'bomb' && (cell.colorIndex < 0 || cell.colorIndex >= 5)) {
            cell.colorIndex = Math.floor(Math.random() * 5);
          }
        }
      }
    }

    return state;
  } catch (e) {
    console.error('Failed to load game state:', e);
    return null;
  }
}

/**
 * Clear the saved game state for the given mode (e.g. on game over).
 * @param {string} modeId
 */
export function clearGameState(modeId) {
  localStorage.removeItem(`hecknsic_state_${modeId}`);
}

// ─── Settings (global) ──────────────────────────────────────────

/**
 * Save settings.
 * @param {Object} settings
 */
export function saveSettings(settings) {
  try {
    localStorage.setItem('hecknsic_settings', JSON.stringify(settings));
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

/**
 * Load settings, merging with defaults.
 */
export function loadSettings() {
  try {
    const raw = localStorage.getItem('hecknsic_settings');
    const userSettings = raw ? JSON.parse(raw) : {};
    return { ...DEFAULT_SETTINGS, ...userSettings };
  } catch (e) {
    console.error('Failed to load settings:', e);
    return DEFAULT_SETTINGS;
  }
}

// ─── Puzzle progress ────────────────────────────────────────────

/**
 * Get puzzle completion record for a given puzzle id.
 * @returns {{ stars: number, bestMoves: number|null, solved: bool } | null}
 */
export function getPuzzleProgress(puzzleId) {
  try {
    const raw = localStorage.getItem(`hecknsic_puzzle_${puzzleId}`);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

/**
 * Save puzzle completion. Keeps best stars and best move count.
 * @param {string} puzzleId
 * @param {{ stars: number, movesUsed: number }} result
 */
export function savePuzzleProgress(puzzleId, result) {
  const existing = getPuzzleProgress(puzzleId) ?? { stars: 0, bestMoves: null, solved: false };
  const updated = {
    stars:     Math.max(existing.stars, result.stars),
    bestMoves: existing.bestMoves === null ? result.movesUsed : Math.min(existing.bestMoves, result.movesUsed),
    solved:    true,
    lastPlayedAt: Date.now(),
  };
  try {
    localStorage.setItem(`hecknsic_puzzle_${puzzleId}`, JSON.stringify(updated));
  } catch (e) {
    console.error('Failed to save puzzle progress:', e);
  }
}

/**
 * Check if a sector is unlocked (first sector always unlocked; others require prior sector complete).
 * @param {string} sectorId
 * @param {import('./puzzles.js').PUZZLE_SECTORS} sectors
 */
export function isSectorUnlocked(sectorId, sectors) {
  const idx = sectors.findIndex(s => s.id === sectorId);
  if (idx === 0) return true; // first sector always open
  const prev = sectors[idx - 1];
  if (!prev) return false;
  return prev.puzzles.every(p => getPuzzleProgress(p.id)?.solved);
}

// ─── High scores (per-mode) ─────────────────────────────────────

/**
 * Add a new score to the high score list for the given mode.
 * @param {string} modeId
 * @param {number} score
 * @param {string} [achievement] - optional achievement id (e.g. 'over-achiever')
 */
export function addHighScore(modeId, score, achievement) {
  const scores = getHighScores(modeId);
  const entry = { score, date: Date.now() };
  if (achievement) entry.achievement = achievement;
  scores.push(entry);
  scores.sort((a, b) => b.score - a.score);
  const top10 = scores.slice(0, 10);
  try {
    localStorage.setItem(`hecknsic_highscores_${modeId}`, JSON.stringify(top10));
  } catch (e) {
    console.error('Failed to save high scores:', e);
  }
}

/**
 * Get the list of high scores for the given mode.
 * @param {string} modeId
 * @returns {Array<{score, date}>}
 */
export function getHighScores(modeId) {
  try {
    const raw = localStorage.getItem(`hecknsic_highscores_${modeId}`);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Failed to load high scores:', e);
    return [];
  }
}
