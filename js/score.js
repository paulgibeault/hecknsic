/**
 * score.js — Points tracking and chain multiplier.
 */

import { SCORE_BASE, CHAIN_MULTIPLIER_BASE } from './constants.js';

let score = 0;
let chainLevel = 0;   // 0 = first match in a cascade, 1 = second, etc.
let comboCount = 0;    // total matches in current cascade
let maxCombo = 0;      // peak combo count across the entire game session
let displayScore = 0;  // for smooth score counter animation

export function getScore()       { return score; }
export function getDisplayScore(){ return Math.round(displayScore); }
export function getChainLevel()  { return chainLevel; }
export function getComboCount()  { return comboCount; }
export function getMaxCombo()    { return maxCombo; }
export function isScoreAnimating(){ return Math.round(displayScore) < score; }


export function resetScore() {
  score = 0;
  displayScore = 0;
  chainLevel = 0;
  comboCount = 0;
  maxCombo = 0;
}

export function restoreScore(saved) {
  score = saved.score ?? 0;
  displayScore = saved.displayScore ?? 0;
  chainLevel = saved.chainLevel ?? 0;
  comboCount = saved.comboCount ?? 0;
  maxCombo = saved.maxCombo ?? 0;
}

/**
 * Award points for a set of matched cells.
 * @param {number} matchSize — how many cells in this match group
 */
export function awardMatch(matchSize, bonusMultiplier = 1) {
  // Look up base or extrapolate for larger matches
  const base = SCORE_BASE[matchSize] ?? matchSize * 10;
  const multiplier = Math.pow(CHAIN_MULTIPLIER_BASE, chainLevel) * bonusMultiplier;
  const points = Math.round(base * multiplier);
  score += points;
  comboCount++;
  return points;
}

/** Call when a cascade step starts (after gravity). */
export function advanceChain() {
  chainLevel++;
}

/** Call when the cascade fully resolves (no more matches). */
export function resetChain() {
  if (comboCount > maxCombo) maxCombo = comboCount;
  chainLevel = 0;
  comboCount = 0;
}

// ─── The score counter's clock ──────────────────────────────────
//
// The counter closes a share of the remaining gap each step, with a floor so
// the last few points always land rather than converging forever. Both of
// those used to be expressed *per frame* — `gap * 0.1` and `max(…, 1)` — and
// `dt` was accepted and then ignored. So the counter's speed was whatever the
// display's was: it ran at half speed on a 30 Hz panel and at double on a
// 120 Hz one, and any frame the loop dropped was time the counter did not
// count.
//
// The shape is kept and re-expressed against wall-clock time, calibrated so
// that a 60 fps frame does exactly what it did before. One step of dt ms is
// dt/16.667 of the old frame-steps: the geometric decay compounds over that
// many frames, and the floor scales linearly with it.
//
// Substituting dt = 1000/60 gives frames = 1, hence gap * (1 - 0.9) = gap * 0.1
// and a floor of 1 — the old expression exactly, so the feel at 60 fps is
// unchanged rather than merely close.
const REFERENCE_FRAME_MS  = 1000 / 60;
const GAP_KEPT_PER_FRAME  = 0.9;  // 10% of the remaining gap closed per frame
const MIN_POINTS_PER_FRAME = 1;

/**
 * Animate the display score toward the actual score. Call each frame.
 * @param {number} dt — milliseconds since the previous frame.
 */
export function updateDisplayScore(dt) {
  if (displayScore >= score) return;

  // A non-finite or non-positive dt means no time passed that we can account
  // for — the first frame after a park hands us exactly that (main.js resets
  // lastTime to 0). Advancing on it would be inventing time.
  const frames = (Number.isFinite(dt) && dt > 0) ? dt / REFERENCE_FRAME_MS : 0;
  if (frames === 0) return;

  const gap   = score - displayScore;
  const eased = gap * (1 - Math.pow(GAP_KEPT_PER_FRAME, frames));
  const floor = MIN_POINTS_PER_FRAME * frames;
  displayScore = Math.min(score, displayScore + Math.max(floor, eased));
}
