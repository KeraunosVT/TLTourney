// Every team's roster — /rosters.
//
// PUBLIC, like /watch, /pool, /lower and /picks. A roster is the picks added
// up, and every one of those is already public; somebody following a link out
// of the stream has no session. What is NOT here is the comp — who sits in
// which party is tactical while a tournament is running and lives behind a
// captain's login (see backend/parties.js).
//
// SPLIT BY ROLE, which is the whole point of the page. A team is sixty-six
// names, and read as one list that is a wall nobody scans. Read as three
// columns it answers the question people actually bring: how deep is this team
// at healer.
import { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Sigil } from '../components/Brand';

// Order matters: Tank, DPS, Healer is how the game says it and how the party
// template is written, so the columns read the same way the slots do.
const ROLES = ['Tank', 'DPS', 'Healer'];

const ROLE_STYLE = {
  Tank: { text: 'text-verdigris', edge: 'border-t-verdigris/60' },
  DPS: { text: 'text-crimsonbright', edge: 'border-t-crimson/60' },
  Healer: { text: 'text-bone/80', edge: 'border-t-bone/40' },
};
const UNSET = { text: 'text-ash', edge: 'border-t-line' };

export default function Rosters() {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(null);
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    try {
      const { data: d } = await axios.get('/api/stream/rosters');
      setData(d);
      setFailed(null);
    } catch (err) {
      // A dropped refresh leaves the rosters already on screen, which are
      // still true. Only a page that never loaded says anything.
      setData((prev) => {
        if (!prev) setFailed(err?.response?.data?.error || 'Could not read the rosters.');
        return prev;
      });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Slowly, and only because a draft fills these in live. A finished roster
  // does not change, and this page is read mostly after the fact.
  useEffect(() => {
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  const needle = q.trim().toLowerCase();

  // Searching does not filter teams away — it HIGHLIGHTS. "Which team is this
  // player on" is the question, and an answer that hides the other three
  // removes the context that makes it an answer.
  const hit = useMemo(() => {
    if (!needle) return () => false;
    return (m) => `${m.player_name} ${(m.classes || []).join(' ')}`
      .toLowerCase().includes(needle);
  }, [needle]);

  if (failed) return <div className="p-8 text-sm text-oxblood">{failed}</div>;
  if (!data) return <div className="p-8 text-sm text-ash">Loading the rosters…</div>;

  const teams = data.teams || [];
  const found = needle ? teams.reduce((n, t) => n + t.members.filter(hit).length, 0) : 0;

  return (
    <div className="min-h-screen px-5 py-7">
      <div className="max-w-[1400px] mx-auto">
        <header className="flex items-end justify-between gap-5 flex-wrap mb-5">
          <div className="flex items-center gap-3">
            <Sigil size={38} />
            <div>
              <h1 className="font-display text-[26px] leading-none">Rosters</h1>
              <p className="text-ash text-[13px] mt-1.5">
                {data.tournament?.name} · {teams.length} team{teams.length === 1 ? '' : 's'}
                {data.tournament?.rosterSize
                  ? ` of ${data.tournament.rosterSize}`
                  : ''}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              className="field-input py-1.5 text-[13px] w-[230px]"
              value={q}
              placeholder="Find a player or class"
              onChange={(e) => setQ(e.target.value)}
              aria-label="Find a player"
            />
            {needle && (
              <span className="text-xs text-ash whitespace-nowrap">
                {found} match{found === 1 ? '' : 'es'}
              </span>
            )}
          </div>
        </header>

        {teams.length === 0 ? (
          <div className="panel px-4 py-10 text-center text-sm text-ash">
            No teams yet — this fills in as the draft runs.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {teams.map((t) => <Team key={t.id} team={t} hit={hit} searching={!!needle} />)}
          </div>
        )}

        <p className="text-[11px] text-dim mt-5">
          In-game names and classes only. Party assignments are not shown while the
          tournament is running.
        </p>
      </div>
    </div>
  );
}

function Team({ team, hit, searching }) {
  const p = team.progress || {};

  // Bucketed once. Anybody whose role was never recorded still gets a column —
  // they are on the roster and cost a pick, and a page that silently drops them
  // would not add up against the count in the header.
  const groups = useMemo(() => {
    const out = ROLES.map((role) => ({
      role,
      list: (team.members || []).filter((m) => m.role === role),
    }));
    const unset = (team.members || []).filter((m) => !ROLES.includes(m.role));
    if (unset.length) out.push({ role: null, list: unset });
    return out;
  }, [team.members]);

  return (
    <section className="panel">
      <header className="px-4 py-3 border-b border-line flex items-baseline gap-3 flex-wrap">
        <span className="mono text-[12px] text-crimson">{team.seed ?? '—'}</span>
        <h2 className="font-display text-[19px]">{team.name}</h2>
        {team.tag && <span className="mono text-[11px] text-ash">{team.tag}</span>}
        {team.captains?.length > 0 && (
          <span className="text-[11.5px] text-ash truncate">
            {team.captains.join(' · ')}
          </span>
        )}
        <span className="flex-1" />
        <span className="mono text-[12px] text-ash">
          {p.playing ?? p.filled ?? 0}
          <span className="text-dim">/{p.size ?? '—'}</span>
        </span>
        {/* A roster that holds somebody who is not playing does not add up
            unless the page says so. See migration 028. */}
        {p.nonPlaying > 0 && (
          <span className="text-[10px] uppercase tracking-[0.12em] text-ash">
            +{p.nonPlaying} not playing
          </span>
        )}
      </header>

      <div className="grid gap-px bg-line" style={{ gridTemplateColumns: `repeat(${groups.length}, minmax(0, 1fr))` }}>
        {groups.map(({ role, list }) => {
          const s = role ? ROLE_STYLE[role] : UNSET;
          return (
            <div key={role || 'unset'} className={`bg-panel border-t-2 ${s.edge} p-3`}>
              <div className="flex items-baseline gap-2 mb-2">
                <span className={`text-[11px] uppercase tracking-[0.14em] font-semibold ${s.text}`}>
                  {role || 'role not set'}
                </span>
                <span className="mono text-[11px] text-dim">{list.length}</span>
              </div>

              {list.length === 0 ? (
                <div className="text-[12px] text-dim italic">none yet</div>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {list.map((m) => (
                    <div
                      key={m.id}
                      className={`px-1.5 py-1 rounded flex items-baseline gap-2 ${
                        searching && hit(m) ? 'bg-crimson/20' : ''
                      } ${m.playing ? '' : 'opacity-50'}`}
                    >
                      {/* A captain did not cost a pick, so their row shows a
                          star where a pick number would be — otherwise the
                          numbers do not reconcile against the count above. */}
                      <span className="mono text-[10px] text-dim w-6 shrink-0 text-right">
                        {m.via === 'captain' ? '★' : m.draft_pick ?? '—'}
                      </span>
                      <span className="text-[12.5px] truncate">{m.player_name}</span>
                      {!m.playing && (
                        <span className="text-[9px] uppercase tracking-[0.1em] text-ash shrink-0">
                          not playing
                        </span>
                      )}
                      <span className="flex-1" />
                      <span className="text-[11px] text-ash truncate max-w-[46%]">
                        {(m.classes || []).join(' · ')}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
