import { useEffect, useMemo, useState } from 'react';
import api, { errorMessage, fieldErrors } from '../api';
import { whenLocal } from '../lib/clock';
import { useAuth } from '../auth';
import { CLASS_NAMES, weaponsLabel } from '@shared/classes.cjs';
import { ROLES, POSITIONS } from '@shared/roles.cjs';
import { Panel, Pill, Button, Field, Tile, Note } from '../components/ui';

const NIGHTS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Three ordered slots rather than a multi-select, because the order carries
// meaning: the first is what you actually play, and captains draft on that.
// A checkbox grid of 45 classes would collect the same three names while
// throwing away which one is your main.
const SLOTS = [
  { key: 0, label: 'Main class', required: true, hint: 'What you play. Captains draft on this one.' },
  { key: 1, label: 'Second class', required: false, hint: 'Something you can be moved onto.' },
  { key: 2, label: 'Third class', required: false, hint: null },
];

const STATUS_PILL = {
  pending: ['crimson', 'Awaiting review'],
  approved: ['good', 'Approved'],
  rejected: ['bad', 'Not accepted'],
  withdrawn: ['quiet', 'Withdrawn'],
};

export default function Signup() {
  const { user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  // The signup window, as the server sees it. `canWithdraw` is separate from
  // `open` on purpose: after the deadline you may still pull out, but you may
  // not come back. See the two gates in backend/signups.js.
  const [window_, setWindow] = useState({ closesAt: null, canWithdraw: false, withdrawIsFinal: false });
  const [closedReason, setClosedReason] = useState(null);
  const [signup, setSignup] = useState(null);
  const [pool, setPool] = useState(null);
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);

  // The form's own state. Seeded from an existing signup when there is one, so
  // editing starts from what you filed rather than from blank.
  // classes is always length 3 in the FORM — one entry per dropdown, '' for an
  // untouched one — and gets compacted on submit. Holding it dense here would
  // mean the third dropdown's value moving when you clear the second.
  const [form, setForm] = useState({
    player_name: '',
    classes: ['', '', ''],
    role: '',
    positions: [],
    nights: [],
    notes: '',
    wants_captain: false,
    wants_shotcall: false,
  });

  const set = (k, v) => {
    setForm((f) => ({ ...f, [k]: v }));
    // Clear the message under a field as soon as it's touched — a stale error
    // sitting under a field you just fixed reads as though it's still wrong.
    setErrors((e) => {
      const next = { ...e };
      delete next[k];
      return next;
    });
  };

  const setClass = (slot, value) => {
    const next = [...form.classes];
    next[slot] = value;
    // Clearing a slot pulls the ones below it up, so you can't end up with a
    // third class and no second — which the server would accept but which
    // reads as though a pick went missing.
    if (!value) {
      const kept = next.filter(Boolean);
      set('classes', [kept[0] || '', kept[1] || '', kept[2] || '']);
    } else {
      set('classes', next);
    }
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
        setWindow({
          closesAt: mine.data.closesAt || null,
          canWithdraw: !!mine.data.canWithdraw,
          withdrawIsFinal: !!mine.data.withdrawIsFinal,
        });
        setPool(poolRes.data);
        if (mine.data.signup) {
          const s = mine.data.signup;
          setSignup(s);
          const saved = s.classes || [];
          setForm({
            player_name: s.player_name,
            // Padded back out to three slots — the stored array is compact.
            classes: [saved[0] || '', saved[1] || '', saved[2] || ''],
            // Both may be unset on a signup filed before these were asked for
            // (migration 002 deliberately backfilled nothing). They arrive
            // empty, the form requires them, and saving fills them in.
            role: s.role || '',
            positions: s.positions || [],
            nights: s.nights || [],
            notes: s.notes || '',
            wants_captain: !!s.wants_captain,
            // Null on a signup filed before migration 009 asked. It loads as
            // unticked and saving answers it properly — which is the only way
            // those rows ever get a real answer.
            wants_shotcall: !!s.wants_shotcall,
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

  // What they've actually picked, in order, blanks removed.
  const picked = useMemo(() => form.classes.filter(Boolean), [form.classes]);

  // How many others main each of their picks — the number worth knowing before
  // you commit, since it's roughly your odds of being the one drafted for it.
  const mainsFor = (name) => pool?.classes?.find((c) => c.class_name === name)?.mains ?? 0;

  const toggleNight = (n) =>
    set('nights', form.nights.includes(n) ? form.nights.filter((x) => x !== n) : [...form.nights, n]);

  const togglePosition = (p) =>
    set('positions', form.positions.includes(p)
      ? form.positions.filter((x) => x !== p)
      : [...form.positions, p]);

  const allPositions = form.positions.length === POSITIONS.length;

  // What to say after a save, given whether a confirmation DM went out.
  function savedMessage({ created, dm }) {
    if (!created && !dm) return 'Saved.';
    const filed = created ? 'Signup filed' : 'Signup re-filed';
    if (dm?.ok) return `${filed} — confirmation sent to your Discord DMs, and you'll get another when an organizer reviews it.`;
    if (dm?.reason === 'DMs closed') {
      return `${filed}. We couldn't DM you — your Discord DMs are closed to this server, so check back here for your status.`;
    }
    return `${filed} — an organizer will review it.`;
  }

  async function save(e) {
    e?.preventDefault();
    setSaving(true);
    setErrors({});
    setBanner(null);
    try {
      const { data } = await api.put('/api/signup/mine', {
        ...form,
        // Compacted on the way out: the form holds three slots, the row holds
        // only what was actually chosen.
        classes: picked,
      });
      setSignup(data.signup);
      // Only promise a DM that actually sent. `dm` is null when this was an
      // edit rather than a new filing, ok:false when Discord refused — most
      // often because their DMs are closed, which is worth saying plainly
      // rather than leaving them waiting for a message that will never come.
      setBanner({ tone: 'good', text: savedMessage(data) });
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
    // The wording changes with the window, because after the deadline this is
    // a one-way door and a confirm that says otherwise is a lie told at the
    // exact moment it costs the most.
    const msg = window_.withdrawIsFinal
      ? 'Withdraw your signup?\n\nThe deadline has passed, so you will NOT be able to file again.'
      : 'Withdraw your signup? You can file again while signups are open.';
    if (!window.confirm(msg)) return;
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
            {window_.closesAt && ` Signups closed ${whenLocal(window_.closesAt)}.`}
            {signup ? ' Your entry is read-only from here.' : ''}
            {window_.canWithdraw && signup && signup.status !== 'withdrawn'
              ? ' You can still withdraw if you can no longer play.'
              : ''}
          </Note>
        </div>
      )}

      {/* The deadline, while it still matters. Printed in the reader's own
          timezone — the server sends the raw timestamp precisely so this can
          be, since a deadline shown an hour out from the one somebody plans
          around is worse than showing no deadline at all. */}
      {!locked && window_.closesAt && (
        <div className="mb-4">
          <Note tone="good">
            Signups close {whenLocal(window_.closesAt)}. You can edit anything until then.
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
              label="Classes you play"
              error={errors.classes}
              hint="Up to three, in order. Only the first is required."
            >
              <div className="flex flex-col gap-3">
                {SLOTS.map((slot) => {
                  const value = form.classes[slot.key] || '';
                  // A class chosen in another slot is removed from this one's
                  // options, so picking the same thing twice isn't offered.
                  // The current value stays listed or the select would blank.
                  const taken = form.classes.filter((c, i) => c && i !== slot.key);
                  const options = CLASS_NAMES.filter((c) => !taken.includes(c));
                  // The third slot is pointless until the second is filled —
                  // it would just be a gap the submit handler closes anyway.
                  const disabled = locked
                    || (slot.key === 2 && !form.classes[1])
                    || (slot.key === 1 && !form.classes[0]);

                  return (
                    <div key={slot.key} className="flex flex-col gap-1">
                      <div className="flex items-center gap-2.5 flex-wrap">
                        <span className="text-[11px] text-ash w-[92px] flex-none">
                          {slot.label}
                          {slot.required && <span className="text-crimson"> *</span>}
                        </span>
                        <select
                          className="field-input flex-1 min-w-[180px]"
                          aria-label={slot.label}
                          value={value}
                          onChange={(e) => setClass(slot.key, e.target.value)}
                          disabled={disabled}
                        >
                          <option value="">{slot.required ? '— pick a class —' : '— none —'}</option>
                          {options.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </div>
                      {value && (
                        <div className="text-[11px] text-ash pl-[102px] flex gap-3 flex-wrap">
                          <span>{weaponsLabel(value)}</span>
                          <span className="text-ash/70">
                            {mainsFor(value) === 0
                              ? 'nobody mains this yet'
                              : `${mainsFor(value)} ${mainsFor(value) === 1 ? 'other mains' : 'others main'} it`}
                          </span>
                        </div>
                      )}
                      {!value && slot.hint && !disabled && (
                        <div className="text-[11px] text-ash/70 pl-[102px]">{slot.hint}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Field>

            {/* Segmented rather than a dropdown: three options that a captain
                filters on shouldn't need a click to reveal. */}
            <Field
              label="Role"
              error={errors.role}
              hint="What you're for. One only — your second and third classes already say what you can be moved onto."
            >
              <div className="flex gap-1.5 flex-wrap" role="radiogroup" aria-label="Role">
                {ROLES.map((r) => {
                  const on = form.role === r;
                  return (
                    <button
                      key={r}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      disabled={locked}
                      onClick={() => set('role', r)}
                      className={`px-4 py-2 rounded border text-[13px] transition-colors disabled:opacity-45 ${
                        on
                          ? 'bg-crimson/20 border-crimson/65 text-bone font-semibold'
                          : 'bg-panelup/40 border-line text-ash hover:text-bone hover:border-crimson/60'
                      }`}
                    >
                      {r}
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field
              label="Positions you can run"
              error={errors.positions}
              hint="Where you're willing to stand. Pick as many as apply."
            >
              <div className="flex flex-col gap-2">
                <div className="flex gap-1.5 flex-wrap">
                  {POSITIONS.map((p) => {
                    const on = form.positions.includes(p);
                    return (
                      <button
                        key={p}
                        type="button"
                        aria-pressed={on}
                        disabled={locked}
                        onClick={() => togglePosition(p)}
                        className={`px-3.5 py-2 rounded border text-[13px] transition-colors disabled:opacity-45 ${
                          on
                            ? 'bg-crimson/20 border-crimson/65 text-bone font-semibold'
                            : 'bg-panelup/40 border-line text-ash hover:text-bone hover:border-crimson/60'
                        }`}
                      >
                        {p}
                      </button>
                    );
                  })}
                </div>
                {/* One control that flips both ways, rather than separate
                    "select all" and "clear" buttons — with four options the
                    second is never the one you want. */}
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => set('positions', allPositions ? [] : [...POSITIONS])}
                  className="self-start text-[12px] text-ash hover:text-crimsonbright underline
                             underline-offset-2 disabled:opacity-45"
                >
                  {allPositions ? 'Clear all' : 'Select all four'}
                </button>
              </div>
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
                          ? 'bg-crimson/20 border-crimson/65 text-bone font-semibold'
                          : 'bg-panelup/40 border-line text-ash hover:text-bone hover:border-crimson/60'
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
                className="mt-0.5 w-4 h-4 accent-[rgb(var(--color-crimson))]"
                checked={form.wants_captain}
                onChange={(e) => set('wants_captain', e.target.checked)}
                disabled={locked}
              />
              <span>
                I'd like to captain a team
                <span className="block text-xs text-ash mt-0.5">
                  Every team has a captain and a co-captain, both drafting. Organizers pick them from
                  the people who volunteer — saying yes isn't a commitment.
                </span>
              </span>
            </label>

            {/* Separate from captaining on purpose. They look like the same
                question and they aren't: a shotcaller runs the fight, a captain
                runs the draft and the roster, and plenty of people are glad to
                do one and not the other. Asking once would lose whichever half
                they meant. */}
            <label className="flex items-start gap-2.5 text-sm cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5 w-4 h-4 accent-[rgb(var(--color-crimson))]"
                checked={form.wants_shotcall}
                onChange={(e) => set('wants_shotcall', e.target.checked)}
                disabled={locked}
              />
              <span>
                I'm willing to shotcall for a team
                <span className="block text-xs text-ash mt-0.5">
                  Calling targets and movement in the fight itself. Separate from captaining —
                  you can say yes to this and no to that.
                </span>
              </span>
            </label>

            <div className="flex items-center gap-3.5 flex-wrap pt-1">
              <Button
                type="submit"
                disabled={locked || saving || picked.length === 0 || !form.role || form.positions.length === 0}
                className="px-5 py-2 text-[13px]"
              >
                {saving ? 'Saving…' : signup && signup.status !== 'withdrawn' ? 'Save changes' : 'File signup'}
              </Button>
              {signup && signup.status !== 'withdrawn' && window_.canWithdraw && (
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
              {/* Role spread first: it's the number that decides whether the
                  pool can field teams at all. Sixty players with four healers
                  is not a pool of sixty. */}
              <div className="px-3.5 pb-3">
                <div className="eyebrow mb-2">Roles on the board</div>
                <div className="grid grid-cols-3 gap-2">
                  {(pool.roles || []).map((r) => (
                    <div key={r.role} className="bg-panelup/50 border border-line rounded px-2.5 py-2 text-center">
                      <div className="mono text-[17px]">{r.count}</div>
                      <div className="text-[10px] uppercase tracking-[0.1em] text-ash mt-0.5">{r.role}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="px-3.5 pb-3">
                <div className="eyebrow mb-2">Positions covered</div>
                <CountBars
                  rows={(pool.positions || []).map((p) => ({ label: p.position, value: p.count }))}
                  labelWidth={110}
                />
              </div>
              <div className="px-3.5 pb-4">
                <div className="eyebrow mb-2">Most-mained classes</div>
                <ClassBars classes={pool.classes || []} />
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
                    ? 'bg-crimson border-crimsonbright ring-[3px] ring-crimson/20'
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

// A plain labelled bar row. Unlike ClassBars this keeps the given order and
// shows every row including the zeroes — for positions, a zero is the whole
// point: it's the gap somebody should go and fill.
function CountBars({ rows, labelWidth = 96 }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2.5 mb-1.5 text-[13px]">
          <span className="flex-none text-ash truncate" style={{ width: labelWidth }} title={r.label}>
            {r.label}
          </span>
          <span className="flex-1 h-[7px] rounded bg-panelup overflow-hidden">
            <i className="block h-full bg-crimson/75" style={{ width: `${(r.value / max) * 100}%` }} />
          </span>
          <span className={`mono text-[11.5px] w-6 text-right ${r.value === 0 ? 'text-oxblood' : 'text-ash'}`}>
            {r.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// Sorted by how many people MAIN each class, not by how many list it anywhere.
// A class five people keep as a third option isn't a class five people play,
// and someone deciding what to bring needs the first number, not the second.
function ClassBars({ classes }) {
  const top = classes
    .filter((c) => c.mains > 0)
    .sort((a, b) => b.mains - a.mains || a.class_name.localeCompare(b.class_name))
    .slice(0, 6);
  if (top.length === 0) return <p className="text-xs text-ash">Nobody is on the board yet.</p>;
  const max = top[0].mains;
  return (
    <div>
      {top.map((c) => (
        <div key={c.class_name} className="flex items-center gap-2.5 mb-1.5 text-[13px]">
          <span className="w-[96px] flex-none text-ash truncate" title={c.class_name}>{c.class_name}</span>
          <span className="flex-1 h-[7px] rounded bg-panelup overflow-hidden">
            <i className="block h-full bg-crimson/75" style={{ width: `${(c.mains / max) * 100}%` }} />
          </span>
          <span
            className="mono text-[11.5px] text-ash w-10 text-right"
            title={`${c.mains} main it, ${c.count} list it at all`}
          >
            {c.mains}
            {c.count > c.mains && <span className="text-ash/60">+{c.count - c.mains}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}
