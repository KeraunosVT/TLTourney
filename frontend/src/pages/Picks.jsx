// Every pick — /picks.
//
// The draft page's feed is the newest twenty, which is the right thing while a
// draft is running and useless afterwards: "who did we take in round 30" is a
// question people ask for weeks, and the answer was only ever in the database.
//
// PUBLIC, like /watch and /lower. Somebody following a link out of the stream
// has no session, and a draft record is the thing being broadcast — the same
// redaction the live feed uses applies here, so no Discord handles and no
// signup notes travel.
//
// Fetched ONCE, not polled. The list is forty kilobytes and the page is a
// record rather than a scoreboard; a Refresh button costs a click and saves
// every open tab from re-reading the whole draft every two seconds. It does
// poll while the draft is actually LIVE, slowly, because then it is both.
import { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Sigil } from '../components/Brand';

const ROLE_TONE = {
  Tank: 'text-verdigris',
  DPS: 'text-crimsonbright',
  Healer: 'text-bone/80',
};

export default function Picks() {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(null);
  const [team, setTeam] = useState('');
  const [role, setRole] = useState('');
  const [q, setQ] = useState('');
  const [newestFirst, setNewestFirst] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data: d } = await axios.get('/api/stream/draft/picks');
      setData(d);
      setFailed(null);
    } catch (err) {
      // Only a page that has never loaded says anything. A dropped refresh
      // leaves the record that is already on screen, which is still true.
      setData((prev) => {
        if (!prev) setFailed(err?.response?.data?.error || 'Could not read the picks.');
        return prev;
      });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Only while it is running, and slowly. A finished draft never changes, and
  // this page is most read after the fact.
  const live = data?.draft?.status === 'live';
  useEffect(() => {
    if (!live) return undefined;
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [live, load]);

  const byId = useMemo(
    () => new Map((data?.teams || []).map((t) => [t.id, t])),
    [data?.teams],
  );

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (data?.picks || []).filter((p) => {
      if (team && p.team_id !== team) return false;
      if (role && p.player.role !== role) return false;
      if (needle) {
        const hay = `${p.player.player_name} ${(p.player.classes || []).join(' ')}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    return newestFirst ? [...list].reverse() : list;
  }, [data?.picks, team, role, q, newestFirst]);

  if (failed) return <div className="p-8 text-sm text-oxblood">{failed}</div>;
  if (!data) return <div className="p-8 text-sm text-ash">Loading the picks…</div>;

  const filtered = shown.length !== (data.picks || []).length;

  return (
    <div className="min-h-screen px-5 py-7">
      <div className="max-w-[1000px] mx-auto">
        <header className="flex items-end justify-between gap-5 flex-wrap mb-5">
          <div className="flex items-center gap-3">
            <Sigil size={38} />
            <div>
              <h1 className="font-display text-[26px] leading-none">Every pick</h1>
              <p className="text-ash text-[13px] mt-1.5">
                {data.tournament?.name}
                {data.draft?.rounds > 0 && ` · ${data.draft.rounds} rounds`}
                {' · '}
                <span className="mono">{data.total}</span>
                {data.draft?.totalPicks > 0 && data.draft.status !== 'complete'
                  && <span className="text-dim"> of {data.draft.totalPicks}</span>}
                {' picks'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* A rehearsal's record must not read as the real one, on the page
                most likely to be linked weeks later with no context. */}
            {data.draft?.isMock && (
              <span className="px-2.5 py-1 rounded-full border border-oxblood/60 bg-oxblooddeep
                               text-[10px] uppercase tracking-[0.14em] text-crimsonbright font-semibold">
                mock draft
              </span>
            )}
            {live && (
              <span className="px-2.5 py-1 rounded-full border border-crimson/55 bg-crimson/15
                               text-[10px] uppercase tracking-[0.14em] text-crimsonbright font-semibold">
                live
              </span>
            )}
            <a
              href="/rosters"
              className="text-xs text-ash hover:text-bone underline underline-offset-2"
            >
              rosters
            </a>
            <button
              onClick={load}
              className="text-xs text-ash hover:text-bone underline underline-offset-2"
            >
              refresh
            </button>
          </div>
        </header>

        {/* ── Filters ──────────────────────────────────────────────────────
            The three questions actually asked of a draft record: what did one
            team take, where did the healers go, and when was somebody picked. */}
        <div className="flex items-end gap-2 flex-wrap mb-3">
          <input
            className="field-input py-1.5 text-[13px] w-[220px]"
            value={q}
            placeholder="Search a name or class"
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search picks"
          />
          <select
            className="field-input py-1.5 text-[13px] w-[190px]"
            value={team}
            onChange={(e) => setTeam(e.target.value)}
            aria-label="Filter by team"
          >
            <option value="">All teams</option>
            {(data.teams || []).map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <select
            className="field-input py-1.5 text-[13px] w-[130px]"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            aria-label="Filter by role"
          >
            <option value="">All roles</option>
            <option value="Tank">Tank</option>
            <option value="DPS">DPS</option>
            <option value="Healer">Healer</option>
          </select>
          <button
            onClick={() => setNewestFirst((v) => !v)}
            className="px-3 py-1.5 rounded border border-line text-xs text-ash hover:text-bone
                       hover:border-crimson transition-colors"
          >
            {newestFirst ? 'Newest first' : 'Pick order'}
          </button>
          {filtered && (
            <button
              onClick={() => { setTeam(''); setRole(''); setQ(''); }}
              className="text-xs text-crimsonbright underline underline-offset-2"
            >
              clear ({shown.length} of {data.picks.length})
            </button>
          )}
        </div>

        <div className="panel overflow-hidden">
          {shown.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-ash">
              {(data.picks || []).length === 0
                ? 'No picks yet — this fills in as the draft runs.'
                : 'Nothing matches that.'}
            </div>
          ) : (
            <div className="flex flex-col">
              {shown.map((p) => {
                const t = byId.get(p.team_id);
                return (
                  <div
                    key={p.pick_number}
                    className="px-4 py-2.5 border-b border-line/40 last:border-b-0
                               flex items-baseline gap-3 flex-wrap"
                  >
                    <span className="mono text-[11px] text-dim w-[74px] shrink-0">
                      R{p.round}<span className="text-line">·</span>P{p.pick_number}
                    </span>

                    <span className="text-[14px] min-w-[150px]">{p.player.player_name}</span>

                    <span className={`text-[11px] uppercase tracking-[0.1em] w-[52px] shrink-0
                                     ${ROLE_TONE[p.player.role] || 'text-ash'}`}>
                      {p.player.role || '—'}
                    </span>

                    <span className="text-[12px] text-ash truncate flex-1 min-w-[120px]">
                      {(p.player.classes || []).join(' · ')}
                    </span>

                    <span className="text-[13px] shrink-0">
                      <span className="text-dim">→ </span>
                      {t?.name || 'Unknown team'}
                    </span>

                    {/* Both flags are things somebody will ask about later, and
                        the answer is easier to keep here than to remember. */}
                    {p.compensation && (
                      <span className="text-[9px] uppercase tracking-[0.1em] text-crimsonbright shrink-0"
                            title="An extra pick — this team has a captain who is not playing.">
                        comp
                      </span>
                    )}
                    {p.auto && (
                      <span className="text-[9px] uppercase tracking-[0.1em] text-oxblood shrink-0"
                            title="The clock made this pick.">
                        auto
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <p className="text-[11px] text-dim mt-4">
          {live
            ? 'Updating while the draft runs. '
            : ''}
          In-game names and classes only — the same list the broadcast shows.
        </p>
      </div>
    </div>
  );
}
