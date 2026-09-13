// Where a login is allowed to put you afterwards.
//
// Two failures live here and they point in opposite directions.
//
// Too strict, and the destination is dropped: somebody clicks /leaderboard in
// Discord, signs in, and is returned to the front page — which is the bug this
// was written for, and which reads to the person experiencing it as the login
// not having worked.
//
// Too loose, and it is an open redirect. The whole value of one is that the
// link is on OUR domain, so a sign-in URL that forwards anywhere is a phishing
// primitive with the tournament's name on the front of it. Every case below
// that returns null is a real shape attackers use, not a hypothetical.
const test = require('node:test');
const assert = require('node:assert');

const { safeReturnTo, appUrl } = require('../auth');

// ── What must be allowed ────────────────────────────────────────────────────
test('an ordinary page path survives the round trip', () => {
  assert.equal(safeReturnTo('/leaderboard'), '/leaderboard');
  assert.equal(safeReturnTo('/bracket'), '/bracket');
  assert.equal(safeReturnTo('/match/wb-1'), '/match/wb-1');
});

test('a query string is kept — it is part of where they were', () => {
  assert.equal(safeReturnTo('/leaderboard?sort=healing'), '/leaderboard?sort=healing');
});

test('the root is a destination like any other', () => {
  assert.equal(safeReturnTo('/'), '/');
});

// ── What must not be ────────────────────────────────────────────────────────
test('protocol-relative paths are refused', () => {
  // The one that looks like a path and is not. "//evil.com" inherits our
  // scheme and goes to evil.com, and it is the single most common way an
  // open-redirect filter that only checked for a leading slash gets beaten.
  assert.equal(safeReturnTo('//evil.com'), null);
  assert.equal(safeReturnTo('//evil.com/leaderboard'), null);
});

test('a backslash after the slash is refused', () => {
  // Browsers normalise "/\" to "//" and follow it. The filter has to know that
  // even though the string does not look protocol-relative.
  assert.equal(safeReturnTo('/\\evil.com'), null);
});

test('absolute URLs are refused however they are spelled', () => {
  assert.equal(safeReturnTo('https://evil.com'), null);
  assert.equal(safeReturnTo('http://evil.com'), null);
  assert.equal(safeReturnTo('javascript:alert(1)'), null);
  assert.equal(safeReturnTo('evil.com'), null);
});

test('the auth flow is not a destination', () => {
  // Returning INTO the login route is the loop, mechanically: sign in, get
  // redirected to sign in, repeat.
  assert.equal(safeReturnTo('/api/auth/login'), null);
  assert.equal(safeReturnTo('/api/auth/discord/callback'), null);
  assert.equal(safeReturnTo('/api'), null);
});

test('control characters cannot be smuggled into the Location header', () => {
  assert.equal(safeReturnTo('/leaderboard\r\nSet-Cookie: a=b'), null);
  assert.equal(safeReturnTo('/leaderboard\n'), null);
  assert.equal(safeReturnTo('/leader\x00board'), null);
});

test('nonsense and absent values fall back rather than throw', () => {
  assert.equal(safeReturnTo(undefined), null);
  assert.equal(safeReturnTo(null), null);
  assert.equal(safeReturnTo(''), null);
  // Express gives an array when the parameter is repeated; it must not be
  // treated as a string.
  assert.equal(safeReturnTo(['/leaderboard', '/bracket']), null);
  assert.equal(safeReturnTo({}), null);
  assert.equal(safeReturnTo(`/${'x'.repeat(600)}`), null);
});

// ── Joining it to APP_URL ───────────────────────────────────────────────────
// APP_URL is "/" locally and "https://tnltourneystats.com" live, and the naive
// concatenation of the first with "/leaderboard" is "//leaderboard" — the exact
// protocol-relative URL the validator above exists to refuse, reintroduced at
// the point of use. These run with APP_URL unset, i.e. the local default.
test('the local default does not produce a protocol-relative redirect', () => {
  assert.equal(appUrl('/leaderboard'), '/leaderboard');
  assert.equal(appUrl('/?auth=not_member'), '/?auth=not_member');
});

test('the root never collapses to an empty Location', () => {
  // "" is not a redirect; it has to stay "/".
  assert.equal(appUrl('/'), '/');
});
