// What the clock picks when nobody does.
//
// This is the one piece of the draft that runs with nobody watching, and it
// always returns SOMEBODY — there is no failure mode where it errors and
// someone investigates. A wrong auto-pick is a plausible name on a roster and
// an argument three weeks later, which is exactly the shape of bug that earns a
// test here.
const test = require('node:test');
const assert = require('node:assert');

const { autoPick } = require('../../shared/autopick.cjs');
const { DEFAULT_PARTY_TEMPLATE, roleDemand } = require('../../shared/parties.cjs');

// The standard 8x6 template's per-role FLOOR for one team: Tank 10, DPS 14,
// Healer 16. Read from the template rather than typed in, so a template change
// moves these tests with it instead of quietly invalidating them.
const demand = roleDemand(DEFAULT_PARTY_TEMPLATE, 1);
const MIN = { Tank: demand.Tank.min, DPS: demand.DPS.min, Healer: demand.Healer.min };

const fill = (role, n) => Array.from({ length: n }, () => ({ role }));

const p = (id, role, name = id) => ({ id, role, player_name: name });
const entry = (signup_id, tier, rank) => ({ signup_id, tier, rank });

// ── The board comes first ───────────────────────────────────────────────────
test('the top of the board wins — that is what the board is for', () => {
  const pool = [p('a', 'DPS'), p('b', 'Tank'), p('c', 'Healer')];
  const board = [entry('c', 3, 0), entry('b', 1, 0), entry('a', 2, 0)];

  const out = autoPick(board, pool, [], demand);
  assert.strictEqual(out.signupId, 'b');
  assert.match(out.reason, /board/i);
});

test('within a tier, RANK decides — not the order the rows came back in', () => {
  // A captain who ordered their Tier 1 has said something specific. Sorting on
  // tier alone would honour the tier and throw away the ordering inside it,
  // which looks completely correct from the outside.
  const pool = [p('a', 'DPS'), p('b', 'DPS'), p('c', 'DPS')];
  const board = [entry('c', 1, 2), entry('a', 1, 0), entry('b', 1, 1)];

  assert.strictEqual(autoPick(board, pool, [], demand).signupId, 'a');
});

test('a lower tier beats a better rank in a worse one', () => {
  const pool = [p('a', 'DPS'), p('b', 'DPS')];
  const board = [entry('a', 2, 0), entry('b', 1, 9)];
  assert.strictEqual(autoPick(board, pool, [], demand).signupId, 'b');
});

test('THE AVOID PILE IS NEVER PICKED', () => {
  // Tier 6 means "we decided against this player". Handing a captain exactly
  // the person they ruled out is worse than picking a stranger — and a naive
  // sort by tier picks them last, which is to say picks them the moment
  // everything else is gone.
  const pool = [p('a', 'DPS'), p('avoid', 'Tank')];
  const board = [entry('avoid', 6, 0)];

  const out = autoPick(board, pool, [], demand);
  assert.notStrictEqual(out.signupId, 'avoid');
  assert.strictEqual(out.signupId, 'a');
});

test('a board full of players who are already gone falls through, not empty', () => {
  // Late in a draft this is the normal case: the board was ranked before the
  // draft and forty of them have been taken. The caller filters those out, so
  // an empty ranked list must fall through to the next rule rather than
  // returning null and stalling the clock.
  const pool = [p('left', 'Healer')];
  const out = autoPick([], pool, [], demand);
  assert.strictEqual(out.signupId, 'left');
});

// ── Then the roster's needs ─────────────────────────────────────────────────
test('with no board, the role with the BIGGEST shortfall is picked', () => {
  // Tanks and DPS are covered; healers are four short. Picking a tank here is a
  // defensible-LOOKING answer that leaves the roster unable to field a party.
  const roster = [
    ...fill('Tank', MIN.Tank),
    ...fill('DPS', MIN.DPS),
    ...fill('Healer', MIN.Healer - 4),
  ];
  const pool = [p('tank', 'Tank'), p('healer', 'Healer'), p('dps', 'DPS')];

  const out = autoPick([], pool, roster, demand);
  assert.strictEqual(out.signupId, 'healer');
  assert.match(out.reason, /Healer/);
});

test('when the pool has nobody in the needed role, it moves to the next need', () => {
  const roster = fill('Healer', MIN.Healer - 4);   // short of healers, and of everything else
  const pool = [p('tank', 'Tank')];                // but only a tank is available
  const out = autoPick([], pool, roster, demand);
  assert.strictEqual(out.signupId, 'tank');
});

test('a roster row with no role at all counts toward nothing and breaks nothing', () => {
  // Signups filed before the role question existed have no role. They must not
  // be counted as covering a slot, and they must not throw.
  const roster = [{ role: null }, { role: undefined }, { role: 'Wizard' }];
  const pool = [p('t', 'Tank'), p('h', 'Healer')];
  const out = autoPick([], pool, roster, demand);
  assert.strictEqual(out.signupId, 'h', 'Healer has the larger minimum, so the larger shortfall');
});

// ── Then anybody ────────────────────────────────────────────────────────────
test('with every role covered it takes the first of the pool as given', () => {
  const roster = [...fill('Tank', MIN.Tank), ...fill('DPS', MIN.DPS), ...fill('Healer', MIN.Healer)];
  const pool = [p('first', 'DPS'), p('second', 'Tank')];
  const out = autoPick([], pool, roster, demand);
  assert.strictEqual(out.signupId, 'first');
});

test('an empty pool is null — there is genuinely nobody to pick', () => {
  assert.strictEqual(autoPick([], [], [], demand), null);
  assert.strictEqual(autoPick([entry('a', 1, 0)], [], [], demand), null);
});

test('every branch explains itself, because the reason is read out loud', () => {
  // It ends up in the audit log, the pick feed and the captain's DM. A blank
  // one turns "the clock picked for you" into an accusation nobody can answer.
  const pool = [p('a', 'DPS')];
  for (const out of [
    autoPick([entry('a', 1, 0)], pool, [], demand),
    autoPick([], pool, [{ role: 'Tank' }], demand),
    autoPick([], pool, [], {}),
  ]) {
    assert.ok(out.reason && out.reason.length > 8, `weak reason: ${out?.reason}`);
  }
});

test('it never picks somebody who is not in the pool handed to it', () => {
  // The caller filters the pool to available players. If the board could
  // override that, the clock would draft somebody already on another team and
  // the constraint would refuse it — leaving the draft stuck on one pick,
  // forever, at whatever hour it happened.
  const pool = [p('free', 'DPS')];
  const board = [entry('gone', 1, 0), entry('free', 4, 0)];
  assert.strictEqual(autoPick(board, pool, [], demand).signupId, 'free');
});
