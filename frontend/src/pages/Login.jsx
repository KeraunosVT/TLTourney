import { useEffect, useState } from 'react';
import api from '../api';
import { LockupVertical } from '../components/Brand';

// The tournament Discord. Signing in checks membership of this server, so
// somebody who hasn't joined it is refused before they get anywhere — which is
// why the invite is step one on this page rather than a footnote.
//
// ⚠️  This must be a NEVER-EXPIRING invite. A default Discord invite dies after
// 7 days, and an expired one here doesn't look broken: people land on "Invite
// Invalid", assume the tournament is closed, and leave.
const DISCORD_INVITE = 'https://discord.gg/p7WPgFku9K';

// Why a login attempt bounced. Discord sends people back here with ?auth=…
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

export default function Login() {
  const [tournament, setTournament] = useState(null);
  const [reason, setReason] = useState(null);

  useEffect(() => {
    const auth = new URLSearchParams(window.location.search).get('auth');
    if (auth && REASONS[auth]) setReason(REASONS[auth]);
    api.get('/api/tournament')
      .then(({ data }) => setTournament(data.tournament))
      .catch(() => {});
  }, []);

  return (
    <div className="min-h-screen grid place-items-center px-5 py-10">
      <div className="w-full max-w-[440px]">
        {/* The vertical lockup, not the horizontal one: this column is 440px at
            its widest and the horizontal lockup's "TOURNAMENT SERIES" would be
            about 7px here. The mark is the page — everything else on it is one
            button. */}
        <div className="flex flex-col items-center text-center mb-7">
          <LockupVertical width={300} />
          {tournament && (
            <div className="eyebrow mt-3">{tournament.name}</div>
          )}
        </div>

        {reason && (
          <div className="mb-5 rounded border border-oxblood/50 bg-oxblooddeep px-4 py-3">
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
            {/* The fix, for whoever is running the site. Shown to everybody
                because the person who hits this is the one who reports it, and
                a report that names the setting gets fixed the same day. */}
            {reason.organizer && (
              <p className="text-[11px] text-ash/80 mt-2 pt-2 border-t border-oxblood/30 leading-relaxed">
                <span className="uppercase tracking-[0.1em] font-semibold">For the organizer:</span>{' '}
                {reason.organizer}
              </p>
            )}
          </div>
        )}

        {/* Two numbered steps rather than one button and a note. Signing in
            without having joined the server doesn't fail gently — Discord
            bounces you back with an error — so the order isn't advice, it's the
            only sequence that works. Numbering it is the cheapest way to say
            so, and returning members lose nothing: step 2 is where they were
            always going to click. */}
        <div className="panel p-6">
          <ol className="flex flex-col gap-5">
            <li>
              <div className="flex items-baseline gap-2 mb-2">
                <span className="mono text-[11px] text-crimson">1</span>
                <span className="text-[13.5px] font-semibold">Join the tournament Discord</span>
              </div>
              <p className="text-xs text-ash leading-relaxed mb-3">
                Signing in checks that you're a member. Do this first — otherwise Discord will
                turn you away.
              </p>
              <a
                href={DISCORD_INVITE}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded
                           border border-line text-bone font-semibold text-sm
                           hover:border-crimson hover:text-crimsonbright transition-colors"
              >
                Join the Discord ↗
              </a>
            </li>

            <li className="pt-1 border-t border-line/60">
              <div className="flex items-baseline gap-2 mb-2 mt-4">
                <span className="mono text-[11px] text-crimson">2</span>
                <span className="text-[13.5px] font-semibold">Sign in here</span>
              </div>
              <p className="text-xs text-ash leading-relaxed mb-3">
                We read your name and your roles in the tournament server — nothing else, and
                nothing is posted on your behalf.
              </p>
              <a
                href="/api/auth/login"
                className="inline-flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded
                           border border-crimson/60 bg-crimson/15 text-crimsonbright font-semibold text-sm
                           hover:bg-crimson/25 transition-colors"
              >
                Sign in with Discord
              </a>
            </li>
          </ol>

          {tournament && (
            <p className="text-xs text-ash mt-5 text-center">
              {tournament.open
                ? 'Signups are open.'
                : 'Signups are closed right now — you can still sign in and look.'}
            </p>
          )}
        </div>

        <p className="text-[11px] text-ash text-center mt-5 leading-relaxed">
          This is the tournament's own Discord server, separate from any guild you're in.
        </p>
      </div>
    </div>
  );
}
