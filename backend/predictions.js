// backend/predictions.js — the prediction game, persisted.
//
// Thin, like bracket.js and for the same reason: every rule about what a pick
// is worth and when it can be made lives in shared/predictions.cjs, which is
// pure and tested. This file reads rows, hands them to those functions, and
// writes back what they say.
//
// THE SERVER'S WINDOW CHECK IS THE ONLY ONE THAT COUNTS. The page hides the
// buttons on a locked match, but that decides what a browser draws and nothing
// else — anybody can post to this route. Every write re-reads the bracket and
// asks pickWindow again, against the state as it is now.
const express = require('express');
const { supabase, currentTournament, audit } = require('./db');
const { fetchAll } = require('./pagedRead');
const { bracketState } = require('./bracket');
const {
  pickWindow, championWindow, pickProblem, scorePick, standings, crowdSplit,
  loserGameOptions, WINNER_POINTS, SCORELINE_BONUS, CHAMPION_POINTS,
  questionWindow, answersVisible, scoreAnswer, questionProblem, answerSplit,
  QUESTION_POINTS, MAX_OPTIONS,
} = require('../shared/predictions.cjs');

// The tables arrive with migration 016. Until it has been run every route here
// fails on the same error, and saying which file to run beats "could not save".
const missingTable = (error) => /schema cache|does not exist|relation/i.test(error?.message || '');
const NEEDS_MIGRATION = {
  error: 'The prediction tables are missing — run migrations/016_predictions.sql in the Supabase SQL editor.',
};
const NEEDS_QUESTIONS = {
  error: 'The question tables are missing — run migrations/017_prediction_questions.sql in the Supabase SQL editor.',
};

// Which migration is actually missing. The reads that fail here span two of
// them, and telling somebody to run 016 when 016 is already run and 017 is not
// sends them to check the wrong thing — PostgREST names the table it could not
// find, so use it.
const missingHint = (err) => (
  /prediction_questions|question_answers/.test(err?.message || '') ? NEEDS_QUESTIONS : NEEDS_MIGRATION
);

const PICK_COLS = 'id, match_id, discord_id, display_name, team_id, loser_games, created_at, updated_at';
const CHAMP_COLS = 'id, discord_id, display_name, team_id, created_at, updated_at';
const QUESTION_COLS = 'id, prompt, options, points, closes_at, correct_option_id, void, created_at, updated_at';
const ANSWER_COLS = 'id, question_id, discord_id, display_name, option_id, created_at, updated_at';

// Both of these grow with (people x matches) and neither has a natural bound,
// which is exactly the shape PostgREST silently truncates at 1,000 rows. Paged,
// ordered by id — a unique tiebreaker, as pagedRead.js insists on.
const readPicks = (tournamentId) => fetchAll(
  () => supabase.from('predictions').select(PICK_COLS)
    .eq('tournament_id', tournamentId).order('id', { ascending: true }),
  { label: 'predictions' },
);

const readChampionPicks = (tournamentId) => fetchAll(
  () => supabase.from('champion_picks').select(CHAMP_COLS)
    .eq('tournament_id', tournamentId).order('id', { ascending: true }),
  { label: 'champion picks' },
);

// Questions are written by hand and there will never be many, but the answers
// to them grow exactly like the picks do.
const readQuestions = (tournamentId) => fetchAll(
  () => supabase.from('prediction_questions').select(QUESTION_COLS)
    .eq('tournament_id', tournamentId).order('created_at', { ascending: true }).order('id'),
  { label: 'questions' },
);

const readAnswers = (tournamentId) => fetchAll(
  () => supabase.from('question_answers').select(ANSWER_COLS)
    .eq('tournament_id', tournamentId).order('id', { ascending: true }),
  { label: 'answers' },
);

/**
 * Stable option ids.
 *
 * Relabelling an option must not orphan the answers already given to it, so an
 * option that arrives carrying an id it already had keeps it, and only genuinely
 * new ones are numbered. Ids are never reused — `o3` deleted and a new option
 * added becomes `o4`, so an old answer can never be silently re-pointed at
 * somebody else's choice.
 */
function mergeOptions(existing = [], incoming = []) {
  const known = new Set((existing || []).map((o) => o.id));
  // Blank rows are dropped BEFORE ids are handed out — an empty box in the form
  // is somebody who stopped typing, not a third choice, and it must not consume
  // a number.
  const rows = (incoming || [])
    .map((o) => ({ id: o?.id, label: String(o?.label ?? '').trim() }))
    .filter((o) => o.label);

  let n = Math.max(0, ...[...known].map((id) => Number(String(id).replace(/^o/, '')) || 0));
  return rows.map((o) => {
    if (o.id && known.has(o.id)) return { id: o.id, label: o.label };
    n += 1;
    const id = `o${n}`;
    known.add(id);
    return { id, label: o.label };
  });
}

const slimTeam = (t) => (t ? { id: t.id, name: t.name, tag: t.tag, seed: t.seed } : null);

/** One match, as the predictions page wants it. */
function matchView(m, { picks, mine, now }) {
  const pick = mine.get(m.id) || null;
  return {
    id: m.id,
    key: m.key,
    label: m.label,
    bracket: m.bracket,
    round: m.round,
    best_of: m.best_of,
    status: m.status,
    scheduled_at: m.scheduled_at,
    is_reset: m.is_reset,
    team_a: slimTeam(m.team_a),
    team_b: slimTeam(m.team_b),
    // Only the numbers, not the games: who won which map is the bracket's
    // business and this page has no use for it.
    series: {
      winsA: m.series?.winsA ?? 0,
      winsB: m.series?.winsB ?? 0,
      decided: !!m.series?.decided,
      winner_team_id: m.series?.winnerId || null,
    },
    window: pickWindow(m, now),
    // Counts only. Names never travel with a split — see the note on the cast
    // route in bracket.js.
    crowd: crowdSplit(picks, m),
    options: loserGameOptions(m.best_of),
    mine: pick
      ? { team_id: pick.team_id, loser_games: pick.loser_games, ...scorePick(pick, m) }
      : null,
  };
}

/**
 * One question, as the page wants it.
 *
 * The SPLIT travels always — counts are counts, and the same reasoning as the
 * crowd bar on a match. NAMES never travel here: they come from the question's
 * own route, and only once answering has closed.
 */
function questionView(q, { answers, mine, now }) {
  const answer = mine.get(q.id) || null;
  const scored = answer ? scoreAnswer(answer, q) : null;
  const forThis = answers.filter((a) => a.question_id === q.id);

  return {
    id: q.id,
    prompt: q.prompt,
    options: q.options || [],
    points: q.points,
    closes_at: q.closes_at,
    correct_option_id: q.correct_option_id,
    void: q.void,
    window: questionWindow(q, now),
    split: answerSplit(answers, q),
    answered: forThis.length,
    // "Who got it right" is a real question with a real answer, so the count
    // is here even before anybody opens the breakdown.
    right: q.correct_option_id && !q.void
      ? forThis.filter((a) => a.option_id === q.correct_option_id).length
      : null,
    reveal: answersVisible(q, now),
    mine: answer ? { option_id: answer.option_id, ...scored } : null,
  };
}

/**
 * Everything the page needs, in one read.
 *
 * Assembled here rather than in three routes because every part of it depends
 * on the same snapshot: a crowd split taken a second after the standings would
 * describe a slightly different tournament, and the page would show two
 * numbers that disagree for no reason anybody could work out.
 */
async function overview(tournamentId, me) {
  const [state, picks, champs, questions, answers] = await Promise.all([
    bracketState(tournamentId),
    readPicks(tournamentId),
    readChampionPicks(tournamentId),
    readQuestions(tournamentId),
    readAnswers(tournamentId),
  ]);

  const now = Date.now();
  const mine = new Map(picks.filter((p) => p.discord_id === me).map((p) => [p.match_id, p]));
  const myAnswers = new Map(answers.filter((a) => a.discord_id === me).map((a) => [a.question_id, a]));

  // Byes are filtered out: pickWindow refuses them anyway, and a card saying
  // "there is nothing to predict" is noise on a page that is a list of things
  // to predict.
  const matches = state.matches
    .filter((m) => m.kind === 'match')
    .map((m) => matchView(m, { picks, mine, now }));

  const table = standings({
    picks,
    matches: state.matches,
    championPicks: champs,
    championId: state.champion?.id || null,
    questions,
    answers,
  });

  const champWindow = championWindow({ teamCount: state.teams.length, matches: state.matches });
  const myChampion = champs.find((c) => c.discord_id === me) || null;

  // How the room called the whole tournament. Counts per team, again with no
  // names attached.
  const championCrowd = state.teams.map((t) => ({
    team_id: t.id,
    count: champs.filter((c) => c.team_id === t.id).length,
  })).filter((x) => x.count > 0);

  return {
    matches,
    questions: questions.map((q) => questionView(q, { answers, mine: myAnswers, now })),
    teams: state.teams.map(slimTeam),
    champion: {
      window: champWindow,
      mine: myChampion ? { team_id: myChampion.team_id } : null,
      crowd: championCrowd,
      // Once there is one. Until then the bonus is unpaid and the page says so.
      decided: state.champion ? slimTeam(state.champion) : null,
      points: CHAMPION_POINTS,
    },
    me: table.find((r) => r.discord_id === me) || null,
    players: table.length,
    scoring: {
      winner: WINNER_POINTS, scoreline: SCORELINE_BONUS,
      champion: CHAMPION_POINTS, question: QUESTION_POINTS,
    },
  };
}

// ── Read and write: anyone with a session ───────────────────────────────────
// Deliberately not restricted to players. The point of this is the people
// watching, and most of them will never appear on a roster.
const router = express.Router();

router.get('/', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.json({ tournament: null, matches: [], teams: [] });

  try {
    const out = await overview(t.id, req.user.id);
    res.json({ tournament: { name: t.name, status: t.status }, ...out });
  } catch (err) {
    if (missingTable(err)) return res.status(503).json(missingHint(err));
    console.error('predictions read failed:', err.message);
    res.status(500).json({ error: 'Could not load the predictions.' });
  }
});

/** The full table. Its own route because the page loads it on a tab. */
router.get('/standings', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.json({ rows: [], me: null });

  try {
    const [state, picks, champs, questions, answers] = await Promise.all([
      bracketState(t.id), readPicks(t.id), readChampionPicks(t.id),
      readQuestions(t.id), readAnswers(t.id),
    ]);
    const rows = standings({
      picks, matches: state.matches, championPicks: champs,
      championId: state.champion?.id || null, questions, answers,
    });

    // The Discord id identifies a person and is not needed to draw a table; the
    // only one that travels is the reader's own, so the page can highlight
    // their row.
    const me = req.user.id;
    res.json({
      rows: rows.map(({ discord_id, ...r }) => ({ ...r, is_me: discord_id === me })),
      me: rows.find((r) => r.discord_id === me) ? rows.find((r) => r.discord_id === me).rank : null,
      champion: state.champion ? slimTeam(state.champion) : null,
    });
  } catch (err) {
    if (missingTable(err)) return res.status(503).json(missingHint(err));
    console.error('standings failed:', err.message);
    res.status(500).json({ error: 'Could not load the standings.' });
  }
});

/**
 * Make or change a pick.
 *
 * An upsert, so changing your mind rewrites the row you already have rather
 * than adding a second one — the unique index would refuse the second anyway,
 * and this way the refusal never has to be explained to anybody.
 */
router.put('/match', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const key = String(req.body?.key || '');
  if (!key) return res.status(400).json({ error: 'Which match?' });

  try {
    const state = await bracketState(t.id);
    const m = state.matches.find((x) => x.key === key);
    if (!m) return res.status(404).json({ error: 'No such match.' });

    const window = pickWindow(m, Date.now());
    if (!window.open) {
      return res.status(409).json({ error: `Predictions are closed on this match. ${window.reason}` });
    }

    const teamId = req.body?.team_id || null;
    const problem = pickProblem({ teamId, loserGames: req.body?.loser_games, match: m });
    if (problem) return res.status(400).json({ error: problem });

    const { error } = await supabase.from('predictions').upsert({
      tournament_id: t.id,
      match_id: m.id,
      discord_id: req.user.id,
      display_name: String(req.user.username || 'Someone').slice(0, 60),
      team_id: teamId,
      loser_games: Number(req.body.loser_games),
    }, { onConflict: 'match_id,discord_id' });

    if (error) {
      if (missingTable(error)) return res.status(503).json(NEEDS_MIGRATION);
      console.error('prediction save failed:', error.message);
      return res.status(500).json({ error: 'Could not save that pick.' });
    }

    res.json({ ok: true, ...(await overview(t.id, req.user.id)) });
  } catch (err) {
    if (missingTable(err)) return res.status(503).json(NEEDS_MIGRATION);
    console.error('prediction save failed:', err.message);
    res.status(500).json({ error: 'Could not save that pick.' });
  }
});

/**
 * Take a pick back.
 *
 * Only while the window is open — the same rule as changing one. A pick that
 * could be withdrawn after kickoff would be a pick nobody could ever be wrong
 * about.
 */
router.delete('/match', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const key = String(req.body?.key || '');
  try {
    const state = await bracketState(t.id);
    const m = state.matches.find((x) => x.key === key);
    if (!m) return res.status(404).json({ error: 'No such match.' });

    const window = pickWindow(m, Date.now());
    if (!window.open) {
      return res.status(409).json({ error: `Predictions are closed on this match. ${window.reason}` });
    }

    const { error } = await supabase.from('predictions').delete()
      .eq('match_id', m.id).eq('discord_id', req.user.id);
    if (error) {
      if (missingTable(error)) return res.status(503).json(NEEDS_MIGRATION);
      return res.status(500).json({ error: 'Could not remove that pick.' });
    }

    res.json({ ok: true, ...(await overview(t.id, req.user.id)) });
  } catch (err) {
    if (missingTable(err)) return res.status(503).json(NEEDS_MIGRATION);
    res.status(500).json({ error: 'Could not remove that pick.' });
  }
});

/**
 * Answer a question.
 *
 * Same shape as a match pick, same rule: changeable until it closes, refused
 * after. The window is re-read from the database on every write, because the
 * page's copy of it can be minutes old.
 */
router.put('/answer', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const id = String(req.body?.question_id || '');
  const optionId = String(req.body?.option_id || '');
  if (!id || !optionId) return res.status(400).json({ error: 'Send a question and an option.' });

  try {
    const { data: q, error } = await supabase.from('prediction_questions')
      .select(QUESTION_COLS).eq('tournament_id', t.id).eq('id', id).maybeSingle();
    if (error && missingTable(error)) return res.status(503).json(NEEDS_QUESTIONS);
    if (!q) return res.status(404).json({ error: 'No such question.' });

    const window = questionWindow(q, Date.now());
    if (!window.open) return res.status(409).json({ error: `That question is closed. ${window.reason}` });

    if (!(q.options || []).some((o) => o.id === optionId)) {
      return res.status(400).json({ error: 'That is not one of the options.' });
    }

    const { error: writeErr } = await supabase.from('question_answers').upsert({
      tournament_id: t.id,
      question_id: q.id,
      discord_id: req.user.id,
      display_name: String(req.user.username || 'Someone').slice(0, 60),
      option_id: optionId,
    }, { onConflict: 'question_id,discord_id' });

    if (writeErr) {
      if (missingTable(writeErr)) return res.status(503).json(NEEDS_QUESTIONS);
      console.error('answer save failed:', writeErr.message);
      return res.status(500).json({ error: 'Could not save that answer.' });
    }

    res.json({ ok: true, ...(await overview(t.id, req.user.id)) });
  } catch (err) {
    if (missingTable(err)) return res.status(503).json(NEEDS_QUESTIONS);
    console.error('answer save failed:', err.message);
    res.status(500).json({ error: 'Could not save that answer.' });
  }
});

/**
 * WHO ANSWERED WHAT — the breakdown behind one question.
 *
 * Refused while the question is still open. Names are the whole substance of
 * this route, and handing them out mid-question turns the question into a poll
 * people copy — which destroys the only thing being measured.
 */
router.get('/question/:id/answers', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(404).json({ error: 'No tournament is running.' });

  try {
    const { data: q } = await supabase.from('prediction_questions')
      .select(QUESTION_COLS).eq('tournament_id', t.id).eq('id', req.params.id).maybeSingle();
    if (!q) return res.status(404).json({ error: 'No such question.' });

    if (!answersVisible(q, Date.now())) {
      return res.status(409).json({ error: 'Still open — who picked what is shown once it closes.' });
    }

    const answers = await fetchAll(
      () => supabase.from('question_answers').select(ANSWER_COLS)
        .eq('question_id', q.id).order('id', { ascending: true }),
      { label: 'answers' },
    );

    const labels = new Map((q.options || []).map((o) => [o.id, o.label]));
    res.json({
      question: { id: q.id, prompt: q.prompt, correct_option_id: q.correct_option_id, void: q.void, points: q.points },
      split: answerSplit(answers, q),
      // Right answers first: this route exists to answer "who got it right".
      // The Discord id never travels — a display name is what a leaderboard
      // needs, and the id identifies an account.
      rows: answers
        .map((a) => ({
          name: a.display_name,
          option_id: a.option_id,
          option: labels.get(a.option_id) || '—',
          correct: !!q.correct_option_id && !q.void && a.option_id === q.correct_option_id,
          is_me: a.discord_id === req.user.id,
        }))
        .sort((x, y) => (y.correct - x.correct) || x.name.localeCompare(y.name)),
    });
  } catch (err) {
    if (missingTable(err)) return res.status(503).json(NEEDS_QUESTIONS);
    res.status(500).json({ error: 'Could not read that question.' });
  }
});

/**
 * WHO PICKED WHAT on one match — the same idea, for the bracket picks.
 *
 * Also refused until the match is locked, and for the same reason.
 */
router.get('/match/:key/picks', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(404).json({ error: 'No tournament is running.' });

  try {
    const state = await bracketState(t.id);
    const m = state.matches.find((x) => x.key === req.params.key);
    if (!m) return res.status(404).json({ error: 'No such match.' });

    if (pickWindow(m, Date.now()).open) {
      return res.status(409).json({ error: 'Still open — who picked what is shown once it locks.' });
    }

    const picks = await fetchAll(
      () => supabase.from('predictions').select(PICK_COLS)
        .eq('match_id', m.id).order('id', { ascending: true }),
      { label: 'predictions' },
    );

    res.json({
      match: { key: m.key, label: m.label, team_a: slimTeam(m.team_a), team_b: slimTeam(m.team_b) },
      rows: picks.map((p) => {
        const scored = scorePick(p, m);
        return {
          name: p.display_name,
          team_id: p.team_id,
          loser_games: p.loser_games,
          ...scored,
          is_me: p.discord_id === req.user.id,
        };
      }).sort((x, y) => (y.points - x.points) || x.name.localeCompare(y.name)),
    });
  } catch (err) {
    if (missingTable(err)) return res.status(503).json(NEEDS_MIGRATION);
    res.status(500).json({ error: 'Could not read those picks.' });
  }
});

/** The champion pick — one per person, locked at the tournament's first game. */
router.put('/champion', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  try {
    const state = await bracketState(t.id);
    const window = championWindow({ teamCount: state.teams.length, matches: state.matches });
    if (!window.open) {
      return res.status(409).json({ error: `Champion picks are closed. ${window.reason}` });
    }

    const teamId = req.body?.team_id || null;
    if (!state.teams.some((x) => x.id === teamId)) {
      return res.status(400).json({ error: 'That team is not in this tournament.' });
    }

    const { error } = await supabase.from('champion_picks').upsert({
      tournament_id: t.id,
      discord_id: req.user.id,
      display_name: String(req.user.username || 'Someone').slice(0, 60),
      team_id: teamId,
    }, { onConflict: 'tournament_id,discord_id' });

    if (error) {
      if (missingTable(error)) return res.status(503).json(NEEDS_MIGRATION);
      console.error('champion pick failed:', error.message);
      return res.status(500).json({ error: 'Could not save that pick.' });
    }

    res.json({ ok: true, ...(await overview(t.id, req.user.id)) });
  } catch (err) {
    if (missingTable(err)) return res.status(503).json(NEEDS_MIGRATION);
    res.status(500).json({ error: 'Could not save that pick.' });
  }
});

// ── Organizer: writing the questions and settling them ──────────────────────
const organizerRouter = express.Router();

/** Write a new question. */
organizerRouter.post('/question', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const problem = questionProblem(req.body || {});
  if (problem) return res.status(400).json({ error: problem });

  const options = mergeOptions([], req.body.options);
  const { data, error } = await supabase.from('prediction_questions').insert({
    tournament_id: t.id,
    prompt: String(req.body.prompt).trim().slice(0, 200),
    options,
    points: Number(req.body.points) || QUESTION_POINTS,
    closes_at: req.body.closes_at || null,
    created_by: req.user?.username || null,
  }).select(QUESTION_COLS).single();

  if (error) {
    if (missingTable(error)) return res.status(503).json(NEEDS_QUESTIONS);
    console.error('question create failed:', error.message);
    return res.status(500).json({ error: 'Could not save that question.' });
  }

  await audit(req.user, 'predictions.question.add', data.id,
    { prompt: data.prompt, options: options.length, points: data.points });
  res.json({ ok: true, question: data, ...(await overview(t.id, req.user.id)) });
});

/**
 * Change one.
 *
 * AN OPTION SOMEBODY HAS ALREADY CHOSEN CANNOT BE REMOVED. Deleting it would
 * leave those answers pointing at nothing: they would silently stop counting
 * toward the split and could never be right, which is indistinguishable from
 * never having answered. Refused, and the refusal names the option.
 */
organizerRouter.put('/question', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const id = String(req.body?.id || '');
  const { data: q } = await supabase.from('prediction_questions')
    .select(QUESTION_COLS).eq('tournament_id', t.id).eq('id', id).maybeSingle();
  if (!q) return res.status(404).json({ error: 'No such question.' });

  const patch = {};
  if (req.body.prompt !== undefined || req.body.options !== undefined || req.body.points !== undefined) {
    const problem = questionProblem({
      prompt: req.body.prompt ?? q.prompt,
      options: req.body.options ?? q.options,
      points: req.body.points ?? q.points,
    });
    if (problem) return res.status(400).json({ error: problem });
  }

  if (req.body.prompt !== undefined) patch.prompt = String(req.body.prompt).trim().slice(0, 200);
  if (req.body.points !== undefined) patch.points = Number(req.body.points);
  // Sent as an empty string to clear it — the same shape the schedule field on
  // a match uses, so an organizer clearing a time does it the same way twice.
  if (req.body.closes_at !== undefined) patch.closes_at = req.body.closes_at || null;

  if (req.body.options !== undefined) {
    const next = mergeOptions(q.options, req.body.options);
    const kept = new Set(next.map((o) => o.id));
    const dropped = (q.options || []).filter((o) => !kept.has(o.id));

    if (dropped.length) {
      const { data: used } = await supabase.from('question_answers')
        .select('option_id').eq('question_id', q.id)
        .in('option_id', dropped.map((o) => o.id));
      const blocked = dropped.filter((o) => (used || []).some((a) => a.option_id === o.id));
      if (blocked.length) {
        return res.status(409).json({
          error: `${blocked.map((o) => `"${o.label}"`).join(' and ')} `
            + `${blocked.length === 1 ? 'has' : 'have'} already been chosen — `
            + 'relabel or void the question instead of removing it.',
        });
      }
    }
    patch.options = next;

    // An answer that is no longer an option cannot be the right one.
    if (q.correct_option_id && !kept.has(q.correct_option_id)) patch.correct_option_id = null;
  }

  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to change.' });

  const { error } = await supabase.from('prediction_questions')
    .update(patch).eq('id', q.id);
  if (error) {
    console.error('question update failed:', error.message);
    return res.status(500).json({ error: 'Could not save that change.' });
  }

  await audit(req.user, 'predictions.question.edit', q.id, patch);
  res.json({ ok: true, ...(await overview(t.id, req.user.id)) });
});

/**
 * Settle it — or void it, or take the answer back.
 *
 * Taking it back is deliberately allowed. An answer entered against the wrong
 * option pays the wrong people, and the fix has to be one click rather than a
 * question deleted and rewritten with everybody's answers gone with it. The
 * standings are computed, never stored, so points simply move.
 */
organizerRouter.post('/question/settle', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const id = String(req.body?.id || '');
  const { data: q } = await supabase.from('prediction_questions')
    .select(QUESTION_COLS).eq('tournament_id', t.id).eq('id', id).maybeSingle();
  if (!q) return res.status(404).json({ error: 'No such question.' });

  const wantsVoid = req.body?.void === true;
  const correct = req.body?.correct_option_id ?? undefined;

  const patch = {};
  if (wantsVoid) {
    patch.void = true;
  } else if (correct !== undefined) {
    if (correct === null || correct === '') {
      patch.correct_option_id = null;
      patch.void = false;
    } else {
      if (!(q.options || []).some((o) => o.id === correct)) {
        return res.status(400).json({ error: 'That is not one of the options.' });
      }
      patch.correct_option_id = correct;
      patch.void = false;
    }
  } else if (req.body?.void === false) {
    patch.void = false;
  } else {
    return res.status(400).json({ error: 'Send the correct option, or void it.' });
  }

  const { error } = await supabase.from('prediction_questions').update(patch).eq('id', q.id);
  if (error) {
    console.error('question settle failed:', error.message);
    return res.status(500).json({ error: 'Could not settle that question.' });
  }

  // How many people it just paid — the number an organizer wants to see
  // immediately after clicking, and the one that says the right option was
  // chosen.
  let paid = null;
  if (patch.correct_option_id) {
    const { count } = await supabase.from('question_answers')
      .select('id', { count: 'exact', head: true })
      .eq('question_id', q.id).eq('option_id', patch.correct_option_id);
    paid = count || 0;
  }

  await audit(req.user, 'predictions.question.settle', q.id, { ...patch, paid });
  res.json({ ok: true, paid, ...(await overview(t.id, req.user.id)) });
});

/**
 * Remove a question.
 *
 * Refused while it has answers unless the caller says so explicitly, because
 * deleting it deletes them — including from the standings of anybody who got it
 * right. Voiding is almost always what was meant, and the refusal says so.
 */
organizerRouter.delete('/question', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const id = String(req.body?.id || '');
  const { data: q } = await supabase.from('prediction_questions')
    .select('id, prompt').eq('tournament_id', t.id).eq('id', id).maybeSingle();
  if (!q) return res.status(404).json({ error: 'No such question.' });

  const { count } = await supabase.from('question_answers')
    .select('id', { count: 'exact', head: true }).eq('question_id', q.id);

  if (count > 0 && req.body?.force !== true) {
    return res.status(409).json({
      error: `${count} ${count === 1 ? 'person has' : 'people have'} answered this. `
        + 'Voiding it leaves their answers on record and scores nobody; deleting it removes them. '
        + 'Send it again with force to delete.',
      answers: count,
    });
  }

  const { error } = await supabase.from('prediction_questions').delete().eq('id', q.id);
  if (error) return res.status(500).json({ error: 'Could not remove that question.' });

  await audit(req.user, 'predictions.question.remove', q.id, { prompt: q.prompt, answers: count });
  res.json({ ok: true, ...(await overview(t.id, req.user.id)) });
});

module.exports = { router, organizerRouter, readPicks };
