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
 */
function standings({ picks = [], matches = [], championPicks = [], championId = null } = {}) {
  const byMatch = new Map(matches.map((m) => [m.id, m]));
  const people = new Map();

  const person = (discordId, name) => {
    if (!people.has(discordId)) {
      people.set(discordId, {
        discord_id: discordId,
        name: name || 'Someone',
        points: 0, correct: 0, exact: 0, settled: 0, picks: 0,
        champion_team_id: null, champion_hit: false, champion_points: 0,
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
  loserGameOptions, scorelineLabel, pickProblem,
  pickWindow, championWindow,
  scorePick, standings, crowdSplit, splitFromCounts,
};
