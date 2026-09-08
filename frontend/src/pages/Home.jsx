// The front door — /.
//
// Everything a viewer needs, without an account. This is the URL that gets
// pasted into Discord, and until now it sent whoever clicked it to a login
// page, which is the worst possible answer to "what is this and what is
// happening".
//
// ── The page IS the tournament's state ──────────────────────────────────────
// One hero, one primary action, and both follow tournaments.status. A visitor
// should never have to work out which phase the season is in — the page tells
// them and hands them the one thing worth doing right now:
//
//   signups   sign up, and how long is left
//   draft     the clock, who is on it, watch it live
//   live      the next match, when, and where to watch
//   complete  the champion
//
// ── Three public reads, polled at the rates the rest of the app uses ────────
// Nothing here is authenticated. The bracket and predictions ARE, and they are
// marked as such rather than linked as though they were not — sending somebody
// to a login page from a page that promised information is the thing this page
// exists to stop.
import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { Sigil } from '../components/Brand';
import { useCountdown, mmss, whenLocal, countdownLabel } from '../lib/clock';
import { pollMs, bracketPollMs } from '../lib/stream';

const DISCORD_INVITE = 'https://discord.gg/p7WPgFku9K';

export default function Home() {
  const [t, setT] = useState(null);
  const [draft, setDraft] = useState(null);
  const [bracket, setBracket] = useState(null);
  const [failed, setFailed] = useState(null);

  // The tournament itself changes when an organizer presses something. Read
  // once; there is nothing to poll for.
  useEffect(() => {
    axios.get('/api/tournament')
      .then(({ data }) => setT(data.tournament))
      .catch(() => setFailed('Could not reach the tournament.'));
  }, []);

  const loadDraft = useCallback(() => axios.get('/api/stream/draft')
    .then(({ data }) => setDraft(data)).catch(() => {}), []);
  const loadBracket = useCallback(() => axios.get('/api/stream/bracket')
    .then(({ data }) => setBracket(data)).catch(() => {}), []);

  useEffect(() => { loadDraft(); }, [loadDraft]);
  useEffect(() => { loadBracket(); }, [loadBracket]);

  // The same tiers the overlays use. A landing page left open on a phone must
  // not cost more than the broadcast does.
  const dStatus = draft?.draft?.status;
  useEffect(() => {
    const id = setInterval(loadDraft, pollMs(dStatus));
    return () => clearInterval(id);
  }, [dStatus, loadDraft]);
  useEffect(() => {
    const id = setInterval(loadBracket, bracketPollMs(bracket));
    return () => clearInterval(id);
  }, [bracket?.exists, bracket?.champion?.id, loadBracket]);

  if (failed && !t) return <div className="p-8 text-sm text-oxblood">{failed}</div>;

  return (
    <div className="min-h-screen">
      <div className="max-w-[1080px] mx-auto px-5 py-8 flex flex-col gap-6">
        <Masthead t={t} />
        <Hero t={t} draft={draft} bracket={bracket} />
        <Watch t={t} />
        <Standings bracket={bracket} />
        <Explore t={t} />
        <Format t={t} />
        <Footer />
      </div>
    </div>
  );
}

function Masthead({ t }) {
  return (
    <header className="flex items-center gap-3.5">
      <Sigil size={44} />
      <div className="leading-none">
        <div className="wordmark text-[17px] tracking-[0.03em]">
          THRONE <span className="text-crimson">&amp;</span> LIBERTY
        </div>
        <div className="eyebrow mt-1.5">{t?.name || 'Tournament Series'}</div>
      </div>
      <div className="flex-1" />
      <a
        href="/signup"
        className="inline-flex items-center h-11 px-4 rounded border border-line text-[13px]
                   text-ash hover:text-bone hover:border-crimson transition-colors"
      >
        Sign in
      </a>
    </header>
  );
}

// ── The one thing that matters right now ────────────────────────────────────
function Hero({ t, draft, bracket }) {
  const d = draft?.draft;
  const live = d?.status === 'live' || d?.status === 'paused';

  if (live) return <DraftHero draft={draft} />;
  if (bracket?.champion) return <ChampionHero bracket={bracket} />;
  // `open` comes from the same isOpen() the signup route enforces — status AND
  // the deadline. It used to be `status === 'signups'` alone, which kept this
  // page inviting people in after the deadline had shut the form.
  if (t?.open) return <SignupsHero t={t} />;
  return <NextMatchHero bracket={bracket} t={t} />;
}

const Panel = ({ children, tone = '' }) => (
  <section className={`panel p-6 ${tone}`}>{children}</section>
);

function SignupsHero({ t }) {
  return (
    <Panel tone="border-verdigris/40">
      <Badge tone="good">Signups are open</Badge>
      <h1 className="font-display text-[38px] leading-[1.08] mt-3 max-w-[20ch]">
        Put your name in the pool.
      </h1>
      <p className="text-[15px] text-ash mt-3 leading-relaxed max-w-[62ch]">
        {t?.roster_size || 66} players a team, drafted live by their captains. Sign up once and
        a captain will call your name.
      </p>
      <div className="flex items-center gap-3 mt-5 flex-wrap">
        <a href="/signup" className="inline-flex items-center justify-center h-12 px-7 rounded
                                     border border-crimson/60 bg-crimson/15 text-crimsonbright
                                     text-[14px] font-bold hover:bg-crimson/25 transition-colors">
          Sign up
        </a>
        <a href="/rosters" className="inline-flex items-center justify-center h-12 px-5 rounded
                                      border border-line text-ash text-[14px] font-semibold
                                      hover:text-bone hover:border-crimson transition-colors">
          See the teams
        </a>
      </div>
      {t?.signups_close_at && (
        <p className="text-[13px] text-dim mt-4">
          Closes {whenLocal(t.signups_close_at)}. Signing in uses Discord.
        </p>
      )}
    </Panel>
  );
}

function DraftHero({ draft }) {
  const d = draft.draft;
  const left = useCountdown(d.deadline, d.serverTime);
  const team = (draft.teams || []).find((x) => x.id === d.onClock);
  const paused = d.status === 'paused';

  return (
    <Panel tone="border-crimson">
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div className="min-w-0">
          <Badge tone={paused ? 'bad' : 'live'}>
            {paused ? 'Draft paused' : 'The draft is live'}
          </Badge>
          <h1 className="font-display text-[38px] leading-[1.08] mt-3 truncate">
            {team?.name || 'The draft is running'}
          </h1>
          <p className="text-[14px] text-ash mt-2">
            {d.isCompensation ? 'Compensation pick' : 'On the clock'}
            {d.round != null && ` · round ${d.round}`}
            {' · '}pick {d.currentPick} of {d.totalPicks}
          </p>
        </div>
        {!paused && (
          <div className="mono text-[56px] leading-none shrink-0">{mmss(left)}</div>
        )}
      </div>
      <div className="flex items-center gap-3 mt-5 flex-wrap">
        <a href="/watch" className="inline-flex items-center justify-center h-12 px-7 rounded
                                    border border-crimson/60 bg-crimson/15 text-crimsonbright
                                    text-[14px] font-bold hover:bg-crimson/25 transition-colors">
          Watch the draft
        </a>
        <a href="/picks" className="inline-flex items-center justify-center h-12 px-5 rounded
                                    border border-line text-ash text-[14px] font-semibold
                                    hover:text-bone hover:border-crimson transition-colors">
          Every pick so far
        </a>
      </div>
      {d.isMock && (
        <p className="text-[13px] text-crimsonbright mt-4">
          This is a mock draft — a rehearsal. Nothing picked here counts.
        </p>
      )}
    </Panel>
  );
}

function ChampionHero({ bracket }) {
  return (
    <Panel tone="border-verdigris/50">
      <Badge tone="good">Champion</Badge>
      <h1 className="font-display text-[38px] leading-[1.08] mt-3">
        {bracket.champion.name}
      </h1>
      <p className="text-[15px] text-ash mt-3">That is the season. The full bracket is below.</p>
      <div className="flex items-center gap-3 mt-5 flex-wrap">
        <a href="/rosters" className="inline-flex items-center justify-center h-12 px-6 rounded
                                      border border-line text-ash text-[14px] font-semibold
                                      hover:text-bone hover:border-crimson transition-colors">
          The rosters
        </a>
        <a href="/picks" className="inline-flex items-center justify-center h-12 px-6 rounded
                                    border border-line text-ash text-[14px] font-semibold
                                    hover:text-bone hover:border-crimson transition-colors">
          Every pick
        </a>
      </div>
    </Panel>
  );
}

// The soonest scheduled match nobody has played yet.
function NextMatchHero({ bracket, t }) {
  const next = (bracket?.matches || [])
    .filter((m) => m.kind === 'match' && m.status !== 'complete'
      && m.team_a_id && m.team_b_id && m.scheduled_at
      && new Date(m.scheduled_at).getTime() > Date.now())
    .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at))[0];

  const left = useCountdown(next?.scheduled_at, bracket?.serverTime);
  const byId = new Map((bracket?.teams || []).map((x) => [x.id, x]));

  if (!next) {
    // Signups being SHUT is worth saying out loud, and saying WHY. Somebody who
    // followed a link to enter needs to know whether they missed a deadline or
    // whether this season simply is not taking entries — those are different
    // answers, and "nothing here" is neither of them.
    const closed = t && t.status === 'signups' && !t.open && t.deadline_passed;
    const drafted = t?.status && t.status !== 'signups' && t.status !== 'setup';

    return (
      <Panel>
        <Badge>{t?.status === 'complete' ? 'Season over' : 'Signups are closed'}</Badge>
        <h1 className="font-display text-[34px] leading-[1.1] mt-3 max-w-[24ch]">
          {bracket?.exists ? 'No match scheduled yet.' : 'Signups are closed.'}
        </h1>
        <p className="text-[15px] text-ash mt-3 leading-relaxed max-w-[62ch]">
          {closed
            ? `Entries closed ${whenLocal(t.signups_close_at)}. The pool is frozen while the teams are built.`
            : bracket?.exists
              ? 'The next fixture will appear here as soon as it has a time.'
              : drafted
                ? 'The pool is closed and the teams are being put together. Rosters and the '
                  + 'draft record are below.'
                : 'Rosters, the draft record and the bracket all appear here as the season runs.'}
        </p>
        <div className="flex items-center gap-3 mt-5 flex-wrap">
          <a href="/rosters" className="inline-flex items-center justify-center h-11 px-5 rounded
                                        border border-line text-ash text-[14px] font-semibold
                                        hover:text-bone hover:border-crimson transition-colors">
            The teams
          </a>
          <a href={DISCORD_INVITE} target="_blank" rel="noreferrer noopener"
             className="inline-flex items-center justify-center h-11 px-5 rounded border border-line
                        text-ash text-[14px] font-semibold hover:text-bone hover:border-crimson
                        transition-colors">
            Discord — next season ↗
          </a>
        </div>
      </Panel>
    );
  }

  return (
    <Panel tone="border-crimson/40">
      <Badge>{next.label || 'Up next'}</Badge>
      <h1 className="font-display text-[34px] leading-[1.12] mt-3">
        {byId.get(next.team_a_id)?.name || 'TBD'}
        <span className="text-ash text-[22px]"> vs </span>
        {byId.get(next.team_b_id)?.name || 'TBD'}
      </h1>
      <p className="text-[15px] text-ash mt-3">
        {whenLocal(next.scheduled_at)}
        {left !== null && <span className="text-bone"> · in {countdownLabel(left)}</span>}
        {next.best_of && <span className="text-dim"> · best of {next.best_of}</span>}
      </p>
      <div className="flex items-center gap-3 mt-5 flex-wrap">
        <a href="/watch" className="inline-flex items-center justify-center h-12 px-7 rounded
                                    border border-crimson/60 bg-crimson/15 text-crimsonbright
                                    text-[14px] font-bold hover:bg-crimson/25 transition-colors">
          Watch live
        </a>
      </div>
    </Panel>
  );
}

// ── Where to watch ──────────────────────────────────────────────────────────
// Absent entirely when no stream is set. An empty "Watch" heading is worse than
// no heading, and these are organizer-entered links that may not exist yet.
function Watch({ t }) {
  const streams = t?.streams || [];
  if (streams.length === 0) return null;
  return (
    <section>
      <h2 className="eyebrow mb-2.5">Watch</h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {streams.map((s) => (
          <a
            key={s.url}
            href={s.url}
            target="_blank"
            rel="noreferrer noopener"
            className="panel px-4 py-3.5 flex items-center gap-3 hover:border-crimson transition-colors"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                 strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
                 className="text-crimsonbright shrink-0" aria-hidden="true">
              <path d="M4 5.5v13l12-6.5z" /><path d="M20 5v14" />
            </svg>
            <span className="text-[14px] truncate">{s.label}</span>
            <span className="flex-1" />
            <span className="mono text-[11px] text-ash">↗</span>
          </a>
        ))}
      </div>
    </section>
  );
}

// ── The seeding table ───────────────────────────────────────────────────────
// The single most-asked question during the group stage, and it has no other
// public home — the bracket page is behind a login.
function Standings({ bracket }) {
  const s = bracket?.seeding;
  if (!s?.exists || !s.standings?.length) return null;

  return (
    <section>
      <div className="flex items-baseline gap-3 mb-2.5">
        <h2 className="eyebrow">Seeding stage</h2>
        <span className="text-[12px] text-ash">
          {s.complete} of {s.total} played{s.done ? ' · final' : ''}
        </span>
      </div>
      <div className="panel overflow-hidden">
        <table className="w-full text-[13.5px]">
          <thead>
            <tr className="text-ash border-b border-line">
              <th className="text-left font-normal px-4 py-2 w-[38px]">#</th>
              <th className="text-left font-normal px-2 py-2">Team</th>
              <th className="text-right font-normal px-2 py-2 w-[50px]">W</th>
              <th className="text-right font-normal px-2 py-2 w-[50px]">L</th>
              <th className="text-right font-normal px-4 py-2 w-[64px]">+/&minus;</th>
            </tr>
          </thead>
          <tbody>
            {s.standings.map((r) => (
              <tr key={r.teamId} className="border-b border-line/40 last:border-b-0">
                <td className="px-4 py-2 mono text-crimson">{r.place}</td>
                <td className="px-2 py-2 truncate">{r.team?.name || '—'}</td>
                <td className="px-2 py-2 mono text-right">{r.won}</td>
                <td className="px-2 py-2 mono text-right text-ash">{r.lost}</td>
                <td className={`px-4 py-2 mono text-right ${
                  r.diff > 0 ? 'text-verdigris' : r.diff < 0 ? 'text-oxblood' : 'text-ash'}`}>
                  {r.diff > 0 ? `+${r.diff}` : r.diff}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="px-4 py-2.5 border-t border-line text-[11.5px] text-ash leading-relaxed">
          Every team plays every other once. These places become the bracket seeds.
        </p>
      </div>
    </section>
  );
}

// ── Everything else ─────────────────────────────────────────────────────────
// Sign-in requirements are stated ON the card rather than discovered at a login
// page. That honesty is the whole reason this page exists.
const LINKS = [
  { href: '/rosters', title: 'Rosters', body: 'Every team, split by Tank, DPS and Healer.' },
  { href: '/picks', title: 'Every pick', body: 'The full draft record, in order, filterable.' },
  { href: '/watch', title: 'Live scene', body: 'The broadcast view — the draft clock or the bracket.' },
  { href: '/bracket', title: 'Bracket', body: 'Every series, map and scoreboard.', signIn: true },
  { href: '/predictions', title: 'Predictions', body: 'Call the season and take a place on the leaderboard.', signIn: true },
  { href: '/leaderboard', title: 'Leaderboard', body: 'Who has called it best so far.', signIn: true },
];

function Explore({ t }) {
  return (
    <section>
      <h2 className="eyebrow mb-2.5">The tournament</h2>
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {LINKS.map((l) => (
          <a
            key={l.href}
            href={l.href}
            className="panel p-4 flex flex-col gap-1.5 hover:border-crimson transition-colors"
          >
            <div className="flex items-baseline gap-2">
              <span className="font-display text-[16px]">{l.title}</span>
              {l.signIn && (
                <span className="text-[9px] uppercase tracking-[0.12em] text-dim">sign in</span>
              )}
            </div>
            <p className="text-[12.5px] text-ash leading-relaxed">{l.body}</p>
          </a>
        ))}
      </div>
      {t?.open && (
        <p className="text-[12px] text-dim mt-3">
          Signing in uses Discord, and you have to be in the tournament server.
        </p>
      )}
    </section>
  );
}

function Format({ t }) {
  const size = t?.roster_size || 66;
  const parties = t?.party_count || 8;
  const per = t?.party_size || 6;
  const subs = t?.sub_count ?? 18;

  return (
    <section>
      <h2 className="eyebrow mb-2.5">How it works</h2>
      <div className="grid gap-2.5 sm:grid-cols-3">
        <Card title={`${size} a team`}>
          {parties} parties of {per} take the field — {parties * per} starters — with {subs}{' '}
          substitutes behind them.
        </Card>
        <Card title="Drafted live">
          Captains pick in snake order on a clock. Miss it and the board picks for you.
        </Card>
        <Card title="Seed, then knock out">
          Every team plays every other once. That table seeds a double-elimination
          bracket, and the final is a single best-of-five.
        </Card>
      </div>
    </section>
  );
}

const Card = ({ title, children }) => (
  <div className="panel p-4 flex flex-col gap-1.5">
    <div className="font-display text-[16px]">{title}</div>
    <p className="text-[12.5px] text-ash leading-relaxed">{children}</p>
  </div>
);

function Footer() {
  return (
    <footer className="border-t border-line pt-5 flex items-center gap-4 flex-wrap">
      <a
        href={DISCORD_INVITE}
        target="_blank"
        rel="noreferrer noopener"
        className="text-[13px] text-ash hover:text-crimsonbright underline underline-offset-2"
      >
        Join the tournament Discord ↗
      </a>
      <span className="flex-1" />
      <span className="text-[11.5px] text-dim">
        Run on Discord. Sign in with the account you play on.
      </span>
    </footer>
  );
}

function Badge({ children, tone = 'quiet' }) {
  const tones = {
    quiet: 'border-line bg-panelup text-ash',
    good: 'border-verdigris/45 bg-verdigrisdeep text-verdigris',
    bad: 'border-oxblood/60 bg-oxblooddeep text-crimsonbright',
    live: 'border-crimson/55 bg-crimson/15 text-crimsonbright',
  };
  return (
    <span className={`inline-flex items-center gap-2 px-3 py-1 rounded-full border
                      text-[10px] uppercase tracking-[0.14em] font-semibold ${tones[tone]}`}>
      {tone === 'live' && <i className="w-1.5 h-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}
