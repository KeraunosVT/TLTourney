// The tournament leaderboard.
//
// Sorted on the server so the ordering matches the label, and re-fetched when
// the column changes rather than re-sorted here — the sort is part of what the
// numbers mean, and two places deciding it is two places to disagree.
//
// Only rows matched to a player at review time are counted. Everything else on
// a scoreboard — opponents, spectators, misreads — is kept as evidence on the
// match page and belongs to nobody, which is the point of matching rows to ids
// rather than to names.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api, { errorMessage } from '../api';
import { Panel, Pill, Empty, Note } from '../components/ui';
import { big } from './Match';

export default function Leaderboard() {
  const [data, setData] = useState(null);
  const [sort, setSort] = useState('damage_dealt');
  const [role, setRole] = useState('');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async (by) => {
    try {
      const { data: d } = await api.get(`/api/stats/leaderboard?sort=${encodeURIComponent(by)}`);
      setData(d);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, 'Could not read the leaderboard.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(sort); }, [load, sort]);

  if (loading) return <div className="p-8 text-sm text-ash">Loading…</div>;

  const teams = new Map((data?.teams || []).map((t) => [t.id, t]));
  const needle = q.trim().toLowerCase();
  const entries = (data?.entries || []).filter((e) => (
    (!role || e.role === role)
    && (!needle || e.player_name.toLowerCase().includes(needle)
      || (e.main_class || '').toLowerCase().includes(needle))
  ));

  const sorts = data?.sorts || {};

  return (
    <div className="px-6 py-7 max-w-[1300px] mx-auto">
      <header className="flex items-end justify-between gap-5 flex-wrap mb-4">
        <div>
          <h1 className="font-display text-[27px]">Leaderboard</h1>
          <p className="text-ash text-sm mt-1.5 max-w-[70ch]">
            Every match scoreboard, added up per player. Sorted by {sorts[sort]?.label?.toLowerCase() || sort}.
          </p>
        </div>
        {data?.entries?.length > 0 && <Pill tone="quiet">{data.entries.length} players</Pill>}
      </header>

      {error && <div className="mb-4 max-w-[900px]"><Note tone="bad">{error}</Note></div>}

      <Panel>
        <div className="px-4 py-3 border-b border-line flex gap-2 flex-wrap items-center">
          <input
            className="field-input py-1 text-[13px] w-auto flex-1 min-w-[200px]"
            placeholder="Search a name or a class…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select
            className="field-input py-1 text-[12.5px] w-auto"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            {Object.entries(sorts).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
          <select
            className="field-input py-1 text-[12.5px] w-auto"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="">Any role</option>
            {['Tank', 'DPS', 'Healer'].map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>

        {entries.length === 0 ? (
          <Empty>
            {data?.entries?.length
              ? 'Nobody matches those filters.'
              : 'No scoreboards have been committed yet — add one from a match on the bracket.'}
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px] border-collapse">
              <thead>
                <tr className="text-ash text-[10px] uppercase tracking-[0.1em] border-b border-line">
                  <th className="text-left px-3 py-2 font-semibold w-10">#</th>
                  <th className="text-left px-3 py-2 font-semibold">Player</th>
                  <th className="text-left px-3 py-2 font-semibold">Team</th>
                  <th className="text-left px-3 py-2 font-semibold">Class</th>
                  <th className="text-right px-3 py-2 font-semibold" title="games played">G</th>
                  <th className="text-right px-3 py-2 font-semibold">K</th>
                  <th className="text-right px-3 py-2 font-semibold">A</th>
                  <th className="text-right px-3 py-2 font-semibold">Damage</th>
                  <th className="text-right px-3 py-2 font-semibold">Healing</th>
                  <th className="text-right px-3 py-2 font-semibold">Dmg / game</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr key={e.signup_id} className="border-b border-line/40 hover:bg-panelup/50">
                    {/* The position in the CURRENT list, not a stored rank —
                        filtering changes what "3rd" means and it should. */}
                    <td className="px-3 py-1.5 mono text-ash">{i + 1}</td>
                    <td className="px-3 py-1.5">
                      <Link
                        to={`/player/${e.signup_id}`}
                        className="hover:text-crimsonbright underline underline-offset-2"
                      >
                        {e.player_name}
                      </Link>
                    </td>
                    <td className="px-3 py-1.5 text-ash text-[12px]">
                      {teams.get(e.team_id)?.tag || teams.get(e.team_id)?.name || '—'}
                    </td>
                    <td className="px-3 py-1.5 text-ash text-[12px]">{e.main_class || '—'}</td>
                    <td
                      className="px-3 py-1.5 text-right mono text-ash"
                      title={`${e.games} games across ${e.matches} match${e.matches === 1 ? '' : 'es'}`}
                    >
                      {e.games}
                    </td>
                    <td className="px-3 py-1.5 text-right mono">{e.kills}</td>
                    <td className="px-3 py-1.5 text-right mono">{e.assists}</td>
                    <td className="px-3 py-1.5 text-right mono">{big(e.damage_dealt)}</td>
                    <td className="px-3 py-1.5 text-right mono">{big(e.healing)}</td>
                    <td className="px-3 py-1.5 text-right mono text-ash">{big(e.avg_damage)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
