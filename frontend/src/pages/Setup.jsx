// Everything about the tournament itself, in one place.
//
// These controls were scattered: the deadline and the season lived on the
// approval queue, which is a page for working through signups; the roster shape
// lived nowhere at all and could not be changed. Settings that only appear
// beside the work they interrupt are settings nobody finds.
//
// Ordered by when you touch them — name and shape at setup, signups next, the
// season's end last — rather than by which table they belong to.
import { useCallback, useEffect, useMemo, useState } from 'react';
import api, { errorMessage } from '../api';
import { Panel, Pill, Button, Field, Note } from '../components/ui';
import { whenLocal, toLocalInput, fromLocalInput, humanDuration } from '../lib/clock';
import { roleDemand, startersPerTeam } from '@shared/parties.cjs';
import { ROLES } from '@shared/roles.cjs';

export default function Setup() {
  const [t, setT] = useState(null);
  const [teams, setTeams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState(null);

  const load = useCallback(async () => {
    try {
      const [tour, team] = await Promise.all([
        api.get('/api/organizer/signups'),
        api.get('/api/organizer/teams'),
      ]);
      setT(tour.data.tournament);
      setTeams(team.data.teams || []);
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err, 'Could not load the tournament.') });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async (patch, note) => {
    setBanner(null);
    try {
      const { data } = await api.put('/api/organizer/tournament', patch);
      setT(data.tournament);
      if (note) setBanner({ tone: 'good', text: note });
      return data.tournament;
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
      return null;
    }
  }, []);

  if (loading) return <div className="p-8 text-sm text-ash">Loading…</div>;
  if (!t) {
    return (
      <div className="px-6 py-7 max-w-[860px] mx-auto">
        <h1 className="font-display text-[27px]">Setup</h1>
        <NewSeason onDone={load} setBanner={setBanner} />
        {banner && <div className="mt-4"><Note tone={banner.tone}>{banner.text}</Note></div>}
      </div>
    );
  }

  const archived = t.status === 'complete';

  return (
    <div className="px-6 py-7 max-w-[1000px] mx-auto flex flex-col gap-4">
      <header className="flex items-end justify-between gap-5 flex-wrap">
        <div>
          <h1 className="font-display text-[27px]">Setup</h1>
          <p className="text-ash text-sm mt-1.5 max-w-[70ch]">
            The tournament itself — what it is called, the shape of a team, when signups close,
            and how the season ends.
          </p>
        </div>
        <Pill tone={archived ? 'quiet' : 'crimson'}>{archived ? 'archived' : t.status}</Pill>
      </header>

      {banner && <Note tone={banner.tone}>{banner.text}</Note>}

      {archived && (
        <Note tone="bad">
          This season is archived and read-only. Start the next one below — the site keeps showing
          this one until you do.
        </Note>
      )}

      {!archived && (
        <>
          <Name tournament={t} onSave={save} />
          <Shape tournament={t} teams={teams} onSave={save} />
          <Demand tournament={t} />
          <Signups tournament={t} onSave={save} />
        </>
      )}

      <Season tournament={t} onDone={load} setBanner={setBanner} />
    </div>
  );
}

// ── Name ────────────────────────────────────────────────────────────────────
function Name({ tournament, onSave }) {
  const [name, setName] = useState(tournament.name);
  useEffect(() => setName(tournament.name), [tournament.name]);
  const changed = name.trim() && name !== tournament.name;

  return (
    <Panel title="Name" subtitle="Shown on the sign-in page, the DMs and the broadcast">
      <div className="p-4 flex items-end gap-2 flex-wrap">
        <input
          className="field-input py-1.5 text-[14px] flex-1 min-w-[280px]"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
        <Button
          variant="primary"
          disabled={!changed}
          onClick={() => onSave({ name: name.trim() }, 'Renamed.')}
        >
          Save
        </Button>
      </div>
    </Panel>
  );
}

// ── The shape of a team ─────────────────────────────────────────────────────
// The one that decides how long draft night is, which is why the arithmetic is
// on screen beside the inputs rather than left to be discovered at 2am.
function Shape({ tournament, teams, onSave }) {
  const [count, setCount] = useState(tournament.party_count);
  const [size, setSize] = useState(tournament.party_size);
  const [subs, setSubs] = useState(tournament.sub_count);
  const [clock, setClock] = useState(120);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setCount(tournament.party_count);
    setSize(tournament.party_size);
    setSubs(tournament.sub_count);
  }, [tournament.party_count, tournament.party_size, tournament.sub_count]);

  const roster = count * size + subs;
  const changed = count !== tournament.party_count
    || size !== tournament.party_size
    || subs !== tournament.sub_count;

  // Draft length, which is what a roster size really decides. Two captains a
  // team are already on the roster, so they are not picks.
  const rounds = Math.max(0, roster - 2);
  const picks = teams.length * rounds;
  const worst = picks * clock;

  const num = (v, lo, hi, set) => (e) => {
    const n = parseInt(e.target.value, 10);
    if (Number.isFinite(n) && n >= lo && n <= hi) set(n);
    else if (e.target.value === '') set(lo);
  };

  return (
    <Panel
      title="The shape of a team"
      subtitle="Parties, party size and substitutes — everything else follows from these"
      right={<span className="mono text-[15px]">{roster} <span className="text-ash text-[12px]">per team</span></span>}
    >
      <div className="p-4 flex flex-col gap-4">
        <div className="flex items-end gap-3 flex-wrap">
          <div className="w-[110px]">
            <Field label="Parties"><input className="field-input py-1.5 text-[14px]" inputMode="numeric" value={count} onChange={num(count, 1, 24, setCount)} /></Field>
          </div>
          <span className="text-ash text-[18px] pb-2">×</span>
          <div className="w-[110px]">
            <Field label="Per party"><input className="field-input py-1.5 text-[14px]" inputMode="numeric" value={size} onChange={num(size, 1, 12, setSize)} /></Field>
          </div>
          <span className="text-ash text-[18px] pb-2">+</span>
          <div className="w-[110px]">
            <Field label="Subs"><input className="field-input py-1.5 text-[14px]" inputMode="numeric" value={subs} onChange={num(subs, 0, 60, setSubs)} /></Field>
          </div>
          <span className="text-ash text-[18px] pb-2">=</span>
          <div className="pb-1.5">
            <span className="mono text-[22px]">{roster}</span>
            <span className="text-ash text-[12px] ml-1.5">roster</span>
          </div>

          <Button
            variant="primary"
            className="ml-auto"
            disabled={!changed || busy}
            onClick={async () => {
              setBusy(true);
              await onSave(
                { party_count: count, party_size: size, sub_count: subs },
                `A team is now ${count} × ${size} + ${subs} = ${roster}.`
              );
              setBusy(false);
            }}
          >
            {busy ? 'Saving…' : 'Save shape'}
          </Button>
        </div>

        {/* Draft night, in hours. The number nobody works out in advance and
            everybody wishes they had. */}
        {teams.length > 0 && (
          <div className="border-t border-line pt-3 flex items-center gap-6 flex-wrap">
            <div>
              <div className="eyebrow">Draft rounds</div>
              <div className="mono text-[18px]">{rounds}</div>
            </div>
            <div>
              <div className="eyebrow">Picks · {teams.length} teams</div>
              <div className="mono text-[18px]">{picks}</div>
            </div>
            <div>
              <div className="eyebrow">If every clock runs out</div>
              <div className={`mono text-[18px] ${worst > 5 * 3600 ? 'text-crimsonbright' : ''}`}>
                {humanDuration(worst)}
              </div>
            </div>
            <label className="flex items-center gap-2 text-[12.5px] text-ash">
              at
              <select
                className="field-input py-1 text-[12.5px] w-auto"
                value={clock}
                onChange={(e) => setClock(Number(e.target.value))}
              >
                {[60, 90, 120, 180].map((s) => <option key={s} value={s}>{s}s a pick</option>)}
              </select>
            </label>
            {worst > 5 * 3600 && (
              <p className="text-xs text-ash max-w-[40ch] leading-relaxed">
                That is the worst case, not the expectation — but a shorter clock or a smaller
                roster is easier to decide now than at 2am.
              </p>
            )}
          </div>
        )}

        {changed && (
          <p className="text-xs text-crimsonbright leading-relaxed max-w-[74ch]">
            Saving reshapes the party template to match. Parties and slots are added at the end as
            “Any Role”, and removed from the end — parties you have tuned keep their slots.
          </p>
        )}
      </div>
    </Panel>
  );
}

// ── Signups ─────────────────────────────────────────────────────────────────
function Signups({ tournament, onSave }) {
  const [value, setValue] = useState(toLocalInput(tournament.signups_close_at));
  useEffect(() => setValue(toLocalInput(tournament.signups_close_at)), [tournament.signups_close_at]);

  const open = tournament.status === 'signups';
  const iso = fromLocalInput(value);
  const changed = value !== toLocalInput(tournament.signups_close_at);
  const passed = iso && new Date(iso) < new Date();

  return (
    <Panel
      title="Signups"
      subtitle="Filing and editing stop at the deadline. Withdrawing does not."
      right={<Pill tone={open ? 'good' : 'bad'}>{open ? 'open' : 'closed'}</Pill>}
    >
      <div className="p-4 flex flex-col gap-3">
        <div className="flex items-end gap-2 flex-wrap">
          <Button
            variant={open ? 'ghost' : 'good'}
            onClick={() => onSave(
              { status: open ? 'draft' : 'signups' },
              open ? 'Signups are closed — the pool is frozen.' : 'Signups are open.'
            )}
          >
            {open ? 'Close signups now' : 'Open signups'}
          </Button>

          <input
            type="datetime-local"
            className="field-input py-1.5 text-[13.5px] w-auto ml-auto"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button
            variant="primary"
            disabled={!changed || (!!value && !iso)}
            onClick={() => onSave({ signups_close_at: iso }, iso ? `Signups close ${whenLocal(iso)}.` : 'Deadline cleared.')}
          >
            Set deadline
          </Button>
          {tournament.signups_close_at && (
            <Button variant="ghost" onClick={() => { setValue(''); onSave({ signups_close_at: null }, 'Deadline cleared.'); }}>
              Clear
            </Button>
          )}
        </div>

        <p className={`text-[13px] ${passed ? 'text-crimsonbright' : 'text-ash'}`}>
          {iso
            ? <>Closes <span className="text-bone">{whenLocal(iso)}</span>{passed && ' — already passed.'}</>
            : 'No deadline set, so signups stay open until you close them by hand.'}
          {' '}Midnight at the start of a day is 00:00 on that date; for the end of the 3rd, set 00:00 on the 4th.
        </p>
      </div>
    </Panel>
  );
}

// ── The party template ──────────────────────────────────────────────────────
// Left out of this page on purpose. It is 48 dropdowns, it is edited once a
// season if ever, and the shape controls above keep it correct without anybody
// opening it. What is shown instead is what it MEANS: the per-role floor, which
// is the number that decides whether the pool can field these teams.
function Demand({ tournament, teams }) {
  const demand = useMemo(
    () => roleDemand(Array.isArray(tournament.party_template) ? tournament.party_template : [], 1),
    [tournament.party_template]
  );
  const starters = startersPerTeam(tournament.party_template || []);

  return (
    <Panel title="What one team needs" subtitle={`${starters} starters, from the party template`}>
      <div className="p-4 flex gap-6 flex-wrap items-baseline">
        {ROLES.map((r) => (
          <div key={r}>
            <div className="eyebrow">{r}</div>
            <div className="mono text-[18px]">
              {demand[r].min}<span className="text-ash text-[13px]">–{demand[r].max}</span>
            </div>
          </div>
        ))}
        <p className="text-xs text-ash max-w-[46ch] leading-relaxed">
          A range, because two slot types accept more than one role. The first number is the floor:
          below it the roster cannot be fielded whoever volunteers.
        </p>
      </div>
    </Panel>
  );
}

// ── Ending and starting a season ────────────────────────────────────────────
function Season({ tournament, onDone, setBanner }) {
  const [confirmText, setConfirmText] = useState('');
  const [showArchive, setShowArchive] = useState(false);
  const [busy, setBusy] = useState(null);
  const archived = tournament.status === 'complete';

  async function archive() {
    setBusy('archive');
    setBanner(null);
    try {
      await api.put('/api/organizer/tournament', { status: 'complete', confirm: confirmText });
      setShowArchive(false);
      setConfirmText('');
      setBanner({ tone: 'good', text: `${tournament.name} is archived.` });
      onDone();
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel title="Season" className={archived ? '' : 'border-oxblood/40'}>
      <div className="p-4 flex flex-col gap-3">
        {archived
          ? <NewSeason onDone={onDone} setBanner={setBanner} inline />
          : (
            <>
              <p className="text-xs text-ash leading-relaxed max-w-[74ch]">
                Archiving ends this season. Signups, the draft and the bracket become read-only, and
                the site keeps showing it until a new season exists — nothing disappears. Nothing
                archives itself: a champion is decided a week before the scoreboards stop being
                corrected.
              </p>
              {!showArchive ? (
                <Button variant="ghost" onClick={() => setShowArchive(true)} className="self-start">
                  Archive this season…
                </Button>
              ) : (
                <div className="flex items-end gap-2 flex-wrap">
                  <div className="w-[300px]">
                    <Field label="Type the season name">
                      <input
                        className="field-input py-1 text-[13px]"
                        value={confirmText}
                        onChange={(e) => setConfirmText(e.target.value)}
                        placeholder={tournament.name}
                      />
                    </Field>
                  </div>
                  <Button variant="danger" disabled={busy} onClick={archive}>
                    {busy === 'archive' ? 'Archiving…' : 'Archive'}
                  </Button>
                  <Button variant="ghost" onClick={() => { setShowArchive(false); setConfirmText(''); }}>
                    Cancel
                  </Button>
                </div>
              )}
            </>
          )}
      </div>
    </Panel>
  );
}

function NewSeason({ onDone, setBanner, inline }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setBanner(null);
    try {
      const { data } = await api.post('/api/organizer/tournament', { name });
      setName('');
      setBanner({ tone: 'good', text: `${data.tournament.name} created — open signups when you are ready.` });
      onDone();
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  const body = (
    <div className="flex items-end gap-2 flex-wrap">
      <div className="flex-1 min-w-[280px]">
        <Field
          label="Start the next season"
          hint="Opens in setup, 8 parties of 6 plus 12 subs. Open signups when you are ready."
        >
          <input
            className="field-input py-1.5 text-[13.5px]"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            placeholder="Season 3 Americas Draft Tournament"
          />
        </Field>
      </div>
      <Button variant="good" disabled={busy || !name.trim()} onClick={create}>
        {busy ? 'Creating…' : 'Create season'}
      </Button>
    </div>
  );

  return inline ? body : <Panel title="No tournament" className="mt-4"><div className="p-4">{body}</div></Panel>;
}
