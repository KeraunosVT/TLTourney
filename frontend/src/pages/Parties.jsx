// The party builder — /parties.
//
// A captain's 66 players, dragged into the 48 seats their party template
// describes. Modelled on Gear-Gap's Parties page, with one difference that
// changes the whole shape of it: THE SEATS ARE TYPED. Gear-Gap's parties are
// freeform buckets of six and the role dots are decoration; here party 1 seat 3
// is a `Tank / DPS` and a Healer may not sit in it. shared/parties.cjs already
// knew that — `canFill` is the same function the readiness figures are built
// from — so the board can refuse a drop rather than merely colour it wrong.
//
// Two containers and no third: the parties, and the bench. There is no
// "unassigned" pool the way Gear-Gap has one, because there is no directory to
// pull from — the roster IS the list, and anybody not in a seat is on the
// bench. That is also how it is stored: no bench flag exists to fall out of
// step with, because "has no seat" is the only representation.
//
// ONE SEAT PER REQUEST. A whole-board save would mean the second captain to
// press it silently reverts the first. See the note on PUT /slot.
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DndContext, DragOverlay, PointerSensor, KeyboardSensor,
  useSensor, useSensors, useDroppable, closestCenter,
} from '@dnd-kit/core';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import api, { errorMessage } from '../api';
import { Panel, Button, Empty, Note, Pill } from '../components/ui';
import { SLOT_TYPES } from '@shared/parties.cjs';

const BENCH = 'bench';
const seatId = (p, s) => `seat:${p}:${s}`;
const parseSeat = (id) => {
  const m = /^seat:(\d+):(\d+)$/.exec(String(id));
  return m ? { partyIndex: Number(m[1]), slotIndex: Number(m[2]) } : null;
};

// One colour per role, used on the card edge and the bench headings. Kept to
// the palette the rest of the app already uses rather than Gear-Gap's sky/
// emerald, which belong to a different brand.
const ROLE_STYLE = {
  Tank: { edge: 'border-l-verdigris', text: 'text-verdigris' },
  DPS: { edge: 'border-l-crimson', text: 'text-crimsonbright' },
  Healer: { edge: 'border-l-bone/60', text: 'text-bone/80' },
};
const roleStyle = (r) => ROLE_STYLE[r] || { edge: 'border-l-line', text: 'text-ash' };

export default function Parties() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState(null);
  const [dragging, setDragging] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data: d } = await api.get('/api/parties');
      setData(d);
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err, 'Could not load the parties.') });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Pointer needs a small distance before a drag starts, or every click on a
  // card is a one-pixel drag that goes nowhere and swallows the click.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const team = useMemo(
    () => (data?.teams || []).find((x) => x.id === data.editableTeamId) || null,
    [data],
  );

  if (loading) return <div className="p-8 text-sm text-ash">Loading…</div>;

  if (!data?.editableTeamId) {
    return (
      <div className="px-6 py-7 max-w-[900px] mx-auto">
        <h1 className="font-display text-[27px]">Parties</h1>
        <Panel className="mt-4">
          <Empty>
            Only a team&apos;s captain or co-captain can arrange its parties — and only
            they can see them. A comp is competitive information while a tournament is
            running.
          </Empty>
        </Panel>
      </div>
    );
  }

  const byId = new Map((team.roster || []).map((m) => [m.id, m]));
  const seatOf = new Map((team.seats || []).map((s) => [seatId(s.party_index, s.slot_index), s.signup_id]));

  // Optimism, deliberately limited: the seats come BACK from every write, so
  // the board re-syncs on each drop rather than trusting a local guess. A comp
  // being edited by two captains at once is the case this protects.
  async function commit(call) {
    setBanner(null);
    try {
      const { data: d } = await call();
      setData((prev) => ({
        ...prev,
        teams: prev.teams.map((x) => (x.id === team.id ? withSeats(x, d.seats) : x)),
      }));
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
      // A refusal usually means the board moved underneath this one.
      if (err?.response?.status === 409) load();
    }
  }

  function onDragEnd({ active, over }) {
    setDragging(null);
    if (!over) return;

    const signupId = String(active.id);
    const target = String(over.id);
    if (target === BENCH) {
      // Already benched — the drag went nowhere worth a request.
      if (!(team.seats || []).some((s) => s.signup_id === signupId)) return;
      return commit(() => api.put('/api/parties/bench', { signup_id: signupId }));
    }

    const seat = parseSeat(target);
    if (!seat) return;
    if (seatOf.get(seatId(seat.partyIndex, seat.slotIndex)) === signupId) return;

    return commit(() => api.put('/api/parties/slot', {
      party_index: seat.partyIndex, slot_index: seat.slotIndex, signup_id: signupId,
    }));
  }

  async function clearAll() {
    if (!window.confirm('Empty every party? Your roster is untouched — everyone goes back to the bench.')) return;
    commit(() => api.delete('/api/parties'));
  }

  const seatedCount = (team.seats || []).length;
  const starters = data.starters || 0;

  return (
    <div className="px-6 py-7 max-w-[1500px] mx-auto">
      <header className="flex items-end justify-between gap-5 flex-wrap mb-4">
        <div>
          <h1 className="font-display text-[27px]">Parties</h1>
          <p className="text-ash text-sm mt-1.5 max-w-[70ch]">
            {team.name} — drag from the bench into a seat. Each seat takes the roles its
            template allows, so a Healer will not drop into a Tank seat.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Pill tone={seatedCount === starters ? 'good' : 'quiet'}>
            {seatedCount} / {starters} seated
          </Pill>
          <a
            href="/comp"
            target="_blank"
            rel="noreferrer"
            className="text-xs text-ash hover:text-bone underline underline-offset-2"
          >
            screenshot view ↗
          </a>
          <Button variant="ghost" onClick={clearAll}>Empty all</Button>
        </div>
      </header>

      {banner && <div className="mb-3"><Note tone={banner.tone}>{banner.text}</Note></div>}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={({ active }) => setDragging(byId.get(String(active.id)) || null)}
        onDragCancel={() => setDragging(null)}
        onDragEnd={onDragEnd}
      >
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px] items-start">
          <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
            {(data.template || []).map((party, pi) => (
              <Party
                key={pi}
                party={party}
                index={pi}
                seatOf={seatOf}
                byId={byId}
                dragging={dragging}
              />
            ))}
          </div>

          <Bench members={team.bench || []} dragging={dragging} />
        </div>

        {/* The card under the cursor. Rendered outside the containers so it is
            not clipped by a party's own overflow. */}
        <DragOverlay>
          {dragging ? <Card member={dragging} overlay /> : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

const withSeats = (team, seats) => {
  const seated = new Set((seats || []).map((s) => s.signup_id));
  return {
    ...team,
    seats: seats || [],
    bench: (team.roster || []).filter((m) => !seated.has(m.id)),
  };
};

// ── One party ───────────────────────────────────────────────────────────────
function Party({ party, index, seatOf, byId, dragging }) {
  const filled = (party.slots || []).filter((_, si) => seatOf.get(seatId(index, si))).length;

  return (
    <Panel
      title={`${index + 1}. ${party.name || 'Party'}`}
      right={
        <span className="mono text-[11px] text-ash">
          {filled}/{(party.slots || []).length}
        </span>
      }
    >
      <div className="p-2 flex flex-col gap-1.5">
        {(party.slots || []).map((type, si) => (
          <Seat
            key={si}
            type={type}
            partyIndex={index}
            slotIndex={si}
            member={byId.get(seatOf.get(seatId(index, si)))}
            dragging={dragging}
          />
        ))}
      </div>
    </Panel>
  );
}

// ── One seat ────────────────────────────────────────────────────────────────
// Highlights while a card is in the air, and says whether THAT card may land
// here — the same `canFill` rule the server enforces, read off SLOT_TYPES so
// the two cannot drift. Doing this in the UI is not a substitute for the
// server check; it is what stops a captain discovering the rule by being told
// off after the drop.
function Seat({ type, partyIndex, slotIndex, member, dragging }) {
  const id = seatId(partyIndex, slotIndex);
  const { setNodeRef, isOver } = useDroppable({ id });

  const eligible = SLOT_TYPES[type] || [];
  // No role recorded is allowed anywhere — a data gap, not a mismatch. The
  // server holds the same line.
  const welcome = !dragging || !dragging.role || eligible.includes(dragging.role);

  const tone = !dragging
    ? 'border-line'
    : welcome
      ? (isOver ? 'border-verdigris bg-verdigrisdeep' : 'border-verdigris/40')
      : 'border-oxblood/40 opacity-40';

  return (
    <div
      ref={setNodeRef}
      className={`rounded border px-2 py-1 min-h-[38px] flex items-center gap-2 transition-colors ${tone}`}
    >
      <span className="text-[9px] uppercase tracking-[0.12em] text-ash w-[62px] flex-none leading-tight">
        {type}
      </span>
      {member ? (
        <Card member={member} />
      ) : (
        <span className="text-[11px] text-dim italic">empty</span>
      )}
    </div>
  );
}

// ── The bench ───────────────────────────────────────────────────────────────
// Everyone with no seat. Grouped by role, because the question asked of a bench
// is "who have I got left who can play this" and a flat list of eighteen names
// answers it slowest.
function Bench({ members, dragging }) {
  const { setNodeRef, isOver } = useDroppable({ id: BENCH });

  const groups = ['Tank', 'DPS', 'Healer', null]
    .map((role) => ({
      role,
      list: members.filter((m) => (role ? m.role === role : !ROLE_STYLE[m.role])),
    }))
    .filter((g) => g.list.length > 0);

  return (
    <Panel
      title="Bench"
      right={<span className="mono text-[11px] text-ash">{members.length}</span>}
    >
      <div
        ref={setNodeRef}
        className={`p-2 max-h-[70vh] overflow-y-auto transition-colors ${
          isOver && dragging ? 'bg-verdigrisdeep' : ''
        }`}
      >
        {members.length === 0 ? (
          <Empty>Everyone is in a party.</Empty>
        ) : (
          groups.map(({ role, list }) => (
            <div key={role || 'unset'} className="mb-2 last:mb-0">
              <div className="px-1 pb-1 flex items-baseline gap-2">
                <span className={`text-[10px] uppercase tracking-[0.14em] ${roleStyle(role).text}`}>
                  {role || 'role not set'}
                </span>
                <span className="mono text-[10px] text-dim">{list.length}</span>
              </div>
              <div className="flex flex-col gap-1">
                {list.map((m) => <Card key={m.id} member={m} />)}
              </div>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}

// ── A player ────────────────────────────────────────────────────────────────
function Card({ member, overlay = false }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: member.id,
    disabled: overlay,
  });

  const s = roleStyle(member.role);

  return (
    <div
      ref={overlay ? undefined : setNodeRef}
      {...(overlay ? {} : listeners)}
      {...(overlay ? {} : attributes)}
      style={overlay ? undefined : { transform: CSS.Translate.toString(transform) }}
      className={`flex-1 min-w-0 rounded border-l-2 ${s.edge} bg-panelup px-2 py-1
                  cursor-grab active:cursor-grabbing select-none
                  ${isDragging ? 'opacity-30' : ''}
                  ${overlay ? 'shadow-[0_6px_24px_rgba(0,0,0,0.5)] cursor-grabbing' : ''}`}
      title={`${member.role || 'role not set'}${member.classes?.[0] ? ` · ${member.classes.join(' · ')}` : ''}`}
    >
      <div className="text-[12.5px] truncate leading-tight">{member.player_name}</div>
      <div className="text-[10px] text-ash truncate leading-tight">
        {(member.classes || []).join(' · ') || member.role || '—'}
      </div>
    </div>
  );
}
