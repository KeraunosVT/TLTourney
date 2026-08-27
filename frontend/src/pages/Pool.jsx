// /pool — who is still on the board.
//
// A window of its own, not a panel on /watch, because the two things people do
// with it both want a separate window:
//
//   · a commentator puts it on their second monitor and reads down it while the
//     scene plays on the first;
//   · a producer adds it to OBS as its own browser source and places it wherever
//     the layout has room, at whatever size, without an overlay covering a third
//     of the rosters.
//
// And it is a short public URL because the third audience is viewers, who can't
// click anything on a broadcast — they can only type what they see on it.
//
// Sized in PIXELS, unlike /watch. That page is a fixed 16:9 scene, so viewport
// units are right there. This one opens at whatever size somebody dragged it to,
// and vh typography in a 560x940 window is unreadable.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { useCountdown, mmss } from '../lib/clock';

export default function Pool() {
  const [state, setState] = useState(null);
  const [failed, setFailed] = useState(null);
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [openId, setOpenId] = useState(null);
  const inFlight = useRef(false);
  const everLoaded = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      // ?pool=1 is what asks for the names. /watch doesn't send it — twenty
      // kilobytes every two seconds for a list the broadcast doesn't render.
      const { data } = await axios.get('/api/stream/draft?pool=1');
      setState(data);
      everLoaded.current = true;
      setFailed(null);
    } catch (err) {
      if (!everLoaded.current) setFailed(err?.response?.data?.error || 'Waiting for the draft…');
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
  const pool = state?.pool;

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (pool || []).filter((p) => (
      (!role || p.role === role)
      && (!needle
        || p.player_name.toLowerCase().includes(needle)
        || (p.classes || []).some((c) => c.toLowerCase().includes(needle)))
    ));
  }, [pool, q, role]);

  if (!state) {
    return (
      <div className="min-h-screen grid place-items-center p-8">
        <p className="text-sm text-ash text-center max-w-[42ch] leading-relaxed">
          {failed || 'Loading…'}
        </p>
      </div>
    );
  }

  const onClock = (state.teams || []).find((t) => t.id === d?.onClock);

  return (
    <div className="min-h-screen flex flex-col">
      {/* ── Who's picking ──────────────────────────────────────────────────
          Context, so the window is self-sufficient. A commentator glancing at
          it should not have to look back at the scene to know whose pick it is. */}
      <div className="px-4 py-2 border-b border-line bg-panel/70 flex items-center gap-3 flex-wrap text-[12.5px] sticky top-0 z-10">
        {d?.status === 'live' ? (
          <>
            <span className="mono text-ash tabular-nums">R{d.round}·P{d.currentPick}</span>
            <span className="truncate">{onClock?.name || '—'}</span>
            <span className={`mono ml-auto tabular-nums ${left !== null && left <= 30 ? 'text-crimsonbright' : 'text-ash'}`}>
              {mmss(left)}
            </span>
          </>
        ) : (
          <span className="text-ash">
            {d?.status === 'complete' ? 'The draft is complete.'
              : d?.status === 'paused' ? 'The draft is paused.'
                : 'The draft has not started.'}
          </span>
        )}
      </div>

      <header className="px-4 pt-4 pb-3">
        <div className="eyebrow">{state.tournament?.name || 'Still available'}</div>
        <div className="flex items-baseline gap-2.5 mt-1">
          <span className="mono text-[34px] leading-none tabular-nums">{state.poolCount ?? '—'}</span>
          <span className="text-sm text-ash">still available</span>
        </div>
      </header>

      {/* ── Scarcity ───────────────────────────────────────────────────────
          The number worth saying out loud: not how many are left, but how many
          are left against how many the teams still have to find. `needed` is
          the per-team floor — the slots no flexible slot can cover — added up
          across every team. Each tile is also the role filter. */}
      {state.scarcity?.length > 0 && (
        <div className="px-4 grid grid-cols-3 gap-2">
          {state.scarcity.map((s) => {
            const short = s.available < s.needed;
            const on = role === s.role;
            return (
              <button
                key={s.role}
                onClick={() => setRole(on ? '' : s.role)}
                className={`text-left px-2.5 py-2 rounded border transition-colors ${
                  on ? 'border-crimson bg-crimson/12' : 'border-line hover:border-crimson/50'
                }`}
              >
                <div className="text-[10px] uppercase tracking-[0.14em] text-ash">{s.role}</div>
                <div className={`mono text-[22px] leading-none mt-1 tabular-nums ${short ? 'text-crimsonbright' : ''}`}>
                  {s.available}
                </div>
                <div className="text-[10px] text-ash mt-1 tabular-nums">{s.needed} needed</div>
              </button>
            );
          })}
        </div>
      )}

      <div className="px-4 pt-3 pb-2">
        <input
          className="field-input py-1.5 text-[13.5px]"
          placeholder="Search a name or a class…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {(q || role) && (
          <div className="mt-1.5 flex items-center gap-3 text-[11.5px] text-ash">
            <span className="tabular-nums">{filtered.length} of {pool?.length ?? 0}</span>
            <button
              onClick={() => { setQ(''); setRole(''); }}
              className="hover:text-bone underline underline-offset-2"
            >
              clear
            </button>
          </div>
        )}
      </div>

      {/* ── The list ───────────────────────────────────────────────────────
          One column in a narrow pop-out, more as the window widens — auto-fill
          rather than a breakpoint, because nobody drags a window to a
          breakpoint. Clicking a row opens what didn't fit on it. */}
      <div className="flex-1 px-4 pb-6">
        {!pool ? (
          <p className="text-sm text-ash py-6">Loading the pool…</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-ash py-6">
            {pool.length === 0 ? 'Everybody has been drafted.' : 'Nobody matches that.'}
          </p>
        ) : (
          <div
            className="grid gap-x-4"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}
          >
            {filtered.map((p) => (
              <button
                key={p.id}
                onClick={() => setOpenId(openId === p.id ? null : p.id)}
                className="text-left py-1.5 border-b border-line/40 min-w-0 hover:bg-panelup/60 px-1 -mx-1 rounded-sm"
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-[13.5px] truncate">{p.player_name}</span>
                  {p.wants_shotcall && (
                    <span className="text-[9px] uppercase tracking-[0.1em] text-verdigris shrink-0">sc</span>
                  )}
                  {p.role && (
                    <span className="text-[9px] uppercase tracking-[0.1em] text-crimson ml-auto shrink-0">
                      {p.role}
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-ash truncate">
                  {(p.classes || []).join(' · ') || 'no class given'}
                </div>
                {openId === p.id && (
                  <div className="text-[11px] text-ash/85 mt-1 leading-snug">
                    {(p.positions || []).join(' · ') || 'no position given'}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
