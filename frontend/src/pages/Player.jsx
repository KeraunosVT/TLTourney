// One player: what they signed up as, who drafted them, and what they did.
//
// Reached by signup id, never by name. Names are what scoreboards give and they
// are not identity — two people can pick the same one, and OCR mangles them —
// so the id is resolved once at review time and everything here keys off it.
import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import api, { errorMessage } from '../api';
import { Panel, Pill, Tile, Empty, Note } from '../components/ui';
import { big } from './Match';

export default function Player() {
  const { signupId } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data: d } = await api.get(`/api/stats/player/${signupId}`);
        if (alive) setData(d);
      } catch (err) {
        if (alive) setError(errorMessage(err, 'Could not read that player.'));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [signupId]);

  if (loading) return <div className="p-8 text-sm text-ash">Loading…</div>;
  if (error) return <div className="p-8 max-w-[700px]"><Note tone="bad">{error}</Note></div>;

  const { player, team, drafted, stats } = data;
  const played = stats.matches > 0;

  return (
    <div className="px-6 py-7 max-w-[1200px] mx-auto">
      <header className="flex items-end justify-between gap-5 flex-wrap mb-5">
        <div>
          <Link to="/leaderboard" className="text-xs text-ash hover:text-bone underline underline-offset-2">
            ← leaderboard
          </Link>
          <h1 className="font-display text-[30px] mt-1">{player.player_name}</h1>
          <p className="text-ash text-sm mt-1">
            {player.role || 'no role given'}
            {player.classes?.length > 0 && ` · signed up on ${player.classes.join(' · ')}`}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {player.wants_shotcall && <Pill tone="good">shotcaller</Pill>}
          {team && <Pill tone="crimson">{team.name}</Pill>}
        </div>
      </header>

      {drafted && (
        <p className="text-[13px] text-ash mb-4">
          {drafted.via === 'captain'
            ? `Captain of ${team?.name || 'their team'}.`
            : drafted.pick
              ? `Drafted in round ${drafted.round}, pick ${drafted.pick}.`
              : 'Added to the roster manually.'}
        </p>
      )}

      {!played ? (
        <Panel>
          <Empty>
            {stats.orphaned > 0
              ? `No matches on record. ${stats.orphaned} scoreboard row(s) belonged to matches that have since been deleted.`
              : 'They have not played a match with a committed scoreboard yet.'}
          </Empty>
        </Panel>
      ) : (
        <>
          <div className="grid gap-3 mb-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
            <Tile label="Matches" value={stats.matches} />
            <Tile label="Kills" value={stats.kills} note={`${stats.avg_kills.toFixed(1)} / match`} />
            <Tile label="Assists" value={stats.assists} />
            <Tile label="Damage" value={big(stats.damage_dealt)} note={`${big(stats.avg_damage)} / match`} />
            <Tile label="Healing" value={big(stats.healing)} note={`${big(stats.avg_healing)} / match`} />
            <Tile label="Damage taken" value={big(stats.damage_taken)} note={`${big(stats.avg_taken)} / match`} />
          </div>

          {stats.orphaned > 0 && (
            <div className="mb-4 max-w-[900px]">
              {/* Said out loud rather than quietly dropped. A history that is
                  shorter than somebody remembers, with no explanation, is the
                  bug this line exists to prevent. */}
              <Note tone="bad">
                {stats.orphaned} more row(s) exist for this player on matches that have since been
                deleted, so they are not counted above.
              </Note>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)] items-start">
            <Panel title="Matches" subtitle="Most recent first">
              <div className="overflow-x-auto">
                <table className="w-full text-[13px] border-collapse">
                  <thead>
                    <tr className="text-ash text-[10px] uppercase tracking-[0.1em] border-b border-line">
                      <th className="text-left px-3 py-2 font-semibold">Match</th>
                      <th className="text-left px-3 py-2 font-semibold">Class</th>
                      <th className="text-right px-3 py-2 font-semibold">#</th>
                      <th className="text-right px-3 py-2 font-semibold">K</th>
                      <th className="text-right px-3 py-2 font-semibold">A</th>
                      <th className="text-right px-3 py-2 font-semibold">Damage</th>
                      <th className="text-right px-3 py-2 font-semibold">Healing</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.history.map((h) => (
                      <tr key={h.match_id} className="border-b border-line/40">
                        <td className="px-3 py-1.5">
                          <Link
                            to={`/match/${encodeURIComponent(h.key)}`}
                            className="mono text-[12px] hover:text-crimsonbright underline underline-offset-2"
                          >
                            {h.key}
                          </Link>
                        </td>
                        <td className="px-3 py-1.5 text-ash text-[12px]">{h.class}</td>
                        <td className="px-3 py-1.5 text-right mono text-ash">{h.rank ?? '—'}</td>
                        <td className="px-3 py-1.5 text-right mono">{h.kills}</td>
                        <td className="px-3 py-1.5 text-right mono">{h.assists}</td>
                        <td className="px-3 py-1.5 text-right mono">{big(h.damage_dealt)}</td>
                        <td className="px-3 py-1.5 text-right mono">{big(h.healing)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel title="What they played" subtitle="From the weapons on each scoreboard">
              <div className="p-4 flex flex-col gap-2">
                {stats.classes.map((c) => (
                  <div key={c.name} className="flex items-center gap-3">
                    <span className="text-[13px] flex-1 truncate">{c.name}</span>
                    <span className="mono text-[12px] text-ash">{c.count}</span>
                    <div className="w-[70px] h-1.5 rounded-full bg-panelup overflow-hidden">
                      <div
                        className="h-full bg-crimson rounded-full"
                        style={{ width: `${(c.count / stats.matches) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
                {/* Worth showing next to what they actually played: somebody who
                    signed up on three classes and only ever played one is a
                    different planning problem from somebody who flexed. */}
                {player.classes?.length > 0 && (
                  <p className="text-[11.5px] text-ash mt-2 leading-relaxed border-t border-line pt-2">
                    Signed up on {player.classes.join(', ')}.
                  </p>
                )}
              </div>
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
