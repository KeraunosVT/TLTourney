// shared/board.cjs — a captain's private ranking of the player pool.
//
// Tiers plus ordering INSIDE each tier, rather than one flat 1..360 list. A
// flat list is a lie about how anybody actually evaluates players: nobody
// genuinely believes their 40th-ranked player is better than their 41st, but
// everybody can say "these twelve are interchangeable and all of them are
// better than the next twenty". Tiers record the confidence that exists;
// ordering within a tier records the preference that exists inside it.
//
// It also survives draft night better. When your pick comes and four of your
// Tier 2 are gone, a tier tells you the remaining ones are still fine. A flat
// list makes you wonder whether you should be reaching further down it.

const { ROLES } = require('./roles.cjs');

const TIERS = [
  { tier: 1, label: 'Tier 1', hint: 'Take one of these the moment the clock starts' },
  { tier: 2, label: 'Tier 2', hint: 'Very happy to land' },
  { tier: 3, label: 'Tier 3', hint: 'Solid' },
  { tier: 4, label: 'Tier 4', hint: 'Depth and subs' },
  { tier: 5, label: 'Tier 5', hint: 'Late rounds' },
  // Not a rank — the opposite. Kept on the board rather than left in the pool
  // because "we already decided against them" is information, and a name that
  // just sits unranked looks like one nobody has gotten to yet.
  { tier: 6, label: 'Avoid', hint: "Don't draft", exclude: true },
];

const TIER_NUMBERS = TIERS.map((t) => t.tier);
const MIN_TIER = Math.min(...TIER_NUMBERS);
const MAX_TIER = Math.max(...TIER_NUMBERS);

// Strict: a tier arrives from a request body, and '2' is a string, not a tier.
const isTier = (n) => typeof n === 'number' && Number.isInteger(n) && TIER_NUMBERS.includes(n);

const tierMeta = (n) => TIERS.find((t) => t.tier === n) || null;

// Tiers that count as "I want this player". Everything the coverage figures
// below are built from.
const RANKED_TIERS = TIERS.filter((t) => !t.exclude).map((t) => t.tier);

/**
 * Does this board actually cover a roster?
 *
 * Compares the players a captain has ranked against the MINIMUM each role
 * needs for one team — the floor from the party template, the slots no
 * flexible slot can cover for them.
 *
 * The point is the thing a captain cannot see by looking at their own board:
 * boards get built out of the players you find exciting, and nobody finds
 * their sixteenth healer exciting. A board can look full and still not contain
 * a legal roster.
 *
 * `ranked` counts only tiers that aren't the Avoid bucket.
 */
function coverage(entries, demand) {
  const have = {};
  ROLES.forEach((r) => { have[r] = 0; });

  let ranked = 0;
  let avoided = 0;
  entries.forEach((e) => {
    if (tierMeta(e.tier)?.exclude) { avoided += 1; return; }
    ranked += 1;
    if (e.role && have[e.role] !== undefined) have[e.role] += 1;
  });

  return {
    ranked,
    avoided,
    roles: ROLES.map((role) => ({
      role,
      have: have[role],
      min: demand[role]?.min ?? 0,
      short: Math.max(0, (demand[role]?.min ?? 0) - have[role]),
    })),
  };
}

/**
 * Move one entry up or down inside its tier.
 *
 * Returns the reordered list of ids, or null if the move goes off either end —
 * null rather than the unchanged list so the caller can skip a pointless write
 * instead of comparing arrays to find out nothing happened.
 */
function moveWithin(ids, id, delta) {
  const i = ids.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ids.length) return null;
  const next = [...ids];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

module.exports = {
  TIERS, TIER_NUMBERS, RANKED_TIERS, MIN_TIER, MAX_TIER,
  isTier, tierMeta, coverage, moveWithin,
};
