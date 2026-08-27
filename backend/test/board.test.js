// The pre-draft board's arithmetic and its one piece of list surgery.
//
// Both are places where a mistake produces a PLAUSIBLE wrong answer rather than
// a crash: a coverage figure that counts the Avoid pile reads as a healthy
// board, and a reorder that silently no-ops at the ends reads as a stuck row.
const test = require('node:test');
const assert = require('node:assert');

const {
  TIERS, RANKED_TIERS, isTier, tierMeta, coverage, moveWithin,
} = require('../../shared/board.cjs');
const { roleDemand } = require('../../shared/parties.cjs');
const { DEFAULT_PARTY_TEMPLATE } = require('../../shared/parties.cjs');

// One team's floor from the real template, so these numbers are the ones the
// page shows rather than invented ones.
const DEMAND = roleDemand(DEFAULT_PARTY_TEMPLATE, 1);

test('tiers are 1..5 plus exactly one Avoid bucket', () => {
  assert.deepStrictEqual(TIERS.map((t) => t.tier), [1, 2, 3, 4, 5, 6]);
  assert.deepStrictEqual(TIERS.filter((t) => t.exclude).map((t) => t.tier), [6]);
  assert.deepStrictEqual(RANKED_TIERS, [1, 2, 3, 4, 5]);
});

test('a tier arriving as a string is not a tier', () => {
  assert.ok(isTier(1) && isTier(6));
  assert.ok(!isTier(0) && !isTier(7));
  assert.ok(!isTier('3'), 'request bodies carry strings; a string must be refused');
  assert.ok(!isTier(2.5) && !isTier(null) && !isTier(undefined));
});

test('the Avoid pile is counted separately, never as coverage', () => {
  const entries = [
    { tier: 1, role: 'Healer' },
    { tier: 3, role: 'Healer' },
    // Ranked Avoid — the whole point is that this does NOT help.
    { tier: 6, role: 'Healer' },
    { tier: 6, role: 'Tank' },
  ];

  const c = coverage(entries, DEMAND);
  assert.strictEqual(c.ranked, 2);
  assert.strictEqual(c.avoided, 2);

  const healer = c.roles.find((r) => r.role === 'Healer');
  assert.strictEqual(healer.have, 2, 'the Avoid healer must not be counted');
  assert.strictEqual(healer.min, 16, '8 parties x 2 healer slots');
  assert.strictEqual(healer.short, 14);
});

test('a signup with no role answer is counted in neither role', () => {
  // Signups filed before migration 002 have no role, and inventing one for
  // them would put a wrong number under a heading a captain acts on.
  const c = coverage([{ tier: 1, role: null }, { tier: 1, role: 'Tank' }], DEMAND);
  assert.strictEqual(c.ranked, 2);
  assert.strictEqual(c.roles.find((r) => r.role === 'Tank').have, 1);
  assert.strictEqual(c.roles.reduce((n, r) => n + r.have, 0), 1);
});

test('shortfall never goes negative once a role is over-covered', () => {
  const tanks = Array.from({ length: 40 }, () => ({ tier: 2, role: 'Tank' }));
  const c = coverage(tanks, DEMAND);
  const tank = c.roles.find((r) => r.role === 'Tank');
  assert.ok(tank.have > tank.min);
  assert.strictEqual(tank.short, 0);
});

test('an empty board is short by exactly the floor', () => {
  const c = coverage([], DEMAND);
  assert.strictEqual(c.ranked, 0);
  c.roles.forEach((r) => assert.strictEqual(r.short, r.min));
});

test('tierMeta finds the Avoid bucket and refuses to invent one', () => {
  assert.strictEqual(tierMeta(6).exclude, true);
  assert.strictEqual(tierMeta(1).exclude, undefined);
  assert.strictEqual(tierMeta(99), null);
});

test('moveWithin swaps neighbours and leaves everything else alone', () => {
  const ids = ['a', 'b', 'c', 'd'];
  assert.deepStrictEqual(moveWithin(ids, 'c', -1), ['a', 'c', 'b', 'd']);
  assert.deepStrictEqual(moveWithin(ids, 'b', 1), ['a', 'c', 'b', 'd']);
  assert.deepStrictEqual(ids, ['a', 'b', 'c', 'd'], 'the input must not be mutated');
});

test('moving off either end returns null, not a copy', () => {
  const ids = ['a', 'b', 'c'];
  // null rather than the unchanged list, so the caller skips the write instead
  // of comparing arrays to discover nothing happened.
  assert.strictEqual(moveWithin(ids, 'a', -1), null);
  assert.strictEqual(moveWithin(ids, 'c', 1), null);
  assert.strictEqual(moveWithin(ids, 'nobody', -1), null);
});
