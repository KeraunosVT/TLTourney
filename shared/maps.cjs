// shared/maps.cjs — the maps a match can be played on, and the bans.
//
// A fixed list, so the map on a game is chosen rather than typed. The games
// table stores `map` as free text and will keep accepting anything — the
// column deliberately does not carry a CHECK, for the reason migration 001
// gives about the class list: a list pasted into the schema drifts from the one
// the app uses, and only one of them can be right. This file is the one.
//
// Written down here rather than as rows in a table because it changes once a
// season at most, and a season's map pool is a fact about the tournament rules,
// not data somebody edits at 2am.

const MAPS = [
  'Leviathan',
  'Pakilo Naru',
  'Manticus',
  'Daigon',
  'Adentus',
  'Ahzreil',
  'Grand Aelon',
  'Morokai',
  'Chernobog',
  'Kowazan',
  'Talus',
];

const isMap = (name) => MAPS.includes(name);

// Between two and four bans per MATCH — not per team. The split between the
// sides is whatever the two of them actually took: two each is the usual shape,
// but a format that hands the higher seed an extra ban is three and one, and
// recording that is not the app's decision to override.
//
// Only the ceiling is enforced. A match part way through its bans has one, and
// a floor checked on the way in would mean bans could only ever be saved all at
// once — the minimum is a rule to show people, not a rule to refuse saves with.
const MIN_BANS_PER_MATCH = 2;
const MAX_BANS_PER_MATCH = 4;

/**
 * A side's bans, cleaned up.
 *
 * Takes what arrives — an array, a lone string from an older caller, null —
 * and returns a list of trimmed, non-empty, DEDUPLICATED names. The dedupe is
 * here rather than only in the route because the database cannot express it:
 * its CHECK catches the same map banned by both sides, but not the same map
 * twice on one side.
 */
function banList(v) {
  const raw = v == null ? [] : (Array.isArray(v) ? v : [v]);
  const out = [];
  for (const x of raw) {
    const name = String(x ?? '').trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * What is wrong with this pair of ban lists, in words, or null if nothing is.
 *
 * One function so the API's answer and the page's answer are the same sentence.
 * Order matters: a made-up map is reported before the count, because "that is
 * not a map" is more useful than "that is five bans" when the fifth is a typo.
 */
function banProblem(a, b) {
  const A = banList(a);
  const B = banList(b);
  const all = [...A, ...B];

  const unknown = all.find((m) => !isMap(m));
  if (unknown) return `"${unknown}" is not one of the tournament's maps.`;

  const both = A.find((m) => B.includes(m));
  if (both) {
    return `Both teams banned ${both} — that leaves one more map in play than the rules say, `
      + 'and which side keeps the ban is not something this can decide.';
  }

  if (all.length > MAX_BANS_PER_MATCH) {
    return `A match takes at most ${MAX_BANS_PER_MATCH} bans; that is ${all.length}.`;
  }

  return null;
}

/**
 * What is left to play on.
 *
 * A ban that is not a real map is IGNORED rather than silently removing
 * nothing — the count of what remains has to match the list of what remains, or
 * a screen says "9 available" above ten rows.
 */
function available(bans = []) {
  const banned = new Set(bans.filter(isMap));
  return MAPS.filter((m) => !banned.has(m));
}

/**
 * Can this map be played, given the bans?
 *
 * Checked on the way in as well as filtered on the way out. The picker only
 * offers legal maps, but a ban entered AFTER a game was recorded can strand a
 * game on a map that is now banned — and that has to be visible rather than
 * quietly allowed.
 */
const isPlayable = (map, bans = []) => isMap(map) && !bans.filter(isMap).includes(map);

module.exports = {
  MAPS, isMap, available, isPlayable,
  banList, banProblem, MIN_BANS_PER_MATCH, MAX_BANS_PER_MATCH,
};
