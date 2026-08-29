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
import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { Sigil } from '../components/Brand';
import PoolPanel from '../components/PoolPanel';
import BracketScene from '../components/BracketScene';
import MatchScene from '../components/MatchScene';
import { useCountdown, mmss } from '../lib/clock';
import { useStreamDraft } from '../lib/stream';

export default function Watch() {
  // ── The rail ──────────────────────────────────────────────────────────────
  // On the scene, not in a second window. It is part of the broadcast: a viewer
  // can see who is left without being told to go and type a URL, and a
  // commentator can read it off the same screen the pick is on.
  //
  // Still hideable, because a producer running a full-screen bracket segment
  // wants the scene clean — A toggles it, ?pool=0 opens without it. Default ON,
  // which is the opposite of where this started, because it now belongs here.
  const [rail, setRail] = useState(() =>
    new URLSearchParams(window.location.search).get('pool') !== '0');

  // ── Which scene ───────────────────────────────────────────────────────────
  // 'auto' follows the tournament: the draft while it is running, the bracket
  // once it is not. A producer overrides with ?scene= or the number keys,
  // because "what is happening" and "what I want on screen right now" are not
  // the same question — a replay segment wants the bracket up mid-draft.
  const [scene, setScene] = useState(() =>
    new URLSearchParams(window.location.search).get('scene') || 'auto');

  const { state, failed } = useStreamDraft(rail);
  const [bracket, setBracket] = useState(null);

  useEffect(() => {
    const onKey = (e) => {
      // Not while somebody is typing into the rail's own search box.
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName)) {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      if (e.key === 'a' || e.key === 'A') setRail((v) => !v);
      if (e.key === '1') setScene('draft');
      if (e.key === '2') setScene('bracket');
      if (e.key === '3') setScene('match');
      if (e.key === '0') setScene('auto');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The bracket poll runs alongside the draft's rather than instead of it, so
  // switching scenes is instant. Slower, because a bracket changes when a match
  // is decided — a few times a night, not every two seconds.
  const bracketFetch = useCallback(async () => {
    try {
      const params = new URLSearchParams(window.location.search);
      const which = params.get('match');
      const { data } = await axios.get(`/api/stream/bracket${which ? `?match=${encodeURIComponent(which)}` : ''}`);
      setBracket(data);
    } catch {
      // A bracket that has not been drawn yet 503s or comes back empty. The
      // scene says so; it is not an error worth putting on a broadcast.
    }
  }, []);

  useEffect(() => {
    bracketFetch();
    const id = setInterval(bracketFetch, 10000);
    return () => clearInterval(id);
  }, [bracketFetch]);

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

  // 'auto' means: the draft while it is running, the bracket once it is not.
  // A bracket that has not been drawn keeps the draft up rather than showing an
  // empty frame — the last useful thing beats a blank one.
  const drafting = d?.status === 'live' || d?.status === 'paused';
  const showing = scene !== 'auto' ? scene : (drafting || !bracket?.exists ? 'draft' : 'bracket');

  const teams = state.teams || [];
  const byId = Object.fromEntries(teams.map((t) => [t.id, t]));
  const onClock = byId[d?.onClock];
  const latest = (state.picks || [])[0];

  return (
    <Stage
      rail={rail && showing === 'draft' && (
        <aside className="w-[26vw] min-w-[300px] max-w-[460px] shrink-0 border-l border-line
                          bg-panel/60 flex flex-col min-h-0">
          {/* The em the whole panel is sized from. A viewport unit here because
              this is a fixed 16:9 scene; /pool passes pixels instead. */}
          <PoolPanel
            pool={state.pool}
            poolCount={state.poolCount}
            scarcity={state.scarcity}
            style={{ fontSize: '1.75vh' }}
          />
        </aside>
      )}
    >
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
          {/* Draft numbers belong to the draft scene. Leaving "Pick 27 / 464"
              above a bracket is a caption for a different broadcast. */}
          {showing === 'draft' && d?.round != null && d.status !== 'complete' && (
            <Stat label="Round" value={`${d.round} / ${d.rounds}`} />
          )}
          {showing === 'draft' && (
            <Stat label="Pick" value={d?.status === 'complete' ? d.totalPicks : `${d?.currentPick} / ${d?.totalPicks}`} />
          )}
          {showing === 'draft' && <Stat label="Pool" value={state.poolCount ?? '—'} />}
          {showing !== 'draft' && bracket?.counts && (
            <Stat label="Played" value={`${bracket.counts.complete} / ${bracket.counts.total}`} />
          )}
          {showing !== 'draft' && bracket?.champion && (
            <Stat label="Champion" value={bracket.champion.tag || bracket.champion.name} />
          )}
        </div>
      </header>

      {showing === 'bracket' && bracket?.exists && <BracketScene state={bracket} />}

      {showing === 'match' && bracket?.exists && (
        <MatchScene
          focus={bracket.focus}
          teams={new Map((bracket.teams || []).map((t) => [t.id, t]))}
        />
      )}

      {(showing === 'bracket' || showing === 'match') && !bracket?.exists && (
        <div className="flex-1 grid place-items-center">
          <div className="text-[2.4vh] text-ash">The bracket has not been drawn yet.</div>
        </div>
      )}

      {showing === 'draft' && (
      <>
      {/* ── The two things that matter ─────────────────────────────────── */}
      <section className="grid grid-cols-1 lg:grid-cols-[1.15fr_1fr] gap-[2vw] px-[2.5vw] py-[2.2vh] shrink-0">
        <OnClock draft={d} team={onClock} left={left} />
        <Latest pick={latest} team={latest ? byId[latest.team_id] : null} />
      </section>

      {/* ── On deck ────────────────────────────────────────────────────── */}
      {d?.status === 'live' && d.onDeck?.length > 0 && (
        <div className="px-[2.5vw] pb-[1.6vh] shrink-0 flex items-center gap-[1.4vw] overflow-hidden">
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
      </>
      )}

      {/* Revealed by a mouse, and only by a mouse. OBS has no cursor, so this
          never appears in the capture. */}
      <div className="fixed bottom-[1.5vh] left-[1.5vw] flex gap-[0.5vw] opacity-0 hover:opacity-100
                      focus-within:opacity-100 transition-opacity">
        {[['auto', 'Auto (0)'], ['draft', 'Draft (1)'], ['bracket', 'Bracket (2)'], ['match', 'Match (3)']]
          .map(([id, label]) => (
            <button
              key={id}
              onClick={() => setScene(id)}
              className={`px-[0.7vw] py-[0.6vh] rounded border text-[1.2vh] ${
                scene === id ? 'border-crimson text-crimsonbright bg-crimson/15' : 'border-line bg-panel text-ash'
              }`}
            >
              {label}
            </button>
          ))}
        {showing === 'draft' && (
          <button
            onClick={() => setRail((v) => !v)}
            className="px-[0.7vw] py-[0.6vh] rounded border border-line bg-panel text-ash text-[1.2vh]"
          >
            {rail ? 'Hide players (A)' : 'Show players (A)'}
          </button>
        )}
      </div>

    </Stage>
  );
}

// Fills the viewport exactly. The SCENE never scrolls — a scrollbar on a
// broadcast is a bug the audience can see and nobody can fix from the sofa. The
// rail beside it scrolls internally, which is a different thing: it is a list
// somebody is working through, not a layout that overflowed.
function Stage({ children, rail }) {
  return (
    <div className="fixed inset-0 flex overflow-hidden bg-ink text-bone">
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">{children}</div>
      {rail}
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
