// The map pool and the bans.
//
// Eleven maps, one ban per team, nine left for a best of three. Every failure
// here is arithmetic that looks right: a count that disagrees with the list
// under it, or a picker offering a map that has been banned.
const test = require('node:test');
const assert = require('node:assert');

const { MAPS, isMap, available, isPlayable, BANS_PER_MATCH } = require('../../shared/maps.cjs');

test('the pool is the eleven maps, with no duplicates', () => {
  assert.strictEqual(MAPS.length, 11);
  assert.strictEqual(new Set(MAPS).size, 11);
  ['Leviathan', 'Pakilo Naru', 'Manticus', 'Daigon', 'Adentus', 'Ahzreil',
    'Grand Aelon', 'Morokai', 'Chernobog', 'Kowazan', 'Talus']
    .forEach((m) => assert.ok(isMap(m), `${m} missing`));
});

test('map names are exact — a near miss is not a map', () => {
  // These arrive from a request body and from a dropdown that could go stale.
  assert.ok(!isMap('leviathan'), 'case matters');
  assert.ok(!isMap('Grand Aelon '), 'the API trims before it checks');
  assert.ok(!isMap('Pakilo'), 'a prefix is not a map');
  assert.ok(!isMap(''));
  assert.ok(!isMap(null));
});

test('TWO BANS LEAVE NINE', () => {
  const left = available(['Leviathan', 'Talus']);
  assert.strictEqual(left.length, MAPS.length - BANS_PER_MATCH);
  assert.ok(!left.includes('Leviathan'));
  assert.ok(!left.includes('Talus'));
});

test('no bans leaves the whole pool', () => {
  assert.deepStrictEqual(available([]), MAPS);
  assert.deepStrictEqual(available([null, undefined]), MAPS);
});

test('a ban that is not a real map removes nothing', () => {
  // The count on screen is drawn from this list. If a junk ban removed a slot
  // without removing a name, the header would say ten above eleven rows.
  const left = available(['NotAMap', 'Talus']);
  assert.strictEqual(left.length, 10);
  assert.ok(!left.includes('Talus'));
});

test('the same map banned twice still only removes one', () => {
  // The API and the database both refuse this, but the arithmetic must not
  // depend on them having caught it.
  assert.strictEqual(available(['Talus', 'Talus']).length, 10);
});

test('available preserves the pool order rather than sorting it', () => {
  const left = available(['Daigon']);
  assert.deepStrictEqual(left, MAPS.filter((m) => m !== 'Daigon'));
});

test('a banned map is not playable, and neither is a made-up one', () => {
  assert.ok(isPlayable('Morokai', ['Talus', 'Daigon']));
  assert.ok(!isPlayable('Talus', ['Talus', 'Daigon']));
  assert.ok(!isPlayable('Somewhere Else', []));
});

test('available and isPlayable never disagree', () => {
  // The picker is built from one and the server validates with the other. If
  // they drifted, a legal pick would be refused on save, which is the most
  // confusing possible outcome.
  const bans = ['Ahzreil', 'Kowazan'];
  const left = available(bans);
  MAPS.forEach((m) => {
    assert.strictEqual(left.includes(m), isPlayable(m, bans), m);
  });
});
