// The rows a draw actually inserts.
//
// Not the engine — shared/bracket.cjs is tested elsewhere and was right both
// times this broke. What breaks is the translation from an engine match to a
// database row, and it breaks the same way twice:
//
//   supabase-js builds PostgREST's `columns` parameter from the UNION of every
//   row's keys. A batch where some rows carry a key and others do not tells
//   PostgREST the payload has that column, finds nothing in the rows missing
//   it, and writes NULL — into a not-null column, so the whole insert fails on
//   a constraint that names the column and says nothing about which row or why.
//
// It happened to `kind` (fixed with a default) and then to `best_of` (omitted
// with a spread, which is the same bug wearing different syntax). This file
// exists so the third one fails here instead of on the night.
const test = require('node:test');
const assert = require('node:assert');

// Requiring the route module boots nothing — it builds routers and exports
// them; server.js is what listens.
const { fromEngine } = require('../bracket');
const {
  generateBracket, generateRoundRobin, GRAND_FINAL_BEST_OF, SEEDING_BEST_OF, DEFAULT_BEST_OF,
} = require('../../shared/bracket.cjs');

const T = '00000000-0000-0000-0000-0000000000aa';
const rowsFor = (g) => g.matches.map((m) => fromEngine(m, T));

// The columns a row must carry to survive a batch insert. Anything not-null in
// the schema without a value in EVERY row is a failed draw.
const REQUIRED = ['tournament_id', 'key', 'bracket', 'round', 'idx', 'kind', 'best_of', 'is_reset'];

test('EVERY GENERATED ROW CARRIES EVERY COLUMN — 4 teams', () => {
  const rows = rowsFor(generateBracket(4));
  assert.ok(rows.length > 0);
  rows.forEach((r) => {
    REQUIRED.forEach((col) => {
      assert.ok(col in r, `${r.key} is missing ${col}`);
      assert.notStrictEqual(r[col], undefined, `${r.key} has undefined ${col}`);
      assert.notStrictEqual(r[col], null, `${r.key} has null ${col}`);
    });
  });
});

test('the key set is IDENTICAL across every row of the batch', () => {
  // The actual mechanism: it is not that a key is missing everywhere, it is
  // that it is present in some rows and absent in others.
  const rows = rowsFor(generateBracket(8));
  const shape = JSON.stringify(Object.keys(rows[0]).sort());
  rows.forEach((r) => {
    assert.strictEqual(JSON.stringify(Object.keys(r).sort()), shape,
      `${r.key} has a different key set from the first row — this is the mixed-key batch`);
  });
});

test('the grand final is best-of-five and everything else best-of-three', () => {
  const rows = rowsFor(generateBracket(8));
  const gf = rows.filter((r) => r.bracket === 'GF');
  assert.ok(gf.length > 0);
  gf.forEach((r) => assert.strictEqual(r.best_of, GRAND_FINAL_BEST_OF));
  rows.filter((r) => r.bracket !== 'GF')
    .forEach((r) => assert.strictEqual(r.best_of, DEFAULT_BEST_OF, `${r.key}`));
});

test('a seeding fixture is a single game, on every row', () => {
  const rows = rowsFor(generateRoundRobin(4));
  assert.strictEqual(rows.length, 6, 'every pair once');
  rows.forEach((r) => {
    assert.strictEqual(r.best_of, SEEDING_BEST_OF);
    assert.strictEqual(r.bracket, 'RR');
  });
});

test('best_of always satisfies the odd-and-in-range constraint', () => {
  // migrations/013: check (best_of >= 1 and best_of <= 9 and best_of % 2 = 1).
  [2, 4, 8, 16].forEach((n) => {
    [...rowsFor(generateBracket(n)), ...rowsFor(generateRoundRobin(n))].forEach((r) => {
      assert.ok(r.best_of >= 1 && r.best_of <= 9 && r.best_of % 2 === 1,
        `${r.key} has best_of ${r.best_of}`);
    });
  });
});

test('kind is never null either — the first row this file was written for', () => {
  [...rowsFor(generateBracket(6)), ...rowsFor(generateRoundRobin(5))].forEach((r) => {
    assert.ok(['match', 'walkover', 'void'].includes(r.kind), `${r.key} kind=${r.kind}`);
  });
});

test('every bracket size a tournament could plausibly draw produces writable rows', () => {
  // The odd sizes are the ones with byes, which is where `kind` came from.
  [2, 3, 4, 5, 6, 7, 8, 12, 16].forEach((n) => {
    const rows = rowsFor(generateBracket(n));
    rows.forEach((r) => REQUIRED.forEach((col) => {
      assert.ok(r[col] !== null && r[col] !== undefined, `${n} teams: ${r.key} ${col}`);
    }));
  });
});
