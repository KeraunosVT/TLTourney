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
const { supabase, currentTournament } = require('./db');
const { fetchAll } = require('./pagedRead');
const { bracketState } = require('./bracket');
const {
  pickWindow, championWindow, pickProblem, scorePick, standings, crowdSplit,
  loserGameOptions, WINNER_POINTS, SCORELINE_BONUS, CHAMPION_POINTS,
} = require('../shared/predictions.cjs');

// The tables arrive with migration 016. Until it has been run every route here
// fails on the same error, and saying which file to run beats "could not save".
const missingTable = (error) => /schema cache|does not exist|relation/i.test(error?.message || '');
const NEEDS_MIGRATION = {
  error: 'The prediction tables are missing — run migrations/016_predictions.sql in the Supabase SQL editor.',
};

const PICK_COLS = 'id, match_id, discord_id, display_name, team_id, loser_games, created_at, updated_at';
const CHAMP_COLS = 'id, discord_id, display_name, team_id, created_at, updated_at';

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
 * Everything the page needs, in one read.
 *
 * Assembled here rather than in three routes because every part of it depends
 * on the same snapshot: a crowd split taken a second after the standings would
 * describe a slightly different tournament, and the page would show two
 * numbers that disagree for no reason anybody could work out.
 */
async function overview(tournamentId, me) {
  const [state, picks, champs] = await Promise.all([
    bracketState(tournamentId),
    readPicks(tournamentId),
    readChampionPicks(tournamentId),
  ]);

  const now = Date.now();
  const mine = new Map(picks.filter((p) => p.discord_id === me).map((p) => [p.match_id, p]));

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
    scoring: { winner: WINNER_POINTS, scoreline: SCORELINE_BONUS, champion: CHAMPION_POINTS },
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
    if (missingTable(err)) return res.status(503).json(NEEDS_MIGRATION);
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
    const [state, picks, champs] = await Promise.all([
      bracketState(t.id), readPicks(t.id), readChampionPicks(t.id),
    ]);
    const rows = standings({
      picks, matches: state.matches, championPicks: champs,
      championId: state.champion?.id || null,
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
    if (missingTable(err)) return res.status(503).json(NEEDS_MIGRATION);
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

module.exports = { router, readPicks };
