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

// ── The compensation pick ───────────────────────────────────────────────────
/**
 * One team, one extra pick, inserted at a fixed point in the order.
 *
 * A captain who does not play still occupies a roster slot — that is what keeps
 * them off every other captain's board — so their team fields one fewer player
 * than everybody else. The snake cannot fix that on its own: every team gets
 * exactly `rounds` picks, and that uniformity is the closed form this whole
 * file is built on.
 *
 * So the extra pick sits OUTSIDE the snake, as a single insertion. `comp` is
 * `{ afterPick, teamId }` — null in a draft that owes nobody anything, which is
 * every draft but this one.
 *
 * WHERE it goes is a fairness decision, not an arithmetic one. It lands at the
 * moment every team has its 48 starters, so the compensated team fills its
 * starting side at the same time as everyone else and the extra body comes off
 * a board that still has bench talent on it. Appending it to the very end would
 * be simpler and would hand them whoever was left after 256 picks.
 *
 * ── Everything below runs through resolvePick ────────────────────────────────
 * The snake arithmetic is untouched. `slotFor` still answers about a pure
 * snake, and this maps a DRAFT pick number onto it: picks after the insertion
 * point are one ahead of their snake position, so they shift back by one.
 * Keeping the two separate is what lets the closed form stay closed.
 */
function resolvePick(pickNumber, comp) {
  if (!comp || !comp.teamId || pickNumber <= comp.afterPick) {
    return { comp: false, snakePick: pickNumber };
  }
  if (pickNumber === comp.afterPick + 1) return { comp: true };
  return { comp: false, snakePick: pickNumber - 1 };
}

/** The team id on the clock for a given pick, or null if that pick isn't one. */
function teamOnClock(order, pickNumber, comp = null) {
  const r = resolvePick(pickNumber, comp);
  if (r.comp) return comp.teamId ?? null;
  const slot = slotFor(order.length, r.snakePick);
  if (!slot) return null;
  return order[slot.seatIndex] ?? null;
}

/**
 * Where a DRAFT pick sits, compensation included.
 *
 * The compensation pick reports the round it follows and is flagged, so the
 * page can say "round 46 · compensation" rather than inventing a round 46.5 or
 * quietly renumbering every round after it.
 */
function draftSlot(teamCount, pickNumber, comp = null) {
  const r = resolvePick(pickNumber, comp);
  if (r.comp) {
    const prev = slotFor(teamCount, comp.afterPick);
    return prev ? { ...prev, compensation: true, pickInRound: null } : null;
  }
  const slot = slotFor(teamCount, r.snakePick);
  return slot ? { ...slot, compensation: false } : null;
}

/** Total picks in a draft of this shape, the compensation pick included. */
const totalPicks = (teamCount, rounds, comp = null) =>
  Math.max(0, teamCount * rounds) + (comp?.teamId ? 1 : 0);

/**
 * When the compensation pick falls, given how the rosters start.
 *
 * `startersPerTeam` is the 48; `playingStart` is how many PLAYING members a
 * full-strength team already has (both captains, so two). After round R such a
 * team holds playingStart + R, so it reaches its starters at R = starters −
 * playingStart, and the extra pick goes immediately after that round.
 *
 * Returned as a pick number rather than a round because that is what the clock
 * compares against, and converting once here beats converting at every read.
 */
const compAfterPick = (teamCount, startersPerTeam, playingStart) =>
  teamCount * Math.max(0, startersPerTeam - playingStart);

/**
 * The next `count` picks from `fromPick` onwards, as
 * [{ pick, round, pickInRound, teamId }].
 *
 * What the "on deck" strip is built from — a captain three picks away wants to
 * be reading their board now, not when the banner turns red.
 */
function upcoming(order, fromPick, count, rounds, comp = null) {
  const total = totalPicks(order.length, rounds, comp);
  const out = [];
  for (let p = fromPick; p <= total && out.length < count; p++) {
    const slot = draftSlot(order.length, p, comp);
    if (!slot) continue;
    out.push({
      pick: p,
      round: slot.round,
      pickInRound: slot.pickInRound,
      compensation: slot.compensation,
      teamId: teamOnClock(order, p, comp),
    });
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
function nextPickFor(order, teamId, fromPick, rounds, comp = null) {
  const total = totalPicks(order.length, rounds, comp);
  for (let p = Math.max(1, fromPick); p <= total; p++) {
    if (teamOnClock(order, p, comp) === teamId) return p;
  }
  return null;
}

/**
 * The whole order, flattened. Not used at runtime — this is what the tests
 * check the closed form against, and what makes the shape obvious to read.
 */
function fullOrder(order, rounds, comp = null) {
  const out = [];
  for (let p = 1; p <= totalPicks(order.length, rounds, comp); p++) {
    out.push(teamOnClock(order, p, comp));
  }
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
const worstCaseSeconds = (teamCount, rounds, pickSeconds, comp = null) =>
  totalPicks(teamCount, rounds, comp) * pickSeconds;

module.exports = {
  slotFor, draftSlot, resolvePick, teamOnClock, totalPicks, compAfterPick,
  upcoming, nextPickFor, fullOrder, worstCaseSeconds,
};
