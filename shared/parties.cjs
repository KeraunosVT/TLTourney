// shared/parties.cjs — the shape of a team's 48 starting slots.
//
// A team is 8 parties of 6, plus 12 substitutes. The 8 parties are NOT
// interchangeable: each has a fixed pattern of role requirements, and two of
// those requirements are flexible rather than exact. Transcribed from the
// tournament's own party template.

const { ROLES } = require('./roles.cjs');

// ── Slot types ──────────────────────────────────────────────────────────────
// A slot names the roles that may fill it, not one role. Three are exact and
// two are flexible, and the flexible ones are why "how many tanks do we need"
// has a RANGE for an answer rather than a number: a Tank / DPS slot is a tank
// or it isn't, depending on who ends up in it.
const SLOT_TYPES = {
  Tank: ['Tank'],
  DPS: ['DPS'],
  Healer: ['Healer'],
  'Tank / DPS': ['Tank', 'DPS'],
  'Any Role': ['Tank', 'DPS', 'Healer'],
};

const SLOT_NAMES = Object.keys(SLOT_TYPES);

// ── The eight parties ───────────────────────────────────────────────────────
// Order matters: party 1 is the objective party and is the one a captain fills
// first. The names are the template's own.
//
// Party 2 was a second copy of the objective party — 'Flex (2-2-2)', two tanks
// and two Tank / DPS. It is an ordinary Flex now, which moves one compulsory
// tank slot and two flexible ones into two compulsory DPS: Tank's floor drops
// 10 → 9, DPS's rises 14 → 16, Healer is unchanged at 16. See migration 020.
const DEFAULT_PARTY_TEMPLATE = [
  { name: 'Objective / Main', slots: ['Tank', 'Tank', 'Tank / DPS', 'Tank / DPS', 'Healer', 'Healer'] },
  { name: 'Flex',             slots: ['Tank', 'Any Role', 'DPS', 'DPS', 'Healer', 'Healer'] },
  { name: 'Flex',             slots: ['Tank', 'Any Role', 'DPS', 'DPS', 'Healer', 'Healer'] },
  { name: 'Flex',             slots: ['Tank', 'Any Role', 'DPS', 'DPS', 'Healer', 'Healer'] },
  { name: 'Flex',             slots: ['Tank', 'Any Role', 'DPS', 'DPS', 'Healer', 'Healer'] },
  { name: 'Flex',             slots: ['Tank', 'Any Role', 'DPS', 'DPS', 'Healer', 'Healer'] },
  { name: '3 DPS',            slots: ['Tank', 'DPS', 'DPS', 'DPS', 'Healer', 'Healer'] },
  { name: '3 DPS',            slots: ['Tank', 'DPS', 'DPS', 'DPS', 'Healer', 'Healer'] },
];

// ── The bench ───────────────────────────────────────────────────────────────
// Substitutes are SLOTS, in the same vocabulary as a party's, rather than a
// bare count. That is the whole trick: a bench described as slot types goes
// through roleDemand unchanged, gets the same min/max treatment as the 48
// starters, and can hold an 'Any Role' seat when an organizer does not want to
// commit the bench to a role. A `{Tank: 4, DPS: 10, Healer: 4}` object would
// have been a second, weaker way of saying the same thing, and every function
// below would have needed a branch for it.
//
// 4 Tank, 8 DPS, 6 Healer = 18, which is sub_count after migration 018. The
// bench moved two seats from damage to healing in 024 — see that migration for
// what it does to the ceilings, which are now CAPS rather than guidance.
const DEFAULT_SUB_SLOTS = [
  'Tank', 'Tank', 'Tank', 'Tank',
  'DPS', 'DPS', 'DPS', 'DPS', 'DPS', 'DPS', 'DPS', 'DPS',
  'Healer', 'Healer', 'Healer', 'Healer', 'Healer', 'Healer',
];

const canFill = (slotType, role) => (SLOT_TYPES[slotType] || []).includes(role);

/**
 * What a given number of teams needs, per role.
 *
 * Returns a MIN and a MAX for each role rather than a single figure, because
 * the flexible slots genuinely have no single answer. Reporting one number
 * would mean either overstating the tank requirement by every flex slot, or
 * understating it by the same — and the whole point of this readout is telling
 * an organizer whether the signup drive is short of tanks.
 *
 *   min — slots ONLY this role can fill. Below this the roster cannot be built.
 *   max — min plus every flexible slot this role is eligible for.
 */
function roleDemand(template, teamCount = 1) {
  const min = {};
  const max = {};
  ROLES.forEach((r) => { min[r] = 0; max[r] = 0; });

  template.forEach((party) => {
    (party.slots || []).forEach((slotType) => {
      const eligible = SLOT_TYPES[slotType] || [];
      // Exactly one eligible role means that role is compulsory here.
      if (eligible.length === 1) min[eligible[0]] += 1;
      eligible.forEach((r) => { max[r] += 1; });
    });
  });

  const out = {};
  ROLES.forEach((r) => {
    out[r] = { min: min[r] * teamCount, max: max[r] * teamCount };
  });
  return out;
}

// Starting slots in one team's template — 48 for the standard 8x6.
const startersPerTeam = (template) =>
  template.reduce((n, p) => n + (p.slots || []).length, 0);

/**
 * What a WHOLE roster asks of each role — the 48 starters and the bench.
 *
 * roleDemand alone answers for the starting side only, which was the right
 * question while the bench was a bare number: 18 substitutes of no stated role
 * make no demand of anybody. Now that the bench has slots, "how many tanks does
 * a full roster want" has an answer, and it is this one.
 *
 * The bench is passed through roleDemand as a single pseudo-party, so a flexible
 * bench slot ranges exactly the way a flexible starting slot does.
 *
 * Kept beside roleDemand rather than replacing it: the two answer different
 * questions and both are asked. A captain drafting picks 40 through 66 is
 * filling the bench and wants this; an organizer asking whether the starting
 * eight can be fielded at all wants roleDemand.
 */
function rosterDemand(template, subSlots, teamCount = 1) {
  const starters = roleDemand(Array.isArray(template) ? template : [], teamCount);
  const bench = roleDemand([{ slots: Array.isArray(subSlots) ? subSlots : [] }], teamCount);

  const out = {};
  ROLES.forEach((r) => {
    out[r] = {
      min: starters[r].min + bench[r].min,
      max: starters[r].max + bench[r].max,
    };
  });
  return out;
}

/**
 * How much room a roster has left for one role — the HARD CAP.
 *
 * `max` from rosterDemand is not a target, it is the number of seats in the
 * template that this role could ever occupy: the slots only it can fill, plus
 * every flexible one it is eligible for, plus its share of the bench. Past that
 * number there is no seat to put the player in — not a tight fit, no seat — so
 * a pick beyond it buys a player who cannot be fielded and cannot be benched.
 *
 * Returns { have, max, room }. `room` is what the draft refuses on when it
 * reaches zero.
 *
 * ⚠️  THIS IS A PER-ROLE CAP, NOT A GUARANTEE OF A LEGAL ROSTER. The three
 * ceilings overlap — they sum to more than a roster holds, because the
 * flexible slots are counted once for every role that could take them. A team
 * can therefore stay under all three caps and still end up unfieldable, by
 * spending the flexible slots on one role and coming up short elsewhere. This
 * catches the mistake somebody actually makes (drafting a ninth healer they
 * have nowhere to put); it does not solve the general packing problem, and
 * pretending otherwise would be worse than the honest limit.
 */
function roleRoom(members, demand, role) {
  const list = Array.isArray(members) ? members : [];
  const have = list.filter((m) => m && m.role === role).length;
  const max = demand?.[role]?.max ?? 0;
  return { have, max, room: Math.max(0, max - have) };
}

/** Roles this roster still has a seat for. Used to keep the clock legal. */
const rolesWithRoom = (members, demand) =>
  ROLES.filter((role) => roleRoom(members, demand, role).room > 0);

/**
 * Reshape the bench to a new substitute count.
 *
 * The same contract as resizeTemplate, and for the same reason: sub_count and
 * sub_slots are two descriptions of one thing, so an organizer moving the
 * number in Setup must not be able to leave a bench of 18 slots beside a
 * sub_count of 12. Trims from the END and pads with 'Any Role' — the slot type
 * that adds no requirement, because inventing one makes a roster read as short
 * of a role nobody asked for.
 */
function resizeSubs(subSlots, subCount) {
  const out = (Array.isArray(subSlots) ? subSlots : []).slice(0, Math.max(0, subCount));
  while (out.length < subCount) out.push('Any Role');
  return out;
}

/** Does this bench describe exactly this many substitutes? */
const subsFit = (subSlots, subCount) =>
  Array.isArray(subSlots) && subSlots.length === subCount;

// ── Changing the shape of a team ────────────────────────────────────────────
/**
 * Reshape a template to a new party count and party size.
 *
 * THE TEMPLATE AND THE NUMBERS HAVE TO MOVE TOGETHER. `roster_size` is
 * generated as party_count * party_size + sub_count, while every readiness and
 * scarcity figure is counted off the TEMPLATE — so the two are two descriptions
 * of one thing and there is nothing to catch them disagreeing.
 *
 * Half of that is enforced: a CHECK pins party_count to the template's length,
 * which is why party_count could not be changed at all through the API. The
 * other half is not, and party_size could be changed on its own — leaving a
 * roster of 52 beside a template describing 48 starters, with every role
 * requirement quietly computed from the wrong one.
 *
 * PRESERVES what is there. Somebody who has tuned party 1 to two tanks and two
 * healers should not lose that because they added a ninth party. Parties are
 * appended or dropped from the END, and slots likewise.
 *
 * Added slots are 'Any Role' rather than a guess. A slot type is a CONSTRAINT —
 * 'Tank' means only a tank may fill it — and inventing a requirement nobody
 * asked for makes a roster look short of tanks that were never needed.
 */
const FLEX_PARTY = ['Tank', 'Any Role', 'DPS', 'DPS', 'Healer', 'Healer'];

function resizeTemplate(template, partyCount, partySize) {
  const source = Array.isArray(template) ? template : [];
  const out = [];

  for (let i = 0; i < partyCount; i++) {
    const existing = source[i];
    const slots = [...((existing?.slots) || FLEX_PARTY)].slice(0, partySize);
    // Pad with the least committal slot there is.
    while (slots.length < partySize) slots.push('Any Role');
    out.push({ name: existing?.name || 'Flex', slots });
  }

  return out;
}

/** Does this template describe exactly this shape? */
const templateFits = (template, partyCount, partySize) =>
  Array.isArray(template)
  && template.length === partyCount
  && template.every((p) => (p.slots || []).length === partySize);

module.exports = {
  SLOT_TYPES, SLOT_NAMES, DEFAULT_PARTY_TEMPLATE, DEFAULT_SUB_SLOTS, FLEX_PARTY,
  canFill, roleDemand, rosterDemand, startersPerTeam,
  roleRoom, rolesWithRoom,
  resizeTemplate, templateFits, resizeSubs, subsFit,
};
