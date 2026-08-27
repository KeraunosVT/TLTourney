// Who is still on the board — the panel itself.
//
// Used twice: as the right-hand rail of the /watch scene, and as the whole of
// the standalone /pool window. Those two want very different type sizes, and
// hard-coding either would make it unreadable in the other.
//
// So EVERY size in here is in `em`, and the host sets the em. /watch passes a
// viewport-relative size because it is a fixed 16:9 scene; /pool passes pixels
// because it opens at whatever size somebody dragged it to. One component, two
// scales, no branching.
import { useMemo, useState } from 'react';
import { ROLES, POSITIONS } from '@shared/roles.cjs';

const EMPTY = { q: '', role: '', position: '', cls: '', shotcaller: false };

const hit = (p, f) => (
  (!f.role || p.role === f.role)
  && (!f.position || (p.positions || []).includes(f.position))
  && (!f.cls || (p.classes || []).includes(f.cls))
  // `=== true` on purpose: a signup filed before the shotcall question existed
  // has null here, and a null must never pass a filter for people who said yes.
  && (!f.shotcaller || p.wants_shotcall === true)
  && (!f.q
    || p.player_name.toLowerCase().includes(f.q)
    || (p.classes || []).some((c) => c.toLowerCase().includes(f.q)))
);

export default function PoolPanel({ pool, poolCount, scarcity, className = '', style }) {
  const [f, setF] = useState(EMPTY);
  const [openId, setOpenId] = useState(null);

  const set = (patch) => setF((prev) => ({ ...prev, ...patch }));
  const q = f.q.trim().toLowerCase();
  const active = { ...f, q };
  const dirty = f.q || f.role || f.position || f.cls || f.shotcaller;

  const list = pool || [];

  // Faceted counts: each facet is counted over the pool with EVERY OTHER filter
  // applied but its own ignored. That is what makes the numbers worth reading —
  // with Healer selected, the position counts say how many of the remaining
  // healers play killsquad, not how many players do overall. Counting against
  // the whole pool instead would show numbers that never move and mean nothing.
  const facets = useMemo(() => {
    const without = (key) => list.filter((p) => hit(p, { ...active, [key]: key === 'shotcaller' ? false : '' }));

    const forRole = without('role');
    const forPosition = without('position');
    const forClass = without('cls');
    const forShotcaller = without('shotcaller');

    const classCounts = new Map();
    forClass.forEach((p) => (p.classes || []).forEach((c) => {
      classCounts.set(c, (classCounts.get(c) || 0) + 1);
    }));

    return {
      role: Object.fromEntries(ROLES.map((r) => [r, forRole.filter((p) => p.role === r).length])),
      position: Object.fromEntries(POSITIONS.map((x) => [
        x, forPosition.filter((p) => (p.positions || []).includes(x)).length,
      ])),
      // Only classes somebody available actually plays, commonest first. A
      // dropdown of all 45 with 30 of them reading zero is a worse list than a
      // dropdown of the 15 that mean something.
      classes: [...classCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      shotcallers: forShotcaller.filter((p) => p.wants_shotcall === true).length,
    };
  }, [list, f.role, f.position, f.cls, f.shotcaller, q]);   // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => list.filter((p) => hit(p, active)), [list, f.role, f.position, f.cls, f.shotcaller, q]);   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`flex flex-col min-h-0 ${className}`} style={style}>
      {/* ── Scarcity, and the role filter ────────────────────────────────
          The headline is not how many are left but how many are left against
          how many the teams still have to find. `needed` is the per-team floor
          — the slots no flexible slot can cover — added up across every team.
          Deliberately NOT faceted: it is a fact about the draft, and a number
          that moved when you typed in the search box would not be one. */}
      <div className="px-[0.9em] pt-[0.8em] shrink-0">
        <div className="flex items-baseline gap-[0.5em]">
          <span className="mono text-[1.9em] leading-none tabular-nums">{poolCount ?? '—'}</span>
          <span className="text-[0.85em] text-ash">still available</span>
        </div>

        {scarcity?.length > 0 && (
          <div className="grid grid-cols-3 gap-[0.4em] mt-[0.7em]">
            {scarcity.map((s) => {
              const on = f.role === s.role;
              const short = s.available < s.needed;
              return (
                <button
                  key={s.role}
                  onClick={() => set({ role: on ? '' : s.role })}
                  className={`text-left px-[0.5em] py-[0.45em] rounded border transition-colors ${
                    on ? 'border-crimson bg-crimson/15' : 'border-line hover:border-crimson/50'
                  }`}
                >
                  <div className="text-[0.62em] uppercase tracking-[0.14em] text-ash">{s.role}</div>
                  <div className={`mono text-[1.25em] leading-none mt-[0.2em] tabular-nums ${short ? 'text-crimsonbright' : ''}`}>
                    {dirty ? facets.role[s.role] : s.available}
                  </div>
                  <div className="text-[0.62em] text-ash mt-[0.25em] tabular-nums">{s.needed} needed</div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Filters ──────────────────────────────────────────────────────── */}
      <div className="px-[0.9em] pt-[0.7em] flex flex-col gap-[0.45em] shrink-0">
        <input
          className="w-full bg-panelup text-bone border border-line rounded px-[0.6em] py-[0.35em]
                     text-[0.88em] outline-none focus:border-crimson placeholder:text-ash/60"
          placeholder="Search a name or a class…"
          value={f.q}
          onChange={(e) => set({ q: e.target.value })}
        />

        <div className="flex flex-wrap gap-[0.3em]">
          {POSITIONS.map((x) => (
            <Chip
              key={x}
              on={f.position === x}
              n={facets.position[x]}
              onClick={() => set({ position: f.position === x ? '' : x })}
            >
              {x.replace('Mainball ', 'MB ')}
            </Chip>
          ))}
          <Chip
            on={f.shotcaller}
            n={facets.shotcallers}
            tone="good"
            onClick={() => set({ shotcaller: !f.shotcaller })}
          >
            Shotcallers
          </Chip>
        </div>

        <div className="flex items-center gap-[0.4em]">
          <select
            className="flex-1 min-w-0 bg-panelup text-bone border border-line rounded px-[0.5em] py-[0.3em]
                       text-[0.8em] outline-none focus:border-crimson"
            value={f.cls}
            onChange={(e) => set({ cls: e.target.value })}
          >
            <option value="">Any class</option>
            {facets.classes.map(([c, n]) => (
              <option key={c} value={c}>{c} ({n})</option>
            ))}
          </select>
          {dirty && (
            <button
              onClick={() => setF(EMPTY)}
              className="text-[0.78em] text-ash hover:text-bone underline underline-offset-2 shrink-0"
            >
              clear
            </button>
          )}
        </div>

        <div className="text-[0.72em] text-ash tabular-nums">
          {dirty ? `showing ${shown.length} of ${list.length}` : `${list.length} players`}
        </div>
      </div>

      {/* ── The list ─────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto px-[0.9em] pb-[0.9em] mt-[0.3em]">
        {!pool ? (
          <p className="text-[0.85em] text-ash py-[1em]">Loading the pool…</p>
        ) : shown.length === 0 ? (
          <p className="text-[0.85em] text-ash py-[1em]">
            {list.length === 0 ? 'Everybody has been drafted.' : 'Nobody matches those filters.'}
          </p>
        ) : (
          <div className="grid gap-x-[1em]" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(14em, 1fr))' }}>
            {shown.map((p) => (
              <button
                key={p.id}
                onClick={() => setOpenId(openId === p.id ? null : p.id)}
                className="text-left py-[0.3em] border-b border-line/40 min-w-0 hover:bg-panelup/60
                           px-[0.25em] -mx-[0.25em] rounded-sm"
              >
                <div className="flex items-baseline gap-[0.4em]">
                  <span className="text-[0.9em] truncate">{p.player_name}</span>
                  {p.wants_shotcall && (
                    <span className="text-[0.6em] uppercase tracking-[0.1em] text-verdigris shrink-0">sc</span>
                  )}
                  {p.role && (
                    <span className="text-[0.6em] uppercase tracking-[0.1em] text-crimson ml-auto shrink-0">
                      {p.role}
                    </span>
                  )}
                </div>
                <div className="text-[0.72em] text-ash truncate">
                  {(p.classes || []).join(' · ') || 'no class given'}
                </div>
                {openId === p.id && (
                  <div className="text-[0.72em] text-ash/85 mt-[0.2em] leading-snug">
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

// A filter with its own count on it. The count is the point — "Killsquad 58"
// tells you whether the filter is worth pressing before you press it.
function Chip({ on, n, tone = 'crimson', children, onClick }) {
  const active = tone === 'good'
    ? 'border-verdigris bg-verdigris/15 text-verdigris'
    : 'border-crimson bg-crimson/15 text-bone';
  return (
    <button
      onClick={onClick}
      disabled={!on && n === 0}
      className={`px-[0.5em] py-[0.25em] rounded border text-[0.72em] whitespace-nowrap transition-colors
        disabled:opacity-30 disabled:cursor-not-allowed
        ${on ? active : 'border-line text-ash hover:text-bone hover:border-crimson/50'}`}
    >
      {children}
      <span className="ml-[0.45em] tabular-nums opacity-70">{n}</span>
    </button>
  );
}
