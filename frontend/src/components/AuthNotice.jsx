// Why a login attempt bounced.
//
// Discord refusals come back as a redirect to APP_URL with ?auth=<reason> on
// it, so whatever renders at APP_URL has to be the thing that reads it. That
// used to be the login page and is now the front door, so this lives in a
// component both of them mount rather than in either one of them.
//
// Getting this wrong is not a cosmetic failure. A refused user who is told
// nothing sees the front page, clicks the gated link again, signs in again, and
// is returned to the front page again — a login loop with no explanation
// anywhere in it. The message IS the exit.
import { DISCORD_INVITE } from '../lib/discord';

const REASONS = {
  not_member: {
    title: 'You need to be in the tournament Discord',
    body: 'Discord says you are not a member of the server this site is bound to. Join it, then come '
      + 'back and sign in. If you are certain you are already in it, the site is pointing at the '
      + 'wrong server — tell an organizer.',
    // The one refusal with an obvious fix, so the fix goes in the message
    // rather than making them find it again further down the page.
    invite: true,
    organizer: 'DISCORD_GUILD_ID is the server this checks against. A login that works for you and '
      + 'nobody else usually means it names a server only you are in.',
  },
  forbidden: {
    title: "Your roles don't let you sign in",
    body: 'You are in the server, but the site is set to admit only certain roles and you do not have '
      + 'one of them. An organizer can fix this.',
    organizer: 'DISCORD_ALLOWED_ROLE_IDS is set. Leave it EMPTY to let any member of the server sign '
      + 'in — that is the usual setting for an open tournament.',
  },
  error: {
    title: "That didn't work",
    body: 'Something went wrong talking to Discord. Try again — if it keeps happening, tell an organizer.',
    organizer: 'Usually DISCORD_REDIRECT_URI not matching the redirect registered on the Discord '
      + 'application, character for character. The server log names the cause.',
  },
};

// Read once at mount rather than from useSearchParams: this renders on the
// front door too, which sits outside the router's data context in some of the
// broadcast routes, and the value never changes without a full navigation.
export function authReason(search = window.location.search) {
  return REASONS[new URLSearchParams(search).get('auth')] || null;
}

export default function AuthNotice({ reason }) {
  if (!reason) return null;

  return (
    <div className="rounded border border-oxblood/50 bg-oxblooddeep px-4 py-3">
      <div className="text-[13.5px] font-semibold text-crimsonbright">{reason.title}</div>
      <p className="text-xs text-ash mt-1 leading-relaxed">{reason.body}</p>
      {reason.invite && (
        <a
          href={DISCORD_INVITE}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex mt-2.5 px-3 py-1.5 rounded border border-crimson/60
                     bg-crimson/15 text-crimsonbright font-semibold text-xs
                     hover:bg-crimson/25 transition-colors"
        >
          Join the Discord ↗
        </a>
      )}
      {/* The fix, for whoever is running the site. Shown to everybody because
          the person who hits this is the one who reports it, and a report that
          names the setting gets fixed the same day. */}
      {reason.organizer && (
        <p className="text-[11px] text-ash/80 mt-2 pt-2 border-t border-oxblood/30 leading-relaxed">
          <span className="uppercase tracking-[0.1em] font-semibold">For the organizer:</span>{' '}
          {reason.organizer}
        </p>
      )}
    </div>
  );
}
