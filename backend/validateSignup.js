// backend/validateSignup.js — turn a request body into a row, or into errors.
//
// Pulled out of the route so it can be tested: server.js calls app.listen() at
// require time, which makes anything defined in it unreachable from a test.
// This is also the part where a mistake produces a PLAUSIBLE WRONG ANSWER
// rather than an error — a gear level that silently becomes 0, a class derived
// from weapons the caller made up — which is Gear-Gap's rule for what earns a
// test.
//
// Two things are deliberately NOT taken from the body:
//   · discord_id  — comes from the session. A signup filed as someone else is
//                   the whole reason this app has a login.
//   · class_name  — derived here from the weapons. The browser shows a class
//                   while you pick; that is a convenience, not an input.

const { WEAPONS, classify, isWeapon } = require('../shared/classes.cjs');

const NIGHTS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const NAME_MAX = 32;      // matches the CHECK constraint in migration 001
const NOTES_MAX = 500;    // ditto
const GEAR_MIN = 0;
const GEAR_MAX = 20000;   // generous on purpose — gear inflates every patch

/**
 * @param {object} body   The raw request body.
 * @returns {{ok: boolean, errors: object, value?: object}}
 *   `errors` is keyed by field so the form can put each message under the
 *   input it belongs to, rather than dropping one string at the top.
 */
function validateSignup(body = {}) {
  const errors = {};

  // ── Character name ────────────────────────────────────────────────────────
  const player_name = String(body.player_name ?? '').trim();
  if (!player_name) {
    errors.player_name = 'Enter your in-game character name.';
  } else if (player_name.length > NAME_MAX) {
    errors.player_name = `That's longer than ${NAME_MAX} characters — use the name exactly as it appears in game.`;
  }

  // ── Weapons ───────────────────────────────────────────────────────────────
  const weapon_1 = String(body.weapon_1 ?? '').trim();
  const weapon_2 = String(body.weapon_2 ?? '').trim();
  let class_name = null;

  if (!isWeapon(weapon_1) || !isWeapon(weapon_2)) {
    errors.weapons = `Pick two weapons from: ${WEAPONS.join(', ')}.`;
  } else if (weapon_1 === weapon_2) {
    errors.weapons = 'Pick two different weapons — every class in the game is a pair.';
  } else {
    class_name = classify(weapon_1, weapon_2);
    // All 45 pairs of 10 weapons resolve, so reaching here means the table and
    // the weapon list have fallen out of step with each other. Say so plainly
    // rather than writing a null class into the row.
    if (!class_name) {
      errors.weapons = `No class is recorded for ${weapon_1} + ${weapon_2}.`;
    }
  }

  // ── Gear level ────────────────────────────────────────────────────────────
  // Rejected rather than coerced. `Number('')` is 0 and `parseInt('abc')` is
  // NaN→0 in the obvious implementation, and a silent 0 puts the player at the
  // bottom of every captain's board without anyone being told why.
  //
  // The empty check is on the TRIMMED string, not the raw value. `'   '` trims
  // to `''`, and `Number('')` is 0 — so testing the raw value lets a field
  // containing only spaces through as a gear level of zero.
  const rawGear = body.gear_level;
  const trimmedGear = typeof rawGear === 'number' ? rawGear : String(rawGear ?? '').trim();
  const gear_level = typeof trimmedGear === 'number' ? trimmedGear : Number(trimmedGear);
  if (trimmedGear === '' || rawGear === null || rawGear === undefined || !Number.isFinite(gear_level)) {
    errors.gear_level = 'Enter your gear level as a number.';
  } else if (!Number.isInteger(gear_level)) {
    errors.gear_level = 'Gear level is a whole number.';
  } else if (gear_level < GEAR_MIN || gear_level > GEAR_MAX) {
    errors.gear_level = `Gear level should be between ${GEAR_MIN} and ${GEAR_MAX}.`;
  }

  // ── Nights ────────────────────────────────────────────────────────────────
  // Deduped and put back in week order, so two signups that picked the same
  // nights in a different order store the same array.
  const rawNights = Array.isArray(body.nights) ? body.nights : [];
  const nights = NIGHTS.filter((n) => rawNights.includes(n));
  if (rawNights.some((n) => !NIGHTS.includes(n))) {
    errors.nights = `Nights must be from: ${NIGHTS.join(', ')}.`;
  } else if (nights.length === 0) {
    errors.nights = 'Pick at least one night you can play.';
  }

  // ── Notes ─────────────────────────────────────────────────────────────────
  const notesRaw = String(body.notes ?? '').trim();
  if (notesRaw.length > NOTES_MAX) {
    errors.notes = `Keep notes under ${NOTES_MAX} characters.`;
  }
  const notes = notesRaw || null;

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    errors: {},
    value: {
      player_name,
      weapon_1,
      weapon_2,
      class_name,
      gear_level,
      nights,
      notes,
      wants_captain: body.wants_captain === true || body.wants_captain === 'true',
    },
  };
}

module.exports = { validateSignup, NIGHTS, NAME_MAX, NOTES_MAX, GEAR_MIN, GEAR_MAX };
