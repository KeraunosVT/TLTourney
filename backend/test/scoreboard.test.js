// Scoreboards: matching rows to people, and people to numbers.
//
// Every failure mode here is a plausible wrong answer rather than an error. A
// row attributed to the wrong player produces a profile that looks completely
// normal; a double-counted scoreboard produces totals that are simply twice as
// good as they should be. Nothing throws, nothing is red, and the only person
// who finds out is the one who knows what they actually did that night.
const test = require('node:test');
const assert = require('node:assert');

const {
  normalizeName, linkRows, linkSummary, playerProfile, leaderboard, rank, isSort,
} = require('../../shared/scoreboard.cjs');

const roster = [
  { id: 'p1', player_name: 'Keraunos', team_id: 'A' },
  { id: 'p2', player_name: 'xSouless', team_id: 'A' },
  { id: 'p3', player_name: 'Blond凶', team_id: 'B' },
  { id: 'p4', player_name: 'z e r o', team_id: 'B' },
];

const row = (player_name, over = {}) => ({
  player_name, rank: 1, weapon_1: 'Staff', weapon_2: 'Wand',
  kills: 0, assists: 0, damage_dealt: 0, damage_taken: 0, healing: 0, ...over,
});

// ── Names ───────────────────────────────────────────────────────────────────
test('case and padding are noise, and are ignored', () => {
  assert.strictEqual(normalizeName('  Keraunos  '), 'keraunos');
  assert.strictEqual(normalizeName('KERAUNOS'), normalizeName('keraunos'));
});

test('NON-LATIN CHARACTERS ARE KEPT, not stripped', () => {
  // The pool really contains Blond凶, メMomo and 龍𝓛𝓤𝓒𝓗𝓞. Stripping "non-standard"
  // characters to make matching easier would collapse distinct players into one
  // another — and a WRONG match is worse than a missed one, because a missed
  // one is visible in the review and a wrong one never is.
  assert.notStrictEqual(normalizeName('Blond凶'), normalizeName('Blond'));
  assert.notStrictEqual(normalizeName('メMomo'), normalizeName('Momo'));
  assert.strictEqual(normalizeName('Blond凶'), 'blond凶');
});

test('internal spacing is collapsed but not removed', () => {
  // OCR reads "z e r o" with inconsistent gaps. It must still match itself, and
  // must NOT become "zero", which could be somebody else entirely.
  assert.strictEqual(normalizeName('z  e r  o'), 'z e r o');
  assert.notStrictEqual(normalizeName('z e r o'), normalizeName('zero'));
});

test('an empty or missing name normalises to empty rather than throwing', () => {
  assert.strictEqual(normalizeName(null), '');
  assert.strictEqual(normalizeName(undefined), '');
});

// ── Linking ─────────────────────────────────────────────────────────────────
test('a name on the roster is matched to that person and their team', () => {
  const [r] = linkRows([row('Keraunos')], roster);
  assert.strictEqual(r.signup_id, 'p1');
  assert.strictEqual(r.team_id, 'A');
  assert.strictEqual(r.match_note, 'matched');
});

test('matching survives the casing and spacing a screenshot introduces', () => {
  assert.strictEqual(linkRows([row('  KERAUNOS ')], roster)[0].signup_id, 'p1');
  assert.strictEqual(linkRows([row('z  e r o')], roster)[0].signup_id, 'p4');
  assert.strictEqual(linkRows([row('Blond凶')], roster)[0].signup_id, 'p3');
});

test('somebody who is not on either roster is left unmatched, not guessed', () => {
  const [r] = linkRows([row('SomeRandomEnemy')], roster);
  assert.strictEqual(r.signup_id, null);
  assert.strictEqual(r.team_id, null);
  assert.strictEqual(r.match_note, 'unmatched');
});

test('TWO PLAYERS WITH THE SAME NAME ARE LEFT FOR A HUMAN', () => {
  // Migration 001 deliberately allows duplicate in-game names — two people
  // really can pick the same one. Guessing between them would attribute a whole
  // night to the wrong person, with nothing on screen to show a choice was made.
  const twins = [...roster, { id: 'p5', player_name: 'Keraunos', team_id: 'B' }];
  const [r] = linkRows([row('Keraunos')], twins);
  assert.strictEqual(r.signup_id, null, 'must not pick one of them');
  assert.strictEqual(r.match_note, 'ambiguous');
});

test('an empty roster leaves everything unmatched rather than failing', () => {
  const linked = linkRows([row('Keraunos'), row('xSouless')], []);
  assert.strictEqual(linked.length, 2);
  assert.ok(linked.every((r) => r.signup_id === null));
});

test('linking never drops or reorders rows', () => {
  // The review table shows these in scoreboard order, and the organizer is
  // reading down it against the screenshot.
  const rows = [row('Keraunos'), row('Nobody'), row('xSouless')];
  const linked = linkRows(rows, roster);
  assert.deepStrictEqual(linked.map((r) => r.player_name), ['Keraunos', 'Nobody', 'xSouless']);
});

test('the summary counts each outcome exactly once', () => {
  const twins = [...roster, { id: 'p5', player_name: 'Keraunos', team_id: 'B' }];
  const s = linkSummary(linkRows([row('Keraunos'), row('xSouless'), row('Stranger')], twins));
  assert.deepStrictEqual(s, { total: 3, matched: 1, unmatched: 1, ambiguous: 1 });
  assert.strictEqual(s.matched + s.unmatched + s.ambiguous, s.total);
});

// ── One player's profile ────────────────────────────────────────────────────
const match = (id, over = {}) => ({ id, key: `W1-${id}`, bracket: 'W', round: 1, scheduled_at: null, ...over });

const stat = (over = {}) => ({
  match: match('m1'), rank: 3, weapon_1: 'Staff', weapon_2: 'Wand',
  kills: 5, assists: 10, damage_dealt: 1000, damage_taken: 500, healing: 0, ...over,
});

test('totals and averages are the sums and means of the rows', () => {
  const p = playerProfile([
    stat({ match: match('m1'), kills: 4, damage_dealt: 1000 }),
    stat({ match: match('m2'), kills: 6, damage_dealt: 3000 }),
  ]);
  assert.strictEqual(p.matches, 2);
  assert.strictEqual(p.kills, 10);
  assert.strictEqual(p.damage_dealt, 4000);
  assert.strictEqual(p.avg_kills, 5);
  assert.strictEqual(p.avg_damage, 2000);
});

test('A PLAYER WITH NO MATCHES GETS ZEROES, NOT NaN', () => {
  // 0/0 is NaN, NaN renders as "NaN" and sorts unpredictably against numbers —
  // so one player who has not played yet can scramble a whole leaderboard.
  const p = playerProfile([]);
  assert.strictEqual(p.matches, 0);
  assert.strictEqual(p.avg_damage, 0);
  Object.values(p).forEach((v) => assert.ok(!Number.isNaN(v), 'no NaN anywhere'));
});

test('BIGINT COLUMNS THAT ARRIVE AS STRINGS STILL ADD UP', () => {
  // PostgREST can return bigint as a string. '1000' + '2000' is '10002000',
  // which is not an error, is off by three orders of magnitude, and looks like
  // a very good night.
  const p = playerProfile([
    stat({ match: match('m1'), damage_dealt: '1000', healing: '250' }),
    stat({ match: match('m2'), damage_dealt: '2000', healing: '750' }),
  ]);
  assert.strictEqual(p.damage_dealt, 3000);
  assert.strictEqual(p.healing, 1000);
});

test('missing and unreadable numbers count as zero rather than poisoning the total', () => {
  const p = playerProfile([
    stat({ match: match('m1'), kills: null, damage_dealt: undefined, healing: 'n/a' }),
    stat({ match: match('m2'), kills: 3, damage_dealt: 100, healing: 50 }),
  ]);
  assert.strictEqual(p.kills, 3);
  assert.strictEqual(p.damage_dealt, 100);
  assert.strictEqual(p.healing, 50);
});

test('a row whose match has been deleted is counted, not crashed on', () => {
  // The embed is a left join, so a deleted match arrives as null rather than
  // the row being absent. Reading .key off it 500'd an entire profile in
  // Gear-Gap over one orphaned row.
  const p = playerProfile([stat({ match: null }), stat({ match: match('m2'), kills: 2 })]);
  assert.strictEqual(p.matches, 1);
  assert.strictEqual(p.orphaned, 1);
  assert.strictEqual(p.kills, 2);
});

test('history is newest first, and undated matches sort last rather than first', () => {
  // `new Date(null)` is the epoch, so an undated match sorted DESCENDING would
  // land at the bottom — but a null date compared naively lands at the top.
  const p = playerProfile([
    stat({ match: match('m1', { scheduled_at: '2026-01-01T00:00:00Z' }) }),
    stat({ match: match('m2', { scheduled_at: null }), created_at: null }),
    stat({ match: match('m3', { scheduled_at: '2026-03-01T00:00:00Z' }) }),
  ]);
  assert.deepStrictEqual(p.history.map((h) => h.match_id), ['m3', 'm1', 'm2']);
});

test('the class breakdown counts weapon pairs, commonest first', () => {
  const p = playerProfile([
    stat({ match: match('m1'), weapon_1: 'Staff', weapon_2: 'Wand' }),
    stat({ match: match('m2'), weapon_1: 'Staff', weapon_2: 'Wand' }),
    stat({ match: match('m3'), weapon_1: 'Greatsword', weapon_2: 'Dagger' }),
  ]);
  assert.strictEqual(p.classes.length, 2);
  assert.strictEqual(p.classes[0].count, 2);
  assert.ok(p.classes[0].count >= p.classes[1].count);
});

// ── The leaderboard ─────────────────────────────────────────────────────────
const people = new Map([
  ['p1', { player_name: 'Keraunos', team_id: 'A', role: 'Healer' }],
  ['p2', { player_name: 'xSouless', team_id: 'A', role: 'DPS' }],
]);

const lrow = (signup_id, over = {}) => ({
  signup_id, weapon_1: 'Staff', weapon_2: 'Wand',
  kills: 1, assists: 1, damage_dealt: 100, damage_taken: 50, healing: 10, ...over,
});

test('each player appears once, with their rows summed', () => {
  const board = leaderboard([
    lrow('p1', { damage_dealt: 100 }),
    lrow('p1', { damage_dealt: 300 }),
    lrow('p2', { damage_dealt: 50 }),
  ], people);

  assert.strictEqual(board.length, 2);
  const k = board.find((e) => e.signup_id === 'p1');
  assert.strictEqual(k.matches, 2);
  assert.strictEqual(k.damage_dealt, 400);
  assert.strictEqual(k.avg_damage, 200);
  assert.strictEqual(k.player_name, 'Keraunos');
});

test('UNMATCHED ROWS ARE DROPPED, not pooled into a phantom player', () => {
  // Bucketing them would put a leaderboard line with the summed damage of forty
  // strangers above every real player, and it would not be a fact about anybody.
  const board = leaderboard([
    lrow(null, { damage_dealt: 999999 }),
    lrow(null, { damage_dealt: 999999 }),
    lrow('p1'),
  ], people);
  assert.strictEqual(board.length, 1);
  assert.strictEqual(board[0].signup_id, 'p1');
});

test('the main class is the one played MOST, not the one played last', () => {
  const board = leaderboard([
    lrow('p1', { weapon_1: 'Staff', weapon_2: 'Wand' }),
    lrow('p1', { weapon_1: 'Staff', weapon_2: 'Wand' }),
    lrow('p1', { weapon_1: 'Greatsword', weapon_2: 'Dagger' }),
  ], people);
  const staffWand = leaderboard([lrow('p1', { weapon_1: 'Staff', weapon_2: 'Wand' })], people)[0].main_class;
  assert.strictEqual(board[0].main_class, staffWand);
});

test('a player the map does not know still appears, under the name on the scoreboard', () => {
  // Their signup could have been deleted after the match. Losing the row would
  // make the totals disagree with the match pages for no visible reason.
  const board = leaderboard([lrow('p9', { player_name: 'Ghost' })], people);
  assert.strictEqual(board.length, 1);
  assert.strictEqual(board[0].player_name, 'Ghost');
});

test('ranking sorts by the chosen column, descending, with a stable tiebreak', () => {
  const entries = [
    { player_name: 'Bravo', damage_dealt: 100, healing: 900 },
    { player_name: 'Alpha', damage_dealt: 300, healing: 100 },
    { player_name: 'Delta', damage_dealt: 100, healing: 500 },
  ];
  assert.deepStrictEqual(rank(entries, 'damage_dealt').map((e) => e.player_name), ['Alpha', 'Bravo', 'Delta']);
  assert.deepStrictEqual(rank(entries, 'healing').map((e) => e.player_name), ['Bravo', 'Delta', 'Alpha']);
});

test('an unknown sort column falls back rather than returning an unsorted list', () => {
  // The column arrives from a query string.
  assert.ok(!isSort('; drop table'));
  assert.ok(!isSort('__proto__'), 'and does not resolve through the prototype');
  const entries = [{ player_name: 'A', damage_dealt: 1 }, { player_name: 'B', damage_dealt: 2 }];
  assert.deepStrictEqual(rank(entries, 'nonsense').map((e) => e.player_name), ['B', 'A']);
});

test('ranking does not mutate what it was given', () => {
  const entries = [{ player_name: 'B', damage_dealt: 1 }, { player_name: 'A', damage_dealt: 2 }];
  const before = entries.map((e) => e.player_name);
  rank(entries, 'damage_dealt');
  assert.deepStrictEqual(entries.map((e) => e.player_name), before);
});
