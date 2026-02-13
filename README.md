<div align="center">
  <img src="icon.png" width="160" alt="Hecknsic Logo" />
  <h1>Hecknsic</h1>
  <a href="https://paulgibeault.github.io/hecknsic/" target="_blank">
    <img src="https://img.shields.io/badge/▶-Launch_Game-7000ff?style=for-the-badge&color=282c34&logoColor=61dafb" alt="Launch Game" />
  </a>
</div>

Hecknsic is a captivating puzzle game designed for modern web platforms, inspired by the classic Hexic HD. Players rotate clusters of colored hexagons on a grid to form matches of three or more, aiming for high scores through strategic play, combo chains, and the smart use of special pieces.

## Features

- **Hexagonal Grid**: A vibrant, dynamic game board.
- **Cluster Rotation**: Select and rotate groups of three tiles to create matches.
- **Special Pieces**:
  - **Star**: Clear all tiles of a specific color.
  - **Flower**: Clear adjacent tiles.
  - **Bomb**: Explode a large area.
- **Combo Chains**: Create cascading matches for exponential score multipliers.
- **Responsive Design**: Playable on desktop and mobile devices.

## How to Play

1. **Objective**: Match three or more same-colored hexagons by rotating clusters.
2. **Controls**:
   - **Select**: Click or tap to select a cluster of three hexagons.
   - **Rotate**: Use the on-screen buttons or keyboard shortcuts (Left/Right arrows or A/D keys) to rotate the selection.
   - **Match**: Align 3+ identical tiles to clear them.
3. **Special Combinations**:
   - **Star**: Form a ring of 6 same-colored tiles.
   - **Flower**: Form a ring of 6 surrounding an empty space.
   - **Bomb**: Match 10 or more tiles at once.

## Running the Game

To play the game locally:

1.  Clone the repository:
    ```bash
    git clone https://github.com/paulgibeault/hecknsic.git
    cd hecknsic
    ```

2.  Start a local web server. You can use Python's built-in server:
    ```bash
    python3 -m http.server 8000
    ```

3.  Open your browser and navigate to:
    `http://localhost:8000`

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
