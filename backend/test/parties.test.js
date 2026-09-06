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
  DEFAULT_PARTY_TEMPLATE, DEFAULT_SUB_SLOTS, SLOT_NAMES, resizeTemplate, templateFits,
  startersPerTeam, roleDemand, rosterDemand, resizeSubs, subsFit,
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

// ── The bench ───────────────────────────────────────────────────────────────
// Substitutes carry slot types now (migration 021). The bug this section
// guards is the one that existed for as long as they did not: role figures
// counted off 48 starters while the roster total counted 66, so a pool could
// report every role covered and be twenty players short of a bench.

test('the default bench is 18 slots — 4 tank, 10 dps, 4 healer', () => {
  assert.strictEqual(DEFAULT_SUB_SLOTS.length, 18);
  const count = (r) => DEFAULT_SUB_SLOTS.filter((s) => s === r).length;
  assert.strictEqual(count('Tank'), 4);
  assert.strictEqual(count('DPS'), 10);
  assert.strictEqual(count('Healer'), 4);
});

test('ROSTER demand is starters PLUS bench', () => {
  const starters = roleDemand(DEFAULT_PARTY_TEMPLATE, 1);
  const whole = rosterDemand(DEFAULT_PARTY_TEMPLATE, DEFAULT_SUB_SLOTS, 1);

  assert.deepStrictEqual(whole.Tank, { min: 13, max: 20 });
  assert.deepStrictEqual(whole.DPS, { min: 26, max: 33 });
  assert.deepStrictEqual(whole.Healer, { min: 20, max: 25 });

  // Every floor moved by exactly the bench's count of that role, and nothing
  // else did. Stated as a relation rather than three more constants so it
  // survives the next time the template is retuned.
  assert.strictEqual(whole.Tank.min - starters.Tank.min, 4);
  assert.strictEqual(whole.DPS.min - starters.DPS.min, 10);
  assert.strictEqual(whole.Healer.min - starters.Healer.min, 4);
});

test('the floors and the flexible slots reconcile to the whole roster', () => {
  const whole = rosterDemand(DEFAULT_PARTY_TEMPLATE, DEFAULT_SUB_SLOTS, 1);
  const compulsory = whole.Tank.min + whole.DPS.min + whole.Healer.min;
  // 59 compulsory + the 7 flexible starting slots = the 66-man roster.
  assert.strictEqual(compulsory, 59);
  assert.strictEqual(compulsory + 7, 66);
});

test('a bench of Any Role adds no requirement to anybody', () => {
  // The state migration 021 leaves an archived season in, and what resizeSubs
  // pads with. It must not make a roster read as short of a role.
  const starters = roleDemand(DEFAULT_PARTY_TEMPLATE, 1);
  const whole = rosterDemand(DEFAULT_PARTY_TEMPLATE, Array(18).fill('Any Role'), 1);
  ['Tank', 'DPS', 'Healer'].forEach((r) => {
    assert.strictEqual(whole[r].min, starters[r].min, `${r} floor moved`);
    assert.strictEqual(whole[r].max, starters[r].max + 18, `${r} ceiling`);
  });
});

test('rosterDemand survives a tournament that has no bench recorded', () => {
  // Rows read before 021 is applied. Falls back to the starting side rather
  // than throwing on a page that would otherwise render.
  const starters = roleDemand(DEFAULT_PARTY_TEMPLATE, 1);
  [undefined, null, []].forEach((bench) => {
    assert.deepStrictEqual(rosterDemand(DEFAULT_PARTY_TEMPLATE, bench, 1), starters);
  });
});

test('RESIZING THE BENCH KEEPS IT AGREEING WITH THE COUNT', () => {
  // The property the CHECK in 021 enforces, and the reason the API resizes
  // instead of refusing: an organizer typing a new number in Setup must not
  // get a rejected write.
  for (const n of [0, 1, 12, 18, 40]) {
    const b = resizeSubs(DEFAULT_SUB_SLOTS, n);
    assert.ok(subsFit(b, n), `${n} does not fit`);
    assert.ok(b.every((s) => SLOT_NAMES.includes(s)), `${n} produced an unknown slot`);
  }
});

test('the bench trims from the END and pads with Any Role', () => {
  assert.deepStrictEqual(resizeSubs(['Tank', 'DPS', 'Healer'], 2), ['Tank', 'DPS']);
  assert.deepStrictEqual(
    resizeSubs(['Tank'], 3),
    ['Tank', 'Any Role', 'Any Role'],
  );
  assert.deepStrictEqual(resizeSubs(null, 2), ['Any Role', 'Any Role']);
});

test('subsFit catches each way the bench and the count can disagree', () => {
  assert.ok(subsFit(DEFAULT_SUB_SLOTS, 18));
  assert.ok(!subsFit(DEFAULT_SUB_SLOTS, 12), 'too many slots');
  assert.ok(!subsFit(['Tank'], 4), 'too few');
  assert.ok(!subsFit(null, 0), 'a missing bench is not a bench of nothing');
});
