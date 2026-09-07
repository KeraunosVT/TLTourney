// The compensation pick.
//
// EGIRL GAP's captain holds a seat without playing, so his team fields one
// fewer than everybody else. The snake cannot express that — every team gets
// exactly `rounds` picks, which is the closed form the whole engine rests on —
// so one pick is inserted outside it.
//
// Every failure here is silent in the way the snake's are: an insertion point
// off by one hands the extra pick to the wrong team, or renumbers every round
// after it, and the draft runs to the end looking fine.
const test = require('node:test');
const assert = require('node:assert');

const {
  teamOnClock, draftSlot, totalPicks, compAfterPick, fullOrder, nextPickFor, upcoming,
} = require('../../shared/draftOrder.cjs');
const { rosterProgress } = require('../../shared/roster.cjs');
const { startProblems } = require('../draft');

const SEATS = ['A', 'B', 'C', 'D'];
const COMP = { afterPick: compAfterPick(4, 48, 2), teamId: 'B' };

test('the pick lands the moment every team has its 48', () => {
  // A full-strength team holds 2 captains, so it reaches 48 after round 46.
  assert.strictEqual(COMP.afterPick, 184);
  assert.strictEqual(COMP.afterPick / SEATS.length, 46);
});

test('IT GOES TO THE RIGHT TEAM, and only that one pick moves', () => {
  const o = fullOrder(SEATS, 64, COMP);
  // Round 46 is even, so it runs back up the seed order: D C B A.
  assert.deepStrictEqual(o.slice(180, 184), ['D', 'C', 'B', 'A']);
  assert.strictEqual(o[184], 'B', 'pick 185 is the compensation');
  // Round 47 is odd and resumes from the top, unrenumbered.
  assert.deepStrictEqual(o.slice(185, 189), ['A', 'B', 'C', 'D']);
});

test('exactly one extra pick exists, and one team has it', () => {
  const o = fullOrder(SEATS, 64, COMP);
  assert.strictEqual(o.length, 257);
  assert.strictEqual(totalPicks(4, 64, COMP), 257);
  const counts = {};
  o.forEach((t) => { counts[t] = (counts[t] || 0) + 1; });
  assert.deepStrictEqual(counts, { A: 64, B: 65, C: 64, D: 64 });
});

test('A DRAFT THAT OWES NOBODY IS BYTE-FOR-BYTE THE OLD ONE', () => {
  // The property that lets this ship: the other three teams' drafts, and every
  // past season, must be untouched by the existence of this feature.
  const withNull = fullOrder(SEATS, 64, null);
  assert.deepStrictEqual(fullOrder(SEATS, 64), withNull, 'omitted comp');
  assert.deepStrictEqual(fullOrder(SEATS, 64, { teamId: null, afterPick: 184 }), withNull);
  assert.strictEqual(totalPicks(4, 64), 256);
});

test('the compensation pick reports the round it FOLLOWS', () => {
  // Not a round 46.5, and not a renumbering of everything after it. The page
  // says "round 46 · compensation" and round 47 is still round 47.
  const at185 = draftSlot(4, 185, COMP);
  assert.strictEqual(at185.round, 46);
  assert.strictEqual(at185.compensation, true);
  assert.strictEqual(at185.pickInRound, null, 'it is not the Nth pick of a round');

  const at186 = draftSlot(4, 186, COMP);
  assert.strictEqual(at186.round, 47);
  assert.strictEqual(at186.pickInRound, 1);
  assert.strictEqual(at186.compensation, false);
});

test('the seat under a compensation pick is NOT the team it belongs to', () => {
  // The bug this guards, and it was one line in makePick: draftSlot reports the
  // seat that had pick 184 (team A, the end of an even round). Indexing that
  // seat would hand pick 185 to A and reject B, whose pick it is.
  assert.strictEqual(SEATS[draftSlot(4, 185, COMP).seatIndex], 'A');
  assert.strictEqual(teamOnClock(SEATS, 185, COMP), 'B');
});

test('a team looking ahead sees its extra pick', () => {
  // Round 46 runs D C B A over picks 181-184, so B picks at 183 and its next
  // turn would be round 47's second pick — 186. The compensation gives it 185
  // instead, one pick earlier and off a board nobody else has touched since.
  assert.strictEqual(nextPickFor(SEATS, 'B', 184, 64, COMP), 185);
  assert.strictEqual(nextPickFor(SEATS, 'B', 184, 64, null), 186);
  // And nobody else's next pick moves.
  assert.strictEqual(nextPickFor(SEATS, 'C', 186, 64, COMP), 188);
});

test('on deck shows it, flagged', () => {
  const next = upcoming(SEATS, 184, 3, 64, COMP);
  assert.deepStrictEqual(next.map((x) => x.teamId), ['A', 'B', 'A']);
  assert.deepStrictEqual(next.map((x) => x.compensation), [false, true, false]);
});

// ── Who is owed one ─────────────────────────────────────────────────────────
const team = (id, over = {}) => ({
  id, name: id, seed: Number(id.slice(1)),
  rosterCount: 2, playingCount: 2, captainCount: 2, ...over,
});
const four = (over = {}) => ['T1', 'T2', 'T3', 'T4'].map((id, i) => team(id, i === 1 ? over : {}));

test('a non-playing captain earns exactly one compensation pick', () => {
  const { problems, comp, rounds } = startProblems(66, four({ playingCount: 1 }), 48);
  assert.deepStrictEqual(problems, [], 'the rosters are still level');
  assert.strictEqual(rounds, 64, 'the round count is unchanged');
  assert.strictEqual(comp.teamId, 'T2');
  assert.strictEqual(comp.afterPick, 184);
});

test('THE LEVEL CHECK STILL PASSES — he occupies a roster slot', () => {
  // The point of the design: he stays on the roster (which is what keeps him
  // off everyone's board), so every team starts with two rows and the existing
  // fairness check has nothing to complain about.
  const teams = four({ playingCount: 1 });
  assert.deepStrictEqual(teams.map((x) => x.rosterCount), [2, 2, 2, 2]);
  assert.deepStrictEqual(startProblems(66, teams, 48).problems, []);
});

test('nobody non-playing means no compensation at all', () => {
  assert.strictEqual(startProblems(66, four(), 48).comp, null);
});

test('two teams short is REFUSED rather than half-compensated', () => {
  // Only one pick can be inserted. Compensating one team and silently not the
  // other is worse than refusing to start.
  const teams = four({ playingCount: 1 });
  teams[2].playingCount = 1;
  const { problems } = startProblems(66, teams, 48);
  assert.ok(problems.some((p) => /Only one compensation/.test(p)), problems.join(' | '));
});

test('a team short by two is refused too', () => {
  const { problems } = startProblems(66, four({ playingCount: 0 }), 48);
  assert.ok(problems.some((p) => /more than one/.test(p)), problems.join(' | '));
});

// ── The roster counts he is kept out of ─────────────────────────────────────
test('a non-playing member is on the roster and in no role total', () => {
  const members = [
    { role: 'Tank', playing: false },
    { role: 'Tank' },
    { role: 'Healer', playing: true },
  ];
  const p = rosterProgress(members, 66);
  assert.strictEqual(p.filled, 3, 'still rostered');
  assert.strictEqual(p.playing, 2);
  assert.strictEqual(p.nonPlaying, 1);
  assert.strictEqual(p.byRole.find((r) => r.role === 'Tank').have, 1, 'not counted as a tank');
});

test('rows from before the column are players', () => {
  // `playing` is undefined on every row written before migration 028. The test
  // everywhere is `!== false`, so absent and true behave identically.
  const p = rosterProgress([{ role: 'Tank' }, { role: 'DPS' }], 66);
  assert.strictEqual(p.playing, 2);
  assert.strictEqual(p.nonPlaying, 0);
});
