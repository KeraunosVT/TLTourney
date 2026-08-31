// Lower thirds — /lower.
//
// The other scenes are full-screen: you cut TO them. This one is meant to sit
// OVER live gameplay in OBS, which makes it a different thing to build.
//
//   TRANSPARENT. The body's colour and its texture are both switched off while
//   this page is mounted and put back on the way out, so an OBS browser source
//   composites it straight onto the game. Everything the strip needs to be
//   readable it paints itself.
//
//   SIZED OFF THE WIDTH, not the height. Every other scene uses vh, which is
//   right for a 16:9 source filling the canvas and wrong here: a producer who
//   makes this source 1920x250 — the natural shape for a lower third — would
//   get 2.5px text. Width is the stable dimension for a strip, so one font-size
//   in vw feeds everything below it in em, the same way PoolPanel is sized.
//
//   IT DISAPPEARS WHEN IT HAS NOTHING TO SAY. A card with no data renders
//   nothing at all rather than an empty frame or a row of dashes — on an
//   overlay, "nothing" is a perfectly good state and a placeholder is a
//   graphic somebody has to notice and remove.
//
//   FORCED DARK. The palette follows a data-theme attribute, and a producer
//   whose browser is set to light would otherwise get a parchment strip over
//   the game. This one pins itself to the dark palette regardless.
//
// URL is the whole interface, because the thing configuring it is a text box in
// OBS:
//
//   /lower?type=matchup                     one card
//   /lower?type=matchup,crowd,series&every=10   cycles them, 10s each
//   /lower?type=player&player=Keraunos      pin one player instead of the top
//   /lower?match=W2-0                       pin the match, rather than following
//   /lower?pos=top&align=right&scale=1.2    where it sits and how big
import { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { useCountdown, countdownLabel, whenShort } from '../lib/clock';
import { big } from './Match';

// Every card this page knows how to draw. They cycle in the order the URL asks
// for them, not in this one — a producer who writes type=crowd,matchup meant
// crowd first.
const KNOWN = ['matchup', 'crowd', 'series', 'player', 'bans', 'next'];

export default function Lower() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);

  const wanted = useMemo(() => {
    const asked = (params.get('type') || 'matchup')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    // A typo in an OBS text box should not blank the overlay mid-broadcast.
    // Unknown names are dropped, and if that leaves nothing we fall back to the
    // one card that is always worth showing.
    const good = asked.filter((t) => KNOWN.includes(t));
    return good.length ? good : ['matchup'];
  }, [params]);

  const every = Math.max(3, Number(params.get('every')) || 12) * 1000;
  const scale = Math.min(4, Math.max(0.3, Number(params.get('scale')) || 1));
  const top = params.get('pos') === 'top';
  const align = ['center', 'right'].includes(params.get('align')) ? params.get('align') : 'left';
  const pinnedMatch = params.get('match') || '';
  const pinnedPlayer = (params.get('player') || '').trim().toLowerCase();

  // ?demo=1 — invented data, so the source can be positioned and sized before
  // there is a tournament to show.
  //
  // This is not a nicety. Somebody sets a browser source up the afternoon
  // before, when no match has been drawn and every card correctly renders
  // nothing — and has no way to tell an empty overlay from a broken URL. The
  // strip carries a DEMO marker precisely because this is the one mode that
  // could reach air by accident, and fake team names on a broadcast are worse
  // than an ugly badge.
  const demo = params.get('demo') === '1';

  // ── Transparent, and dark whatever the browser thinks ─────────────────────
  useEffect(() => {
    const el = document.body;
    const root = document.documentElement;
    const before = {
      background: el.style.background,
      backgroundColor: el.style.backgroundColor,
      backgroundImage: el.style.backgroundImage,
      theme: root.getAttribute('data-theme'),
    };

    el.style.backgroundColor = 'transparent';
    el.style.backgroundImage = 'none';
    root.setAttribute('data-theme', 'dark');

    return () => {
      el.style.background = before.background;
      el.style.backgroundColor = before.backgroundColor;
      el.style.backgroundImage = before.backgroundImage;
      if (before.theme) root.setAttribute('data-theme', before.theme);
      else root.removeAttribute('data-theme');
    };
  }, []);

  // ── The one read ──────────────────────────────────────────────────────────
  // Same public cast route the other scenes use, and no session, for the same
  // reason: OBS carries no cookie. Five seconds rather than two — the server
  // caches this for three, and a lower third is not a clock.
  const [live, setData] = useState(null);
  const data = demo ? DEMO : live;

  const load = useCallback(async () => {
    if (demo) return;
    try {
      const { data: d } = await axios.get(
        `/api/stream/bracket${pinnedMatch ? `?match=${encodeURIComponent(pinnedMatch)}` : ''}`,
      );
      setData(d);
    } catch {
      // Leave the last good frame up. A network blip must not blank an overlay
      // that is on screen — the previous score is still true.
    }
  }, [pinnedMatch, demo]);

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  // ── Rotation ──────────────────────────────────────────────────────────────
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (wanted.length < 2) return undefined;
    const id = setInterval(() => setStep((n) => n + 1), every);
    return () => clearInterval(id);
  }, [wanted.length, every]);

  const focus = data?.focus || null;
  const teams = useMemo(
    () => new Map((data?.teams || []).map((t) => [t.id, t])),
    [data],
  );

  const next = useMemo(() => upNext(data, focus), [data, focus]);
  const player = useMemo(() => spotlight(focus, pinnedPlayer), [focus, pinnedPlayer]);

  // Only the cards that have something to say. A rotation that includes an
  // empty one is a rotation with a blank slot in it, which on a broadcast reads
  // as broken rather than as quiet.
  const ready = wanted.filter((t) => hasContent(t, { focus, next, player }));
  const current = ready.length ? ready[step % ready.length] : null;

  const a = teams.get(focus?.team_a_id) || focus?.team_a || null;
  const b = teams.get(focus?.team_b_id) || focus?.team_b || null;

  // Nothing to say, so nothing on screen. Deliberately not a placeholder: this
  // is an overlay, and an empty frame over gameplay is a graphic somebody has
  // to notice and remove mid-broadcast.
  if (!current) return <Legend wanted={wanted} ready={ready} />;

  return (
    <div
      className={`fixed inset-x-0 flex px-[1.6em] ${top ? 'top-0 pt-[1.4em]' : 'bottom-0 pb-[1.4em]'} ${
        align === 'center' ? 'justify-center' : align === 'right' ? 'justify-end' : 'justify-start'
      }`}
      // One number feeds the whole strip: everything below is in em.
      style={{ fontSize: `${scale}vw` }}
    >
      {/* Keyed on the card so React remounts it — which replays the entrance
          on every change rather than only the first. */}
      <Strip key={current} demo={demo}>
        {current === 'matchup' && <Matchup focus={focus} a={a} b={b} />}
        {current === 'crowd' && <Crowd focus={focus} a={a} b={b} />}
        {current === 'series' && <Series focus={focus} teams={teams} />}
        {current === 'player' && <Player row={player} teams={teams} game={focus?.scoreboardGame} />}
        {current === 'bans' && <Bans focus={focus} a={a} b={b} />}
        {current === 'next' && <Next match={next} teams={teams} serverTime={data?.serverTime} />}
      </Strip>

      <Legend wanted={wanted} ready={ready} showing={current} />
    </div>
  );
}

/**
 * Setup help, revealed by a mouse and only by a mouse.
 *
 * OBS has no cursor, so this never reaches the capture — the same trick the
 * scene switcher on /watch uses. It exists because the interface to this page
 * is a text box in OBS, and the failure mode is a producer looking at an empty
 * overlay with no way to tell whether the URL is wrong or the data is simply
 * not there yet. This distinguishes the two.
 */
function Legend({ wanted, ready, showing }) {
  return (
    <div className="fixed bottom-2 right-2 opacity-0 hover:opacity-100 focus-within:opacity-100
                    transition-opacity bg-panel border border-line rounded p-3 text-[12px]
                    text-ash max-w-[420px] leading-relaxed" style={{ fontSize: 12 }}>
      <div className="text-bone mb-1">Lower thirds</div>
      <div>
        <span className="text-dim">cards:</span> {KNOWN.join(', ')}
      </div>
      <div>
        <span className="text-dim">asked for:</span> {wanted.join(', ')}
        {ready.length !== wanted.length && (
          <span className="text-crimsonbright">
            {' '}— {wanted.filter((t) => !ready.includes(t)).join(', ')} has no data yet
          </span>
        )}
      </div>
      {showing && <div><span className="text-dim">showing:</span> {showing}</div>}
      <div className="mt-1 text-dim">
        ?type=matchup,crowd&amp;every=10&amp;pos=bottom&amp;align=left&amp;scale=1&amp;match=W2-0
      </div>
    </div>
  );
}

// ── Invented data, for positioning the source ───────────────────────────────
// Shaped exactly like the cast route's answer, so every card takes the same
// path it takes on the night. Names are obviously not real ones.
const A_ID = 'demo-a';
const B_ID = 'demo-b';
const DEMO = {
  serverTime: new Date().toISOString(),
  teams: [
    { id: A_ID, name: 'Sample Team One', tag: 'ONE', seed: 1 },
    { id: B_ID, name: 'Sample Team Two', tag: 'TWO', seed: 4 },
  ],
  matches: [
    {
      key: 'W2-1', kind: 'match', status: 'ready', label: 'Winners Round 2',
      team_a_id: A_ID, team_b_id: B_ID,
      // Far enough out that the countdown shows its long form.
      scheduled_at: new Date(Date.now() + 42 * 60 * 1000).toISOString(),
    },
  ],
  focus: {
    key: 'W2-0', label: 'Winners Round 2', best_of: 3, status: 'ready',
    team_a_id: A_ID, team_b_id: B_ID,
    scheduled_at: new Date(Date.now() + 8 * 60 * 1000).toISOString(),
    series: { winsA: 1, winsB: 1, played: 2, decided: false, winnerId: null, toWin: 2 },
    games: [
      { game_number: 1, map: 'Leviathan', winner_team_id: A_ID },
      { game_number: 2, map: 'Morokai', winner_team_id: B_ID },
    ],
    bans_a: ['Talus', 'Daigon'],
    bans_b: ['Adentus', 'Kowazan'],
    crowd: { a: 68, b: 32, total: 100, pct_a: 68, pct_b: 32 },
    scoreboardGame: 2,
    scoreboard: [
      { rank: 1, player_name: 'Sample Player', team_id: A_ID, class: 'Greatsword / Dagger',
        kills: 14, assists: 22, damage_dealt: 1_240_000, damage_taken: 810_000, healing: 96_000 },
      { rank: 2, player_name: 'Another Player', team_id: B_ID, class: 'Wand / Longbow',
        kills: 9, assists: 31, damage_dealt: 980_000, damage_taken: 640_000, healing: 412_000 },
    ],
  },
};

// ── What each card needs before it is worth showing ─────────────────────────
function hasContent(type, { focus, next, player }) {
  switch (type) {
    case 'matchup': return !!(focus?.team_a_id && focus?.team_b_id);
    case 'crowd': return (focus?.crowd?.total || 0) > 0;
    case 'series': return (focus?.games || []).some((g) => g.map || g.winner_team_id);
    case 'player': return !!player;
    case 'bans': return ((focus?.bans_a || []).length + (focus?.bans_b || []).length) > 0;
    case 'next': return !!next;
    default: return false;
  }
}

/** The soonest scheduled match that has not started — and not the one on screen. */
function upNext(data, focus) {
  const now = Date.now();
  return (data?.matches || [])
    .filter((m) => m.kind === 'match'
      && m.status !== 'complete'
      && m.team_a_id && m.team_b_id
      && m.scheduled_at
      && new Date(m.scheduled_at).getTime() > now
      && m.key !== focus?.key)
    .sort((x, y) => new Date(x.scheduled_at) - new Date(y.scheduled_at))[0] || null;
}

/**
 * Who to put on the player card.
 *
 * `?player=` pins somebody by name — the case where a commentator is about to
 * talk about a specific person. Otherwise it is whoever did the most damage in
 * the game that has a scoreboard, which is the row people ask about.
 */
function spotlight(focus, pinned) {
  const rows = focus?.scoreboard || [];
  if (!rows.length) return null;
  if (pinned) {
    return rows.find((r) => (r.player_name || '').toLowerCase() === pinned) || null;
  }
  return [...rows].sort((x, y) => (y.damage_dealt || 0) - (x.damage_dealt || 0))[0] || null;
}

// ── The strip itself ────────────────────────────────────────────────────────
// A scrim, because this sits over moving footage: bone text straight onto
// gameplay is legible for about a second at a time, and a tournament overlay
// has to hold up against a bright sky and a spell effect equally. The crimson
// edge is the brand's one saturated element and does the work of saying whose
// broadcast this is without a logo taking up room.
function Strip({ children, demo }) {
  return (
    <div className="lower-in flex items-stretch max-w-[92vw] rounded-[0.3em] overflow-hidden
                    shadow-[0_0.3em_1.6em_rgba(0,0,0,0.55)]">
      <div className="w-[0.28em] bg-crimson shrink-0" />
      <div className="bg-ink/85 backdrop-blur-[2px] border-y border-r border-line/70
                      px-[1.1em] py-[0.7em] flex items-center gap-[1.2em] min-w-0">
        {children}
        {demo && (
          <span className="text-[0.45em] uppercase tracking-[0.24em] text-crimsonbright
                           border border-crimson/60 rounded px-[0.6em] py-[0.3em] shrink-0">
            demo
          </span>
        )}
      </div>
    </div>
  );
}

const Eyebrow = ({ children }) => (
  <span className="text-[0.5em] uppercase tracking-[0.24em] text-ash whitespace-nowrap">{children}</span>
);

// ── Who is playing ──────────────────────────────────────────────────────────
function Matchup({ focus, a, b }) {
  const s = focus.series || {};
  const decided = s.decided || focus.status === 'complete';

  return (
    <>
      <div className="flex flex-col gap-[0.15em] min-w-0">
        <Eyebrow>{focus.label || focus.key} · best of {focus.best_of}</Eyebrow>

        <div className="flex items-center gap-[0.7em] min-w-0">
          <Team team={a} won={decided && s.winnerId === focus.team_a_id} />

          <span className="mono text-[1.5em] leading-none tabular-nums shrink-0">
            <span className={s.winnerId === focus.team_a_id ? 'text-verdigris' : ''}>{s.winsA ?? 0}</span>
            <span className="text-dim mx-[0.25em]">–</span>
            <span className={s.winnerId === focus.team_b_id ? 'text-verdigris' : ''}>{s.winsB ?? 0}</span>
          </span>

          <Team team={b} won={decided && s.winnerId === focus.team_b_id} />
        </div>
      </div>

      {focus.scheduled_at && !decided && (
        <span className="text-[0.6em] text-ash whitespace-nowrap shrink-0">{whenShort(focus.scheduled_at)}</span>
      )}
    </>
  );
}

function Team({ team, won }) {
  if (!team) return <span className="text-[1.1em] text-dim">TBD</span>;
  return (
    <span className="flex items-baseline gap-[0.35em] min-w-0">
      {team.seed != null && <span className="mono text-[0.55em] text-dim shrink-0">{team.seed}</span>}
      <span className={`text-[1.1em] truncate ${won ? 'text-verdigris' : ''}`}>
        {team.name || team.tag}
      </span>
    </span>
  );
}

// ── How the room called it ──────────────────────────────────────────────────
// Counts, never names — the same rule the scene and the API hold to. There is
// no session behind an overlay, so nobody on it could have agreed to appear.
function Crowd({ focus, a, b }) {
  const c = focus.crowd;
  return (
    <div className="flex flex-col gap-[0.3em] w-[26em] max-w-[80vw]">
      <div className="flex items-baseline justify-between gap-[1em]">
        <Eyebrow>Viewer picks</Eyebrow>
        <span className="text-[0.55em] text-ash whitespace-nowrap">
          {c.total} pick{c.total === 1 ? '' : 's'}
        </span>
      </div>

      <div className="flex h-[0.32em] rounded-full overflow-hidden bg-panelup">
        <div className="bg-crimson transition-[width] duration-500" style={{ width: `${c.pct_a}%` }} />
        <div className="bg-bone/45 transition-[width] duration-500" style={{ width: `${c.pct_b}%` }} />
      </div>

      <div className="flex items-baseline justify-between gap-[1em] text-[0.75em]">
        <span className="truncate">
          <span className="mono text-crimsonbright">{c.pct_a}%</span>{' '}
          <span className="text-ash">{a?.tag || a?.name || '—'}</span>
        </span>
        <span className="truncate text-right">
          <span className="text-ash">{b?.tag || b?.name || '—'}</span>{' '}
          <span className="mono">{c.pct_b}%</span>
        </span>
      </div>
    </div>
  );
}

// ── Game by game ────────────────────────────────────────────────────────────
function Series({ focus, teams }) {
  const games = (focus.games || []).filter((g) => g.map || g.winner_team_id);
  return (
    <>
      <Eyebrow>Games</Eyebrow>
      <div className="flex items-center gap-[1.1em] min-w-0">
        {games.map((g) => {
          const won = teams.get(g.winner_team_id);
          return (
            <span key={g.game_number} className={`flex items-baseline gap-[0.4em] ${g.dead ? 'opacity-45' : ''}`}>
              <span className="mono text-[0.5em] text-dim shrink-0">G{g.game_number}</span>
              <span className="text-[0.85em] truncate">{g.map || '—'}</span>
              {won && <span className="text-[0.7em] text-verdigris shrink-0">{won.tag || won.name}</span>}
            </span>
          );
        })}
      </div>
    </>
  );
}

// ── One player ──────────────────────────────────────────────────────────────
function Player({ row, teams, game }) {
  const team = teams.get(row.team_id);
  return (
    <>
      <div className="flex flex-col gap-[0.15em] min-w-0">
        <Eyebrow>
          {team ? `${team.tag || team.name} · ` : ''}{row.class || 'unknown class'}
          {game ? ` · game ${game}` : ''}
        </Eyebrow>
        <span className="text-[1.15em] truncate">{row.player_name}</span>
      </div>

      <div className="flex items-baseline gap-[1.1em] shrink-0">
        <Figure label="Damage" value={big(row.damage_dealt)} />
        <Figure label="Kills" value={row.kills ?? 0} />
        <Figure label="Healing" value={big(row.healing)} />
      </div>
    </>
  );
}

const Figure = ({ label, value }) => (
  <span className="flex flex-col items-end gap-[0.1em]">
    <span className="text-[0.45em] uppercase tracking-[0.2em] text-ash">{label}</span>
    <span className="mono text-[0.95em] leading-none tabular-nums">{value}</span>
  </span>
);

// ── The bans ────────────────────────────────────────────────────────────────
function Bans({ focus, a, b }) {
  const all = [
    ...(focus.bans_a || []).map((m) => [m, a]),
    ...(focus.bans_b || []).map((m) => [m, b]),
  ];
  return (
    <>
      <Eyebrow>Banned</Eyebrow>
      <div className="flex items-center gap-[1em]">
        {all.map(([map, team]) => (
          <span key={map} className="flex items-baseline gap-[0.35em]">
            <span className="text-[0.85em] line-through text-crimsonbright">{map}</span>
            <span className="text-[0.55em] text-ash">{team?.tag || team?.name}</span>
          </span>
        ))}
      </div>
    </>
  );
}

// ── What is on next ─────────────────────────────────────────────────────────
function Next({ match, teams, serverTime }) {
  const left = useCountdown(match?.scheduled_at, serverTime);
  const a = teams.get(match.team_a_id);
  const b = teams.get(match.team_b_id);

  return (
    <>
      <div className="flex flex-col gap-[0.15em] min-w-0">
        <Eyebrow>Up next · {match.label || match.key}</Eyebrow>
        <span className="text-[1.05em] truncate">
          {a?.name || 'TBD'} <span className="text-dim">vs</span> {b?.name || 'TBD'}
        </span>
      </div>

      <span className="flex flex-col items-end gap-[0.1em] shrink-0">
        <span className="text-[0.45em] uppercase tracking-[0.2em] text-ash">Starts in</span>
        <span className="mono text-[1.05em] leading-none tabular-nums">{countdownLabel(left)}</span>
      </span>
    </>
  );
}
