# **Hecknsic: Game Design and Technical Specification**

## **1\. Introduction to Hecknsic**

Hecknsic is a captivating puzzle game designed for modern web platforms, building upon the core mechanics of the classic Hecknsic puzzle game. Players rotate clusters of colored hexagons on a grid to form matches of three or more, aiming for high scores through strategic play, combo chains, and the smart use of special pieces. The game emphasizes challenging puzzles, dynamic visuals, and engaging competitive multiplayer, all synchronized with moody, vibey music.

## **2\. Game Rules and Gameplay Mechanics**

### **2.1 Core Gameplay**

* **Objective**: Match three or more same-colored hexagons by rotating clusters.  
* **Grid**: The game is played on a hexagonal grid.  
* **Rotation**: Players select a cluster of three adjacent hexagons and can rotate them clockwise or counter-clockwise.  
* **Matching**: When three or more identical hexagons align, they disappear, and pieces above them fall to fill the empty spaces, potentially creating chain reactions.

### **2.2 Turn Mechanics**

A single turn involves:

1. **Cursor Movement**: Using controls (D-pad/left stick), players move a cursor to select a cluster of three hexagons.  
2. **Cluster Selection**: Pressing the 'A' button picks up the selected cluster. The spaces where the cluster was are temporarily left empty.  
3. **Rotation**: The selected cluster can be rotated clockwise or counter-clockwise (using left/right bumpers).  
4. **Placement**: Pressing 'A' again drops the cluster into its chosen position. It can be placed back in its original spot without changing the board if no rotation was made. There is no option to cancel a selection once a cluster is picked up; it must be placed.  
5. **Piece Falling**: After a match, new pieces fall from the top of the board to fill empty spaces, potentially triggering chain reactions.

### **2.3 Special Pieces and Power-Ups (In-Game)**

These special pieces are created during gameplay by specific matching patterns and are used on the player's own board to clear pieces.

* **Star**  
  * **Creation**: Formed by matching six same-colored hexagons in a **circle** (one hexagon in the center surrounded by five others).  
  * **Visuals**: Looks like a regular hexagon with a distinct swirling pattern inside.  
  * **Usage**: When included in a match of three or more, the star clears all hexagons of that same color across the entire board.  
  * **Disappearance**: Once activated, the star disappears.  
* **Flower**  
  * **Creation**: Formed by matching six same-colored hexagons in a **ring** (six hexagons surrounding an empty space where a piece previously was, creating a hole-like appearance in the middle).  
  * **Visuals**: Looks like a regular hexagon with a swirling pattern inside, similar to a star. When activated, it bursts open.  
  * **Usage**: When included in a match of three or more, the flower clears all hexagons immediately adjacent to it.  
  * **Disappearance**: Once activated, the flower disappears.  
* **Bomb**  
  * **Creation**: Formed by matching 10 or more hexagons in a single move.  
  * **Visuals**: Looks like a regular hexagon with a flashing fuse.  
  * **Usage**: When included in a match of three or more, it explodes, clearing a large area around it.  
  * **Chaining**: Bombs can trigger other bombs if their explosion radii overlap.  
  * **Disappearance**: Once activated, the bomb disappears.  
* **Obstacle Pieces (e.g., "Stone")**: Non-interactive pieces that act as obstacles. They cannot be moved directly but can be cleared by matching adjacent pieces or using specific power-ups.

### **2.4 Scoring System**

Scoring rewards larger matches, combo chains, and the strategic use of special pieces.

* **Base Points**:  
  * Match of 3: 10 points  
  * Match of 4: 20 points  
  * Match of 5: 40 points  
* **Special Piece Value**:  
  * Flower: 100 points  
  * Bomb: 200 points  
* **Chain Reaction Bonus**: An exponential multiplier is applied to subsequent matches within a single chain reaction. For example:  
  * 1st match: Base points  
  * 2nd match: Base points \* 1.5  
  * 3rd match: Base points \* 2  
  * And so on, with the multiplier increasing exponentially.

### **2.5 Visuals and User Interface (UI)**

* **Dynamic Visuals**: The game board and UI elements (like score counters) will pulse and vibrate in sync with the background music.  
* **Moody Colors**: The background will feature moody color filters or gradients, enhancing the atmosphere.  
* **Special Piece Effects**:  
  * Star: Swirling pattern when formed; clears pieces of its color with a distinct effect.  
  * Flower: Swirling pattern when formed; bursts open with an explosion effect when used, clearing adjacent pieces.  
  * Bomb: Flashing fuse when formed; large explosion effect when activated.  
* **Screen Layout (Single Player)**:  
  * Central hexagonal grid for the game board.  
  * Adjacent UI elements for score, timer, and potentially next piece previews or power-up indicators.  
  * Buttons for actions (e.g., Pause, Settings).

## **3\. Implementation Plan: Web-Based Multiplayer**

### **3.1 Core Technologies (Tech Stack)**

* **Frontend**: HTML5, CSS3, JavaScript.  
* **Frontend Framework**: React (preferred for component-based UI development). Other options include Vue.js or Angular.  
* **Styling Libraries**: Tailwind CSS (utility-first for flexible styling), or Material UI/Chakra UI (for pre-built components).  
* **Game Rendering**: PixiJS or Phaser (for efficient partial rendering and canvas management).  
* **Peer-to-Peer Networking**: WebRTC (Data Channels for gameplay data, no voice/video).  
* **Signaling for WebRTC**: A simple, lightweight server (e.g., built with Node.js and WebSockets like Socket.IO), or a user-driven peer-to-peer connection via QR code pairing.

### **3.2 Software Architecture**

The game will be structured into modular components to ensure maintainability and scalability, aligning with object-oriented principles where applicable.

* **Game Board Module**:  
  * Manages the hexagonal grid structure.  
  * Uses a 2D array or similar data structure to represent the grid, storing hexagon properties (color, special type).  
  * Handles piece generation, placement, rotation (using matrix transformations for new positions).  
  * Implements collision detection for piece placement.  
  * Manages piece falling and chain reactions after matches.  
  * Supports a palette of at least six base colors, plus additional colors/types for special pieces.  
* **Scoring Module**:  
  * Calculates points based on match size and special pieces.  
  * Applies exponential bonuses for chain reactions.  
  * Manages high scores.  
* **Power-Ups Module**:  
  * Handles the creation, properties, and activation of in-game special pieces (Stars, Flowers, Bombs).  
  * Manages the effects of multiplayer power-ups (Color Change, Bomb Drop, Freeze).  
* **Player Management Module**:  
  * Manages player states and actions in both single and multiplayer modes.  
  * Handles player-specific data like scores and current power-ups.  
* **Graphics and Audio Module**:  
  * Manages rendering to the canvas (using PixiJS/Phaser).  
  * Handles visual effects for matches, special pieces, and power-ups.  
  * Synchronizes visual pulsing/vibration with game music.  
  * Manages sound effects and background music.

### **3.3 Game Loop and Rendering**

The game will utilize a highly optimized game loop for smooth performance:

1. **requestAnimationFrame**: This browser API will serve as the entry point for each frame's computation and rendering, synchronizing with the browser's refresh rate (typically 60 FPS).  
2. **Update Game State**: Within each requestAnimationFrame call:  
   * Process user input (mouse, keyboard, touch).  
   * Update the game world based on inputs and game rules (e.g., move pieces, check for matches, update scores, activate power-ups).  
   * Prepare data for rendering the next frame. The "game state" object serves as the bridge, passing all current game information between frames.  
3. **Draw Frame (Partial Rendering)**:  
   * To minimize flickering and optimize performance, only the parts of the screen that have changed since the last frame will be redrawn.  
   * Libraries like PixiJS or Phaser will assist in managing canvas operations and implementing partial rendering efficiently.  
   * Steps: Clear only the changed areas, draw updated game board sections, draw updated pieces/elements, draw any refreshed UI components (score, timer).

### **3.4 Multiplayer Implementation**

* **Modes**:  
  * **Race to Score**: First player to reach a target score wins.  
  * **Timed Mode**: Highest score wins after a set time limit.  
  * **Sudden Death**: Player loses if they run out of moves.  
* **Competitive Power-Ups (Sent to Opponent)**:  
  * **Earning**: Players can earn these by creating bombs or stars on their own board and choosing *not* to use them locally, but instead send them to the opponent.  
  * **Bomb Drop**: A bomb visually drops on a random location on the opponent's screen, explodes, and clears pieces, causing a chain reaction on their board.  
  * **Color Change (Star-based)**: Triggered by sending a star; swaps colors of a few random hexagons on the opponent's board, scattering their setup.  
  * **Freeze**: A snowflake icon appears and temporarily freezes a random section of the opponent's hexagons, preventing them from making moves in that area.  
  * **Mechanic Refinement (To-Do)**: A short delay or visual indicator when a power-up is sent will be considered to smooth the experience.  
* **Visuals**:  
  * **Dynamic Split-Screen**: The screen will be split into two player views. The dividing line could dynamically shift to give the leading player a larger portion of the screen, or even rotate around the center like a wheel, providing a challenging and chaotic visual.  
  * **Power-Up Animations**:  
    * **Color Change**: Swirling rainbow icon appears, flashes, then random hexagons change color.  
    * **Bomb Drop**: Cartoon bomb falls, explodes, creates a temporary hole that refills.  
    * **Freeze**: Snowflake icon appears, hexagons under its effect get a frosty overlay and become immobile.  
* **Peer-to-Peer Connectivity (WebRTC)**:  
  * **Data Channels**: WebRTC's data channels will be used for direct, low-latency game data transmission between players' browsers (no voice/video).  
  * **No Central Server for Gameplay**: Once the connection is established, gameplay data flows directly between peers.  
  * **Initial Connection Setup (QR Code Pairing)**:  
    * **Mechanism**: Players establish connection by sharing a one-time code via a human-to-human transfer (e.g., QR code).  
    * **Player A (Host)**: Generates a QR code containing connection information (e.g., a WebRTC offer).  
    * **Player B (Joiner)**: Scans the QR code (using their phone or webcam) to obtain the connection information and establish the peer-to-peer link.  
    * **Implementation**: Utilize JavaScript libraries for QR code generation and scanning (e.g., ZXing library for browser-native functionality without user-installed dependencies).  
    * **Camera Access**: Accessing the user's camera for QR code scanning will trigger a standard browser permission prompt (getUserMedia API). Generating the QR code itself does not require permissions.  
    * **Benefits**: Eliminates the need for a persistent, central signaling server to host for all users, making the game easy to distribute and play.

### **3.5 Hosting and Deployment**

* **GitHub Pages**: The game will be hosted for free using GitHub Pages. Users can simply point their browser to the provided URL, download the game files, and it will run directly in their browser.  
* **User Configuration (Optional Signaling Server)**: While QR code pairing is preferred, the option could exist for users to configure their own signaling server address in a local configuration file if they choose an alternative connection method.

## **4\. Development Workflow Considerations**

* **Object-Oriented Design**: While React is functional, game logic and objects (e.g., Hexagon, GameBoard, Player) can be structured using classes. Phaser/PixiJS naturally support this with concepts like Phaser.Scene and game objects.  
* **Scene Management**: Phaser's scene management will allow for organizing different parts of the game (e.g., Main Menu, Multiplayer Lobby, Game Screen) into separate, manageable classes.

This comprehensive overview should serve as a strong foundation for designing the software architecture and proceeding with the development of "Hecknsic."
