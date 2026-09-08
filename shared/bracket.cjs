// shared/bracket.cjs — double elimination, with a reset.
//
// Two pure functions and no database between them:
//
//   generateBracket(n)               the entire match skeleton, up front
//   applyResult(matches, key, winner) where the two teams go next
//
// THE WHOLE SKELETON IS BUILT AT ONCE. Every match exists from the moment the
// bracket is generated, with empty slots that name where their occupants come
// from. Advancing a team is then writing an id into a slot that is already
// there — not creating a round. Generating rounds lazily is where double
// elimination implementations go wrong, because the losers bracket's shape
// depends on rounds that haven't happened yet and the special cases multiply
// until nobody can say whether a given bracket is right.
//
// A slot names its source rather than pointing at a destination:
//
//   { type: 'seed',   seed }   the nth seed starts here
//   { type: 'winner', of }     whoever wins that match
//   { type: 'loser',  of }     whoever loses it
//   { type: 'bye' }            nobody — see the bye cascade below
//
// Sources rather than destinations because a match has exactly two slots and
// therefore exactly two sources, while "where does the loser of this go" has
// answers that differ per bracket, per round, and per parity. Reading the
// sources, every match answers for itself.

// ── Structure ───────────────────────────────────────────────────────────────
const SEED = (seed) => ({ type: 'seed', seed });
const WINNER = (of) => ({ type: 'winner', of });
const LOSER = (of) => ({ type: 'loser', of });

const keyFor = (bracket, round, idx) => `${bracket}${round}-${idx}`;

// matches.best_of defaults to 3 (migration 013). Two stages override it, and
// they pull in opposite directions for the same reason — how much a series is
// worth deciding.
//
// The grand final is longer than everything before it.
const GRAND_FINAL_BEST_OF = 5;

// A seeding fixture is a SINGLE GAME. Six fixtures at best-of-three is
// eighteen games to decide a seeding order, which is more play than the
// double-elimination bracket those seeds feed into. One game each keeps the
// stage to six games and puts the long series where they matter.
const SEEDING_BEST_OF = 1;

// ── The seeding stage ───────────────────────────────────────────────────────
/**
 * Everyone plays everyone once, and the table that comes out of it seeds the
 * bracket.
 *
 * Four teams is six matches over three rounds — which is where "a 6 game
 * seeding tournament" comes from — but nothing here is written for four: n
 * teams play n(n-1)/2 matches over n-1 rounds (n rounds when n is odd, one team
 * resting each round).
 *
 * CIRCLE METHOD. Team 1 is pinned and the rest rotate one position each round,
 * which is the standard construction and the reason it is worth using rather
 * than nesting two loops: it guarantees every pair meets exactly once AND that
 * no team plays twice in the same round, so a round is a night's play.
 *
 * Slots are SEED(n) on both sides, the same shape the bracket uses, so the
 * backend's existing "map seed position to team id" pass places these too
 * without a second code path. The seed here is only an entry number — the whole
 * point of this stage is that it decides the real one.
 */
function generateRoundRobin(teamCount) {
  const teams = Math.max(0, Math.floor(teamCount) || 0);
  if (teams < 2) return { teams, rounds: 0, matches: [] };

  // An odd count gets a phantom that sits out; whoever is drawn against it
  // rests that round. Nothing is emitted for those pairings.
  const ids = Array.from({ length: teams }, (_, i) => i + 1);
  if (ids.length % 2 === 1) ids.push(null);

  const n = ids.length;
  const matches = [];

  for (let r = 0; r < n - 1; r++) {
    let idx = 0;
    for (let i = 0; i < n / 2; i++) {
      const a = ids[i];
      const b = ids[n - 1 - i];
      if (a === null || b === null) continue;
      // Lower seed on the left, purely so the fixture list reads consistently.
      const [lo, hi] = a < b ? [a, b] : [b, a];
      matches.push({
        key: keyFor('RR', r + 1, idx), bracket: 'RR', round: r + 1, idx,
        a: SEED(lo), b: SEED(hi),
        bestOf: SEEDING_BEST_OF,
        // Every fixture is played — a round-robin has no byes and nothing to
        // void, so markByes is not run over these. Set explicitly rather than
        // left for the database default: backend/bracket.js maps this field
        // onto `kind`, and an undefined here reached PostgREST as an explicit
        // NULL into a not-null column. See the note in fromEngine.
        status: 'match',
      });
      idx += 1;
    }
    // Rotate everything but the first position.
    ids.splice(1, 0, ids.pop());
  }

  return { teams, rounds: n - 1, matches };
}

/**
 * The table, from the results.
 *
 * Pure, and every input is handed in — `played` is the completed round-robin
 * matches, `teams` is [{ id, seed }], and `gamesByKey` maps a match key to
 * { a, b } game wins for the differential. A tournament that does not record
 * individual games still gets a table; it just leans harder on the tiebreaks
 * below the differential.
 *
 * ── The order, and why ──────────────────────────────────────────────────────
 *   1. Matches won.
 *   2. Head-to-head AMONG THE TIED TEAMS ONLY — a mini-table of the matches
 *      they played against each other. Two teams on 2-1 are separated by the
 *      one they played; three teams on 2-1 are separated by their results in
 *      the three matches between them, which is the same rule applied to a
 *      bigger group rather than a different rule.
 *   3. Game differential across the whole stage.
 *   4. Games won.
 *   5. Draft seed, ascending.
 *
 * Step 5 exists so this function is TOTAL. Every earlier step can tie — three
 * teams beating each other in a circle is not a freak result in a four-team
 * group — and a sort that can leave two teams genuinely equal produces a
 * seeding that depends on the order rows came back from Postgres. Draft seed is
 * arbitrary but it is FIXED, published, and the same answer every time it runs.
 */
function roundRobinStandings(played = [], teams = [], gamesByKey = {}) {
  const rows = new Map(teams.map((t) => ({
    teamId: t.id,
    seed: t.seed ?? Number.MAX_SAFE_INTEGER,
    played: 0, won: 0, lost: 0,
    gamesFor: 0, gamesAgainst: 0,
  })).map((r) => [r.teamId, r]));

  const done = played.filter((m) => m.winner_team_id && m.team_a_id && m.team_b_id);

  for (const m of done) {
    const a = rows.get(m.team_a_id);
    const b = rows.get(m.team_b_id);
    if (!a || !b) continue;

    a.played += 1; b.played += 1;
    const winner = rows.get(m.winner_team_id);
    const loser = m.winner_team_id === m.team_a_id ? b : a;
    if (winner) winner.won += 1;
    loser.lost += 1;

    const g = gamesByKey[m.key] || {};
    const ga = Number(g.a) || 0;
    const gb = Number(g.b) || 0;
    a.gamesFor += ga; a.gamesAgainst += gb;
    b.gamesFor += gb; b.gamesAgainst += ga;
  }

  // Head-to-head wins inside an arbitrary group of teams.
  const h2h = (group) => {
    const set = new Set(group);
    const wins = new Map([...set].map((id) => [id, 0]));
    for (const m of done) {
      if (!set.has(m.team_a_id) || !set.has(m.team_b_id)) continue;
      wins.set(m.winner_team_id, (wins.get(m.winner_team_id) || 0) + 1);
    }
    return wins;
  };

  const all = [...rows.values()];
  const diff = (r) => r.gamesFor - r.gamesAgainst;

  // Sorted in two passes: the whole field by wins, then each block of equal
  // wins by the rest. Head-to-head has to be computed per block, because "who
  // beat whom" is only meaningful among the teams actually tied.
  all.sort((x, y) => y.won - x.won);

  const out = [];
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j < all.length && all[j].won === all[i].won) j += 1;
    const block = all.slice(i, j);

    if (block.length > 1) {
      const wins = h2h(block.map((r) => r.teamId));
      block.sort((x, y) => (wins.get(y.teamId) || 0) - (wins.get(x.teamId) || 0)
        || diff(y) - diff(x)
        || y.gamesFor - x.gamesFor
        || x.seed - y.seed);
    }
    out.push(...block);
    i = j;
  }

  return out.map((r, n) => ({ ...r, diff: diff(r), place: n + 1 }));
}

/**
 * The order seeds are laid down the first round, so 1 meets the weakest team
 * and 1 and 2 can only meet in the final.
 *
 * Built by repeatedly doubling: every seed s in a bracket of n becomes the pair
 * (s, 2n+1-s), and the pair is written high-then-low on alternate positions so
 * the halves stay balanced.
 *
 *   2:  [1, 2]
 *   4:  [1, 4, 3, 2]
 *   8:  [1, 8, 5, 4, 3, 6, 7, 2]
 *
 * Read as adjacent pairs, the 8 is 1v8, 5v4, 3v6, 7v2 — the standard bracket.
 */
function seedOrder(size) {
  if (size < 2) return [1];
  let list = [1, 2];
  while (list.length < size) {
    const n = list.length;
    const next = [];
    list.forEach((s, i) => {
      const partner = 2 * n + 1 - s;
      if (i % 2 === 0) next.push(s, partner);
      else next.push(partner, s);
    });
    list = next;
  }
  return list;
}

/** Smallest power of two that holds n. Integer arithmetic — log2 of 8 is not 3. */
function bracketSize(n) {
  let size = 1;
  while (size < n) size <<= 1;
  return size;
}

/**
 * Build every match for `teamCount` teams.
 *
 * Returns { teams, size, byes, winnersRounds, losersRounds, matches }.
 *
 * Shape, for a bracket of size B with k = log2(B) winners rounds:
 *
 *   winners  round r has B / 2^r matches, r = 1..k. Round k is the WB final.
 *   losers   2k-2 rounds, alternating:
 *              minor round 2i-1  pairs the survivors of the previous LB round
 *              major round 2i    puts those winners against WB round i+1's losers
 *            Both have B / 2^(i+1) matches, for i = 1..k-1.
 *   final    WB champion vs LB champion, plus a reset match played only if the
 *            LB champion wins the first one.
 */
function generateBracket(teamCount) {
  const teams = Math.max(0, Math.floor(teamCount) || 0);
  if (teams < 2) {
    return { teams, size: 0, byes: 0, winnersRounds: 0, losersRounds: 0, matches: [] };
  }

  const size = bracketSize(teams);
  let k = 0;
  while ((1 << k) < size) k += 1;

  const order = seedOrder(size);
  const matches = [];

  // ── Winners ───────────────────────────────────────────────────────────────
  for (let i = 0; i < size / 2; i++) {
    matches.push({
      key: keyFor('W', 1, i), bracket: 'W', round: 1, idx: i,
      a: SEED(order[2 * i]), b: SEED(order[2 * i + 1]),
    });
  }
  for (let r = 2; r <= k; r++) {
    for (let i = 0; i < size >> r; i++) {
      matches.push({
        key: keyFor('W', r, i), bracket: 'W', round: r, idx: i,
        a: WINNER(keyFor('W', r - 1, 2 * i)),
        b: WINNER(keyFor('W', r - 1, 2 * i + 1)),
      });
    }
  }

  // ── Losers ────────────────────────────────────────────────────────────────
  for (let i = 1; i <= k - 1; i++) {
    const count = size >> (i + 1);
    const minor = 2 * i - 1;
    const major = 2 * i;

    // Minor: pairs whoever is already in the losers bracket. Round 1 is the
    // special case — there is no previous LB round, so it pairs WB round 1's
    // losers directly.
    for (let j = 0; j < count; j++) {
      matches.push({
        key: keyFor('L', minor, j), bracket: 'L', round: minor, idx: j,
        a: i === 1 ? LOSER(keyFor('W', 1, 2 * j)) : WINNER(keyFor('L', minor - 1, 2 * j)),
        b: i === 1 ? LOSER(keyFor('W', 1, 2 * j + 1)) : WINNER(keyFor('L', minor - 1, 2 * j + 1)),
      });
    }

    // Major: the survivors meet the teams dropping out of the winners bracket.
    //
    // CROSS-PLACEMENT, and it is invisible when it is wrong. Taken straight,
    // LB round 2 match j would receive WB round 2 match j's loser — and both of
    // those come from the same half of the winners bracket, so the team that
    // knocked somebody into the losers bracket meets them again immediately.
    // Reversing the drop order puts them against the other half instead.
    //
    // Alternating rather than always: reversing every major round would simply
    // move the collision rather than remove it.
    const flip = i % 2 === 1;
    for (let j = 0; j < count; j++) {
      const drop = flip ? count - 1 - j : j;
      matches.push({
        key: keyFor('L', major, j), bracket: 'L', round: major, idx: j,
        a: WINNER(keyFor('L', minor, j)),
        b: LOSER(keyFor('W', i + 1, drop)),
      });
    }
  }

  // ── Grand final ───────────────────────────────────────────────────────────
  // ONE match, best of five, and no reset. The losers-bracket team does not
  // have to win twice.
  //
  // That is a rules decision rather than an implementation one, and it costs
  // something real: a team that has not lost all tournament can now be knocked
  // out by a single series, which is the thing a reset exists to prevent. It
  // buys back a final that always ends when it says it will — one series, a
  // known length, schedulable on a broadcast. The organisers made that trade;
  // see migration 026.
  //
  // GF2-0 is simply not built any more. applyResult still handles a reset match
  // if one is present, so brackets drawn before 026 continue to work.
  const wbFinal = keyFor('W', k, 0);
  matches.push({
    key: 'GF1-0', bracket: 'GF', round: 1, idx: 0,
    a: WINNER(wbFinal),
    // With two teams there is no losers bracket at all (2k-2 = 0 rounds), so
    // the winners final's loser IS the losers champion. Without this the grand
    // final would reference a match that was never built.
    b: k === 1 ? LOSER(wbFinal) : WINNER(keyFor('L', 2 * k - 2, 0)),
    // Which side arrived through the losers bracket. With no reset it decides
    // nothing structural, but it is still what the page uses to say how each
    // team got here.
    lbSlot: 'b',
    bestOf: GRAND_FINAL_BEST_OF,
  });

  markByes(matches, teams);

  return { teams, size, byes: size - teams, winnersRounds: k, losersRounds: Math.max(0, 2 * k - 2), matches };
}

/**
 * Work out which matches nobody actually plays, and mark them.
 *
 * A bracket of 11 teams is a bracket of 16 with 5 empty chairs. Seeds 12..16
 * don't exist, so the matches against them are walkovers — and the loser of a
 * walkover is nobody, which means the losers-bracket slot expecting that loser
 * is ALSO empty, which can make a losers match a walkover in turn. The emptiness
 * cascades, and it cascades further the more byes there are.
 *
 * Resolved as a fixpoint rather than a formula. Each pass asks every match
 * whether both its slots are known yet; a pass that changes nothing means
 * everything that can be decided has been. Two lines, no special cases, and
 * correct for any number of byes.
 *
 * Statuses:
 *   'match'    both sides real — somebody has to play it
 *   'walkover' one side empty — the other advances for free
 *   'void'     both sides empty — the match does not exist
 */
function markByes(matches, teams) {
  const byKey = new Map(matches.map((m) => [m.key, m]));
  const out = new Map();   // key -> { winner, loser }, each 'live' | 'bye'

  const slot = (src) => {
    if (!src) return '?';
    if (src.type === 'seed') return src.seed <= teams ? 'live' : 'bye';
    const o = out.get(src.of);
    if (!o) return '?';
    return src.type === 'winner' ? o.winner : o.loser;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const m of matches) {
      if (out.has(m.key)) continue;
      const a = slot(m.a);
      const b = slot(m.b);
      if (a === '?' || b === '?') continue;

      if (a === 'bye' && b === 'bye') {
        m.status = 'void';
        out.set(m.key, { winner: 'bye', loser: 'bye' });
      } else if (a === 'bye' || b === 'bye') {
        m.status = 'walkover';
        m.advances = a === 'bye' ? 'b' : 'a';
        out.set(m.key, { winner: 'live', loser: 'bye' });
      } else {
        m.status = 'match';
        out.set(m.key, { winner: 'live', loser: 'live' });
      }
      changed = true;
    }
  }

  // Anything still undecided depends only on real results, so it is a real
  // match. Reachable when a match's sources are themselves undecided.
  matches.forEach((m) => { if (!m.status) m.status = 'match'; });
  return matches;
}

// ── Advancing ───────────────────────────────────────────────────────────────
/**
 * Which side of the grand final arrived through the WINNERS bracket.
 *
 * DERIVED from the match's own slot sources rather than read from a field,
 * because this function has to work on rows that came back out of a database.
 * `lbSlot` is set when generateBracket builds the match and is gone by the time
 * the row is read again — and a `lbSlot === 'a'` test against undefined
 * silently falls through to the right answer, which is the worst kind of
 * correct: it would keep working until somebody built a bracket the other way
 * round, and then the reset would fire for the wrong team.
 *
 * The winners champion is the side fed by a winners-bracket match's winner.
 */
function winnersSide(m) {
  if (m.lbSlot) return m.lbSlot === 'a' ? 'b' : 'a';
  if (m.a?.type === 'winner' && String(m.a.of || '').startsWith('W')) return 'a';
  if (m.b?.type === 'winner' && String(m.b.of || '').startsWith('W')) return 'b';
  return 'a';
}

/**
 * Somebody won. Where do the two teams go?
 *
 * Pure: takes the current matches (with team ids and results filled in), and
 * returns the writes to make. Persisting them, and logging it, is the caller's
 * job — which is what lets the whole of this be tested without a database.
 *
 * Returns { winnerId, loserId, writes, eliminated, reset, champion } or
 * { error }.
 */
function applyResult(matches, key, winnerId) {
  const m = matches.find((x) => x.key === key);
  if (!m) return { error: `There is no match ${key} in this bracket.` };

  const a = m.team_a_id ?? null;
  const b = m.team_b_id ?? null;
  if (!a || !b) return { error: 'Both teams have to be decided before this match has a result.' };
  if (winnerId !== a && winnerId !== b) return { error: 'That team is not in this match.' };

  const loserId = winnerId === a ? b : a;

  // The reset question, and it has to be asked before the writes are collected:
  // the reset match's slots source from this one, so without it a grand final
  // won by the winners-bracket team would still populate the reset and the
  // bracket would sit there waiting for a match that should never be played.
  const isGrandFinal = m.bracket === 'GF' && m.round === 1;

  // A reset only happens if there is a reset match TO PLAY. Since 026 the
  // generator stops building one, and without this check a grand final won by
  // the losers-bracket team would still be flagged `reset` — which suppresses
  // the champion, advances nothing, and leaves the bracket waiting forever on
  // a match that does not exist. Brackets drawn before 026 still carry a GF2-0
  // and still reset; this is what makes both work from one function.
  const hasReset = matches.some((x) => x.reset || x.is_reset);
  const reset = isGrandFinal && hasReset
    && winnerId !== (winnersSide(m) === 'a' ? a : b);

  const writes = [];
  let dropped = false;
  for (const x of matches) {
    // A reset that isn't happening receives nothing.
    if (x.reset && isGrandFinal && !reset) continue;
    for (const side of ['a', 'b']) {
      const src = x[side];
      if (src?.type === 'winner' && src.of === key) {
        writes.push({ key: x.key, slot: side, teamId: winnerId });
      } else if (src?.type === 'loser' && src.of === key) {
        writes.push({ key: x.key, slot: side, teamId: loserId });
        dropped = true;
      }
    }
  }

  return {
    winnerId,
    loserId,
    writes,
    // Out of the tournament: their loss had nowhere to drop to. True for every
    // losers-bracket match, and for a grand final that isn't forcing a reset.
    eliminated: dropped ? null : loserId,
    reset,
    champion: (isGrandFinal && !reset) || (m.bracket === 'GF' && m.round === 2)
      ? winnerId
      : null,
  };
}

// ── Naming ──────────────────────────────────────────────────────────────────
/**
 * What to call a match on screen.
 *
 * "Winners Round 3" is what it is; "Winners Final" is what people call it, and
 * a bracket that says the first is harder to talk about than one that says the
 * second.
 */
function roundLabel(match, { winnersRounds, losersRounds, seedingRounds } = {}) {
  // The seeding stage is rounds of fixtures, not a knockout — there is no
  // "final", so it says which of the n-1 rounds it is and stops there.
  if (match.bracket === 'RR') {
    return seedingRounds && match.round === seedingRounds
      ? 'Seeding — Final Round'
      : `Seeding — Round ${match.round}`;
  }
  if (match.bracket === 'GF') return match.round === 2 ? 'Grand Final — Reset' : 'Grand Final';
  if (match.bracket === 'W') {
    if (match.round === winnersRounds) return 'Winners Final';
    if (match.round === winnersRounds - 1) return 'Winners Semi-final';
    return `Winners Round ${match.round}`;
  }
  if (match.round === losersRounds) return 'Losers Final';
  if (match.round === losersRounds - 1) return 'Losers Semi-final';
  return `Losers Round ${match.round}`;
}

/** Matches grouped into the columns a bracket is drawn as. */
function columns(matches, bracket) {
  const mine = matches.filter((m) => m.bracket === bracket && m.status !== 'void');
  const rounds = [...new Set(mine.map((m) => m.round))].sort((x, y) => x - y);
  return rounds.map((round) => ({
    round,
    matches: mine.filter((m) => m.round === round).sort((x, y) => x.idx - y.idx),
  }));
}

module.exports = {
  generateBracket, generateRoundRobin, roundRobinStandings,
  applyResult, seedOrder, bracketSize, roundLabel, columns, winnersSide,
  GRAND_FINAL_BEST_OF, SEEDING_BEST_OF, SEED, WINNER, LOSER, keyFor,
};
