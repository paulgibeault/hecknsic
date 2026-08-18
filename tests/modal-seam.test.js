/**
 * modal-seam.test.js — one way in and out of a modal (hecknsic#64).
 *
 * The bug this pins is not subtle once you see it: main.js's modals paused the
 * game, the puzzle selector / result / failed / editor modals did not, and
 * nothing anywhere enforced either convention. The board went on animating and
 * consuming clicks behind half the modals in the game, and #57 had already had
 * to fix six handlers that cleared the pause flag without waking the loop it
 * had parked. Both failures are call-site failures — the sequence was written
 * out by hand eleven times — so the fix is a seam, and these tests hold the
 * seam's contract rather than any one call site's.
 *
 * What is asserted here:
 *   - opening a modal pauses (per the documented policy table);
 *   - closing resumes, and resumes *through the loop's own wake seam*, which
 *     is what "a parked loop does not restart because a flag flipped" means;
 *   - a redraw requested behind an open modal does NOT put frames back on the
 *     schedule — the gate registered in main.js stays the sole authority;
 *   - closing always clears the pending action (ghost-click protection);
 *   - the three end-of-game modals are non-pausing on purpose, because the
 *     explosion tween runs behind them and needs a live loop;
 *   - and two repo gates: nothing outside js/modal.js toggles `hidden` on a
 *     modal root, and every modal root in index.html has a policy.
 *
 * The document stub is the same trick tests/rotation-cancel.test.js uses; the
 * loop stub is the one from tests/power-saver.test.js. Arcade has to be
 * installed before the module graph is evaluated (js/tween.js reads
 * reducedMotion at call time and frame.js comes along with it).
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installArcade } from './helpers/fake-arcade.mjs';

installArcade({ powerSaver: false, reducedMotion: true });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ─── DOM stub ───────────────────────────────────────────────────
//
// Just enough of an element to observe the one thing the seam does to the DOM.

const elements = new Map();

function fakeElement(id) {
  const classes = new Set(['modal', 'hidden']);
  return {
    id,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
  };
}

globalThis.window = {
  devicePixelRatio: 1,
  matchMedia: () => ({ matches: true }),
  requestAnimationFrame: () => 0,
};
globalThis.document = {
  documentElement: { style: { setProperty() {} } },
  getElementById: (id) => elements.get(id) ?? null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} } }),
};
globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;

const modal    = await import('../js/modal.js');
const frame    = await import('../js/frame.js');
const renderer = await import('../js/renderer.js');
const input    = await import('../js/input.js');

for (const id of modal.MODAL_IDS) elements.set(id, fakeElement(id));

const isHidden = (id) => elements.get(id).classList.contains('hidden');

/**
 * A stand-in for main.js: the pause flag, resumeFromPause(), the frame loop,
 * and — critically — the same gate main.js registers at the bottom of its
 * bootstrap. Everything the seam is allowed to touch, it touches through here.
 */
function makeHost() {
  const h = {
    isPaused: false,
    running: true,
    starts: 0,
    resumes: 0,
  };

  frame.registerFrameLoop(
    { start() { h.running = true; h.starts++; }, running: () => h.running },
    () => !h.isPaused,          // js/main.js:634 — the sole authority
  );

  modal.resetModalSeam();
  modal.registerModalHost({
    pause: () => { h.isPaused = true; },
    resume: () => {                 // js/main.js resumeFromPause()
      h.resumes++;
      h.isPaused = false;
      frame.wakeFrameLoop();
    },
  });

  // Every modal root back to hidden, and the loop parked as it would be behind
  // one (gameLoop parks on the first frame that observes the pause).
  for (const id of modal.MODAL_IDS) elements.get(id).classList.add('hidden');
  input.clearPendingAction();
  h.running = false;
  h.starts = 0;
  h.resumes = 0;
  return h;
}

// ─── Open / close ───────────────────────────────────────────────

test('opening a pausing modal hides nothing else and parks the game', () => {
  const h = makeHost();

  modal.openModal('modal-help');

  assert.strictEqual(isHidden('modal-help'), false, 'the modal root must be shown');
  assert.strictEqual(h.isPaused, true,
    'opening a modal must pause the game — the board must not animate or eat ' +
    'input behind it');
  assert.strictEqual(modal.isModalOpen('modal-help'), true);
});

test('closing resumes through the wake seam, not by flipping a flag', () => {
  const h = makeHost();

  modal.openModal('modal-help');
  assert.strictEqual(h.starts, 0, 'precondition: the loop is parked behind the modal');

  modal.closeModal('modal-help');

  assert.strictEqual(isHidden('modal-help'), true, 'the modal root must be hidden again');
  assert.strictEqual(h.isPaused, false, 'the pause must be lifted');
  assert.strictEqual(h.starts, 1,
    'clearing the flag is not enough (#55/#57): a parked loop does not restart ' +
    'because a boolean flipped, so the close must wake it as well — otherwise ' +
    'the board sits frozen until the next resize');
  assert.strictEqual(modal.isModalOpen('modal-help'), false);
});

test('closing discards the click that dismissed the modal', () => {
  const h = makeHost();

  modal.openModal('modal-scores');
  input.triggerAction('rotateCW');   // a gesture that landed behind the modal
  assert.strictEqual(input.hasPendingAction(), true, 'precondition: queued');

  modal.closeModal('modal-scores');

  assert.strictEqual(input.hasPendingAction(), false,
    'the seam must clear the pending action on close (js/input.js) — a ghost ' +
    'click surviving the close is answered by the board on the next frame');
});

// ─── The gate stays the sole authority ──────────────────────────

test('a redraw requested behind an open modal does not restart the loop', () => {
  const h = makeHost();

  modal.openModal('modal-puzzle-select');
  assert.strictEqual(h.isPaused, true, 'precondition: the selector pauses');

  renderer.requestRedraw();
  assert.strictEqual(h.starts, 0,
    'requestRedraw() must not revive the loop behind a modal — that is a ' +
    'deliberate park, not an idle one, and the gate registered in main.js is ' +
    'what tells the two apart');

  input.triggerAction('rotateCW');   // the keypress path: queue + requestRedraw
  assert.strictEqual(h.starts, 0,
    'a keypress behind an open modal must not put frames back on the schedule; ' +
    'the seam must not add a second path that starts the loop');

  modal.closeModal('modal-puzzle-select');
  assert.strictEqual(h.starts, 1, 'and the close is what brings it back');
});

// ─── Policy ─────────────────────────────────────────────────────

test('the puzzle modals opened on a live board pause — the bug in #64', () => {
  for (const id of ['modal-puzzle-select', 'modal-puzzle-editor']) {
    const h = makeHost();
    modal.openModal(id);
    assert.strictEqual(h.isPaused, true,
      `${id} must pause: before the seam it never touched the pause flag at ` +
      'all, so the board kept animating and consuming input behind it');
    modal.closeModal(id);
    assert.strictEqual(h.isPaused, false, `${id} must resume on close`);
    assert.strictEqual(h.starts, 1, `${id} must wake the loop on close`);
  }
});

test('the end-of-run modals stay non-pausing so the explosion can tick', () => {
  // The two puzzle end-of-run modals belong in this list, not with the puzzle
  // modals that open on a live board. Both fire _onPuzzleEnd() as they open,
  // which sets state = 'gameover' — input is already refused, so the pause buys
  // nothing — and both are opened from a setTimeout(600) inside onPuzzleMove().
  // Solve a puzzle on the same move a pre-placed bomb expires and that timer
  // lands 600 ms into handleGameOver()'s 1500 ms explosion; pausing there would
  // freeze the board mid-detonation until the player dismissed the modal.
  for (const id of ['modal-gameover', 'modal-gamewin', 'modal-over-achiever',
                    'modal-puzzle-result', 'modal-puzzle-failed']) {
    const h = makeHost();
    modal.openModal(id);
    assert.strictEqual(h.isPaused, false,
      `${id} must NOT pause: handleGameOver()/handleOverAchiever() show it and ` +
      'then await a 1.5 s tween that blows the board apart behind it, and ' +
      'handleGameWin() is the tail of an animation its caller is still ' +
      'awaiting. Pausing would park the loop those awaits depend on and hang ' +
      'the game.');

    renderer.requestRedraw();
    assert.strictEqual(h.starts, 1,
      `${id} is shown over a running animation, so the gate must stay open ` +
      'and a redraw behind it must still reach the loop');
  }
});

test('every close path resumes, including the ones that load a new board', () => {
  // btn-puzzle-retry / btn-puzzle-next close the result modal and go straight
  // into startPuzzle(), which replaces the board. startPuzzle() then calls
  // hidePuzzleModals() over the top, closing all three. The second close must
  // not undo the first, and neither may leave the game parked with a fresh
  // puzzle on screen.
  const h = makeHost();

  modal.openModal('modal-puzzle-result');
  modal.closeModal('modal-puzzle-result');          // the button handler
  ['modal-puzzle-select', 'modal-puzzle-result', 'modal-puzzle-failed']
    .forEach(modal.closeModal);                     // hidePuzzleModals()

  assert.strictEqual(h.isPaused, false,
    'a modal that pauses must resume on every exit path, including the ones ' +
    'that go on to load a new puzzle');
  assert.ok(h.starts >= 1, 'and the loop must be running for the new board');
});

test('closing a modal that is not open cannot unpause one that is', () => {
  const h = makeHost();

  modal.openModal('modal-puzzle-select');
  // clearActivePuzzle() → hidePuzzleModals() closes all three defensively while
  // only the selector is showing; the two absent ones must be no-ops.
  modal.closeModal('modal-puzzle-result');
  modal.closeModal('modal-puzzle-failed');

  assert.strictEqual(h.isPaused, true,
    'the pause is held by whichever pausing modal is still open, not by the ' +
    'last close call to run');
  assert.strictEqual(h.starts, 0, 'and the loop stays parked behind it');

  modal.closeModal('modal-puzzle-select');
  assert.strictEqual(h.isPaused, false, 'the last one out lifts the pause');
});

test('the selector handing over to the editor never unpauses in between', () => {
  // btn-open-puzzle-editor: close the selector, open the editor. Both pause.
  const h = makeHost();

  modal.openModal('modal-puzzle-select');
  modal.closeModal('modal-puzzle-select');
  modal.openModal('modal-puzzle-editor');

  assert.strictEqual(h.isPaused, true, 'the editor holds the pause the selector had');
  modal.closeModal('modal-puzzle-editor');
  assert.strictEqual(h.isPaused, false);
});

// ─── Repo gates ─────────────────────────────────────────────────

test('the policy table covers every modal root in index.html', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const inHtml = [...html.matchAll(/id="(modal-[\w-]+)"/g)].map((m) => m[1]).sort();

  assert.deepStrictEqual(inHtml, [...modal.MODAL_IDS].sort(),
    'a modal root with no entry in MODAL_POLICY would fall through the seam ' +
    'and silently skip the pause — which is precisely the bug #64 is about. ' +
    'Add it to js/modal.js.');
});

/**
 * The line #64 asks for: open/close is the seam's job and nobody else's.
 *
 * Scoped to `hidden` on *modal roots* — an id literal starting `modal-`, or a
 * variable this file assigned from one. The dropdown, the rotate controls and
 * the handedness pills toggle `hidden` too and are none of the seam's
 * business, so they must stay allowed; a naive grep for "hidden" would flag
 * them and be turned off within the week.
 *
 * A receiver the scan cannot resolve is also a failure. The pre-#64 code hid
 * the puzzle modals through a computed id — `getElementById(id)` in a forEach —
 * which no literal-based rule can see, and leaving that shape allowed would
 * leave the gate trivially sidesteppable.
 */
test('nothing outside js/modal.js toggles hidden on a modal root', () => {
  const files = fs.readdirSync(path.join(ROOT, 'js'))
    .filter((f) => f.endsWith('.js') && f !== 'modal.js');

  const violations = [];

  for (const file of files) {
    const src = fs.readFileSync(path.join(ROOT, 'js', file), 'utf8');

    // Locals assigned from a modal root: `const failedModal = getElementById('modal-…')`
    const rootVars = new Set(
      [...src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*document\s*\.\s*getElementById\(\s*['"]modal-/g)]
        .map((m) => m[1]),
    );

    for (const m of src.matchAll(/\.\s*classList\s*\.\s*(?:add|remove|toggle)\(\s*['"]hidden['"]/g)) {
      const before = src.slice(0, m.index);
      const line = before.split('\n').length;
      const where = `js/${file}:${line}`;

      const literal = before.match(/getElementById\(\s*(['"])([^'"]*)\1\s*\)\s*\??\s*$/);
      if (literal) {
        if (literal[2].startsWith('modal-')) {
          violations.push(`${where} — hides modal root '${literal[2]}' directly`);
        }
        continue;
      }

      const ident = before.match(/([A-Za-z_$][\w$]*)\s*\??\s*$/);
      if (ident) {
        if (rootVars.has(ident[1])) {
          violations.push(`${where} — hides modal root via '${ident[1]}'`);
        }
        continue;
      }

      violations.push(
        `${where} — unresolvable receiver for a 'hidden' toggle; if this is a ` +
        'modal it must go through js/modal.js, and if it is not, give it a ' +
        'plain named variable so this gate can tell');
    }
  }

  assert.deepStrictEqual(violations, [],
    'modal open/close belongs to js/modal.js — that is the whole point of ' +
    'hecknsic#64. A hand-rolled toggle skips the pause, the resume, or the ' +
    'pending-action clear, and which one it skips is a coin flip:\n' +
    violations.join('\n'));
});
