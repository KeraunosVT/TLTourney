// shared/captains.cjs — who runs a team, and how the site knows it's them.
//
// Two captains per team, held in `team_captains` as one row each. The pair is a
// SEAT number rather than two columns on `teams`, for three reasons that all
// showed up the moment the count went from one to two:
//
//   · "is this person already captaining something" is one unique index over
//     one column, instead of an OR across captain_id and co_captain_id that
//     nothing in the database enforces;
//   · going to three captains later is a CHECK edit, not a schema change plus
//     every query that mentions either column;
//   · a captain is a ROW, so adding and removing one is an insert and a delete
//     rather than a null being shuffled between two columns.
//
// Identity itself is not stored here at all. A captain is a `player_signups`
// row, and that row carries the discord_id. So the site recognises a captain by
// matching the signed-in Discord user against the signup a captain seat points
// at — which means captaincy survives a re-login, cannot be spoofed from the
// browser, and cannot name somebody who never signed up.

// Both seats are captains with the same powers. The distinction is who is named
// first on the team and who the room looks at when something has to be decided
// — not a permission difference, and deliberately not one, because a co-captain
// who cannot pick is useless on the night the captain doesn't show.
const CAPTAIN_SEATS = [
  { seat: 1, label: 'Captain' },
  { seat: 2, label: 'Co-captain' },
];

const MAX_CAPTAINS_PER_TEAM = CAPTAIN_SEATS.length;

const SEAT_NUMBERS = CAPTAIN_SEATS.map((s) => s.seat);

const isSeat = (n) => SEAT_NUMBERS.includes(n);

const seatLabel = (n) => (CAPTAIN_SEATS.find((s) => s.seat === n) || {}).label || `Seat ${n}`;

/**
 * The lowest seat this team hasn't filled, or null if it's full.
 *
 * Used when an organizer assigns a captain without saying which seat — the
 * common case, since the first person they pick is the captain and the second
 * is the co-captain, in that order.
 */
function firstFreeSeat(taken = []) {
  const used = new Set(taken);
  return SEAT_NUMBERS.find((s) => !used.has(s)) ?? null;
}

module.exports = {
  CAPTAIN_SEATS, MAX_CAPTAINS_PER_TEAM, SEAT_NUMBERS,
  isSeat, seatLabel, firstFreeSeat,
};
