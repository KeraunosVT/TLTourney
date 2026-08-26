// Signup validation. The rule for what earns a test here is Gear-Gap's: cover
// the logic where a mistake produces a PLAUSIBLE WRONG ANSWER rather than an
// error. A gear level that silently becomes 0, a class taken from the request
// body instead of derived, nights stored in whatever order they arrived —
// none of those throw, and all of them are wrong in ways nobody would spot.
const test = require('node:test');
const assert = require('node:assert');
const { validateSignup, NIGHTS, GEAR_MAX } = require('../validateSignup');

const good = () => ({
  player_name: 'Keraunos',
  weapon_1: 'Greatsword',
  weapon_2: 'Dagger',
  gear_level: 5140,
  nights: ['Tue', 'Thu'],
  notes: 'Can flex to healer.',
  wants_captain: false,
});

test('a complete signup passes and derives its class', () => {
  const r = validateSignup(good());
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.strictEqual(r.value.class_name, 'Ravager');
  assert.strictEqual(r.value.gear_level, 5140);
});

test('the class is DERIVED, never taken from the body', () => {
  // Someone posting class_name: 'Paladin' with Greatsword+Dagger must still be
  // stored as a Ravager. This is the field a captain sorts on.
  const r = validateSignup({ ...good(), class_name: 'Paladin' });
  assert.ok(r.ok);
  assert.strictEqual(r.value.class_name, 'Ravager');
});

test('discord_id in the body is ignored — identity comes from the session', () => {
  const r = validateSignup({ ...good(), discord_id: '99999', status: 'approved' });
  assert.ok(r.ok);
  assert.strictEqual(r.value.discord_id, undefined);
  assert.strictEqual(r.value.status, undefined);
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

// ── Weapons ─────────────────────────────────────────────────────────────────
test('two of the same weapon is refused', () => {
  const r = validateSignup({ ...good(), weapon_1: 'Dagger', weapon_2: 'Dagger' });
  assert.ok(!r.ok);
  assert.match(r.errors.weapons, /different/i);
});

test('a weapon that is not in the game is refused', () => {
  assert.ok(!validateSignup({ ...good(), weapon_2: 'Trebuchet' }).ok);
  assert.ok(!validateSignup({ ...good(), weapon_1: '' }).ok);
});

test('weapon order does not change the class', () => {
  const a = validateSignup({ ...good(), weapon_1: 'Greatsword', weapon_2: 'Dagger' });
  const b = validateSignup({ ...good(), weapon_1: 'Dagger', weapon_2: 'Greatsword' });
  assert.strictEqual(a.value.class_name, b.value.class_name);
});

// ── Gear level ──────────────────────────────────────────────────────────────
// The whole point: none of these may quietly become 0.
test('a blank or non-numeric gear level is refused, not coerced to 0', () => {
  for (const bad of ['', '   ', 'abc', null, undefined, {}, NaN]) {
    const r = validateSignup({ ...good(), gear_level: bad });
    assert.ok(!r.ok, `${JSON.stringify(bad)} should be refused`);
    assert.ok(r.errors.gear_level, `${JSON.stringify(bad)} should name the gear field`);
  }
});

test('a numeric string is accepted and becomes a number', () => {
  const r = validateSignup({ ...good(), gear_level: '4820' });
  assert.ok(r.ok);
  assert.strictEqual(r.value.gear_level, 4820);
});

test('fractional and out-of-range gear levels are refused', () => {
  assert.ok(!validateSignup({ ...good(), gear_level: 5140.5 }).ok);
  assert.ok(!validateSignup({ ...good(), gear_level: -1 }).ok);
  assert.ok(!validateSignup({ ...good(), gear_level: GEAR_MAX + 1 }).ok);
  assert.ok(validateSignup({ ...good(), gear_level: 0 }).ok);
  assert.ok(validateSignup({ ...good(), gear_level: GEAR_MAX }).ok);
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
  assert.ok(!validateSignup({ ...good(), nights: 'Tue' }).ok);       // not an array
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

// ── Error shape ─────────────────────────────────────────────────────────────
test('errors are keyed by field so the form can place each message', () => {
  const r = validateSignup({ player_name: '', weapon_1: 'Dagger', weapon_2: 'Dagger', gear_level: 'x', nights: [] });
  assert.ok(!r.ok);
  assert.deepStrictEqual(
    Object.keys(r.errors).sort(),
    ['gear_level', 'nights', 'player_name', 'weapons']
  );
  assert.strictEqual(r.value, undefined, 'no value when invalid');
});
