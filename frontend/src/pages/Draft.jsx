// The draft room — the side the people IN the draft look at.
//
// Everything on this page is arranged around one question: whose pick is it,
// and what should they do about it. A captain on the clock should be able to
// make a defensible pick without scrolling, reading, or deciding anything they
// haven't already decided — which is what the pre-draft board was for, and why
// it sits at the top of this page rather than on the other one.
//
// The broadcast layout is a separate page (Watch.jsx) rather than this one
// scaled up. They want opposite things: this page is dense because a captain is
// two feet from it looking for a name, and that one is enormous because a
// viewer is ten feet from it reading two.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api, { errorMessage } from '../api';
import { Panel, Pill, Button, Empty, Note, Field } from '../components/ui';
import { useAuth } from '../auth';
import { useCountdown, mmss, humanDuration } from '../lib/clock';
import { ROLES, POSITIONS } from '@shared/roles.cjs';

export default function Draft() {
  const { user } = useAuth();
  const [state, setState] = useState(null);
  const [admin, setAdmin] = useState(null);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState(null);
  const [picking, setPicking] = useState(null);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    // A slow response must not stack up behind the poll — on draft night the
    // page is open for hours and one stalled request would otherwise become
    // twenty.
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const { data } = await api.get('/api/draft');
      setState(data);
      if (user?.isOrganizer) {
        const { data: a } = await api.get('/api/organizer/draft');
        setAdmin(a);
      }
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err, 'Could not read the draft.') });
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [user?.isOrganizer]);

  useEffect(() => { load(); }, [load]);

  // Polls rather than streams. See the note at the top of backend/draft.js: the
  // countdown is computed locally from a deadline, so the only thing that has
  // to arrive promptly is a pick every minute or two.
  const status = state?.draft?.status;
  useEffect(() => {
    const ms = status === 'live' ? 2000 : 10000;
    const id = setInterval(load, ms);
    return () => clearInterval(id);
  }, [status, load]);

  const d = state?.draft;
  const left = useCountdown(d?.deadline, d?.serverTime);
  const teamsById = useMemo(
    () => Object.fromEntries((state?.teams || []).map((t) => [t.id, t])),
    [state?.teams]
  );

  async function pick(playerId) {
    setPicking(playerId);
    setBanner(null);
    try {
      const { data } = await api.post('/api/draft/pick', {
        signup_id: playerId,
        expected_pick: d.currentPick,
      });
      setBanner({ tone: 'good', text: `Drafted ${data.player.player_name}.` });
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
    } finally {
      setPicking(null);
      load();
    }
  }

  if (loading) return <div className="p-8 text-sm text-ash">Loading the draft…</div>;
  if (!d) {
    return (
      <div className="px-6 py-7 max-w-[900px] mx-auto">
        <h1 className="font-display text-[27px]">Draft</h1>
        {/* The banner carries the real reason when there is one — most likely
            "the draft tables are missing", which a bare "no tournament is
            running" would hide. */}
        {banner ? (
          <div className="mt-4"><Note tone={banner.tone}>{banner.text}</Note></div>
        ) : (
          <p className="text-ash text-sm mt-2">No tournament is running.</p>
        )}
      </div>
    );
  }

  const you = state.you;
  const onClockTeam = teamsById[d.onClock];
  const canPick = you?.onClock && d.status === 'live';

  return (
    <div className="px-6 py-7 max-w-[1500px] mx-auto">
      <header className="flex items-end justify-between gap-5 flex-wrap mb-4">
        <div>
          <h1 className="font-display text-[27px]">Draft</h1>
          <p className="text-ash text-sm mt-1.5">
            {state.tournament?.name}
            {d.rounds > 0 && ` · ${d.rounds} rounds · ${d.totalPicks} picks`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill status={d.status} />
          {/* Opened in its own tab because this is the one you point OBS at,
              and it has no navigation to get back from. */}
          <a
            href="/watch"
            target="_blank"
            rel="noreferrer"
            className="text-xs text-ash hover:text-bone underline underline-offset-2"
          >
            stream view ↗
          </a>
        </div>
      </header>

      {banner && <div className="mb-3"><Note tone={banner.tone}>{banner.text}</Note></div>}

      <ClockBanner draft={d} you={you} team={onClockTeam} left={left} />

      {user?.isOrganizer && (
        <Controls
          admin={admin}
          draft={d}
          teams={state.teams}
          pool={state.pool}
          onDone={load}
          setBanner={setBanner}
        />
      )}

      <div className="grid gap-4 mt-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] items-start">
        <div className="flex flex-col gap-4">
          {you && (
            <Shortlist
              board={state.board}
              canPick={canPick}
              picking={picking}
              onPick={pick}
            />
          )}
          <Pool pool={state.pool} canPick={canPick} picking={picking} onPick={pick} />
        </div>

        <div className="flex flex-col gap-4">
          <OnDeck draft={d} teams={teamsById} you={you} />
          <Feed picks={state.picks} teams={teamsById} />
          <Standings teams={state.teams} you={you} />
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }) {
  const map = {
    pending: ['quiet', 'not started'],
    live: ['crimson', 'live'],
    paused: ['bad', 'paused'],
    complete: ['good', 'complete'],
  };
  const [tone, label] = map[status] || ['quiet', status];
  return <Pill tone={tone} blip={status === 'live'}>{label}</Pill>;
}

// ── The banner ──────────────────────────────────────────────────────────────
// The one thing on the page that has to be readable from across a room, because
// the answer to "am I up?" should never require reading.
function ClockBanner({ draft, you, team, left }) {
  if (draft.status === 'pending') {
    return (
      <Panel>
        <div className="p-6 text-center">
          <div className="eyebrow">The draft has not started</div>
          <p className="text-sm text-ash mt-2 max-w-[60ch] mx-auto">
            Rank the pool on your draft board while you wait — when the clock starts, the top of
            that board is your answer.
          </p>
        </div>
      </Panel>
    );
  }

  if (draft.status === 'complete') {
    return (
      <Panel className="border-verdigris/40">
        <div className="p-6 text-center">
          <div className="font-display text-[26px] text-verdigris">The draft is complete</div>
          <p className="text-sm text-ash mt-1.5">
            All {draft.totalPicks} picks are in. Rosters are below.
          </p>
        </div>
      </Panel>
    );
  }

  if (draft.status === 'paused') {
    return (
      <Panel className="border-oxblood/50">
        <div className="p-5 flex items-center gap-5 flex-wrap">
          <Pill tone="bad">paused</Pill>
          <div className="min-w-0">
            <div className="text-[15px]">
              Stopped at pick {draft.currentPick} — {team?.name || 'a team'} is on the clock.
            </div>
            {draft.pausedReason && (
              <p className="text-[13px] text-ash mt-1 max-w-[80ch] leading-relaxed">{draft.pausedReason}</p>
            )}
          </div>
        </div>
      </Panel>
    );
  }

  const urgent = left !== null && left <= 30;
  const yours = you?.onClock;

  return (
    <Panel className={yours ? 'border-crimson' : urgent ? 'border-oxblood/60' : ''}>
      <div className="p-5 flex items-center justify-between gap-6 flex-wrap">
        <div className="min-w-0">
          <div className="eyebrow">
            Round {draft.round} · Pick {draft.currentPick} of {draft.totalPicks}
          </div>
          <div className={`font-display mt-1 leading-tight ${yours ? 'text-[34px] text-crimsonbright' : 'text-[26px]'}`}>
            {yours ? "You're on the clock" : `${team?.name || 'Unknown team'} is on the clock`}
          </div>
          {!yours && you && (
            <div className="text-[13px] text-ash mt-1">
              {you.picksAway === null
                ? 'You have no picks left.'
                : you.picksAway === 1
                  ? `${you.name} is up next — start deciding.`
                  : `${you.name} picks in ${you.picksAway} — pick ${you.nextPick}.`}
            </div>
          )}
          {!you && (
            <div className="text-[13px] text-ash mt-1">
              You are watching — only a team's captains can pick.
            </div>
          )}
        </div>

        <div
          className={`mono tabular-nums leading-none ${
            urgent ? 'text-crimsonbright' : 'text-bone'
          } ${yours ? 'text-[64px]' : 'text-[44px]'}`}
        >
          {mmss(left)}
        </div>
      </div>
    </Panel>
  );
}

// ── Your board, live ────────────────────────────────────────────────────────
// The players a captain already decided they wanted, with everyone since taken
// removed. On the clock this is meant to be the entire decision: the top row is
// the pick.
function Shortlist({ board, canPick, picking, onPick }) {
  const [open, setOpen] = useState(true);
  const top = open ? board : board.slice(0, 5);

  return (
    <Panel
      title="Your board"
      subtitle="Best available, in the order you ranked them"
      right={
        <div className="flex items-center gap-3">
          <span className="text-xs text-ash">{board.length} still available</span>
          {board.length > 5 && (
            <button onClick={() => setOpen((v) => !v)} className="text-xs text-ash hover:text-bone underline underline-offset-2">
              {open ? 'show top 5' : 'show all'}
            </button>
          )}
        </div>
      }
    >
      {board.length === 0 ? (
        <Empty>
          Nobody left on your board. Use the pool below — or go and rank some more.
        </Empty>
      ) : (
        <div className="flex flex-col max-h-[46vh] overflow-y-auto">
          {top.map((e, i) => (
            <Row
              key={e.signup_id}
              p={e}
              lead={
                <span className="mono text-[11px] text-ash w-8 shrink-0">
                  T{e.tier}·{(e.rank ?? 0) + 1}
                </span>
              }
              note={e.note}
              highlight={i === 0}
              canPick={canPick}
              picking={picking}
              onPick={onPick}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

// ── Everyone else ───────────────────────────────────────────────────────────
function Pool({ pool, canPick, picking, onPick }) {
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [position, setPosition] = useState('');
  const [shotcallers, setShotcallers] = useState(false);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return pool.filter((p) => (
      (!role || p.role === role)
      && (!position || (p.positions || []).includes(position))
      // `=== true` on purpose: a signup filed before the question existed has
      // null here, and a null must never pass a filter for people who said yes.
      && (!shotcallers || p.wants_shotcall === true)
      && (!needle
        || p.player_name.toLowerCase().includes(needle)
        || (p.classes || []).some((c) => c.toLowerCase().includes(needle)))
    ));
  }, [pool, q, role, position, shotcallers]);

  return (
    <Panel
      title="Available players"
      right={<span className="text-xs text-ash">{filtered.length} of {pool.length}</span>}
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
          <label className="inline-flex items-center gap-1.5 text-[12.5px] text-ash cursor-pointer px-1">
            <input
              type="checkbox"
              className="w-3.5 h-3.5 accent-[rgb(var(--color-crimson))]"
              checked={shotcallers}
              onChange={(e) => setShotcallers(e.target.checked)}
            />
            Shotcallers
          </label>
        </div>
      </div>

      {filtered.length === 0 ? (
        <Empty>{pool.length === 0 ? 'Everybody has been drafted.' : 'Nobody matches those filters.'}</Empty>
      ) : (
        <div className="flex flex-col max-h-[58vh] overflow-y-auto">
          {filtered.map((p) => (
            <Row key={p.id} p={p} canPick={canPick} picking={picking} onPick={onPick} />
          ))}
        </div>
      )}
    </Panel>
  );
}

// One player, and the button that drafts them.
//
// The button is TWO clicks, and it is deliberate. Everything else on this page
// is reversible by reloading; this one hands a player to a team in front of an
// audience, and undoing it needs an organizer. A misclick in a scrolling list
// of three hundred names is not a hypothetical.
function Row({ p, lead, note, highlight, canPick, picking, onPick }) {
  const [armed, setArmed] = useState(false);
  const id = p.signup_id || p.id;

  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  return (
    <div
      className={`px-4 py-2.5 border-b border-line/50 last:border-b-0 flex items-start gap-3 ${
        highlight ? 'bg-crimson/[0.07]' : ''
      }`}
    >
      {lead}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[13.5px]">{p.player_name}</span>
          {p.role && <span className="text-[10px] uppercase tracking-[0.1em] text-crimson">{p.role}</span>}
          <span className="text-[11px] text-ash truncate">
            {(p.classes || []).join(' · ') || 'no class given'}
          </span>
          {p.wants_shotcall && (
            <span className="text-[10px] uppercase tracking-[0.1em] text-verdigris">shotcaller</span>
          )}
          {(p.nights || []).length > 0 && (
            <span className="text-[10px] text-ash/70">{(p.nights || []).join(' ')}</span>
          )}
        </div>

        {/* Two different notes can sit on one row and they mean opposite
            things: one is what the PLAYER said about themselves, one is what
            THIS CAPTAIN wrote about them. Unlabelled, a scouting note reads as
            a quote and a quote reads as scouting — so both are labelled, and
            they are different colours. */}
        {p.notes && <Says text={p.notes} />}
        {note && (
          <div className="text-[11.5px] text-bone/75 mt-0.5 leading-snug">
            <Tag>your note</Tag>{note}
          </div>
        )}
      </div>

      {canPick && (
        armed ? (
          <Button variant="danger" disabled={picking === id} onClick={() => onPick(id)}>
            {picking === id ? 'Drafting…' : `Confirm — draft ${p.player_name}`}
          </Button>
        ) : (
          <Button variant="primary" onClick={() => setArmed(true)}>Draft</Button>
        )
      )}
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

// What the player wrote about themselves at signup.
//
// Clamped to one line and expanded by clicking. Notes run to 500 characters and
// most are one clause — showing them all in full turns a list of a hundred and
// fifty into a wall, and showing none of them wastes the most useful thing on
// the row. One line catches "can flex healer" whole and signals the rest.
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

// ── Right-hand column ───────────────────────────────────────────────────────
function OnDeck({ draft, teams, you }) {
  if (draft.status !== 'live' && draft.status !== 'paused') return null;
  if (!draft.onDeck?.length) return null;

  return (
    <Panel title="On deck">
      <div className="p-3 flex flex-col">
        {draft.onDeck.map((x) => (
          <div
            key={x.pick}
            className={`px-2 py-1.5 rounded flex items-center gap-3 text-[13px] ${
              you && x.teamId === you.teamId ? 'bg-crimson/12 text-crimsonbright' : 'text-ash'
            }`}
          >
            <span className="mono text-[11px] w-14 shrink-0">R{x.round}·P{x.pick}</span>
            <span className="truncate">{teams[x.teamId]?.name || '—'}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function Feed({ picks, teams }) {
  return (
    <Panel title="Picks" right={<span className="text-xs text-ash">most recent first</span>}>
      {picks.length === 0 ? (
        <Empty>Nothing yet.</Empty>
      ) : (
        <div className="flex flex-col max-h-[40vh] overflow-y-auto">
          {picks.map((x) => (
            <div key={x.pick_number} className="px-4 py-2 border-b border-line/50 last:border-b-0 flex items-baseline gap-3">
              <span className="mono text-[11px] text-ash w-14 shrink-0">R{x.round}·P{x.pick_number}</span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] truncate">
                  {x.player.player_name}
                  <span className="text-ash"> → {teams[x.team_id]?.tag || teams[x.team_id]?.name || '—'}</span>
                </div>
                <div className="text-[11px] text-ash truncate">
                  {x.player.role || '—'} · {(x.player.classes || []).join(' · ') || 'no class'}
                </div>
              </div>
              {/* Marked because a captain WILL come back and ask about this one. */}
              {x.auto && <span className="text-[10px] uppercase tracking-[0.1em] text-oxblood shrink-0">auto</span>}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function Standings({ teams, you }) {
  return (
    <Panel title="Rosters">
      <div className="p-3 flex flex-col gap-1">
        {teams.map((t) => (
          <div
            key={t.id}
            className={`px-2 py-1.5 rounded flex items-center justify-between gap-3 text-[13px] ${
              you && t.id === you.teamId ? 'bg-crimson/12' : ''
            }`}
          >
            <span className="truncate">
              <span className="mono text-[11px] text-ash mr-2">{t.seed ?? '—'}</span>
              {t.name}
            </span>
            <span className="mono text-[12px] text-ash shrink-0">
              {t.progress.filled}/{t.progress.size}
            </span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ── Organizer controls ──────────────────────────────────────────────────────
function Controls({ admin, draft, teams, pool, onDone, setBanner }) {
  const [busy, setBusy] = useState(null);
  const [seconds, setSeconds] = useState(String(draft.pickSeconds));
  const [confirmText, setConfirmText] = useState('');
  const [showReset, setShowReset] = useState(false);

  useEffect(() => { setSeconds(String(draft.pickSeconds)); }, [draft.pickSeconds]);

  async function call(what, body, verb = 'post') {
    setBusy(what);
    setBanner(null);
    try {
      const { data } = await api[verb](`/api/organizer/draft/${what}`, body || {});
      if (what === 'undo') setBanner({ tone: 'good', text: `Took back pick ${data.undone.pick} — ${data.undone.player}.` });
      if (what === 'reset') setBanner({ tone: 'good', text: `Draft reset — ${data.removed} picks removed.` });
      setShowReset(false);
      setConfirmText('');
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
    } finally {
      setBusy(null);
      onDone();
    }
  }

  const plan = admin?.plan;

  return (
    <Panel
      title="Organizer"
      className="mt-4 border-crimson/25"
      right={<span className="text-xs text-ash">only you see this</span>}
    >
      <div className="p-4 flex flex-col gap-4">
        {draft.status === 'pending' && admin && !admin.canStart && (
          <div className="flex flex-col gap-1.5">
            {admin.problems.map((p) => (
              <div key={p} className="text-[13px] text-crimsonbright leading-relaxed">· {p}</div>
            ))}
          </div>
        )}

        {/* The arithmetic nobody does in advance. 8 teams drafting 58 rounds at
            two minutes a pick is over fifteen hours — worth knowing before the
            night rather than at 3am during it. */}
        {draft.status === 'pending' && plan?.picks > 0 && (
          <div className="flex gap-6 flex-wrap items-baseline">
            <div>
              <div className="eyebrow">Rounds</div>
              <div className="mono text-[20px]">{plan.rounds}</div>
            </div>
            <div>
              <div className="eyebrow">Picks</div>
              <div className="mono text-[20px]">{plan.picks}</div>
            </div>
            <div>
              <div className="eyebrow">If every clock runs out</div>
              <div className={`mono text-[20px] ${plan.worstCaseSeconds > 5 * 3600 ? 'text-crimsonbright' : ''}`}>
                {humanDuration(plan.worstCaseSeconds)}
              </div>
            </div>
            {plan.worstCaseSeconds > 5 * 3600 && (
              <p className="text-xs text-ash max-w-[46ch] leading-relaxed">
                That is the worst case, not the expectation — but a shorter clock or a smaller
                roster is easier to decide now than at 2am.
              </p>
            )}
          </div>
        )}

        <div className="flex items-end gap-2 flex-wrap">
          {draft.status === 'pending' && (
            <Button
              variant="good"
              disabled={busy || !admin?.canStart}
              onClick={() => call('start', { pick_seconds: Number(seconds) })}
            >
              {busy === 'start' ? 'Starting…' : 'Start the draft'}
            </Button>
          )}
          {draft.status === 'live' && (
            <Button variant="ghost" disabled={busy} onClick={() => call('pause')}>Pause</Button>
          )}
          {draft.status === 'paused' && (
            <Button variant="good" disabled={busy} onClick={() => call('resume')}>Resume</Button>
          )}
          {draft.status !== 'pending' && (
            <Button variant="ghost" disabled={busy} onClick={() => call('undo')}>Undo last pick</Button>
          )}

          <div className="w-[150px]">
            <Field label="Pick clock" htmlFor="pick-seconds">
              <div className="flex gap-1.5">
                <input
                  id="pick-seconds"
                  className="field-input py-1 text-[13px]"
                  value={seconds}
                  inputMode="numeric"
                  onChange={(e) => setSeconds(e.target.value.replace(/[^0-9]/g, ''))}
                />
                <Button
                  variant="ghost"
                  disabled={busy || Number(seconds) === draft.pickSeconds}
                  onClick={() => call('settings', { pick_seconds: Number(seconds) }, 'put')}
                >
                  set
                </Button>
              </div>
            </Field>
          </div>

          <div className="ml-auto">
            {!showReset ? (
              <Button variant="ghost" onClick={() => setShowReset(true)}>Reset draft…</Button>
            ) : (
              <div className="flex items-end gap-2">
                <div className="w-[240px]">
                  <Field
                    label="Type the tournament name"
                    hint="Deletes every pick and every drafted player. Captains stay."
                  >
                    <input
                      className="field-input py-1 text-[13px]"
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      placeholder={admin?.tournament?.name || ''}
                    />
                  </Field>
                </div>
                <Button variant="danger" disabled={busy} onClick={() => call('reset', { confirm: confirmText })}>
                  Reset
                </Button>
                <Button variant="ghost" onClick={() => { setShowReset(false); setConfirmText(''); }}>
                  Cancel
                </Button>
              </div>
            )}
          </div>
        </div>

        {draft.status === 'live' && (
          <PickFor teams={teams} draft={draft} pool={pool} onDone={onDone} setBanner={setBanner} />
        )}
      </div>
    </Panel>
  );
}

// Picking for a captain who isn't there. Kept behind a disclosure because it is
// rarely the right answer — the clock already covers an absent captain, and it
// covers them with their own board.
function PickFor({ teams, draft, pool = [], onDone, setBanner }) {
  const [open, setOpen] = useState(false);
  const [signup, setSignup] = useState('');
  const [busy, setBusy] = useState(false);

  const team = teams.find((t) => t.id === draft.onClock);

  if (!team) return null;
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-xs text-ash hover:text-bone underline underline-offset-2 self-start">
        Pick for {team.name}…
      </button>
    );
  }

  async function go() {
    setBusy(true);
    try {
      const { data } = await api.post('/api/organizer/draft/pick', {
        team_id: team.id, signup_id: signup,
      });
      setBanner({ tone: 'good', text: `Drafted ${data.player.player_name} for ${team.name}.` });
      setOpen(false);
      setSignup('');
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
    } finally {
      setBusy(false);
      onDone();
    }
  }

  return (
    <div className="flex items-end gap-2 flex-wrap border-t border-line pt-3">
      <div className="min-w-[260px]">
        <Field label={`Pick for ${team.name}`} hint="The clock would use their own board — this overrides it.">
          <select className="field-input py-1 text-[13px]" value={signup} onChange={(e) => setSignup(e.target.value)}>
            <option value="">Choose a player…</option>
            {pool.map((p) => (
              <option key={p.id} value={p.id}>
                {p.player_name} — {p.role || 'no role'}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Button variant="danger" disabled={!signup || busy} onClick={go}>
        {busy ? 'Drafting…' : 'Draft them'}
      </Button>
      <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
    </div>
  );
}
