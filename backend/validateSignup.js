// backend/validateSignup.js — turn a request body into a row, or into errors.
//
// Pulled out of the route so it can be tested: server.js calls app.listen() at
// require time, which makes anything defined in it unreachable from a test.
// This is also the part where a mistake produces a PLAUSIBLE WRONG ANSWER
// rather than an error — a class that isn't in the game stored as though it
// were, a duplicate silently counted twice in the pool — which is Gear-Gap's
// rule for what earns a test.
//
// One thing is deliberately NOT taken from the body:
//   · discord_id — comes from the session. A signup filed as someone else is
//                  the whole reason this app has a login.

const { CLASS_NAMES, isClass } = require('../shared/classes.cjs');
const { ROLES, POSITIONS, isRole } = require('../shared/roles.cjs');

const NIGHTS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const NAME_MAX = 32;      // matches the CHECK constraint in migration 001
const NOTES_MAX = 500;    // ditto
const MAX_CLASSES = 3;    // ditto

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

  // ── Classes ───────────────────────────────────────────────────────────────
  // One to three, in preference order, no repeats. Order is meaningful — the
  // first is their main — so this deliberately does NOT sort, unlike nights.
  //
  // Blanks are dropped rather than rejected: the form offers three dropdowns
  // and the second and third are optional, so an unfilled one arrives as ''.
  // That is a person leaving a field alone, not an error to report at them.
  const rawClasses = Array.isArray(body.classes) ? body.classes : [];
  const cleaned = rawClasses.map((c) => String(c ?? '').trim()).filter(Boolean);

  const classes = [];
  const seen = new Set();
  let duplicate = null;
  let unknown = null;
  for (const c of cleaned) {
    if (!isClass(c)) { unknown = unknown || c; continue; }
    if (seen.has(c)) { duplicate = duplicate || c; continue; }
    seen.add(c);
    classes.push(c);
  }

  if (!Array.isArray(body.classes)) {
    errors.classes = 'Pick at least one class.';
  } else if (unknown) {
    errors.classes = `"${unknown}" isn't a class in the game.`;
  } else if (duplicate) {
    // Reported rather than quietly de-duplicated. Picking the same class twice
    // means the form let them, and silently collapsing it hides that.
    errors.classes = `You picked ${duplicate} twice — each slot should be a different class.`;
  } else if (classes.length === 0) {
    errors.classes = 'Pick at least one class.';
  } else if (classes.length > MAX_CLASSES) {
    errors.classes = `Pick at most ${MAX_CLASSES} classes.`;
  }

  // ── Role ──────────────────────────────────────────────────────────────────
  // Required on every write. Existing rows may hold null — those predate the
  // field (see migrations/002) — but nothing may be SAVED without one, which
  // is how those rows get filled in as their owners edit them.
  const role = String(body.role ?? '').trim();
  if (!role) {
    errors.role = 'Pick a role.';
  } else if (!isRole(role)) {
    errors.role = `Role must be one of: ${ROLES.join(', ')}.`;
  }

  // ── Positions ─────────────────────────────────────────────────────────────
  // Many, and put back in the canonical order — front to back, the way a raid
  // is actually arranged — so two signups that ticked the same boxes in a
  // different order store the same array and read the same in the queue.
  const rawPositions = Array.isArray(body.positions) ? body.positions : [];
  const positions = POSITIONS.filter((p) => rawPositions.includes(p));
  if (!Array.isArray(body.positions)) {
    errors.positions = 'Pick at least one position.';
  } else if (rawPositions.some((p) => !POSITIONS.includes(p))) {
    errors.positions = `Positions must be from: ${POSITIONS.join(', ')}.`;
  } else if (positions.length === 0) {
    errors.positions = 'Pick at least one position — "all" is fine.';
  }

  // ── Nights ────────────────────────────────────────────────────────────────
  // Deduped and put back in week order, so two signups that picked the same
  // nights in a different order store the same array. Unlike classes, order
  // carries no meaning here — Tuesday is not a preference over Thursday.
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
      classes,
      role,
      positions,
      nights,
      notes,
      wants_captain: body.wants_captain === true || body.wants_captain === 'true',
      // Always a real boolean, never null. The column is nullable only so that
      // signups filed before the question existed can say "never asked" — a
      // form that shows the box and comes back unticked is a genuine no.
      wants_shotcall: body.wants_shotcall === true || body.wants_shotcall === 'true',
    },
  };
}

module.exports = {
  validateSignup, NIGHTS, CLASS_NAMES, ROLES, POSITIONS,
  NAME_MAX, NOTES_MAX, MAX_CLASSES,
};
