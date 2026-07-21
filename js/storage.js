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

// ─── Lifetime stats (Arcade.stats, category 'lifetime') ─────────
// Read by the launcher's records surfaces; nothing in-game renders these yet.
// A "game" is an arcade/chill run that ended (bomb or session end); a puzzle
// or daily only counts when actually solved — there is no lose-credit.

export function recordGameEnd(maxCombo) {
  Arcade.stats.update('lifetime', (s) => ({
    ...s,
    gamesPlayed: (s.gamesPlayed || 0) + 1,
    bestCombo:   Math.max(s.bestCombo || 0, maxCombo || 0),
  }));
}

export function recordPuzzleSolved(isDaily) {
  Arcade.stats.update('lifetime', (s) => ({
    ...s,
    puzzlesSolved: (s.puzzlesSolved || 0) + 1,
    dailiesSolved: (s.dailiesSolved || 0) + (isDaily ? 1 : 0),
  }));
}

// ─── Records (Arcade.records) — per-mode single best score ──────
// One self-describing best-ever value per score-accumulating mode, rendered by
// the launcher's Records sheet with zero in-game code. These live ALONGSIDE the
// per-mode Arcade.scores leaderboards (R4) — the boards stay a ranked top-N with
// names; the record is the single "best ever" framing.
//
// Only arcade + chill accumulate a mode-wide score (finalised via
// commitScoreFromInput → addHighScore). Puzzle mode tracks bests per-puzzle
// (savePuzzleProgress), not one mode aggregate, so it gets no record category
// here — that would be a per-puzzle category explosion (capped at 50 by R4).
const RECORD_SCORE_MODES = { arcade: 'Arcade', chill: 'Chill' };

/**
 * Promote a finalised mode score to its single-best record. Idempotent (best()
 * never regresses; ties don't write). Feature-detected (R5) so a stale SDK is a
 * no-op. Category slug is permanent schema: `best_score_<mode>`.
 */
export function recordModeScore(modeId, score) {
  if (!(window.Arcade && Arcade.records)) return;
  const modeLabel = RECORD_SCORE_MODES[modeId];
  if (!modeLabel || !Number.isFinite(score)) return;
  Arcade.records.best(`best_score_${modeId}`, {
    value: score,
    direction: 'higher',
    format: 'integer',
    label: `Best score — ${modeLabel}`,
  });
}

/**
 * One-shot seed of the records categories from the existing per-mode
 * leaderboards, so long-time players don't lose their best. Idempotent via
 * best(); guarded so a records-less SDK leaves the migration unmarked and
 * retries after a later SDK upgrade.
 */
export function seedRecordsFromScores() {
  if (!(window.Arcade && Arcade.records)) return;
  Arcade.state.migrate('records-v1', () => {
    for (const modeId of Object.keys(RECORD_SCORE_MODES)) {
      const top = Arcade.scores.list(modeId, { limit: 1 })[0];
      if (top && Number.isFinite(top.score)) recordModeScore(modeId, top.score);
    }
  });
}

// ─── Player name (cross-game, lives at arcade.v1.global.playerName) ──

export function getPlayerName() {
  return Arcade.player.name();
}
export function setPlayerName(name) {
  Arcade.player.setName(name);
}
