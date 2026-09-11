// Trades: moving a player from one roster to another.
//
// Every rule here exists because breaking it produces a roster that looks
// entirely normal. A player moved off a team that no longer has them, a captain
// quietly playing for somebody else, the same person sent twice and arriving
// once — none of these throw, none of them are visible on a roster page, and
// all of them are only findable by somebody who remembers what the trade was
// supposed to be.
const test = require('node:test');
const assert = require('node:assert');

const { validateTrade, rosterSizes, describeTrade } = require('../../shared/trades.cjs');

const HAM = { id: 'ham', name: 'The Hamstars' };
const UNC = { id: 'unc', name: "Unc' Graveyard" };
const SNPY = { id: 'snpy', name: 'Team Snoopy' };

const player = (id, name, via = 'draft') => ({ id, player_name: name, via, playing: true });

// Two rosters: a captain and two drafted players each.
const rosters = () => new Map([
  ['ham', [player('h1', 'HamCap', 'captain'), player('h2', 'Keraunos'), player('h3', 'xSouless', 'manual')]],
  ['unc', [player('u1', 'UncCap', 'captain'), player('u2', 'Blond凶'), player('u3', 'z e r o')]],
]);

const move = (signup_id, from, to) => ({ signup_id, from_team_id: from, to_team_id: to });

// ── The trade that works ────────────────────────────────────────────────────
test('a straight one-for-one is accepted, with both names filled in from the roster', () => {
  const r = validateTrade(
    [move('h2', 'ham', 'unc'), move('u2', 'unc', 'ham')],
    rosters(), [HAM, UNC]
  );

  assert.ok(r.ok, r.errors.join(' / '));
  assert.strictEqual(r.moves.length, 2);
  assert.strictEqual(r.moves[0].player_name, 'Keraunos');
  assert.strictEqual(r.moves[0].to_team, "Unc' Graveyard");
  assert.strictEqual(r.moves[1].player_name, 'Blond凶');
});

test('NAMES COME FROM THE ROSTER, NEVER FROM THE REQUEST', () => {
  // The name goes into a permanent record. A name in a request body is a claim
  // by whoever sent it, and the one place it must not be trusted is the one
  // that outlives the roster row.
  const r = validateTrade(
    [{ ...move('h2', 'ham', 'unc'), player_name: 'Somebody Else' }],
    rosters(), [HAM, UNC]
  );
  assert.strictEqual(r.moves[0].player_name, 'Keraunos');
});

test('a drafted player can be traded, and the record says they were drafted', () => {
  // The whole reason this feature exists: teams.js cannot remove them at all,
  // because reconcile() would write the roster row straight back.
  const r = validateTrade([move('h2', 'ham', 'unc')], rosters(), [HAM, UNC]);
  assert.ok(r.ok);
  assert.strictEqual(r.moves[0].via, 'draft');
  assert.strictEqual(r.moves[0].was_drafted, true);
});

test('a manual add trades the same way a drafted player does', () => {
  const r = validateTrade([move('h3', 'ham', 'unc')], rosters(), [HAM, UNC]);
  assert.ok(r.ok);
  assert.strictEqual(r.moves[0].was_drafted, false);
});

// ── The refusals ────────────────────────────────────────────────────────────
test('A CAPTAIN CANNOT BE TRADED', () => {
  // They are on that roster BECAUSE they captain it (migration 008). Moving the
  // row would leave team_captains pointing at somebody who plays for the other
  // team — and the captain seat is what decides who may draft, who may edit the
  // comp, and whose Discord account is trusted for that team.
  const r = validateTrade([move('h1', 'ham', 'unc')], rosters(), [HAM, UNC]);
  assert.ok(!r.ok);
  assert.match(r.errors[0], /captains/i);
  assert.match(r.errors[0], /remove the captain seat/i);
  assert.strictEqual(r.moves.length, 0, 'and nothing is passed through to be written');
});

test('a player who is not on the team they are being traded FROM is refused', () => {
  // The rosters were read a minute ago and the trade is being made now. In
  // between, another organizer can have moved them.
  const r = validateTrade([move('u2', 'ham', 'unc')], rosters(), [HAM, UNC]);
  assert.ok(!r.ok);
  assert.match(r.errors[0], /not on The Hamstars/);
  assert.match(r.errors[0], /may have changed/);
});

test('a player sent twice is refused rather than moved twice', () => {
  const r = validateTrade(
    [move('h2', 'ham', 'unc'), move('h2', 'ham', 'unc')],
    rosters(), [HAM, UNC]
  );
  assert.ok(!r.ok);
  assert.match(r.errors.join(' '), /twice/);
});

test('a trade with nobody in it is refused', () => {
  assert.ok(!validateTrade([], rosters(), [HAM, UNC]).ok);
  assert.ok(!validateTrade(null, rosters(), [HAM, UNC]).ok);
  assert.match(validateTrade([], rosters(), [HAM, UNC]).errors[0], /at least one/i);
});

test('a team cannot trade with itself', () => {
  const r = validateTrade([move('h2', 'ham', 'ham')], rosters(), [HAM, HAM]);
  assert.ok(!r.ok);
  assert.match(r.errors.join(' '), /itself/);
});

test('A THIRD TEAM CANNOT BE DRAGGED IN', () => {
  // Moving somebody to a team that is not in this trade changes a roster
  // nobody filling in this form is looking at.
  const r = validateTrade([move('h2', 'ham', 'snpy')], rosters(), [HAM, UNC]);
  assert.ok(!r.ok);
  assert.match(r.errors.join(' '), /both teams/i);
});

test('a move missing a player or a team is refused, not skipped', () => {
  const r = validateTrade(
    [{ from_team_id: 'ham', to_team_id: 'unc' }, move('h2', 'ham', null)],
    rosters(), [HAM, UNC]
  );
  assert.ok(!r.ok);
  assert.strictEqual(r.errors.length, 2, 'both, not the first');
});

test('EVERY PROBLEM IS REPORTED, not just the first', () => {
  // A trade is built as a whole — several players across two rosters — and one
  // refusal per attempt is one round trip through the form per mistake.
  const r = validateTrade(
    [move('h1', 'ham', 'unc'), move('u1', 'unc', 'ham'), move('u2', 'ham', 'unc')],
    rosters(), [HAM, UNC]
  );
  assert.ok(!r.ok);
  assert.strictEqual(r.errors.length, 3);
});

test('two bad moves are located separately, so the right one can be fixed', () => {
  const r = validateTrade([move('x1', 'ham', 'unc'), move('x2', 'ham', 'unc')], rosters(), [HAM, UNC]);
  assert.ok(!r.ok);
  assert.strictEqual(r.errors.length, 2);
  assert.match(r.errors[0], /^Move 1:/);
  assert.match(r.errors[1], /^Move 2:/);
});

test('one problem stated twice is said once', () => {
  // The duplicate check runs per occurrence, so a player sent twice would
  // otherwise produce the identical sentence twice and read as two faults.
  const r = validateTrade(
    [move('h2', 'ham', 'unc'), move('h2', 'ham', 'unc')],
    rosters(), [HAM, UNC]
  );
  assert.deepStrictEqual(r.errors, ['Keraunos is in this trade twice.']);
});

// ── What it does to the rosters ─────────────────────────────────────────────
test('an even trade leaves both rosters the size they were', () => {
  const r = validateTrade(
    [move('h2', 'ham', 'unc'), move('u2', 'unc', 'ham')],
    rosters(), [HAM, UNC]
  );
  const ham = r.sizes.find((s) => s.team_id === 'ham');
  assert.deepStrictEqual(
    { before: ham.before, after: ham.after, out: ham.out, in: ham.in },
    { before: 3, after: 3, out: 1, in: 1 }
  );
});

test('A LOPSIDED TRADE IS ALLOWED, and says what it costs', () => {
  // Two-for-nothing is a real thing organizers do — covering a no-show, undoing
  // a draft that went wrong. teams.js already declines to enforce roster_size
  // on a manual add for the same reason. The sizes are returned so the
  // consequence is on screen BEFORE the button, not on the bracket afterwards.
  const r = validateTrade(
    [move('h2', 'ham', 'unc'), move('h3', 'ham', 'unc')],
    rosters(), [HAM, UNC]
  );
  assert.ok(r.ok);
  assert.strictEqual(r.sizes.find((s) => s.team_id === 'ham').after, 1);
  assert.strictEqual(r.sizes.find((s) => s.team_id === 'unc').after, 5);
});

test('sizes count everybody on the roster, captains included', () => {
  const sizes = rosterSizes([HAM, UNC], rosters(), []);
  assert.strictEqual(sizes.find((s) => s.team_id === 'ham').before, 3);
  assert.strictEqual(sizes.find((s) => s.team_id === 'ham').after, 3);
});

test('a team with no roster at all is a size, not a crash', () => {
  const sizes = rosterSizes([HAM, SNPY], new Map(), []);
  assert.strictEqual(sizes.find((s) => s.team_id === 'snpy').before, 0);
});

// ── Saying what happened ────────────────────────────────────────────────────
test('the summary says which way each player went', () => {
  const { moves } = validateTrade(
    [move('h2', 'ham', 'unc'), move('u2', 'unc', 'ham')],
    rosters(), [HAM, UNC]
  );
  const line = describeTrade(moves);
  assert.match(line, /Keraunos The Hamstars → Unc' Graveyard/);
  assert.match(line, /Blond凶 Unc' Graveyard → The Hamstars/);
});

test('players going the same way are named together, not one line each', () => {
  const { moves } = validateTrade(
    [move('h2', 'ham', 'unc'), move('h3', 'ham', 'unc')],
    rosters(), [HAM, UNC]
  );
  const line = describeTrade(moves);
  assert.match(line, /Keraunos, xSouless The Hamstars → Unc' Graveyard/);
  assert.strictEqual(line.split(';').length, 1);
});

test('a summary of nothing says so rather than reading as an empty trade', () => {
  assert.strictEqual(describeTrade([]), 'nothing moved');
  assert.strictEqual(describeTrade(null), 'nothing moved');
});
