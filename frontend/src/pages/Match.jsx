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
import { CLASS_NAMES, WEAPONS_FOR, classify, weaponsLabel } from '@shared/classes.cjs';
import { applySides, candidatesFor } from '@shared/scoreboard.cjs';
import { whenLocal, toLocalInput, fromLocalInput } from '../lib/clock';

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

  // Which team played which colour, chosen BEFORE the read. The organizer was
  // watching the match; asking them is two clicks and beats inferring it from
  // names that have just been through OCR. The inference still runs on the
  // server, but only to argue back if these look reversed.
  const [sides, setSides] = useState({ Yellow: '', Red: '' });

  // Which game of the series is on screen. A best-of-three has up to three
  // scoreboards and they are three different sets of numbers.
  const [game, setGame] = useState(1);

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

  useEffect(() => {
    // Seeded from the bracket's own A/B order so the pickers are never empty,
    // but it is a guess about a colour and the organizer has to confirm it —
    // which is why the button below says so rather than just being enabled.
    if (data?.match?.team_a_id && !sides.Yellow && !sides.Red) {
      setSides({ Yellow: data.match.team_a_id, Red: data.match.team_b_id });
    }
  }, [data?.match?.team_a_id, data?.match?.team_b_id]);   // eslint-disable-line react-hooks/exhaustive-deps

  async function parse(files) {
    setBusy(true);
    setBanner(null);
    const form = new FormData();
    // One field name, appended once per file — a paginated scoreboard is ten
    // screenshots and they are read as one board.
    [...files].forEach((f) => form.append('files', f));
    form.append('yellow_team_id', sides.Yellow);
    form.append('red_team_id', sides.Red);
    form.append('game_number', String(game));
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
        game_number: game,
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

  async function saveSchedule(iso) {
    setBanner(null);
    try {
      await api.put('/api/organizer/bracket/schedule', { key, scheduled_at: iso });
      setBanner({
        tone: 'good',
        text: iso ? `Scheduled for ${whenLocal(iso)}.` : 'Time cleared.',
      });
      load();
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
    }
  }

  async function saveBans(fields) {
    setBanner(null);
    try {
      const { data: d } = await api.put('/api/organizer/bracket/bans', { key, ...fields });
      if (d.stranded?.length) {
        setBanner({
          tone: 'bad',
          text: `Game ${d.stranded.map((x) => x.game_number).join(', ')} `
            + `${d.stranded.length === 1 ? 'was' : 'were'} played on a map that is now banned `
            + `(${d.stranded.map((x) => x.map).join(', ')}) — fix the ban or the game.`,
        });
      }
      load();
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
    }
  }

  async function saveGame(gameNumber, fields) {
    setBanner(null);
    try {
      await api.post('/api/organizer/bracket/game', { key, game_number: gameNumber, ...fields });
      load();
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
    }
  }

  const patch = (i, fields) => setReview((prev) => ({
    ...prev,
    rows: prev.rows.map((r, n) => (n === i ? { ...r, ...fields } : r)),
  }));

  // Changing which team played which colour re-teams EVERY row, including the
  // ones whose name matched nobody. That is the point of the colour deciding
  // it rather than the name.
  // Distinct from the `sides` state above, which is chosen before the upload.
  // This one corrects the sides on a read that already happened, without
  // making somebody upload ten screenshots again to fix two clicks.
  const resideReview = (next) => setReview((prev) => ({
    ...prev,
    sides: next,
    rows: applySides(prev.rows, next, prev.roster),
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
          <p className="text-ash text-sm mt-1">
            <span className="mono">{m.key}</span>
            {m.scheduled_at && <span className="ml-2.5">{whenLocal(m.scheduled_at)}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {m.winner && <Pill tone="good">{m.winner.name} won</Pill>}
          {m.scoreboard_at
            ? <Pill tone="quiet">scoreboard saved</Pill>
            : <Pill tone="crimson">no scoreboard</Pill>}
        </div>
      </header>

      {banner && <div className="mb-4 max-w-[900px]"><Note tone={banner.tone}>{banner.text}</Note></div>}

      {canEdit && <Schedule match={m} onSave={saveSchedule} />}

      <Bans match={m} available={data.mapsAvailable || []} canEdit={canEdit} onSave={saveBans} />

      <Games
        match={m}
        series={data.series}
        games={data.games || []}
        available={data.mapsAvailable || []}
        canEdit={canEdit}
        selected={game}
        onSelect={setGame}
        onSave={saveGame}
      />

      {canEdit && !review && (
        <Panel title={`Add the scoreboard for game ${game}`} className="mb-4 max-w-[900px] border-crimson/25">
          <div className="p-4 flex flex-col gap-3">
            <p className="text-[13px] text-ash leading-relaxed max-w-[70ch]">
              Upload <span className="text-bone">every page</span> of the end-of-match scoreboard
              at once — select all ten screenshots together. They are read, merged on the
              scoreboard's own ranking, matched against both rosters, and shown to you to check.
              Overlapping pages are fine; duplicates collapse and anything the pages disagree
              about is flagged rather than picked for you.
              <span className="text-bone"> Nothing is saved until you press save.</span> The winner
              is never taken from the scoreboard; that stays a decision you make on the bracket.
            </p>
            {/* Set BEFORE the read. The colour decides which team every row
                counts for, so getting it backwards puts a whole match on the
                wrong two teams — and every number would still look plausible. */}
            <div className="flex items-center gap-4 flex-wrap border-t border-b border-line py-3">
              {['Yellow', 'Red'].map((colour) => (
                <label key={colour} className="flex items-center gap-2">
                  <span
                    className={`text-[11px] uppercase tracking-[0.12em] font-semibold ${
                      colour === 'Yellow' ? 'text-[#d8b657]' : 'text-crimsonbright'
                    }`}
                  >
                    {colour} was
                  </span>
                  <select
                    className="bg-panelup border border-line rounded px-2 py-1 text-[12.5px]
                               outline-none focus:border-crimson"
                    value={sides[colour]}
                    onChange={(e) => {
                      const other = colour === 'Yellow' ? 'Red' : 'Yellow';
                      const swapTo = sides[colour];
                      setSides((p) => ({
                        ...p,
                        [colour]: e.target.value,
                        // Two teams, two colours — picking one for a colour
                        // necessarily gives the other colour the other team.
                        [other]: p[other] === e.target.value ? swapTo : p[other],
                      }));
                    }}
                  >
                    <option value="">— choose —</option>
                    {[m.team_a, m.team_b].filter(Boolean).map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </label>
              ))}
              <button
                onClick={() => setSides((p) => ({ Yellow: p.Red, Red: p.Yellow }))}
                className="text-[11.5px] text-ash hover:text-bone underline underline-offset-2"
              >
                swap
              </button>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <input
                ref={fileRef}
                type="file"
                accept="image/*,.csv,text/csv"
                disabled={busy || !sides.Yellow || !sides.Red || sides.Yellow === sides.Red}
                multiple
                onChange={(e) => e.target.files?.length && parse(e.target.files)}
                className="text-[13px] text-ash file:mr-3 file:px-3 file:py-1.5 file:rounded file:border
                           file:border-crimson/60 file:bg-crimson/15 file:text-crimsonbright
                           file:text-xs file:font-semibold file:cursor-pointer"
              />
              {busy && <span className="text-xs text-crimsonbright">Reading… a full board takes a moment.</span>}
              {!busy && (!sides.Yellow || !sides.Red || sides.Yellow === sides.Red) && (
                <span className="text-xs text-crimsonbright">Set both colours first.</span>
              )}
              {(data.games || []).find((x) => x.game_number === game)?.scoreboard_at && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={async () => {
                    await api.delete(`/api/organizer/results/match/${encodeURIComponent(key)}?game=${game}`);
                    load();
                  }}
                  className="ml-auto"
                >
                  Clear game {game}'s scoreboard
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
          onSides={resideReview}
          onRemove={(i) => setReview((p) => ({ ...p, rows: p.rows.filter((_, n) => n !== i) }))}
          onCancel={() => setReview(null)}
          onCommit={commit}
        />
      )}

      {!review && (() => {
        const current = (data.games || []).find((x) => x.game_number === game);
        const rows = current?.rows || [];
        return rows.length === 0
          ? <Panel><Empty>No scoreboard for game {game} yet.</Empty></Panel>
          : <Saved rows={rows} match={m} game={game} />;
      })()}

      {/* Rows recorded before the series split matches into games. Shown rather
          than orphaned into a tab that does not exist. */}
      {!review && (data.looseRows || []).length > 0 && (
        <div className="mt-4">
          <Saved rows={data.looseRows} match={m} game={null} />
        </div>
      )}
    </div>
  );
}

// ── The review ──────────────────────────────────────────────────────────────
function Review({ review, busy, onPatch, onSides, onRemove, onCancel, onCommit }) {
  const live = useMemo(() => ({
    total: review.rows.length,
    matched: review.rows.filter((r) => r.signup_id).length,
  }), [review.rows]);

  const roster = review.roster || [];

  return (
    <Panel
      title="Check this before saving"
      subtitle="The colour says which team a row counts for; “whose stats” says which player on it. Unmatched rows are at the top."
      className="border-crimson/40"
      right={
        <span className="text-xs text-ash">
          {live.matched} of {live.total} rows have a player
        </span>
      }
    >
      {/* Which team played which colour. Inferred from the rows that matched
          confidently, and overridable — nothing on a screenshot says "Yellow is
          The Hamstars", only the players do. */}
      <div className="px-4 py-3 border-b border-line flex items-center gap-4 flex-wrap">
        {['Yellow', 'Red'].map((colour) => (
          <label key={colour} className="flex items-center gap-2">
            <span
              className={`text-[11px] uppercase tracking-[0.12em] font-semibold ${
                colour === 'Yellow' ? 'text-[#d8b657]' : 'text-crimsonbright'
              }`}
            >
              {colour}
            </span>
            <select
              className="bg-panelup border border-line rounded px-2 py-1 text-[12.5px]
                         outline-none focus:border-crimson"
              value={review.sides?.[colour] || ''}
              onChange={(e) => onSides({ ...review.sides, [colour]: e.target.value || null })}
            >
              <option value="">— not set —</option>
              {(review.teams || []).map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
        ))}
        <button
          onClick={() => onSides({ Yellow: review.sides?.Red || null, Red: review.sides?.Yellow || null })}
          className="text-[11.5px] text-ash hover:text-bone underline underline-offset-2"
        >
          swap
        </button>
        <span className="text-[11.5px] text-ash">
          The colour decides which team each row counts for — including rows whose name matched nobody.
        </span>
      </div>

      {review.files?.length > 1 && (
        <div className="px-4 py-2.5 border-b border-line flex flex-wrap gap-x-4 gap-y-1">
          {review.files.map((f) => (
            <span key={f.name} className={`text-[11.5px] ${f.error ? 'text-crimsonbright' : 'text-ash'}`}>
              {f.error ? '✕' : '✓'} {f.name}
              <span className="text-dim"> · {f.error ? 'unreadable' : `${f.rows} rows`}</span>
            </span>
          ))}
        </div>
      )}

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
              <th className="text-left px-2 py-2 font-semibold">Name as read</th>
              <th className="text-left px-2 py-2 font-semibold">Whose stats</th>
              <th className="text-left px-2 py-2 font-semibold">Class</th>
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
                className={`border-t border-line/50 ${
                  r.side_conflict ? 'bg-oxblood/25' : r.signup_id ? '' : 'bg-crimson/[0.06]'
                }`}
              >
                <td className="px-2 py-1.5 mono text-ash whitespace-nowrap">
                  {r.rank || '—'}
                  <span
                    className={`ml-1.5 text-[9px] uppercase ${
                      r.team_color === 'Yellow' ? 'text-[#d8b657]'
                        : r.team_color === 'Red' ? 'text-crimsonbright' : 'text-dim'
                    }`}
                  >
                    {r.team_color ? r.team_color[0] : '?'}
                  </span>
                </td>
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
                    {/* The wording matters. This said "not one of these teams",
                        which reads as a question about WHICH TEAM — and the
                        colour above already decides that. This column decides
                        which PERSON on that team the row's numbers belong to,
                        and leaving it empty means nobody's profile gets them. */}
                    <option value="">— nobody, don't count it —</option>
                    {/* Only the side this row played on. A Yellow row cannot
                        be a Red player, so offering the other roster is
                        offering a hundred wrong answers. */}
                    {candidatesFor(r, roster, review.sides).map((o) => (
                      <option key={o.id} value={o.id}>{o.player_name}</option>
                    ))}
                  </select>
                  {r.match_note === 'ambiguous' && (
                    <div className="text-[10px] text-crimsonbright mt-0.5">
                      two players share this name — pick one
                    </div>
                  )}
                  {r.side_conflict && (
                    <div className="text-[10px] text-crimsonbright mt-0.5">
                      this name is on the other team — check the colour or the name
                    </div>
                  )}
                </td>
                <td className="px-2 py-1.5">
                  {/* ONE class, not two weapons. The weapon pair is what the
                      screenshot shows and what the model reads, but nobody
                      thinks in pairs — a reviewer looking at an icon they don't
                      recognise knows the CLASS, and picking it writes both
                      weapons underneath. Two dropdowns of ten weapons is a
                      hundred combinations, most of which are not a class. */}
                  <select
                    className={`w-full bg-panelup border rounded px-1.5 py-1 text-[12px] outline-none
                      focus:border-crimson ${classify(r.weapon_1, r.weapon_2) ? 'border-line' : 'border-crimson/70'}`}
                    title={weaponsLabel(classify(r.weapon_1, r.weapon_2)) || `${r.weapon_1 || '?'} · ${r.weapon_2 || '?'}`}
                    value={classify(r.weapon_1, r.weapon_2) || ''}
                    onChange={(e) => {
                      const [w1, w2] = WEAPONS_FOR[e.target.value] || [null, null];
                      onPatch(i, { weapon_1: w1, weapon_2: w2 });
                    }}
                  >
                    {/* The unreadable case keeps what the model actually said,
                        so a reviewer can see WHY it failed rather than an empty
                        box that could mean anything. */}
                    <option value="">
                      {r.weapon_1 || r.weapon_2 ? `? ${r.weapon_1 || '?'} · ${r.weapon_2 || '?'}` : '— unknown —'}
                    </option>
                    {CLASS_NAMES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
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
        <p className="text-xs text-ash ml-2 max-w-[62ch] leading-relaxed">
          Saving replaces any scoreboard already stored for this match. Rows left as “nobody” are
          kept as evidence — they still show on this match — but they are not added to anyone's
          totals or profile.
        </p>
      </div>
    </Panel>
  );
}

// ── The saved scoreboard ────────────────────────────────────────────────────
function Saved({ rows, match, game }) {
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
      title={game ? `Game ${game} scoreboard` : 'Scoreboard (recorded before games)'}
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
                <td className="px-3 py-1.5 text-[12px]" title={`${r.weapon_1 || '?'} · ${r.weapon_2 || '?'}`}>
                  {r.class || <span className="text-crimsonbright">unknown</span>}
                </td>
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


// ── The series ──────────────────────────────────────────────────────────────
// One row per game played, plus the next one while the series is live. Not all
// three: an empty game 3 under a finished 2-0 invites somebody to fill it in,
// and a dead rubber recorded as a real game makes the series read 2-1.
function Games({ match, series, games, available, canEdit, selected, onSelect, onSave }) {
  const sides = [match.team_a, match.team_b].filter(Boolean);

  return (
    <Panel
      title="Games"
      subtitle={`Best of ${match.best_of}${series?.decided ? '' : ` · first to ${series?.toWin ?? 2}`}`}
      className="mb-4"
      right={
        <span className="mono text-[15px]">
          <span className={series?.winnerId === match.team_a_id ? 'text-verdigris' : ''}>{series?.winsA ?? 0}</span>
          <span className="text-ash mx-1.5">—</span>
          <span className={series?.winnerId === match.team_b_id ? 'text-verdigris' : ''}>{series?.winsB ?? 0}</span>
        </span>
      }
    >
      <div className="flex flex-col">
        {games.map((g) => {
          const on = g.game_number === selected;
          return (
            <div
              key={g.game_number}
              className={`px-4 py-2.5 border-b border-line/50 last:border-b-0 flex items-center gap-3 flex-wrap
                ${on ? 'bg-crimson/[0.07]' : ''} ${g.dead ? 'opacity-50' : ''}`}
            >
              <button
                onClick={() => onSelect(g.game_number)}
                className={`text-[13px] font-semibold w-[62px] text-left shrink-0 ${
                  on ? 'text-crimsonbright' : 'text-ash hover:text-bone'
                }`}
              >
                Game {g.game_number}
              </button>

              {canEdit ? (
                <select
                  className="bg-panelup border border-line rounded px-2 py-1 text-[12.5px] w-[190px]
                             outline-none focus:border-crimson"
                  value={g.map || ''}
                  onChange={(e) => onSave(g.game_number, { map: e.target.value })}
                >
                  <option value="">— map —</option>
                  {/* Only what survived the bans. A picker that offers a banned
                      map is a picker that will eventually be used to choose
                      one. */}
                  {available.map((x) => <option key={x} value={x}>{x}</option>)}
                  {/* A map recorded before a ban was entered would otherwise
                      vanish from its own row, which reads as data loss. */}
                  {g.map && !available.includes(g.map) && (
                    <option value={g.map}>{g.map} — now banned</option>
                  )}
                </select>
              ) : (
                <span className="text-[12.5px] text-ash w-[190px] truncate">{g.map || 'map not recorded'}</span>
              )}

              {canEdit ? (
                <select
                  className="bg-panelup border border-line rounded px-2 py-1 text-[12.5px]
                             outline-none focus:border-crimson"
                  value={g.winner_team_id || ''}
                  onChange={(e) => onSave(g.game_number, { winner_team_id: e.target.value || null })}
                >
                  <option value="">— not played yet —</option>
                  {sides.map((t) => <option key={t.id} value={t.id}>{t.name} won</option>)}
                </select>
              ) : (
                <span className="text-[12.5px]">
                  {g.winner_team_id
                    ? `${sides.find((t) => t.id === g.winner_team_id)?.name || '—'} won`
                    : <span className="text-ash">not played yet</span>}
                </span>
              )}

              {g.scoreboard_at && (
                <span className="text-[10px] uppercase tracking-[0.1em] text-verdigris">stats</span>
              )}
              {g.dead && (
                <span className="text-[10px] uppercase tracking-[0.1em] text-ash" title="the series was already decided">
                  did not count
                </span>
              )}
            </div>
          );
        })}
      </div>

      {series?.decided && (
        <div className="px-4 py-2.5 border-t border-line text-[12.5px] text-verdigris">
          Series decided — the bracket has advanced. Changing a game here will take that back.
        </div>
      )}
    </Panel>
  );
}


// ── Map bans ────────────────────────────────────────────────────────────────
// One per team, so nine of the eleven maps survive into a best of three.
//
// Shown above the games rather than beside them because a ban is a fact about
// the whole series — it is decided once, before anything is played, and every
// game underneath is picked from what it leaves.
function Bans({ match, available, canEdit, onSave }) {
  const sides = [
    { team: match.team_a, field: 'ban_a', value: match.ban_a },
    { team: match.team_b, field: 'ban_b', value: match.ban_b },
  ].filter((x) => x.team);

  const banned = [match.ban_a, match.ban_b].filter(Boolean);

  return (
    <Panel
      title="Map bans"
      subtitle="One each, before the series starts"
      className="mb-4"
      right={
        <span className="text-xs text-ash">
          {available.length} map{available.length === 1 ? '' : 's'} left
        </span>
      }
    >
      <div className="p-4 flex flex-col gap-3">
        <div className="flex gap-5 flex-wrap">
          {sides.map(({ team, field, value }) => (
            <label key={field} className="flex items-center gap-2">
              <span className="text-[12.5px] text-ash w-[130px] truncate text-right">{team.name} bans</span>
              {canEdit ? (
                <select
                  className="bg-panelup border border-line rounded px-2 py-1 text-[12.5px] w-[170px]
                             outline-none focus:border-crimson"
                  value={value || ''}
                  onChange={(e) => onSave({ [field]: e.target.value })}
                >
                  <option value="">— no ban yet —</option>
                  {/* Their own current ban stays listed so the select can show
                      it; the other team's is left out, because banning it
                      wastes a ban and the server refuses it anyway. */}
                  {[...available, ...(value ? [value] : [])]
                    .sort((a, b) => a.localeCompare(b))
                    .map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              ) : (
                <span className={`text-[12.5px] w-[170px] ${value ? 'text-crimsonbright line-through' : 'text-ash'}`}>
                  {value || 'no ban yet'}
                </span>
              )}
            </label>
          ))}
        </div>

        {/* The whole pool, struck through where banned. The point of showing it
            is that "what is still available" is the question being asked, and
            counting it off two dropdowns is work. */}
        <div className="flex flex-wrap gap-1.5 border-t border-line pt-3">
          {[...available, ...banned].sort((a, b) => a.localeCompare(b)).map((name) => {
            const out = banned.includes(name);
            return (
              <span
                key={name}
                className={`px-2 py-0.5 rounded border text-[11.5px] ${
                  out
                    ? 'border-oxblood/60 text-ash/50 line-through'
                    : 'border-line text-bone'
                }`}
              >
                {name}
              </span>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}


// ── When it is played ───────────────────────────────────────────────────────
// Set in the organizer's own timezone and echoed back with the zone named, the
// same way the signup deadline is — for the same reason, which is that a
// tournament spread across a continent cannot agree on what "8pm" means until
// somebody writes down which 8pm.
//
// Most matches have no time and should not. A losers-bracket round 4 fixture
// has no date until the teams in it exist, and a blank field is the honest
// representation of that.
function Schedule({ match, onSave }) {
  const [value, setValue] = useState(toLocalInput(match.scheduled_at));
  const [busy, setBusy] = useState(false);

  useEffect(() => { setValue(toLocalInput(match.scheduled_at)); }, [match.scheduled_at]);

  const changed = value !== toLocalInput(match.scheduled_at);
  const iso = fromLocalInput(value);

  async function save(next) {
    setBusy(true);
    try { await onSave(next); } finally { setBusy(false); }
  }

  return (
    <Panel title="Scheduled for" className="mb-4 max-w-[560px]">
      <div className="p-4 flex items-center gap-2 flex-wrap">
        <input
          type="datetime-local"
          className="field-input py-1.5 text-[13.5px] w-auto"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button variant="primary" disabled={busy || !changed || (!!value && !iso)} onClick={() => save(iso)}>
          {busy ? 'Saving…' : 'Set'}
        </Button>
        {match.scheduled_at && (
          <Button variant="ghost" disabled={busy} onClick={() => { setValue(''); save(null); }}>
            Clear
          </Button>
        )}
        <span className="text-[12px] text-ash ml-1">
          {iso ? whenLocal(iso) : 'no time set'}
        </span>
      </div>
    </Panel>
  );
}
