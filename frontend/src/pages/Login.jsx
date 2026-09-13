import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import api from '../api';
import { LockupVertical } from '../components/Brand';
import AuthNotice, { authReason } from '../components/AuthNotice';
import { DISCORD_INVITE } from '../lib/discord';
import { hostOf } from '@shared/streams.cjs';

// Signing in checks membership of the tournament Discord, so somebody who
// hasn't joined it is refused before they get anywhere — which is why the
// invite is step one on this page rather than a footnote.

export default function Login() {
  const [tournament, setTournament] = useState(null);
  const [reason, setReason] = useState(null);

  // Where to put them back afterwards. The gate renders this page IN PLACE of
  // the route they asked for, without changing the URL, so the location still
  // says /leaderboard and the round trip can end where it started instead of
  // on the front page.
  const { pathname, search } = useLocation();
  const returnTo = `${pathname}${search}`;
  const signInHref = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;

  useEffect(() => {
    setReason(authReason());
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

        {reason && <div className="mb-5"><AuthNotice reason={reason} /></div>}

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
                href={signInHref}
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

        {/* Watching needs no account, so this sits OUTSIDE the sign-in panel
            rather than inside the two-step. Somebody who followed a link to
            find the stream should not have to read a Discord invite first. */}
        {tournament?.streams?.length > 0 && (
          <div className="mt-6">
            <div className="eyebrow text-center mb-2.5">Watch</div>
            <div className="flex flex-col gap-1.5">
              {tournament.streams.map((s) => (
                <a
                  key={s.url}
                  href={s.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="flex items-center gap-2.5 px-3.5 py-2.5 rounded border border-line
                             hover:border-crimson hover:text-crimsonbright transition-colors"
                >
                  <span className="text-[13px] truncate">{s.label}</span>
                  <span className="flex-1" />
                  {/* The host, shown because these are links an organizer
                      typed and a viewer is about to leave the site for. */}
                  <span className="mono text-[10.5px] text-ash truncate">{hostOf(s.url)} ↗</span>
                </a>
              ))}
            </div>
          </div>
        )}

        <p className="text-[11px] text-ash text-center mt-5 leading-relaxed">
          This is the tournament's own Discord server, separate from any guild you're in.
        </p>
      </div>
    </div>
  );
}
