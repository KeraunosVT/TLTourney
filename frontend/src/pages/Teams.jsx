import { useCallback, useEffect, useMemo, useState } from 'react';
import api, { errorMessage } from '../api';
import { Panel, Pill, Button, Empty, Note, Field } from '../components/ui';
import { CAPTAIN_SEATS } from '@shared/captains.cjs';
import { safeInvite, INVITE_HINT, MAX_INVITE } from '@shared/invites.cjs';
import { validateTrade, describeTrade } from '@shared/trades.cjs';

export default function Teams() {
  const [teams, setTeams] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [readiness, setReadiness] = useState(null);
  const [tournament, setTournament] = useState(null);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState(null);
  const [newName, setNewName] = useState('');
  const [newTag, setNewTag] = useState('');
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/api/organizer/teams');
      setTeams(data.teams || []);
      setCandidates(data.candidates || []);
      setReadiness(data.readiness);
      setTournament(data.tournament);
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err, 'Could not load the teams.') });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e?.preventDefault();
    if (!newName.trim()) return;
    setBusy('new');
    setBanner(null);
    try {
      await api.post('/api/organizer/teams', { name: newName.trim(), tag: newTag.trim() });
      setNewName(''); setNewTag('');
      await load();
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  // Renaming is allowed at any point, draft or no draft — the draft freezes
  // WHICH teams exist and in what order, and it snapshots their ids, never
  // their names. Every screen reads the name live, so a typo fixed in round
  // nine is fixed on the bracket, the overlay and the standings at once.
  //
  // Returns whether it saved, so the row can stay open on a rejected name
  // rather than closing over the text somebody has to retype.
  async function rename(team, fields) {
    setBusy(team.id);
    setBanner(null);
    try {
      await api.put(`/api/organizer/teams/${team.id}`, fields);
      await load();
      return true;
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
      // A conflict is another team holding that name or tag — which may have
      // happened since this page loaded, so refetch before they try again.
      if (err?.response?.status === 409) load();
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function addCaptain(team, seat, signupId) {
    setBusy(team.id);
    setBanner(null);
    try {
      const { data } = await api.post(`/api/organizer/teams/${team.id}/captains`, { signup_id: signupId, seat });
      await load();
      // Seating somebody takes them off every board that had them ranked. Say
      // so — those captains are about to find a name missing and it should not
      // be a mystery.
      if (data?.clearedFrom > 0) {
        setBanner({
          tone: 'good',
          text: `Seated. They were removed from ${data.clearedFrom} draft board${data.clearedFrom === 1 ? '' : 's'} — they're no longer available to draft.`,
        });
      }
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
      // A conflict means what's on screen is stale — the seat, or the person,
      // went somewhere else since this page loaded.
      if (err?.response?.status === 409) load();
    } finally {
      setBusy(null);
    }
  }

  async function removeCaptain(team, captain) {
    setBusy(team.id);
    setBanner(null);
    try {
      await api.delete(`/api/organizer/teams/${team.id}/captains/${captain.id}`);
      await load();
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  // A no-show replaced, an injury, someone added after the draft finished.
  // Goes through the same addToRoster door as a captain seat or a draft pick —
  // the server clears them off every board and says how many, which is worth
  // surfacing for the same reason a captain seating does.
  async function addToRosterManually(team, signupId) {
    setBusy(team.id);
    setBanner(null);
    try {
      const { data } = await api.post(`/api/organizer/teams/${team.id}/roster`, { signup_id: signupId });
      await load();
      if (data?.clearedFrom > 0) {
        setBanner({
          tone: 'good',
          text: `Added. They were removed from ${data.clearedFrom} draft board${data.clearedFrom === 1 ? '' : 's'} — they're no longer available to draft.`,
        });
      }
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
      if (err?.response?.status === 409) load();
    } finally {
      setBusy(null);
    }
  }

  // Only ever offered for a 'manual' entry — the server refuses a captain seat
  // or a draft pick here regardless, but the button is hidden for those too so
  // clicking it doesn't exist as a way to learn that the hard way.
  async function removeFromRoster(team, member) {
    if (!window.confirm(`Remove ${member.player_name} from ${team.name}'s roster?`)) return;
    setBusy(team.id);
    setBanner(null);
    try {
      await api.delete(`/api/organizer/teams/${team.id}/roster/${member.id}`);
      await load();
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  async function remove(team) {
    if (!window.confirm(`Delete ${team.name}? This cannot be undone.`)) return;
    setBusy(team.id);
    try {
      await api.delete(`/api/organizer/teams/${team.id}`);
      await load();
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  async function move(team, delta) {
    const ordered = teams.filter((t) => t.seed != null);
    const i = ordered.findIndex((t) => t.id === team.id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ordered.length) return;
    const next = [...ordered];
    [next[i], next[j]] = [next[j], next[i]];
    setBusy(team.id);
    try {
      await api.post('/api/organizer/teams/reseed', { order: next.map((t) => t.id) });
      await load();
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <div className="p-8 text-sm text-ash">Loading…</div>;

  // Volunteers who are still free — the list shrinks as they're seated, which
  // is the point: what's left is who an organizer still has to place.
  const volunteers = candidates.filter((c) => c.wants_captain);
  const seatsFilled = teams.reduce((n, t) => n + (t.captains?.length || 0), 0);

  return (
    <div className="px-6 py-7 max-w-[1180px] mx-auto">
      <header className="flex items-end justify-between gap-5 flex-wrap mb-5">
        <div>
          <h1 className="font-display text-[27px]">Teams</h1>
          <p className="text-ash text-sm mt-1.5 max-w-[64ch]">
            Each team is {tournament?.party_count}&nbsp;parties of {tournament?.party_size} plus{' '}
            {tournament?.sub_count} subs — {tournament?.roster_size} players, run by a captain and a
            co-captain. Seed order is draft order: the snake starts at seed 1.
          </p>
        </div>
      </header>

      {banner && <div className="mb-4"><Note tone={banner.tone}>{banner.text}</Note></div>}

      {readiness && <Readiness r={readiness} />}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] items-start mt-4">
        <Panel
          title={`${teams.length} team${teams.length === 1 ? '' : 's'}`}
          right={<span className="text-xs text-ash">seed order = draft order</span>}
        >
          {teams.length === 0 && <Empty>No teams yet. Add the first one on the right.</Empty>}
          <div className="flex flex-col">
            {teams.map((t, i) => (
              <div key={t.id} className="px-4 py-3 border-b border-line/50 last:border-b-0 flex items-start gap-3 flex-wrap">
                <div className="flex flex-col items-center gap-0.5 pt-0.5">
                  <button
                    onClick={() => move(t, -1)}
                    disabled={i === 0 || busy === t.id}
                    className="text-ash hover:text-bone disabled:opacity-25 leading-none text-[11px]"
                    aria-label={`Move ${t.name} up`}
                  >▲</button>
                  <span className="mono text-[13px] w-6 text-center">{t.seed ?? '—'}</span>
                  <button
                    onClick={() => move(t, 1)}
                    disabled={i === teams.length - 1 || busy === t.id}
                    className="text-ash hover:text-bone disabled:opacity-25 leading-none text-[11px]"
                    aria-label={`Move ${t.name} down`}
                  >▼</button>
                </div>

                <div className="flex-1 min-w-[200px]">
                  <TeamName
                    team={t}
                    busy={busy === t.id}
                    onSave={(fields) => rename(t, fields)}
                  />
                  <TeamInvite
                    team={t}
                    busy={busy === t.id}
                    onSave={(fields) => rename(t, fields)}
                  />
                  {/* One row per seat, always both, filled or not — an empty
                      co-captain seat is a thing to notice, and it disappears
                      entirely if empty seats aren't drawn. */}
                  <div className="mt-2 flex flex-col gap-1.5">
                    {CAPTAIN_SEATS.map(({ seat, label }) => {
                      const held = t.captains?.find((c) => c.seat === seat);
                      return (
                        <div key={seat} className="flex items-center gap-2 flex-wrap">
                          <span className="text-[10px] uppercase tracking-[0.14em] text-ash w-[74px] flex-none">
                            {label}
                          </span>
                          {held ? (
                            <>
                              <span className="text-[13px]">{held.player_name}</span>
                              <span className="text-[11px] text-ash">
                                {held.role || 'role not set'}
                                {held.classes?.[0] ? ` · ${held.classes[0]}` : ''}
                              </span>
                              <button
                                onClick={() => removeCaptain(t, held)}
                                disabled={busy === t.id}
                                className="text-[11px] text-ash hover:text-crimsonbright underline underline-offset-2"
                              >
                                remove
                              </button>
                            </>
                          ) : (
                            <select
                              className="field-input py-1 text-[12.5px] max-w-[260px]"
                              value=""
                              disabled={busy === t.id || candidates.length === 0}
                              onChange={(e) => e.target.value && addCaptain(t, seat, e.target.value)}
                              aria-label={`${label} for ${t.name}`}
                            >
                              <option value="">
                                {candidates.length ? `— assign a ${label.toLowerCase()} —` : '— nobody available —'}
                              </option>
                              {candidates.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.player_name}{c.wants_captain ? ' ★ volunteered' : ''}
                                  {c.role ? ` — ${c.role}` : ''}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  <Roster team={t} candidates={candidates} busy={busy === t.id} onAdd={addToRosterManually} onRemove={removeFromRoster} />
                </div>

                <Button variant="ghost" onClick={() => remove(t)} disabled={busy === t.id}>Delete</Button>
              </div>
            ))}
          </div>
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel title="Add a team">
            <form className="p-4 flex flex-col gap-3" onSubmit={create}>
              <Field label="Name" htmlFor="tname">
                <input
                  id="tname"
                  className="field-input"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  maxLength={40}
                  placeholder="Iron Vow"
                />
              </Field>
              <Field label="Tag" htmlFor="ttag" optional hint="Short form for the bracket. Up to 6 characters.">
                <input
                  id="ttag"
                  className="field-input mono max-w-[130px] uppercase"
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                  maxLength={6}
                  placeholder="IRV"
                />
              </Field>
              <Button type="submit" disabled={!newName.trim() || busy === 'new'} className="self-start px-4 py-2 text-[13px]">
                {busy === 'new' ? 'Adding…' : 'Add team'}
              </Button>
            </form>
          </Panel>

          <Panel
            title="Captain volunteers"
            right={
              <span className="text-xs text-ash">
                {seatsFilled} of {teams.length * CAPTAIN_SEATS.length} seats filled
              </span>
            }
          >
            {volunteers.length === 0 ? (
              <Empty>
                {seatsFilled > 0
                  ? 'Every volunteer has a seat.'
                  : 'Nobody has volunteered to captain yet.'}
              </Empty>
            ) : (
              <div className="flex flex-col">
                {volunteers.map((c) => (
                  <div key={c.id} className="px-4 py-2 border-b border-line/50 last:border-b-0 text-[13px] flex items-center gap-2 flex-wrap">
                    <span>{c.player_name}</span>
                    <span className="text-[11px] text-ash">
                      {c.role || 'role not set'}{c.classes?.[0] ? ` · ${c.classes[0]}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>

      <Trades teams={teams} onDone={load} setBanner={setBanner} />
    </div>
  );
}

// ── Trades ──────────────────────────────────────────────────────────────────
// Moving players BETWEEN two rosters, which is the one roster change the rest
// of this page cannot make: a drafted player has no remove button, because
// removing their roster row does not remove them — the draft writes it back.
//
// Below the teams rather than beside them, because it is the rarest thing on
// this page and the only one that changes two teams at once. Both rosters are
// drawn in full while a trade is being built: the question being answered is
// "who goes the other way", and it cannot be answered from one list.
//
// Validation is @shared/trades.cjs — the same module the server refuses with.
// So the sentence under the button before it is pressed is the sentence that
// comes back if it is pressed anyway, and a rule can never be enforced in one
// place and not the other.
function Trades({ teams, onDone, setBanner }) {
  const [aId, setAId] = useState('');
  const [bId, setBId] = useState('');
  const [picked, setPicked] = useState(() => new Set());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState([]);
  const [needsMigration, setNeedsMigration] = useState(false);

  const loadHistory = useCallback(async () => {
    try {
      const { data } = await api.get('/api/organizer/trades');
      setHistory(data.trades || []);
      setNeedsMigration(false);
    } catch (err) {
      // A missing table is the state of every database until somebody runs
      // 033, including on the day this ships. Said once, here, rather than as
      // a page-level error that looks like a fault.
      if (err?.response?.status === 503) setNeedsMigration(true);
    }
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const a = teams.find((t) => t.id === aId) || null;
  const b = teams.find((t) => t.id === bId) || null;

  // Clearing the picks when either side changes is not tidiness — a pick is a
  // player ON a team, and keeping it across a change of teams would send
  // somebody from a roster that is no longer on screen.
  const chooseA = (id) => { setAId(id); if (id === bId) setBId(''); setPicked(new Set()); };
  const chooseB = (id) => { setBId(id); if (id === aId) setAId(''); setPicked(new Set()); };

  const toggle = (signupId) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(signupId)) next.delete(signupId); else next.add(signupId);
    return next;
  });

  const rosters = useMemo(
    () => new Map(teams.map((t) => [t.id, t.roster || []])),
    [teams]
  );

  const moves = useMemo(() => {
    if (!a || !b) return [];
    const out = [];
    [[a, b], [b, a]].forEach(([from, to]) => {
      (from.roster || []).forEach((m) => {
        if (picked.has(m.id)) out.push({ signup_id: m.id, from_team_id: from.id, to_team_id: to.id });
      });
    });
    return out;
  }, [a, b, picked]);

  const check = useMemo(
    () => (a && b ? validateTrade(moves, rosters, [a, b]) : null),
    [a, b, moves, rosters]
  );

  async function submit() {
    if (!check?.ok) return;
    setBusy(true);
    setBanner(null);
    try {
      const { data } = await api.post('/api/organizer/trades', {
        team_a_id: a.id,
        team_b_id: b.id,
        moves,
        note: note.trim() || undefined,
      });
      setPicked(new Set());
      setNote('');
      setBanner({
        tone: 'good',
        text: `Traded — ${data.trade.summary}.`
          + (data.seatsEmptied
            ? ` ${data.seatsEmptied} party seat${data.seatsEmptied === 1 ? '' : 's'} emptied.`
            : ''),
      });
      await Promise.all([onDone(), loadHistory()]);
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err, 'Could not make that trade.') });
    } finally {
      setBusy(false);
    }
  }

  const side = (team, other) => (
    <div className="flex-1 min-w-[240px]">
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <span className="text-[13px] font-semibold truncate">{team.name}</span>
        <span className="text-[11px] text-ash mono">
          {sizeFor(check, team.id)}
        </span>
      </div>
      <div className="border border-line rounded max-h-[260px] overflow-y-auto">
        {(team.roster || []).length === 0 && (
          <p className="text-[12px] text-ash px-2.5 py-3">Nobody on this roster yet.</p>
        )}
        {(team.roster || []).map((m) => {
          const isCaptain = m.via === 'captain';
          const on = picked.has(m.id);
          return (
            <label
              key={m.id}
              className={`flex items-center gap-2 px-2.5 py-1.5 border-b border-line/40 last:border-b-0
                text-[12.5px] ${isCaptain ? 'opacity-45' : 'cursor-pointer hover:bg-panelup'}
                ${on ? 'bg-crimson/[0.10]' : ''}`}
              title={isCaptain ? 'Captains are traded by moving the captain seat, not here.' : ''}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={isCaptain || busy}
                onChange={() => toggle(m.id)}
                className="accent-crimson"
              />
              <span className="flex-1 truncate">{m.player_name}</span>
              {isCaptain && <span className="text-[10px] uppercase tracking-[0.1em] text-ash">captain</span>}
              {m.via === 'draft' && m.draft_pick && (
                <span className="text-[10px] text-dim mono">R{m.draft_round}P{m.draft_pick}</span>
              )}
              {/* No "traded" badge here on purpose. The roster read
                  (teams.js ROSTER_ROWS) deliberately does not select
                  traded_from_team_id: PostgREST errors the WHOLE select on an
                  unknown column, and that read feeds the draft — so asking for
                  a column added by 033 would take the draft down on any
                  database that has not run it yet. One line to add once it is
                  applied everywhere; the history below says who moved in the
                  meantime. */}
              {/* The arrow is the only thing on the row that says which way
                  this person is going, and it is the whole point of the form. */}
              {on && <span className="text-crimsonbright text-[11px] mono">→ {other.tag || other.name}</span>}
            </label>
          );
        })}
      </div>
    </div>
  );

  return (
    <Panel
      title="Trade players"
      subtitle="Moves players between two rosters, including drafted ones. The picks stay on the record."
      className="mt-4"
      right={<span className="text-xs text-ash">{history.length} trade{history.length === 1 ? '' : 's'} so far</span>}
    >
      {needsMigration && (
        <div className="px-4 pt-4">
          <Note tone="bad">
            The trades table is missing — run migrations/033_trades.sql in the Supabase SQL editor,
            then migrations/verify.sql. Nothing here will save until you do.
          </Note>
        </div>
      )}

      <div className="p-4 flex flex-col gap-4">
        <div className="flex items-end gap-3 flex-wrap">
          <Field label="Team" htmlFor="trade-a">
            <select id="trade-a" className="field-input py-1.5 text-[13px] min-w-[190px]"
                    value={aId} onChange={(e) => chooseA(e.target.value)} disabled={busy}>
              <option value="">— choose —</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          <span className="text-ash text-[12px] pb-2">and</span>
          <Field label="Team" htmlFor="trade-b">
            <select id="trade-b" className="field-input py-1.5 text-[13px] min-w-[190px]"
                    value={bId} onChange={(e) => chooseB(e.target.value)} disabled={busy}>
              <option value="">— choose —</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
        </div>

        {!a || !b ? (
          <p className="text-[12.5px] text-ash">
            Pick two teams. Tick whoever is moving on each side — a trade can be lopsided, and the
            roster sizes above each list say what it does to both.
          </p>
        ) : (
          <>
            <div className="flex gap-4 flex-wrap">
              {side(a, b)}
              {side(b, a)}
            </div>

            <Field label="Why" htmlFor="trade-note" optional
                   hint="Goes on the record beside the trade. “Sub for Saturday”, “drafted in error”.">
              <input id="trade-note" className="field-input py-1.5 text-[13px]" maxLength={280}
                     value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} />
            </Field>

            <div className="flex items-center gap-3 flex-wrap border-t border-line pt-3">
              <Button variant="primary" disabled={busy || !check?.ok} onClick={submit}>
                {busy ? 'Trading…' : moves.length ? `Trade ${moves.length} player${moves.length === 1 ? '' : 's'}` : 'Trade'}
              </Button>
              {/* The first refusal only. The others are the same list the
                  server would give back, and a stack of red under a button
                  nobody can press yet is noise. */}
              {check && !check.ok && moves.length > 0 && (
                <span className="text-[12px] text-crimsonbright">{check.errors[0]}</span>
              )}
              {check?.ok && (
                <span className="text-[12px] text-ash">{describeTrade(check.moves)}</span>
              )}
            </div>
          </>
        )}
      </div>

      {history.length > 0 && (
        <div className="border-t border-line">
          {history.map((tr) => (
            <div key={tr.id} className="px-4 py-2.5 border-b border-line/40 last:border-b-0 flex items-baseline gap-3 flex-wrap">
              {/* A failed or half-applied trade is listed too. Hiding them is
                  how a half-applied one stays invisible on the only page that
                  would show it. */}
              {tr.status !== 'applied' && (
                <Pill tone={tr.status === 'pending' ? 'bad' : 'quiet'}>
                  {tr.status === 'pending' ? 'half-applied — check the rosters' : 'failed'}
                </Pill>
              )}
              <span className="text-[12.5px] flex-1 min-w-[240px]">{tr.summary}</span>
              {tr.note && <span className="text-[11.5px] text-ash italic">“{tr.note}”</span>}
              <span className="text-[11px] text-dim mono">
                {new Date(tr.created_at).toLocaleDateString()}{tr.made_by ? ` · ${tr.made_by}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// "15 → 14" for the side being read, or just the count before anybody is
// ticked. Reads off the same validation the button uses, so it cannot drift
// from what the trade will actually do.
function sizeFor(check, teamId) {
  const s = check?.sizes?.find((x) => x.team_id === teamId);
  if (!s) return '';
  return s.before === s.after ? `${s.before}` : `${s.before} → ${s.after}`;
}

// The name, which only becomes an input once you ask for it. A team is renamed
// maybe once — a typo a captain spotted, or a roster that picked a better name
// after the draft — and a permanent pair of text boxes on every row would put a
// dozen open fields on a page whose actual job is seating captains.
//
// Name and tag edit TOGETHER because they change together: the tag is the short
// form of the name, and a team renamed from Iron Vow to Iron Oath still showing
// IRV on the bracket is exactly the mistake this exists to fix. Two separate
// pencils would make keeping them in step an extra thing to remember.
function TeamName({ team, busy, onSave }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(team.name);
  const [tag, setTag] = useState(team.tag || '');

  // Opening starts from what the team is called NOW, not from whatever was
  // typed and abandoned last time this row was open.
  function open() {
    setName(team.name);
    setTag(team.tag || '');
    setEditing(true);
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-display text-[17px]">{team.name}</span>
        {team.tag && <span className="mono text-[11px] text-crimson">{team.tag}</span>}
        <button
          onClick={open}
          disabled={busy}
          className="text-[11px] text-ash hover:text-crimsonbright underline underline-offset-2
                     disabled:opacity-45"
        >
          rename
        </button>
      </div>
    );
  }

  async function commit(e) {
    e?.preventDefault();
    const nextName = name.trim();
    const nextTag = tag.trim().toUpperCase();
    if (!nextName) return;

    // Nothing actually changed. Close quietly rather than spend a request and
    // get "Nothing to change" back for having opened the row and thought better
    // of it.
    if (nextName === team.name && nextTag === (team.tag || '')) {
      setEditing(false);
      return;
    }
    if (await onSave({ name: nextName, tag: nextTag })) setEditing(false);
  }

  // Escape abandons from either field — the way out of an edit somebody opened
  // by mistake, without hunting for Cancel.
  const escapes = (e) => { if (e.key === 'Escape') setEditing(false); };

  return (
    <form className="flex items-center gap-2 flex-wrap" onSubmit={commit}>
      <input
        autoFocus
        className="field-input py-1 text-[14px] max-w-[210px]"
        value={name}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={escapes}
        aria-label={`Name for ${team.name}`}
      />
      <input
        className="field-input mono py-1 text-[12px] w-[84px] uppercase"
        value={tag}
        maxLength={6}
        placeholder="tag"
        onChange={(e) => setTag(e.target.value)}
        onKeyDown={escapes}
        aria-label={`Tag for ${team.name}`}
      />
      <Button type="submit" disabled={!name.trim() || busy} className="py-1">
        {busy ? 'Saving…' : 'Save'}
      </Button>
      <Button variant="ghost" type="button" disabled={busy} onClick={() => setEditing(false)} className="py-1">
        Cancel
      </Button>
    </form>
  );
}

// ── The team's own Discord ──────────────────────────────────────────────────
// Sent to every player this team drafts, in the DM that tells them they were
// picked. That is what makes an empty one worth showing rather than hiding: a
// team with no invite still drafts, and its players just get no link — which
// nobody notices until somebody asks where to go on draft night.
function TeamInvite({ team, busy, onSave }) {
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(team.discord_url || '');
  const [error, setError] = useState(null);

  function open() {
    setUrl(team.discord_url || '');
    setError(null);
    setEditing(true);
  }

  if (!editing) {
    return (
      <div className="mt-1 flex items-center gap-2 flex-wrap text-[11.5px]">
        <span className="text-[10px] uppercase tracking-[0.14em] text-ash">Discord</span>
        {team.discord_url ? (
          <a
            href={team.discord_url}
            target="_blank"
            rel="noreferrer noopener"
            className="mono text-ash hover:text-crimsonbright truncate max-w-[240px]"
          >
            {team.discord_url.replace(/^https:\/\//, '')}
          </a>
        ) : (
          // Named as a consequence, not a blank. "not set" would read as
          // optional; this says what it costs.
          <span className="text-oxblood">no invite — drafted players get no link</span>
        )}
        <button
          onClick={open}
          disabled={busy}
          className="text-ash hover:text-crimsonbright underline underline-offset-2 disabled:opacity-45"
        >
          {team.discord_url ? 'change' : 'add'}
        </button>
      </div>
    );
  }

  async function commit(e) {
    e?.preventDefault();
    const next = url.trim();
    if (next === (team.discord_url || '')) return setEditing(false);
    // Checked here with the same function the server uses, so a wrong paste is
    // caught under the field rather than as a banner after a round trip.
    if (next && !safeInvite(next)) return setError(INVITE_HINT);
    setError(null);
    if (await onSave({ discord_url: next })) setEditing(false);
  }

  return (
    <form className="mt-1.5 flex flex-col gap-1" onSubmit={commit}>
      <div className="flex items-center gap-2 flex-wrap">
        <input
          autoFocus
          className="field-input py-1 text-[12.5px] flex-1 min-w-[240px] max-w-[340px]"
          value={url}
          maxLength={MAX_INVITE}
          placeholder="https://discord.gg/…"
          onChange={(e) => { setUrl(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); }}
          aria-label={`Discord invite for ${team.name}`}
        />
        <Button type="submit" disabled={busy} className="py-1">
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="ghost" type="button" disabled={busy} onClick={() => setEditing(false)} className="py-1">
          Cancel
        </Button>
      </div>
      {error && <p className="field-error">{error}</p>}
    </form>
  );
}

// Who plays for this team. Captains are on it from the moment they're seated —
// they're not spectators, they're two of the sixty — which is also why they
// stop appearing in every other captain's available players.
//
// A manual add/remove sits here too, rather than as its own panel, because a
// no-show is dealt with while looking at the roster it broke — not on a
// separate screen with its own copy of who's already on a team.
function Roster({ team, candidates, busy, onAdd, onRemove }) {
  const members = team.roster || [];
  const p = team.progress;

  return (
    <div className="mt-2.5 pt-2.5 border-t border-line/40">
      {members.length > 0 && (
        <>
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[10px] uppercase tracking-[0.14em] text-ash">Roster</span>
            <span className="mono text-[12px]">
              {p?.filled ?? members.length}<span className="text-ash">/{p?.size ?? '—'}</span>
            </span>
            {p?.remaining > 0 && (
              <span className="text-[11px] text-ash">{p.remaining} still to draft</span>
            )}
          </div>
          <div className="mt-1.5 flex gap-1.5 flex-wrap">
            {members.map((m) => (
              <span
                key={m.id}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-line
                           bg-panelup text-[11.5px]"
                title={`${m.role || 'role not set'}${m.classes?.[0] ? ` · ${m.classes[0]}` : ''}`}
              >
                {m.via === 'captain' && <span className="text-crimson text-[9px]">★</span>}
                {m.player_name}
                {/* A captain seat and a draft pick each have their own, more
                    correct way to leave — offering this button for them would
                    only send the click to a 409 the person clicking it can't
                    see coming. */}
                {m.via === 'manual' && (
                  <button
                    onClick={() => onRemove(team, m)}
                    disabled={busy}
                    className="ml-0.5 text-ash hover:text-crimsonbright leading-none"
                    aria-label={`Remove ${m.player_name} from ${team.name}`}
                    title="Remove from roster"
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>
        </>
      )}

      <div className="mt-2 flex items-center gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-[0.14em] text-ash w-[74px] flex-none">
          Add player
        </span>
        <select
          className="field-input py-1 text-[12.5px] max-w-[260px]"
          value=""
          disabled={busy || candidates.length === 0}
          onChange={(e) => e.target.value && onAdd(team, e.target.value)}
          aria-label={`Add a player to ${team.name}'s roster`}
        >
          <option value="">
            {candidates.length ? '— add a substitute or replacement —' : '— nobody available —'}
          </option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.player_name}{c.role ? ` — ${c.role}` : ''}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

// The headline: can this pool fill these teams?
//
// Role figures are shown against the FLOOR — the slots only that role can take.
// The ceiling is there as context, but chasing it would mean recruiting for
// slots the flexible ones already cover.
function Readiness({ r }) {
  const ok = r.short === 0 && r.roles.every((x) => x.short === 0);
  return (
    <Panel
      title="Can the pool fill these teams?"
      right={
        r.teams === 0
          ? <Pill tone="quiet">no teams yet</Pill>
          : ok
            ? <Pill tone="good">yes — every role covered</Pill>
            : <Pill tone="bad">{r.short} short of {r.needed}</Pill>
      }
    >
      <div className="p-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div>
          <div className="eyebrow mb-2">Roster spots</div>
          <div className="mono text-[26px]">{r.approved}<span className="text-ash text-[16px]"> / {r.needed}</span></div>
          <p className="text-xs text-ash mt-1.5 leading-relaxed">
            {r.teams} team{r.teams === 1 ? '' : 's'} × {r.rosterSize} — {r.starters} starting
            and {r.subs} substitute spots.
            {r.short > 0 && <> <span className="text-crimsonbright">{r.short} more signups needed.</span></>}
          </p>
          {r.unanswered > 0 && (
            <p className="text-xs text-ash mt-2">
              {r.unanswered} approved signup{r.unanswered === 1 ? '' : 's'} predate the role
              question and aren't counted below.
            </p>
          )}
        </div>

        <div>
          <div className="eyebrow mb-2">By role — against the minimum each needs</div>
          <div className="flex flex-col gap-2">
            {r.roles.map((x) => {
              const pct = x.min === 0 ? 100 : Math.min(100, (x.have / x.min) * 100);
              return (
                <div key={x.role} className="flex items-center gap-2.5 text-[13px]">
                  <span className="w-[54px] flex-none text-ash">{x.role}</span>
                  <span className="flex-1 h-[9px] rounded bg-panelup overflow-hidden">
                    <i
                      className={`block h-full ${x.short > 0 ? 'bg-oxblood' : 'bg-verdigris/80'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </span>
                  <span className="mono text-[12px] w-[74px] text-right">
                    {x.have}<span className="text-ash">/{x.min}</span>
                  </span>
                  <span className="mono text-[10.5px] text-ash w-[52px] text-right" title="ceiling, if every flexible slot went to this role">
                    max {x.max}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Panel>
  );
}
