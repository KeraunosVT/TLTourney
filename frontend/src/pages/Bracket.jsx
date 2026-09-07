// The bracket.
//
// Winners across the top, losers underneath, grand final at the right — the way
// a double-elimination bracket is drawn everywhere, because people already know
// how to read that and this is not the place to be original.
//
// Rounds are columns, and each column spreads its matches evenly over the full
// height. That is not quite the classic bracket geometry (where a round-2 match
// sits exactly between the two round-1 matches feeding it), but it is close
// enough to read at a glance and it costs no connector-line arithmetic that
// would need redoing for every bye and every bracket size.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api, { errorMessage } from '../api';
import { Panel, Pill, Button, Note, Field } from '../components/ui';
import { useAuth } from '../auth';
import { whenShort } from '../lib/clock';

export default function Bracket() {
  const { user } = useAuth();
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const url = user?.isOrganizer ? '/api/organizer/bracket' : '/api/bracket';
      const { data } = await api.get(url);
      setState(data);
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err, 'Could not read the bracket.') });
    } finally {
      setLoading(false);
    }
  }, [user?.isOrganizer]);

  useEffect(() => { load(); }, [load]);

  // The broadcast links, fetched once and separately. Not folded into the
  // bracket read: they change about twice a season while this page reloads on
  // every result, and a failure to reach them must not take the bracket down.
  const [streams, setStreams] = useState([]);
  useEffect(() => {
    api.get('/api/tournament')
      .then(({ data }) => setStreams(data.tournament?.streams || []))
      .catch(() => {});
  }, []);

  async function record(key, winnerId) {
    setBusy(true);
    setBanner(null);
    try {
      const { data } = await api.post('/api/organizer/bracket/result', { key, winner_team_id: winnerId });
      setState(data);
      if (data.champion) {
        setBanner({ tone: 'good', text: 'That decides it — the tournament has a champion.' });
      } else if (data.reset) {
        setBanner({ tone: 'good', text: 'The losers bracket won — the reset match is live.' });
      }
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
      load();
    } finally {
      setBusy(false);
    }
  }

  const grouped = useMemo(() => {
    const ms = state?.matches || [];
    const by = (bracket) => {
      const mine = ms.filter((m) => m.bracket === bracket);
      const rounds = [...new Set(mine.map((m) => m.round))].sort((a, b) => a - b);
      return rounds.map((round) => ({
        round,
        label: mine.find((m) => m.round === round)?.label || `Round ${round}`,
        matches: mine.filter((m) => m.round === round).sort((a, b) => a.idx - b.idx),
      }));
    };
    return { RR: by('RR'), W: by('W'), L: by('L'), GF: by('GF') };
  }, [state?.matches]);

  if (loading) return <div className="p-8 text-sm text-ash">Loading the bracket…</div>;

  const canRecord = !!user?.isOrganizer;

  return (
    <div className="px-6 py-7">
      <header className="flex items-end justify-between gap-5 flex-wrap mb-4 max-w-[1400px]">
        <div>
          <h1 className="font-display text-[27px]">Bracket</h1>
          <p className="text-ash text-sm mt-1.5 max-w-[70ch]">
            A seeding stage first — every team plays every other once — and the table it
            produces seeds a double-elimination bracket. A team is out on its second loss.
            The grand final is a single best-of-five: no reset, so it ends when it ends.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Where to watch, on the page people are looking at while a series
              is being played. Absent entirely when no stream is set — an empty
              "Watch" heading is worse than no heading. */}
          {streams.map((s) => (
            <a
              key={s.url}
              href={s.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded border border-crimson/55
                         bg-crimson/12 text-crimsonbright text-xs font-semibold
                         hover:bg-crimson/22 transition-colors"
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
                   strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 5.5v13l12-6.5z" />
                <path d="M20 5v14" />
              </svg>
              {s.label}
            </a>
          ))}
          {state?.exists && (
            <>
              <Pill tone="quiet">
                {state.counts.complete} of {state.counts.total} played
              </Pill>
              {state.counts.ready > 0 && <Pill tone="crimson" blip>{state.counts.ready} ready</Pill>}
            </>
          )}
        </div>
      </header>

      {banner && <div className="mb-4 max-w-[900px]"><Note tone={banner.tone}>{banner.text}</Note></div>}

      {state?.champion && <Champion team={state.champion} />}

      {canRecord && <Controls state={state} onDone={load} setBanner={setBanner} />}

      {state?.seeding?.exists && (
        <Seeding
          seeding={state.seeding}
          columns={grouped.RR}
          onPick={record}
          canRecord={canRecord}
          busy={busy}
        />
      )}

      {!state?.exists ? (
        <Panel className="mt-4 max-w-[760px]">
          <div className="p-6 text-center">
            <div className="eyebrow">No bracket yet</div>
            <p className="text-sm text-ash mt-2 max-w-[56ch] mx-auto leading-relaxed">
              {canRecord
                ? 'Draw the seeding stage first — every team plays every other once, and that '
                  + 'table seeds this bracket. Once all of it is played, generate.'
                : 'It will appear here once the seeding stage is finished and the organizers '
                  + 'have drawn it.'}
            </p>
          </div>
        </Panel>
      ) : (
        <div className="mt-4 flex flex-col gap-5">
          <Half title="Winners" columns={grouped.W} onPick={record} canRecord={canRecord} busy={busy} />
          {grouped.L.length > 0 && (
            <Half title="Losers" columns={grouped.L} onPick={record} canRecord={canRecord} busy={busy} tone="loser" />
          )}
          <Half title="Grand Final" columns={grouped.GF} onPick={record} canRecord={canRecord} busy={busy} tone="gf" />
        </div>
      )}
    </div>
  );
}

// ── The seeding stage ───────────────────────────────────────────────────────
// The table first and the fixtures under it, because the table is what the
// stage is FOR — the fixtures are how it got there. Everyone reading this page
// during the group stage is asking "who is seeding first", and answering that
// below six match cards would be answering it last.
function Seeding({ seeding, columns, onPick, canRecord, busy }) {
  const done = seeding.done;
  return (
    <section className="mt-4 flex flex-col gap-3">
      <div className="flex items-baseline gap-3 flex-wrap">
        <h2 className="eyebrow">Seeding stage</h2>
        <span className="text-xs text-ash">
          {seeding.complete} of {seeding.total} played
        </span>
        {done
          ? <Pill tone="good">table final</Pill>
          : <Pill tone="quiet">in progress</Pill>}
      </div>

      <Panel className="max-w-[760px]">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-ash border-b border-line">
              <th className="text-left font-normal px-4 py-2 w-[38px]">#</th>
              <th className="text-left font-normal px-2 py-2">Team</th>
              <th className="text-right font-normal px-2 py-2 w-[54px]">W</th>
              <th className="text-right font-normal px-2 py-2 w-[54px]">L</th>
              {/* Games won minus games lost. It only decides anything when wins
                  and head-to-head have both tied, which in a four-team group is
                  common enough to be worth showing rather than explaining. */}
              <th className="text-right font-normal px-4 py-2 w-[70px]" title="game differential">
                +/&minus;
              </th>
            </tr>
          </thead>
          <tbody>
            {seeding.standings.map((r) => (
              <tr key={r.teamId} className="border-b border-line/40 last:border-b-0">
                <td className="px-4 py-2 mono text-crimson">{r.place}</td>
                <td className="px-2 py-2 truncate">
                  {r.team?.name || '—'}
                  {r.team?.tag && <span className="mono text-[11px] text-ash ml-2">{r.team.tag}</span>}
                </td>
                <td className="px-2 py-2 mono text-right">{r.won}</td>
                <td className="px-2 py-2 mono text-right text-ash">{r.lost}</td>
                <td className={`px-4 py-2 mono text-right ${r.diff > 0 ? 'text-verdigris' : r.diff < 0 ? 'text-oxblood' : 'text-ash'}`}>
                  {r.diff > 0 ? `+${r.diff}` : r.diff}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="px-4 py-2.5 border-t border-line text-[11.5px] text-ash leading-relaxed">
          {done
            ? 'This is the final table — these places are the bracket seeds.'
            : 'Places become the bracket seeds once every fixture is played.'}
          {' '}Ties are broken by the matches between the tied teams, then game
          difference, then draft seed.
        </div>
      </Panel>

      <Half
        title="Fixtures"
        columns={columns}
        onPick={onPick}
        canRecord={canRecord}
        busy={busy}
        tone="seeding"
      />
    </section>
  );
}

// ── One half of the bracket ─────────────────────────────────────────────────
// Scrolls horizontally on its own rather than scrolling the page: a sixteen-team
// bracket is six columns wide and the page around it should stay put.
function Half({ title, columns, onPick, canRecord, busy, tone = 'winner' }) {
  const edge = {
    winner: 'border-line', loser: 'border-oxblood/40',
    gf: 'border-crimson/40', seeding: 'border-line',
  }[tone];
  return (
    <section>
      <h2 className="eyebrow mb-2">{title}</h2>
      <div className={`overflow-x-auto border rounded-md bg-panel/40 ${edge}`}>
        <div className="flex gap-3 p-3 min-w-min">
          {columns.map((col) => (
            <div key={col.round} className="flex flex-col gap-2 min-w-[218px]">
              <div className="text-[10px] uppercase tracking-[0.14em] text-ash px-1 whitespace-nowrap">
                {col.label}
              </div>
              <div className="flex-1 flex flex-col justify-around gap-2">
                {col.matches.map((m) => (
                  <MatchCard key={m.key} m={m} onPick={onPick} canRecord={canRecord} busy={busy} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function MatchCard({ m, onPick, canRecord, busy }) {
  // Missing weapons screenshots, counted. Only for matches that have two teams
  // and are actually played — a pending slot has nobody to be missing one, and
  // a walkover was never played.
  const weaponsShort = m.kind === 'match' && m.team_a_id && m.team_b_id
    ? ['a', 'b'].filter((side) => !m.weapons?.[side]).length
    : 0;
  const [armed, setArmed] = useState(null);

  // A reset that never became live is structure, not a fixture. Shown greyed
  // rather than hidden, because "there might be one more game" is part of
  // reading a double-elimination bracket.
  const dormant = m.is_reset && !m.team_a_id;

  const border = m.status === 'complete' ? 'border-line'
    : m.status === 'ready' ? 'border-crimson/70'
      : 'border-line/50';

  return (
    <div className={`rounded border bg-panelup/60 ${border} ${dormant ? 'opacity-40' : ''}`}>
      <div className="px-2 py-1 border-b border-line/50 flex items-center justify-between gap-2">
        {/* The key doubles as the way into the match's scoreboard — the only
            place a result gets its detail, and where an organizer uploads it. */}
        <Link
          to={`/match/${encodeURIComponent(m.key)}`}
          className="mono text-[10px] text-ash hover:text-crimsonbright underline underline-offset-2"
        >
          {m.key}
        </Link>
        {m.scoreboard_at && <span className="text-[9px] uppercase tracking-[0.1em] text-verdigris">stats</span>}
        {/* The series score, once anything has been played. A bracket card that
            says only who won loses the difference between a 2-0 and a 2-1. */}
        {m.series?.played > 0 && (
          <span className="mono text-[10px] text-ash">{m.series.winsA}—{m.series.winsB}</span>
        )}
        {m.best_of > 1 && m.status !== 'complete' && m.series?.played === 0 && (
          <span className="text-[9px] uppercase tracking-[0.1em] text-dim">bo{m.best_of}</span>
        )}
        {/* Short and without a zone: the card has no room, and a bracket full
            of "EDT" repeated forty times is noise. The match page says it in
            full. */}
        {m.scheduled_at && m.status !== 'complete' && (
          <span className="text-[9.5px] text-ash whitespace-nowrap">{whenShort(m.scheduled_at)}</span>
        )}
        {m.kind === 'walkover' && <span className="text-[9px] uppercase tracking-[0.1em] text-ash">bye</span>}
        {m.status === 'ready' && <span className="text-[9px] uppercase tracking-[0.1em] text-crimsonbright">ready</span>}
        {m.is_reset && !dormant && <span className="text-[9px] uppercase tracking-[0.1em] text-crimsonbright">reset</span>}
        {/* A marker, not a block. Visible from the bracket so nobody has to
            open six match pages to find the one that is missing a comp. */}
        {weaponsShort > 0 && (
          <span
            className="text-[9px] uppercase tracking-[0.1em] text-oxblood whitespace-nowrap"
            title={weaponsShort === 2
              ? 'Neither team has a weapons screenshot'
              : 'One team has no weapons screenshot'}
          >
            {weaponsShort === 2 ? 'no weapons' : 'weapons 1/2'}
          </span>
        )}
      </div>

      {['a', 'b'].map((slot) => {
        const team = m[`team_${slot}`];
        const won = m.winner_team_id && team && m.winner_team_id === team.id;
        const lost = m.status === 'complete' && team && !won;
        const canClick = canRecord && m.status === 'ready' && team && !busy;

        return (
          <button
            key={slot}
            disabled={!canClick}
            onClick={() => (armed === slot ? onPick(m.key, team.id) : setArmed(slot))}
            onBlur={() => setArmed(null)}
            className={`w-full text-left px-2 py-1.5 flex items-center gap-2 border-b border-line/30 last:border-b-0
              ${canClick ? 'hover:bg-crimson/12 cursor-pointer' : 'cursor-default'}
              ${won ? 'bg-verdigris/10' : ''} ${lost ? 'opacity-45' : ''}`}
          >
            <span className="mono text-[10px] text-ash w-4 shrink-0">{team?.seed ?? ''}</span>
            <span className={`text-[12.5px] truncate flex-1 ${won ? 'text-bone' : ''} ${lost ? 'line-through' : ''}`}>
              {team ? team.name : <span className="text-dim italic">{slotHint(m[`slot_${slot}`])}</span>}
            </span>
            {won && <span className="text-verdigris text-[10px] shrink-0">✓</span>}
            {armed === slot && canClick && (
              <span className="text-[9px] uppercase tracking-[0.1em] text-crimsonbright shrink-0">click again</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// An empty slot says where its occupant will come from. "Winner of W2-1" is a
// bracket you can read before it has been played; a blank line is not.
function slotHint(src) {
  if (!src) return '—';
  if (src.type === 'seed') return `Seed ${src.seed}`;
  if (src.type === 'winner') return `Winner of ${src.of}`;
  if (src.type === 'loser') return `Loser of ${src.of}`;
  return '—';
}

function Champion({ team }) {
  return (
    <Panel className="border-verdigris/50 mb-4 max-w-[760px]">
      <div className="p-5 text-center">
        <div className="eyebrow text-verdigris">Champion</div>
        <div className="font-display text-[30px] mt-1">{team.name}</div>
      </div>
    </Panel>
  );
}

// ── Organizer ───────────────────────────────────────────────────────────────
function Controls({ state, onDone, setBanner }) {
  const [busy, setBusy] = useState(null);
  const [confirmText, setConfirmText] = useState('');
  const [showClear, setShowClear] = useState(false);

  async function call(what, fn) {
    setBusy(what);
    setBanner(null);
    try {
      await fn();
      setShowClear(false);
      setConfirmText('');
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
    } finally {
      setBusy(null);
      onDone();
    }
  }

  return (
    <Panel title="Organizer" className="border-crimson/25 max-w-[900px]" right={<span className="text-xs text-ash">only you see this</span>}>
      <div className="p-4 flex flex-col gap-3">
        {state?.unseeded?.length > 0 && (
          <div className="text-[13px] text-crimsonbright leading-relaxed">
            · {state.unseeded.join(', ')} {state.unseeded.length === 1 ? 'has' : 'have'} no seed and
            {state.unseeded.length === 1 ? ' is' : ' are'} left out of the draw. Seed them on the
            Teams page first.
          </div>
        )}

        <div className="flex items-end gap-2 flex-wrap">
          {/* The seeding stage comes first and is drawn from draft order, so it
              can go out the moment the draft ends. */}
          <Button
            variant={state?.seeding?.exists ? 'ghost' : 'good'}
            disabled={busy || state?.counts?.complete > 0}
            onClick={() => call('seeding', () => api.post('/api/organizer/bracket/seeding'))}
          >
            {busy === 'seeding'
              ? 'Drawing…'
              : state?.seeding?.exists ? 'Redraw seeding stage' : 'Draw seeding stage'}
          </Button>

          <Button
            variant={state?.exists ? 'ghost' : 'good'}
            disabled={busy || !state?.seeding?.done || (state?.exists && !state?.canGenerate)}
            onClick={() => call('generate', () => api.post('/api/organizer/bracket/generate'))}
          >
            {busy === 'generate' ? 'Drawing…' : state?.exists ? 'Redraw bracket' : 'Generate bracket'}
          </Button>

          {/* Said before the click rather than as a 409 after it. */}
          {state?.seeding?.exists && !state.seeding.done && (
            <span className="text-xs text-ash self-center">
              {state.seeding.total - state.seeding.complete} seeding{' '}
              {state.seeding.total - state.seeding.complete === 1 ? 'match' : 'matches'} left —
              the bracket is seeded from the final table.
            </span>
          )}

          {state?.exists && (
            <Button
              variant="ghost"
              disabled={busy || state.counts.complete === 0}
              onClick={() => call('undo', () => api.post('/api/organizer/bracket/undo'))}
            >
              Undo last result
            </Button>
          )}

          {state?.exists && (
            <div className="ml-auto">
              {!showClear ? (
                <Button variant="ghost" onClick={() => setShowClear(true)}>Clear bracket…</Button>
              ) : (
                <div className="flex items-end gap-2">
                  <div className="w-[240px]">
                    <Field label="Type the tournament name" hint="Erases every match and every result.">
                      <input
                        className="field-input py-1 text-[13px]"
                        value={confirmText}
                        onChange={(e) => setConfirmText(e.target.value)}
                      />
                    </Field>
                  </div>
                  <Button
                    variant="danger"
                    disabled={busy}
                    onClick={() => call('clear', () => api.delete('/api/organizer/bracket', { data: { confirm: confirmText } }))}
                  >
                    Clear
                  </Button>
                  <Button variant="ghost" onClick={() => { setShowClear(false); setConfirmText(''); }}>
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        {state?.exists && !state?.canGenerate && (
          <p className="text-xs text-ash leading-relaxed max-w-[62ch]">
            Results have been recorded, so the bracket can't be redrawn — redrawing re-pairs
            everybody from scratch. Clear it if you really mean to start over.
          </p>
        )}
        <p className="text-xs text-ash leading-relaxed max-w-[62ch]">
          To record a result, click the winning team on a match marked <span className="text-crimsonbright">ready</span>,
          then click it again to confirm.
        </p>
      </div>
    </Panel>
  );
}
