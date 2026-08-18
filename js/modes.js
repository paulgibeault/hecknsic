/**
 * modes.js — Game mode definitions and active-mode state.
 */

const GAME_MODES = {
  // hasBombs: spawns new bombs during play and ticks existing ones
  // ticksBombs: ticks existing bombs each move (puzzle mode uses pre-placed bombs, no spawning)
  arcade: { id: 'arcade', label: 'Arcade', hasBombs: true,  ticksBombs: true,  hasGameOver: true,  isPuzzle: false },
  chill:  { id: 'chill',  label: 'Chill',  hasBombs: false, ticksBombs: false, hasGameOver: false, isPuzzle: false },
  puzzle: { id: 'puzzle', label: 'Puzzle', hasBombs: false, ticksBombs: true,  hasGameOver: true,  isPuzzle: true  },
};

// Line match mode removed — preserved at git tag feature/line-match-mode
const MATCH_MODES = {
  classic: { id: 'classic', label: 'Classic', matchMode: 'classic' },
};

let activeGameModeId = 'arcade';
let activeMatchModeId = 'classic';

export function loadActiveMode() {
  const savedGame = Arcade.state.get('activeGameMode');
  const savedMatch = Arcade.state.get('activeMatchMode');
  if (savedGame && GAME_MODES[savedGame]) activeGameModeId = savedGame;
  if (savedMatch && MATCH_MODES[savedMatch]) activeMatchModeId = savedMatch;
}

export function getActiveGameMode()   { return GAME_MODES[activeGameModeId] || GAME_MODES.arcade; }
export function getActiveMatchMode()  { return MATCH_MODES[activeMatchModeId] || MATCH_MODES.classic; }
export function getActiveGameModeId() { return activeGameModeId; }

/**
 * Storage-key component, and FROZEN SCHEMA. Match mode collapsed to a single
 * 'classic' entry long ago, but the `_classic` suffix is baked into every
 * persisted key already on players' devices
 * (arcade.v1.hecknsic.gameState.arcade_classic, and the high-score keys).
 * The unused setter/list/id accessors around it were deleted; this string
 * must not change without a migration.
 */
export function getCombinedModeId() { return `${activeGameModeId}_${activeMatchModeId}`; }

export function getAllGameModes()      { return Object.values(GAME_MODES); }

export function setActiveGameMode(id) {
  activeGameModeId = id;
  Arcade.state.set('activeGameMode', id);
}
