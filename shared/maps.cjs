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

// One ban per team, so two per match. Kept as a named constant because the
// arithmetic below reads as nonsense without it, and because "two bans" is a
// rule that will get argued about and changed.
const BANS_PER_MATCH = 2;

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

module.exports = { MAPS, isMap, available, isPlayable, BANS_PER_MATCH };
