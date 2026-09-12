// Which guilds turned up — /guilds.
//
// The guild column has been filled in on every scoreboard since migration 012
// and, until this page, was shown nowhere. It is the only thing on a scoreboard
// that says anything about the world outside the tournament: the four teams are
// drafted across guild lines, so this is the answer to "who actually came".
//
// PUBLIC, like /rosters and /picks and for the same reason plus one of its own:
// the people most interested in a guild tally are the guilds, and they are
// largely not in the tournament, have no account, and are following a link out
// of Discord. It reads /api/stream/guilds, which sits above requireAuth.
//
// The one thing it does NOT read publicly is the list of players whose rows
// name two guilds. That is a fix-it queue, it puts names beside the word wrong,
// and it is fetched from the authenticated route only when an organizer is
// looking.
//
// Live, not a snapshot. The tally reads the committed rows and resolves
// spellings through guild_aliases at read time — so committing a board changes
// this page on its next poll, and adding an alias re-counts every board ever
// uploaded without touching one of them.
//
// ── THE SPELLINGS ARE THE HARD PART ─────────────────────────────────────────
// Guild names in this game are full of trailing glyphs — MILK°, JAILEDシ,
// Lotus花粉 — and a trailing glyph is exactly what an OCR pass drops, doubles or
// turns into an HTML entity. One guild has already arrived under four spellings.
// So the page does not just draw the tally: it shows what fed each bar, and
// flags the players whose own rows disagree, which is how the next misread gets
// found without anybody reading a list of thirty names.
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';
import api, { errorMessage } from '../api';
import { useAuth } from '../auth';
import { Sigil } from '../components/Brand';
import { Panel, Pill, Button, Empty, Note } from '../components/ui';
import { big } from './Match';

// Not a team. A row whose side never read belongs to neither, and the tally
// leaves it out of both — see shared/guilds.cjs.
const NO_SIDE = 'var(--chart-none)';
const HUES = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)'];

export default function Guilds() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [conflicts, setConflicts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState('total');

  // Plain axios, not the api client: this page is reached without a session and
  // the route it reads sits above requireAuth.
  const load = useCallback(async () => {
    try {
      const { data: d } = await axios.get('/api/stream/guilds');
      setData(d);
      setError(null);
    } catch (err) {
      // A dropped refresh leaves the numbers already on screen, which are still
      // true. Only a page that never loaded says anything.
      setData((prev) => {
        if (!prev) setError(errorMessage(err, 'Could not read the guilds.'));
        return prev;
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Slowly. This only changes when an organizer commits a scoreboard, which
  // happens a few times a night — the same reasoning as the rosters page.
  useEffect(() => {
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  // Organizers only, and on its own request. The public payload deliberately
  // does not carry this — see the note at the top of the file. A failure here
  // is silent: it is an extra panel, not the page.
  useEffect(() => {
    if (!user?.isOrganizer) { setConflicts([]); return undefined; }
    let live = true;
    api.get('/api/stats/guilds')
      .then(({ data: d }) => { if (live) setConflicts(d.conflicts || []); })
      .catch(() => {});
    return () => { live = false; };
  }, [user?.isOrganizer, data?.rows]);

  const teams = useMemo(() => (data?.teams || []), [data]);

  // Colour follows the TEAM, not its position in this list. A team with nobody
  // from a given guild would otherwise shift every colour after it.
  const hueOf = useMemo(() => {
    const m = new Map();
    teams.forEach((t, i) => m.set(t.id, HUES[i % HUES.length]));
    return m;
  }, [teams]);

  const guilds = data?.guilds || [];

  // The axis is drawn to a round number above the tallest bar, so the ticks are
  // tens rather than whatever the biggest guild happens to be.
  const scale = useMemo(() => {
    const top = Math.max(1, ...guilds.map((g) => g.players));
    const step = top <= 20 ? 5 : 10;
    return Math.ceil(top / step) * step;
  }, [guilds]);

  const ticks = useMemo(() => {
    const step = scale <= 20 ? 5 : 10;
    return Array.from({ length: scale / step + 1 }, (_, i) => i * step);
  }, [scale]);

  if (loading) return <div className="p-8 text-sm text-ash">Loading the guilds…</div>;

  const merged = guilds.filter((g) => g.spellings.length > 1);
  const players = guilds.reduce((n, g) => n + g.players, 0);

  return (
    <div className="min-h-screen px-5 py-7 max-w-[1100px] mx-auto">
      {/* Its own header, like /rosters: this page is reached from a link in
          Discord as often as from the rail, and a page with no session has no
          rail to sit in. */}
      <header className="flex items-end justify-between gap-5 flex-wrap mb-4">
        <div className="flex items-center gap-3">
          <Sigil size={38} />
          <div>
            <h1 className="font-display text-[26px] leading-none">Guilds</h1>
            <p className="text-ash text-[13px] mt-1.5 max-w-[70ch]">
              Every guild read off a committed scoreboard, by how many players carried it.
              The teams are drafted across guild lines — the split says who is feeding whom.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {data?.rows > 0 && <Pill tone="quiet">{data.rows} rows</Pill>}
          {conflicts.length > 0 && (
            <Pill tone="crimson">
              {conflicts.length} spelling{conflicts.length === 1 ? '' : 's'} to check
            </Pill>
          )}
          <Link
            to="/rosters"
            className="text-[12.5px] text-ash hover:text-bone underline underline-offset-2"
          >
            rosters →
          </Link>
        </div>
      </header>

      {error && <div className="mb-4 max-w-[900px]"><Note tone="bad">{error}</Note></div>}

      {guilds.length === 0 ? (
        <Panel>
          <Empty>
            No scoreboards have been committed yet — add one from a match on the bracket, and
            the guilds on it will appear here.
          </Empty>
        </Panel>
      ) : (
        <>
          <Panel
            title="Players fielded, by guild"
            subtitle="One player counts once, however many games they played."
            right={
              <div className="flex items-center gap-2">
                <Button
                  variant={mode === 'total' ? 'primary' : 'ghost'}
                  onClick={() => setMode('total')}
                >
                  Total
                </Button>
                <Button
                  variant={mode === 'team' ? 'primary' : 'ghost'}
                  onClick={() => setMode('team')}
                >
                  Split by team
                </Button>
              </div>
            }
          >
            {/* A legend whenever there is more than one colour on screen —
                identity never rests on colour alone. */}
            {mode === 'team' && (
              <div className="px-4 py-3 border-b border-line flex flex-wrap gap-x-5 gap-y-1.5">
                {teams.map((t) => (
                  <span key={t.id} className="inline-flex items-center gap-2 text-[12px] text-ash">
                    <i
                      className="w-2.5 h-2.5 rounded-sm shrink-0"
                      style={{ background: hueOf.get(t.id) }}
                    />
                    {t.tag || t.name}
                  </span>
                ))}
              </div>
            )}

            <div className="p-4">
              <div className="relative">
                {/* Hairlines behind the bars only — they stop at the last bar
                    rather than running down through the tick labels. */}
                <div
                  className="absolute inset-y-0 pointer-events-none"
                  style={{ left: 'calc(var(--label-w) + 12px)', right: 'calc(var(--value-w) + 12px)' }}
                >
                  {ticks.map((n) => (
                    <i
                      key={n}
                      className="absolute inset-y-0 w-px bg-line/60"
                      style={{ left: `${(n / scale) * 100}%` }}
                    />
                  ))}
                </div>

                <div className="[--label-w:132px] [--value-w:30px] sm:[--label-w:150px]">
                  {guilds.map((g) => (
                    <GuildRow
                      key={g.name}
                      guild={g}
                      mode={mode}
                      scale={scale}
                      teams={teams}
                      hueOf={hueOf}
                    />
                  ))}
                </div>
              </div>

              <div
                className="mt-2 relative h-4 [--label-w:132px] [--value-w:30px] sm:[--label-w:150px]"
                style={{ marginLeft: 'calc(var(--label-w) + 12px)', marginRight: 'calc(var(--value-w) + 12px)' }}
              >
                {ticks.map((n) => (
                  <span
                    key={n}
                    className="absolute top-0 -translate-x-1/2 mono text-[10.5px] text-dim"
                    style={{ left: `${(n / scale) * 100}%` }}
                  >
                    {n}
                  </span>
                ))}
              </div>
              <p className="text-[11px] text-dim mt-5">players</p>
            </div>

            {data?.noGuild > 0 && (
              <p className="px-4 pb-4 text-[11.5px] text-dim max-w-[76ch]">
                {data.noGuild} row{data.noGuild === 1 ? '' : 's'} carried no guild at all and
                {data.noGuild === 1 ? ' is' : ' are'} in none of the bars above — a column that
                never read, kept out rather than folded into anybody.
              </p>
            )}
          </Panel>

          {/* THE ONE THAT EARNS ITS PLACE. A player is on one scoreboard per
              game, so two of their games naming two guilds is a misread rather
              than a transfer — and it is the strongest evidence there is that
              two spellings are one guild, found by the data arguing with itself
              instead of by somebody scanning a list of thirty names. */}
          {conflicts.length > 0 && (
            <Panel
              title="Spellings that need a decision"
              subtitle="Organizers only. These players' own rows name two guilds, and one person cannot be in two on one night."
              className="mt-4 border-crimson/40"
            >
              <div className="flex flex-col">
                {conflicts.map((c) => (
                  <div key={c.player_name} className="px-4 py-2.5 border-b border-line/50 last:border-b-0">
                    <div className="text-[13px]">{c.player_name}</div>
                    <div className="text-[12px] text-ash mt-0.5">
                      read as{' '}
                      {c.spellings.map((s, i) => (
                        <Fragment key={s}>
                          {i > 0 && <span className="text-dim"> and </span>}
                          <span className="mono text-crimsonbright">{s}</span>
                        </Fragment>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <p className="px-4 py-3 border-t border-line text-[11.5px] text-ash max-w-[80ch]">
                Add a row to <span className="mono">guild_aliases</span> mapping the wrong
                spelling to the right one and every board ever uploaded re-counts on the next
                read — the stored rows are left exactly as they came off the screenshot.
              </p>
            </Panel>
          )}

          <Panel
            title="The same numbers, in full"
            subtitle={`${guilds.length} guild${guilds.length === 1 ? '' : 's'} · ${players} players · totals across every game`}
            className="mt-4"
          >
            <div className="overflow-x-auto">
              <table className="w-full text-[13px] border-collapse">
                <thead>
                  <tr className="text-ash text-[10px] uppercase tracking-[0.1em] border-b border-line">
                    <th className="text-left px-3 py-2 font-semibold">Guild</th>
                    <th className="text-right px-3 py-2 font-semibold">Players</th>
                    {teams.map((t) => (
                      <th key={t.id} className="text-right px-3 py-2 font-semibold whitespace-nowrap">
                        <i
                          className="inline-block w-2 h-2 rounded-sm mr-1.5"
                          style={{ background: hueOf.get(t.id) }}
                        />
                        {t.tag || t.name}
                      </th>
                    ))}
                    <th className="text-right px-3 py-2 font-semibold">K</th>
                    <th className="text-right px-3 py-2 font-semibold">Damage</th>
                    <th className="text-right px-3 py-2 font-semibold">Healing</th>
                  </tr>
                </thead>
                <tbody>
                  {guilds.map((g) => (
                    <tr key={g.name} className="border-b border-line/40 hover:bg-panelup/50">
                      <td className="px-3 py-1.5">
                        {g.name}
                        {/* What fed this bar. A guild counted from three
                            spellings is the alias table working, and it should
                            be visible rather than taken on trust. */}
                        {g.spellings.length > 1 && (
                          <span
                            className="text-[10px] text-dim ml-2"
                            title={g.spellings.join(' · ')}
                          >
                            {g.spellings.length} spellings
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-right mono">{g.players}</td>
                      {teams.map((t) => (
                        <td
                          key={t.id}
                          className={`px-3 py-1.5 text-right mono ${g.byTeam[t.id] ? '' : 'text-dim'}`}
                        >
                          {g.byTeam[t.id] || 0}
                        </td>
                      ))}
                      <td className="px-3 py-1.5 text-right mono">{g.kills}</td>
                      <td className="px-3 py-1.5 text-right mono">{big(g.damage_dealt)}</td>
                      <td className="px-3 py-1.5 text-right mono text-ash">{big(g.healing)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {merged.length > 0 && (
              <p className="px-4 py-3 border-t border-line text-[11.5px] text-ash max-w-[80ch]">
                {merged.map((g) => g.name).join(', ')}{' '}
                {merged.length === 1 ? 'is' : 'are'} counted from more than one spelling, folded
                together by the alias table. Hover the count to see which.
              </p>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

// One bar. Split mode stacks the teams with a 2px gap of the panel showing
// through between them — the separation is the gap, never a stroke, which would
// add ink that is not data.
function GuildRow({ guild, mode, scale, teams, hueOf }) {
  const width = (guild.players / scale) * 100;

  const segments = mode === 'team'
    ? teams
      .map((t) => ({ id: t.id, label: t.tag || t.name, n: guild.byTeam[t.id] || 0, hue: hueOf.get(t.id) }))
      .filter((s) => s.n > 0)
    : [{ id: 'all', label: 'players', n: guild.players, hue: 'var(--color-crimson)' }];

  // In split mode the bar is as long as the segments actually drawn, not as
  // long as `players` — a guild with somebody on no side would otherwise show a
  // stack shorter than its own bar with an unexplained gap at the end.
  const drawn = segments.reduce((n, s) => n + s.n, 0);
  const barWidth = mode === 'team' ? (drawn / scale) * 100 : width;

  const title = `${guild.name} — ${guild.players} player${guild.players === 1 ? '' : 's'}`
    + (segments.length && mode === 'team'
      ? `: ${segments.map((s) => `${s.n} ${s.label}`).join(', ')}` : '')
    + `. ${guild.kills} kills.`
    + (guild.spellings.length > 1 ? ` Counted from: ${guild.spellings.join(', ')}.` : '');

  return (
    <div
      className="grid items-center gap-3 py-[3px] rounded-sm hover:bg-crimson/[0.07]"
      style={{ gridTemplateColumns: 'var(--label-w) 1fr var(--value-w)' }}
      title={title}
    >
      <div className="text-[12.5px] text-right truncate">{guild.name}</div>
      <div className="flex gap-[2px] h-[15px]" style={{ width: `${barWidth}%` }}>
        {segments.map((s, i) => (
          <div
            key={s.id}
            className={`h-full ${i === segments.length - 1 ? 'rounded-r-[4px]' : ''}`}
            style={{ width: `${(s.n / (drawn || 1)) * 100}%`, background: s.hue, minWidth: '2px' }}
          />
        ))}
      </div>
      <div className="mono text-[12px] text-ash text-right">{guild.players}</div>
    </div>
  );
}
