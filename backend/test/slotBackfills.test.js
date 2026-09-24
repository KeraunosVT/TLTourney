// Putting a team back into a slot that an unwind emptied by accident.
//
// The bug this file exists for, in full: a grand final is fed by the winners
// final and the losers final. Undo the losers final — because it was a forfeit
// and needs recording as one — and the undo clears every match downstream of
// it, blanking BOTH slots of the grand final. One of those slots had nothing to
// do with the losers bracket. The winners finalist is simply gone, their match
// still sitting there complete, and no route ever looks at a finished match and
// asks whether the team it advanced actually arrived.
//
// It is quiet, which is the dangerous part. The bracket renders, the undo
// reports success, and what is left is a grand final with one team in it that
// nothing short of a redraw will fix.
//
// So the property under test is not "advancement works" — applyResult has the
// simulations for that. It is that the bracket can be asked, from the rows
// alone, whether it still agrees with its own wiring.
const test = require('node:test');
const assert = require('node:assert');

const { slotBackfills } = require('../../shared/bracket.cjs');

const WINNERS = 'team-hamstars';
const LOSERS = 'team-egirl';
const OUT = 'team-unc';

/** The shape settle() reads: database rows, not engine matches. */
const match = (over = {}) => ({
  key: 'GF1-0', kind: 'match', status: 'pending',
  slot_a: null, slot_b: null,
  team_a_id: null, team_b_id: null,
  winner_team_id: null, loser_team_id: null,
  ...over,
});

const done = (key, winner, loser) => match({
  key, status: 'complete', winner_team_id: winner, loser_team_id: loser,
});

// ── The regression ──────────────────────────────────────────────────────────
test('a grand final emptied by undoing the losers final gets its winners finalist back', () => {
  const rows = [
    done('W2-0', WINNERS, OUT),
    // The losers final, just undone: pending again, nobody advanced out of it.
    match({ key: 'L2-0', status: 'pending', team_a_id: LOSERS, team_b_id: OUT }),
    match({
      key: 'GF1-0',
      slot_a: { type: 'winner', of: 'W2-0' },
      slot_b: { type: 'winner', of: 'L2-0' },
    }),
  ];

  assert.deepStrictEqual(slotBackfills(rows), [
    { key: 'GF1-0', slot: 'a', teamId: WINNERS },
  ], 'the winners finalist belongs in the slot their own match still feeds');
});

test('the slot fed by the undone match is left empty', () => {
  const rows = [
    done('W2-0', WINNERS, OUT),
    match({ key: 'L2-0', status: 'pending' }),
    match({
      key: 'GF1-0',
      slot_a: { type: 'winner', of: 'W2-0' },
      slot_b: { type: 'winner', of: 'L2-0' },
    }),
  ];

  const slots = slotBackfills(rows).map((w) => w.slot);
  assert.ok(!slots.includes('b'),
    'refilling the slot the undo was ABOUT would undo the undo');
});

// ── What it must not touch ──────────────────────────────────────────────────
test('a slot that already has a team is never rewritten', () => {
  const rows = [
    done('W2-0', WINNERS, OUT),
    match({
      key: 'GF1-0',
      slot_a: { type: 'winner', of: 'W2-0' },
      team_a_id: 'someone-else',
    }),
  ];

  assert.deepStrictEqual(slotBackfills(rows), [],
    'an organizer placing a team by hand outranks the wiring');
});

test('nothing is filled from a match that has not finished', () => {
  const rows = [
    match({ key: 'W2-0', status: 'ready' }),
    match({ key: 'GF1-0', slot_a: { type: 'winner', of: 'W2-0' } }),
  ];
  assert.deepStrictEqual(slotBackfills(rows), []);
});

test('a completed match is left alone, and so is a void one', () => {
  const rows = [
    done('W1-0', WINNERS, OUT),
    match({ key: 'done', status: 'complete', slot_a: { type: 'winner', of: 'W1-0' } }),
    match({ key: 'void', kind: 'void', slot_a: { type: 'winner', of: 'W1-0' } }),
  ];
  assert.deepStrictEqual(slotBackfills(rows), []);
});

test('a seed slot is placed at generation, not from a feeder', () => {
  const rows = [match({ key: 'W1-0', slot_a: { type: 'seed', seed: 1 } })];
  assert.deepStrictEqual(slotBackfills(rows), []);
});

test('a slot pointing at a match that is not in the bracket is ignored', () => {
  const rows = [match({ key: 'GF1-0', slot_a: { type: 'winner', of: 'W9-9' } })];
  assert.deepStrictEqual(slotBackfills(rows), []);
});

// ── Losers drop in too ──────────────────────────────────────────────────────
test('a loser slot is filled from the feeder\'s loser', () => {
  const rows = [
    done('W2-0', WINNERS, OUT),
    match({ key: 'L2-0', slot_b: { type: 'loser', of: 'W2-0' } }),
  ];

  assert.deepStrictEqual(slotBackfills(rows), [
    { key: 'L2-0', slot: 'b', teamId: OUT },
  ]);
});

test('a bye has no loser, so the slot it drops into stays empty', () => {
  const rows = [
    // What settle() writes for a walkover: a winner, and loser_team_id null.
    match({ key: 'W1-0', kind: 'walkover', status: 'complete', winner_team_id: WINNERS }),
    match({ key: 'L1-0', slot_a: { type: 'loser', of: 'W1-0' } }),
  ];

  assert.deepStrictEqual(slotBackfills(rows), [],
    'filling this would invent a team that was eliminated by a match nobody played');
});

test('both slots of a match can be restored at once', () => {
  const rows = [
    done('W1-0', WINNERS, OUT),
    done('W1-1', LOSERS, 'team-snoopy'),
    match({
      key: 'W2-0',
      slot_a: { type: 'winner', of: 'W1-0' },
      slot_b: { type: 'winner', of: 'W1-1' },
    }),
  ];

  assert.deepStrictEqual(slotBackfills(rows), [
    { key: 'W2-0', slot: 'a', teamId: WINNERS },
    { key: 'W2-0', slot: 'b', teamId: LOSERS },
  ]);
});
