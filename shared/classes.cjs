// shared/classes.cjs — the weapon pair → class rule, used by BOTH halves.
//
// One copy on purpose. The signup form derives the class in the browser so it
// can show it as you pick, and the server derives it again on write because a
// value that arrives in a request body is a claim, not a fact. Two copies of
// this table would drift, and the drift would be invisible: the page would name
// one class and the database would store another.
//
// ── WHY .cjs ────────────────────────────────────────────────────────────────
// CommonJS, so the backend can `require()` it on ANY Node version. This was
// briefly an .mjs that the CommonJS backend required — which works, but only on
// Node 22.12+, and pinning the whole deployment to a bleeding-edge Node so one
// 30-line file can use `export` is a bad trade. Vite reads CommonJS from source
// via commonjsOptions in vite.config.js.
//
// The table itself is weaponClasses.json, lifted from Gear-Gap. Its keys are
// NOT in a consistent order (`CrossbowDagger` but `GreatswordDagger`), so every
// lookup has to try both concatenations.

const WEAPON_CLASSES = require('./weaponClasses.json');

// The ten weapons, in the order the game's own UI lists them.
const WEAPONS = ['SnS', 'Greatsword', 'Dagger', 'Crossbow', 'Longbow', 'Staff', 'Wand', 'Spear', 'Orb', 'Gauntlet'];

/**
 * The class for a weapon pair, or null if there isn't one.
 * Order-independent: Greatsword+Dagger and Dagger+Greatsword are both Ravager.
 */
function classify(w1, w2) {
  if (!w1 || !w2) return null;
  return WEAPON_CLASSES[w1 + w2] || WEAPON_CLASSES[w2 + w1] || null;
}

const isWeapon = (w) => WEAPONS.includes(w);

module.exports = { WEAPONS, WEAPON_CLASSES, classify, isWeapon };
