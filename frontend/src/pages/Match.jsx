// One match: its scoreboard, and the review that produced it.
//
// The review table is the point of this page. An OCR read is a guess — weapon
// icons are the least reliable thing on the scoreboard, non-Latin names come
// back mangled, and the model occasionally invents a row — so nothing is
// written until somebody has looked at it beside the screenshot and said yes.
//
// Rows arrive already matched to the two rosters, so the job is checking rather
// than filling in. The rows that could NOT be matched are pushed to the top,
// because they are the only ones that need a decision.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import api, { errorMessage } from '../api';
import { Panel, Pill, Button, Note, Empty } from '../components/ui';
import { useAuth } from '../auth';
import { WEAPONS } from '@shared/classes.cjs';

// 3254684 → "3.25M". A scoreboard is a wall of seven-digit numbers, and nobody
// reads them digit by digit — they compare them.
export function big(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e4) return `${(v / 1e3).toFixed(0)}k`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(v);
}

export default function Match() {
  const { key } = useParams();
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState(null);

  // The review, held in the browser until it is committed. Null means there is
  // nothing under review — either it was never started, or it has been saved.
  const [review, setReview] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const { data: d } = await api.get(`/api/stats/match/${encodeURIComponent(key)}`);
      setData(d);
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err, 'Could not read that match.') });
    } finally {
      setLoading(false);
    }
  }, [key]);

  useEffect(() => { load(); }, [load]);

  async function parse(file) {
    setBusy(true);
    setBanner(null);
    const form = new FormData();
    form.append('file', file);
    try {
      const { data: d } = await api.post(`/api/organizer/results/parse/${encodeURIComponent(key)}`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      // Unmatched first — they are the rows that need a person, and reading
      // down forty correct rows to find three that don't have one is the job
      // this page exists to avoid.
      const ordered = [...d.rows].sort(
        (a, b) => (a.signup_id ? 1 : 0) - (b.signup_id ? 1 : 0) || (a.rank || 0) - (b.rank || 0)
      );
      setReview({ ...d, rows: ordered });
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function commit() {
    setBusy(true);
    setBanner(null);
    try {
      const { data: d } = await api.post(`/api/organizer/results/commit/${encodeURIComponent(key)}`, {
        rows: review.rows,
      });
      setReview(null);
      setBanner({
        tone: 'good',
        text: `Saved ${d.total} rows — ${d.matched} matched to players`
          + `${d.unmatched ? `, ${d.unmatched} left unmatched` : ''}.`,
      });
      load();
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  const patch = (i, fields) => setReview((prev) => ({
    ...prev,
    rows: prev.rows.map((r, n) => (n === i ? { ...r, ...fields } : r)),
  }));

  if (loading) return <div className="p-8 text-sm text-ash">Loading…</div>;
  if (!data?.match) {
    return (
      <div className="px-6 py-7">
        <h1 className="font-display text-[27px]">Match</h1>
        <p className="text-ash text-sm mt-2">No match called “{key}”.</p>
      </div>
    );
  }

  const m = data.match;
  const canEdit = !!user?.isOrganizer;

  return (
    <div className="px-6 py-7 max-w-[1500px] mx-auto">
      <header className="flex items-end justify-between gap-5 flex-wrap mb-4">
        <div>
          <Link to="/bracket" className="text-xs text-ash hover:text-bone underline underline-offset-2">
            ← bracket
          </Link>
          <h1 className="font-display text-[27px] mt-1">
            {m.team_a?.name || 'TBD'} <span className="text-ash text-[19px]">vs</span> {m.team_b?.name || 'TBD'}
          </h1>
          <p className="text-ash text-sm mt-1 mono">{m.key}</p>
        </div>
        <div className="flex items-center gap-2">
          {m.winner && <Pill tone="good">{m.winner.name} won</Pill>}
          {m.scoreboard_at
            ? <Pill tone="quiet">scoreboard saved</Pill>
            : <Pill tone="crimson">no scoreboard</Pill>}
        </div>
      </header>

      {banner && <div className="mb-4 max-w-[900px]"><Note tone={banner.tone}>{banner.text}</Note></div>}

      {canEdit && !review && (
        <Panel title="Add a scoreboard" className="mb-4 max-w-[900px] border-crimson/25">
          <div className="p-4 flex flex-col gap-3">
            <p className="text-[13px] text-ash leading-relaxed max-w-[70ch]">
              Upload the end-of-match screenshot (or a CSV). It is read, matched against both
              rosters, and shown to you to check — <span className="text-bone">nothing is saved
              until you press save</span>. The winner is never taken from the scoreboard; that
              stays a decision you make on the bracket.
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <input
                ref={fileRef}
                type="file"
                accept="image/*,.csv,text/csv"
                disabled={busy}
                onChange={(e) => e.target.files?.[0] && parse(e.target.files[0])}
                className="text-[13px] text-ash file:mr-3 file:px-3 file:py-1.5 file:rounded file:border
                           file:border-crimson/60 file:bg-crimson/15 file:text-crimsonbright
                           file:text-xs file:font-semibold file:cursor-pointer"
              />
              {busy && <span className="text-xs text-ash">Reading the screenshot…</span>}
              {m.scoreboard_at && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={async () => {
                    await api.delete(`/api/organizer/results/match/${encodeURIComponent(key)}`);
                    load();
                  }}
                  className="ml-auto"
                >
                  Clear saved scoreboard
                </Button>
              )}
            </div>
          </div>
        </Panel>
      )}

      {review && (
        <Review
          review={review}
          busy={busy}
          onPatch={patch}
          onRemove={(i) => setReview((p) => ({ ...p, rows: p.rows.filter((_, n) => n !== i) }))}
          onCancel={() => setReview(null)}
          onCommit={commit}
        />
      )}

      {!review && (
        data.rows.length === 0
          ? <Panel><Empty>No scoreboard has been added for this match yet.</Empty></Panel>
          : <Saved rows={data.rows} match={m} />
      )}
    </div>
  );
}

// ── The review ──────────────────────────────────────────────────────────────
function Review({ review, busy, onPatch, onRemove, onCancel, onCommit }) {
  const live = useMemo(() => ({
    total: review.rows.length,
    matched: review.rows.filter((r) => r.signup_id).length,
  }), [review.rows]);

  // Who each row could be. One list for both teams, labelled by team, because
  // an organizer fixing a row knows the name and not which side it was on.
  const options = review.roster || [];

  return (
    <Panel
      title="Check this before saving"
      subtitle="Rows that could not be matched are at the top"
      className="border-crimson/40"
      right={
        <span className="text-xs text-ash">
          {live.matched} of {live.total} matched to players
        </span>
      }
    >
      {review.warnings?.length > 0 && (
        <div className="px-4 py-3 border-b border-line flex flex-col gap-1">
          {review.warnings.map((w) => (
            <div key={w} className="text-[12.5px] text-crimsonbright">· {w}</div>
          ))}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px] border-collapse">
          <thead>
            <tr className="text-ash text-[10px] uppercase tracking-[0.1em]">
              <th className="text-left px-2 py-2 font-semibold">#</th>
              <th className="text-left px-2 py-2 font-semibold">Name on the scoreboard</th>
              <th className="text-left px-2 py-2 font-semibold">Who is this</th>
              <th className="text-left px-2 py-2 font-semibold">Weapons</th>
              <th className="text-right px-2 py-2 font-semibold">K</th>
              <th className="text-right px-2 py-2 font-semibold">A</th>
              <th className="text-right px-2 py-2 font-semibold">Damage</th>
              <th className="text-right px-2 py-2 font-semibold">Taken</th>
              <th className="text-right px-2 py-2 font-semibold">Healing</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {review.rows.map((r, i) => (
              <tr
                key={`${r.player_name}-${i}`}
                className={`border-t border-line/50 ${r.signup_id ? '' : 'bg-crimson/[0.06]'}`}
              >
                <td className="px-2 py-1.5 mono text-ash">{r.rank || '—'}</td>
                <td className="px-2 py-1.5">
                  <input
                    className="w-full bg-panelup border border-line rounded px-1.5 py-1 text-[12.5px]
                               outline-none focus:border-crimson"
                    value={r.player_name}
                    onChange={(e) => onPatch(i, { player_name: e.target.value })}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <select
                    className={`w-full bg-panelup border rounded px-1.5 py-1 text-[12.5px] outline-none
                      focus:border-crimson ${r.signup_id ? 'border-line' : 'border-crimson/70'}`}
                    value={r.signup_id || ''}
                    onChange={(e) => {
                      const who = options.find((o) => o.id === e.target.value);
                      onPatch(i, { signup_id: who?.id || null, team_id: who?.team_id || null });
                    }}
                  >
                    {/* Not "unknown" — a deliberate choice. Plenty of rows are
                        genuinely nobody's: opponents, spectators, a guild that
                        wandered through. Those must be saveable as such. */}
                    <option value="">— not one of these teams —</option>
                    {options.map((o) => (
                      <option key={o.id} value={o.id}>{o.player_name}</option>
                    ))}
                  </select>
                  {r.match_note === 'ambiguous' && (
                    <div className="text-[10px] text-crimsonbright mt-0.5">
                      two players share this name — pick one
                    </div>
                  )}
                </td>
                <td className="px-2 py-1.5">
                  <div className="flex gap-1">
                    {['weapon_1', 'weapon_2'].map((w) => (
                      <select
                        key={w}
                        className="bg-panelup border border-line rounded px-1 py-1 text-[11.5px]
                                   outline-none focus:border-crimson"
                        value={WEAPONS.includes(r[w]) ? r[w] : ''}
                        onChange={(e) => onPatch(i, { [w]: e.target.value })}
                      >
                        <option value="">{r[w] || '?'}</option>
                        {WEAPONS.map((x) => <option key={x} value={x}>{x}</option>)}
                      </select>
                    ))}
                  </div>
                </td>
                {['kills', 'assists', 'damage_dealt', 'damage_taken', 'healing'].map((f) => (
                  <td key={f} className="px-2 py-1.5">
                    <input
                      inputMode="numeric"
                      className="w-[76px] bg-panelup border border-line rounded px-1.5 py-1 text-[12.5px]
                                 text-right mono outline-none focus:border-crimson"
                      value={r[f] ?? 0}
                      onChange={(e) => onPatch(i, { [f]: e.target.value.replace(/[^0-9]/g, '') })}
                    />
                  </td>
                ))}
                <td className="px-2 py-1.5">
                  <button
                    onClick={() => onRemove(i)}
                    className="text-[11px] text-ash hover:text-crimsonbright underline underline-offset-2"
                  >
                    remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="px-4 py-3 border-t border-line flex items-center gap-2 flex-wrap">
        <Button variant="good" disabled={busy} onClick={onCommit}>
          {busy ? 'Saving…' : `Save ${live.total} rows`}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>Discard</Button>
        <p className="text-xs text-ash ml-2 max-w-[60ch] leading-relaxed">
          Saving replaces any scoreboard already stored for this match. Rows left as “not one of
          these teams” are kept as evidence but counted for nobody.
        </p>
      </div>
    </Panel>
  );
}

// ── The saved scoreboard ────────────────────────────────────────────────────
function Saved({ rows, match }) {
  const [sort, setSort] = useState('damage_dealt');
  const sorted = useMemo(
    () => [...rows].sort((a, b) => (Number(b[sort]) || 0) - (Number(a[sort]) || 0)),
    [rows, sort]
  );

  const col = (field, label) => (
    <th
      className="text-right px-3 py-2 font-semibold cursor-pointer hover:text-bone whitespace-nowrap"
      onClick={() => setSort(field)}
    >
      {label}{sort === field ? ' ▾' : ''}
    </th>
  );

  const unmatched = rows.filter((r) => !r.signup_id).length;

  return (
    <Panel
      title="Scoreboard"
      right={
        <span className="text-xs text-ash">
          {rows.length} rows{unmatched ? ` · ${unmatched} not on either team` : ''}
        </span>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full text-[13px] border-collapse">
          <thead>
            <tr className="text-ash text-[10px] uppercase tracking-[0.1em] border-b border-line">
              <th className="text-left px-3 py-2 font-semibold">#</th>
              <th className="text-left px-3 py-2 font-semibold">Player</th>
              <th className="text-left px-3 py-2 font-semibold">Class</th>
              {col('kills', 'K')}
              {col('assists', 'A')}
              {col('damage_dealt', 'Damage')}
              {col('damage_taken', 'Taken')}
              {col('healing', 'Healing')}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id} className={`border-b border-line/40 ${r.signup_id ? '' : 'opacity-55'}`}>
                <td className="px-3 py-1.5 mono text-ash">{r.rank ?? '—'}</td>
                <td className="px-3 py-1.5">
                  {r.signup_id
                    ? <Link to={`/player/${r.signup_id}`} className="hover:text-crimsonbright underline underline-offset-2">
                        {r.player_name}
                      </Link>
                    : <span title="not on either team">{r.player_name}</span>}
                  {r.team_id && match.team_a && (
                    <span className="text-[10px] text-ash ml-2">
                      {r.team_id === match.team_a.id ? match.team_a.tag || match.team_a.name
                        : match.team_b?.tag || match.team_b?.name}
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-ash text-[12px]">{r.class}</td>
                <td className="px-3 py-1.5 text-right mono">{r.kills}</td>
                <td className="px-3 py-1.5 text-right mono">{r.assists}</td>
                <td className="px-3 py-1.5 text-right mono">{big(r.damage_dealt)}</td>
                <td className="px-3 py-1.5 text-right mono text-ash">{big(r.damage_taken)}</td>
                <td className="px-3 py-1.5 text-right mono">{big(r.healing)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
