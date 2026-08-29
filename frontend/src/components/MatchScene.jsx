// One match, as a broadcast scene: who is playing, where, and who did what.
//
// The scene a commentator talks over between games. Two columns, and the split
// is deliberate — the left is the SERIES (the thing being decided), the right
// is the last GAME (the thing just watched). Merging them produces a screen
// where nobody can tell which numbers belong to which.
//
// The scoreboard is cut to the top few by damage and by healing rather than
// shown whole. A hundred rows at a legible size is four screens, and the rows
// anybody talks about are the top of each.
export default function MatchScene({ focus, teams }) {
  if (!focus) {
    return (
      <div className="flex-1 grid place-items-center">
        <div className="text-[2.4vh] text-ash">No match to show yet.</div>
      </div>
    );
  }

  const a = teams.get(focus.team_a_id);
  const b = teams.get(focus.team_b_id);
  const s = focus.series || {};
  const rows = focus.scoreboard || [];

  const top = (field, n = 6) => [...rows]
    .sort((x, y) => (y[field] || 0) - (x[field] || 0))
    .slice(0, n);

  return (
    <div className="flex-1 min-h-0 px-[2.5vw] pb-[2vh] grid grid-cols-[1fr_1.15fr] gap-[2vw]">
      {/* ── The series ─────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-[1.4vh] min-h-0">
        <div className="panel px-[1.4vw] py-[1.6vh]">
          <div className="text-[1.1vh] uppercase tracking-[0.22em] text-ash">
            {focus.label || focus.key} · best of {focus.best_of}
          </div>

          <div className="flex items-center justify-between gap-[1vw] mt-[1.2vh]">
            <Side team={a} wins={s.winsA} won={s.winnerId === focus.team_a_id} />
            <span className="mono text-[2.6vh] text-dim shrink-0">vs</span>
            <Side team={b} wins={s.winsB} won={s.winnerId === focus.team_b_id} align="right" />
          </div>
        </div>

        {/* Games, with the map each was played on. */}
        <div className="panel flex-1 min-h-0 overflow-hidden">
          <div className="px-[1.2vw] py-[0.9vh] border-b border-line text-[1.05vh] uppercase tracking-[0.2em] text-ash">
            Games
          </div>
          {(focus.games || []).filter((g) => g.map || g.winner_team_id).map((g) => (
            <div
              key={g.game_number}
              className={`px-[1.2vw] py-[1vh] border-b border-line/40 last:border-b-0 flex items-center gap-[1vw] ${
                g.dead ? 'opacity-45' : ''
              }`}
            >
              <span className="text-[1.3vh] text-ash w-[3.5vw] shrink-0">Game {g.game_number}</span>
              <span className="text-[1.9vh] flex-1 truncate">{g.map || '—'}</span>
              <span className="text-[1.5vh] truncate max-w-[9vw]">
                {g.winner_team_id
                  ? (teams.get(g.winner_team_id)?.tag || teams.get(g.winner_team_id)?.name)
                  : <span className="text-ash">to play</span>}
              </span>
            </div>
          ))}

          {/* Bans last: they are context for the maps above, and reading them
              first would be reading the negative space before the picture. */}
          {(focus.ban_a || focus.ban_b) && (
            <div className="px-[1.2vw] py-[1vh] border-t border-line flex items-center gap-[1.4vw] flex-wrap">
              <span className="text-[1.05vh] uppercase tracking-[0.2em] text-ash">Banned</span>
              {[[focus.ban_a, a], [focus.ban_b, b]].filter(([m]) => m).map(([map, team]) => (
                <span key={map} className="text-[1.4vh]">
                  <span className="line-through text-crimsonbright">{map}</span>
                  <span className="text-ash text-[1.1vh] ml-[0.4vw]">{team?.tag || team?.name}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── The last game played ───────────────────────────────────────── */}
      <div className="flex flex-col gap-[1.4vh] min-h-0">
        {rows.length === 0 ? (
          <div className="panel flex-1 grid place-items-center">
            <span className="text-[1.8vh] text-ash">No scoreboard yet</span>
          </div>
        ) : (
          <>
            <Chart
              title={`Game ${focus.scoreboardGame} · most damage`}
              rows={top('damage_dealt')}
              field="damage_dealt"
              teams={teams}
            />
            <Chart
              title="Most healing"
              rows={top('healing', 4)}
              field="healing"
              teams={teams}
              tone="good"
            />
          </>
        )}
      </div>
    </div>
  );
}

function Side({ team, wins, won, align }) {
  return (
    <div className={`min-w-0 flex-1 ${align === 'right' ? 'text-right' : ''}`}>
      <div className={`font-display text-[3.4vh] leading-tight truncate ${won ? 'text-verdigris' : ''}`}>
        {team?.name || 'TBD'}
      </div>
      <div className={`mono text-[4.4vh] leading-none mt-[0.4vh] ${won ? 'text-verdigris' : 'text-ash'}`}>
        {wins ?? 0}
      </div>
    </div>
  );
}

// A bar chart rather than a table. At ten feet the ORDER and the GAP are what
// read; the exact figure is a caption on the bar, not the point of it.
function Chart({ title, rows, field, teams, tone }) {
  const max = Math.max(1, ...rows.map((r) => r[field] || 0));
  const big = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

  return (
    <div className="panel flex-1 min-h-0 overflow-hidden flex flex-col">
      <div className="px-[1.2vw] py-[0.9vh] border-b border-line text-[1.05vh] uppercase tracking-[0.2em] text-ash">
        {title}
      </div>
      <div className="flex-1 min-h-0 px-[1.2vw] py-[0.9vh] flex flex-col justify-around">
        {rows.map((r) => (
          <div key={`${r.player_name}-${r.rank}`} className="flex items-center gap-[0.8vw]">
            <span className="text-[1.5vh] w-[9vw] truncate shrink-0">{r.player_name}</span>
            <span className="text-[1vh] text-ash w-[4.5vw] truncate shrink-0">
              {teams.get(r.team_id)?.tag || teams.get(r.team_id)?.name || ''}
            </span>
            <div className="flex-1 h-[1.5vh] rounded-sm bg-panelup overflow-hidden">
              <div
                className={`h-full rounded-sm ${tone === 'good' ? 'bg-verdigris/70' : 'bg-crimson/80'}`}
                style={{ width: `${((r[field] || 0) / max) * 100}%` }}
              />
            </div>
            <span className="mono text-[1.4vh] w-[4vw] text-right shrink-0">{big(r[field] || 0)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
