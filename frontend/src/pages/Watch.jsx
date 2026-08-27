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
import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Sigil } from '../components/Brand';
import { useCountdown, mmss } from '../lib/clock';

export default function Watch() {
  const [state, setState] = useState(null);
  const [failed, setFailed] = useState(null);
  const inFlight = useRef(false);
  const everLoaded = useRef(false);

  // ── The pop-out ───────────────────────────────────────────────────────────
  // Not a panel over the scene. /pool is its own window, so a commentator can
  // put it on a second monitor and a producer can add it to OBS as a separate
  // browser source, sized and placed to fit the layout instead of covering a
  // third of the rosters.
  //
  // Named, so pressing A twice focuses the window that is already open rather
  // than stacking a second one on top of it.
  const [blocked, setBlocked] = useState(false);

  // Read off the address bar rather than hard-coded, so the line on the
  // broadcast says the domain people actually reached this on — and says
  // localhost in dev rather than lying about the live one.
  const host = window.location.host;

  const popOut = useCallback(() => {
    const w = window.open('/pool', 'tlt_pool', 'width=560,height=940,menubar=no,toolbar=no,location=no');
    // A blocker returns null. Say so rather than looking broken — the URL is
    // public and typeable, which is the whole reason it is short.
    if (w) { w.focus(); setBlocked(false); } else { setBlocked(true); }
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      // Not while they're typing somewhere.
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName)) return;
      // A keypress counts as a user gesture, so window.open is allowed here.
      if (e.key === 'a' || e.key === 'A') popOut();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [popOut]);

  // No dependencies on purpose. If this closed over `state` it would get a new
  // identity on every poll, and the interval below would be torn down and
  // re-armed twice a second for the whole of draft night.
  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      // Plain axios, not the shared instance: this route takes no credentials
      // and there is no session to send.
      const { data } = await axios.get('/api/stream/draft');
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

      {/* ── The strip: on deck, and where viewers find the full pool ──── */}
      <div className="px-[2.5vw] pb-[1.6vh] shrink-0 flex items-center gap-[2vw]">
        {d?.status === 'live' && d.onDeck?.length > 0 && (
          <div className="flex items-center gap-[1.4vw] overflow-hidden min-w-0">
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
        )}

        {/* ON the broadcast, deliberately. A viewer cannot click anything on a
            stream — they can only type what they can read — so the one way the
            pool reaches them is a short URL that stays on screen. This is why
            the route is /pool and not /watch/desk. */}
        <div className="ml-auto shrink-0 text-right leading-tight">
          <div className="text-[1.05vh] uppercase tracking-[0.2em] text-ash">
            {state.poolCount ?? '—'} still available
          </div>
          <div className="text-[1.5vh] text-bone mt-[0.3vh] tabular-nums">
            {host}/pool
          </div>
        </div>
      </div>

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

      {/* Revealed by a mouse, and only by a mouse. OBS has no cursor, so it
          never appears in the capture — it exists so a commentator who was not
          told about the keyboard shortcut can still find the window. */}
      <button
        onClick={popOut}
        className="fixed bottom-[1.5vh] right-[1.5vw] px-[0.8vw] py-[0.6vh] rounded border border-line
                   bg-panel text-ash text-[1.2vh] opacity-0 hover:opacity-100 focus:opacity-100
                   transition-opacity"
      >
        Pop out available players (A)
      </button>

      {blocked && (
        <div className="fixed bottom-[1.5vh] left-[1.5vw] px-[1vw] py-[0.8vh] rounded border border-oxblood/70
                        bg-panel text-[1.3vh] text-bone">
          The pop-up was blocked — open <span className="text-crimsonbright">{host}/pool</span> yourself.
        </div>
      )}

    </Stage>
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
