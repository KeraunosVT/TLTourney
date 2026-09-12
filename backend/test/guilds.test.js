// Guild names: one guild, however the scoreboard spelled it.
//
// The failure this file exists for is not a crash. One guild read three ways
// (MILK°, MILK, MILK*) appears three times in a list, each a third of its real
// size, and every one of those numbers looks like a small guild that turned up.
// Nothing is red, nothing throws, and the only person who can tell is somebody
// who already knows how many players that guild brought.
const test = require('node:test');
const assert = require('node:assert');

const {
  normalizeGuild, guildKey, aliasMap, canonicalGuild, guildTally,
} = require('../../shared/guilds.cjs');

const aliases = aliasMap([
  { alias: 'MILK°', canonical: 'MILK' },
  { alias: 'MILK*', canonical: 'MILK' },
]);

const grow = (guild_name, over = {}) => ({
  guild_name, player_name: 'somebody', signup_id: null, team_id: null,
  kills: 0, assists: 0, damage_dealt: 0, damage_taken: 0, healing: 0, ...over,
});

// ── The name ────────────────────────────────────────────────────────────────
test('case and padding are noise; glyphs are not', () => {
  assert.strictEqual(normalizeGuild('  MILK°  '), 'MILK°');
  assert.strictEqual(guildKey('MILK°'), guildKey('milk°'));
  assert.notStrictEqual(guildKey('MILK°'), guildKey('MILK'), 'the degree sign is part of the name');
});

test('GUILD NAMES KEEP THEIR NON-LATIN CHARACTERS', () => {
  // JAILEDシ, Lotus花粉, ABG Garden っ and Big Chillinツ are real guilds on
  // these boards. Stripping "non-standard" characters to make matching easier
  // would fold different guilds together, and a wrong merge is invisible.
  assert.strictEqual(normalizeGuild('JAILEDシ'), 'JAILEDシ');
  assert.notStrictEqual(guildKey('Lotus花粉'), guildKey('Lotus'));
  assert.notStrictEqual(guildKey('Unhinged死'), guildKey('Unhinged'));
});

test('internal spacing is collapsed but never removed', () => {
  assert.strictEqual(normalizeGuild('ABG  Garden  っ'), 'ABG Garden っ');
  assert.notStrictEqual(guildKey('Supple On 3'), guildKey('SuppleOn3'));
});

// ── Resolving ───────────────────────────────────────────────────────────────
test('THE THREE MILK SPELLINGS RESOLVE TO ONE GUILD', () => {
  assert.strictEqual(canonicalGuild('MILK°', aliases), 'MILK');
  assert.strictEqual(canonicalGuild('MILK*', aliases), 'MILK');
  assert.strictEqual(canonicalGuild('MILK', aliases), 'MILK');
});

test('an alias matches however the read cased or padded it', () => {
  assert.strictEqual(canonicalGuild(' milk° ', aliases), 'MILK');
  assert.strictEqual(canonicalGuild('Milk*', aliases), 'MILK');
});

test('a guild nobody has aliased is returned as itself, not dropped', () => {
  // The common case by far. An alias list is a short list of corrections, not
  // a registry every guild has to be entered into first.
  assert.strictEqual(canonicalGuild('JAILEDシ', aliases), 'JAILEDシ');
  assert.strictEqual(canonicalGuild('  Gear Gap ', aliases), 'Gear Gap');
});

test('NO GUILD IS NULL, NOT "Unknown"', () => {
  // Bucketing unread rows under a word invents a guild out of a failure to
  // read one — and on these boards it would place mid-table.
  assert.strictEqual(canonicalGuild(null, aliases), null);
  assert.strictEqual(canonicalGuild('', aliases), null);
  assert.strictEqual(canonicalGuild('   ', aliases), null);
});

test('resolving works with no alias list at all', () => {
  // The state of every database until 032 is applied, and of this one if that
  // read fails. Guild names must still resolve to themselves.
  assert.strictEqual(canonicalGuild('MILK°', null), 'MILK°');
  assert.strictEqual(canonicalGuild('MILK°', new Map()), 'MILK°');
  assert.strictEqual(canonicalGuild('', null), null);
});

test('a self-alias is dropped rather than stored as a pointless hop', () => {
  const m = aliasMap([{ alias: 'MILK', canonical: 'milk' }, { alias: 'x', canonical: '' }]);
  assert.strictEqual(m.size, 0);
});

test('CHAINS ARE NOT FOLLOWED — one hop, deliberately', () => {
  // A -> B -> C resolves to B. Following chains means a loop check on every
  // lookup, or a lookup that can hang, for a case that is somebody having
  // entered one guild twice. Migration 032 has the query that finds these.
  const chain = aliasMap([
    { alias: 'A', canonical: 'B' },
    { alias: 'B', canonical: 'C' },
  ]);
  assert.strictEqual(canonicalGuild('A', chain), 'B');
});

// ── The tally ───────────────────────────────────────────────────────────────
test('the spellings collapse into one row with one total', () => {
  const { guilds } = guildTally([
    grow('MILK°', { signup_id: 'p1', kills: 4 }),
    grow('MILK', { signup_id: 'p2', kills: 6 }),
    grow('MILK*', { signup_id: 'p3', kills: 1 }),
  ], aliases);

  assert.strictEqual(guilds.length, 1);
  assert.strictEqual(guilds[0].name, 'MILK');
  assert.strictEqual(guilds[0].players, 3);
  assert.strictEqual(guilds[0].kills, 11);
});

test('THE SPELLINGS THAT FED A GUILD ARE KEPT, so an alias can be checked', () => {
  // The one thing that makes a merge auditable after the fact: a guild whose
  // spellings list holds three entries is either three aliases doing their job
  // or one wrong claim, and either way it is on screen rather than inferred.
  const { guilds } = guildTally([
    grow('MILK°', { signup_id: 'p1' }),
    grow('MILK*', { signup_id: 'p2' }),
    grow('MILK', { signup_id: 'p3' }),
  ], aliases);
  assert.deepStrictEqual(guilds[0].spellings, ['MILK', 'MILK*', 'MILK°']);
});

test('PLAYERS AND ROWS ARE DIFFERENT NUMBERS', () => {
  // A best-of-three puts one player on three rows. Counting rows would say
  // this guild fielded three people when it fielded one.
  const { guilds } = guildTally([
    grow('Gear Gap', { signup_id: 'p1', kills: 3 }),
    grow('Gear Gap', { signup_id: 'p1', kills: 4 }),
    grow('Gear Gap', { signup_id: 'p1', kills: 5 }),
  ], aliases);
  assert.strictEqual(guilds[0].players, 1);
  assert.strictEqual(guilds[0].rows, 3);
  assert.strictEqual(guilds[0].kills, 12);
});

test('an unmatched row still counts as somebody, by name', () => {
  // It is an opponent or a misread, and it carried a guild that really was on
  // the screenshot. Counting it as nobody would undercount every guild that
  // did not sign up for this tournament.
  const { guilds } = guildTally([
    grow('Ermmmm', { signup_id: null, player_name: 'Stranger' }),
    grow('Ermmmm', { signup_id: null, player_name: 'Another' }),
    grow('Ermmmm', { signup_id: null, player_name: 'Stranger' }),
  ], aliases);
  assert.strictEqual(guilds[0].players, 2, 'two people, one of them on two rows');
  assert.strictEqual(guilds[0].rows, 3);
});

test('rows with no guild are COUNTED, not listed as a guild', () => {
  const { guilds, noGuild } = guildTally([
    grow(null, { signup_id: 'p1' }),
    grow('', { signup_id: 'p2' }),
    grow('MILK', { signup_id: 'p3' }),
  ], aliases);
  assert.strictEqual(noGuild, 2);
  assert.strictEqual(guilds.length, 1);
  assert.ok(!guilds.some((g) => g.name === 'Unknown' || g.name === ''));
});

// ── Guildless ───────────────────────────────────────────────────────────────
// Counted the same way a guild is, so it can be drawn as a bar beside them —
// but returned OUTSIDE the list, because it is not one.
test('the guildless are tallied like a guild: people, teams and totals', () => {
  const { guildless } = guildTally([
    grow(null, { signup_id: 'p1', team_id: 'A', kills: 3 }),
    grow(null, { signup_id: 'p1', team_id: 'A', kills: 4 }),   // same player, game 2
    grow('', { signup_id: 'p2', team_id: 'B', kills: 5 }),
  ], aliases);

  assert.strictEqual(guildless.name, 'Guildless');
  assert.strictEqual(guildless.rows, 3);
  assert.strictEqual(guildless.players, 2, 'people, not rows — as everywhere else');
  assert.deepStrictEqual(guildless.byTeam, { A: 1, B: 1 });
  assert.strictEqual(guildless.kills, 12);
});

test('GUILDLESS IS NEVER ONE OF THE GUILDS', () => {
  // A caller ranking guilds by size must not be able to hand back "Guildless"
  // as the fourth biggest, however many rows it holds.
  const { guilds, guildless } = guildTally([
    grow(null, { signup_id: 'p1' }), grow(null, { signup_id: 'p2' }),
    grow(null, { signup_id: 'p3' }), grow('MILK', { signup_id: 'p4' }),
  ], aliases);
  assert.deepStrictEqual(guilds.map((g) => g.name), ['MILK']);
  assert.strictEqual(guildless.players, 3, 'bigger than the only real guild, and still not in it');
});

test('a board where everybody named a guild has no guildless entry at all', () => {
  // Null rather than a zeroed row, so a page leaves the bar off instead of
  // drawing an empty one labelled Guildless.
  const { guildless, noGuild } = guildTally([grow('MILK', { signup_id: 'p1' })], aliases);
  assert.strictEqual(guildless, null);
  assert.strictEqual(noGuild, 0);
});

test('the guildless carry no spellings, because there was nothing to read', () => {
  const { guildless } = guildTally([grow(null, { signup_id: 'p1' }), grow('   ', { signup_id: 'p2' })], aliases);
  assert.deepStrictEqual(guildless.spellings, []);
});

test('noGuild still reports the row count it always did', () => {
  const { guildless, noGuild } = guildTally([
    grow(null, { signup_id: 'p1' }), grow(null, { signup_id: 'p1' }),
  ], aliases);
  assert.strictEqual(noGuild, 2, 'rows');
  assert.strictEqual(guildless.players, 1, 'one person on both of them');
  assert.strictEqual(noGuild, guildless.rows);
});

test('THE SPLIT BY TEAM COUNTS PEOPLE, NOT ROWS', () => {
  // These sit beside `players` and have to be the same kind of number. Counting
  // rows agreed with it exactly while every team had played once, then a second
  // round of scoreboards made every segment twice its bar.
  const { guilds } = guildTally([
    grow('MILK', { signup_id: 'p1', team_id: 'A' }),
    grow('MILK', { signup_id: 'p1', team_id: 'A' }),  // same player, game 2
    grow('MILK', { signup_id: 'p2', team_id: 'A' }),
  ], aliases);
  assert.strictEqual(guilds[0].rows, 3);
  assert.strictEqual(guilds[0].players, 2);
  assert.deepStrictEqual(guilds[0].byTeam, { A: 2 }, 'two people, not three rows');
});

test('a player traded mid-season counts for both teams, and is flagged', () => {
  // Their old scoreboard rows keep the team they played for at the time, which
  // is right — so the per-team counts can add up to more than `players`, and a
  // stacked bar built from them would run past its own bar without this.
  const { guilds } = guildTally([
    grow('MILK', { signup_id: 'p1', team_id: 'A' }),
    grow('MILK', { signup_id: 'p1', team_id: 'B' }),
  ], aliases);
  assert.strictEqual(guilds[0].players, 1);
  assert.deepStrictEqual(guilds[0].byTeam, { A: 1, B: 1 });
  assert.strictEqual(guilds[0].playedForTwo, 1);
});

test('nobody is flagged as having played for two teams when they have not', () => {
  const { guilds } = guildTally([
    grow('MILK', { signup_id: 'p1', team_id: 'A' }),
    grow('MILK', { signup_id: 'p2', team_id: 'B' }),
  ], aliases);
  assert.strictEqual(guilds[0].playedForTwo, 0);
});

test('the split by team counts only rows that have a side', () => {
  const { guilds } = guildTally([
    grow('MILK°', { signup_id: 'p1', team_id: 'A' }),
    grow('MILK', { signup_id: 'p2', team_id: 'A' }),
    grow('MILK*', { signup_id: 'p3', team_id: 'B' }),
    grow('MILK', { signup_id: 'p4', team_id: null }),
  ], aliases);
  assert.deepStrictEqual(guilds[0].byTeam, { A: 2, B: 1 });
  assert.strictEqual(guilds[0].players, 4, 'the row with no side still counts as a player');
});

test('biggest first, and a tie breaks on something stable', () => {
  const { guilds } = guildTally([
    grow('Small', { signup_id: 'p1' }),
    grow('Big', { signup_id: 'p2' }),
    grow('Big', { signup_id: 'p3' }),
    grow('Also', { signup_id: 'p4' }),
  ], aliases);
  assert.strictEqual(guilds[0].name, 'Big');
  assert.deepStrictEqual(guilds.slice(1).map((g) => g.name), ['Also', 'Small'], 'ties sort by name');
});

test('BIGINT DAMAGE ARRIVING AS A STRING STILL ADDS UP', () => {
  const { guilds } = guildTally([
    grow('MILK', { signup_id: 'p1', damage_dealt: '1000000' }),
    grow('MILK°', { signup_id: 'p2', damage_dealt: '2000000' }),
  ], aliases);
  assert.strictEqual(guilds[0].damage_dealt, 3000000);
});

test('missing numbers count as zero rather than poisoning a guild', () => {
  const { guilds } = guildTally([
    grow('MILK', { signup_id: 'p1', kills: null, healing: 'n/a' }),
    grow('MILK', { signup_id: 'p2', kills: 3, healing: 50 }),
  ], aliases);
  assert.strictEqual(guilds[0].kills, 3);
  assert.strictEqual(guilds[0].healing, 50);
  Object.values(guilds[0]).forEach((v) => assert.ok(!Number.isNaN(v), 'no NaN anywhere'));
});

test('an empty board is an empty tally, not a crash', () => {
  const empty = { guilds: [], guildless: null, noGuild: 0, conflicts: [] };
  assert.deepStrictEqual(guildTally([], aliases), empty);
  assert.deepStrictEqual(guildTally(null, null), empty);
});

// ── The data arguing with itself ────────────────────────────────────────────
// A player is on one scoreboard per game. If two of their games name two
// guilds, that is a misread rather than a transfer — and it is the strongest
// evidence there is that two spellings are one guild, because it comes from the
// data disagreeing with itself instead of from somebody eyeballing a list.
test('A PLAYER WHOSE ROWS NAME TWO GUILDS IS FLAGGED', () => {
  const { conflicts } = guildTally([
    grow('MILK', { signup_id: 'p1', player_name: 'xSp00n' }),
    grow('MILK&deg;', { signup_id: 'p1', player_name: 'xSp00n' }),
  ], aliases);

  assert.strictEqual(conflicts.length, 1);
  assert.strictEqual(conflicts[0].player_name, 'xSp00n');
  assert.deepStrictEqual(conflicts[0].guilds, ['MILK', 'MILK&deg;']);
  assert.deepStrictEqual(conflicts[0].spellings, ['MILK', 'MILK&deg;'],
    'the raw spellings, which is what an alias row needs');
});

test('A PAIR THE ALIAS TABLE ALREADY FOLDS IS NOT A CONFLICT', () => {
  // The point of checking after aliasing: an alias doing its job leaves one
  // name, so what remains flagged is only the aliases nobody has written yet.
  const { conflicts } = guildTally([
    grow('MILK°', { signup_id: 'p1', player_name: 'xSp00n' }),
    grow('MILK*', { signup_id: 'p1', player_name: 'xSp00n' }),
  ], aliases);
  assert.deepStrictEqual(conflicts, []);
});

test('two different people in two different guilds are not a conflict', () => {
  const { conflicts } = guildTally([
    grow('MILK', { signup_id: 'p1' }),
    grow('Gear Gap', { signup_id: 'p2' }),
  ], aliases);
  assert.deepStrictEqual(conflicts, []);
});

test('a row with no guild does not argue with the rows that have one', () => {
  // Nothing to disagree with — an unread guild is an absence, not a claim.
  const { conflicts, noGuild } = guildTally([
    grow('MILK', { signup_id: 'p1' }),
    grow(null, { signup_id: 'p1' }),
  ], aliases);
  assert.strictEqual(noGuild, 1);
  assert.deepStrictEqual(conflicts, []);
});

test('the same guild across many games is never a conflict', () => {
  const { conflicts } = guildTally([
    grow('Gear Gap', { signup_id: 'p1' }),
    grow('Gear Gap', { signup_id: 'p1' }),
    grow('  gear gap ', { signup_id: 'p1' }),
  ], aliases);
  assert.deepStrictEqual(conflicts, [], 'casing and padding are not a disagreement');
});

// ── The case this was all for ───────────────────────────────────────────────
test('THE REAL BOARDS: MILK goes from three small guilds to one of sixteen', () => {
  // The counts as committed: MILK° 11, MILK 4, MILK* 1. Apart they are three
  // forgettable entries; together they are sixth on the board.
  const rows = [
    ...Array.from({ length: 11 }, (_, i) => grow('MILK°', { signup_id: `a${i}` })),
    ...Array.from({ length: 4 }, (_, i) => grow('MILK', { signup_id: `b${i}` })),
    ...Array.from({ length: 1 }, (_, i) => grow('MILK*', { signup_id: `c${i}` })),
  ];

  assert.strictEqual(guildTally(rows, new Map()).guilds.length, 3, 'without aliases: three guilds');

  const { guilds } = guildTally(rows, aliases);
  assert.strictEqual(guilds.length, 1);
  assert.strictEqual(guilds[0].players, 16);
  assert.deepStrictEqual(guilds[0].spellings, ['MILK', 'MILK*', 'MILK°']);
});
