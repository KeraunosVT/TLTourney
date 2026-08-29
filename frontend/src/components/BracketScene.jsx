// The bracket, as a broadcast scene.
//
// Not the /bracket page scaled up. That page is for an organizer two feet away
// who clicks things; this is for a viewer ten feet away who cannot. So: no
// controls, no scrolling, everything sized in viewport units, and the whole
// draw on screen at once — a bracket you have to scroll is a bracket nobody
// watching can read.
//
// It fits by shrinking rather than by hiding. A double-elimination bracket is
// two brackets and a final, and dropping either half to make the type bigger
// would leave the audience unable to see who is still alive.
import { whenShort } from '../lib/clock';

export default function BracketScene({ state }) {
  const teams = new Map((state.teams || []).map((t) => [t.id, t]));
  const columns = (bracket) => {
    const mine = (state.matches || []).filter((m) => m.bracket === bracket);
    const rounds = [...new Set(mine.map((m) => m.round))].sort((a, b) => a - b);
    return rounds.map((round) => ({
      round,
      label: mine.find((m) => m.round === round)?.label || `Round ${round}`,
      matches: mine.filter((m) => m.round === round).sort((a, b) => a.idx - b.idx),
    }));
  };

  const W = columns('W');
  const L = columns('L');
  const GF = (state.matches || []).filter((m) => m.bracket === 'GF' && (!m.is_reset || m.team_a_id));

  return (
    <div className="flex-1 min-h-0 px-[2vw] pb-[2vh] flex gap-[1vw]">
      <div className="flex-1 min-w-0 flex flex-col gap-[1.4vh]">
        <Half title="Winners" columns={W} teams={teams} />
        {L.length > 0 && <Half title="Losers" columns={L} teams={teams} tone="loser" />}
      </div>

      {/* The final gets its own column at full height. It is the thing the
          whole bracket is pointing at, and folding it into the winners row
          would make it one box among fifteen. */}
      <div className="w-[15vw] min-w-[150px] shrink-0 flex flex-col">
        <Label>Grand Final</Label>
        <div className="flex-1 flex flex-col justify-center gap-[1vh]">
          {GF.map((m) => <Fixture key={m.key} m={m} teams={teams} big />)}
        </div>
      </div>
    </div>
  );
}

const Label = ({ children }) => (
  <div className="text-[1.05vh] uppercase tracking-[0.22em] text-ash mb-[0.6vh] whitespace-nowrap">
    {children}
  </div>
);

function Half({ title, columns, teams, tone }) {
  return (
    <section className="flex-1 min-h-0 flex flex-col">
      <Label>{title}</Label>
      <div className={`flex-1 min-h-0 flex gap-[0.7vw] rounded border p-[0.6vh] ${
        tone === 'loser' ? 'border-oxblood/30 bg-oxblooddeep/20' : 'border-line/60 bg-panel/30'
      }`}
      >
        {columns.map((col) => (
          <div key={col.round} className="flex-1 min-w-0 flex flex-col">
            <div className="text-[0.95vh] uppercase tracking-[0.14em] text-dim mb-[0.5vh] truncate">
              {col.label}
            </div>
            <div className="flex-1 flex flex-col justify-around gap-[0.5vh] min-h-0">
              {col.matches.map((m) => <Fixture key={m.key} m={m} teams={teams} />)}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Fixture({ m, teams, big }) {
  const live = m.status === 'ready';
  const done = m.status === 'complete';

  return (
    <div
      className={`rounded border overflow-hidden ${
        live ? 'border-crimson bg-crimson/10' : done ? 'border-line/70 bg-panelup/40' : 'border-line/30'
      }`}
    >
      {[['a', m.team_a_id], ['b', m.team_b_id]].map(([slot, id], i) => {
        const team = teams.get(id);
        const won = done && m.winner_team_id === id;
        const lost = done && id && !won;
        const wins = i === 0 ? m.series?.winsA : m.series?.winsB;

        return (
          <div
            key={slot}
            className={`px-[0.4vw] py-[0.35vh] flex items-center gap-[0.4vw] ${
              i === 0 ? 'border-b border-line/40' : ''
            } ${won ? 'bg-verdigris/12' : ''} ${lost ? 'opacity-45' : ''}`}
          >
            <span className={`mono text-[0.9vh] text-ash w-[1.2vw] shrink-0 ${big ? 'text-[1.2vh]' : ''}`}>
              {team?.seed ?? ''}
            </span>
            <span className={`truncate flex-1 ${big ? 'text-[1.8vh]' : 'text-[1.25vh]'} ${won ? 'text-bone' : ''}`}>
              {team ? (team.tag || team.name) : <span className="text-dim">—</span>}
            </span>
            {/* The series score, not just a tick. In a best of three the
                difference between 2-0 and 2-1 is most of the story. */}
            {m.series?.played > 0 && (
              <span className={`mono shrink-0 ${big ? 'text-[1.6vh]' : 'text-[1.1vh]'} ${
                won ? 'text-verdigris' : 'text-ash'
              }`}
              >
                {wins ?? 0}
              </span>
            )}
          </div>
        );
      })}

      {/* Only on a fixture that has not happened: once it is played, the score
          above says everything and a date is clutter. */}
      {!done && m.scheduled_at && (
        <div className="px-[0.4vw] py-[0.2vh] text-[0.85vh] text-ash border-t border-line/30 truncate">
          {whenShort(m.scheduled_at)}
        </div>
      )}
    </div>
  );
}
