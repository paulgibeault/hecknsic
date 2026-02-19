/**
 * storage.js — LocalStorage wrapper for persistence.
 */

const STORAGE_KEYS = {
  GAME_STATE: 'hecknsic_state',
  SETTINGS: 'hecknsic_settings',
  HIGH_SCORES: 'hecknsic_highscores',
};

const DEFAULT_SETTINGS = {
  theme: 'dark',
  soundVolume: 0.5,
  keyBindings: {
    rotateCW: 'q',
    rotateCCW: 'e',
  },
};

/**
 * Save the current game state.
 * @param {Object} state - The complete game state object.
 */
export function saveGameState(state) {
  try {
    localStorage.setItem(STORAGE_KEYS.GAME_STATE, JSON.stringify(state));
  } catch (e) {
    console.error('Failed to save game state:', e);
  }
}

/**
 * Load the saved game state.
 * @returns {Object|null} The saved state or null if none/error.
 */
export function loadGameState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.GAME_STATE);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.error('Failed to load game state:', e);
    return null;
  }
}

/**
 * Clear the saved game state (e.g. on game over).
 */
export function clearGameState() {
  localStorage.removeItem(STORAGE_KEYS.GAME_STATE);
}

/**
 * Save settings.
 * @param {Object} settings 
 */
export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

/**
 * Load settings, merging with defaults.
 */
export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    const userSettings = raw ? JSON.parse(raw) : {};
    return { ...DEFAULT_SETTINGS, ...userSettings };
  } catch (e) {
    console.error('Failed to load settings:', e);
    return DEFAULT_SETTINGS;
  }
}

/**
 * Add a new score to the high score list.
 * @param {number} score 
 */
export function addHighScore(score) {
  const scores = getHighScores();
  scores.push({ score, date:  Date.now() });
  // Sort desc
  scores.sort((a, b) => b.score - a.score);
  // Keep top 10
  const top10 = scores.slice(0, 10);
  
  try {
    localStorage.setItem(STORAGE_KEYS.HIGH_SCORES, JSON.stringify(top10));
  } catch (e) {
    console.error('Failed to save high scores:', e);
  }
}

/**
 * Get the list of high scores.
 * @returns {Array<{score, date}>}
 */
export function getHighScores() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.HIGH_SCORES);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Failed to load high scores:', e);
    return [];
  }
}
