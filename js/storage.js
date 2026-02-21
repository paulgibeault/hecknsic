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
    return raw ? JSON.parse(raw) : null;
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

// ─── High scores (per-mode) ─────────────────────────────────────

/**
 * Add a new score to the high score list for the given mode.
 * @param {string} modeId
 * @param {number} score
 */
export function addHighScore(modeId, score) {
  const scores = getHighScores(modeId);
  scores.push({ score, date: Date.now() });
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
