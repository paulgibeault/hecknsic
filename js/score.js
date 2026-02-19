/**
 * score.js — Points tracking and chain multiplier.
 */

import { SCORE_BASE, CHAIN_MULTIPLIER_BASE } from './constants.js';

let score = 0;
let chainLevel = 0;   // 0 = first match in a cascade, 1 = second, etc.
let comboCount = 0;    // total matches in current cascade
let displayScore = 0;  // for smooth score counter animation

export function getScore()       { return score; }
export function getDisplayScore(){ return Math.round(displayScore); }
export function getChainLevel()  { return chainLevel; }
export function getComboCount()  { return comboCount; }

export function resetScore() {
  score = 0;
  displayScore = 0;
  chainLevel = 0;
  comboCount = 0;
}

export function restoreScore(saved) {
  score = saved.score ?? 0;
  displayScore = saved.displayScore ?? 0;
  chainLevel = saved.chainLevel ?? 0;
  comboCount = saved.comboCount ?? 0;
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
  chainLevel = 0;
  comboCount = 0;
}

/** Animate the display score toward the actual score. Call each frame. */
export function updateDisplayScore(dt) {
  if (displayScore < score) {
    displayScore = Math.min(score, displayScore + Math.max(1, (score - displayScore) * 0.1));
  }
}
