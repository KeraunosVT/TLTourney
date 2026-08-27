import { useCallback, useEffect, useState } from 'react';
import api, { errorMessage } from '../api';
import { Panel, Pill, Button, Empty, Note, Field } from '../components/ui';
import { CAPTAIN_SEATS } from '@shared/captains.cjs';

export default function Teams() {
  const [teams, setTeams] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [readiness, setReadiness] = useState(null);
  const [tournament, setTournament] = useState(null);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState(null);
  const [newName, setNewName] = useState('');
  const [newTag, setNewTag] = useState('');
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/api/organizer/teams');
      setTeams(data.teams || []);
      setCandidates(data.candidates || []);
      setReadiness(data.readiness);
      setTournament(data.tournament);
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err, 'Could not load the teams.') });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e?.preventDefault();
    if (!newName.trim()) return;
    setBusy('new');
    setBanner(null);
    try {
      await api.post('/api/organizer/teams', { name: newName.trim(), tag: newTag.trim() });
      setNewName(''); setNewTag('');
      await load();
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  async function addCaptain(team, seat, signupId) {
    setBusy(team.id);
    setBanner(null);
    try {
      await api.post(`/api/organizer/teams/${team.id}/captains`, { signup_id: signupId, seat });
      await load();
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
      // A conflict means what's on screen is stale — the seat, or the person,
      // went somewhere else since this page loaded.
      if (err?.response?.status === 409) load();
    } finally {
      setBusy(null);
    }
  }

  async function removeCaptain(team, captain) {
    setBusy(team.id);
    setBanner(null);
    try {
      await api.delete(`/api/organizer/teams/${team.id}/captains/${captain.id}`);
      await load();
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  async function remove(team) {
    if (!window.confirm(`Delete ${team.name}? This cannot be undone.`)) return;
    setBusy(team.id);
    try {
      await api.delete(`/api/organizer/teams/${team.id}`);
      await load();
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  async function move(team, delta) {
    const ordered = teams.filter((t) => t.seed != null);
    const i = ordered.findIndex((t) => t.id === team.id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ordered.length) return;
    const next = [...ordered];
    [next[i], next[j]] = [next[j], next[i]];
    setBusy(team.id);
    try {
      await api.post('/api/organizer/teams/reseed', { order: next.map((t) => t.id) });
      await load();
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <div className="p-8 text-sm text-ash">Loading…</div>;

  // Volunteers who are still free — the list shrinks as they're seated, which
  // is the point: what's left is who an organizer still has to place.
  const volunteers = candidates.filter((c) => c.wants_captain);
  const seatsFilled = teams.reduce((n, t) => n + (t.captains?.length || 0), 0);

  return (
    <div className="px-6 py-7 max-w-[1180px] mx-auto">
      <header className="flex items-end justify-between gap-5 flex-wrap mb-5">
        <div>
          <h1 className="font-display text-[27px]">Teams</h1>
          <p className="text-ash text-sm mt-1.5 max-w-[64ch]">
            Each team is {tournament?.party_count}&nbsp;parties of {tournament?.party_size} plus{' '}
            {tournament?.sub_count} subs — {tournament?.roster_size} players, run by a captain and a
            co-captain. Seed order is draft order: the snake starts at seed 1.
          </p>
        </div>
      </header>

      {banner && <div className="mb-4"><Note tone={banner.tone}>{banner.text}</Note></div>}

      {readiness && <Readiness r={readiness} />}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] items-start mt-4">
        <Panel
          title={`${teams.length} team${teams.length === 1 ? '' : 's'}`}
          right={<span className="text-xs text-ash">seed order = draft order</span>}
        >
          {teams.length === 0 && <Empty>No teams yet. Add the first one on the right.</Empty>}
          <div className="flex flex-col">
            {teams.map((t, i) => (
              <div key={t.id} className="px-4 py-3 border-b border-line/50 last:border-b-0 flex items-start gap-3 flex-wrap">
                <div className="flex flex-col items-center gap-0.5 pt-0.5">
                  <button
                    onClick={() => move(t, -1)}
                    disabled={i === 0 || busy === t.id}
                    className="text-ash hover:text-bone disabled:opacity-25 leading-none text-[11px]"
                    aria-label={`Move ${t.name} up`}
                  >▲</button>
                  <span className="mono text-[13px] w-6 text-center">{t.seed ?? '—'}</span>
                  <button
                    onClick={() => move(t, 1)}
                    disabled={i === teams.length - 1 || busy === t.id}
                    className="text-ash hover:text-bone disabled:opacity-25 leading-none text-[11px]"
                    aria-label={`Move ${t.name} down`}
                  >▼</button>
                </div>

                <div className="flex-1 min-w-[200px]">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-display text-[17px]">{t.name}</span>
                    {t.tag && <span className="mono text-[11px] text-crimson">{t.tag}</span>}
                  </div>
                  {/* One row per seat, always both, filled or not — an empty
                      co-captain seat is a thing to notice, and it disappears
                      entirely if empty seats aren't drawn. */}
                  <div className="mt-2 flex flex-col gap-1.5">
                    {CAPTAIN_SEATS.map(({ seat, label }) => {
                      const held = t.captains?.find((c) => c.seat === seat);
                      return (
                        <div key={seat} className="flex items-center gap-2 flex-wrap">
                          <span className="text-[10px] uppercase tracking-[0.14em] text-ash w-[74px] flex-none">
                            {label}
                          </span>
                          {held ? (
                            <>
                              <span className="text-[13px]">{held.player_name}</span>
                              <span className="text-[11px] text-ash">
                                {held.role || 'role not set'}
                                {held.classes?.[0] ? ` · ${held.classes[0]}` : ''}
                              </span>
                              <button
                                onClick={() => removeCaptain(t, held)}
                                disabled={busy === t.id}
                                className="text-[11px] text-ash hover:text-crimsonbright underline underline-offset-2"
                              >
                                remove
                              </button>
                            </>
                          ) : (
                            <select
                              className="field-input py-1 text-[12.5px] max-w-[260px]"
                              value=""
                              disabled={busy === t.id || candidates.length === 0}
                              onChange={(e) => e.target.value && addCaptain(t, seat, e.target.value)}
                              aria-label={`${label} for ${t.name}`}
                            >
                              <option value="">
                                {candidates.length ? `— assign a ${label.toLowerCase()} —` : '— nobody available —'}
                              </option>
                              {candidates.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.player_name}{c.wants_captain ? ' ★ volunteered' : ''}
                                  {c.role ? ` — ${c.role}` : ''}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                <Button variant="ghost" onClick={() => remove(t)} disabled={busy === t.id}>Delete</Button>
              </div>
            ))}
          </div>
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel title="Add a team">
            <form className="p-4 flex flex-col gap-3" onSubmit={create}>
              <Field label="Name" htmlFor="tname">
                <input
                  id="tname"
                  className="field-input"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  maxLength={40}
                  placeholder="Iron Vow"
                />
              </Field>
              <Field label="Tag" htmlFor="ttag" optional hint="Short form for the bracket. Up to 6 characters.">
                <input
                  id="ttag"
                  className="field-input mono max-w-[130px] uppercase"
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                  maxLength={6}
                  placeholder="IRV"
                />
              </Field>
              <Button type="submit" disabled={!newName.trim() || busy === 'new'} className="self-start px-4 py-2 text-[13px]">
                {busy === 'new' ? 'Adding…' : 'Add team'}
              </Button>
            </form>
          </Panel>

          <Panel
            title="Captain volunteers"
            right={
              <span className="text-xs text-ash">
                {seatsFilled} of {teams.length * CAPTAIN_SEATS.length} seats filled
              </span>
            }
          >
            {volunteers.length === 0 ? (
              <Empty>
                {seatsFilled > 0
                  ? 'Every volunteer has a seat.'
                  : 'Nobody has volunteered to captain yet.'}
              </Empty>
            ) : (
              <div className="flex flex-col">
                {volunteers.map((c) => (
                  <div key={c.id} className="px-4 py-2 border-b border-line/50 last:border-b-0 text-[13px] flex items-center gap-2 flex-wrap">
                    <span>{c.player_name}</span>
                    <span className="text-[11px] text-ash">
                      {c.role || 'role not set'}{c.classes?.[0] ? ` · ${c.classes[0]}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

// The headline: can this pool fill these teams?
//
// Role figures are shown against the FLOOR — the slots only that role can take.
// The ceiling is there as context, but chasing it would mean recruiting for
// slots the flexible ones already cover.
function Readiness({ r }) {
  const ok = r.short === 0 && r.roles.every((x) => x.short === 0);
  return (
    <Panel
      title="Can the pool fill these teams?"
      right={
        r.teams === 0
          ? <Pill tone="quiet">no teams yet</Pill>
          : ok
            ? <Pill tone="good">yes — every role covered</Pill>
            : <Pill tone="bad">{r.short} short of {r.needed}</Pill>
      }
    >
      <div className="p-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div>
          <div className="eyebrow mb-2">Roster spots</div>
          <div className="mono text-[26px]">{r.approved}<span className="text-ash text-[16px]"> / {r.needed}</span></div>
          <p className="text-xs text-ash mt-1.5 leading-relaxed">
            {r.teams} team{r.teams === 1 ? '' : 's'} × {r.rosterSize} — {r.starters} starting
            and {r.subs} substitute spots.
            {r.short > 0 && <> <span className="text-crimsonbright">{r.short} more signups needed.</span></>}
          </p>
          {r.unanswered > 0 && (
            <p className="text-xs text-ash mt-2">
              {r.unanswered} approved signup{r.unanswered === 1 ? '' : 's'} predate the role
              question and aren't counted below.
            </p>
          )}
        </div>

        <div>
          <div className="eyebrow mb-2">By role — against the minimum each needs</div>
          <div className="flex flex-col gap-2">
            {r.roles.map((x) => {
              const pct = x.min === 0 ? 100 : Math.min(100, (x.have / x.min) * 100);
              return (
                <div key={x.role} className="flex items-center gap-2.5 text-[13px]">
                  <span className="w-[54px] flex-none text-ash">{x.role}</span>
                  <span className="flex-1 h-[9px] rounded bg-panelup overflow-hidden">
                    <i
                      className={`block h-full ${x.short > 0 ? 'bg-oxblood' : 'bg-verdigris/80'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </span>
                  <span className="mono text-[12px] w-[74px] text-right">
                    {x.have}<span className="text-ash">/{x.min}</span>
                  </span>
                  <span className="mono text-[10.5px] text-ash w-[52px] text-right" title="ceiling, if every flexible slot went to this role">
                    max {x.max}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Panel>
  );
}
