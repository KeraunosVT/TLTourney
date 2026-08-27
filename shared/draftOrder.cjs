// shared/draftOrder.cjs — whose turn is it?
//
// A snake draft runs down the seed order on odd rounds and back up it on even
// ones, so seed 1 picks first in round 1 and last in round 2. That is the whole
// idea: over any two rounds every team gets one early pick and one late one,
// and the advantage of a high seed is a first-round advantage rather than a
// compounding one.
//
// Everything here is ARITHMETIC on the pick number, not a precomputed list.
// With 8 teams and 58 rounds that list is 464 entries, it would have to be
// rebuilt on every read, and every consumer would then be iterating it to find
// the one entry it wanted. The closed form answers "who is on pick 313" in
// constant time, which is what the stream view asks two or three times a
// second.
//
// The order these functions take is the SNAPSHOT — team ids frozen when the
// draft started, not teams.seed read live. See migrations/010.

/**
 * Where a pick number sits in the snake.
 *
 * Returns { round, pickInRound, seatIndex } — seatIndex being the position in
 * the seed-ordered array, which is the bit that reverses. Null for a pick
 * number or team count that isn't one.
 *
 * Both round and pickInRound are 1-based, because that is how they are said out
 * loud: "round 4, pick 3". seatIndex is 0-based because it indexes an array.
 */
function slotFor(teamCount, pickNumber) {
  if (!Number.isInteger(teamCount) || teamCount < 1) return null;
  if (!Number.isInteger(pickNumber) || pickNumber < 1) return null;

  const round = Math.ceil(pickNumber / teamCount);
  const i = (pickNumber - 1) % teamCount;

  // The snake, in one line. Odd rounds run down the seed order; even rounds run
  // back up it.
  const seatIndex = round % 2 === 1 ? i : teamCount - 1 - i;

  return { round, pickInRound: i + 1, seatIndex };
}

/** The team id on the clock for a given pick, or null if that pick isn't one. */
function teamOnClock(order, pickNumber) {
  const slot = slotFor(order.length, pickNumber);
  if (!slot) return null;
  return order[slot.seatIndex] ?? null;
}

/** Total picks in a draft of this shape. */
const totalPicks = (teamCount, rounds) => Math.max(0, teamCount * rounds);

/**
 * The next `count` picks from `fromPick` onwards, as
 * [{ pick, round, pickInRound, teamId }].
 *
 * What the "on deck" strip is built from — a captain three picks away wants to
 * be reading their board now, not when the banner turns red.
 */
function upcoming(order, fromPick, count, rounds) {
  const total = totalPicks(order.length, rounds);
  const out = [];
  for (let p = fromPick; p <= total && out.length < count; p++) {
    const slot = slotFor(order.length, p);
    out.push({ pick: p, round: slot.round, pickInRound: slot.pickInRound, teamId: order[slot.seatIndex] });
  }
  return out;
}

/**
 * The next pick this team owns, at or after `fromPick`. Null once they have no
 * picks left.
 *
 * Scans forward rather than solving for it. It looks at most teamCount picks
 * ahead — a team's picks are never further apart than two rounds minus one —
 * and the closed form for "the next occurrence in a snake" is two cases with an
 * off-by-one in each, which is a lot of subtlety to hide for the sake of
 * skipping eight iterations.
 */
function nextPickFor(order, teamId, fromPick, rounds) {
  const total = totalPicks(order.length, rounds);
  for (let p = Math.max(1, fromPick); p <= total; p++) {
    if (teamOnClock(order, p) === teamId) return p;
  }
  return null;
}

/**
 * The whole order, flattened. Not used at runtime — this is what the tests
 * check the closed form against, and what makes the shape obvious to read.
 */
function fullOrder(order, rounds) {
  const out = [];
  for (let p = 1; p <= totalPicks(order.length, rounds); p++) out.push(teamOnClock(order, p));
  return out;
}

/**
 * How long a draft of this shape takes, in seconds, if every pick uses the
 * whole clock.
 *
 * Exists because the answer is startling and nobody works it out in advance.
 * Eight teams drafting 58 rounds at two minutes a pick is 464 picks and just
 * over fifteen hours. An organizer who sees that before draft night can shorten
 * the clock or shrink the roster; one who doesn't finds out at 3am.
 */
const worstCaseSeconds = (teamCount, rounds, pickSeconds) =>
  totalPicks(teamCount, rounds) * pickSeconds;

module.exports = {
  slotFor, teamOnClock, totalPicks, upcoming, nextPickFor, fullOrder, worstCaseSeconds,
};
