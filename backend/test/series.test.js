// Best of three.
//
// This decides when a match is over, which decides when the bracket advances.
// Getting it wrong does not throw — it either advances a team who has not won
// yet, or leaves a finished match sitting on the bracket waiting for a game
// nobody is going to play.
const test = require('node:test');
const assert = require('node:assert');

const { toWin, isBestOf, seriesResult, gameSlots, scoreline } = require('../../shared/series.cjs');

const A = 'teamA';
const B = 'teamB';
const g = (game_number, winner_team_id, over = {}) => ({ game_number, winner_team_id, ...over });

// ── How many games win it ───────────────────────────────────────────────────
test('a best of N is won by more than half of N', () => {
  assert.strictEqual(toWin(1), 1);
  assert.strictEqual(toWin(3), 2);
  assert.strictEqual(toWin(5), 3);
  assert.strictEqual(toWin(7), 4);
});

test('ONLY ODD SERIES ARE ALLOWED', () => {
  // A best of four can end two apiece, and a bracket has no way to record a
  // draw or advance one — the match would never resolve, with nothing to say
  // why. The database refuses it as well.
  assert.ok(isBestOf(1) && isBestOf(3) && isBestOf(5));
  assert.ok(!isBestOf(2), 'even series can be drawn');
  assert.ok(!isBestOf(4));
  assert.ok(!isBestOf(0));
  assert.ok(!isBestOf(11), 'and there is an upper bound');
  assert.ok(!isBestOf(3.5));
  assert.ok(!isBestOf('3'), 'arrives from a request body');
});

// ── Where a series stands ───────────────────────────────────────────────────
test('nothing played is nothing decided', () => {
  const s = seriesResult([], 3, A, B);
  assert.deepStrictEqual([s.winsA, s.winsB, s.decided, s.winnerId], [0, 0, false, null]);
  assert.strictEqual(s.remaining, 2);
});

test('ONE WIN DOES NOT DECIDE A BEST OF THREE', () => {
  // The failure that advances a team who has not won yet.
  const s = seriesResult([g(1, A)], 3, A, B);
  assert.strictEqual(s.winsA, 1);
  assert.strictEqual(s.decided, false);
  assert.strictEqual(s.winnerId, null);
  // The MOST that could still be played: A needs one more, B needs two, so the
  // series can still run two games.
  assert.strictEqual(s.remaining, 2);
});

test('two wins decides it, and names the winner', () => {
  const s = seriesResult([g(1, A), g(2, A)], 3, A, B);
  assert.ok(s.decided);
  assert.strictEqual(s.winnerId, A);
  assert.strictEqual(s.remaining, 0, 'a dead rubber is not a game anybody plays');
});

test('a series that goes the distance is decided by the last game', () => {
  const after2 = seriesResult([g(1, A), g(2, B)], 3, A, B);
  assert.ok(!after2.decided, '1-1 is not a result');
  assert.strictEqual(after2.remaining, 1);

  const after3 = seriesResult([g(1, A), g(2, B), g(3, B)], 3, A, B);
  assert.ok(after3.decided);
  assert.strictEqual(after3.winnerId, B);
});

test('the order games arrive in does not matter', () => {
  const forwards = seriesResult([g(1, A), g(2, B), g(3, A)], 3, A, B);
  const backwards = seriesResult([g(3, A), g(1, A), g(2, B)], 3, A, B);
  assert.deepStrictEqual(
    [forwards.winsA, forwards.winsB, forwards.winnerId],
    [backwards.winsA, backwards.winsB, backwards.winnerId]
  );
});

test('a game with no winner yet counts for nobody', () => {
  // The map is entered before the game is played, so a row with a map and no
  // winner is the normal in-progress state.
  const s = seriesResult([g(1, A), g(2, null, { map: 'somewhere' })], 3, A, B);
  assert.strictEqual(s.played, 1);
  assert.strictEqual(s.winsA, 1);
  assert.ok(!s.decided);
});

test('a winner who is in neither team decides nothing', () => {
  // Cannot happen through the form. If it ever does, it must not hand the
  // series to somebody who was not playing.
  const s = seriesResult([g(1, 'someoneElse'), g(2, 'someoneElse')], 3, A, B);
  assert.strictEqual(s.winsA, 0);
  assert.strictEqual(s.winsB, 0);
  assert.ok(!s.decided);
  assert.strictEqual(s.played, 2, 'still counted as played, so it is visible');
});

test('a best of one is decided by one game', () => {
  const s = seriesResult([g(1, B)], 1, A, B);
  assert.ok(s.decided);
  assert.strictEqual(s.winnerId, B);
});

test('a best of five needs three', () => {
  assert.ok(!seriesResult([g(1, A), g(2, A)], 5, A, B).decided);
  assert.ok(seriesResult([g(1, A), g(2, A), g(3, A)], 5, A, B).decided);
});

// ── What the form should show ───────────────────────────────────────────────
test('an unplayed series offers exactly one empty game', () => {
  // Not three. Three empty rows invites somebody to fill in a game 3 that was
  // never played.
  const slots = gameSlots([], 3, A, B);
  assert.strictEqual(slots.length, 1);
  assert.deepStrictEqual(slots.map((s) => s.game_number), [1]);
  assert.ok(!slots[0].exists);
});

test('each recorded game reveals the next one', () => {
  const slots = gameSlots([g(1, A)], 3, A, B);
  assert.deepStrictEqual(slots.map((s) => s.game_number), [1, 2]);
  assert.deepStrictEqual(slots.map((s) => !!s.exists), [true, false]);
});

test('A DECIDED SERIES OFFERS NO FURTHER GAME', () => {
  // The dead rubber. Offering an empty game 3 under a finished 2-0 is how a
  // series ends up reading 2-1 when it was 2-0.
  const slots = gameSlots([g(1, A), g(2, A)], 3, A, B);
  assert.strictEqual(slots.length, 2);
  assert.ok(slots.every((s) => s.exists));
});

test('a game recorded after the series was decided is still shown', () => {
  // Somebody entered it. Hiding it would make the score on screen disagree with
  // the games on screen, with nothing to explain the difference.
  const slots = gameSlots([g(1, A), g(2, A), g(3, B)], 3, A, B);
  assert.strictEqual(slots.length, 3);
  assert.ok(slots[2].dead, 'and marked as not having counted');
});

test('slots always come out in game order', () => {
  const slots = gameSlots([g(3, B), g(1, A), g(2, B)], 3, A, B);
  assert.deepStrictEqual(slots.map((s) => s.game_number), [1, 2, 3]);
});

test('the scoreline reads in team order, not winner order', () => {
  assert.strictEqual(scoreline(seriesResult([g(1, B), g(2, B)], 3, A, B)), '0 — 2');
});
