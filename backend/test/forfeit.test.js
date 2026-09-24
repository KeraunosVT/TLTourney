// Forfeiting a match — the rules, without a database behind them.
//
// The whole hazard here is DIRECTION. Recording a result names the winner;
// forfeiting names the team that pulled out. Those are opposite inputs that
// produce the same kind of write, and getting them the wrong way round does not
// fail — it advances the team that withdrew, through a bracket that looks
// entirely correct, until somebody notices a team playing a semi-final they
// conceded.
//
// So opponentIn is tested in both directions on purpose, and forfeitProblem is
// tested on every state a match can be in rather than only the happy one.
const test = require('node:test');
const assert = require('node:assert');

const { opponentIn, forfeitProblem, forfeitReasonProblem } = require('../../shared/bracket.cjs');

const A = 'team-a';
const B = 'team-b';
const ready = (over = {}) => ({
  key: 'W1-0', kind: 'match', status: 'ready', best_of: 3,
  team_a_id: A, team_b_id: B, ...over,
});

// ── Direction ───────────────────────────────────────────────────────────────
test('the winner is the OTHER team, from either side', () => {
  const m = ready();
  assert.strictEqual(opponentIn(m, A), B);
  assert.strictEqual(opponentIn(m, B), A);
});

test('nobody is ever their own opponent', () => {
  const m = ready();
  for (const who of [A, B]) {
    assert.notStrictEqual(opponentIn(m, who), who,
      'a forfeit that awards the match to the team that conceded is the bug this file exists for');
  }
});

// ── When a forfeit is allowed ───────────────────────────────────────────────
test('a ready match with both teams can be forfeited by either side', () => {
  assert.strictEqual(forfeitProblem({ match: ready(), teamId: A }), null);
  assert.strictEqual(forfeitProblem({ match: ready(), teamId: B }), null);
});

test('a match that is already decided is refused, not overwritten', () => {
  // Silently replacing a recorded result would rewrite a played series as a
  // concession. Undo exists for this.
  const p = forfeitProblem({ match: ready({ status: 'complete' }), teamId: A });
  assert.match(p, /already has a result/i);
});

test('a bye cannot be forfeited', () => {
  // One team and nobody to concede to. Writing a result here would put one on a
  // row the bracket resolves by itself.
  const p = forfeitProblem({ match: ready({ kind: 'walkover', team_b_id: null }), teamId: A });
  assert.match(p, /bye/i);
});

test('a void match cannot be forfeited', () => {
  const p = forfeitProblem({ match: ready({ kind: 'void' }), teamId: A });
  assert.match(p, /not being played/i);
});

test('a match missing a team cannot be forfeited yet', () => {
  // THE CASE THAT MAKES THIS PER-MATCH. A team that has withdrawn entirely
  // still cannot be forfeited out of a losers bracket slot whose other side is
  // undecided — there is no opponent to award it to. settle() fills the slot in
  // later, and the forfeit is recorded then.
  for (const m of [ready({ team_b_id: null }), ready({ team_a_id: null })]) {
    assert.match(forfeitProblem({ match: m, teamId: A }), /both teams/i);
  }
});

test('a team not in the match is refused', () => {
  const p = forfeitProblem({ match: ready(), teamId: 'team-c' });
  assert.match(p, /not in this match/i);
});

test('a missing match or missing team is a sentence, not a crash', () => {
  assert.match(forfeitProblem({ match: null, teamId: A }), /no such match/i);
  assert.match(forfeitProblem({ match: ready(), teamId: null }), /which team/i);
  assert.match(forfeitProblem({ match: ready(), teamId: undefined }), /which team/i);
});

// ── The reason ──────────────────────────────────────────────────────────────
// Required, because a forfeit with no stated cause is the thing 035 had to go
// back and repair by hand — a row that changed for a reason nobody wrote down.
test('a reason is required and whitespace is not one', () => {
  assert.match(forfeitReasonProblem(''), /say why/i);
  assert.match(forfeitReasonProblem('   '), /say why/i);
  assert.match(forfeitReasonProblem(null), /say why/i);
  assert.match(forfeitReasonProblem(undefined), /say why/i);
});

test('an ordinary reason passes', () => {
  assert.strictEqual(forfeitReasonProblem('Did not turn up'), null);
  assert.strictEqual(forfeitReasonProblem('  roster withdrew  '), null);
});

test('an over-long reason is refused rather than truncated', () => {
  assert.strictEqual(forfeitReasonProblem('x'.repeat(200)), null);
  assert.match(forfeitReasonProblem('x'.repeat(201)), /200/);
});
