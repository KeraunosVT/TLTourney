// Broadcast links.
//
// These are typed by an organizer and rendered as anchors to the PUBLIC —
// /api/tournament sits above requireAuth, so a signed-out visitor gets them.
// That makes the scheme check a security boundary rather than tidiness:
// `javascript:` in an href runs on click, and no amount of care in the page
// that renders it can undo a bad value that was allowed into the column.
const test = require('node:test');
const assert = require('node:assert');

const {
  MAX_STREAMS, MAX_URL, safeUrl, hostOf, normalizeStreams,
} = require('../../shared/streams.cjs');

test('HTTPS IS THE ONLY SCHEME THAT SURVIVES', () => {
  assert.ok(safeUrl('https://twitch.tv/keraunos'));

  // The one that matters. An href carrying this runs script on click.
  assert.strictEqual(safeUrl('javascript:alert(1)'), null);
  assert.strictEqual(safeUrl('JavaScript:alert(1)'), null, 'scheme is case-insensitive');
  assert.strictEqual(safeUrl('data:text/html,<script>alert(1)</script>'), null);
  assert.strictEqual(safeUrl('vbscript:msgbox(1)'), null);
  assert.strictEqual(safeUrl('file:///etc/passwd'), null);

  // Refused as an allow-list consequence rather than by its own rule, which is
  // the point: a scheme invented after this was written is refused too.
  assert.strictEqual(safeUrl('http://twitch.tv/keraunos'), null, 'plain http');
});

test('junk that is not a URL at all is refused, not stored', () => {
  ['', '   ', 'twitch.tv/keraunos', 'not a url', '//twitch.tv/x', 'https://'].forEach((bad) => {
    assert.strictEqual(safeUrl(bad), null, `accepted ${JSON.stringify(bad)}`);
  });
  assert.strictEqual(safeUrl(null), null);
  assert.strictEqual(safeUrl(undefined), null);
});

test('an absurdly long URL is refused before it reaches the column', () => {
  assert.strictEqual(safeUrl(`https://twitch.tv/${'x'.repeat(MAX_URL)}`), null);
});

test('hostOf drops www so the label reads the way people say it', () => {
  assert.strictEqual(hostOf('https://www.twitch.tv/keraunos'), 'twitch.tv');
  assert.strictEqual(hostOf('https://youtube.com/@x'), 'youtube.com');
  assert.strictEqual(hostOf('nonsense'), '');
});

test('a normal list survives intact and in order', () => {
  const { streams, error } = normalizeStreams([
    { label: 'Main broadcast', url: 'https://twitch.tv/main' },
    { label: 'Co-stream', url: 'https://twitch.tv/second' },
  ]);
  assert.strictEqual(error, undefined);
  assert.deepStrictEqual(streams.map((s) => s.label), ['Main broadcast', 'Co-stream']);
});

test('BLANK ROWS ARE DROPPED, not rejected', () => {
  // The editor keeps an empty row at the bottom to type into. Saving with it
  // still empty is not a mistake, and a red banner for it would be nonsense.
  const { streams, error } = normalizeStreams([
    { label: 'Main', url: 'https://twitch.tv/main' },
    { label: '', url: '' },
    { label: '   ', url: '  ' },
  ]);
  assert.strictEqual(error, undefined);
  assert.strictEqual(streams.length, 1);
});

test('a row with a link and no label is labelled by its host', () => {
  // Better than "Stream": a bare URL tells a viewer nothing about whose it is,
  // and the host at least says where they are about to go.
  const { streams } = normalizeStreams([{ label: '', url: 'https://www.twitch.tv/keraunos' }]);
  assert.deepStrictEqual(streams, [{ label: 'twitch.tv', url: 'https://www.twitch.tv/keraunos' }]);
});

test('a label with no link is an error, not a silent drop', () => {
  // The opposite of a blank row: somebody typed a name and meant to paste a
  // link. Dropping it quietly is how a stream goes unlisted on the night.
  const { error } = normalizeStreams([{ label: 'Main broadcast', url: '' }]);
  assert.match(error, /no link/);
});

test('a bad link names itself in the error', () => {
  const { error, streams } = normalizeStreams([{ label: 'Main', url: 'twitch.tv/main' }]);
  assert.strictEqual(streams, undefined, 'nothing is saved when one row is bad');
  assert.match(error, /https:\/\//);
});

test('the list is capped', () => {
  const many = Array.from({ length: MAX_STREAMS + 1 }, (_, i) => ({
    label: `S${i}`, url: `https://twitch.tv/s${i}`,
  }));
  assert.match(normalizeStreams(many).error, /more than/);
});

test('missing and malformed input are answered, never thrown', () => {
  // This runs on a request body. Every shape somebody can PUT has to come back
  // as a value rather than a 500.
  assert.deepStrictEqual(normalizeStreams(undefined), { streams: [] });
  assert.deepStrictEqual(normalizeStreams(null), { streams: [] });
  assert.deepStrictEqual(normalizeStreams([]), { streams: [] });
  assert.match(normalizeStreams('https://twitch.tv/x').error, /a list/);
  assert.match(normalizeStreams({ url: 'https://twitch.tv/x' }).error, /a list/);
  // A row that is not an object at all — String(undefined ?? '') is '', so
  // these read as blank rows and drop.
  assert.deepStrictEqual(normalizeStreams([null, undefined, 7]), { streams: [] });
});
