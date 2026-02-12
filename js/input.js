/**
 * input.js — Mouse, touch, and keyboard input → game actions.
 */

import { GRID_COLS, GRID_ROWS } from './constants.js';
import { pixelToHex, findClusterAtPixel } from './hex-math.js';
import { getOrigin } from './renderer.js';

// ─── State ──────────────────────────────────────────────────────
let mouseX = 0, mouseY = 0;
let lastClickPos = null;     // {x, y} of last click for flower detection
let hoverCluster = null;
let pendingAction = null;  // { type: 'select'|'rotateCW'|'rotateCCW' }

export function getHoverCluster() { return hoverCluster; }
export function getLastClickPos() { return lastClickPos; }

/**
 * Consume and return the next pending action, or null.
 */
export function consumeAction() {
  const a = pendingAction;
  pendingAction = null;
  return a;
}

/**
 * Bind event listeners on the canvas.
 */
export function initInput(canvas) {
  canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    mouseX = e.clientX - rect.left;
    mouseY = e.clientY - rect.top;
    updateHover();
  });

  canvas.addEventListener('click', e => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    lastClickPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    pendingAction = { type: 'select' };
  });

  canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    pendingAction = { type: 'rotateCCW' };
  });

  // Touch
  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    const touch = e.touches[0];
    const rect = canvas.getBoundingClientRect();
    mouseX = touch.clientX - rect.left;
    mouseY = touch.clientY - rect.top;
    lastClickPos = { x: mouseX, y: mouseY };
    updateHover();
    pendingAction = { type: 'select' };
  }, { passive: false });

  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    const touch = e.touches[0];
    const rect = canvas.getBoundingClientRect();
    mouseX = touch.clientX - rect.left;
    mouseY = touch.clientY - rect.top;
    updateHover();
  }, { passive: false });

  // Keyboard
  window.addEventListener('keydown', e => {
    switch (e.key) {
      case 'q': case 'Q':
        pendingAction = { type: 'rotateCW' };
        break;
      case 'e': case 'E':
        pendingAction = { type: 'rotateCCW' };
        break;
      case ' ':
      case 'Enter':
        e.preventDefault();
        pendingAction = { type: 'select' };
        break;
    }
  });
}

function updateHover() {
  const { originX, originY } = getOrigin();
  hoverCluster = findClusterAtPixel(mouseX, mouseY, originX, originY, GRID_COLS, GRID_ROWS);
}
