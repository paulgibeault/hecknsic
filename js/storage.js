/**
 * storage.js — Persistence wrapper over Arcade.state.* (per-game),
 * Arcade.scores.* (leaderboards), and Arcade.player.* (sticky name).
 *
 * Namespaced keys (under arcade.v1.hecknsic.*):
 *   gameState.<combinedId>       – per-mode game state
 *   settings                     – key bindings, theme, etc.
 *   puzzle.<puzzleId>            – per-puzzle progress
 *   scores.<modeId>              – per-mode leaderboard (managed by SDK)
 */

const DEFAULT_SETTINGS = {
  keyBindings: {
    rotateCW: 'q',
    rotateCCW: 'e',
  },
};

// ─── Game state (per-mode) ───────────────────────────────────────

export function saveGameState(modeId, state) {
  Arcade.state.set(`gameState.${modeId}`, state);
}

export function loadGameState(modeId) {
  const state = Arcade.state.get(`gameState.${modeId}`);
  if (!state) return null;

  // Patch: fix bombs that have an invalid colorIndex (e.g. negative from a
  // displaced special piece). Assign them a random valid color so they can
  // be matched. Persisted on the next saveGame().
  if (state.grid) {
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
}

export function clearGameState(modeId) {
  Arcade.state.remove(`gameState.${modeId}`);
}

// ─── Settings (per-game) ────────────────────────────────────────

export function saveSettings(settings) {
  Arcade.state.set('settings', settings);
}

export function loadSettings() {
  return Arcade.state.getOrInit('settings', DEFAULT_SETTINGS);
}

// ─── Puzzle progress ────────────────────────────────────────────

export function getPuzzleProgress(puzzleId) {
  return Arcade.state.get(`puzzle.${puzzleId}`);
}

export function savePuzzleProgress(puzzleId, result) {
  const existing = getPuzzleProgress(puzzleId) ?? { stars: 0, bestMoves: null, bestScore: 0, solved: false };
  const updated = {
    stars:     Math.max(existing.stars, result.stars ?? 0),
    bestMoves: result.movesUsed != null
      ? (existing.bestMoves === null ? result.movesUsed : Math.min(existing.bestMoves, result.movesUsed))
      : existing.bestMoves,
    bestScore: Math.max(existing.bestScore ?? 0, result.score ?? 0),
    solved:    existing.solved || (result.stars != null && result.stars > 0),
    lastPlayedAt: Date.now(),
  };
  Arcade.state.set(`puzzle.${puzzleId}`, updated);
}

/**
 * Check if a sector is unlocked (first sector always unlocked; others require prior sector complete).
 * @param {string} sectorId
 * @param {Array<{id: string, puzzles: Array<{id: string}>}>} sectors — the full PUZZLE_SECTORS array
 */
export function isSectorUnlocked(sectorId, sectors) {
  const idx = sectors.findIndex(s => s.id === sectorId);
  if (idx === 0) return true; // first sector always open
  const prev = sectors[idx - 1];
  if (!prev) return false;
  return prev.puzzles.every(p => getPuzzleProgress(p.id)?.solved);
}

// ─── High scores (per game mode) ────────────────────────────────

/**
 * Add a score for the given game mode. The SDK auto-stamps the player name
 * from Arcade.player.name() and a timestamp. Achievement and combo are
 * tucked into meta so the entry shape stays stable.
 */
export function addHighScore(modeId, score, achievement, maxCombo) {
  const meta = {};
  if (achievement) meta.achievement = achievement;
  if (maxCombo != null) meta.maxCombo = maxCombo;
  const entry = { score };
  if (Object.keys(meta).length > 0) entry.meta = meta;
  Arcade.scores.add(modeId, entry);
}

/**
 * Top 10 scores for the given mode, descending. Entry shape:
 *   { score, ts, name?, meta?: { achievement?, maxCombo? } }
 */
export function getHighScores(modeId) {
  return Arcade.scores.list(modeId, { limit: 10 });
}

// ─── Player name (cross-game, lives at arcade.v1.global.playerName) ──

export function getPlayerName() {
  return Arcade.player.name();
}
export function setPlayerName(name) {
  Arcade.player.setName(name);
}
