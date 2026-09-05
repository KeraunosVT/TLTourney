// Audit log pagination: the keyset cursor and the limit clamp.
//
// This is the kind of arithmetic that is wrong quietly — a limit that isn't
// clamped can be asked to read the whole table in one go, and a cursor that
// silently coerces a bad value to something plausible turns a broken "Load
// more" click into a page that looks fine and skips rows.
const test = require('node:test');
const assert = require('node:assert');

const { clampAuditLimit, parseAuditCursor } = require('../organizer');

test('no limit given falls back to the default page size', () => {
  assert.strictEqual(clampAuditLimit(undefined), 100);
  assert.strictEqual(clampAuditLimit(''), 100);
  assert.strictEqual(clampAuditLimit('not a number'), 100);
});

test('a limit inside the range is used as given', () => {
  assert.strictEqual(clampAuditLimit('50'), 50);
  assert.strictEqual(clampAuditLimit(50), 50);
});

test('a limit below 1 is floored, not refused — asking for 0 still gets something', () => {
  assert.strictEqual(clampAuditLimit('0'), 1);
  assert.strictEqual(clampAuditLimit('-5'), 1);
});

test('a limit above the ceiling is capped, not honoured', () => {
  // The whole point: nothing can ask this route to read an unbounded slice of
  // a table that grows for as long as the site is used.
  assert.strictEqual(clampAuditLimit('999999'), 300);
});

test('no cursor means the first page, not an error', () => {
  assert.strictEqual(parseAuditCursor(undefined), null);
});

test('a real cursor is parsed as the id it is', () => {
  assert.strictEqual(parseAuditCursor('42'), 42);
  assert.strictEqual(parseAuditCursor(42), 42);
});

test('a cursor that is not a positive integer is refused, not coerced', () => {
  // Silently treating a bad cursor as "start over" would make a broken "Load
  // more" button look like it worked while quietly re-showing the first page.
  assert.strictEqual(parseAuditCursor('abc'), undefined);
  assert.strictEqual(parseAuditCursor('0'), undefined);
  assert.strictEqual(parseAuditCursor('-3'), undefined);
  assert.strictEqual(parseAuditCursor('4.5'), undefined);
});
