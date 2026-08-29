// Reshaping a team.
//
// roster_size is generated as party_count * party_size + sub_count; every role
// requirement is counted off the party TEMPLATE. They are two descriptions of
// one thing, and only half of that is enforced — a CHECK pins party_count to
// the template's length, and nothing at all pins party_size to the slots. So
// party_size could be changed alone, leaving a 52-player roster beside a
// template describing 48 starters, with every readiness figure computed from
// the wrong one and nothing on screen disagreeing.
const test = require('node:test');
const assert = require('node:assert');

const {
  DEFAULT_PARTY_TEMPLATE, SLOT_NAMES, resizeTemplate, templateFits,
  startersPerTeam, roleDemand,
} = require('../../shared/parties.cjs');

test('the default template is 8 parties of 6', () => {
  assert.ok(templateFits(DEFAULT_PARTY_TEMPLATE, 8, 6));
  assert.strictEqual(startersPerTeam(DEFAULT_PARTY_TEMPLATE), 48);
});

test('RESIZING KEEPS THE TWO DESCRIPTIONS AGREEING', () => {
  // The property the whole function exists for.
  for (const [count, size] of [[8, 6], [6, 6], [4, 5], [12, 6], [1, 1], [8, 8]]) {
    const t = resizeTemplate(DEFAULT_PARTY_TEMPLATE, count, size);
    assert.ok(templateFits(t, count, size), `${count}x${size} does not fit`);
    assert.strictEqual(startersPerTeam(t), count * size, `${count}x${size} starters`);
  }
});

test('shrinking drops from the END, so tuned early parties survive', () => {
  // Party 1 is the objective party and the one people actually tune. Losing it
  // to a change in party COUNT would be a silent edit to something else.
  const t = resizeTemplate(DEFAULT_PARTY_TEMPLATE, 3, 6);
  assert.strictEqual(t.length, 3);
  assert.deepStrictEqual(t[0], DEFAULT_PARTY_TEMPLATE[0]);
  assert.deepStrictEqual(t[1], DEFAULT_PARTY_TEMPLATE[1]);
});

test('growing keeps every existing party untouched', () => {
  const t = resizeTemplate(DEFAULT_PARTY_TEMPLATE, 10, 6);
  assert.strictEqual(t.length, 10);
  DEFAULT_PARTY_TEMPLATE.forEach((p, i) => assert.deepStrictEqual(t[i], p));
});

test('ADDED SLOTS ARE "Any Role", NEVER A GUESS', () => {
  // A slot type is a CONSTRAINT — 'Tank' means only a tank may fill it. Padding
  // with one invents a requirement nobody asked for, and the roster then reads
  // as short of tanks it never needed.
  const t = resizeTemplate([{ name: 'P', slots: ['Tank', 'Healer'] }], 1, 5);
  assert.deepStrictEqual(t[0].slots, ['Tank', 'Healer', 'Any Role', 'Any Role', 'Any Role']);

  const before = roleDemand([{ name: 'P', slots: ['Tank', 'Healer'] }], 1);
  const after = roleDemand(t, 1);
  assert.strictEqual(after.Tank.min, before.Tank.min, 'padding added no tank requirement');
  assert.strictEqual(after.Healer.min, before.Healer.min);
});

test('trimming a party cuts slots from the end', () => {
  const t = resizeTemplate([{ name: 'P', slots: ['Tank', 'Tank', 'Healer', 'DPS'] }], 1, 2);
  assert.deepStrictEqual(t[0].slots, ['Tank', 'Tank']);
});

test('every slot a resize produces is a real slot type', () => {
  // Anything else can never be filled and would sit there looking normal.
  const t = resizeTemplate([], 9, 7);
  t.forEach((p) => p.slots.forEach((x) => assert.ok(SLOT_NAMES.includes(x), x)));
});

test('resizing from nothing still produces a usable template', () => {
  const t = resizeTemplate(null, 2, 6);
  assert.ok(templateFits(t, 2, 6));
  assert.strictEqual(startersPerTeam(t), 12);
});

test('templateFits catches each way the two can disagree', () => {
  const t = DEFAULT_PARTY_TEMPLATE;
  assert.ok(!templateFits(t, 6, 6), 'wrong party count');
  assert.ok(!templateFits(t, 8, 5), 'wrong party size — the half nothing enforces');
  assert.ok(!templateFits(null, 8, 6));
  assert.ok(!templateFits([{ name: 'P' }], 1, 6), 'a party with no slots at all');
});

test('resizing is idempotent', () => {
  const once = resizeTemplate(DEFAULT_PARTY_TEMPLATE, 5, 4);
  const twice = resizeTemplate(once, 5, 4);
  assert.deepStrictEqual(twice, once);
});
