I would like to add a couple items on the todo list regarding gameplay.

- The starflower should move only one place when rotated.  It should not spin-until-match like the standard selection mode.

- The rotation buttons are inverted,  they spin the opposite direction as indicated.  I want the icons to stay in the same place, I jsut want them mapped differently.

- The rotation buttons should show the key binded to that direction, to make the ui more intuitive

- A simple and robust settings system utilizing browser cookies.  This would hold app settings like theme (dark/light), ~~sound controls~~, rotation button mapping, ~~high score~~, and other stateful needs. (Sound controls: done, via the launcher's global mute/volume, not an in-game cookie setting. High score: done for single-value bests via `Arcade.records` — see note below.)

- Use cookies (or other client-based storage option) to store game board state, to enable a game to persist accross page refreshes.

- Game history with high scores list (partially addressed — `Arcade.records` now tracks a single best-per-mode value (`best_score_arcade`/`best_score_chill`), not a ranked history list; still open if a history list is wanted)