// ─── Grid ───────────────────────────────────────────────────────
export const GRID_COLS = 9;
export const GRID_ROWS = 9;
export const HEX_SIZE = 32;  // radius: center to vertex

// Derived dimensions (flat-top hex)
export const HEX_WIDTH  = HEX_SIZE * 2;
export const HEX_HEIGHT = Math.sqrt(3) * HEX_SIZE;
export const HEX_HORIZ  = HEX_WIDTH * 0.75;   // column spacing
export const HEX_VERT   = HEX_HEIGHT;          // row spacing

// ─── Colors ─────────────────────────────────────────────────────
export const PIECE_COLORS = [
  { name: 'red',    base: '#E03030', light: '#FF6060', dark: '#901818' },
  { name: 'orange', base: '#E88020', light: '#FFB050', dark: '#904810' },
  { name: 'blue',   base: '#2080E0', light: '#50B0FF', dark: '#104880' },
  { name: 'green',  base: '#30A840', light: '#60D870', dark: '#186020' },
  { name: 'purple', base: '#8040C0', light: '#B070F0', dark: '#502080' },
];

// Add teal at higher levels
export const EXTRA_COLORS = [
  { name: 'teal', base: '#20B0B0', light: '#50E0E0', dark: '#106060' },
];

// Bright silver chrome for starflower pieces (colorIndex = -1, unmatchable)
export const STARFLOWER_COLOR = {
  name: 'starflower', base: '#A0ADB8', light: '#D4DEE6', dark: '#4A5560',
};

// Deep obsidian for black pearl pieces (colorIndex = -2, unmatchable)
export const BLACK_PEARL_COLOR = {
  name: 'blackpearl', base: '#1A1520', light: '#3A2840', dark: '#0A0810',
};

// ─── UI ─────────────────────────────────────────────────────────
export const FRAME_COLOR     = '#2A2D35';
export const BOARD_BG_COLOR  = '#1A1D25';
export const TEXT_COLOR       = '#D0D0D8';
export const HIGHLIGHT_COLOR  = 'rgba(255, 255, 255, 0.85)';
export const CLUSTER_HIGHLIGHT = 'rgba(255, 255, 200, 0.55)';

// ─── Scoring ────────────────────────────────────────────────────
export const SCORE_BASE = { 3: 5, 4: 10, 5: 20 };
export const CHAIN_MULTIPLIER_BASE = 1.5;

// ─── Timing ─────────────────────────────────────────────────────
export const FALL_SPEED = 0.008;       // cells per ms
export const MATCH_FLASH_MS  = 500;    // flash + shrink before removal
export const GRAVITY_MS      = 120;    // per row of falling
export const ROTATION_POP_MS = 100;    // scale-up "pop"
export const ROTATION_SETTLE_MS = 200; // settle back "thunk"
export const SPAWN_DROP_MS   = 200;    // new pieces drop in

// ─── Bombs ──────────────────────────────────────────────────────
export const BOMB_INITIAL_TIMER  = 15; // moves before bomb explodes
export const BOMB_SPAWN_INTERVAL = 2; // spawn a bomb every N moves
export const BOMB_MIN_TIMER      = 8;  // shortest timer at high difficulty

