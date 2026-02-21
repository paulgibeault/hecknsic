/**
 * input.js — Mouse, touch, and keyboard input → game actions.
 */

import { GRID_COLS, GRID_ROWS } from './constants.js';
import { pixelToHex, findClusterAtPixel } from './hex-math.js';
import { getOrigin, getBoardScale } from './renderer.js';

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
 * Trigger an action programmatically (e.g. from UI buttons).
 */
export function triggerAction(type) {
  pendingAction = { type };
}

/**
 * Bind event listeners on the canvas.
 */
let keyBindings = {
  rotateCW: 'q',
  rotateCCW: 'e',
};

export function setKeyBindings(bindings) {
  if (bindings.rotateCW) keyBindings.rotateCW = bindings.rotateCW;
  if (bindings.rotateCCW) keyBindings.rotateCCW = bindings.rotateCCW;
}

export function initInput(canvas) {
  canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    const s = getBoardScale();
    mouseX = (e.clientX - rect.left) / s;
    mouseY = (e.clientY - rect.top) / s;
    updateHover();
  });

  canvas.addEventListener('click', e => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const s = getBoardScale();
    lastClickPos = { x: (e.clientX - rect.left) / s, y: (e.clientY - rect.top) / s };
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
    const s = getBoardScale();
    mouseX = (touch.clientX - rect.left) / s;
    mouseY = (touch.clientY - rect.top) / s;
    lastClickPos = { x: mouseX, y: mouseY };
    updateHover();
    pendingAction = { type: 'select' };
  }, { passive: false });

  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    const touch = e.touches[0];
    const rect = canvas.getBoundingClientRect();
    const s = getBoardScale();
    mouseX = (touch.clientX - rect.left) / s;
    mouseY = (touch.clientY - rect.top) / s;
    updateHover();
  }, { passive: false });

  // Keyboard
  window.addEventListener('keydown', e => {
    const key = e.key.toLowerCase();
    
    // Configurable keys
    if (key === keyBindings.rotateCW.toLowerCase()) {
      pendingAction = { type: 'rotateCW' };
      return;
    }
    if (key === keyBindings.rotateCCW.toLowerCase()) {
      pendingAction = { type: 'rotateCCW' };
      return;
    }

    // Hardcoded aliases (Arrow keys)
    // "Inverted" logic: Left Arrow -> CW (based on Q mapping), Right Arrow -> CCW (based on E mapping)
    if (e.key === 'ArrowLeft') {
      pendingAction = { type: 'rotateCW' };
      return;
    }
    if (e.key === 'ArrowRight') {
      pendingAction = { type: 'rotateCCW' };
      return;
    }

    switch (e.key) {
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
