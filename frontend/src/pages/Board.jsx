// The captain's pre-draft board — private to the team's two captains.
//
// Two columns: the pool on the left, the tiers on the right. Placement is a
// button per tier rather than drag-and-drop, deliberately. Dragging one player
// into a tier is nicer; dragging three hundred is not, and three hundred is the
// actual job. A row of six buttons is one click per player with no aiming, it
// works on a phone, and it costs no dependency.
import { useCallback, useEffect, useMemo, useState } from 'react';
import api, { errorMessage } from '../api';
import { Panel, Pill, Button, Empty, Note } from '../components/ui';
import { useCaptaincy } from '../captaincy';
import { ROLES, POSITIONS } from '@shared/roles.cjs';
import { moveWithin } from '@shared/board.cjs';

export default function Board() {
  const { team } = useCaptaincy();
  const [tiers, setTiers] = useState([]);
  const [entries, setEntries] = useState([]);
  const [pool, setPool] = useState([]);
  const [roster, setRoster] = useState([]);
  const [progress, setProgress] = useState(null);
  const [cover, setCover] = useState(null);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState(null);
  const [busy, setBusy] = useState(null);

  // Filters over the pool. A captain looking to fill their healer slots wants
  // the pool to BE healers for a minute.
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [position, setPosition] = useState('');
  const [shotcallers, setShotcallers] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/api/board');
      setTiers(data.tiers || []);
      setEntries(data.entries || []);
      setPool(data.pool || []);
      setRoster(data.roster || []);
      setProgress(data.progress || null);
      setCover(data.coverage || null);
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err, 'Could not load your board.') });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function place(player, tier) {
    setBusy(player.id);
    setBanner(null);
    try {
      await api.put('/api/board/entry', { signup_id: player.id, tier });
      await load();
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  async function unplace(entry) {
    setBusy(entry.signup_id);
    try {
      await api.delete(`/api/board/entry/${entry.signup_id}`);
      await load();
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  async function move(entry, delta) {
    const ids = entries.filter((e) => e.tier === entry.tier).map((e) => e.signup_id);
    const next = moveWithin(ids, entry.signup_id, delta);
    if (!next) return;  // already at the end of its tier

    // Optimistic: reordering is the one action fast enough that a round trip
    // before the row moves is felt as lag.
    setEntries((prev) => {
      const others = prev.filter((e) => e.tier !== entry.tier);
      const mine = prev.filter((e) => e.tier === entry.tier);
      return [...others, ...next.map((id) => mine.find((e) => e.signup_id === id))];
    });

    try {
      await api.post('/api/board/reorder', { tier: entry.tier, order: next });
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
      load();  // put it back where the server says it is
    }
  }

  async function saveNote(entry, note) {
    if ((entry.note || '') === note.trim()) return;
    try {
      await api.put('/api/board/note', { signup_id: entry.signup_id, note });
      setEntries((prev) => prev.map((e) => (
        e.signup_id === entry.signup_id ? { ...e, note: note.trim() || null } : e
      )));
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
    }
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return pool.filter((p) => (
      (!role || p.role === role)
      && (!position || (p.positions || []).includes(position))
      && (!shotcallers || p.wants_shotcall === true)
      && (!needle
        || p.player_name.toLowerCase().includes(needle)
        || (p.classes || []).some((c) => c.toLowerCase().includes(needle)))
    ));
  }, [pool, q, role, position, shotcallers]);

  if (loading) return <div className="p-8 text-sm text-ash">Loading your board…</div>;

  const byTier = (n) => entries.filter((e) => e.tier === n);

  return (
    <div className="px-6 py-7 max-w-[1320px] mx-auto">
      <header className="flex items-end justify-between gap-5 flex-wrap mb-5">
        <div>
          <h1 className="font-display text-[27px]">Draft board</h1>
          <p className="text-ash text-sm mt-1.5 max-w-[70ch]">
            {team?.name}'s board, visible only to {team?.name}'s captains. Rank the pool before
            draft night so a two-minute clock is a formality rather than a decision.
          </p>
        </div>
        <Pill tone="quiet" blip>private to your team</Pill>
      </header>

      {banner && <div className="mb-4"><Note tone={banner.tone}>{banner.text}</Note></div>}

      {roster.length > 0 && <YourTeam roster={roster} progress={progress} />}

      {cover && <Coverage c={cover} />}

      <div className="grid gap-4 mt-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] items-start">
        {/* ── The pool ─────────────────────────────────────────────────── */}
        <Panel
          title="Available players"
          right={<span className="text-xs text-ash">{filtered.length} of {pool.length} unranked</span>}
        >
          <div className="px-4 py-3 border-b border-line flex flex-col gap-2.5">
            <input
              className="field-input"
              placeholder="Search a name or a class…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <div className="flex gap-2 flex-wrap">
              <select className="field-input py-1 text-[12.5px] w-auto" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="">Any role</option>
                {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              <select className="field-input py-1 text-[12.5px] w-auto" value={position} onChange={(e) => setPosition(e.target.value)}>
                <option value="">Any position</option>
                {POSITIONS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              {/* Explicitly `=== true`: a signup filed before the question
                  existed has null here, and null must not pass a filter for
                  people who said yes. */}
              <label className="inline-flex items-center gap-1.5 text-[12.5px] text-ash cursor-pointer px-1">
                <input
                  type="checkbox"
                  className="w-3.5 h-3.5 accent-[rgb(var(--color-crimson))]"
                  checked={shotcallers}
                  onChange={(e) => setShotcallers(e.target.checked)}
                />
                Shotcallers
              </label>
              {(q || role || position || shotcallers) && (
                <Button
                  variant="ghost"
                  onClick={() => { setQ(''); setRole(''); setPosition(''); setShotcallers(false); }}
                >
                  Clear
                </Button>
              )}
            </div>
          </div>

          {filtered.length === 0 ? (
            <Empty>
              {pool.length === 0
                ? 'Every approved player is on your board.'
                : 'Nobody in the pool matches those filters.'}
            </Empty>
          ) : (
            <div className="flex flex-col max-h-[62vh] overflow-y-auto">
              {filtered.map((p) => (
                <div key={p.id} className="px-4 py-2.5 border-b border-line/50 last:border-b-0">
                  <PlayerLine p={p} />
                  <div className="mt-1.5 flex items-center gap-1 flex-wrap">
                    <span className="text-[10px] uppercase tracking-[0.12em] text-ash mr-1">Place in</span>
                    {tiers.map((t) => (
                      <button
                        key={t.tier}
                        onClick={() => place(p, t.tier)}
                        disabled={busy === p.id}
                        title={t.hint}
                        className={`px-2 py-0.5 rounded border text-[11px] font-semibold transition-colors
                          disabled:opacity-40 ${t.exclude
                            ? 'border-oxblood/60 text-crimsonbright hover:bg-oxblood/30'
                            : 'border-line text-ash hover:text-bone hover:border-crimson'}`}
                      >
                        {t.exclude ? 'Avoid' : t.tier}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        {/* ── The tiers ────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-3">
          {tiers.map((t) => {
            const rows = byTier(t.tier);
            return (
              <Panel
                key={t.tier}
                title={t.label}
                subtitle={t.hint}
                right={<span className="text-xs text-ash">{rows.length}</span>}
                className={t.exclude ? 'border-oxblood/40' : ''}
              >
                {rows.length === 0 ? (
                  <Empty>Nothing here yet.</Empty>
                ) : (
                  <div className="flex flex-col">
                    {rows.map((e, i) => (
                      <div key={e.signup_id} className="px-4 py-2.5 border-b border-line/50 last:border-b-0 flex items-start gap-3">
                        <div className="flex flex-col items-center gap-0.5 pt-0.5">
                          <button
                            onClick={() => move(e, -1)}
                            disabled={i === 0}
                            className="text-ash hover:text-bone disabled:opacity-25 leading-none text-[11px]"
                            aria-label={`Move ${e.player_name} up`}
                          >▲</button>
                          <span className="mono text-[11px] text-ash w-5 text-center">{i + 1}</span>
                          <button
                            onClick={() => move(e, 1)}
                            disabled={i === rows.length - 1}
                            className="text-ash hover:text-bone disabled:opacity-25 leading-none text-[11px]"
                            aria-label={`Move ${e.player_name} down`}
                          >▼</button>
                        </div>
                        <div className="flex-1 min-w-0">
                          <PlayerLine p={e} />
                          <NoteBox entry={e} onSave={saveNote} />
                        </div>
                        <button
                          onClick={() => unplace(e)}
                          disabled={busy === e.signup_id}
                          className="text-[11px] text-ash hover:text-crimsonbright underline underline-offset-2 pt-0.5"
                        >
                          remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Who you already have, and how many picks that leaves. The second number is
// the one captains get wrong: two captains means 58 picks, not 60, so a board
// built to exactly 60 is two players too long.
function YourTeam({ roster, progress }) {
  return (
    <Panel
      title="Your roster"
      right={
        <span className="text-xs text-ash">
          {progress?.remaining ?? '—'} of {progress?.size ?? '—'} still to draft
        </span>
      }
    >
      <div className="p-4 flex gap-1.5 flex-wrap">
        {roster.map((m) => (
          <span
            key={m.id}
            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-line
                       bg-panelup text-[12px]"
            title={`${m.role || 'role not set'}${m.classes?.[0] ? ` · ${m.classes[0]}` : ''}`}
          >
            {m.via === 'captain' && <span className="text-crimson text-[9px]">★</span>}
            {m.player_name}
            <span className="text-[10px] text-ash">{m.role || '—'}</span>
          </span>
        ))}
      </div>
    </Panel>
  );
}

function PlayerLine({ p }) {
  return (
    <div>
      <div className="flex items-baseline gap-2 flex-wrap">
      {/* Drafted players are removed from every board outright, so this should
          not normally appear. It's the fallback for an entry whose deletion
          didn't land — better a name marked unavailable than one that reads as
          free. */}
      <span className={`text-[13.5px] ${p.taken ? 'line-through text-ash/60' : ''}`}>
        {p.player_name}
      </span>
      {p.taken && <span className="text-[10px] uppercase tracking-[0.1em] text-oxblood">taken</span>}
      {p.role && <span className="text-[10px] uppercase tracking-[0.1em] text-crimson">{p.role}</span>}
      <span className="text-[11px] text-ash truncate">
        {(p.classes || []).join(' · ') || 'no class given'}
      </span>
      {/* Worth its own mark on the board: a team needs one or two of these and
          there is no way to tell from a class list who they are. */}
      {p.wants_shotcall && (
        <span className="text-[10px] uppercase tracking-[0.1em] text-verdigris">shotcaller</span>
      )}
        {(p.nights || []).length > 0 && (
          <span className="text-[10px] text-ash/70">{(p.nights || []).join(' ')}</span>
        )}
      </div>

      {/* What they wrote about themselves. The server has been sending this
          since the board existed and the page was dropping it — which is a
          shame, because "can flex healer if you need one" is exactly the thing
          that decides where somebody goes on a board. */}
      {p.notes && <Says text={p.notes} />}
    </div>
  );
}

function Tag({ children }) {
  return (
    <span className="text-[9px] uppercase tracking-[0.14em] text-dim mr-1.5 align-[1px]">
      {children}
    </span>
  );
}

// Clamped to one line, expanded by clicking. Notes run to 500 characters and a
// pool is hundreds long; one line catches most of them whole and signals the
// rest. Labelled and italic so it is never mistaken for the captain's OWN note
// on the same row, which means the opposite thing.
function Says({ text }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      onClick={() => setOpen((v) => !v)}
      title={open ? 'collapse' : text}
      className="mt-0.5 text-left w-full text-[11.5px] text-ash italic leading-snug hover:text-bone"
    >
      <Tag>they said</Tag>
      <span className={open ? '' : 'inline-block max-w-full align-bottom truncate'}>{text}</span>
    </button>
  );
}

// The note only becomes an input once you click it. Three hundred permanently
// open text boxes is a wall of empty rectangles; the note matters on maybe
// twenty of them.
function NoteBox({ entry, onSave }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(entry.note || '');

  useEffect(() => { setText(entry.note || ''); }, [entry.note]);

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className={`mt-0.5 text-left text-[11.5px] leading-snug ${
          entry.note ? 'text-bone/75' : 'text-ash/50 italic'
        } hover:text-crimsonbright`}
      >
        {entry.note ? <><Tag>your note</Tag>{entry.note}</> : 'add a note'}
      </button>
    );
  }

  const commit = () => { setEditing(false); onSave(entry, text); };

  return (
    <input
      autoFocus
      className="field-input mt-1 py-1 text-[12px]"
      value={text}
      maxLength={300}
      placeholder="Why this player, here"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') { setText(entry.note || ''); setEditing(false); }
      }}
    />
  );
}

// Does the board contain a legal roster? A board built only from players you
// find interesting is short of healers, always, and nothing else on this page
// would tell you.
function Coverage({ c }) {
  const short = c.roles.filter((r) => r.short > 0);
  return (
    <Panel
      title="Does your board cover a roster?"
      right={
        short.length === 0
          ? <Pill tone="good">every role covered</Pill>
          : <Pill tone="bad">{short.map((r) => `${r.short} more ${r.role}`).join(', ')}</Pill>
      }
    >
      <div className="p-4 flex items-center gap-6 flex-wrap">
        <div>
          <div className="eyebrow mb-1">Ranked</div>
          <div className="mono text-[24px]">{c.ranked}</div>
          {c.avoided > 0 && <div className="text-[11px] text-ash mt-0.5">{c.avoided} on Avoid</div>}
        </div>
        <div className="flex gap-5 flex-wrap">
          {c.roles.map((r) => (
            <div key={r.role}>
              <div className="eyebrow mb-1">{r.role}</div>
              <div className="mono text-[18px]">
                {r.have}<span className="text-ash text-[13px]">/{r.min}</span>
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-ash max-w-[42ch] leading-relaxed">
          Against the minimum one roster needs — the slots no flexible slot can cover for you.
        </p>
      </div>
    </Panel>
  );
}
