import { useEffect, useMemo, useState } from 'react';
import api, { errorMessage, fieldErrors } from '../api';
import { useAuth } from '../auth';
import { classify, WEAPONS } from '@shared/classes.cjs';
import { Panel, Pill, Button, Field, Tile, Note } from '../components/ui';

const NIGHTS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const STATUS_PILL = {
  pending: ['brass', 'Awaiting review'],
  approved: ['good', 'Approved'],
  rejected: ['bad', 'Not accepted'],
  withdrawn: ['quiet', 'Withdrawn'],
};

export default function Signup() {
  const { user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [closedReason, setClosedReason] = useState(null);
  const [signup, setSignup] = useState(null);
  const [pool, setPool] = useState(null);
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);

  // The form's own state. Seeded from an existing signup when there is one, so
  // editing starts from what you filed rather than from blank.
  const [form, setForm] = useState({
    player_name: '',
    weapon_1: 'Greatsword',
    weapon_2: 'Dagger',
    gear_level: '',
    nights: [],
    notes: '',
    wants_captain: false,
  });

  const set = (k, v) => {
    setForm((f) => ({ ...f, [k]: v }));
    // Clear the message under a field as soon as it's touched — a stale error
    // sitting under a field you just fixed reads as though it's still wrong.
    setErrors((e) => {
      const next = { ...e };
      delete next[k];
      if (k === 'weapon_1' || k === 'weapon_2') delete next.weapons;
      return next;
    });
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [mine, poolRes] = await Promise.all([
          api.get('/api/signup/mine'),
          api.get('/api/signup/pool'),
        ]);
        if (!alive) return;
        setOpen(mine.data.open);
        setClosedReason(mine.data.reason);
        setPool(poolRes.data);
        if (mine.data.signup) {
          const s = mine.data.signup;
          setSignup(s);
          setForm({
            player_name: s.player_name,
            weapon_1: s.weapon_1,
            weapon_2: s.weapon_2,
            gear_level: String(s.gear_level),
            nights: s.nights || [],
            notes: s.notes || '',
            wants_captain: !!s.wants_captain,
          });
        } else {
          // Nothing filed yet — a sensible starting point beats an empty box.
          setForm((f) => ({ ...f, player_name: user?.username || '' }));
        }
      } catch (err) {
        if (alive) setBanner({ tone: 'bad', text: errorMessage(err, 'Could not load your signup.') });
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [user]);

  // The whole point of this form: the class follows from the weapon pair, so it
  // is never asked for. Computed with the same shared/classes.cjs the server
  // derives it with, which is why the two can't disagree.
  const derived = useMemo(() => {
    if (form.weapon_1 === form.weapon_2) {
      return { ok: false, text: 'Pick two different weapons', why: 'Every class in the game is a pair.' };
    }
    const name = classify(form.weapon_1, form.weapon_2);
    if (!name) return { ok: false, text: 'No class for that pair', why: 'That combination isn\'t in the class table.' };
    const peers = pool?.classes?.find((c) => c.class_name === name)?.count ?? 0;
    return { ok: true, name, peers };
  }, [form.weapon_1, form.weapon_2, pool]);

  const toggleNight = (n) =>
    set('nights', form.nights.includes(n) ? form.nights.filter((x) => x !== n) : [...form.nights, n]);

  async function save(e) {
    e?.preventDefault();
    setSaving(true);
    setErrors({});
    setBanner(null);
    try {
      const { data } = await api.put('/api/signup/mine', {
        ...form,
        gear_level: form.gear_level,
      });
      setSignup(data.signup);
      setBanner({
        tone: 'good',
        text: data.created
          ? "Signup filed — an organizer will review it and you'll get a DM."
          : 'Saved.',
      });
      const poolRes = await api.get('/api/signup/pool');
      setPool(poolRes.data);
    } catch (err) {
      setErrors(fieldErrors(err));
      setBanner({ tone: 'bad', text: errorMessage(err, 'Could not save your signup.') });
    } finally {
      setSaving(false);
    }
  }

  async function withdraw() {
    if (!window.confirm('Withdraw your signup? You can file again while signups are open.')) return;
    setSaving(true);
    try {
      const { data } = await api.delete('/api/signup/mine');
      setSignup(data.signup);
      setBanner({ tone: 'good', text: 'Withdrawn. File again any time before signups close.' });
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="p-8 text-sm text-ash">Loading…</div>;
  }

  const locked = !open;
  const [pillTone, pillText] = signup ? STATUS_PILL[signup.status] : ['quiet', 'Not filed'];

  return (
    <div className="px-6 py-7 max-w-[1180px] mx-auto">
      <header className="flex items-end justify-between gap-5 flex-wrap mb-5">
        <div>
          <h1 className="font-display text-[27px]">Sign up</h1>
          <p className="text-ash text-sm mt-1.5 max-w-[64ch]">
            This is the pool captains draft from. Fill it in once — you can keep editing until
            signups close, and nothing here is visible to captains until an organizer approves it.
          </p>
        </div>
        <Pill tone={pillTone} blip={signup?.status === 'pending'}>{pillText}</Pill>
      </header>

      {locked && (
        <div className="mb-4">
          <Note tone="bad">
            {closedReason}
            {signup ? ' Your entry is read-only from here.' : ''}
          </Note>
        </div>
      )}
      {banner && <div className="mb-4"><Note tone={banner.tone}>{banner.text}</Note></div>}

      {signup?.status === 'rejected' && signup.decision_note && (
        <div className="mb-4">
          <Note tone="bad">
            <strong>Not accepted:</strong> {signup.decision_note}
            {open && ' — fix it above and save to go back in the queue.'}
          </Note>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] items-start">
        {/* ── the form ── */}
        <Panel title="Your details" right={<span className="text-xs text-ash">{signup ? 'Editing your entry' : 'New entry'}</span>}>
          <form className="p-5 flex flex-col gap-5" onSubmit={save}>
            <Field
              label="In-game character name"
              htmlFor="player_name"
              error={errors.player_name}
              hint="Exactly as it appears on the scoreboard — this is how your stats get matched to you."
            >
              <input
                id="player_name"
                className="field-input"
                value={form.player_name}
                onChange={(e) => set('player_name', e.target.value)}
                disabled={locked}
                maxLength={32}
                spellCheck={false}
                autoComplete="off"
              />
            </Field>

            <Field
              label="Weapons"
              error={errors.weapons}
              hint="Your class follows from the pair — the game decides it, so we don't ask."
            >
              <div className="flex items-center gap-2.5">
                <select
                  className="field-input"
                  aria-label="First weapon"
                  value={form.weapon_1}
                  onChange={(e) => set('weapon_1', e.target.value)}
                  disabled={locked}
                >
                  {WEAPONS.map((w) => <option key={w}>{w}</option>)}
                </select>
                <span className="text-ash">+</span>
                <select
                  className="field-input"
                  aria-label="Second weapon"
                  value={form.weapon_2}
                  onChange={(e) => set('weapon_2', e.target.value)}
                  disabled={locked}
                >
                  {WEAPONS.map((w) => <option key={w}>{w}</option>)}
                </select>
              </div>
            </Field>

            {/* The derived class, shown as you pick. */}
            <div
              className={`rounded border px-4 py-3.5 flex items-center justify-between gap-4 flex-wrap ${
                derived.ok
                  ? 'border-brass/45 bg-gradient-to-r from-brass/12 to-panelup/50'
                  : 'border-oxblood/55 bg-oxblooddeep'
              }`}
            >
              <div>
                <div className="eyebrow mb-1">{derived.ok ? 'Your class' : 'No class'}</div>
                {derived.ok ? (
                  <>
                    <div className="font-display text-[26px] leading-tight">{derived.name}</div>
                    <div className="text-xs text-ash mt-0.5">{form.weapon_1} · {form.weapon_2}</div>
                  </>
                ) : (
                  <>
                    <div className="font-display text-[17px] text-oxblood">{derived.text}</div>
                    <div className="text-xs text-ash mt-0.5">{derived.why}</div>
                  </>
                )}
              </div>
              {derived.ok && (
                <div className="text-right text-xs text-ash">
                  <b className="block mono text-[19px] text-bone font-medium">{derived.peers}</b>
                  others in the pool
                </div>
              )}
            </div>

            <Field
              label="Gear level"
              htmlFor="gear_level"
              error={errors.gear_level}
              hint="The number in your in-game Equipment Level window. Captains sort the board on this, so a made-up figure gets you drafted into a fight you can't hold."
            >
              <input
                id="gear_level"
                type="number"
                inputMode="numeric"
                className="field-input mono max-w-[170px]"
                value={form.gear_level}
                onChange={(e) => set('gear_level', e.target.value)}
                disabled={locked}
                min={0}
                max={20000}
                step={10}
              />
            </Field>

            <Field
              label="Nights you can play"
              error={errors.nights}
              hint="Matches run in the evening. Miss the night your team is scheduled and they field one short."
            >
              <div className="flex gap-1.5 flex-wrap">
                {NIGHTS.map((n) => {
                  const on = form.nights.includes(n);
                  return (
                    <button
                      key={n}
                      type="button"
                      aria-pressed={on}
                      disabled={locked}
                      onClick={() => toggleNight(n)}
                      className={`px-3 py-1.5 rounded border text-[13px] transition-colors disabled:opacity-45 ${
                        on
                          ? 'bg-brass/20 border-brass/65 text-bone font-semibold'
                          : 'bg-panelup/40 border-line text-ash hover:text-bone hover:border-brass/60'
                      }`}
                    >
                      {n}
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field label="Anything captains should know" htmlFor="notes" optional error={errors.notes}>
              <textarea
                id="notes"
                rows={3}
                className="field-input text-sm resize-y"
                placeholder="Second build, a role you'd rather not play, someone you'd like to play with…"
                value={form.notes}
                onChange={(e) => set('notes', e.target.value)}
                disabled={locked}
                maxLength={500}
              />
            </Field>

            <label className="flex items-start gap-2.5 text-sm cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5 w-4 h-4 accent-[rgb(var(--color-brass))]"
                checked={form.wants_captain}
                onChange={(e) => set('wants_captain', e.target.checked)}
                disabled={locked}
              />
              <span>
                I'd like to captain a team
                <span className="block text-xs text-ash mt-0.5">
                  Organizers pick captains from the people who volunteer. Saying yes isn't a commitment.
                </span>
              </span>
            </label>

            <div className="flex items-center gap-3.5 flex-wrap pt-1">
              <Button type="submit" disabled={locked || saving || !derived.ok} className="px-5 py-2 text-[13px]">
                {saving ? 'Saving…' : signup && signup.status !== 'withdrawn' ? 'Save changes' : 'File signup'}
              </Button>
              {signup && signup.status !== 'withdrawn' && !locked && (
                <Button type="button" variant="ghost" onClick={withdraw} disabled={saving}>
                  Withdraw
                </Button>
              )}
              {signup?.updated_at && (
                <span className="text-xs text-ash">
                  Last saved {new Date(signup.updated_at).toLocaleString()}
                </span>
              )}
            </div>
          </form>
        </Panel>

        {/* ── status and context ── */}
        <div className="flex flex-col gap-4">
          <Panel title="Status">
            <Steps signup={signup} />
          </Panel>

          {/* Optional-chained throughout. The panel is context, not the point
              of the page — it must never be the reason the form won't render. */}
          {pool?.counts && (
            <Panel title="The pool" right={<span className="text-xs text-ash">right now</span>}>
              <div className="p-3.5 grid grid-cols-2 gap-2.5">
                <Tile
                  label="Signed up"
                  value={pool.counts.total ?? 0}
                  note={`${pool.counts.pending ?? 0} awaiting review`}
                />
                <Tile label="On the board" value={pool.counts.approved ?? 0} note="approved and draftable" />
              </div>
              <div className="px-3.5 pb-4">
                <div className="eyebrow mb-2">Most-signed weapons</div>
                <WeaponBars weapons={pool.weapons || []} />
              </div>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

function Steps({ signup }) {
  const status = signup?.status;
  const filed = !!signup && status !== 'withdrawn';
  const approved = status === 'approved';
  const rejected = status === 'rejected';

  const steps = [
    {
      done: filed,
      now: !filed,
      title: filed ? 'Submitted' : 'Not filed yet',
      note: filed && signup.created_at
        ? new Date(signup.created_at).toLocaleString()
        : 'Fill in the form and save.',
    },
    {
      done: approved,
      now: status === 'pending',
      bad: rejected,
      title: rejected ? 'Not accepted' : approved ? 'Approved by an organizer' : 'Waiting on review',
      note: rejected
        ? signup.decision_note || 'See the reason above.'
        : approved
          ? `${signup.decided_at ? new Date(signup.decided_at).toLocaleString() : ''}${signup.decided_by ? ` · ${signup.decided_by}` : ''}`
          : 'Organizers get a notification. You will too, when it is decided.',
    },
    {
      done: false,
      now: approved,
      title: 'Waiting to be drafted',
      note: approved ? "You're on the board captains pick from." : 'Once approved, you go on the board.',
    },
    {
      done: false,
      title: 'Drafted to a team',
      note: "You'll be DMed when a captain takes you.",
    },
  ];

  return (
    <ol className="list-none m-0 p-4 flex flex-col">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-3 pb-4 last:pb-0 relative">
          {i < steps.length - 1 && (
            <span className="absolute left-[6px] top-[15px] bottom-px w-px bg-line" aria-hidden="true" />
          )}
          <span
            className={`w-[13px] h-[13px] rounded-full flex-none mt-[3px] border-[1.5px] relative z-[1] ${
              s.bad
                ? 'bg-oxblood border-oxblood'
                : s.done
                  ? 'bg-verdigris border-verdigris'
                  : s.now
                    ? 'bg-brass border-brassbright ring-[3px] ring-brass/20'
                    : 'bg-panel border-line'
            }`}
          />
          <div className="flex flex-col gap-0.5">
            <b className={`text-[13.5px] font-semibold ${s.done || s.now || s.bad ? '' : 'text-ash'}`}>{s.title}</b>
            {s.note && <span className="text-xs text-ash">{s.note}</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function WeaponBars({ weapons }) {
  const top = weapons.filter((w) => w.count > 0).slice(0, 5);
  if (top.length === 0) return <p className="text-xs text-ash">Nobody is on the board yet.</p>;
  const max = top[0].count;
  return (
    <div>
      {top.map((w) => (
        <div key={w.weapon} className="flex items-center gap-2.5 mb-1.5 text-[13px]">
          <span className="w-[82px] flex-none text-ash">{w.weapon}</span>
          <span className="flex-1 h-[7px] rounded bg-panelup overflow-hidden">
            <i className="block h-full bg-brass/75" style={{ width: `${(w.count / max) * 100}%` }} />
          </span>
          <span className="mono text-[11.5px] text-ash w-6 text-right">{w.count}</span>
        </div>
      ))}
    </div>
  );
}
