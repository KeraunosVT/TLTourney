// The weapon-pair → class rule. Worth holding directly because it is the seam
// between what the form shows you and what the database stores: a wrong answer
// here is a plausible class name, not an error, and nobody would notice.
const test = require('node:test');
const assert = require('node:assert');
const { WEAPONS, WEAPON_CLASSES, classify } = require('../../shared/classes.cjs');

test('every pair of two different weapons resolves to a class', () => {
  const missing = [];
  for (let i = 0; i < WEAPONS.length; i++) {
    for (let j = i + 1; j < WEAPONS.length; j++) {
      if (!classify(WEAPONS[i], WEAPONS[j])) missing.push(`${WEAPONS[i]}+${WEAPONS[j]}`);
    }
  }
  assert.deepStrictEqual(missing, [], 'these pairs have no class');
});

test('there are 45 pairs and the table has 45 entries', () => {
  const pairs = (WEAPONS.length * (WEAPONS.length - 1)) / 2;
  assert.strictEqual(pairs, 45);
  assert.strictEqual(Object.keys(WEAPON_CLASSES).length, 45);
});

test('order does not matter — the JSON keys are not consistently ordered', () => {
  // These two are written the opposite way round in weaponClasses.json, which
  // is exactly why the lookup tries both concatenations.
  assert.strictEqual(classify('Greatsword', 'Dagger'), 'Ravager');
  assert.strictEqual(classify('Dagger', 'Greatsword'), 'Ravager');
  assert.strictEqual(classify('Wand', 'Longbow'), 'Seeker');
  assert.strictEqual(classify('Longbow', 'Wand'), 'Seeker');
});

test('a few known pairs, spot-checked against the game', () => {
  assert.strictEqual(classify('SnS', 'Greatsword'), 'Crusader');
  assert.strictEqual(classify('Crossbow', 'Dagger'), 'Scorpion');
  assert.strictEqual(classify('Staff', 'Wand'), 'Invocator');
  assert.strictEqual(classify('Gauntlet', 'Spear'), 'Destroyer');
});

test('the same weapon twice is not a class', () => {
  WEAPONS.forEach((w) => assert.strictEqual(classify(w, w), null, `${w}+${w} should not resolve`));
});

test('nonsense and missing weapons return null rather than throwing', () => {
  assert.strictEqual(classify('Trebuchet', 'Dagger'), null);
  assert.strictEqual(classify('', 'Dagger'), null);
  assert.strictEqual(classify(null, undefined), null);
});

test('no class name is used for two different pairs', () => {
  // A duplicate would make the class ambiguous when read back — two builds
  // collapsing into one row on any per-class count.
  const seen = new Map();
  Object.entries(WEAPON_CLASSES).forEach(([pair, name]) => {
    assert.ok(!seen.has(name), `${name} is used by both ${seen.get(name)} and ${pair}`);
    seen.set(name, pair);
  });
});
