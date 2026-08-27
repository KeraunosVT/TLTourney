// When the confirmation DM goes out, and what it says.
//
// The condition is the whole feature. Wrong one way, a player is DM'd every
// time they touch their entry; wrong the other, somebody who withdrew and came
// back is never told their signup landed. Neither failure throws — both just
// look like the feature working until somebody complains.
const test = require('node:test');
const assert = require('node:assert');

const { receipt, entersQueue } = require('../signups');

const TOURNAMENT = { name: 'Season 2 Americas Draft Tournament' };

const SIGNUP = {
  player_name: 'Keraunos',
  role: 'DPS',
  classes: ['Ravager', 'Templar'],
  positions: ['Mainball Melee', 'Killsquad'],
  nights: ['Tue', 'Wed'],
  wants_captain: false,
};

test('a brand new signup is DM\'d', () => {
  // No previous row at all — `existing?.status` is undefined.
  assert.strictEqual(entersQueue(undefined, 'pending'), true);
});

test('editing a signup already in the queue is NOT DM\'d again', () => {
  assert.strictEqual(entersQueue('pending', 'pending'), false);
});

test('editing an approved signup is not DM\'d', () => {
  // An edit leaves an approved signup approved — it never re-enters the queue,
  // so there is nothing to confirm.
  assert.strictEqual(entersQueue('approved', 'approved'), false);
});

test('withdrawing and coming back IS DM\'d — it is a fresh submission', () => {
  assert.strictEqual(entersQueue('withdrawn', 'pending'), true);
});

test('re-filing after a rejection IS DM\'d', () => {
  assert.strictEqual(entersQueue('rejected', 'pending'), true);
});

test('the receipt quotes back what was stored', () => {
  const text = receipt(TOURNAMENT, SIGNUP);
  assert.match(text, /Season 2 Americas Draft Tournament/);
  assert.match(text, /Keraunos/);
  assert.match(text, /DPS/);
  assert.match(text, /Ravager · Templar/);
  assert.match(text, /Mainball Melee, Killsquad/);
  assert.match(text, /Tue, Wed/);
});

test('a captain volunteer is told their answer was recorded', () => {
  assert.match(receipt(TOURNAMENT, { ...SIGNUP, wants_captain: true }), /captain/i);
  assert.doesNotMatch(receipt(TOURNAMENT, SIGNUP), /put your name down to captain/);
});

test('empty optional sections are omitted, not printed as blanks', () => {
  const bare = receipt(TOURNAMENT, {
    player_name: 'Arelite', role: 'Healer', classes: ['Templar'],
    positions: [], nights: [], wants_captain: false,
  });
  assert.doesNotMatch(bare, /Positions:/);
  assert.doesNotMatch(bare, /Nights:/);
  assert.match(bare, /Templar/);
});

test('a signup filed before the role question reads honestly, not as blank', () => {
  // Migration 002 backfilled nothing on purpose. A null role must not render as
  // an empty string that looks like an answer the player gave.
  const old = receipt(TOURNAMENT, {
    player_name: 'Arelite', role: null, classes: [], positions: [], nights: [],
  });
  assert.match(old, /no role given/);
  assert.match(old, /none given/);
});
