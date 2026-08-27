// Who is still available to captain, and how the seats are counted.
//
// The one bug worth a test here is invisible: filtering the candidate list on
// seat 1 alone. The list still looks right, the organizer picks a name off it,
// and the DATABASE refuses the insert — so the failure surfaces as a red banner
// on a click that should have worked, and only for co-captains.
const test = require('node:test');
const assert = require('node:assert');

const { captainCandidates } = require('../teams');
const {
  CAPTAIN_SEATS, MAX_CAPTAINS_PER_TEAM, isSeat, firstFreeSeat,
} = require('../../shared/captains.cjs');

const player = (id, name, wants = false) => ({
  id, player_name: name, wants_captain: wants, role: 'DPS',
});

test('someone holding either seat is off the candidate list', () => {
  const approved = [player('a', 'Arelite'), player('b', 'Boros'), player('c', 'Ceren')];
  // Boros is a CO-captain — seat 2. Filtering on seat 1 would keep him here.
  const seated = [
    { id: 'a', seat: 1 },
    { id: 'b', seat: 2 },
  ];

  const out = captainCandidates(approved, seated).map((p) => p.id);
  assert.deepStrictEqual(out, ['c']);
});

test('volunteers come first, then alphabetical within each group', () => {
  const approved = [
    player('1', 'Zane'),
    player('2', 'Arelite'),
    player('3', 'Yara', true),
    player('4', 'Boros', true),
  ];

  assert.deepStrictEqual(
    captainCandidates(approved, []).map((p) => p.player_name),
    ['Boros', 'Yara', 'Arelite', 'Zane']
  );
});

test('nobody seated yet means everybody is a candidate', () => {
  const approved = [player('a', 'Arelite'), player('b', 'Boros')];
  assert.strictEqual(captainCandidates(approved, []).length, 2);
});

test('a team takes exactly two captains', () => {
  assert.strictEqual(MAX_CAPTAINS_PER_TEAM, 2);
  assert.deepStrictEqual(CAPTAIN_SEATS.map((s) => s.seat), [1, 2]);
  assert.ok(isSeat(1) && isSeat(2));
  assert.ok(!isSeat(0) && !isSeat(3));
  // Strings arrive from a request body; a seat that isn't a number is not a seat.
  assert.ok(!isSeat('1'));
});

test('the first free seat is the lowest one, and null once full', () => {
  assert.strictEqual(firstFreeSeat([]), 1);
  assert.strictEqual(firstFreeSeat([1]), 2);
  assert.strictEqual(firstFreeSeat([2]), 1);      // seat 1 vacated, seat 2 held
  assert.strictEqual(firstFreeSeat([1, 2]), null);
});
