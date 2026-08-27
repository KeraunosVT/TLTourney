// Rosters: how full, and who is still available.
//
// The arithmetic here is the kind that is wrong quietly. A `remaining` that
// forgets the captains already on the roster is off by exactly two, which looks
// entirely reasonable right up to the moment a captain drafts two players they
// have no room for.
const test = require('node:test');
const assert = require('node:assert');

const { rosterProgress, VIA_CAPTAIN, isVia } = require('../../shared/roster.cjs');
const { captainCandidates } = require('../teams');

const member = (id, name, role, via = 'draft') => ({ id, player_name: name, role, via });

test('captains count against the roster, so remaining is 58 not 60', () => {
  const p = rosterProgress([
    member('a', 'Keraunos', 'DPS', VIA_CAPTAIN),
    member('b', 'Arelite', 'Healer', VIA_CAPTAIN),
  ], 60);

  assert.strictEqual(p.filled, 2);
  assert.strictEqual(p.captains, 2);
  assert.strictEqual(p.drafted, 0);
  assert.strictEqual(p.remaining, 58, 'a captain is one of the sixty, not an extra');
});

test('a full roster has nothing remaining, and an over-full one does not go negative', () => {
  const full = Array.from({ length: 60 }, (_, i) => member(`p${i}`, `P${i}`, 'DPS'));
  assert.strictEqual(rosterProgress(full, 60).remaining, 0);
  assert.strictEqual(rosterProgress([...full, member('x', 'X', 'DPS')], 60).remaining, 0);
});

test('roles are counted, and a signup with no role is not counted as one', () => {
  const p = rosterProgress([
    member('a', 'A', 'Tank', VIA_CAPTAIN),
    member('b', 'B', 'Healer'),
    member('c', 'C', null),
  ], 60);

  assert.strictEqual(p.byRole.find((r) => r.role === 'Tank').have, 1);
  assert.strictEqual(p.byRole.find((r) => r.role === 'Healer').have, 1);
  assert.strictEqual(p.byRole.find((r) => r.role === 'DPS').have, 0);
  assert.strictEqual(p.unanswered, 1);
  assert.strictEqual(p.filled, 3, 'a missing role still occupies a roster spot');
});

test('an empty roster reports the whole thing as remaining', () => {
  const p = rosterProgress([], 60);
  assert.strictEqual(p.filled, 0);
  assert.strictEqual(p.remaining, 60);
});

test('via is constrained to the three the migration allows', () => {
  assert.ok(isVia('captain') && isVia('draft') && isVia('manual'));
  assert.ok(!isVia('') && !isVia('invited') && !isVia(null));
});

test('anyone on any roster is out of the captain candidates', () => {
  const approved = [
    { id: 'a', player_name: 'Arelite', wants_captain: true },
    { id: 'b', player_name: 'Boros', wants_captain: false },
    { id: 'c', player_name: 'Ceren', wants_captain: false },
  ];
  // A drafted player on ANOTHER team — not a captain anywhere, but not
  // available either. Filtering on captain seats alone would still offer them.
  const rostered = new Set(['a', 'c']);

  assert.deepStrictEqual(
    captainCandidates(approved, rostered).map((p) => p.id),
    ['b']
  );
});

test('captainCandidates still accepts a list, not only a Set', () => {
  // The Teams page passes a Set; older callers passed rows with ids. Both have
  // to mean the same thing or the candidate list silently stops filtering.
  const approved = [{ id: 'a', player_name: 'A' }, { id: 'b', player_name: 'B' }];
  assert.deepStrictEqual(
    captainCandidates(approved, [{ id: 'a' }]).map((p) => p.id),
    ['b']
  );
});
