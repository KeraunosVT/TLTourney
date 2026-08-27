// Signup validation. The rule for what earns a test here is Gear-Gap's: cover
// the logic where a mistake produces a PLAUSIBLE WRONG ANSWER rather than an
// error. A class that isn't in the game stored as though it were, preference
// order silently reshuffled, a duplicate counted twice in the pool — none of
// those throw, and all of them are wrong in ways nobody would spot.
const test = require('node:test');
const assert = require('node:assert');
const { validateSignup, NIGHTS, MAX_CLASSES } = require('../validateSignup');
const { CLASS_NAMES } = require('../../shared/classes.cjs');
const { ROLES, POSITIONS } = require('../../shared/roles.cjs');

const good = () => ({
  player_name: 'Keraunos',
  classes: ['Ravager'],
  role: 'DPS',
  positions: ['Mainball Melee'],
  nights: ['Tue', 'Thu'],
  notes: 'Can flex to healer.',
  wants_captain: false,
});

test('a complete signup passes', () => {
  const r = validateSignup(good());
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepStrictEqual(r.value.classes, ['Ravager']);
});

test('discord_id and status in the body are ignored', () => {
  const r = validateSignup({ ...good(), discord_id: '99999', status: 'approved' });
  assert.ok(r.ok);
  assert.strictEqual(r.value.discord_id, undefined);
  assert.strictEqual(r.value.status, undefined);
});

test('gear_level is gone — sending one changes nothing', () => {
  const r = validateSignup({ ...good(), gear_level: 5140 });
  assert.ok(r.ok);
  assert.strictEqual(r.value.gear_level, undefined);
});

// ── Name ────────────────────────────────────────────────────────────────────
test('the character name is trimmed, and blank is refused', () => {
  assert.strictEqual(validateSignup({ ...good(), player_name: '  Keraunos  ' }).value.player_name, 'Keraunos');
  assert.ok(validateSignup({ ...good(), player_name: '   ' }).errors.player_name);
  assert.ok(validateSignup({ ...good(), player_name: undefined }).errors.player_name);
});

test('an over-long name is refused rather than silently truncated', () => {
  const r = validateSignup({ ...good(), player_name: 'x'.repeat(33) });
  assert.ok(!r.ok);
  assert.ok(r.errors.player_name);
});

// ── Classes ─────────────────────────────────────────────────────────────────
test('one, two and three classes are all accepted', () => {
  assert.ok(validateSignup({ ...good(), classes: ['Ravager'] }).ok);
  assert.ok(validateSignup({ ...good(), classes: ['Ravager', 'Paladin'] }).ok);
  assert.ok(validateSignup({ ...good(), classes: ['Ravager', 'Paladin', 'Templar'] }).ok);
});

test('a fourth class is refused', () => {
  const r = validateSignup({ ...good(), classes: ['Ravager', 'Paladin', 'Templar', 'Oracle'] });
  assert.ok(!r.ok);
  assert.match(r.errors.classes, /at most 3/i);
});

test('PREFERENCE ORDER IS PRESERVED — the first class is their main', () => {
  // The single most damaging silent bug available here: sorting these would
  // quietly reassign everybody's main class, and every row would still look
  // perfectly valid.
  const picked = ['Templar', 'Archon', 'Ravager'];   // deliberately not alphabetical
  const r = validateSignup({ ...good(), classes: picked });
  assert.ok(r.ok);
  assert.deepStrictEqual(r.value.classes, picked);
});

test('no classes at all is refused', () => {
  assert.ok(!validateSignup({ ...good(), classes: [] }).ok);
  assert.ok(!validateSignup({ ...good(), classes: undefined }).ok);
  assert.ok(!validateSignup({ ...good(), classes: 'Ravager' }).ok);   // not an array
});

test('empty slots are dropped, not rejected — the 2nd and 3rd are optional', () => {
  const r = validateSignup({ ...good(), classes: ['Ravager', '', '  '] });
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepStrictEqual(r.value.classes, ['Ravager']);
});

test('a class that is not in the game is refused, not stored', () => {
  const r = validateSignup({ ...good(), classes: ['Ravager', 'Battlemage'] });
  assert.ok(!r.ok);
  assert.match(r.errors.classes, /Battlemage/);
});

test('a duplicate is reported rather than silently collapsed', () => {
  const r = validateSignup({ ...good(), classes: ['Ravager', 'Ravager'] });
  assert.ok(!r.ok);
  assert.match(r.errors.classes, /twice/i);
});

test('class names are case- and whitespace-sensitive to the real list', () => {
  // "ravager" is not a class; accepting it would put a name in the database
  // that no lookup elsewhere would match.
  assert.ok(!validateSignup({ ...good(), classes: ['ravager'] }).ok);
  assert.ok(validateSignup({ ...good(), classes: ['  Ravager  '] }).ok, 'but padding is trimmed');
});

test('every one of the 45 classes is individually acceptable', () => {
  const rejected = CLASS_NAMES.filter((c) => !validateSignup({ ...good(), classes: [c] }).ok);
  assert.deepStrictEqual(rejected, [], 'these real classes were refused');
  assert.strictEqual(CLASS_NAMES.length, 45);
});

test('MAX_CLASSES and the message agree', () => {
  const tooMany = CLASS_NAMES.slice(0, MAX_CLASSES + 1);
  const r = validateSignup({ ...good(), classes: tooMany });
  assert.ok(!r.ok);
  assert.match(r.errors.classes, new RegExp(String(MAX_CLASSES)));
});

// ── Role ────────────────────────────────────────────────────────────────────
test('each of the three roles is accepted', () => {
  ROLES.forEach((r) => assert.ok(validateSignup({ ...good(), role: r }).ok, r));
  assert.deepStrictEqual(ROLES, ['Tank', 'DPS', 'Healer']);
});

test('a missing or invented role is refused', () => {
  assert.ok(!validateSignup({ ...good(), role: undefined }).ok);
  assert.ok(!validateSignup({ ...good(), role: '' }).ok);
  assert.ok(!validateSignup({ ...good(), role: 'Support' }).ok);
  // Case matters — 'dps' stored where 'DPS' is expected matches no filter.
  assert.ok(!validateSignup({ ...good(), role: 'dps' }).ok);
});

// ── Positions ───────────────────────────────────────────────────────────────
test('one, several, and all four positions are accepted', () => {
  assert.ok(validateSignup({ ...good(), positions: ['Killsquad'] }).ok);
  assert.ok(validateSignup({ ...good(), positions: ['Tank Party', 'Killsquad'] }).ok);
  assert.ok(validateSignup({ ...good(), positions: [...POSITIONS] }).ok);
});

test('POSITIONS COME BACK IN CANONICAL ORDER, not the order they were ticked', () => {
  // Two people who can do the same things must store the same array, or the
  // queue shows the same answer written two different ways and no grouping
  // by position can ever line up.
  const a = validateSignup({ ...good(), positions: ['Killsquad', 'Tank Party'] });
  const b = validateSignup({ ...good(), positions: ['Tank Party', 'Killsquad'] });
  assert.deepStrictEqual(a.value.positions, b.value.positions);
  assert.deepStrictEqual(a.value.positions, ['Tank Party', 'Killsquad']);
});

test('duplicate positions collapse', () => {
  const r = validateSignup({ ...good(), positions: ['Killsquad', 'Killsquad'] });
  assert.deepStrictEqual(r.value.positions, ['Killsquad']);
});

test('no positions is refused, and an invented one is refused', () => {
  assert.ok(!validateSignup({ ...good(), positions: [] }).ok);
  assert.ok(!validateSignup({ ...good(), positions: undefined }).ok);
  assert.ok(!validateSignup({ ...good(), positions: 'Killsquad' }).ok);   // not an array
  assert.ok(!validateSignup({ ...good(), positions: ['Backline'] }).ok);
});

test('every position name is individually acceptable', () => {
  POSITIONS.forEach((p) => assert.ok(validateSignup({ ...good(), positions: [p] }).ok, p));
  assert.deepStrictEqual(POSITIONS, ['Tank Party', 'Mainball Melee', 'Mainball Ranged', 'Killsquad']);
});

// ── Nights ──────────────────────────────────────────────────────────────────
test('nights come back in week order however they were sent', () => {
  const r = validateSignup({ ...good(), nights: ['Sun', 'Tue', 'Fri'] });
  assert.deepStrictEqual(r.value.nights, ['Tue', 'Fri', 'Sun']);
});

test('duplicate nights collapse', () => {
  const r = validateSignup({ ...good(), nights: ['Tue', 'Tue', 'Tue'] });
  assert.deepStrictEqual(r.value.nights, ['Tue']);
});

test('no nights at all is refused, and a made-up night is refused', () => {
  assert.ok(!validateSignup({ ...good(), nights: [] }).ok);
  assert.ok(!validateSignup({ ...good(), nights: 'Tue' }).ok);
  assert.ok(!validateSignup({ ...good(), nights: ['Funday'] }).ok);
});

test('every night name is individually acceptable', () => {
  NIGHTS.forEach((n) => assert.ok(validateSignup({ ...good(), nights: [n] }).ok, n));
});

// ── Notes and captaincy ─────────────────────────────────────────────────────
test('empty notes become null rather than an empty string', () => {
  assert.strictEqual(validateSignup({ ...good(), notes: '   ' }).value.notes, null);
  assert.strictEqual(validateSignup({ ...good(), notes: undefined }).value.notes, null);
});

test('over-long notes are refused', () => {
  assert.ok(!validateSignup({ ...good(), notes: 'x'.repeat(501) }).ok);
});

test('wants_captain accepts a real boolean and the string a form sends', () => {
  assert.strictEqual(validateSignup({ ...good(), wants_captain: true }).value.wants_captain, true);
  assert.strictEqual(validateSignup({ ...good(), wants_captain: 'true' }).value.wants_captain, true);
  assert.strictEqual(validateSignup({ ...good(), wants_captain: 'no' }).value.wants_captain, false);
  assert.strictEqual(validateSignup({ ...good(), wants_captain: undefined }).value.wants_captain, false);
});

test('wants_shotcall is stored the same way, and is its own answer', () => {
  assert.strictEqual(validateSignup({ ...good(), wants_shotcall: true }).value.wants_shotcall, true);
  assert.strictEqual(validateSignup({ ...good(), wants_shotcall: 'true' }).value.wants_shotcall, true);
  assert.strictEqual(validateSignup({ ...good(), wants_shotcall: 'no' }).value.wants_shotcall, false);
});

test('captaining and shotcalling are independent answers', () => {
  // They read like the same question and are not: a shotcaller runs the fight,
  // a captain runs the draft. Someone glad to do one and not the other must be
  // able to say so, and a copy-paste that wires both to one field would look
  // fine until exactly that person filled the form in.
  const v = validateSignup({ ...good(), wants_captain: false, wants_shotcall: true }).value;
  assert.strictEqual(v.wants_captain, false);
  assert.strictEqual(v.wants_shotcall, true);

  const w = validateSignup({ ...good(), wants_captain: true, wants_shotcall: false }).value;
  assert.strictEqual(w.wants_captain, true);
  assert.strictEqual(w.wants_shotcall, false);
});

test('a missing shotcall answer is stored as false, never as null', () => {
  // The column is nullable ONLY so rows predating the question can say "never
  // asked". Anything coming through the form has seen the box, so an absent
  // value is a real no — writing null here would resurrect the ambiguity that
  // migration 009 exists to contain.
  const v = validateSignup({ ...good(), wants_shotcall: undefined }).value;
  assert.strictEqual(v.wants_shotcall, false);
  assert.notStrictEqual(v.wants_shotcall, null);
});

// ── Error shape ─────────────────────────────────────────────────────────────
test('errors are keyed by field so the form can place each message', () => {
  const r = validateSignup({ player_name: '', classes: [], role: '', positions: [], nights: [] });
  assert.ok(!r.ok);
  assert.deepStrictEqual(
    Object.keys(r.errors).sort(),
    ['classes', 'nights', 'player_name', 'positions', 'role']
  );
  assert.strictEqual(r.value, undefined, 'no value when invalid');
});
