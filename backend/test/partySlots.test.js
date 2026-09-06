// Seating somebody in a party.
//
// The rule under test is the one that makes this builder different from
// Gear-Gap's: a slot type NAMES the roles that may fill it, so a comp is not
// just an arrangement, it is an arrangement that either can be fielded or
// cannot. Every failure here is silent — a Healer sitting in a Tank seat looks
// exactly like a Healer sitting in a Healer seat until the match starts.
const test = require('node:test');
const assert = require('node:assert');

const { slotTypeAt, visibleTeamsFor } = require('../parties');
const { canFill, DEFAULT_PARTY_TEMPLATE, SLOT_NAMES } = require('../../shared/parties.cjs');
const { ROLES } = require('../../shared/roles.cjs');

// ── Who may READ a comp ─────────────────────────────────────────────────────
// A comp is competitive information: knowing which six an opponent put in
// their objective party is worth what knowing their draft board is worth. The
// first version of this route returned every team's to every signed-in user,
// so these are here to stop that coming back.
const TEAMS = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
const CAPTAIN_OF_A = { id: 'a', name: 'A' };

test('A CAPTAIN SEES ONLY THEIR OWN COMP', () => {
  const seen = visibleTeamsFor(TEAMS, CAPTAIN_OF_A, { isOrganizer: false });
  assert.deepStrictEqual(seen.map((x) => x.id), ['a']);
});

test('a player who captains nothing sees no comps at all', () => {
  assert.deepStrictEqual(visibleTeamsFor(TEAMS, null, { isOrganizer: false }), []);
  assert.deepStrictEqual(visibleTeamsFor(TEAMS, undefined, {}), []);
  assert.deepStrictEqual(visibleTeamsFor(TEAMS, null, undefined), []);
});

test('an organizer sees every comp', () => {
  const seen = visibleTeamsFor(TEAMS, null, { isOrganizer: true });
  assert.deepStrictEqual(seen.map((x) => x.id), ['a', 'b', 'c']);
});

test('a captaincy with no id matches NOTHING, not everything', () => {
  // The failure mode this guards: filtering on `x.id === mine?.id` where both
  // are undefined matches every row with no id. Today no team row lacks one;
  // the day a partial row reaches here, the difference is a total leak.
  assert.deepStrictEqual(visibleTeamsFor([{ id: undefined }, { id: 'b' }], {}, {}), []);
  assert.deepStrictEqual(visibleTeamsFor([{ id: undefined }], { id: null }, {}), []);
});

test('slotTypeAt reads the template, not a party count and a size', () => {
  // Party 1 is the objective party: Tank, Tank, Tank / DPS, Tank / DPS, Healer, Healer.
  assert.strictEqual(slotTypeAt(DEFAULT_PARTY_TEMPLATE, 0, 0), 'Tank');
  assert.strictEqual(slotTypeAt(DEFAULT_PARTY_TEMPLATE, 0, 2), 'Tank / DPS');
  assert.strictEqual(slotTypeAt(DEFAULT_PARTY_TEMPLATE, 0, 4), 'Healer');
  // Party 2 became an ordinary Flex in migration 020.
  assert.strictEqual(slotTypeAt(DEFAULT_PARTY_TEMPLATE, 1, 1), 'Any Role');
});

test('a seat outside the template is not a seat', () => {
  // The check that stops a write landing somewhere nothing renders. A party
  // template can be RESIZED under a comp, so "party 9" is not a hypothetical.
  assert.strictEqual(slotTypeAt(DEFAULT_PARTY_TEMPLATE, 8, 0), null, 'party past the end');
  assert.strictEqual(slotTypeAt(DEFAULT_PARTY_TEMPLATE, 0, 6), null, 'seat past the end');
  assert.strictEqual(slotTypeAt(DEFAULT_PARTY_TEMPLATE, -1, 0), null, 'negative party');
  assert.strictEqual(slotTypeAt([], 0, 0), null, 'no template at all');
});

test('every slot type in the default template is one the app knows', () => {
  // A slot type nothing recognises has no eligible roles, so canFill refuses
  // every player and the seat can never be filled by anybody.
  DEFAULT_PARTY_TEMPLATE.forEach((party, pi) => {
    (party.slots || []).forEach((type, si) => {
      assert.ok(SLOT_NAMES.includes(type), `party ${pi + 1} seat ${si + 1} is "${type}"`);
      assert.ok(ROLES.some((r) => canFill(type, r)), `nobody can fill "${type}"`);
    });
  });
});

test('THE RULE: exact seats take one role, flexible seats take their own', () => {
  assert.ok(canFill('Tank', 'Tank'));
  assert.ok(!canFill('Tank', 'DPS'));
  assert.ok(!canFill('Tank', 'Healer'));

  assert.ok(canFill('Tank / DPS', 'Tank'));
  assert.ok(canFill('Tank / DPS', 'DPS'));
  assert.ok(!canFill('Tank / DPS', 'Healer'), 'the flexible seat is not a free seat');

  ROLES.forEach((r) => assert.ok(canFill('Any Role', r), `Any Role rejects ${r}`));
});

test('a slot type nobody knows accepts nobody', () => {
  // 'Support' is the one people reach for — it is what the source spreadsheet
  // calls the healer rows. A template carrying it would leave sixteen seats a
  // captain could never fill, with nothing on screen saying why. verify.sql
  // asserts it never reaches the database; this asserts what would happen.
  ROLES.forEach((r) => assert.ok(!canFill('Support', r), `"Support" accepted a ${r}`));
});

// The server allows a player with NO recorded role into any seat, and that is
// a deliberate exception rather than an oversight — see the note in
// backend/parties.js. Asserted here so it is not "fixed" later.
test('a player with no role is a data gap, not a mismatch', () => {
  const noRole = null;
  SLOT_NAMES.forEach((type) => {
    assert.ok(!canFill(type, noRole), 'canFill itself refuses null');
  });
  // ...so the route cannot lean on canFill for this case, and does not: it
  // checks `role && !canFill(...)`. This is that expression.
  const blocked = (type, role) => Boolean(role) && !canFill(type, role);
  assert.strictEqual(blocked('Tank', null), false, 'unrecorded role is not blocked');
  assert.strictEqual(blocked('Tank', 'Healer'), true);
  assert.strictEqual(blocked('Any Role', 'Healer'), false);
});
