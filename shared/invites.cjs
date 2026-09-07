// shared/invites.cjs — a team's own Discord, for the people it drafts.
//
// Read by both halves, like roles.cjs: the Teams form refuses exactly what the
// API refuses, from one function.
//
// ── Why the host is checked, and not just the scheme ────────────────────────
// These URLs go out in a DM FROM THE TOURNAMENT BOT, to a player who has just
// been drafted and is expecting exactly such a message. That is the most
// trusted a link this app sends will ever be, and it is typed by whoever can
// edit a team.
//
// So an invite is a Discord invite: two hosts, nothing else. Not because other
// links are useless, but because "click this to join your team" carrying an
// arbitrary destination is a phishing template with the bot's name on it. A
// team that wants to send something else can send it themselves.

const INVITE_HOSTS = ['discord.gg', 'discord.com', 'discordapp.com'];

const MAX_INVITE = 200;

/**
 * A usable invite, or null.
 *
 * Returns the normalised URL so what is stored is what was checked — parsing
 * and then saving the raw string is how a value that passed validation and a
 * value that got written stop being the same thing.
 */
function safeInvite(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (value.length > MAX_INVITE) return null;

  let u;
  try {
    u = new URL(value);
  } catch {
    return null;
  }

  if (u.protocol !== 'https:') return null;

  // Exact host or a subdomain of one, so `discord.gg.evil.com` is refused —
  // an endsWith check on the bare domain would accept it.
  const host = u.host.replace(/^www\./, '').toLowerCase();
  const ok = INVITE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  if (!ok) return null;

  // discord.com invites live under /invite/. The bare domain is the app, not
  // an invite, and a player clicking it lands nowhere useful.
  if (host !== 'discord.gg' && !u.pathname.startsWith('/invite/')) return null;
  if (u.pathname === '/' || u.pathname === '') return null;

  return u.toString();
}

/** What to tell somebody who pasted the wrong thing. */
const INVITE_HINT = 'A team link is a Discord invite — https://discord.gg/… '
  + 'or https://discord.com/invite/…';

module.exports = { INVITE_HOSTS, MAX_INVITE, INVITE_HINT, safeInvite };
