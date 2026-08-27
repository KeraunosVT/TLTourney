// The stream view — /watch.
//
// This is the page a broadcast points at, and it is built for a viewer sitting
// ten feet from a television, not two feet from a monitor. That single fact
// decides everything about it:
//
//   · no session. An OBS browser source carries no cookie, and neither does
//     anyone who follows the link from the stream. It reads /api/stream/draft,
//     which is the one unauthenticated data route in the app and returns only
//     what is already being broadcast anyway.
//   · no navigation, no scrolling, no shell. It is a scene, not a page.
//   · everything sized in viewport units, so 1920x1080 in OBS and a half-width
//     browser window both fill correctly without a zoom setting.
//   · four things visible at once and no more: who is picking, how long they
//     have, who was just taken, and who is next. Anything else is for the
//     people IN the draft, and they have their own page.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { Sigil } from '../components/Brand';
import { useCountdown, mmss } from '../lib/clock';

export default function Watch() {
  const [state, setState] = useState(null);
  const [failed, setFailed] = useState(null);
  const inFlight = useRef(false);
  const everLoaded = useRef(false);

  // ── The commentary desk ───────────────────────────────────────────────────
  // Closed by default, which is what keeps it off the broadcast: an OBS browser
  // source never hovers and never presses a key, so it renders the clean scene
  // and nothing else. A commentator opens /watch?desk=1 on their own monitor,
  // or presses A on any copy of the page when a segment calls for showing it.
  const [desk, setDesk] = useState(() =>
    new URLSearchParams(window.location.search).get('desk') === '1');

  // Read by `load` through a ref rather than a dependency, so opening the desk
  // doesn't give `load` a new identity and re-arm the poll interval.
  const wantPool = useRef(desk);
  useEffect(() => { wantPool.current = desk; }, [desk]);

  useEffect(() => {
    const onKey = (e) => {
      // Not while they're typing a name into the search box.
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName)) {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      if (e.key === 'a' || e.key === 'A') setDesk((v) => !v);
      if (e.key === 'Escape') setDesk(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // No dependencies on purpose. If this closed over `state` it would get a new
  // identity on every poll, and the interval below would be torn down and
  // re-armed twice a second for the whole of draft night.
  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      // Plain axios, not the shared instance: this route takes no credentials
      // and there is no session to send.
      const { data } = await axios.get(`/api/stream/draft${wantPool.current ? '?pool=1' : ''}`);
      setState(data);
      everLoaded.current = true;
      setFailed(null);
    } catch (err) {
      // A dropped poll is not worth showing on a broadcast — the last good
      // frame stays up and the next poll fixes it. Only a page that has NEVER
      // loaded says anything, and then it says what the server said: the
      // failure that will really happen is 010 not having been run, and
      // "waiting for the draft" would hide that behind a spinner forever.
      if (!everLoaded.current) {
        setFailed(err?.response?.data?.error || 'Waiting for the draft…');
      }
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Opening the desk asks for the pool immediately rather than at the next
  // poll. Two seconds of an empty panel is two seconds a commentator spends
  // wondering whether it's broken.
  useEffect(() => { if (desk) load(); }, [desk, load]);

  const status = state?.draft?.status;
  useEffect(() => {
    const id = setInterval(load, status === 'live' ? 2000 : 10000);
    return () => clearInterval(id);
  }, [status, load]);

  const d = state?.draft;
  const left = useCountdown(d?.deadline, d?.serverTime);

  if (!state) {
    return (
      <Stage>
        <div className="m-auto text-center">
          <Sigil size={72} />
          <div className="mt-4 text-[2vh] text-ash max-w-[46ch] leading-relaxed">
            {failed || 'Loading…'}
          </div>
        </div>
      </Stage>
    );
  }

  const teams = state.teams || [];
  const byId = Object.fromEntries(teams.map((t) => [t.id, t]));
  const onClock = byId[d?.onClock];
  const latest = (state.picks || [])[0];

  return (
    <Stage>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="flex items-center gap-[2vw] px-[2.5vw] py-[1.4vh] border-b border-line/70 shrink-0">
        <Sigil size={40} />
        <div className="leading-none">
          <div className="wordmark text-[1.7vh] tracking-[0.05em] whitespace-nowrap">
            THRONE <span className="text-crimson">&amp;</span> LIBERTY
          </div>
          <div className="text-[1.05vh] uppercase tracking-[0.28em] text-ash mt-[0.5vh] whitespace-nowrap">
            {state.tournament?.name || 'Tournament Series'}
          </div>
        </div>

        <div className="ml-auto flex items-baseline gap-[2.5vw] mono">
          {d?.round != null && d.status !== 'complete' && (
            <Stat label="Round" value={`${d.round} / ${d.rounds}`} />
          )}
          <Stat label="Pick" value={d?.status === 'complete' ? d.totalPicks : `${d?.currentPick} / ${d?.totalPicks}`} />
          <Stat label="Pool" value={state.poolCount ?? '—'} />
        </div>
      </header>

      {/* ── The two things that matter ─────────────────────────────────── */}
      <section className="grid grid-cols-1 lg:grid-cols-[1.15fr_1fr] gap-[2vw] px-[2.5vw] py-[2.2vh] shrink-0">
        <OnClock draft={d} team={onClock} left={left} />
        <Latest pick={latest} team={latest ? byId[latest.team_id] : null} />
      </section>

      {/* ── On deck ────────────────────────────────────────────────────── */}
      {d?.status === 'live' && d.onDeck?.length > 0 && (
        <div className="px-[2.5vw] pb-[1.6vh] shrink-0">
          <div className="flex items-center gap-[1.4vw] overflow-hidden">
            <span className="text-[1.1vh] uppercase tracking-[0.24em] text-ash shrink-0">On deck</span>
            {d.onDeck.slice(0, 5).map((x, i) => (
              <span key={x.pick} className="flex items-center gap-[1.4vw] shrink-0">
                {i > 0 && <span className="text-dim text-[1.6vh]">›</span>}
                <span className={`text-[1.9vh] whitespace-nowrap ${i === 0 ? 'text-bone' : 'text-ash'}`}>
                  {byId[x.teamId]?.name || '—'}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── The rosters, growing ───────────────────────────────────────── */}
      <section className="flex-1 min-h-0 px-[2.5vw] pb-[2vh]">
        <div
          className="grid gap-[0.9vw] h-full"
          style={{ gridTemplateColumns: `repeat(${Math.min(teams.length || 1, 8)}, minmax(0, 1fr))` }}
        >
          {teams.map((t) => (
            <TeamColumn key={t.id} team={t} live={t.id === d?.onClock && d?.status === 'live'} />
          ))}
        </div>
      </section>

      {desk && (
        <Desk
          pool={state.pool}
          count={state.poolCount}
          scarcity={state.scarcity}
          onClose={() => setDesk(false)}
        />
      )}

      {/* Revealed by a mouse, and only by a mouse. OBS has no cursor, so this
          never appears in the capture — it exists so a commentator who wasn't
          told about the keyboard shortcut can still find the panel. */}
      {!desk && (
        <button
          onClick={() => setDesk(true)}
          className="fixed bottom-[1.5vh] right-[1.5vw] px-[0.8vw] py-[0.6vh] rounded border border-line
                     bg-panel text-ash text-[1.2vh] opacity-0 hover:opacity-100 focus:opacity-100
                     transition-opacity"
        >
          Available players (A)
        </button>
      )}
    </Stage>
  );
}

// ── The commentary desk ─────────────────────────────────────────────────────
// The question a commentator asks forty times a night is "is X still on the
// board?", and the one that makes the segment is "how many tanks are left".
// Both are here; nothing else is.
//
// It overlays the right-hand side rather than replacing the scene, so the clock
// and the team on it stay visible while somebody is reading down the list.
function Desk({ pool, count, scarcity, onClose }) {
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const box = useRef(null);

  useEffect(() => { box.current?.focus(); }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (pool || []).filter((p) => (
      (!role || p.role === role)
      && (!needle
        || p.player_name.toLowerCase().includes(needle)
        || (p.classes || []).some((c) => c.toLowerCase().includes(needle)))
    ));
  }, [pool, q, role]);

  return (
    <aside
      className="fixed top-0 right-0 h-full w-[34vw] min-w-[360px] max-w-[560px] z-10
                 bg-panel/97 border-l border-line flex flex-col shadow-2xl"
    >
      <header className="px-[1.2vw] py-[1.4vh] border-b border-line flex items-baseline justify-between gap-3 shrink-0">
        <div>
          <div className="text-[1.1vh] uppercase tracking-[0.24em] text-ash">Still available</div>
          <div className="mono text-[3vh] leading-none mt-[0.5vh] tabular-nums">{count ?? '—'}</div>
        </div>
        <button onClick={onClose} className="text-[1.3vh] text-ash hover:text-bone">
          close (esc)
        </button>
      </header>

      {/* The scarcity line. "Four tanks left and the teams need eleven more" is
          the sentence; a raw count of everyone left is not. `needed` is the
          floor across every team — the slots no flexible slot can cover. */}
      {scarcity?.length > 0 && (
        <div className="px-[1.2vw] py-[1.2vh] border-b border-line grid grid-cols-3 gap-[0.8vw] shrink-0">
          {scarcity.map((s) => {
            const short = s.available < s.needed;
            return (
              <button
                key={s.role}
                onClick={() => setRole(role === s.role ? '' : s.role)}
                className={`text-left px-[0.6vw] py-[0.8vh] rounded border transition-colors ${
                  role === s.role ? 'border-crimson bg-crimson/12' : 'border-line hover:border-crimson/50'
                }`}
              >
                <div className="text-[1.05vh] uppercase tracking-[0.16em] text-ash">{s.role}</div>
                <div className={`mono text-[2.4vh] leading-none mt-[0.4vh] tabular-nums ${
                  short ? 'text-crimsonbright' : ''
                }`}>
                  {s.available}
                </div>
                <div className="text-[1.05vh] text-ash mt-[0.4vh] tabular-nums">
                  {s.needed} still needed
                </div>
              </button>
            );
          })}
        </div>
      )}

      <div className="px-[1.2vw] py-[1.1vh] border-b border-line shrink-0">
        <input
          ref={box}
          className="field-input py-[0.6vh] text-[1.6vh]"
          placeholder="Search a name or a class…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {!pool ? (
          <div className="px-[1.2vw] py-[2vh] text-[1.4vh] text-ash">Loading the pool…</div>
        ) : filtered.length === 0 ? (
          <div className="px-[1.2vw] py-[2vh] text-[1.4vh] text-ash">
            {(pool.length === 0) ? 'Everybody has been drafted.' : 'Nobody matches that.'}
          </div>
        ) : (
          <>
            {(q || role) && (
              <div className="px-[1.2vw] pt-[1vh] text-[1.15vh] text-ash tabular-nums">
                {filtered.length} of {pool.length}
              </div>
            )}
            {/* Two columns: a hundred and fifty names in one column is a lot of
                scrolling to answer "is he still there". */}
            <div className="grid grid-cols-2 gap-x-[0.8vw] px-[1.2vw] py-[1vh]">
              {filtered.map((p) => (
                <div key={p.id} className="py-[0.55vh] border-b border-line/30 min-w-0">
                  <div className="text-[1.45vh] truncate">
                    {p.player_name}
                    {p.wants_shotcall && <span className="text-verdigris ml-[0.4vw]">·SC</span>}
                  </div>
                  <div className="text-[1.05vh] text-ash truncate">
                    {p.role || '—'} · {(p.classes || []).join(' ') || 'no class'}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

// Fills the viewport exactly and never scrolls — a scrollbar on a broadcast is
// a bug the audience can see and nobody can fix from the sofa.
function Stage({ children }) {
  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-ink text-bone">
      {children}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="text-right">
      <div className="text-[1vh] uppercase tracking-[0.22em] text-ash">{label}</div>
      <div className="text-[2.2vh] tabular-nums mt-[0.3vh]">{value}</div>
    </div>
  );
}

// ── On the clock ────────────────────────────────────────────────────────────
function OnClock({ draft, team, left }) {
  if (!draft || draft.status === 'pending') {
    return (
      <Card>
        <div className="text-[1.2vh] uppercase tracking-[0.24em] text-ash">Starting soon</div>
        <div className="font-display text-[5.5vh] leading-tight mt-[1vh]">The draft is about to begin</div>
      </Card>
    );
  }

  if (draft.status === 'complete') {
    return (
      <Card tone="good">
        <div className="text-[1.2vh] uppercase tracking-[0.24em] text-verdigris">Complete</div>
        <div className="font-display text-[5.5vh] leading-tight mt-[1vh]">Every pick is in</div>
      </Card>
    );
  }

  if (draft.status === 'paused') {
    return (
      <Card tone="bad">
        <div className="text-[1.2vh] uppercase tracking-[0.24em] text-crimsonbright">Paused</div>
        <div className="font-display text-[4.6vh] leading-tight mt-[1vh]">{team?.name || 'Draft paused'}</div>
        <div className="text-[1.7vh] text-ash mt-[0.8vh]">Back shortly</div>
      </Card>
    );
  }

  const urgent = left !== null && left <= 30;
  const fraction = draft.pickSeconds ? Math.max(0, Math.min(1, (left ?? 0) / draft.pickSeconds)) : 0;

  return (
    <Card tone={urgent ? 'urgent' : 'live'}>
      <div className="flex items-start justify-between gap-[2vw]">
        <div className="min-w-0">
          <div className="text-[1.2vh] uppercase tracking-[0.24em] text-crimsonbright">On the clock</div>
          <div className="font-display text-[5.4vh] leading-[1.05] mt-[0.8vh] truncate">
            {team?.name || 'Unknown team'}
          </div>
          <div className="text-[1.6vh] text-ash mt-[0.8vh] truncate">
            {(team?.captains || []).map((c) => c.player_name).join(' · ') || 'no captain'}
          </div>
        </div>

        <div
          className={`mono tabular-nums text-[8.5vh] leading-none shrink-0 ${
            urgent ? 'text-crimsonbright' : 'text-bone'
          }`}
        >
          {mmss(left)}
        </div>
      </div>

      {/* The bar reads at a glance from across a room in a way digits do not —
          you can see "nearly out of time" without reading a number. */}
      <div className="mt-[1.6vh] h-[0.7vh] rounded-full bg-panelup overflow-hidden">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ease-linear ${
            urgent ? 'bg-crimsonbright' : 'bg-crimson'
          }`}
          style={{ width: `${fraction * 100}%` }}
        />
      </div>
    </Card>
  );
}

// ── The pick that just happened ─────────────────────────────────────────────
function Latest({ pick, team }) {
  if (!pick) {
    return (
      <Card>
        <div className="text-[1.2vh] uppercase tracking-[0.24em] text-ash">Latest pick</div>
        <div className="text-[2.4vh] text-ash mt-[1.4vh]">Nothing yet</div>
      </Card>
    );
  }

  return (
    // Keyed on the pick number so React remounts it — which is what replays the
    // entrance animation on every new pick instead of only the first.
    <Card key={pick.pick_number} flash>
      <div className="flex items-baseline justify-between gap-[1.5vw]">
        <div className="text-[1.2vh] uppercase tracking-[0.24em] text-ash">Latest pick</div>
        <div className="mono text-[1.4vh] text-ash tabular-nums">
          R{pick.round} · P{pick.pick_number}
          {pick.auto && <span className="text-oxblood ml-[0.8vw]">AUTO</span>}
        </div>
      </div>

      <div className="font-display text-[4.6vh] leading-[1.05] mt-[0.8vh] truncate">
        {pick.player.player_name}
      </div>

      <div className="flex items-baseline gap-[1.2vw] mt-[0.8vh] flex-wrap">
        {pick.player.role && (
          <span className="text-[1.5vh] uppercase tracking-[0.14em] text-crimson">{pick.player.role}</span>
        )}
        <span className="text-[1.7vh] text-ash truncate">
          {(pick.player.classes || []).join(' · ')}
        </span>
        {pick.player.wants_shotcall && (
          <span className="text-[1.3vh] uppercase tracking-[0.14em] text-verdigris">shotcaller</span>
        )}
      </div>

      <div className="text-[2vh] mt-[1.2vh] truncate">
        <span className="text-dim">→ </span>{team?.name || '—'}
      </div>
    </Card>
  );
}

// ── One team's column ───────────────────────────────────────────────────────
function TeamColumn({ team, live }) {
  // The most recent additions, newest first — already trimmed and sorted by the
  // server, because a 60-player roster neither fits on a screen nor belongs in
  // a payload polled every two seconds. The count under the name comes from
  // `progress`, which is computed over the whole roster.
  const recent = (team.recent || []).slice(0, 6);

  return (
    <div
      className={`panel flex flex-col min-h-0 overflow-hidden ${
        live ? 'border-crimson' : ''
      }`}
    >
      <div className={`px-[0.7vw] py-[1vh] border-b border-line shrink-0 ${live ? 'bg-crimson/12' : ''}`}>
        <div className="flex items-baseline gap-[0.5vw]">
          <span className="mono text-[1.1vh] text-ash shrink-0">{team.seed ?? '—'}</span>
          <span className="text-[1.7vh] truncate">{team.tag || team.name}</span>
        </div>
        <div className="mono text-[1.3vh] text-ash mt-[0.4vh] tabular-nums">
          {team.progress?.filled ?? 0}
          <span className="text-dim">/{team.progress?.size ?? '—'}</span>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        {recent.length === 0 ? (
          <div className="px-[0.7vw] py-[1.2vh] text-[1.3vh] text-dim">no picks yet</div>
        ) : (
          recent.map((m) => (
            <div key={m.id} className="px-[0.7vw] py-[0.75vh] border-b border-line/40 last:border-b-0">
              <div className="text-[1.45vh] truncate">{m.player_name}</div>
              <div className="text-[1.1vh] text-ash truncate">
                {m.role || '—'} · {(m.classes || [])[0] || 'no class'}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function Card({ tone = 'plain', flash = false, children }) {
  const tones = {
    plain: 'border-line',
    live: 'border-crimson/50',
    urgent: 'border-crimsonbright',
    good: 'border-verdigris/50',
    bad: 'border-oxblood/70',
  };
  return (
    <div
      className={`panel px-[1.6vw] py-[2vh] flex flex-col justify-center min-h-[17vh] ${tones[tone]} ${
        flash ? 'pick-flash' : ''
      }`}
    >
      {children}
    </div>
  );
}
