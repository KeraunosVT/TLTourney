// A team's Discord invite.
//
// This URL goes out in a DM FROM THE TOURNAMENT BOT to a player who has just
// been drafted and is expecting exactly that message. It is the most trusted
// link this app ever sends, and it is typed by whoever can edit a team — so
// the host check is the point of the whole module, not a formality.
const test = require('node:test');
const assert = require('node:assert');

const { safeInvite, MAX_INVITE } = require('../../shared/invites.cjs');

test('the four real invites are accepted', () => {
  [
    'https://discord.gg/S2KsfEesB',
    'https://discord.gg/4zAhxvPWK',
    'https://discord.gg/SqJnD5VGz',
    'https://discord.gg/DnxFdnPT4',
  ].forEach((url) => assert.ok(safeInvite(url), `refused ${url}`));
});

test('discord.com invites need the /invite/ path', () => {
  assert.ok(safeInvite('https://discord.com/invite/abc123'));
  // The bare app is not an invite — a player clicking it lands nowhere useful.
  assert.strictEqual(safeInvite('https://discord.com/'), null);
  assert.strictEqual(safeInvite('https://discord.com/channels/123/456'), null);
});

test('A LOOKALIKE HOST IS REFUSED', () => {
  // The bug an endsWith check on the bare domain would have: every one of these
  // contains "discord.gg" or "discord.com" and none of them is Discord.
  [
    'https://discord.gg.evil.com/abc',
    'https://discord.com.evil.com/invite/abc',
    'https://notdiscord.gg/abc',
    'https://evil.com/discord.gg/abc',
    'https://discord.gg@evil.com/abc',
  ].forEach((url) => assert.strictEqual(safeInvite(url), null, `accepted ${url}`));
});

test('a genuine subdomain is still Discord', () => {
  assert.ok(safeInvite('https://ptb.discord.com/invite/abc123'));
});

test('the scheme check survives, same as it does for streams', () => {
  assert.strictEqual(safeInvite('javascript:alert(1)'), null);
  assert.strictEqual(safeInvite('http://discord.gg/abc'), null, 'plain http');
  assert.strictEqual(safeInvite('discord.gg/abc'), null, 'no scheme at all');
});

test('the stored value is the PARSED one, not the raw string', () => {
  // What passed validation and what gets written have to be the same thing.
  assert.strictEqual(safeInvite('  https://discord.gg/abc  '), 'https://discord.gg/abc');
  assert.strictEqual(safeInvite('https://WWW.discord.gg/abc'), 'https://www.discord.gg/abc');
});

test('empty and junk come back as null rather than throwing', () => {
  // This runs on a request body and on every keystroke in the form.
  [null, undefined, '', '   ', 'not a url', 7, {}].forEach((bad) => {
    assert.strictEqual(safeInvite(bad), null, `threw or accepted ${JSON.stringify(bad)}`);
  });
});

test('an absurdly long URL is refused', () => {
  assert.strictEqual(safeInvite(`https://discord.gg/${'x'.repeat(MAX_INVITE)}`), null);
});
