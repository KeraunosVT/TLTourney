// shared/streams.cjs — where the tournament is being broadcast.
//
// Read by both halves, like roles.cjs and classes.cjs: the Setup form refuses
// exactly what the server refuses, from one function. Two copies would drift,
// and the drift shows up as a link the form accepted and the server then threw
// away without saying so.
//
// A LIST, not a single URL. A season has a main broadcast and then co-streams —
// a second caster, a team running their own POV, a rerun in another language —
// and modelling that as one field means the day somebody adds a co-stream is
// the day somebody edits a migration.

const MAX_STREAMS = 8;
const MAX_LABEL = 40;
const MAX_URL = 300;

/**
 * HTTPS ONLY, and this is the security check rather than a tidiness rule.
 *
 * These URLs are typed by an organizer and rendered as links to the public, so
 * the scheme is the whole attack surface: `javascript:` in an href runs on
 * click, and `data:` can carry a whole page. Neither is a broadcast. Checking
 * for a known-good scheme rather than blocking known-bad ones means a scheme
 * invented after this was written is refused by default.
 *
 * Plain http is refused too — a stream link is posted in Discord and opened by
 * hundreds of people, and there is no live broadcast that needs it.
 */
function safeUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (value.length > MAX_URL) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** twitch.tv/foo → "twitch.tv". Shown beside a link so a viewer can see where it goes. */
function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Clean a submitted list, or say what is wrong with it.
 *
 * Returns { streams } or { error }. Rows with neither a label nor a URL are
 * DROPPED rather than rejected: the editor keeps a blank row at the bottom for
 * typing into, and submitting with it still empty is not a mistake worth a red
 * banner.
 */
function normalizeStreams(input) {
  if (input === null || input === undefined) return { streams: [] };
  if (!Array.isArray(input)) return { error: 'Streams are a list.' };

  const out = [];
  for (const row of input) {
    const label = String(row?.label ?? '').trim().slice(0, MAX_LABEL);
    const rawUrl = String(row?.url ?? '').trim();

    if (!label && !rawUrl) continue;
    if (!rawUrl) return { error: `"${label}" has no link.` };

    const url = safeUrl(rawUrl);
    if (!url) {
      return {
        error: `"${rawUrl.slice(0, 60)}" is not a usable link — it has to start with https://`,
      };
    }
    // A link with no label renders as a bare URL, which tells a viewer nothing
    // about whose stream it is. The host is a better default than "Stream".
    out.push({ label: label || hostOf(url), url });
  }

  if (out.length > MAX_STREAMS) {
    return { error: `That is more than ${MAX_STREAMS} streams — trim the list.` };
  }
  return { streams: out };
}

module.exports = { MAX_STREAMS, MAX_LABEL, MAX_URL, safeUrl, hostOf, normalizeStreams };
