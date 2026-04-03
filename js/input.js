/**
 * input.js — Mouse, touch, and keyboard input → game actions.
 */

import { GRID_COLS, GRID_ROWS } from './constants.js';
import { pixelToHex, findClusterAtPixel } from './hex-math.js';
import { getOrigin, getBoardScale, requestRedraw } from './renderer.js';

// ─── State ──────────────────────────────────────────────────────
let mouseX = 0, mouseY = 0;
let lastClickPos = null;     // {x, y} of last click for flower detection
let hoverCluster = null;
let pendingAction = null;  // { type: 'select'|'rotateCW'|'rotateCCW' }
let clusterCenterPx = null; // {x, y} pixel center of selected cluster (canvas-scaled coords)

export function getHoverCluster() { return hoverCluster; }
export function getLastClickPos() { return lastClickPos; }
export function getMousePos() { return { x: mouseX, y: mouseY }; }

/**
 * Called by main.js whenever a cluster is selected/changed.
 * x, y are in canvas-scaled coordinates (same space as lastClickPos).
 */
export function setClusterCenterPx(x, y) {
  clusterCenterPx = (x != null && y != null) ? { x, y } : null;
}

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
 * Discard any pending input action and last click position.
 * Call after closing a modal to prevent ghost clicks from re-opening it.
 */
export function clearPendingAction() {
  pendingAction = null;
  lastClickPos = null;
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
    requestRedraw();
  });

  canvas.addEventListener('click', e => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const s = getBoardScale();
    lastClickPos = { x: (e.clientX - rect.left) / s, y: (e.clientY - rect.top) / s };
    pendingAction = { type: 'select' };
    requestRedraw();
  });

  canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    pendingAction = { type: 'rotateCCW' };
    requestRedraw();
  });

  // Touch — tap to select, horizontal swipe to rotate
  const SWIPE_THRESHOLD_PX = 40; // screen pixels (not scaled)
  let touchStartX = 0, touchStartY = 0;

  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    const touch = e.touches[0];
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    const rect = canvas.getBoundingClientRect();
    const s = getBoardScale();
    mouseX = (touch.clientX - rect.left) / s;
    mouseY = (touch.clientY - rect.top) / s;
    lastClickPos = { x: mouseX, y: mouseY };
    updateHover();
    requestRedraw();
  }, { passive: false });

  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    const touch = e.touches[0];
    const rect = canvas.getBoundingClientRect();
    const s = getBoardScale();
    mouseX = (touch.clientX - rect.left) / s;
    mouseY = (touch.clientY - rect.top) / s;
    updateHover();
    requestRedraw();
  }, { passive: false });

  canvas.addEventListener('touchend', e => {
    e.preventDefault();
    const touch = e.changedTouches[0];
    const dx = touch.clientX - touchStartX;
    const dy = touch.clientY - touchStartY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    if (Math.hypot(dx, dy) >= SWIPE_THRESHOLD_PX) {
      // Pinwheel: cross product of (finger-pos relative to cluster center) × (swipe direction).
      // Both vectors in screen pixels. In screen coords (y-down): cross > 0 → CW, cross < 0 → CCW.
      let clockwise;
      if (clusterCenterPx) {
        const rect = canvas.getBoundingClientRect();
        const s = getBoardScale();
        const centerScreenX = clusterCenterPx.x * s + rect.left;
        const centerScreenY = clusterCenterPx.y * s + rect.top;
        const rx = touchStartX - centerScreenX;
        const ry = touchStartY - centerScreenY;
        const cross = rx * dy - ry * dx;
        clockwise = cross > 0;
      } else {
        clockwise = dx > 0;
      }
      pendingAction = { type: clockwise ? 'rotateCW' : 'rotateCCW' };
    } else {
      // Short movement — treat as tap → select
      pendingAction = { type: 'select' };
    }
    requestRedraw();
  }, { passive: false });

  // Keyboard
  window.addEventListener('keydown', e => {
    const key = e.key.toLowerCase();
    
    // Configurable keys
    if (key === keyBindings.rotateCW.toLowerCase()) {
      pendingAction = { type: 'rotateCW' };
      requestRedraw();
      return;
    }
    if (key === keyBindings.rotateCCW.toLowerCase()) {
      pendingAction = { type: 'rotateCCW' };
      requestRedraw();
      return;
    }

    // Hardcoded aliases (Arrow keys)
    // "Inverted" logic: Left Arrow -> CW (based on Q mapping), Right Arrow -> CCW (based on E mapping)
    if (e.key === 'ArrowLeft') {
      pendingAction = { type: 'rotateCW' };
      requestRedraw();
      return;
    }
    if (e.key === 'ArrowRight') {
      pendingAction = { type: 'rotateCCW' };
      requestRedraw();
      return;
    }

    switch (e.key) {
      case ' ':
      case 'Enter':
        e.preventDefault();
        pendingAction = { type: 'select' };
        requestRedraw();
        break;
    }
  });
}

function updateHover() {
  const { originX, originY } = getOrigin();
  hoverCluster = findClusterAtPixel(mouseX, mouseY, originX, originY, GRID_COLS, GRID_ROWS);
}
