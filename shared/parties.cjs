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
const DEFAULT_PARTY_TEMPLATE = [
  { name: 'Objective / Main', slots: ['Tank', 'Tank', 'Tank / DPS', 'Tank / DPS', 'Healer', 'Healer'] },
  { name: 'Flex (2-2-2)',     slots: ['Tank', 'Tank', 'Tank / DPS', 'Tank / DPS', 'Healer', 'Healer'] },
  { name: 'Flex',             slots: ['Tank', 'Any Role', 'DPS', 'DPS', 'Healer', 'Healer'] },
  { name: 'Flex',             slots: ['Tank', 'Any Role', 'DPS', 'DPS', 'Healer', 'Healer'] },
  { name: 'Flex',             slots: ['Tank', 'Any Role', 'DPS', 'DPS', 'Healer', 'Healer'] },
  { name: 'Flex',             slots: ['Tank', 'Any Role', 'DPS', 'DPS', 'Healer', 'Healer'] },
  { name: '3 DPS',            slots: ['Tank', 'DPS', 'DPS', 'DPS', 'Healer', 'Healer'] },
  { name: '3 DPS',            slots: ['Tank', 'DPS', 'DPS', 'DPS', 'Healer', 'Healer'] },
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

module.exports = {
  SLOT_TYPES, SLOT_NAMES, DEFAULT_PARTY_TEMPLATE,
  canFill, roleDemand, startersPerTeam,
};
