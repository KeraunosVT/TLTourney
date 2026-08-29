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
  linkRows, linkSummary, mergePages, inferSides, applySides,
  playerProfile, leaderboard, rank, SORTS, isSort,
} = require('../shared/scoreboard.cjs');
const { classify } = require('../shared/classes.cjs');
const { seriesResult, gameSlots } = require('../shared/series.cjs');
const { MAPS, available } = require('../shared/maps.cjs');

// In memory, not on disk: a scoreboard screenshot is read once and never needed
// again, and writing it to the filesystem of whatever host this is on would be
// a file nobody deletes.
// A 50v50 scoreboard is paginated — a dozen rows on screen at a time — so a
// full board is ten or so screenshots, and people overlap them so nothing falls
// between two shots. Batch upload is the normal case here, not a convenience.
// Capped with the PEAK in mind, not the typical case. multer buffers every
// file in memory before the handler runs, so the limit that matters is files x
// fileSize — 20 x 12MB was 240MB of headroom this app does not have on a small
// host. A scoreboard screenshot is well under a megabyte.
const MAX_FILES = 12;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024, files: MAX_FILES },
});

// Gemini calls run a few at a time rather than all at once. Ten concurrent
// vision requests is how a free-tier key earns a 429, and a rate-limited batch
// fails as "some of your screenshots didn't read" — the least useful possible
// error on the night.
const LANES = 3;

async function inLanes(items, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(LANES, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  }));
  return out;
}

const STAT_COLS = 'id, match_id, game_id, signup_id, team_id, rank, weapon_1, weapon_2, guild_name, '
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
    .select('id, key, bracket, round, idx, best_of, team_a_id, team_b_id, winner_team_id, status, scoreboard_at, bans_a, bans_b')
    .eq('tournament_id', t.id).eq('key', req.params.key).maybeSingle();
  if (!match) return res.status(404).json({ error: 'No such match.' });

  const [{ data: rows }, { data: teams }, { data: games }] = await Promise.all([
    supabase.from('player_match_stats').select(STAT_COLS)
      .eq('match_id', match.id).order('rank', { ascending: true }),
    supabase.from('teams').select('id, name, tag, seed').eq('tournament_id', t.id),
    supabase.from('match_games')
      .select('id, game_number, map, winner_team_id, scoreboard_at')
      .eq('match_id', match.id).order('game_number', { ascending: true }),
  ]);

  const byId = new Map((teams || []).map((x) => [x.id, x]));
  const byGame = new Map();
  (rows || []).forEach((r) => {
    const k = r.game_id || 'none';
    if (!byGame.has(k)) byGame.set(k, []);
    byGame.get(k).push({ ...r, class: classify(r.weapon_1, r.weapon_2) });
  });

  // Every game played, plus the next one if the series is still live — see
  // shared/series.cjs. The page shows one tab per entry.
  const slots = gameSlots(games || [], match.best_of, match.team_a_id, match.team_b_id);

  res.json({
    match: {
      ...match,
      team_a: byId.get(match.team_a_id) || null,
      team_b: byId.get(match.team_b_id) || null,
      winner: byId.get(match.winner_team_id) || null,
    },
    series: seriesResult(games || [], match.best_of, match.team_a_id, match.team_b_id),
    maps: MAPS,
    mapsAvailable: available([...(match.bans_a || []), ...(match.bans_b || [])]),
    games: slots.map((g) => ({ ...g, rows: byGame.get(g.id) || [] })),
    // Rows recorded before 013 split matches into games. Kept visible rather
    // than orphaned into a tab that does not exist.
    looseRows: byGame.get('none') || [],
  });
});

/** The tournament leaderboard. */
router.get('/leaderboard', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.json({ entries: [], sorts: SORTS });

  const [{ data: rows, error }, { data: signups }, { data: teams }] = await Promise.all([
    supabase.from('player_match_stats')
      .select('signup_id, match_id, team_id, player_name, weapon_1, weapon_2, kills, assists, damage_dealt, damage_taken, healing')
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
    .select(`${STAT_COLS}, match:matches (id, key, bracket, round, idx, scheduled_at, winner_team_id), game:match_games (game_number, map)`)
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
organizerRouter.post('/parse/:key', upload.array('files', MAX_FILES), async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });
  const files = req.files || [];
  if (files.length === 0) return res.status(400).json({ error: 'Attach one or more screenshots, or a CSV.' });

  const { data: match } = await supabase.from('matches')
    .select('id, key, team_a_id, team_b_id')
    .eq('tournament_id', t.id).eq('key', req.params.key).maybeSingle();
  if (!match) return res.status(404).json({ error: 'No such match.' });
  if (!match.team_a_id || !match.team_b_id) {
    return res.status(409).json({ error: 'Both teams have to be decided before this match can have a scoreboard.' });
  }

  // Each page is read on its own and a failure is reported PER FILE rather than
  // failing the batch. Nine screenshots that read and one that didn't is nine
  // pages of work kept and one to retake; throwing the lot away because the
  // last one was blurry is not.
  const pages = await inLanes(files, async (f) => {
    const isCsv = /csv|text\/plain/i.test(f.mimetype) || /\.csv$/i.test(f.originalname || '');
    try {
      const out = isCsv
        ? parseCsv(f.buffer.toString('utf8'))
        : await parseScreenshot(f.buffer, f.mimetype);
      return { name: f.originalname || 'file', players: out.players, warnings: out.warnings || [], usedLegend: out.usedLegend };
    } catch (err) {
      console.error(`scoreboard parse failed (${f.originalname}):`, err.message);
      // The message is the useful part — "GEMINI_API_KEY is not set" and
      // "Gemini did not return valid JSON" send you to completely different
      // places, and a generic failure sends you to neither.
      return { name: f.originalname || 'file', players: [], error: err.message };
    }
  });

  const failed = pages.filter((p) => p.error);
  if (failed.length === files.length) {
    // Every one failed, so it is not the screenshots — it is the key, the
    // model, or the network. Say the first reason rather than a tally.
    return res.status(502).json({ error: failed[0].error });
  }

  const merged = mergePages(pages);

  let roster;
  try {
    roster = await rosterFor(t.id, match);
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: 'Could not read the rosters to match names against.' });
  }

  const named = linkRows(merged.rows, roster);

  // The organizer says which team played which colour BEFORE uploading — they
  // were watching, and it is two clicks against a vote that can be wrong.
  // Multer puts text fields alongside the files, so they arrive on the body.
  const pair = [match.team_a_id, match.team_b_id];
  const asked = {
    Yellow: pair.includes(req.body?.yellow_team_id) ? req.body.yellow_team_id : null,
    Red: pair.includes(req.body?.red_team_id) ? req.body.red_team_id : null,
  };
  const given = asked.Yellow && asked.Red && asked.Yellow !== asked.Red;

  // Inferred anyway, and NOT to override them — to check them. Picking the two
  // colours the wrong way round is the easiest mistake on this page to make and
  // the hardest to see afterwards, because every number lands on the wrong team
  // and every one of them looks plausible.
  const voted = inferSides(named, roster);
  const sides = given ? asked : voted.sides;
  const confident = given || voted.confident;
  const contradicted = given && voted.confident
    && (voted.sides.Yellow !== sides.Yellow || voted.sides.Red !== sides.Red);

  const linked = applySides(named, sides, roster);

  const warnings = [
    ...failed.map((p) => `${p.name} could not be read: ${p.error}`),
    ...merged.conflicts,
    ...(files.length > 1
      ? [`Merged ${files.length - failed.length} of ${files.length} files into ${merged.rows.length} rows`
        + `${merged.duplicates ? `, ${merged.duplicates} duplicate row(s) collapsed` : ''}.`]
      : []),
    // Per-file warnings from the reader itself, de-duplicated: ten pages each
    // saying "3 rows have a weapon to confirm" is ten copies of one fact.
    ...[...new Set(pages.flatMap((p) => p.warnings || []))]
      .filter((w) => !/weapon to confirm/i.test(w)),
  ];

  // Restated in the language the review actually uses. ingest.js counts rows
  // whose WEAPONS it could not place; the table shows a class, so a warning
  // about weapons sends a reviewer looking for a column that isn't there.
  const noClass = linked.filter((r) => !classify(r.weapon_1, r.weapon_2)).length;
  if (noClass) {
    warnings.push(`${noClass} row(s) have no class the weapons resolve to — set it in the Class column.`);
  }

  const sideConflicts = linked.filter((r) => r.side_conflict).length;
  if (sideConflicts) {
    warnings.push(
      `${sideConflicts} row(s) are on a colour that disagrees with the team their name belongs to `
      + '— either the name or the colour was misread, so check those first.'
    );
  }
  if (contradicted) {
    warnings.push(
      'The names on the Yellow rows mostly belong to the team you marked as Red, and vice versa — '
      + 'check you have the two colours the right way round before saving.'
    );
  }
  if (!confident) {
    warnings.push(
      'Could not tell which team played Yellow and which played Red — set it above the table.'
    );
  }

  const { data: teamRows } = await supabase.from('teams')
    .select('id, name, tag').in('id', [match.team_a_id, match.team_b_id]);

  res.json({
    rows: linked.map((r) => ({ ...r, class: classify(r.weapon_1, r.weapon_2) })),
    summary: linkSummary(linked),
    sides,
    sidesConfident: confident,
    teams: teamRows || [],
    warnings,
    files: pages.map((p) => ({ name: p.name, rows: p.players.length, error: p.error || null })),
    usedLegend: pages.find((p) => p.usedLegend !== undefined)?.usedLegend ?? null,
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

  // Which GAME of the series. A best-of-three has up to three scoreboards, and
  // the unique index is on (game_id, signup_id) — committing without one would
  // put every game's rows in the same bucket and refuse the second.
  const gameNumber = Number(req.body?.game_number);
  if (!Number.isInteger(gameNumber) || gameNumber < 1) {
    return res.status(400).json({ error: 'Which game is this scoreboard for?' });
  }

  const { data: game, error: gErr } = await supabase.from('match_games')
    .upsert({ tournament_id: t.id, match_id: match.id, game_number: gameNumber },
      { onConflict: 'match_id,game_number' })
    .select('id, game_number').single();
  if (gErr || !game) {
    console.error('game lookup failed:', gErr?.message);
    if (/schema cache|does not exist|relation/i.test(gErr?.message || '')) {
      return res.status(503).json({
        error: 'The games table is missing — run migrations/013_games.sql in the Supabase SQL editor.',
      });
    }
    return res.status(500).json({ error: 'Could not find that game.' });
  }

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
    game_id: game.id,
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
    .delete().eq('game_id', game.id);
  if (delErr) {
    console.error('scoreboard clear failed:', delErr.message);
    return res.status(500).json({ error: 'Could not clear the old scoreboard.' });
  }

  const { error: insErr } = await supabase.from('player_match_stats').insert(clean);
  if (insErr) {
    console.error('scoreboard insert failed:', insErr.message);
    if (/pms_one_row_per_player_per_game/.test(`${insErr.message} ${insErr.details}`)) {
      return res.status(409).json({ error: 'Two rows are matched to the same player.' });
    }
    return res.status(500).json({
      error: 'The old scoreboard was cleared but the new one did not save — upload it again.',
    });
  }

  const now = new Date().toISOString();
  await supabase.from('match_games').update({ scoreboard_at: now }).eq('id', game.id);
  // On the match too, so the bracket card can show a stats badge without
  // counting rows in another table for every match on screen.
  await supabase.from('matches').update({ scoreboard_at: now }).eq('id', match.id);

  const summary = linkSummary(clean);
  await audit(req.user, 'scoreboard.commit', `${match.key} g${game.game_number}`, summary);
  res.json({ ok: true, ...summary });
});

organizerRouter.delete('/match/:key', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const { data: match } = await supabase.from('matches')
    .select('id, key').eq('tournament_id', t.id).eq('key', req.params.key).maybeSingle();
  if (!match) return res.status(404).json({ error: 'No such match.' });

  const gameNumber = Number(req.query.game || req.body?.game_number);
  const { data: game } = await supabase.from('match_games')
    .select('id').eq('match_id', match.id).eq('game_number', gameNumber).maybeSingle();
  if (!game) return res.status(404).json({ error: 'No such game.' });

  const { error } = await supabase.from('player_match_stats').delete().eq('game_id', game.id);
  if (error) return res.status(500).json({ error: 'Could not clear that scoreboard.' });

  await supabase.from('match_games').update({ scoreboard_at: null }).eq('id', game.id);

  // The match keeps its badge only while SOME game still has a scoreboard.
  const { count } = await supabase.from('player_match_stats')
    .select('id', { count: 'exact', head: true }).eq('match_id', match.id);
  await supabase.from('matches')
    .update({ scoreboard_at: count ? new Date().toISOString() : null })
    .eq('id', match.id);

  await audit(req.user, 'scoreboard.clear', `${match.key} g${gameNumber}`, null);
  res.json({ ok: true });
});

module.exports = { router, organizerRouter };
