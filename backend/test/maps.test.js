// The map pool and the bans.
//
// Eleven maps and two to four bans per match, so seven to nine survive into a
// best of three. Every failure here is arithmetic that looks right: a count
// that disagrees with the list under it, or a picker offering a banned map.
const test = require('node:test');
const assert = require('node:assert');

const {
  MAPS, isMap, available, isPlayable,
  banList, banProblem, MIN_BANS_PER_MATCH, MAX_BANS_PER_MATCH,
} = require('../../shared/maps.cjs');

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

test('TWO BANS LEAVE NINE, FOUR LEAVE SEVEN', () => {
  const two = available(['Leviathan', 'Talus']);
  assert.strictEqual(two.length, MAPS.length - MIN_BANS_PER_MATCH);
  assert.ok(!two.includes('Leviathan'));
  assert.ok(!two.includes('Talus'));

  const four = available(['Leviathan', 'Talus', 'Daigon', 'Morokai']);
  assert.strictEqual(four.length, MAPS.length - MAX_BANS_PER_MATCH);

  // The ceiling has to leave a best of three room to be played. If the pool
  // ever shrinks, this is the check that says the ban count has to shrink too.
  assert.ok(MAPS.length - MAX_BANS_PER_MATCH >= 3);
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

// ── The lists, and what is wrong with them ──────────────────────────────────
test('banList takes what arrives and returns a clean list', () => {
  assert.deepStrictEqual(banList(['Talus', 'Daigon']), ['Talus', 'Daigon']);
  assert.deepStrictEqual(banList(null), []);
  assert.deepStrictEqual(banList([]), []);
  // A lone string, from a caller written against the one-ban-each shape.
  assert.deepStrictEqual(banList('Talus'), ['Talus']);
  // Blanks are how an empty select arrives, and would otherwise count as a ban.
  assert.deepStrictEqual(banList(['Talus', '', null, '  ']), ['Talus']);
  assert.deepStrictEqual(banList([' Talus ']), ['Talus']);
});

test('banList dedupes WITHIN a side — the database cannot', () => {
  // The CHECK catches the same map on both sides, but not twice on one. If this
  // let it through, a side would spend two of the match's four bans on one map.
  assert.deepStrictEqual(banList(['Talus', 'Talus']), ['Talus']);
  assert.strictEqual(banProblem(['Talus', 'Talus'], ['Daigon', 'Morokai']), null);
  assert.strictEqual(available([...banList(['Talus', 'Talus']), 'Daigon']).length, 9);
});

test('banProblem: the ceiling is four ACROSS the match, not per side', () => {
  assert.strictEqual(banProblem(['Talus', 'Daigon'], ['Morokai', 'Adentus']), null);
  // Three and one is a legal split, not a rounding error.
  assert.strictEqual(banProblem(['Talus', 'Daigon', 'Morokai'], ['Adentus']), null);
  // One each is what a match half way through its bans looks like. Saving that
  // has to work, or bans could only ever be entered all at once.
  assert.strictEqual(banProblem(['Talus'], []), null);
  assert.strictEqual(banProblem([], []), null);

  const over = banProblem(['Talus', 'Daigon', 'Morokai'], ['Adentus', 'Ahzreil']);
  assert.match(over, /at most 4/);
});

test('banProblem: both sides banning one map is refused, and named', () => {
  const both = banProblem(['Talus', 'Daigon'], ['Talus']);
  assert.match(both, /Talus/);
  assert.match(both, /Both teams/);
});

test('banProblem reports a made-up map BEFORE the count', () => {
  // Five bans where the fifth is a typo: "that is not a map" is the useful
  // sentence, and "that is five bans" sends somebody deleting a real one.
  const p = banProblem(['Talus', 'Daigon', 'Morokai'], ['Adentus', 'Tallus']);
  assert.match(p, /Tallus/);
  assert.ok(!/at most/.test(p), p);
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
