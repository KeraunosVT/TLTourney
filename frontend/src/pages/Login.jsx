import { useEffect, useState } from 'react';
import api from '../api';
import { LockupVertical } from '../components/Brand';

// Why a login attempt bounced. Discord sends people back here with ?auth=…
const REASONS = {
  not_member: {
    title: 'You need to be in the tournament Discord',
    body: 'Discord says you are not a member of the server this site is bound to. Join it, then come '
      + 'back and sign in. If you are certain you are already in it, the site is pointing at the '
      + 'wrong server — tell an organizer.',
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

        <div className="panel p-6 text-center">
          <p className="text-sm text-ash leading-relaxed mb-5">
            Sign in with Discord to file your signup for the draft. We read your name and your
            roles in the tournament server — nothing else, and nothing is posted on your behalf.
          </p>
          <a
            href="/api/auth/login"
            className="inline-flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded
                       border border-crimson/60 bg-crimson/15 text-crimsonbright font-semibold text-sm
                       hover:bg-crimson/25 transition-colors"
          >
            Sign in with Discord
          </a>

          {tournament && (
            <p className="text-xs text-ash mt-4">
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
