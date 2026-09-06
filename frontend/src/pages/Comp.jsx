// The comp, laid out to be SCREENSHOT — /comp.
//
// Instead of posting to Discord from the server, this is the page a captain
// crops and pastes. That makes the requirements different from every other
// page in the app, and they are worth stating because they are what the layout
// is for:
//
//   FIXED WIDTH, not fluid. A screenshot is cropped by hand, and a layout that
//   reflows with the window means two captains produce two differently-shaped
//   images of the same thing. 1180px sits inside a maximised browser on a
//   1440-wide screen with room for the crop.
//
//   NO NAVIGATION, NO CONTROLS. Anything interactive is something that ends up
//   in the picture looking like a button nobody can press. The one control —
//   the team switcher — is hidden until the mouse is over the page, the trick
//   /watch and /lower already use for producer-only chrome.
//
//   EVERY SEAT DRAWN, filled or not. An empty seat is information: it is what
//   the comp still needs, and a layout that omits them makes a half-built comp
//   look finished. The Teams page makes the same argument about empty captain
//   seats.
//
//   NO SCROLLING WITHIN IT. Eight parties of six is 48 names and they all have
//   to be in one frame, or the screenshot is two screenshots.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api, { errorMessage } from '../api';

const ROLE_EDGE = {
  Tank: 'border-l-verdigris',
  DPS: 'border-l-crimson',
  Healer: 'border-l-bone/60',
};

export default function Comp() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(null);

  const wanted = params.get('team') || '';

  const load = useCallback(async () => {
    try {
      const { data: d } = await api.get('/api/parties');
      setData(d);
    } catch (err) {
      setFailed(errorMessage(err, 'Could not load the comps.'));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Default to the caller's own team when they captain one — a captain opening
  // this from the builder means theirs, and asking them to pick it every time
  // is a click between them and the screenshot they came for.
  const team = useMemo(() => {
    const teams = data?.teams || [];
    return teams.find((x) => x.id === wanted)
      || teams.find((x) => x.id === data?.editableTeamId)
      || teams[0]
      || null;
  }, [data, wanted]);

  if (failed) return <div className="p-8 text-sm text-oxblood">{failed}</div>;
  if (!data) return <div className="p-8 text-sm text-ash">Loading…</div>;

  // The server sends only the comps this caller may see, so an empty list is
  // an answer rather than a slow load — somebody who captains nothing and does
  // not organise. Said plainly instead of spinning forever.
  if (!team) {
    return (
      <div className="p-8 text-sm text-ash max-w-[60ch]">
        Comps are visible to the captains of the team they belong to. If you captain a
        team, this page will show yours.
      </div>
    );
  }

  const seatOf = new Map(
    (team.seats || []).map((s) => [`${s.party_index}:${s.slot_index}`, s.signup_id]),
  );
  const byId = new Map((team.roster || []).map((m) => [m.id, m]));
  const seated = (team.seats || []).length;

  return (
    <div className="min-h-screen bg-ink flex flex-col items-center py-6">
      {/* Producer-only, and only a mouse reveals it — the same reason /watch
          hides its scene switcher. A screenshot never contains a cursor.

          The switcher renders only when more than one comp came back, which
          means only for organizers: a captain is sent exactly one team by the
          server and has nothing to switch between. It is not a permission
          check — the server already made that decision — it is a control with
          nothing to do disappearing rather than showing a list of one. */}
      <div className="w-[1180px] mb-2 opacity-0 hover:opacity-100 focus-within:opacity-100
                      transition-opacity flex items-center gap-2">
        {(data.teams || []).length > 1 && (
          <>
            <span className="text-[11px] text-ash">Team</span>
            <select
              className="field-input py-1 text-[12px] max-w-[240px]"
              value={team.id}
              onChange={(e) => setParams({ team: e.target.value })}
            >
              {(data.teams || []).map((x) => (
                <option key={x.id} value={x.id}>{x.name}</option>
              ))}
            </select>
          </>
        )}
        <span className="text-[11px] text-dim">
          crop the card below — this row is invisible without a cursor on it
        </span>
      </div>

      {/* THE CROP. Everything inside this box is the image. */}
      <div className="w-[1180px] border border-line bg-panel">
        <header className="px-5 py-3.5 border-b border-line flex items-baseline gap-3 flex-wrap">
          <h1 className="font-display text-[22px] leading-none">{team.name}</h1>
          {team.tag && <span className="mono text-[12px] text-crimson">{team.tag}</span>}
          {team.seed != null && (
            <span className="mono text-[11px] text-ash">seed {team.seed}</span>
          )}
          <span className="ml-auto text-[11px] uppercase tracking-[0.18em] text-ash">
            {data.tournament?.name}
          </span>
          <span className="mono text-[12px] text-ash">
            {seated}<span className="text-dim">/{data.starters}</span>
          </span>
        </header>

        <div className="grid grid-cols-4 gap-px bg-line">
          {(data.template || []).map((party, pi) => (
            <div key={pi} className="bg-panel p-3">
              <div className="flex items-baseline gap-2 mb-2">
                <span className="mono text-[11px] text-crimson">{pi + 1}</span>
                <span className="text-[12px] font-semibold truncate">{party.name || 'Party'}</span>
              </div>
              <div className="flex flex-col gap-1">
                {(party.slots || []).map((type, si) => {
                  const m = byId.get(seatOf.get(`${pi}:${si}`));
                  return (
                    <div
                      key={si}
                      className={`border-l-2 pl-2 py-0.5 ${
                        m ? (ROLE_EDGE[m.role] || 'border-l-line') : 'border-l-line/40'
                      }`}
                    >
                      <div className="text-[12px] leading-tight truncate">
                        {m ? m.player_name : <span className="text-dim italic">— {type} —</span>}
                      </div>
                      <div className="text-[10px] text-ash leading-tight truncate">
                        {m ? ((m.classes || []).join(' · ') || m.role || type) : ''}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* The bench belongs in the picture. "Who is not playing" is the first
            question anybody asks of a comp posted in Discord, and a screenshot
            that cannot answer it gets a reply asking. */}
        {(team.bench || []).length > 0 && (
          <div className="px-5 py-3 border-t border-line">
            <div className="text-[10px] uppercase tracking-[0.18em] text-ash mb-1.5">
              Bench · {team.bench.length}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {team.bench.map((m) => (
                <span key={m.id} className="text-[11.5px] text-bone/80">
                  {m.player_name}
                  <span className="text-dim"> {m.role || '—'}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
