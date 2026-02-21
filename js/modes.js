/**
 * modes.js — Game mode definitions and active-mode state.
 */

const GAME_MODES = {
  arcade: { id: 'arcade', label: 'Arcade', hasBombs: true,  hasGameOver: true },
  chill:  { id: 'chill',  label: 'Chill',  hasBombs: false, hasGameOver: false },
};

const MATCH_MODES = {
  line: { id: 'line', label: 'Line', matchMode: 'line' },
  classic: { id: 'classic', label: 'Classic', matchMode: 'classic' },
};

let activeGameModeId = 'arcade';
let activeMatchModeId = 'line';

export function loadActiveMode() {
  const savedGame = localStorage.getItem('hecknsic_active_game_mode');
  const savedMatch = localStorage.getItem('hecknsic_active_match_mode');
  if (savedGame && GAME_MODES[savedGame]) activeGameModeId = savedGame;
  if (savedMatch && MATCH_MODES[savedMatch]) activeMatchModeId = savedMatch;
}

export function getActiveGameMode()   { return GAME_MODES[activeGameModeId] || GAME_MODES.arcade; }
export function getActiveMatchMode()  { return MATCH_MODES[activeMatchModeId] || MATCH_MODES.classic; }
export function getActiveGameModeId() { return activeGameModeId; }
export function getActiveMatchModeId() { return activeMatchModeId; }
// Used for high score storage keys:
export function getCombinedModeId() { return `${activeGameModeId}_${activeMatchModeId}`; }

export function getAllGameModes()      { return Object.values(GAME_MODES); }
export function getAllMatchModes()     { return Object.values(MATCH_MODES); }

export function setActiveGameMode(id) {
  activeGameModeId = id;
  localStorage.setItem('hecknsic_active_game_mode', id);
}

export function setActiveMatchMode(id) {
  activeMatchModeId = id;
  localStorage.setItem('hecknsic_active_match_mode', id);
}
