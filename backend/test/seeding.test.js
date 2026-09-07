// The seeding stage, and the table it produces.
//
// Every failure here is silent in the same way the bracket's are: a round-robin
// that misses a pairing, or a standings sort that is not total, produces a
// tournament that runs to completion and seeds the wrong team first. Nobody
// finds out, because there is nothing to compare it against.
const test = require('node:test');
const assert = require('node:assert');

const {
  generateRoundRobin, roundRobinStandings, generateBracket, applyResult,
  GRAND_FINAL_BEST_OF,
} = require('../../shared/bracket.cjs');

// ── The fixtures ────────────────────────────────────────────────────────────
test('four teams is SIX matches over three rounds', () => {
  // The number in the brief. Everything below generalises, but this is the one
  // the organizers said out loud.
  const g = generateRoundRobin(4);
  assert.strictEqual(g.matches.length, 6);
  assert.strictEqual(g.rounds, 3);
});

test('every pair meets exactly once, at every size', () => {
  for (const n of [2, 3, 4, 5, 6, 8, 9, 12]) {
    const g = generateRoundRobin(n);
    const seen = g.matches.map((m) => [m.a.seed, m.b.seed].sort((x, y) => x - y).join('v'));
    assert.strictEqual(new Set(seen).size, seen.length, `${n}: a pair meets twice`);
    assert.strictEqual(seen.length, (n * (n - 1)) / 2, `${n}: wrong fixture count`);
  }
});

test('NOBODY PLAYS TWICE IN THE SAME ROUND', () => {
  // The property the circle method buys, and the reason it is worth using over
  // two nested loops. Without it a "round" is not a night's play.
  for (const n of [4, 5, 6, 8, 9]) {
    const g = generateRoundRobin(n);
    const byRound = new Map();
    for (const m of g.matches) {
      if (!byRound.has(m.round)) byRound.set(m.round, []);
      byRound.get(m.round).push(m.a.seed, m.b.seed);
    }
    for (const [round, seeds] of byRound) {
      assert.strictEqual(new Set(seeds).size, seeds.length, `${n} teams, round ${round}`);
    }
  }
});

test('an odd count rests one team a round rather than inventing a fixture', () => {
  const g = generateRoundRobin(5);
  assert.strictEqual(g.matches.length, 10);
  // Five rounds of two, not four rounds of two and a half.
  assert.strictEqual(g.rounds, 5);
  g.matches.forEach((m) => {
    assert.ok(m.a.seed >= 1 && m.a.seed <= 5, 'a real team');
    assert.ok(m.b.seed >= 1 && m.b.seed <= 5, 'a real team');
  });
});

test('keys are unique and namespaced away from the bracket', () => {
  const g = generateRoundRobin(6);
  const keys = g.matches.map((m) => m.key);
  assert.strictEqual(new Set(keys).size, keys.length);
  keys.forEach((k) => assert.match(k, /^RR\d+-\d+$/));
  // No collision with a bracket drawn for the same tournament.
  const b = generateBracket(6).matches.map((m) => m.key);
  assert.strictEqual(keys.filter((k) => b.includes(k)).length, 0);
});

test('EVERY FIXTURE CARRIES A KIND', () => {
  // The bug that stopped the seeding stage writing at all, and it was invisible
  // from here: backend/bracket.js maps this field onto `matches.kind`, and
  // supabase-js builds its `columns` parameter from Object.keys() — which
  // includes a key whose value is undefined, while JSON.stringify drops the
  // value. PostgREST was told the payload had a `kind` column, found nothing,
  // and wrote NULL into a not-null column.
  //
  // generateBracket sets this through markByes. A round-robin has no byes and
  // never ran it, so nothing was setting it.
  for (const n of [2, 4, 5, 8]) {
    generateRoundRobin(n).matches.forEach((m) => {
      assert.strictEqual(m.status, 'match', `${n} teams: ${m.key} has no kind`);
    });
  }
});

test('too few teams produces nothing rather than throwing', () => {
  [0, 1, -3, null, undefined, NaN].forEach((n) => {
    const g = generateRoundRobin(n);
    assert.deepStrictEqual(g.matches, [], `${n}`);
  });
});

// ── The table ───────────────────────────────────────────────────────────────
const TEAMS = [{ id: 'A', seed: 1 }, { id: 'B', seed: 2 }, { id: 'C', seed: 3 }, { id: 'D', seed: 4 }];
const m = (key, a, b, w) => ({ key, team_a_id: a, team_b_id: b, winner_team_id: w });
const places = (rows) => rows.map((r) => r.teamId);

test('a clean table sorts by matches won', () => {
  const played = [
    m('RR1-0', 'A', 'D', 'A'), m('RR1-1', 'B', 'C', 'B'),
    m('RR2-0', 'A', 'C', 'A'), m('RR2-1', 'B', 'D', 'B'),
    m('RR3-0', 'A', 'B', 'A'), m('RR3-1', 'C', 'D', 'C'),
  ];
  const table = roundRobinStandings(played, TEAMS);
  assert.deepStrictEqual(places(table), ['A', 'B', 'C', 'D']);
  assert.deepStrictEqual(table.map((r) => r.won), [3, 2, 1, 0]);
  assert.deepStrictEqual(table.map((r) => r.place), [1, 2, 3, 4]);
});

test('HEAD-TO-HEAD breaks a two-way tie', () => {
  // A and B both finish 2-1. B beat A, so B seeds above them — the result they
  // played is a better answer than any aggregate.
  const played = [
    m('RR1-0', 'A', 'D', 'A'), m('RR1-1', 'B', 'C', 'B'),
    m('RR2-0', 'A', 'C', 'A'), m('RR2-1', 'B', 'D', 'D'),
    m('RR3-0', 'A', 'B', 'B'), m('RR3-1', 'C', 'D', 'C'),
  ];
  const table = roundRobinStandings(played, TEAMS);
  assert.strictEqual(table[0].won, 2);
  assert.strictEqual(table[1].won, 2);
  assert.deepStrictEqual(places(table).slice(0, 2), ['B', 'A'], 'B beat A');
});

test('game differential breaks a tie head-to-head cannot', () => {
  // A three-way circle on 1-1 each: head-to-head is 1-1-1 and settles nothing,
  // so the differential across the stage decides.
  const played = [
    m('RR1-0', 'A', 'B', 'A'), m('RR1-1', 'B', 'C', 'B'), m('RR2-0', 'C', 'A', 'C'),
  ];
  const games = {
    'RR1-0': { a: 2, b: 0 },   // A +2
    'RR1-1': { a: 2, b: 1 },   // B +1, C -1
    'RR2-0': { a: 2, b: 1 },   // C +1, A -1
  };
  const table = roundRobinStandings(played, [TEAMS[0], TEAMS[1], TEAMS[2]], games);
  assert.deepStrictEqual(table.map((r) => r.won), [1, 1, 1], 'all level on wins');
  assert.strictEqual(table[0].teamId, 'A', 'A has the best differential (+1)');
});

test('THE SORT IS TOTAL — a perfect circle still produces an order', () => {
  // Three teams beating each other in a ring, no games recorded: wins tie,
  // head-to-head ties, differential ties, games-won ties. Draft seed is the
  // backstop, and without it the seeding would depend on row order out of
  // Postgres — different every time it ran.
  const played = [
    m('RR1-0', 'A', 'B', 'A'), m('RR1-1', 'B', 'C', 'B'), m('RR2-0', 'C', 'A', 'C'),
  ];
  const three = [TEAMS[0], TEAMS[1], TEAMS[2]];
  const first = places(roundRobinStandings(played, three));
  assert.deepStrictEqual(first, ['A', 'B', 'C'], 'falls back to draft seed');

  // And it is STABLE: the same input in a different order gives the same table.
  const shuffled = [played[2], played[0], played[1]];
  assert.deepStrictEqual(places(roundRobinStandings(shuffled, three)), first);
  assert.deepStrictEqual(places(roundRobinStandings(played, [...three].reverse())), first);
});

test('places are always 1..n with no gaps', () => {
  const table = roundRobinStandings([], TEAMS);
  assert.deepStrictEqual(table.map((r) => r.place), [1, 2, 3, 4]);
  // An unplayed stage still seeds — by draft order, which is the honest answer
  // when nothing has been decided.
  assert.deepStrictEqual(places(table), ['A', 'B', 'C', 'D']);
});

test('unfinished and unknown matches are ignored, not half-counted', () => {
  const played = [
    m('RR1-0', 'A', 'B', 'A'),
    { key: 'RR1-1', team_a_id: 'C', team_b_id: 'D', winner_team_id: null },  // not played
    m('RR2-0', 'A', 'ghost', 'A'),                                          // team not in the list
  ];
  const table = roundRobinStandings(played, TEAMS);
  const a = table.find((r) => r.teamId === 'A');
  assert.strictEqual(a.played, 1, 'the ghost match is not counted');
  assert.strictEqual(table.find((r) => r.teamId === 'C').played, 0);
});

// ── The grand final ─────────────────────────────────────────────────────────
test('THE GRAND FINAL IS ONE MATCH, BEST OF FIVE', () => {
  const g = generateBracket(4);
  const gf = g.matches.filter((x) => x.bracket === 'GF');
  assert.strictEqual(gf.length, 1, 'no reset match is generated');
  assert.strictEqual(gf[0].key, 'GF1-0');
  assert.strictEqual(gf[0].bestOf, GRAND_FINAL_BEST_OF);
  assert.strictEqual(GRAND_FINAL_BEST_OF, 5);
});

test('everything before the final keeps the default best-of', () => {
  generateBracket(8).matches
    .filter((x) => x.bracket !== 'GF')
    .forEach((x) => assert.strictEqual(x.bestOf, undefined, `${x.key} overrode best_of`));
});

test('NO RESET: the losers-bracket team winning the final ends it', () => {
  // The bug this guards, and it would have hung the tournament: without a reset
  // match present, a grand final won from the losers bracket used to flag
  // `reset`, which suppresses the champion and advances nobody. The bracket
  // would sit finished-but-not-finished forever.
  const g = generateBracket(4);
  const matches = g.matches.map((x) => ({ ...x, team_a_id: null, team_b_id: null }));
  const gf = matches.find((x) => x.key === 'GF1-0');
  gf.team_a_id = 'WB';   // arrived through the winners bracket
  gf.team_b_id = 'LB';   // arrived through the losers bracket

  const out = applyResult(matches, 'GF1-0', 'LB');
  assert.strictEqual(out.reset, false, 'no reset is triggered');
  assert.strictEqual(out.champion, 'LB', 'the winner is the champion');
  assert.strictEqual(out.eliminated, 'WB');
});

test('a bracket drawn BEFORE 026 still resets', () => {
  // Backward compatibility, from one code path: applyResult resets only when a
  // reset match is actually present, so an in-flight tournament keeps its rules.
  const g = generateBracket(4);
  const matches = g.matches.map((x) => ({ ...x, team_a_id: null, team_b_id: null }));
  matches.push({
    key: 'GF2-0', bracket: 'GF', round: 2, idx: 0,
    a: { type: 'winner', of: 'GF1-0' }, b: { type: 'loser', of: 'GF1-0' }, reset: true,
  });
  const gf = matches.find((x) => x.key === 'GF1-0');
  gf.team_a_id = 'WB';
  gf.team_b_id = 'LB';

  const out = applyResult(matches, 'GF1-0', 'LB');
  assert.strictEqual(out.reset, true);
  assert.strictEqual(out.champion, null, 'not champion yet — the reset decides');
});

test('the winners-bracket team winning ends it either way', () => {
  for (const withReset of [false, true]) {
    const matches = generateBracket(4).matches.map((x) => ({ ...x }));
    if (withReset) {
      matches.push({ key: 'GF2-0', bracket: 'GF', round: 2, idx: 0, reset: true, a: {}, b: {} });
    }
    const gf = matches.find((x) => x.key === 'GF1-0');
    gf.team_a_id = 'WB';
    gf.team_b_id = 'LB';
    const out = applyResult(matches, 'GF1-0', 'WB');
    assert.strictEqual(out.reset, false, `withReset=${withReset}`);
    assert.strictEqual(out.champion, 'WB');
  }
});
