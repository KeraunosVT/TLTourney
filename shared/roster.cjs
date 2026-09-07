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

  // A member marked `playing: false` is on the roster and will not take the
  // field — a captain holding a seat without playing (migration 028). They keep
  // their roster row, because that is what stops another team drafting them,
  // and they are counted out of everything about the TEAM: the role totals, the
  // role cap, and the seats the party builder can fill.
  //
  // Absent or true both mean playing. Every row predates the column.
  const playing = members.filter((m) => m.playing !== false);

  let unanswered = 0;
  playing.forEach((m) => {
    if (m.role && byRole[m.role] !== undefined) byRole[m.role] += 1;
    else unanswered += 1;
  });

  const filled = members.length;
  return {
    filled,
    // How many will actually play. Equal to `filled` on every team but one, and
    // the difference is the whole reason the compensation pick exists.
    playing: playing.length,
    nonPlaying: filled - playing.length,
    size: rosterSize,
    remaining: Math.max(0, rosterSize - filled),
    captains: members.filter((m) => m.via === VIA_CAPTAIN).length,
    drafted: members.filter((m) => m.via !== VIA_CAPTAIN).length,
    unanswered,
    byRole: ROLES.map((role) => ({ role, have: byRole[role] })),
  };
}

module.exports = { VIA, VIA_CAPTAIN, isVia, rosterProgress };
