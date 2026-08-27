// shared/roster.cjs — who plays for a team, and how far off a full one is.
//
// A roster row exists for everybody attached to a team, whatever route they
// took to get there. `via` records that route, because it is the difference
// between "unseating this captain should take them off the roster" (yes, they
// were only ever on it BECAUSE they captain) and "removing this drafted player
// should" (a different decision entirely).

const { ROLES } = require('./roles.cjs');

// Kept in step with the CHECK in migrations/008 — changing one means changing
// the other.
const VIA = ['captain', 'draft', 'manual'];

const isVia = (v) => VIA.includes(v);

// A captain is on the roster because they captain. Unseating them takes the
// row with it; a drafted player's row survives, because being dropped from a
// roster is a decision somebody has to make on purpose.
const VIA_CAPTAIN = 'captain';

/**
 * How full is this roster, and of what?
 *
 * `remaining` is what a captain actually wants on draft night: how many picks
 * they have left. It counts the captains already on the roster, which is the
 * detail that catches people out — two captains means 58 picks, not 60, and a
 * draft board built for 60 is two players too long.
 */
function rosterProgress(members, rosterSize = 0) {
  const byRole = {};
  ROLES.forEach((r) => { byRole[r] = 0; });

  let unanswered = 0;
  members.forEach((m) => {
    if (m.role && byRole[m.role] !== undefined) byRole[m.role] += 1;
    else unanswered += 1;
  });

  const filled = members.length;
  return {
    filled,
    size: rosterSize,
    remaining: Math.max(0, rosterSize - filled),
    captains: members.filter((m) => m.via === VIA_CAPTAIN).length,
    drafted: members.filter((m) => m.via !== VIA_CAPTAIN).length,
    unanswered,
    byRole: ROLES.map((role) => ({ role, have: byRole[role] })),
  };
}

module.exports = { VIA, VIA_CAPTAIN, isVia, rosterProgress };
