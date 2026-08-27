// When are signups open?
//
// Two gates that differ by one case, which is exactly the shape of thing that
// gets collapsed into one during a later edit. And every failure here is silent:
// a deadline that doesn't hold lets somebody change their class the morning of
// the draft and invalidates boards nobody re-checks; a deadline that holds too
// hard traps a player who can't make it in a pool captains are drafting from.
const test = require('node:test');
const assert = require('node:assert');

const { isOpen, canWithdraw, deadlinePassed, closedReason } = require('../signups');

const HOUR = 3600 * 1000;
const at = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

const open = (over = {}) => ({ status: 'signups', signups_close_at: null, ...over });

// ── The deadline itself ─────────────────────────────────────────────────────
test('no deadline set means signups never close on time', () => {
  // The state the tournament is in today. A null must not read as "the deadline
  // was the epoch and it passed".
  assert.strictEqual(deadlinePassed(open()), false);
  assert.strictEqual(deadlinePassed(open({ signups_close_at: undefined })), false);
  assert.ok(isOpen(open()));
});

test('a deadline in the future is open, one in the past is not', () => {
  assert.ok(isOpen(open({ signups_close_at: at(HOUR) })));
  assert.ok(!isOpen(open({ signups_close_at: at(-HOUR) })));
});

test('THE DEADLINE ACTUALLY CLOSES SIGNUPS — it used to be decorative', () => {
  // It was stored, printed on the form as a date people planned around, and
  // never checked by anything. This is the regression test for that.
  const t = open({ signups_close_at: at(-1000) });
  assert.strictEqual(t.status, 'signups', 'status alone still says open');
  assert.strictEqual(isOpen(t), false, 'but the deadline closes it');
});

test('a deadline a second away is still open', () => {
  assert.ok(isOpen(open({ signups_close_at: at(1000) })));
});

// ── Status still matters ────────────────────────────────────────────────────
test('the draft starting closes signups whatever the deadline says', () => {
  // A deadline in the future must not reopen a pool the draft is running on.
  for (const status of ['draft', 'live', 'complete', 'setup']) {
    assert.strictEqual(
      isOpen({ status, signups_close_at: at(HOUR) }), false,
      `status ${status} should be closed`
    );
  }
});

test('no tournament at all is closed, not a crash', () => {
  assert.strictEqual(isOpen(null), false);
  assert.strictEqual(isOpen(undefined), false);
  assert.strictEqual(deadlinePassed(null), false);
  assert.strictEqual(canWithdraw(null), false);
});

// ── Withdrawing is the asymmetric one ───────────────────────────────────────
test('YOU MAY STILL LEAVE AFTER THE DEADLINE, EVEN THOUGH YOU MAY NOT EDIT', () => {
  // The whole reason there are two gates. Days can pass between the close and
  // draft night; somebody who finds out they can't make it has to be able to
  // say so, or a captain spends a pick on a player who never turns up.
  const closed = open({ signups_close_at: at(-HOUR) });
  assert.strictEqual(isOpen(closed), false, 'cannot file or edit');
  assert.strictEqual(canWithdraw(closed), true, 'but can still pull out');
});

test('once the draft starts, withdrawing stops too', () => {
  // Rosters are being built out of this pool by then — leaving is a
  // conversation with an organizer, not a button.
  assert.strictEqual(canWithdraw({ status: 'draft', signups_close_at: at(HOUR) }), false);
  assert.strictEqual(canWithdraw({ status: 'live' }), false);
});

test('before the deadline the two gates agree', () => {
  // They only diverge in one window. Anywhere else, a difference would be a bug.
  for (const t of [open(), open({ signups_close_at: at(HOUR) })]) {
    assert.strictEqual(isOpen(t), canWithdraw(t));
  }
});

// ── What the player is told ─────────────────────────────────────────────────
test('each closed state explains itself differently', () => {
  // "Signups are closed" for a deadline that passed would have people asking an
  // organizer why, and the answer is on the page they were just looking at.
  assert.match(closedReason(null), /no tournament/i);
  assert.match(closedReason({ status: 'setup' }), /not opened yet/i);
  assert.match(closedReason(open({ signups_close_at: at(-HOUR) })), /deadline/i);
  assert.match(closedReason({ status: 'draft' }), /draft has started/i);
});

test('a tournament that is open has no reason to give', () => {
  // closedReason is only ever read when isOpen is false; this pins the pairing
  // so a future edit cannot make the form print a reason while accepting entries.
  const t = open({ signups_close_at: at(HOUR) });
  assert.ok(isOpen(t));
});
