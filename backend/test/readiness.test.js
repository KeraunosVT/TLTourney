// Can the pool fill the teams? This is the number an organizer acts on — it
// decides when signups close and which role the recruitment drive chases — and
// every way of getting it wrong produces a confident, plausible, wrong figure
// rather than an error.
const test = require('node:test');
const assert = require('node:assert');
const { readiness } = require('../teams');
const { DEFAULT_PARTY_TEMPLATE, roleDemand, startersPerTeam } = require('../../shared/parties.cjs');

const tournament = {
  party_template: DEFAULT_PARTY_TEMPLATE,
  party_count: 8,
  party_size: 6,
  sub_count: 12,
  roster_size: 60,
};

const pool = (spec) => {
  const out = [];
  Object.entries(spec).forEach(([role, n]) => {
    for (let i = 0; i < n; i++) out.push({ role: role === 'none' ? null : role, status: 'approved' });
  });
  return out;
};

test('the template is 8 parties of 6 — 48 starters, 60 with subs', () => {
  assert.strictEqual(DEFAULT_PARTY_TEMPLATE.length, 8);
  assert.strictEqual(startersPerTeam(DEFAULT_PARTY_TEMPLATE), 48);
  assert.strictEqual(48 + tournament.sub_count, tournament.roster_size);
});

test('six teams need 360 roster spots, 288 of them starting', () => {
  const r = readiness(tournament, 6, []);
  assert.strictEqual(r.needed, 360);
  assert.strictEqual(r.starters, 288);
  assert.strictEqual(r.subs, 72);
  assert.strictEqual(r.short, 360);
});

test('role demand is a RANGE, because two slot types take more than one role', () => {
  // The bug this guards: collapsing the flexible slots into one number. Every
  // Tank / DPS and Any Role slot counted as a tank requirement overstates
  // tanks by 48; counting none of them understates the ceiling by the same.
  const d = roleDemand(DEFAULT_PARTY_TEMPLATE, 6);
  assert.deepStrictEqual(d.Tank, { min: 60, max: 108 });
  assert.deepStrictEqual(d.DPS, { min: 84, max: 132 });
  assert.deepStrictEqual(d.Healer, { min: 96, max: 120 });
});

test('compulsory + flexible slots reconcile to the starter count', () => {
  const d = roleDemand(DEFAULT_PARTY_TEMPLATE, 6);
  const compulsory = d.Tank.min + d.DPS.min + d.Healer.min;
  assert.strictEqual(compulsory, 240);
  assert.strictEqual(compulsory + 48, 288, 'the 48 flexible slots are the balance');
});

test('shortfall per role is measured against the FLOOR, not the ceiling', () => {
  // Against the ceiling, a pool could look short of tanks while being able to
  // field every team — and an organizer would chase tanks it does not need.
  const r = readiness(tournament, 6, pool({ Tank: 60, DPS: 84, Healer: 96 }));
  r.roles.forEach((x) => assert.strictEqual(x.short, 0, `${x.role} should not be short`));
});

test('one short of the floor is reported as short by one', () => {
  const r = readiness(tournament, 6, pool({ Tank: 59, DPS: 84, Healer: 96 }));
  assert.strictEqual(r.roles.find((x) => x.role === 'Tank').short, 1);
  assert.strictEqual(r.roles.find((x) => x.role === 'DPS').short, 0);
});

test('surplus never reports as negative shortfall', () => {
  const r = readiness(tournament, 6, pool({ Tank: 500, DPS: 500, Healer: 500 }));
  r.roles.forEach((x) => assert.strictEqual(x.short, 0));
  assert.strictEqual(r.short, 0, 'overall shortfall floors at zero too');
});

test('signups with no role are counted separately, not as a role', () => {
  // Rows filed before migration 002 have a null role. Silently bucketing them
  // into one would inflate that role's supply and hide a real shortage.
  const r = readiness(tournament, 6, pool({ Tank: 10, none: 5 }));
  assert.strictEqual(r.unanswered, 5);
  assert.strictEqual(r.roles.find((x) => x.role === 'Tank').have, 10);
  assert.strictEqual(r.approved, 15, 'they still count toward the roster total');
});

test('zero teams needs nothing and is short of nothing', () => {
  const r = readiness(tournament, 0, pool({ Tank: 3 }));
  assert.strictEqual(r.needed, 0);
  assert.strictEqual(r.short, 0);
  r.roles.forEach((x) => assert.strictEqual(x.min, 0));
});

test('a tournament with no template does not throw', () => {
  const r = readiness({ ...tournament, party_template: null }, 6, pool({ Tank: 3 }));
  assert.strictEqual(r.starters, 0);
  assert.strictEqual(r.needed, 360, 'roster_size still governs the total');
});
