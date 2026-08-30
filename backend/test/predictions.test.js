// The prediction game.
//
// Two kinds of failure are worth guarding here, and neither one looks like a
// bug from the outside:
//
//   TIME — a window that closes a moment too late lets somebody pick a match
//   they can already see the first fight of. There is no error message for
//   that; there is just a leaderboard nobody trusts.
//
//   ARITHMETIC — points that are plausibly wrong. A tie broken silently, a
//   half-played series counted as a miss, a champion bonus paid on the wrong
//   team. Every one of those produces a standings table that renders perfectly.
const test = require('node:test');
const assert = require('node:assert');

const {
  WINNER_POINTS, SCORELINE_BONUS, CHAMPION_POINTS, QUESTION_POINTS, MAX_OPTIONS,
  loserGameOptions, scorelineLabel, pickProblem,
  pickWindow, championWindow, questionWindow, answersVisible,
  scorePick, scoreAnswer, questionProblem, answerSplit,
  standings, crowdSplit,
} = require('../../shared/predictions.cjs');

const A = 'team-a';
const B = 'team-b';

// A match as bracketState hands it over: series attached, teams filled in.
const match = (over = {}) => ({
  id: 'm1', key: 'W1-1', kind: 'match', status: 'ready', best_of: 3,
  team_a_id: A, team_b_id: B, scheduled_at: null,
  series: { winsA: 0, winsB: 0, played: 0, decided: false, winnerId: null, toWin: 2 },
  ...over,
});

const series = (winsA, winsB) => ({
  winsA, winsB, played: winsA + winsB,
  decided: winsA >= 2 || winsB >= 2,
  winnerId: winsA >= 2 ? A : winsB >= 2 ? B : null,
  toWin: 2,
});

// ── The window ──────────────────────────────────────────────────────────────
test('a match with two teams and nothing played is open', () => {
  const w = pickWindow(match());
  assert.strictEqual(w.open, true);
  assert.strictEqual(w.closesAt, null);
});

test('THE FIRST RECORDED GAME CLOSES IT, scheduled or not', () => {
  // The case that matters: a match starting late, still open by the clock, but
  // with game 1 already in the books. Anyone picking now has seen it.
  const late = match({
    scheduled_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    series: series(1, 0),
  });
  const w = pickWindow(late);
  assert.strictEqual(w.open, false);
  assert.match(w.reason, /started/);
});

test('A GAME ROW CLOSES IT, even before that game has a winner', () => {
  // Game 1's map goes in before game 1 is played — the organizer route accepts
  // a map with no winner for exactly that reason. Waiting for a winner would
  // leave an unscheduled match open through the whole of the first game.
  const m = match({ games: [{ game_number: 1, map: 'Talus', winner_team_id: null }] });
  assert.strictEqual(pickWindow(m).open, false);
  assert.match(pickWindow(m).reason, /started/);

  // And an empty games array is not a started match.
  assert.strictEqual(pickWindow(match({ games: [] })).open, true);
});

test('KICKOFF CLOSES IT even with no game recorded yet', () => {
  const at = new Date('2026-09-10T20:00:00Z').toISOString();
  const m = match({ scheduled_at: at });

  const before = pickWindow(m, Date.parse(at) - 1000);
  assert.strictEqual(before.open, true, 'a second before kickoff is still open');
  assert.strictEqual(before.closesAt, at, 'and it says when it shuts');

  // On the second, not after it. A window that closes "after" the scheduled
  // time is a window that accepts a pick at exactly kickoff.
  assert.strictEqual(pickWindow(m, Date.parse(at)).open, false);
  assert.match(pickWindow(m, Date.parse(at) + 1).reason, /Kickoff/);
});

test('a match missing a team is closed, but marked pending rather than refused', () => {
  // The difference the page needs: "not yet" draws a placeholder, "no" draws
  // nothing. A losers-round-4 fixture is the former for most of the night.
  const w = pickWindow(match({ team_b_id: null }));
  assert.strictEqual(w.open, false);
  assert.strictEqual(w.pending, true);
  assert.match(w.reason, /Waiting/);
});

test('a bye is never predictable', () => {
  const w = pickWindow(match({ kind: 'walkover', status: 'complete' }));
  assert.strictEqual(w.open, false);
  assert.match(w.reason, /bye/);
});

test('a finished match is closed', () => {
  assert.strictEqual(pickWindow(match({ status: 'complete', series: series(2, 1) })).open, false);
});

// ── The champion window ─────────────────────────────────────────────────────
test('champion picks close on the first game of the tournament, not on the draw', () => {
  const drawn = [match(), match({ id: 'm2' })];
  assert.strictEqual(championWindow({ teamCount: 8, matches: drawn }).open, true,
    'a drawn but unplayed bracket is still open');

  const underway = [match({ series: series(1, 0) }), match({ id: 'm2' })];
  const w = championWindow({ teamCount: 8, matches: underway });
  assert.strictEqual(w.open, false);
  assert.match(w.reason, /started/);
});

test('a bye does not start the tournament', () => {
  // Walkovers complete the moment the bracket is generated. If they counted,
  // the champion window would close before it ever opened.
  const withBye = [match({ kind: 'walkover', status: 'complete' }), match({ id: 'm2' })];
  assert.strictEqual(championWindow({ teamCount: 6, matches: withBye }).open, true);
});

test('no teams, no champion pick', () => {
  assert.strictEqual(championWindow({ teamCount: 0, matches: [] }).open, false);
});

// ── What a pick may say ─────────────────────────────────────────────────────
test('the scoreline options come from best_of, not from a constant', () => {
  assert.deepStrictEqual(loserGameOptions(3), [0, 1]);
  assert.deepStrictEqual(loserGameOptions(5), [0, 1, 2]);
  assert.deepStrictEqual(loserGameOptions(1), [0]);
  assert.strictEqual(scorelineLabel(3, 1), '2 — 1');
  assert.strictEqual(scorelineLabel(5, 2), '3 — 2');
});

test('a scoreline the series cannot produce is refused, and one it can is not', () => {
  const bo3 = match();
  assert.strictEqual(pickProblem({ teamId: A, loserGames: 1, match: bo3 }), null);
  assert.match(pickProblem({ teamId: A, loserGames: 2, match: bo3 }), /cannot end/);

  // The same number is legal in a best of five, so this cannot be a constant.
  const bo5 = match({ best_of: 5 });
  assert.strictEqual(pickProblem({ teamId: A, loserGames: 2, match: bo5 }), null);
  assert.match(pickProblem({ teamId: A, loserGames: 3, match: bo5 }), /cannot end/);
});

test('a team that is not in the match is refused', () => {
  assert.match(pickProblem({ teamId: 'someone-else', loserGames: 0, match: match() }), /not in this match/);
  assert.match(pickProblem({ teamId: null, loserGames: 0, match: match() }), /Pick a team/);
  assert.match(pickProblem({ teamId: A, loserGames: null, match: match() }), /scoreline/);
});

// ── Scoring ─────────────────────────────────────────────────────────────────
test('the winner scores, the exact scoreline scores more', () => {
  const done = match({ status: 'complete', series: series(2, 1) });

  const exact = scorePick({ team_id: A, loser_games: 1 }, done);
  assert.strictEqual(exact.points, WINNER_POINTS + SCORELINE_BONUS);
  assert.ok(exact.correct && exact.exact && exact.settled);

  const rightTeam = scorePick({ team_id: A, loser_games: 0 }, done);
  assert.strictEqual(rightTeam.points, WINNER_POINTS);
  assert.ok(rightTeam.correct);
  assert.strictEqual(rightTeam.exact, false);

  const wrong = scorePick({ team_id: B, loser_games: 1 }, done);
  assert.strictEqual(wrong.points, 0);
  assert.strictEqual(wrong.correct, false);
  assert.strictEqual(wrong.settled, true, 'wrong is settled — it is a miss, not a pending pick');
});

test('AN UNFINISHED SERIES SCORES NOTHING, and says so', () => {
  // The distinction the standings are built on. If a 1-0 counted as settled,
  // everybody who picked the trailing team would show a miss that could still
  // come good, and totals would move backwards when game 3 landed.
  const live = scorePick({ team_id: A, loser_games: 0 }, match({ series: series(1, 0) }));
  assert.strictEqual(live.settled, false);
  assert.strictEqual(live.points, 0);
  assert.strictEqual(live.correct, false);
});

test('a walkover pays nobody', () => {
  // Byes complete with a winner and no games. A pick that predates the draw
  // resolving must not turn into free points.
  const bye = match({
    kind: 'walkover', status: 'complete',
    series: { winsA: 0, winsB: 0, played: 0, decided: false, winnerId: null, toWin: 2 },
  });
  assert.strictEqual(scorePick({ team_id: A, loser_games: 0 }, bye).points, 0);
  assert.strictEqual(scorePick({ team_id: A, loser_games: 0 }, bye).settled, false);
});

test('the scoreline is read off the LOSER, so it works whichever side won', () => {
  const bWon = match({ status: 'complete', series: series(1, 2) });
  const exact = scorePick({ team_id: B, loser_games: 1 }, bWon);
  assert.strictEqual(exact.exact, true);
  assert.strictEqual(exact.points, WINNER_POINTS + SCORELINE_BONUS);
  assert.deepStrictEqual(exact.actual, { winner_team_id: B, loser_games: 1 });
});

test('a pick on a match that no longer exists scores nothing rather than throwing', () => {
  assert.strictEqual(scorePick({ team_id: A, loser_games: 0 }, undefined).points, 0);
  assert.strictEqual(scorePick(null, match()).settled, false);
});

// ── Standings ───────────────────────────────────────────────────────────────
const twoMatches = [
  { ...match({ id: 'm1', status: 'complete', series: series(2, 0) }) },
  { ...match({ id: 'm2', status: 'complete', series: series(1, 2) }) },
];

test('totals add up across matches, and pending picks do not count', () => {
  const rows = standings({
    matches: [...twoMatches, match({ id: 'm3', series: series(1, 0) })],
    picks: [
      { discord_id: '1', display_name: 'Ana', match_id: 'm1', team_id: A, loser_games: 0 },  // exact  15
      { discord_id: '1', display_name: 'Ana', match_id: 'm2', team_id: B, loser_games: 0 },  // winner 10
      { discord_id: '1', display_name: 'Ana', match_id: 'm3', team_id: A, loser_games: 0 },  // pending
      { discord_id: '2', display_name: 'Bo', match_id: 'm1', team_id: B, loser_games: 1 },   // miss
    ],
  });

  const ana = rows.find((r) => r.discord_id === '1');
  assert.strictEqual(ana.points, 25);
  assert.strictEqual(ana.correct, 2);
  assert.strictEqual(ana.exact, 1);
  assert.strictEqual(ana.picks, 3, 'three picks made');
  assert.strictEqual(ana.settled, 2, 'two of them scored');

  const bo = rows.find((r) => r.discord_id === '2');
  assert.strictEqual(bo.points, 0);
  assert.strictEqual(bo.settled, 1);
});

test('EQUAL POINTS SHARE A RANK — 1, 2, 2, 4', () => {
  const rows = standings({
    matches: twoMatches,
    picks: [
      { discord_id: '1', display_name: 'Ana', match_id: 'm1', team_id: A, loser_games: 0 },
      { discord_id: '1', display_name: 'Ana', match_id: 'm2', team_id: B, loser_games: 1 },
      { discord_id: '2', display_name: 'Bo', match_id: 'm1', team_id: A, loser_games: 0 },
      { discord_id: '3', display_name: 'Cy', match_id: 'm1', team_id: A, loser_games: 1 },
      { discord_id: '4', display_name: 'Di', match_id: 'm1', team_id: B, loser_games: 0 },
    ],
  });

  assert.deepStrictEqual(rows.map((r) => [r.name, r.points, r.rank]), [
    ['Ana', 30, 1],
    ['Bo', 15, 2],
    ['Cy', 10, 3],
    ['Di', 0, 4],
  ]);

  // And a genuine tie really does share, rather than being split on a hidden
  // criterion nobody can see in the table.
  const tied = standings({
    matches: twoMatches,
    picks: [
      { discord_id: '1', display_name: 'Ana', match_id: 'm1', team_id: A, loser_games: 0 },
      { discord_id: '2', display_name: 'Bo', match_id: 'm1', team_id: A, loser_games: 0 },
      { discord_id: '3', display_name: 'Cy', match_id: 'm1', team_id: B, loser_games: 0 },
    ],
  });
  assert.deepStrictEqual(tied.map((r) => r.rank), [1, 1, 3]);
});

test('the champion bonus pays the right team only, and once', () => {
  const picks = [
    { discord_id: '1', display_name: 'Ana', team_id: A },
    { discord_id: '2', display_name: 'Bo', team_id: B },
  ];

  const undecided = standings({ matches: twoMatches, picks: [], championPicks: picks });
  assert.strictEqual(undecided.find((r) => r.discord_id === '1').points, 0,
    'no champion yet, no bonus');
  assert.strictEqual(undecided.find((r) => r.discord_id === '1').champion_team_id, A,
    'but the pick is still reported back');

  const decided = standings({ matches: twoMatches, picks: [], championPicks: picks, championId: A });
  assert.strictEqual(decided.find((r) => r.discord_id === '1').points, CHAMPION_POINTS);
  assert.strictEqual(decided.find((r) => r.discord_id === '1').champion_hit, true);
  assert.strictEqual(decided.find((r) => r.discord_id === '2').points, 0);
});

test('somebody with only a champion pick still appears', () => {
  const rows = standings({ matches: twoMatches, picks: [], championPicks: [
    { discord_id: '9', display_name: 'Late', team_id: A },
  ] });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].picks, 0);
});

test('the newest display name wins', () => {
  // People rename themselves on Discord. The board should say what they are
  // called now, not what they were called in week one.
  const rows = standings({
    matches: twoMatches,
    picks: [
      { discord_id: '1', display_name: 'OldName', match_id: 'm1', team_id: A, loser_games: 0 },
      { discord_id: '1', display_name: 'NewName', match_id: 'm2', team_id: B, loser_games: 1 },
    ],
  });
  assert.strictEqual(rows[0].name, 'NewName');
});

// ── Organizer-written questions ─────────────────────────────────────────────
const question = (over = {}) => ({
  id: 'q1',
  prompt: 'Does the grand final go to a reset?',
  options: [{ id: 'o1', label: 'Yes' }, { id: 'o2', label: 'No' }],
  points: 10,
  closes_at: null,
  correct_option_id: null,
  void: false,
  ...over,
});

test('a question with no closing time stays open until it is settled', () => {
  assert.strictEqual(questionWindow(question()).open, true);
  assert.strictEqual(questionWindow(question()).closesAt, null);

  const settled = question({ correct_option_id: 'o1' });
  assert.strictEqual(questionWindow(settled).open, false);
  assert.strictEqual(questionWindow(settled).done, true);
});

test('a closing time closes it, on the second', () => {
  const at = new Date('2026-09-12T19:00:00Z').toISOString();
  const q = question({ closes_at: at });
  assert.strictEqual(questionWindow(q, Date.parse(at) - 1).open, true);
  assert.strictEqual(questionWindow(q, Date.parse(at)).open, false);
  assert.match(questionWindow(q, Date.parse(at)).reason, /waiting on the answer/i);
});

test('NAMES ARE HIDDEN WHILE IT IS OPEN, shown once it is not', () => {
  // Otherwise the question is a poll people copy, and what each person actually
  // thought — the only thing being measured — is unrecoverable.
  assert.strictEqual(answersVisible(question()), false);
  assert.strictEqual(answersVisible(question({ correct_option_id: 'o2' })), true);

  const at = new Date('2026-09-12T19:00:00Z').toISOString();
  assert.strictEqual(answersVisible(question({ closes_at: at }), Date.parse(at) - 1), false);
  assert.strictEqual(answersVisible(question({ closes_at: at }), Date.parse(at) + 1), true);
});

test('an unsettled question scores nothing; a settled one pays its own points', () => {
  const answer = { question_id: 'q1', option_id: 'o1' };

  const pending = scoreAnswer(answer, question());
  assert.strictEqual(pending.settled, false);
  assert.strictEqual(pending.points, 0);

  const hit = scoreAnswer(answer, question({ correct_option_id: 'o1', points: 25 }));
  assert.strictEqual(hit.points, 25, 'the question carries its own value');
  assert.ok(hit.correct && hit.settled);

  const miss = scoreAnswer(answer, question({ correct_option_id: 'o2' }));
  assert.strictEqual(miss.points, 0);
  assert.strictEqual(miss.correct, false);
  assert.strictEqual(miss.settled, true, 'wrong is settled, not pending');
});

test('A VOIDED QUESTION PAYS NOBODY, even the option marked correct', () => {
  // The situation never arose, so there is no right answer. Voiding has to beat
  // a correct_option_id left over from before somebody changed their mind.
  const voided = question({ correct_option_id: 'o1', void: true });
  const scored = scoreAnswer({ question_id: 'q1', option_id: 'o1' }, voided);
  assert.strictEqual(scored.points, 0);
  assert.strictEqual(scored.settled, false);
});

test('question points default sensibly when none was stored', () => {
  const scored = scoreAnswer({ question_id: 'q1', option_id: 'o1' },
    question({ correct_option_id: 'o1', points: null }));
  assert.strictEqual(scored.points, QUESTION_POINTS);
});

test('what a question may not be', () => {
  const ok = { prompt: 'Who tops damage?', options: [{ label: 'A' }, { label: 'B' }], points: 10 };
  assert.strictEqual(questionProblem(ok), null);

  assert.match(questionProblem({ ...ok, prompt: '  ' }), /needs a prompt/);
  assert.match(questionProblem({ ...ok, options: [{ label: 'A' }] }), /at least 2/);
  assert.match(questionProblem({ ...ok, options: [{ label: 'A' }, { label: 'a' }] }), /same thing/);
  assert.match(questionProblem({ ...ok, points: 0 }), /between 1 and 100/);
  assert.match(questionProblem({ ...ok, points: 2.5 }), /whole number/);

  const tooMany = Array.from({ length: MAX_OPTIONS + 1 }, (_, i) => ({ label: `opt ${i}` }));
  assert.match(questionProblem({ ...ok, options: tooMany }), /is the most/);

  // Blank options are dropped, not counted — an empty row in the form is
  // somebody who stopped typing, not a third choice.
  assert.strictEqual(questionProblem({ ...ok, options: [{ label: 'A' }, { label: 'B' }, { label: '  ' }] }), null);
});

test('the answer split covers every option, including the ones nobody chose', () => {
  const q = question({ options: [{ id: 'o1', label: 'Yes' }, { id: 'o2', label: 'No' }] });
  const split = answerSplit([
    { question_id: 'q1', option_id: 'o1' },
    { question_id: 'q1', option_id: 'o1' },
    { question_id: 'q1', option_id: 'o1' },
    { question_id: 'q1', option_id: 'gone' },   // an option since removed
    { question_id: 'other', option_id: 'o2' },
  ], q);

  assert.deepStrictEqual(split.map((s) => [s.label, s.count, s.pct]), [
    ['Yes', 3, 100],
    ['No', 0, 0],
  ]);
});

test('question points land in the standings beside the match points', () => {
  const rows = standings({
    matches: twoMatches,
    picks: [{ discord_id: '1', display_name: 'Ana', match_id: 'm1', team_id: A, loser_games: 0 }],
    questions: [
      question({ id: 'q1', correct_option_id: 'o1', points: 20 }),
      question({ id: 'q2', correct_option_id: 'o2', points: 10 }),
      question({ id: 'q3' }),                              // unsettled
    ],
    answers: [
      { discord_id: '1', display_name: 'Ana', question_id: 'q1', option_id: 'o1' },  // +20
      { discord_id: '1', display_name: 'Ana', question_id: 'q2', option_id: 'o1' },  // miss
      { discord_id: '1', display_name: 'Ana', question_id: 'q3', option_id: 'o1' },  // pending
      { discord_id: '2', display_name: 'Bo', question_id: 'q2', option_id: 'o2' },   // +10
    ],
  });

  const ana = rows.find((r) => r.name === 'Ana');
  assert.strictEqual(ana.points, WINNER_POINTS + SCORELINE_BONUS + 20);
  assert.strictEqual(ana.question_points, 20);
  assert.strictEqual(ana.questions_correct, 1);
  assert.strictEqual(ana.answers, 3, 'three answered');

  // Somebody who only answered a question still appears, and is ranked on it.
  const bo = rows.find((r) => r.name === 'Bo');
  assert.strictEqual(bo.points, 10);
  assert.strictEqual(bo.picks, 0);
});

// ── The crowd bar ───────────────────────────────────────────────────────────
test('the split counts only this match, and only its two teams', () => {
  const m = match();
  const split = crowdSplit([
    { match_id: 'm1', team_id: A },
    { match_id: 'm1', team_id: A },
    { match_id: 'm1', team_id: B },
    { match_id: 'm1', team_id: 'someone-else' },  // a team that has since moved
    { match_id: 'other', team_id: A },
  ], m);

  assert.strictEqual(split.a, 2);
  assert.strictEqual(split.b, 1);
  assert.strictEqual(split.total, 3);
  assert.strictEqual(split.pct_a, 67);
  assert.strictEqual(split.pct_b, 33);
});

test('nobody has picked: percentages are null, not zero', () => {
  // A 0% / 0% bar reads as two teams nobody believes in. Null lets the page say
  // "no picks yet" instead.
  const split = crowdSplit([], match());
  assert.strictEqual(split.total, 0);
  assert.strictEqual(split.pct_a, null);
  assert.strictEqual(split.pct_b, null);
});
