// shared/predictions.cjs — the prediction game: what a pick is worth, and when
// it can still be made.
//
// Pure, like shared/bracket.cjs and for the same reason. Everything here is
// arithmetic that decides who is winning a public leaderboard, which is exactly
// the kind of thing that gets argued about on stream — so it is written once,
// used by both halves of the app, and tested with no database in the way.
//
// TWO RULES CARRY THE WHOLE FEATURE, and both are about time:
//
//   1. A pick can be changed freely until the match starts, and not at all
//      afterwards. `pickWindow` is the only place that decides this, so the
//      button the browser draws and the check the server makes cannot disagree
//      — and only the server's answer is load-bearing.
//   2. A pick is scored only once the series is DECIDED. A match in progress
//      contributes nothing to anybody's total, so the standings never move
//      backwards when a game 3 turns a 2-0 into a 2-1.
const { toWin } = require('./series.cjs');

// ── What a pick is worth ────────────────────────────────────────────────────
// Flat, deliberately. Weighting later rounds heavier is tempting and it makes
// the game harder to explain — "ten for the winner, five more for the exact
// scoreline" fits in one line of stream chat, and a scoring table with round
// multipliers does not.
//
// The champion pick is worth two and a half matches: enough that somebody who
// called it in week one is still in the conversation, not so much that the
// per-match game stops mattering.
const WINNER_POINTS = 10;
const SCORELINE_BONUS = 5;
const CHAMPION_POINTS = 25;

/** The most one match can be worth. */
const MATCH_MAX = WINNER_POINTS + SCORELINE_BONUS;

/**
 * How many games the losing side may be predicted to take.
 *
 * Best of three → 0 or 1, which is the 2-0 / 2-1 choice on screen. Written as
 * arithmetic on best_of rather than as the literal [0, 1] so a best-of-five
 * grand final does not need a second code path.
 */
const loserGameOptions = (bestOf) => {
  const need = toWin(bestOf);
  return Array.from({ length: need }, (_, i) => i);
};

/** "2 — 1", from the winner's point of view. */
const scorelineLabel = (bestOf, loserGames) => `${toWin(bestOf)} — ${loserGames}`;

/**
 * Is this a pick the rules allow? Returns a sentence, or null.
 *
 * The scoreline is checked against the match's own best_of, not against a
 * constant: predicting 2-2 is nonsense, and so is predicting 3-1 in a best of
 * three, but a best of five can be won 3-2 and must not be refused.
 */
function pickProblem({ teamId, loserGames, match }) {
  if (!teamId) return 'Pick a team.';
  if (teamId !== match?.team_a_id && teamId !== match?.team_b_id) {
    return 'That team is not in this match.';
  }
  // Checked for ABSENCE before it is converted. Number(null) and Number('') are
  // both 0, so a form that never asked the question, or asked and got no
  // answer, would arrive here looking exactly like a deliberate 2-0 — and be
  // scored as one.
  if (loserGames === null || loserGames === undefined || loserGames === '') {
    return 'Pick a scoreline.';
  }
  const n = Number(loserGames);
  if (!Number.isInteger(n) || n < 0) return 'Pick a scoreline.';
  if (n >= toWin(match?.best_of)) {
    return `A best of ${match?.best_of} cannot end ${toWin(match?.best_of)} — ${n}.`;
  }
  return null;
}

// ── When a pick can be made ─────────────────────────────────────────────────
/**
 * Whether this match is still open for predictions, and if not, why.
 *
 * THE REASON IS PART OF THE ANSWER. "Closed" on its own reads as a bug to
 * somebody who was about to pick; "the series has already started" reads as a
 * rule. Every branch returns one.
 *
 * Locked by whichever comes first: the scheduled kickoff, or the first game
 * actually being recorded. Both are needed. A match that starts late must not
 * accept picks after the first game has been played, and a match nobody has
 * entered a game for yet must still lock at the time it was advertised to
 * start — otherwise the picks arriving during the broadcast are being made by
 * people who can see the first fight.
 *
 * @param match a bracket match with `series` attached (bracketState does this)
 * @param now   epoch ms, injectable so this is testable and so the page and the
 *              server can be handed the same instant
 */
function pickWindow(match, now = Date.now()) {
  if (!match) return { open: false, reason: 'No such match.' };

  // A bye is not an event. Nobody plays it and its winner was decided by the
  // draw, so offering a pick on it would be offering free points.
  if (match.kind !== 'match') {
    return { open: false, reason: 'A bye — there is nothing to predict.' };
  }

  // The reset match exists in the skeleton from the moment the bracket is
  // drawn, but only becomes a fixture if the losers bracket forces it.
  if (!match.team_a_id || !match.team_b_id) {
    return { open: false, reason: 'Waiting on both teams.', pending: true };
  }

  if (match.status === 'complete') return { open: false, reason: 'Already played.' };

  // ANY game row closes it, not just a game with a winner.
  //
  // The map for game 1 is normally entered before that game is played — the
  // organizer route accepts a map with no winner precisely so it can be. If the
  // lock waited for a recorded winner, an unscheduled match would stay open
  // through the whole of game 1, and the picks arriving during it would be
  // made by people watching the fight.
  const played = Number(match.series?.played) || 0;
  const started = (match.games?.length || 0) > 0;
  if (played > 0 || started) return { open: false, reason: 'The series has started.' };

  if (match.scheduled_at) {
    const kickoff = new Date(match.scheduled_at).getTime();
    if (Number.isFinite(kickoff) && now >= kickoff) {
      return { open: false, reason: 'Kickoff has passed.' };
    }
    return { open: true, closesAt: match.scheduled_at };
  }

  // No scheduled time is the common case for a match whose teams have only just
  // been decided. It stays open until somebody records a game.
  return { open: true, closesAt: null };
}

/**
 * The champion pick's window.
 *
 * Open until the FIRST GAME OF THE TOURNAMENT is recorded — not until the
 * bracket is drawn. Locking at the draw would leave a window of minutes
 * between the draft finishing and an organizer clicking generate, which is no
 * window at all for anybody who is not already watching.
 *
 * It does need teams to exist: picking a champion out of an empty tournament is
 * not a thing to offer.
 */
function championWindow({ teamCount = 0, matches = [] } = {}) {
  if (teamCount < 2) return { open: false, reason: 'No teams yet.' };

  // The same test as one match's lock, applied to the whole draw: a game row
  // exists, a game has been won, or a match is finished. Byes are excluded —
  // they complete at generation, and counting one would shut the champion
  // window before it ever opened.
  const started = matches.some((m) => m.kind === 'match'
    && ((Number(m.series?.played) || 0) > 0
      || (m.games?.length || 0) > 0
      || m.status === 'complete'));
  if (started) {
    return { open: false, reason: 'The tournament has started — champion picks locked at the first game.' };
  }

  return { open: true };
}

// ── What a pick turned out to be worth ──────────────────────────────────────
/**
 * Score one prediction against the match it was made on.
 *
 * `settled` is the important field, and it is not the same as "the match has a
 * winner": a match still being played scores nothing at all rather than scoring
 * zero, so the standings distinguish "wrong" from "not yet".
 */
function scorePick(pick, match) {
  const out = {
    settled: false, points: 0, correct: false, exact: false,
    actual: null, predicted: null,
  };
  if (!pick || !match) return out;

  const series = match.series || {};
  // A walkover has a winner and no games. Nobody could have predicted it and
  // nobody picked it — pickWindow refuses — but a pick that exists from before
  // a bye was resolved must not quietly pay out.
  if (match.kind !== 'match' || !series.decided || !series.winnerId) return out;

  const loserGames = Math.min(series.winsA, series.winsB);
  out.settled = true;
  out.actual = { winner_team_id: series.winnerId, loser_games: loserGames };
  out.predicted = { winner_team_id: pick.team_id, loser_games: Number(pick.loser_games) };

  if (pick.team_id !== series.winnerId) return out;

  out.correct = true;
  out.points = WINNER_POINTS;

  if (Number(pick.loser_games) === loserGames) {
    out.exact = true;
    out.points += SCORELINE_BONUS;
  }

  return out;
}

// ── Questions an organizer writes ───────────────────────────────────────────
// The match picks are the same question over and over; these are whatever else
// is worth asking. "Does the grand final go to a reset?", "Which team tops the
// damage chart?", "How many games does the final run?"
//
// MULTIPLE CHOICE, always. A free-text answer has to be graded by hand and
// argued about — "HAM" against "The Hamstars" against "hamstars" are one answer
// typed three ways, and somebody has to decide that at midnight. A fixed set of
// options makes the scoring mechanical, which is the only way "who got it
// right" is a fact rather than an opinion.
const QUESTION_POINTS = 10;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 8;

/** Is this question still open, and if not, why? */
function questionWindow(q, now = Date.now()) {
  if (!q) return { open: false, reason: 'No such question.' };
  if (q.void) return { open: false, reason: 'Voided — nobody scores this one.', done: true };
  if (q.correct_option_id) return { open: false, reason: 'Settled.', done: true };

  if (q.closes_at) {
    const at = new Date(q.closes_at).getTime();
    if (Number.isFinite(at) && now >= at) {
      return { open: false, reason: 'Closed — waiting on the answer.' };
    }
    return { open: true, closesAt: q.closes_at };
  }

  // No closing time: open until an organizer settles it. That is the right
  // default for a question whose moment is not on a schedule — "does the reset
  // happen" closes when somebody answers it, not at eight o'clock.
  return { open: true, closesAt: null };
}

/**
 * Whether the names on a question may be shown.
 *
 * Counts while it is open, names once it is not. Revealing who picked what
 * while picking is still allowed would turn every question into a poll people
 * copy — and the whole point is what each person thought.
 */
const answersVisible = (q, now = Date.now()) => !questionWindow(q, now).open;

/** Score one answer. Unsettled scores nothing rather than scoring zero. */
function scoreAnswer(answer, question) {
  const out = { settled: false, points: 0, correct: false };
  if (!answer || !question || question.void) return out;
  if (!question.correct_option_id) return out;

  out.settled = true;
  if (answer.option_id === question.correct_option_id) {
    out.correct = true;
    // A stored value of null must not read as a question worth nothing.
    // Number(null) is 0 and 0 is finite, so "is it a number" is the wrong
    // test — questionProblem refuses anything below 1, so a zero here is
    // always an absence rather than somebody's choice.
    const stored = Number(question.points);
    out.points = Number.isInteger(stored) && stored > 0 ? stored : QUESTION_POINTS;
  }
  return out;
}

/** How the room answered — counts per option, plus percentages. */
function answerSplit(answers, question) {
  const counts = new Map((question?.options || []).map((o) => [o.id, 0]));
  let total = 0;
  for (const a of answers) {
    if (a.question_id !== question?.id) continue;
    if (!counts.has(a.option_id)) continue;   // an option that has since been removed
    counts.set(a.option_id, counts.get(a.option_id) + 1);
    total += 1;
  }
  return (question?.options || []).map((o) => ({
    option_id: o.id,
    label: o.label,
    count: counts.get(o.id) || 0,
    pct: total ? Math.round((counts.get(o.id) / total) * 100) : null,
  }));
}

/**
 * What is wrong with a question an organizer is writing, in words, or null.
 *
 * Option IDS are not checked here — they are assigned by the server, so that
 * relabelling an option cannot silently orphan the answers already given to it.
 */
function questionProblem({ prompt, options, points }) {
  const text = String(prompt || '').trim();
  if (!text) return 'A question needs a prompt.';
  if (text.length > 200) return 'That prompt is too long — keep it under 200 characters.';

  const list = Array.isArray(options) ? options : [];
  const labels = list.map((o) => String(o?.label ?? '').trim()).filter(Boolean);
  if (labels.length < MIN_OPTIONS) return `Give it at least ${MIN_OPTIONS} options.`;
  if (labels.length > MAX_OPTIONS) return `${MAX_OPTIONS} options is the most a question can have.`;
  if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) {
    return 'Two options say the same thing.';
  }
  if (labels.some((l) => l.length > 60)) return 'An option label is too long.';

  if (points !== undefined && points !== null && points !== '') {
    const n = Number(points);
    if (!Number.isInteger(n) || n < 1 || n > 100) return 'Points must be a whole number between 1 and 100.';
  }

  return null;
}

// ── The standings ───────────────────────────────────────────────────────────
/**
 * Everybody's total, in order.
 *
 * Ties share a rank, on POINTS alone. The sort has tiebreakers under it so the
 * table has a stable order, but two people on 45 points are both 3rd — ranking
 * one of them above the other on a hidden criterion is the kind of thing that
 * gets noticed on a stream and defended badly.
 *
 * @param picks         [{ discord_id, display_name, match_id, team_id, loser_games }]
 * @param matches       bracket matches with `series` attached
 * @param championPicks [{ discord_id, display_name, team_id }]
 * @param championId    the tournament's champion, once there is one
 * @param questions     organizer-written questions, with their options and answer
 * @param answers       [{ discord_id, display_name, question_id, option_id }]
 */
function standings({
  picks = [], matches = [], championPicks = [], championId = null,
  questions = [], answers = [],
} = {}) {
  const byMatch = new Map(matches.map((m) => [m.id, m]));
  const byQuestion = new Map(questions.map((q) => [q.id, q]));
  const people = new Map();

  const person = (discordId, name) => {
    if (!people.has(discordId)) {
      people.set(discordId, {
        discord_id: discordId,
        name: name || 'Someone',
        points: 0, correct: 0, exact: 0, settled: 0, picks: 0,
        champion_team_id: null, champion_hit: false, champion_points: 0,
        answers: 0, questions_correct: 0, question_points: 0,
      });
    }
    const row = people.get(discordId);
    // The most recent name wins — people rename themselves on Discord, and the
    // leaderboard should show what they are called now, not what they were
    // called the first time they picked.
    if (name) row.name = name;
    return row;
  };

  for (const p of picks) {
    const row = person(p.discord_id, p.display_name);
    row.picks += 1;
    const scored = scorePick(p, byMatch.get(p.match_id));
    if (!scored.settled) continue;
    row.settled += 1;
    row.points += scored.points;
    if (scored.correct) row.correct += 1;
    if (scored.exact) row.exact += 1;
  }

  for (const a of answers) {
    const row = person(a.discord_id, a.display_name);
    row.answers += 1;
    const scored = scoreAnswer(a, byQuestion.get(a.question_id));
    if (!scored.settled) continue;
    row.points += scored.points;
    row.question_points += scored.points;
    if (scored.correct) row.questions_correct += 1;
  }

  for (const c of championPicks) {
    const row = person(c.discord_id, c.display_name);
    row.champion_team_id = c.team_id;
    if (championId && c.team_id === championId) {
      row.champion_hit = true;
      row.champion_points = CHAMPION_POINTS;
      row.points += CHAMPION_POINTS;
    }
  }

  const rows = [...people.values()].sort((x, y) => (
    y.points - x.points
    || y.exact - x.exact
    || y.correct - x.correct
    || x.name.localeCompare(y.name)
  ));

  // Competition ranking: 1, 2, 2, 4. Equal points, equal rank.
  let rank = 0;
  let seen = 0;
  let last = null;
  for (const row of rows) {
    seen += 1;
    if (row.points !== last) { rank = seen; last = row.points; }
    row.rank = rank;
  }

  return rows;
}

/**
 * How the room is split on one match.
 *
 * Counts only — no names. This is the number that goes on the broadcast, where
 * there is no session and no way for anyone to consent to being named.
 */
function crowdSplit(picks, match) {
  let a = 0;
  let b = 0;
  for (const p of picks) {
    if (p.match_id !== match?.id) continue;
    if (p.team_id === match.team_a_id) a += 1;
    else if (p.team_id === match.team_b_id) b += 1;
  }
  return splitFromCounts(a, b);
}

/**
 * The same bar, from two counts somebody else has already totalled.
 *
 * The broadcast route counts in the database rather than reading every pick
 * back to count them in JavaScript. It still has to draw the identical bar, so
 * the percentage arithmetic lives here once instead of being repeated there.
 */
function splitFromCounts(a = 0, b = 0) {
  const total = a + b;
  return {
    a,
    b,
    total,
    // Rounded for display, and only when there is anybody to divide by. A
    // "0%–0%" bar on an unpicked match reads as two teams nobody believes in
    // rather than as no data.
    pct_a: total ? Math.round((a / total) * 100) : null,
    pct_b: total ? Math.round((b / total) * 100) : null,
  };
}

module.exports = {
  WINNER_POINTS, SCORELINE_BONUS, CHAMPION_POINTS, MATCH_MAX,
  QUESTION_POINTS, MIN_OPTIONS, MAX_OPTIONS,
  loserGameOptions, scorelineLabel, pickProblem,
  pickWindow, championWindow, questionWindow, answersVisible,
  scorePick, scoreAnswer, questionProblem, answerSplit,
  standings, crowdSplit, splitFromCounts,
};
