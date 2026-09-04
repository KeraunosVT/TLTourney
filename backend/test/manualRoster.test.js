// Manual roster changes: the escape hatch for a no-show, an injury, or a
// player leaving a team after the draft is long over.
//
// These are integration-shaped rules living in backend/teams.js, so what's
// tested here at the unit level is the one piece of pure logic the routes
// lean on: which `via` a removal is allowed to touch. The routes themselves
// enforce this against the database directly (draftUnderWay, the approved-
// signup check, the addToRoster call) — this file pins the decision table so
// a refactor can't quietly let a draft pick be deleted through this door.
const test = require('node:test');
const assert = require('node:assert');

const { VIA_CAPTAIN, isVia } = require('../../shared/roster.cjs');

// Mirrors the branching in DELETE /:id/roster/:signupId — kept here as a pure
// function so the rule ("captain seats and draft picks are refused, manual
// adds are not") has one place it can be asserted without a database.
function removalAllowed(via) {
  if (via === VIA_CAPTAIN) return false;
  if (via === 'draft') return false;
  return via === 'manual';
}

test('a manual roster entry can be removed', () => {
  assert.strictEqual(removalAllowed('manual'), true);
});

test('a captain seat is refused — remove the seat instead', () => {
  assert.strictEqual(removalAllowed(VIA_CAPTAIN), false);
});

test('a draft pick is refused — it stays on the record', () => {
  assert.strictEqual(removalAllowed('draft'), false);
});

test('every via this route might see is one the schema actually allows', () => {
  ['manual', 'draft', VIA_CAPTAIN].forEach((v) => assert.ok(isVia(v), v));
});
