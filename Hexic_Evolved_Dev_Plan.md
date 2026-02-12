# Hexic Evolved — Development Plan

A clean, phase-gated blueprint to recreate the speed and vibe of Hexic HD as a standalone web page. Every phase ends with a playable milestone.

---

## 1. Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| **Rendering** | HTML5 Canvas 2D | Zero dependencies, fast for 2D, easy bevel/gradient effects |
| **Language** | Vanilla JS (ES6+ modules) | No build step, `<script type="module">` |
| **Structure** | Single `index.html` + module files | Serve from any static host |
| **Audio** | Web Audio API | Beat analysis, spatial SFX, no libs needed |
| **Multiplayer** | WebRTC DataChannel | P2P, low latency, no game server |
| **Signaling** | QR code exchange (`qrcode-generator` + camera scan) | No central server required |

> **Excluded on purpose:** Three.js (overkill for 2D), React/Vue (no component tree needed), GSAP (custom tween is trivial), PixiJS/Phaser (Canvas 2D is enough).

---

## 2. File Layout

```
index.html
css/
  style.css
js/
  main.js            ← entry point, game loop, canvas setup
  constants.js       ← colors, grid size, scoring tables
  hex-math.js        ← coordinate conversions, neighbor lookup
  board.js           ← grid state, spawn, gravity, match detection
  cluster.js         ← 3-hex cluster selection + rotation
  renderer.js        ← draw board, hexes, cursor, effects
  input.js           ← mouse/touch/keyboard → game actions
  score.js           ← points, chain multiplier, level
  specials.js        ← star, flower, bomb creation + activation
  tween.js           ← lightweight easing helper (~40 lines)
  audio.js           ← music, SFX, beat detection
  multiplayer.js     ← WebRTC, QR signaling, state sync
  ui.js              ← HUD overlays (score, combo, pause)
assets/
  sounds/            ← match.wav, rotate.wav, combo.wav, etc.
  music/             ← background track(s)
```

---

## 3. Hex Grid Math

The grid uses **flat-top hexagons** in an **offset coordinate system (odd-q)**.

### 3.1 Storage

A 2D array `grid[col][row]` where odd columns are shifted down by half a hex height.

### 3.2 Hex Dimensions

```
           ___
          /   \       size = radius from center to vertex
         /     \      width  = size * 2
        |       |     height = sqrt(3) * size
         \     /      horiz  = width * 3/4   (column spacing)
          \___/       vert   = height         (row spacing)
```

### 3.3 Grid → Pixel

```js
function hexToPixel(col, row, size) {
  const x = originX + col * size * 1.5;
  const y = originY + row * Math.sqrt(3) * size
            + (col % 2 === 1 ? Math.sqrt(3) / 2 * size : 0);
  return { x, y };
}
```

### 3.4 Pixel → Grid (for click detection)

Convert pixel to fractional axial coordinates, then round to nearest hex:

```js
function pixelToHex(px, py, size) {
  const q = (2/3 * (px - originX)) / size;
  const r = (-1/3 * (px - originX) + Math.sqrt(3)/3 * (py - originY)) / size;
  return axialRound(q, r);  // then convert axial → offset
}
```

### 3.5 Neighbors (odd-q offset)

```js
const NEIGHBORS_EVEN = [
  [+1,  0], [+1, -1], [ 0, -1],
  [-1, -1], [-1,  0], [ 0, +1]
];
const NEIGHBORS_ODD = [
  [+1, +1], [+1,  0], [ 0, -1],
  [-1,  0], [-1, +1], [ 0, +1]
];
```

### 3.6 Cluster Selection

A **cluster** is 3 hexes sharing a common vertex. There are 6 possible cluster orientations around each vertex. The player's cursor sits on a vertex; clicking cycles through the 6 triangles or selects the one closest to the click angle.

### 3.7 Rotation

Rotating a cluster CW: `[A, B, C] → [C, A, B]` (shift colors, not positions).
Rotating CCW: `[A, B, C] → [B, C, A]`.

---

## 4. Visual Spec (Matching Original Hexic HD)

### 4.1 Overall Look

Referencing the original screenshot:
- **Board background**: dark steel-gray metallic frame with subtle hex-pattern texture
- **Play area**: slightly recessed, darker background behind the hexes
- **Hexes**: glossy, 3D-beveled, vibrant, saturation-rich

### 4.2 Color Palette

| Color | Hex (approx) | Usage |
|-------|--------------|-------|
| Red | `#E03030` | Piece |
| Orange | `#E88020` | Piece |
| Blue | `#2080E0` | Piece |
| Green | `#30A840` | Piece |
| Purple | `#8040C0` | Piece |
| Teal | `#20B0B0` | Piece (6th color, higher levels) |
| Frame | `#2A2D35` | UI border |
| Board BG | `#1A1D25` | Behind hexes |

### 4.3 Hex Rendering (Canvas 2D)

Each hex is drawn as a 6-sided polygon with:
1. **Base fill**: radial gradient from lighter center to darker edge (simulates dome/bevel)
2. **Highlight**: small arc of white at top-left (~20% opacity) for gloss
3. **Outline**: 1px darker stroke for separation
4. **Selected**: bright white outline + slight scale-up via transform

### 4.4 UI Layout

```
┌──────────────────────────────────┐
│  HEXIC          SCORE: 200       │  ← top bar
├──────────────────────────────────┤
│ LEVEL │                          │
│   1   │                          │
│       │      HEX GRID            │
│COMBOS │     (centered)           │
│  16   │                          │
│       │                          │
│       │                          │
├──────────────────────────────────┤
│           [Pause]                │  ← bottom bar
└──────────────────────────────────┘
```

---

## 5. Development Phases

### Phase 1 — Board + Rendering

**Goal:** See a full board of glossy hexes with a movable cursor.

- [ ] Canvas setup, resize handler, game loop (`requestAnimationFrame`)
- [ ] Implement `hex-math.js` (all formulas from §3)
- [ ] `board.js`: create grid, fill with random colors, store as `grid[col][row] = { color, special }`
- [ ] `renderer.js`: draw each hex with bevel/gloss gradient
- [ ] Draw dark metallic frame and HUD layout
- [ ] `input.js`: pixel→hex on mousemove, highlight hovered hex
- [ ] Cursor: highlight the nearest cluster (3 hexes around a vertex)

**Exit criteria:** Board renders at 60 FPS, cursor highlights a valid cluster as you move the mouse.

---

### Phase 2 — Core Gameplay

**Goal:** Fully playable single-player loop — select, rotate, match, score.

- [ ] Click to select cluster → visual "lift" (scale + shadow)
- [ ] Left-click / `Q` key = rotate CW, right-click / `E` key = rotate CCW
- [ ] Confirm placement on second click (or after rotation)
- [ ] `board.js` match detection:
  - Scan 3 axes (horizontal + 2 diagonals) for runs of 3+ same color
  - Flood-fill variant to catch non-linear groups
- [ ] Matched hexes: brief white flash → fade out → remove
- [ ] Gravity: pieces above empty spaces slide down (animated)
- [ ] New pieces spawn at top with a brief "drop-in" animation
- [ ] Chain reactions: re-scan after gravity settles, repeat until stable
- [ ] `score.js`: base points + exponential chain multiplier
- [ ] HUD: live score, combo counter

**Exit criteria:** You can play indefinitely — rotate clusters, matches clear, chains cascade, score climbs.

---

### Phase 3 — Special Pieces + Polish

**Goal:** Full single-player game with specials, effects, and audio.

- [ ] **Star**: detect 6 same-color in a ring around a center hex → replace center with star piece
  - Activation: when star is part of a match, clear all pieces of that color on the board
  - Visual: swirling gradient on the star hex; color-wave sweep effect on activation
- [ ] **Flower**: detect 6 same-color surrounding an empty gap → place flower
  - Activation: clears all hexes adjacent to the flower
  - Visual: expanding ring burst
- [ ] **Bomb**: detect 10+ matched in one move → spawn bomb at center of match
  - Activation: large area explosion (radius ~3 hexes)
  - Visual: shockwave ring + debris particles
- [ ] **Obstacle pieces** (stone): immovable, cleared only by adjacent matches or specials
- [ ] Particle system: simple canvas-drawn circles with velocity + fade for match/explosion FX
- [ ] Sound effects: rotate click, match chime (pitch rises with chain length), combo whoosh, special activation
- [ ] Background music: Web Audio API playback, optional BPM detection for pulsing hex brightness
- [ ] Level progression: increase color count or add obstacles as score milestones are reached
- [ ] Game-over condition: no valid moves remaining → show final score

**Exit criteria:** A complete, polished single-player game that feels fast and satisfying.

---

### Phase 4 — Multiplayer

**Goal:** Two players compete head-to-head via WebRTC.

- [ ] **Connection flow:**
  1. Host clicks "Host Game" → generates WebRTC offer → encodes as QR code
  2. Joiner scans QR → decodes offer → generates answer → shows answer QR
  3. Host scans answer QR → DataChannel opens
- [ ] **Split-screen rendering**: two independent board canvases side by side
- [ ] **State sync**: each player sends only their moves; each client runs its own simulation for the opponent's board
- [ ] **Game modes:**
  - Race to Score (first to N wins)
  - Timed (highest score in T seconds)
  - Sudden Death (no valid moves = loss)
- [ ] **Competitive power-ups** (earned by creating specials, sent to opponent instead of using locally):
  - Bomb Drop: random area explosion on opponent's board
  - Color Change: swap colors of random hexes on opponent's board
  - Freeze: lock a section of opponent's board for a few seconds
- [ ] Dynamic split-screen divider: shifts toward the losing player

**Exit criteria:** Two browsers on the same network can connect and play a competitive match.

---

### Phase 5 — Deploy + Final Polish

**Goal:** Ship it.

- [ ] Mobile/touch input support (tap to select, swipe to rotate)
- [ ] Responsive canvas sizing for different screen sizes
- [ ] Performance audit: stay above 60 FPS on mid-range hardware
- [ ] Deploy to GitHub Pages
- [ ] README with screenshots and play instructions

**Exit criteria:** Live at a public URL, playable on desktop and mobile.

---

## 6. Guiding Principles

1. **No frameworks until proven necessary.** Vanilla JS + Canvas 2D can do everything Hexic needs. Add a library only when hand-rolling would take >2 hours and produce worse results.
2. **Playable at every phase.** Never go more than a few days without something you can click on and enjoy.
3. **Juice > features.** A board with 5 colors and great animations beats a board with 8 colors and no polish.
4. **Data drives rendering.** The grid array is the source of truth. The renderer reads it every frame. Never store game state in DOM or canvas.
5. **Keep files short.** No file over ~300 lines. If it's growing past that, split it.