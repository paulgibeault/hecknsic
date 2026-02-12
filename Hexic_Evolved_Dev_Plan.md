# Hexic Evolved - Development Plan

Comprehensive plan to develop "Hexic Evolved" as a standalone web page using Three.js and modern web technologies.

## Tech Stack

*   **Rendering Engine:** **Three.js**
    *   Chosen for dynamic visuals, 3D representation of hexagonal pieces, advanced lighting, animations, and effects.
    *   Uses an orthographic camera for the classic top-down puzzle view.
*   **Core Language:** **JavaScript (ES6+)**
    *   Utilizes classes and modules for clean structure.
*   **Scaffolding:** **HTML5** and **CSS3**
    *   Simple structure without complex frameworks to ensure a lightweight, standalone application.
*   **Networking:** **WebRTC**
    *   Peer-to-peer multiplayer support.
*   **QR Code Library:** `qrcode-generator` (or similar)
    *   For creating and scanning QR codes to facilitate WebRTC connections.
*   **Animation:** **GSAP (GreenSock Animation Platform)**
    *   Integrated with Three.js for smooth, high-performance animations (movements, matches, UI effects).

---

## Development Phases

### Phase 1: Project Setup and Core Game Board Rendering

1.  **File Structure**
    *   `index.html`: Main page with `<canvas>` and UI containers.
    *   `css/style.css`: UI styling.
    *   `js/main.js`: Entry point.
    *   `js/GameBoard.js`: Manages game state, grid data, and hexagon objects.
    *   `js/Hexagon.js`: Represents a single hexagon piece.
    *   `js/Constants.js`: Game constants (colors, grid size, scoring).

2.  **Three.js Scene Setup**
    *   Initialize scene, renderer, and orthographic camera.
    *   Create `HexagonGeometry`.
    *   Render initial hexagonal grid based on `GameBoard` data.
    *   Implement basic game loop (`requestAnimationFrame`).

### Phase 2: Implementing Core Gameplay Mechanics

1.  **Player Input and Interaction**
    *   `Raycaster` for mouse/touch detection.
    *   Logic to select a cluster of three adjacent hexagons.
    *   Visual highlighting of selection.

2.  **Rotation and Placement**
    *   Clockwise/Counter-clockwise rotation logic (updating meshes and data).
    *   "Drop" mechanic to place rotated clusters.

3.  **Match Detection and Scoring**
    *   Check `GameBoard` for matches (3+ same-colored hexagons).
    *   Remove matched hexagons (data and meshes).
    *   `ScoreManager` for tracking and displaying score.
    *   Piece falling logic and chain reaction checks.

### Phase 3: Special Pieces and Visual Polish

1.  **Special Piece Logic**
    *   Pattern detection for **Stars**, **Flowers**, and **Bombs**.
    *   Visual updates for special pieces (textures, materials, particles).

2.  **Animation and Effects**
    *   GSAP animations for falling, rotating, and matching.
    *   Particle systems/shaders for special effects:
        *   **Star:** Color-clearing wave.
        *   **Flower:** Expanding ring explosion.
        *   **Bomb:** Large explosion.
    *   "Pulsing" effect synced with game loop/audio.

### Phase 4: Peer-to-Peer Multiplayer

1.  **UI for Multiplayer**
    *   "Host Game" and "Join Game" buttons.
    *   QR code display (Host) and camera view (Joiner).

2.  **WebRTC and Signaling**
    *   **Host:** Generate WebRTC offer -> QR Code.
    *   **Joiner:** Scan QR -> Decode -> Generate Answer -> Display Answer QR.
    *   **Connection:** Host scans Answer QR to establish `DataChannel`.

3.  **Multiplayer Gameplay**
    *   Split-screen view (two viewports).
    *   Sync game state (moves, power-ups) via `DataChannel`.
    *   Competitive power-ups (Bomb Drop, Color Change, Freeze).
    *   Dynamic split-screen divider based on score lead.

### Phase 5: Audio Integration and Final Deployment

1.  **Sound and Music**
    *   Background music.
    *   Web Audio API for beat analysis and visual syncing.
    *   Sound effects (rotation, matching, combos, special pieces).

2.  **Final Polish and Testing**
    *   Test all modes and interactions.
    *   Optimize Three.js performance (aim for 60 FPS).
    *   UI refinement and responsiveness.

3.  **Deployment**
    *   Package HTML/CSS/JS.
    *   Deploy to static host (e.g., GitHub Pages).