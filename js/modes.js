/**
 * modes.js — Game mode definitions and active-mode state.
 */

const MODES = {
  arcade: { id: 'arcade', label: 'Arcade', hasBombs: true,  hasGameOver: true,  matchMode: 'line' },
  chill:  { id: 'chill',  label: 'Chill',  hasBombs: false, hasGameOver: false, matchMode: 'line' },
  triangle: { id: 'triangle', label: 'Triangle', hasBombs: true, hasGameOver: true, matchMode: 'triangle' },
};

let activeModeId = 'arcade';

export function loadActiveMode() {
  const saved = localStorage.getItem('hecknsic_activemode');
  if (saved && MODES[saved]) activeModeId = saved;
}

export function getActiveMode()   { return MODES[activeModeId]; }
export function getActiveModeId() { return activeModeId; }
export function getAllModes()      { return Object.values(MODES); }
export function setActiveMode(id) {
  activeModeId = id;
  localStorage.setItem('hecknsic_activemode', id);
}
