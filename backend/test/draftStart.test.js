// Can this draft start, and how many rounds is it?
//
// Every check in startProblems guards against a draft that runs perfectly to
// the end and is quietly WRONG — not one that crashes. That is the whole reason
// it exists as a gate rather than as a warning: an unfair draft is only
// discoverable afterwards, by comparing finished rosters, and by then it has
// been streamed.
const test = require('node:test');
const assert = require('node:assert');

const { startProblems } = require('../draft');

const team = (name, over = {}) => ({ name, seed: 1, rosterCount: 2, captainCount: 2, ...over });
const seeded = (n, over = {}) =>
  Array.from({ length: n }, (_, i) => team(`T${i + 1}`, { seed: i + 1, ...over }));

test('two properly set-up teams can start', () => {
  const { problems, rounds } = startProblems(60, seeded(2));
  assert.deepStrictEqual(problems, []);
  assert.strictEqual(rounds, 58);
});

test('ROUNDS ACCOUNT FOR THE CAPTAINS ALREADY ON THE ROSTER', () => {
  // The off-by-two that costs the most: 60 rounds with two captains already
  // seated is 62 players a team, and the draft would not notice.
  assert.strictEqual(startProblems(60, seeded(4)).rounds, 58);
  assert.strictEqual(startProblems(60, seeded(4, { rosterCount: 1, captainCount: 1 })).rounds, 59);
  assert.strictEqual(startProblems(6, seeded(4, { rosterCount: 0, captainCount: 1 })).rounds, 6);
});

test('one team is not a draft', () => {
  const { problems } = startProblems(60, seeded(1));
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /two teams/i);
});

test('an unseeded team is refused, and named', () => {
  const teams = seeded(3);
  teams[1].seed = null;
  const { problems } = startProblems(60, teams);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /T2/);
  assert.match(problems[0], /seed/i);
});

test('a team with no captain is refused — every pick would be the clock\'s', () => {
  const teams = seeded(3);
  teams[2].captainCount = 0;
  const { problems } = startProblems(60, teams);
  assert.match(problems[0], /T3/);
  assert.match(problems[0], /captain/i);
});

test('TEAMS THAT DO NOT START LEVEL ARE REFUSED', () => {
  // The quiet one. A snake gives every team the same NUMBER of picks, so a team
  // starting with two captains and one starting with one finish a player apart
  // — and nothing at any later point reports it.
  const teams = seeded(3);
  teams[0].rosterCount = 1;
  teams[0].captainCount = 1;

  const { problems } = startProblems(60, teams);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /level/i);
  assert.match(problems[0], /T1 1/);
  assert.match(problems[0], /T2 2/);
});

test('a roster already full leaves nothing to draft', () => {
  const { problems, rounds } = startProblems(2, seeded(4));   // 2-player rosters, 2 captains
  assert.strictEqual(rounds, 0);
  assert.match(problems[0], /nothing to draft/i);
});

test('several problems at once are all reported, not just the first', () => {
  // An organizer fixing one thing per attempt on draft night is an organizer
  // finding the last problem at 9:40.
  const teams = seeded(3);
  teams[0].seed = null;
  teams[1].captainCount = 0;
  teams[2].rosterCount = 1;

  const { problems } = startProblems(60, teams);
  assert.strictEqual(problems.length, 3);
});
