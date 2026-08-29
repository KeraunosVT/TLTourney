// backend/results.js — scoreboards in, statistics out.
//
// Three steps, deliberately separate, and the separation is the whole design:
//
//   PARSE    a screenshot becomes rows. Nothing is written.
//   REVIEW   a human checks the rows and says who each one is. Still nothing
//            written — the reviewed rows come back from the browser.
//   COMMIT   the rows are stored against the match, replacing whatever was
//            there.
//
// Parsing and committing are not one call because an OCR read is a GUESS.
// Weapon icons are the least reliable field in the game's UI, non-Latin names
// come back mangled, and the model occasionally invents a row. Writing that
// straight into the record and letting somebody correct it afterwards means the
// wrong numbers exist, get read, and get argued about in the window between.
//
// THE WINNER IS NEVER INFERRED. The scoreboard's Yellow/Red split is shown as a
// suggestion and decides nothing: a tournament result settled by an OCR pass on
// a team colour is a result nobody can defend. It goes through the bracket's own
// result endpoint, with a team id an organizer chose.
const express = require('express');
const multer = require('multer');
const { supabase, currentTournament, audit } = require('./db');
const { parseScreenshot, parseCsv } = require('./ingest');
const { rostersByTeam } = require('./teams');
const {
  linkRows, linkSummary, playerProfile, leaderboard, rank, SORTS, isSort,
} = require('../shared/scoreboard.cjs');
const { classify } = require('../shared/classes.cjs');

// In memory, not on disk: a scoreboard screenshot is read once and never needed
// again, and writing it to the filesystem of whatever host this is on would be
// a file nobody deletes.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

const STAT_COLS = 'id, match_id, signup_id, team_id, rank, weapon_1, weapon_2, guild_name, '
  + 'player_name, team_color, kills, assists, damage_dealt, damage_taken, healing, created_at';

const toInt = (v) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/** Everyone on either team of this match, as the linker wants them. */
async function rosterFor(tournamentId, match) {
  const rosters = await rostersByTeam(tournamentId);
  const ids = [match.team_a_id, match.team_b_id].filter(Boolean);
  return ids.flatMap((teamId) => (rosters.get(teamId) || [])
    .map((m) => ({ id: m.id, player_name: m.player_name, team_id: teamId })));
}

// ── Read: anyone signed in ──────────────────────────────────────────────────
const router = express.Router();

/** One match's scoreboard. */
router.get('/match/:key', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.json({ match: null, rows: [] });

  const { data: match } = await supabase.from('matches')
    .select('id, key, bracket, round, idx, team_a_id, team_b_id, winner_team_id, status, scoreboard_at')
    .eq('tournament_id', t.id).eq('key', req.params.key).maybeSingle();
  if (!match) return res.status(404).json({ error: 'No such match.' });

  const [{ data: rows }, { data: teams }] = await Promise.all([
    supabase.from('player_match_stats').select(STAT_COLS)
      .eq('match_id', match.id).order('rank', { ascending: true }),
    supabase.from('teams').select('id, name, tag, seed').eq('tournament_id', t.id),
  ]);

  const byId = new Map((teams || []).map((x) => [x.id, x]));
  res.json({
    match: {
      ...match,
      team_a: byId.get(match.team_a_id) || null,
      team_b: byId.get(match.team_b_id) || null,
      winner: byId.get(match.winner_team_id) || null,
    },
    rows: (rows || []).map((r) => ({ ...r, class: classify(r.weapon_1, r.weapon_2) })),
  });
});

/** The tournament leaderboard. */
router.get('/leaderboard', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.json({ entries: [], sorts: SORTS });

  const [{ data: rows, error }, { data: signups }, { data: teams }] = await Promise.all([
    supabase.from('player_match_stats')
      .select('signup_id, team_id, player_name, weapon_1, weapon_2, kills, assists, damage_dealt, damage_taken, healing')
      .eq('tournament_id', t.id).not('signup_id', 'is', null),
    supabase.from('player_signups').select('id, player_name, role').eq('tournament_id', t.id),
    supabase.from('teams').select('id, name, tag').eq('tournament_id', t.id),
  ]);

  if (error) {
    if (/schema cache|does not exist|relation/i.test(error.message)) {
      return res.status(503).json({
        error: 'The scoreboard table is missing — run migrations/012_scoreboards.sql in the '
          + 'Supabase SQL editor, then migrations/verify.sql.',
      });
    }
    console.error('leaderboard read failed:', error.message);
    return res.status(500).json({ error: 'Could not read the leaderboard.' });
  }

  // Team comes from the STAT ROW, not from the roster: somebody who was traded,
  // or whose signup was later removed, still played that match for whoever they
  // played it for.
  const people = new Map();
  (signups || []).forEach((s) => people.set(s.id, { player_name: s.player_name, role: s.role }));
  (rows || []).forEach((r) => {
    const who = people.get(r.signup_id);
    if (who && who.team_id === undefined) who.team_id = r.team_id;
  });

  const sortBy = isSort(req.query.sort) ? req.query.sort : 'damage_dealt';
  res.json({
    entries: rank(leaderboard(rows, people), sortBy),
    teams: teams || [],
    sort: sortBy,
    sorts: SORTS,
  });
});

/** One player's profile. Keyed on the signup id, never on a name. */
router.get('/player/:signupId', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(404).json({ error: 'No tournament is running.' });

  const { data: player } = await supabase.from('player_signups')
    .select('id, player_name, role, classes, positions, wants_shotcall')
    .eq('tournament_id', t.id).eq('id', req.params.signupId).maybeSingle();
  if (!player) return res.status(404).json({ error: 'No such player in this tournament.' });

  const { data: rows, error } = await supabase.from('player_match_stats')
    .select(`${STAT_COLS}, match:matches (id, key, bracket, round, idx, scheduled_at, winner_team_id)`)
    .eq('tournament_id', t.id).eq('signup_id', player.id);
  if (error) {
    console.error('player profile read failed:', error.message);
    return res.status(500).json({ error: 'Could not read that player.' });
  }

  const { data: onTeam } = await supabase.from('team_players')
    .select('team_id, via, draft_round, draft_pick, teams:team_id (id, name, tag, seed)')
    .eq('tournament_id', t.id).eq('signup_id', player.id).maybeSingle();

  res.json({
    player,
    team: onTeam?.teams || null,
    drafted: onTeam ? { via: onTeam.via, round: onTeam.draft_round, pick: onTeam.draft_pick } : null,
    stats: playerProfile(rows || []),
  });
});

// ── Organizer: parse, then commit ───────────────────────────────────────────
const organizerRouter = express.Router();

/**
 * Read a screenshot or CSV. Writes NOTHING.
 *
 * Comes back with the rows already matched against both teams' rosters, so the
 * review starts from "check these" rather than "fill all of this in".
 */
organizerRouter.post('/parse/:key', upload.single('file'), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });
  if (!req.file) return res.status(400).json({ error: 'Attach a screenshot or a CSV.' });

  const { data: match } = await supabase.from('matches')
    .select('id, key, team_a_id, team_b_id')
    .eq('tournament_id', t.id).eq('key', req.params.key).maybeSingle();
  if (!match) return res.status(404).json({ error: 'No such match.' });
  if (!match.team_a_id || !match.team_b_id) {
    return res.status(409).json({ error: 'Both teams have to be decided before this match can have a scoreboard.' });
  }

  let parsed;
  try {
    const isCsv = /csv|text\/plain/i.test(req.file.mimetype) || /\.csv$/i.test(req.file.originalname || '');
    parsed = isCsv
      ? parseCsv(req.file.buffer.toString('utf8'))
      : await parseScreenshot(req.file.buffer, req.file.mimetype);
  } catch (err) {
    console.error('scoreboard parse failed:', err.message);
    // The message is the useful part here — "GEMINI_API_KEY is not set" and
    // "Gemini did not return valid JSON" send you to completely different
    // places, and a generic failure sends you to neither.
    return res.status(502).json({ error: err.message });
  }

  let roster;
  try {
    roster = await rosterFor(t.id, match);
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: 'Could not read the rosters to match names against.' });
  }

  const linked = linkRows(parsed.players, roster);
  res.json({
    rows: linked.map((r) => ({ ...r, class: classify(r.weapon_1, r.weapon_2) })),
    summary: linkSummary(linked),
    warnings: parsed.warnings || [],
    usedLegend: parsed.usedLegend ?? null,
    // The two rosters, so the review can offer a dropdown per unmatched row.
    roster,
  });
});

/**
 * Store the reviewed rows against the match, replacing whatever was there.
 *
 * Delete-then-insert, in that order, and NOT inside a stored procedure — the
 * same call the plan made for the draft's make_pick and refused for the same
 * reason. If the insert half fails, the match reads as having no scoreboard,
 * which is visible on the bracket and fixed by uploading again. That is a
 * recoverable, self-announcing state, unlike a wedged draft, so it does not
 * justify a second place for this logic to live where no test can reach it.
 */
organizerRouter.post('/commit/:key', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const { data: match } = await supabase.from('matches')
    .select('id, key, team_a_id, team_b_id')
    .eq('tournament_id', t.id).eq('key', req.params.key).maybeSingle();
  if (!match) return res.status(404).json({ error: 'No such match.' });

  const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!rows) return res.status(400).json({ error: 'Send the reviewed rows.' });
  if (rows.length === 0) return res.status(400).json({ error: 'There are no rows to save.' });

  // One person cannot appear twice on one scoreboard. The database refuses it
  // too — that is what pms_one_row_per_player_per_match is for — but catching
  // it here can say WHICH name was doubled, which the constraint cannot.
  const seen = new Map();
  for (const r of rows) {
    if (!r.signup_id) continue;
    if (seen.has(r.signup_id)) {
      return res.status(409).json({
        error: `${r.player_name || 'That player'} is matched to the same person on two rows — `
          + 'fix one of them before saving.',
      });
    }
    seen.set(r.signup_id, true);
  }

  const clean = rows.map((r) => ({
    tournament_id: t.id,
    match_id: match.id,
    signup_id: r.signup_id || null,
    team_id: r.team_id || null,
    rank: Number.isFinite(Number(r.rank)) ? Math.trunc(Number(r.rank)) : null,
    weapon_1: String(r.weapon_1 || '').slice(0, 40) || null,
    weapon_2: String(r.weapon_2 || '').slice(0, 40) || null,
    guild_name: String(r.guild_name || '').slice(0, 80) || null,
    player_name: String(r.player_name || '').trim().slice(0, 64),
    team_color: ['Yellow', 'Red'].includes(r.team_color) ? r.team_color : null,
    kills: toInt(r.kills),
    assists: toInt(r.assists),
    damage_dealt: toInt(r.damage_dealt),
    damage_taken: toInt(r.damage_taken),
    healing: toInt(r.healing),
  }));

  if (clean.some((r) => !r.player_name)) {
    return res.status(400).json({ error: 'Every row needs a name — delete the blank ones.' });
  }

  const { error: delErr } = await supabase.from('player_match_stats')
    .delete().eq('match_id', match.id);
  if (delErr) {
    console.error('scoreboard clear failed:', delErr.message);
    return res.status(500).json({ error: 'Could not clear the old scoreboard.' });
  }

  const { error: insErr } = await supabase.from('player_match_stats').insert(clean);
  if (insErr) {
    console.error('scoreboard insert failed:', insErr.message);
    if (/pms_one_row_per_player_per_match/.test(`${insErr.message} ${insErr.details}`)) {
      return res.status(409).json({ error: 'Two rows are matched to the same player.' });
    }
    return res.status(500).json({
      error: 'The old scoreboard was cleared but the new one did not save — upload it again.',
    });
  }

  await supabase.from('matches')
    .update({ scoreboard_at: new Date().toISOString() })
    .eq('id', match.id);

  const summary = linkSummary(clean);
  await audit(req.user, 'scoreboard.commit', match.key, summary);
  res.json({ ok: true, ...summary });
});

organizerRouter.delete('/match/:key', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const { data: match } = await supabase.from('matches')
    .select('id, key').eq('tournament_id', t.id).eq('key', req.params.key).maybeSingle();
  if (!match) return res.status(404).json({ error: 'No such match.' });

  const { error } = await supabase.from('player_match_stats').delete().eq('match_id', match.id);
  if (error) return res.status(500).json({ error: 'Could not clear that scoreboard.' });

  await supabase.from('matches').update({ scoreboard_at: null }).eq('id', match.id);
  await audit(req.user, 'scoreboard.clear', match.key, null);
  res.json({ ok: true });
});

module.exports = { router, organizerRouter };
