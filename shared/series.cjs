// shared/series.cjs — a match is best of three.
//
// One pure function decides when a series is over and who won it, and the
// bracket then advances exactly as it always did. Keeping that boundary is the
// point: shared/bracket.cjs knows about winners and slots and nothing about
// games, and this knows about games and nothing about brackets.

/** How many games win a series. Best of 3 → 2, best of 5 → 3. */
const toWin = (bestOf) => Math.floor((Number(bestOf) || 1) / 2) + 1;

/**
 * ODD ONLY, and the database says so too.
 *
 * A best of four can be drawn two apiece, and a bracket has no way to record a
 * draw or advance one — the match would simply never resolve, with no error
 * anywhere to say why.
 */
const isBestOf = (n) => Number.isInteger(n) && n >= 1 && n <= 9 && n % 2 === 1;

/**
 * Where a series stands.
 *
 * @param games  [{ game_number, winner_team_id }] — order does not matter
 * @param bestOf 1, 3, 5…
 * @param teamA  the match's team_a_id
 * @param teamB  the match's team_b_id
 *
 * Returns:
 *   winsA, winsB   games won, counting only games with a winner recorded
 *   toWin          how many it takes
 *   decided        somebody has reached it
 *   winnerId       who, or null
 *   remaining      the MOST games that could still be played — 0 once it is
 *                  decided, because a dead rubber is not a game anybody plays.
 *                  At 1-0 in a best of three that is 2, not 1: the series can
 *                  still go the distance.
 *   played         games with a result
 */
function seriesResult(games, bestOf, teamA, teamB) {
  const need = toWin(bestOf);
  let winsA = 0;
  let winsB = 0;
  let played = 0;

  (games || []).forEach((g) => {
    if (!g.winner_team_id) return;
    played += 1;
    if (g.winner_team_id === teamA) winsA += 1;
    else if (g.winner_team_id === teamB) winsB += 1;
    // A winner that is neither team is not counted for either. It cannot
    // happen through the UI and it must not silently decide a series if it
    // ever does.
  });

  const decided = winsA >= need || winsB >= need;
  const winnerId = winsA >= need ? teamA : winsB >= need ? teamB : null;

  return {
    winsA,
    winsB,
    toWin: need,
    decided,
    winnerId,
    played,
    // Once it is decided nothing more is worth playing. Before that, it is what
    // the TRAILING team still needs, which is the most the series can run on —
    // not bestOf minus played, which would keep offering a game 3 in a 2-0.
    remaining: decided ? 0 : Math.max(need - winsA, need - winsB),
  };
}

/**
 * The rows a scoresheet should show: every game already played, plus the next
 * one if there is a next one.
 *
 * Not all `bestOf` rows. Offering an empty game 3 under a finished 2-0 invites
 * somebody to fill it in, and a dead rubber recorded as a real game makes the
 * series read 2-1 when it was 2-0.
 */
function gameSlots(games, bestOf, teamA, teamB) {
  const played = [...(games || [])].sort((a, b) => a.game_number - b.game_number);
  const need = toWin(bestOf);

  // Walked in order rather than counted in bulk, because whether a game
  // MATTERED depends on the score before it, not after. A game 3 in a 2-0 is
  // shown — somebody entered it and hiding it would make the score disagree
  // with the games on screen — but marked as having decided nothing.
  let a = 0;
  let b = 0;
  const slots = played.map((g) => {
    const alreadyDecided = a >= need || b >= need;
    if (g.winner_team_id === teamA) a += 1;
    else if (g.winner_team_id === teamB) b += 1;
    return { ...g, exists: true, dead: alreadyDecided };
  });

  // One empty slot, and only while the series is live. Offering all three at
  // once invites somebody to fill in a game that was never played.
  const state = seriesResult(games, bestOf, teamA, teamB);
  if (!state.decided && slots.length < bestOf) {
    slots.push({ game_number: (slots[slots.length - 1]?.game_number || 0) + 1, exists: false });
  }

  return slots;
}

/** "2 — 1", for a bracket card. */
const scoreline = (state) => `${state.winsA} — ${state.winsB}`;

module.exports = { toWin, isBestOf, seriesResult, gameSlots, scoreline };
