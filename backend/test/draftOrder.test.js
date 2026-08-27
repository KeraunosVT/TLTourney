// The snake. Every failure mode here is silent: a draft with the order subtly
// wrong runs happily to the end, hands somebody an extra early pick, and the
// only evidence is a roster that looks slightly better than it should.
//
// The arithmetic is four lines, which is exactly why it needs testing — an
// off-by-one in the reversal gives seed 1 both ends of the snake, which is the
// single most valuable bug you could ship into a competitive draft.
const test = require('node:test');
const assert = require('node:assert');

const {
  slotFor, teamOnClock, totalPicks, upcoming, nextPickFor, fullOrder, worstCaseSeconds,
} = require('../../shared/draftOrder.cjs');

const teams = (n) => Array.from({ length: n }, (_, i) => `t${i + 1}`);

// ── The shape ───────────────────────────────────────────────────────────────
test('round 1 runs down the seed order, round 2 runs back up it', () => {
  const order = teams(4);
  assert.deepStrictEqual(fullOrder(order, 2), [
    't1', 't2', 't3', 't4',   // round 1
    't4', 't3', 't2', 't1',   // round 2
  ]);
});

test('THE SNAKE TURNS BACK: the last pick of an odd round and the first of the '
  + 'next belong to the same team', () => {
  // This is what makes a snake a snake. Get the reversal backwards and seed 1
  // gets picks 1 AND 5 instead of seed 4 getting 4 and 5 — a compounding
  // advantage that nothing else in the app would ever report.
  const order = teams(4);
  assert.strictEqual(teamOnClock(order, 4), 't4');
  assert.strictEqual(teamOnClock(order, 5), 't4');

  assert.strictEqual(teamOnClock(order, 8), 't1');
  assert.strictEqual(teamOnClock(order, 9), 't1');
});

test('over four rounds the pattern repeats, odd down and even up', () => {
  const order = teams(3);
  assert.deepStrictEqual(fullOrder(order, 4), [
    't1', 't2', 't3',
    't3', 't2', 't1',
    't1', 't2', 't3',
    't3', 't2', 't1',
  ]);
});

test('EVERY TEAM GETS EXACTLY THE SAME NUMBER OF PICKS', () => {
  // The fairness property the whole thing exists for, checked at sizes that
  // stress the parity: odd team counts, even team counts, odd and even rounds.
  for (const n of [2, 3, 5, 8, 11]) {
    for (const rounds of [1, 2, 3, 7, 58]) {
      const counts = new Map();
      fullOrder(teams(n), rounds).forEach((id) => counts.set(id, (counts.get(id) || 0) + 1));
      assert.strictEqual(counts.size, n, `${n} teams / ${rounds} rounds: not every team picked`);
      [...counts.values()].forEach((c) => assert.strictEqual(
        c, rounds, `${n} teams / ${rounds} rounds: a team got ${c} picks, not ${rounds}`
      ));
    }
  }
});

test('nobody picks twice in a row except across the turn', () => {
  const order = teams(6);
  const flat = fullOrder(order, 6);
  flat.forEach((id, i) => {
    if (i === 0 || flat[i - 1] !== id) return;
    // The only legal repeat is the last pick of a round followed by the first
    // of the next — i.e. i is a multiple of the team count.
    assert.strictEqual(i % order.length, 0, `pick ${i + 1} repeated ${id} mid-round`);
  });
});

// ── slotFor ─────────────────────────────────────────────────────────────────
test('round and pick-in-round are 1-based, the way they are said out loud', () => {
  assert.deepStrictEqual(slotFor(4, 1), { round: 1, pickInRound: 1, seatIndex: 0 });
  assert.deepStrictEqual(slotFor(4, 4), { round: 1, pickInRound: 4, seatIndex: 3 });
  assert.deepStrictEqual(slotFor(4, 5), { round: 2, pickInRound: 1, seatIndex: 3 });
  assert.deepStrictEqual(slotFor(4, 8), { round: 2, pickInRound: 4, seatIndex: 0 });
  assert.deepStrictEqual(slotFor(4, 9), { round: 3, pickInRound: 1, seatIndex: 0 });
});

test('a pick number that is not one gets null, not a guess', () => {
  assert.strictEqual(slotFor(4, 0), null);
  assert.strictEqual(slotFor(4, -1), null);
  assert.strictEqual(slotFor(4, 1.5), null);
  assert.strictEqual(slotFor(4, '1'), null);      // arrives from a request body
  assert.strictEqual(slotFor(0, 1), null);
});

test('a single team still snakes correctly — it just picks every time', () => {
  assert.deepStrictEqual(fullOrder(['solo'], 3), ['solo', 'solo', 'solo']);
});

test('teamOnClock past the end of the order is null', () => {
  assert.strictEqual(teamOnClock([], 1), null);
  assert.strictEqual(teamOnClock(teams(4), 0), null);
});

// ── Counting ────────────────────────────────────────────────────────────────
test('totalPicks is teams times rounds, and never negative', () => {
  assert.strictEqual(totalPicks(8, 58), 464);
  assert.strictEqual(totalPicks(8, 0), 0);
  assert.strictEqual(totalPicks(0, 58), 0);
  assert.strictEqual(totalPicks(8, -3), 0);
});

test('worst case draft length is the number nobody works out in advance', () => {
  // 8 teams, 58 rounds, 2 minutes a pick. Fifteen and a half hours.
  assert.strictEqual(worstCaseSeconds(8, 58, 120), 55680);
  assert.ok(worstCaseSeconds(8, 58, 120) / 3600 > 15);
});

// ── upcoming ────────────────────────────────────────────────────────────────
test('on deck reads forward across the turn', () => {
  const order = teams(4);
  const next = upcoming(order, 3, 4, 3);
  assert.deepStrictEqual(next.map((x) => x.teamId), ['t3', 't4', 't4', 't3']);
  assert.deepStrictEqual(next.map((x) => x.pick), [3, 4, 5, 6]);
  assert.deepStrictEqual(next.map((x) => x.round), [1, 1, 2, 2]);
});

test('on deck runs out at the end of the draft rather than inventing picks', () => {
  const order = teams(4);
  assert.strictEqual(upcoming(order, 7, 5, 2).length, 2);   // only 8 picks exist
  assert.strictEqual(upcoming(order, 9, 5, 2).length, 0);
});

// ── nextPickFor ─────────────────────────────────────────────────────────────
test('a team on the clock finds THIS pick, not the next one', () => {
  // The difference between "you're up" and "you're up in 8", which is the
  // difference between a captain reading their board and a captain missing it.
  const order = teams(4);
  assert.strictEqual(nextPickFor(order, 't1', 1, 4), 1);
  assert.strictEqual(nextPickFor(order, 't1', 2, 4), 8);
  assert.strictEqual(nextPickFor(order, 't4', 2, 4), 4);
  assert.strictEqual(nextPickFor(order, 't4', 5, 4), 5);
  assert.strictEqual(nextPickFor(order, 't4', 6, 4), 12);
});

test('the wait between a team\'s picks is longest at the ends of the order', () => {
  // Seed 1 waits 6 picks between round 1 and round 2 with 4 teams; the middle
  // seeds wait less. That asymmetry is the snake working, not a bug.
  const order = teams(4);
  assert.strictEqual(nextPickFor(order, 't1', 2, 4) - 1, 7);
  assert.strictEqual(nextPickFor(order, 't2', 3, 4) - 2, 5);
});

test('a team with no picks left gets null rather than a pick past the end', () => {
  const order = teams(4);
  assert.strictEqual(nextPickFor(order, 't1', 9, 2), null);
  assert.strictEqual(nextPickFor(order, 'nobody', 1, 4), null);
});
