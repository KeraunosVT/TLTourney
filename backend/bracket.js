// backend/bracket.js — the bracket, persisted.
//
// All the thinking is in shared/bracket.cjs, which is pure and has fifty
// thousand simulated tournaments behind it. This file does three things and
// nothing else: write that function's output into `matches`, read it back, and
// turn a reported winner into the rows that record it.
//
// Deliberately thin. Every line of bracket reasoning that leaks in here is a
// line that can only be tested with a database.
const express = require('express');
const { supabase, currentTournament, audit } = require('./db');
const { generateBracket, applyResult, roundLabel } = require('../shared/bracket.cjs');
const { seriesResult, gameSlots, isBestOf } = require('../shared/series.cjs');
const { isMap, available, isPlayable } = require('../shared/maps.cjs');

const COLS = 'id, key, bracket, round, idx, slot_a, slot_b, team_a_id, team_b_id, '
  + 'winner_team_id, loser_team_id, kind, advances, status, is_reset, scheduled_at, '
  + 'decided_at, decided_by, scoreboard_at, best_of, ban_a, ban_b';

const TEAM = 'id, name, tag, seed';

// The DB row and the pure function speak slightly different dialects: the
// engine wants `a`/`b` for the slot sources, the table stores them as
// slot_a/slot_b so the columns say what they are. Converted in one place each
// way rather than at every call site.
const toEngine = (row) => ({ ...row, a: row.slot_a, b: row.slot_b, reset: row.is_reset });

const fromEngine = (m, tournamentId) => ({
  tournament_id: tournamentId,
  key: m.key,
  bracket: m.bracket,
  round: m.round,
  idx: m.idx,
  slot_a: m.a,
  slot_b: m.b,
  kind: m.status,           // the engine calls it status; here it is what KIND of match it is
  advances: m.advances || null,
  is_reset: !!m.reset,
});

const GAME = 'id, match_id, game_number, map, winner_team_id, scoreboard_at, decided_at, decided_by';

async function readGames(tournamentId) {
  const { data, error } = await supabase
    .from('match_games').select(GAME).eq('tournament_id', tournamentId)
    .order('game_number', { ascending: true });
  if (error) throw new Error(`games read failed: ${error.message}`);
  const byMatch = new Map();
  (data || []).forEach((g) => {
    if (!byMatch.has(g.match_id)) byMatch.set(g.match_id, []);
    byMatch.get(g.match_id).push(g);
  });
  return byMatch;
}

async function readMatches(tournamentId) {
  const { data, error } = await supabase
    .from('matches').select(COLS).eq('tournament_id', tournamentId)
    .order('bracket', { ascending: true })
    .order('round', { ascending: true })
    .order('idx', { ascending: true });
  if (error) throw new Error(`bracket read failed: ${error.message}`);
  return data || [];
}

/**
 * Fill in every slot that can now be filled, and mark what is ready to play.
 *
 * Run after generating and after every result. It is written as a fixpoint over
 * the whole bracket rather than as "advance these two teams" because walkovers
 * chain: a bye advances somebody for free, which can complete the next walkover,
 * which can complete the one after. Handling one step and trusting the next
 * result to handle the rest leaves a bracket that is correct only while people
 * keep playing matches.
 *
 * Returns the number of rows it changed.
 */
async function settle(tournamentId) {
  let rows = await readMatches(tournamentId);
  let written = 0;

  for (let pass = 0; pass < 40; pass++) {
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const patches = new Map();   // key -> partial row

    const patch = (key, fields) => {
      patches.set(key, { ...(patches.get(key) || {}), ...fields });
      Object.assign(byKey.get(key), fields);
    };

    for (const r of rows) {
      if (r.status === 'complete') continue;

      // A walkover completes itself the moment the side that advances is known.
      // Nobody plays it, so waiting for a reported result would stall the
      // bracket on a match that has no opponent to lose it.
      if (r.kind === 'walkover') {
        const id = r[`team_${r.advances}_id`];
        if (!id) continue;
        patch(r.key, {
          winner_team_id: id, loser_team_id: null,
          status: 'complete', decided_at: new Date().toISOString(), decided_by: 'bye',
        });
        // Carry them forward by hand: applyResult needs two teams, and a
        // walkover has one.
        rows.forEach((x) => ['a', 'b'].forEach((s) => {
          const src = x[`slot_${s}`];
          if (src?.type === 'winner' && src.of === r.key) patch(x.key, { [`team_${s}_id`]: id });
        }));
        continue;
      }

      if (r.kind === 'void') continue;

      const ready = r.team_a_id && r.team_b_id;
      if (ready && r.status !== 'ready') patch(r.key, { status: 'ready' });
    }

    if (patches.size === 0) break;

    for (const [key, fields] of patches) {
      const { error } = await supabase.from('matches').update(fields)
        .eq('tournament_id', tournamentId).eq('key', key);
      if (error) throw new Error(`bracket settle failed at ${key}: ${error.message}`);
      written += 1;
    }
    rows = await readMatches(tournamentId);
  }

  return written;
}

// ── Reading it ──────────────────────────────────────────────────────────────
async function bracketState(tournamentId) {
  const [rows, teamsRes, gamesByMatch] = await Promise.all([
    readMatches(tournamentId),
    supabase.from('teams').select(TEAM).eq('tournament_id', tournamentId)
      .order('seed', { ascending: true, nullsFirst: false }),
    readGames(tournamentId),
  ]);
  if (teamsRes.error) throw new Error(`bracket teams read failed: ${teamsRes.error.message}`);

  const teams = teamsRes.data || [];
  const byId = new Map(teams.map((t) => [t.id, t]));

  const winnersRounds = Math.max(0, ...rows.filter((r) => r.bracket === 'W').map((r) => r.round));
  const losersRounds = Math.max(0, ...rows.filter((r) => r.bracket === 'L').map((r) => r.round));

  const matches = rows
    // Void matches are structure, not events. They exist so the round
    // arithmetic stays whole; showing an empty box on a bracket is worse than
    // showing nothing.
    .filter((r) => r.kind !== 'void')
    .map((r) => {
      const games = gamesByMatch.get(r.id) || [];
      return {
        ...r,
        label: roundLabel(r, { winnersRounds, losersRounds }),
        team_a: byId.get(r.team_a_id) || null,
        team_b: byId.get(r.team_b_id) || null,
        winner: byId.get(r.winner_team_id) || null,
        games,
        series: seriesResult(games, r.best_of, r.team_a_id, r.team_b_id),
        // Worked out here rather than on the page, so the picker and the
        // validation that refuses a banned map are reading the same list.
        maps_available: available([r.ban_a, r.ban_b]),
      };
    });

  const gf1 = rows.find((r) => r.bracket === 'GF' && r.round === 1);
  const gf2 = rows.find((r) => r.bracket === 'GF' && r.round === 2);
  // The tournament is over when a grand final is complete and no reset is
  // pending — i.e. either the reset was played, or it never became live.
  const decider = gf2?.status === 'complete' ? gf2 : (gf2?.team_a_id ? null : gf1);
  const champion = decider?.status === 'complete' ? byId.get(decider.winner_team_id) || null : null;

  return {
    exists: rows.length > 0,
    winnersRounds,
    losersRounds,
    teams,
    matches,
    champion,
    // The reset is only a fixture once the losers bracket has forced it. Counted
    // unconditionally, a finished tournament read "10 of 11 played" forever,
    // with the missing one being a match that was never going to happen.
    counts: (() => {
      const live = matches.filter((m) => m.kind === 'match' && (!m.is_reset || m.team_a_id));
      return {
        total: live.length,
        complete: live.filter((m) => m.status === 'complete').length,
        ready: live.filter((m) => m.status === 'ready').length,
      };
    })(),
  };
}

// ── Public: anyone signed in ────────────────────────────────────────────────
const router = express.Router();

router.get('/', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.json({ exists: false, matches: [], teams: [] });

  try {
    res.json(await bracketState(t.id));
  } catch (err) {
    console.error('bracket read failed:', err.message);
    if (/schema cache|does not exist|relation/i.test(err.message)) {
      return res.status(503).json({
        error: 'The bracket table is missing — run migrations/011_bracket.sql in the '
          + 'Supabase SQL editor, then migrations/verify.sql.',
      });
    }
    res.status(500).json({ error: 'Could not read the bracket.' });
  }
});

// ── Organizer ───────────────────────────────────────────────────────────────
const organizerRouter = express.Router();

organizerRouter.get('/', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.json({ exists: false, matches: [], teams: [] });

  try {
    const state = await bracketState(t.id);
    res.json({
      ...state,
      // Regenerating is refused once anything has been played, so the button
      // has to know before it is pressed rather than after.
      canGenerate: state.counts.complete === 0,
      seeded: state.teams.filter((x) => x.seed).length,
      unseeded: state.teams.filter((x) => !x.seed).map((x) => x.name),
    });
  } catch (err) {
    console.error('organizer bracket read failed:', err.message);
    res.status(500).json({ error: 'Could not read the bracket.' });
  }
});

/**
 * Build the bracket from the teams' seeds.
 *
 * Refused once ANY match has been played. Regenerating mid-tournament would
 * silently re-pair everybody and erase results — and the button that does it
 * sits on the same screen as the one that records them.
 */
organizerRouter.post('/generate', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const { data: teams, error: tErr } = await supabase
    .from('teams').select(TEAM).eq('tournament_id', t.id)
    .not('seed', 'is', null).order('seed', { ascending: true });
  if (tErr) return res.status(500).json({ error: 'Could not read the teams.' });

  if ((teams || []).length < 2) {
    return res.status(409).json({ error: 'A bracket needs at least two seeded teams.' });
  }

  const { data: existing, error: exErr } = await supabase
    .from('matches').select('key, status, decided_by').eq('tournament_id', t.id);
  if (exErr) {
    if (/schema cache|does not exist|relation/i.test(exErr.message)) {
      return res.status(503).json({
        error: 'The bracket table is missing — run migrations/011_bracket.sql first.',
      });
    }
    return res.status(500).json({ error: 'Could not read the existing bracket.' });
  }

  // A BYE IS NOT A PLAYED MATCH. Generating settles the walkovers on the way
  // out, which marks them complete — so counting completed matches read a
  // freshly drawn bracket as one that had already been played, and refused to
  // redraw it. Nobody had played anything.
  const played = (existing || []).filter((m) => m.status === 'complete' && m.decided_by !== 'bye');
  if (played.length > 0) {
    return res.status(409).json({
      error: `${played.length} matches have already been played — the bracket cannot be regenerated. `
        + 'Clear it first if you really mean to start over.',
    });
  }

  const g = generateBracket(teams.length);

  // Replace wholesale rather than upsert. A bracket half-built from an old team
  // count and half from a new one is the worst possible state, and the only way
  // to be sure it cannot happen is for the old one not to be there.
  if ((existing || []).length) {
    const { error } = await supabase.from('matches').delete().eq('tournament_id', t.id);
    if (error) return res.status(500).json({ error: 'Could not clear the old bracket.' });
  }

  const rows = g.matches.map((m) => fromEngine(m, t.id));
  const { error: insErr } = await supabase.from('matches').insert(rows);
  if (insErr) {
    console.error('bracket insert failed:', insErr.message);
    return res.status(500).json({ error: 'Could not write the bracket.' });
  }

  // Seed the first round, then let walkovers cascade.
  // POSITION in the seed order, not the raw seed value.
  //
  // generateBracket produces slots for seeds 1..n. teams.seed is any integer a
  // human typed — reseed writes 1..N, but a hand-edited seed can be 12, or 9000,
  // or leave a gap. Matching on the raw value silently placed only the teams
  // whose seed happened to fall inside 1..n and left every other slot empty:
  // a bracket that generated without error and had nobody in it.
  //
  // The mock bracket caught this on its first run, with teams seeded 9000+.
  const bySeed = new Map(teams.map((x, i) => [i + 1, x.id]));
  for (const m of g.matches) {
    const fields = {};
    if (m.a.type === 'seed' && bySeed.has(m.a.seed)) fields.team_a_id = bySeed.get(m.a.seed);
    if (m.b.type === 'seed' && bySeed.has(m.b.seed)) fields.team_b_id = bySeed.get(m.b.seed);
    if (!Object.keys(fields).length) continue;
    const { error } = await supabase.from('matches').update(fields)
      .eq('tournament_id', t.id).eq('key', m.key);
    if (error) return res.status(500).json({ error: 'Could not seed the bracket.' });
  }

  try {
    await settle(t.id);
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: 'The bracket was written but did not settle — reload it.' });
  }

  await audit(req.user, 'bracket.generate', null, {
    teams: teams.length, size: g.size, byes: g.byes, matches: g.matches.length,
  });
  res.json({ ok: true, ...(await bracketState(t.id)) });
});

/**
 * Clear a match's result and everything downstream of it.
 *
 * Shared by undo and by a game being edited so the series is no longer decided.
 * A team that advanced on this result may already be written into two more
 * slots, so the whole subtree is cleared rather than tracked.
 */
async function unwind(tournamentId, rows, key) {
  const downstream = new Set([key]);
  let grew = true;
  while (grew) {
    grew = false;
    rows.forEach((r) => {
      if (downstream.has(r.key)) return;
      if (['slot_a', 'slot_b'].some((sl) => r[sl]?.of && downstream.has(r[sl].of))) {
        downstream.add(r.key);
        grew = true;
      }
    });
  }

  for (const k of downstream) {
    const isSelf = k === key;
    const { error } = await supabase.from('matches').update({
      winner_team_id: null, loser_team_id: null, status: 'pending',
      decided_at: null, decided_by: null,
      // The match itself keeps its teams; everything after it loses them,
      // because those teams only got there because of the result being undone.
      ...(isSelf ? {} : { team_a_id: null, team_b_id: null }),
    }).eq('tournament_id', tournamentId).eq('key', k);
    if (error) throw new Error(`unwind failed at ${k}: ${error.message}`);
  }
  return downstream;
}

/**
 * Bring a match's result into line with the games recorded under it.
 *
 * The only thing that decides a bracket match now. Called after any change to a
 * game, and self-correcting in all three directions:
 *
 *   not decided -> decided         record the winner and advance
 *   decided -> not decided         a game was edited or removed; clear the
 *                                  result and everything downstream
 *   decided -> a DIFFERENT winner  an organizer fixed a wrong game; unwind,
 *                                  then advance the other way
 *
 * Written as "make the bracket agree with the games" rather than "apply this
 * game" because the second only works forwards. Correcting game 1 of a finished
 * series is an ordinary thing to do, and it has to un-advance a team that is
 * already two rounds along.
 */
async function recompute(t, key, actor) {
  const rows = await readMatches(t.id);
  const match = rows.find((r) => r.key === key);
  if (!match) return { error: 'No such match.', code: 404 };

  const gamesByMatch = await readGames(t.id);
  const games = gamesByMatch.get(match.id) || [];
  const series = seriesResult(games, match.best_of, match.team_a_id, match.team_b_id);

  const recorded = match.winner_team_id || null;
  const should = series.decided ? series.winnerId : null;
  if (recorded === should) return { series, changed: false };

  // Anything already recorded comes off first — including when the winner
  // merely CHANGED, because the old winner is sitting in a later slot.
  if (recorded) {
    try {
      await unwind(t.id, rows, key);
    } catch (err) {
      console.error(err.message);
      return { error: 'The bracket is half-undone — reload it.', code: 500 };
    }
  }

  if (!should) {
    await settle(t.id);
    return { series, changed: true, cleared: true };
  }

  const fresh = await readMatches(t.id);
  const result = applyResult(fresh.map(toEngine), key, should);
  if (result.error) return { error: result.error, code: 409 };

  const { error: mErr } = await supabase.from('matches').update({
    winner_team_id: result.winnerId,
    loser_team_id: result.loserId,
    status: 'complete',
    decided_at: new Date().toISOString(),
    decided_by: actor || null,
  }).eq('tournament_id', t.id).eq('key', key);
  if (mErr) {
    console.error('series result write failed:', mErr.message);
    return { error: 'Could not record that result.', code: 500 };
  }

  for (const w of result.writes) {
    const { error } = await supabase.from('matches')
      .update({ [`team_${w.slot}_id`]: w.teamId })
      .eq('tournament_id', t.id).eq('key', w.key);
    if (error) {
      console.error('advance failed:', error.message);
      return { error: 'The result was recorded but the teams did not advance — reload.', code: 500 };
    }
  }

  await settle(t.id);
  return { series, changed: true, result };
}

/**
 * Record a game: its map, its winner, or both.
 *
 * The map saves on its own, before the game is played — that is the order
 * things actually happen in, and a form that demanded a winner before it would
 * accept a map would have people writing the map down somewhere else.
 */
organizerRouter.post('/game', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const key = String(req.body?.key || '');
  const number = Number(req.body?.game_number);
  if (!key || !Number.isInteger(number) || number < 1 || number > 9) {
    return res.status(400).json({ error: 'Send the match and a game number.' });
  }

  const { data: match } = await supabase.from('matches')
    .select('id, key, best_of, team_a_id, team_b_id, ban_a, ban_b')
    .eq('tournament_id', t.id).eq('key', key).maybeSingle();
  if (!match) return res.status(404).json({ error: 'No such match.' });
  if (!match.team_a_id || !match.team_b_id) {
    return res.status(409).json({ error: 'Both teams have to be decided before games can be recorded.' });
  }
  if (number > match.best_of) {
    return res.status(400).json({ error: `This match is best of ${match.best_of}.` });
  }

  const winner = req.body?.winner_team_id ?? undefined;
  if (winner !== undefined && winner !== null
      && ![match.team_a_id, match.team_b_id].includes(winner)) {
    return res.status(400).json({ error: 'That team is not in this match.' });
  }

  const patch = { tournament_id: t.id, match_id: match.id, game_number: number };
  if (req.body?.map !== undefined) {
    const map = String(req.body.map).trim() || null;
    if (map && !isMap(map)) {
      return res.status(400).json({ error: `"${map}" is not one of the tournament's maps.` });
    }
    if (map && !isPlayable(map, [match.ban_a, match.ban_b])) {
      return res.status(409).json({ error: `${map} is banned in this match.` });
    }
    patch.map = map;
  }
  if (winner !== undefined) {
    patch.winner_team_id = winner || null;
    patch.decided_at = winner ? new Date().toISOString() : null;
    patch.decided_by = winner ? (req.user?.username || null) : null;
  }

  const { error } = await supabase.from('match_games')
    .upsert(patch, { onConflict: 'match_id,game_number' });
  if (error) {
    console.error('game save failed:', error.message);
    if (/schema cache|does not exist|relation/i.test(error.message)) {
      return res.status(503).json({
        error: 'The games table is missing — run migrations/013_games.sql in the Supabase SQL editor.',
      });
    }
    return res.status(500).json({ error: 'Could not save that game.' });
  }

  const out = await recompute(t, key, req.user?.username);
  if (out.error) return res.status(out.code || 500).json({ error: out.error });

  await audit(req.user, 'bracket.game', key, {
    game: number, map: patch.map, winner: patch.winner_team_id,
    series: out.series ? `${out.series.winsA}-${out.series.winsB}` : null,
  });

  res.json({ ok: true, series: out.series, ...(await bracketState(t.id)) });
});

organizerRouter.delete('/game', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const key = String(req.body?.key || '');
  const number = Number(req.body?.game_number);
  const { data: match } = await supabase.from('matches')
    .select('id').eq('tournament_id', t.id).eq('key', key).maybeSingle();
  if (!match) return res.status(404).json({ error: 'No such match.' });

  const { error } = await supabase.from('match_games').delete()
    .eq('match_id', match.id).eq('game_number', number);
  if (error) return res.status(500).json({ error: 'Could not remove that game.' });

  const out = await recompute(t, key, req.user?.username);
  if (out.error) return res.status(out.code || 500).json({ error: out.error });

  await audit(req.user, 'bracket.game.remove', key, { game: number });
  res.json({ ok: true, ...(await bracketState(t.id)) });
});

/**
 * The two map bans, one per team.
 *
 * Sent as a pair rather than one at a time, so "both teams banned the same map"
 * is answerable in one place — the database refuses it too, but this can say
 * WHICH map, which the constraint cannot.
 *
 * Clearing a ban is legal and is how a mistake gets fixed: send null.
 */
organizerRouter.put('/bans', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const key = String(req.body?.key || '');
  const { data: match } = await supabase.from('matches')
    .select('id, key, ban_a, ban_b').eq('tournament_id', t.id).eq('key', key).maybeSingle();
  if (!match) return res.status(404).json({ error: 'No such match.' });

  const read = (v, current) => {
    if (v === undefined) return current;                 // not sent: leave it
    const name = String(v ?? '').trim();
    return name || null;                                 // sent empty: clear it
  };

  const banA = read(req.body?.ban_a, match.ban_a);
  const banB = read(req.body?.ban_b, match.ban_b);

  for (const b of [banA, banB]) {
    if (b && !isMap(b)) return res.status(400).json({ error: `"${b}" is not one of the tournament's maps.` });
  }
  if (banA && banB && banA === banB) {
    return res.status(409).json({
      error: `Both teams cannot ban ${banA} — that leaves ten maps in play instead of nine.`,
    });
  }

  const { error } = await supabase.from('matches')
    .update({ ban_a: banA, ban_b: banB }).eq('id', match.id);
  if (error) {
    console.error('ban write failed:', error.message);
    if (/ban_a|ban_b|column/.test(error.message)) {
      return res.status(503).json({
        error: 'The ban columns are missing — run migrations/014_map_bans.sql in the Supabase SQL editor.',
      });
    }
    return res.status(500).json({ error: 'Could not save the bans.' });
  }

  // A ban entered after a game was recorded can strand that game on a map that
  // is now banned. Reported rather than corrected — deleting somebody's
  // recorded game to make a ban fit is not a call this should make.
  const { data: played } = await supabase.from('match_games')
    .select('game_number, map').eq('match_id', match.id).not('map', 'is', null);
  const stranded = (played || []).filter((g) => !isPlayable(g.map, [banA, banB]));

  await audit(req.user, 'bracket.bans', key, { ban_a: banA, ban_b: banB, stranded: stranded.length });
  res.json({
    ok: true,
    stranded: stranded.map((g) => ({ game_number: g.game_number, map: g.map })),
    ...(await bracketState(t.id)),
  });
});

/**
 * When this match is played.
 *
 * A plain instant, sent as ISO from a browser that read it off a local
 * datetime picker. Stored as timestamptz so every reader renders it in their
 * own zone — a tournament spread across a continent cannot agree on "8pm".
 *
 * Null clears it. A match with no time is the normal state for most of a
 * bracket: the losers-bracket round 4 fixture does not have a time until the
 * teams in it are known.
 */
organizerRouter.put('/schedule', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const key = String(req.body?.key || '');
  const raw = req.body?.scheduled_at;

  let when = null;
  if (raw) {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'That is not a date.' });
    when = d.toISOString();
  }

  const { data, error } = await supabase.from('matches')
    .update({ scheduled_at: when })
    .eq('tournament_id', t.id).eq('key', key)
    .select('key').maybeSingle();
  if (error) {
    console.error('schedule write failed:', error.message);
    return res.status(500).json({ error: 'Could not save that time.' });
  }
  if (!data) return res.status(404).json({ error: 'No such match.' });

  await audit(req.user, 'bracket.schedule', key, { scheduled_at: when });
  res.json({ ok: true, ...(await bracketState(t.id)) });
});

/** How long this series is. A grand final is often longer than the rounds. */
organizerRouter.put('/best-of', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const bestOf = Number(req.body?.best_of);
  if (!isBestOf(bestOf)) {
    return res.status(400).json({
      error: 'A series is an odd number of games, 1 to 9 — an even one can be drawn.',
    });
  }

  const key = String(req.body?.key || '');
  const { error } = await supabase.from('matches').update({ best_of: bestOf })
    .eq('tournament_id', t.id).eq('key', key);
  if (error) return res.status(500).json({ error: 'Could not change that.' });

  // Shortening a series can decide one that was not, and lengthening can
  // un-decide one that was.
  const out = await recompute(t, key, req.user?.username);
  if (out.error) return res.status(out.code || 500).json({ error: out.error });

  await audit(req.user, 'bracket.best_of', key, { best_of: bestOf });
  res.json({ ok: true, ...(await bracketState(t.id)) });
});

/**
 * Record a result directly, with no games.
 *
 * Kept for the cases that have none to record: a forfeit, a disqualification, a
 * team that never turned up. It writes a one-game series underneath so the
 * bracket and the games never disagree about what happened.
 *
 * The winner is stated explicitly and is never inferred. When scoreboards are
 * read from screenshots the colours on the image are a suggestion — a
 * tournament result decided by an OCR pass on a team colour is a result nobody
 * can defend.
 */
organizerRouter.post('/result', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const key = String(req.body?.key || '');
  const winnerId = req.body?.winner_team_id;
  if (!key || !winnerId) return res.status(400).json({ error: 'Send the match and the winning team.' });

  const { data: match } = await supabase.from('matches')
    .select('id, key, best_of, team_a_id, team_b_id, status')
    .eq('tournament_id', t.id).eq('key', key).maybeSingle();
  if (!match) return res.status(404).json({ error: 'No such match in this bracket.' });
  if (match.status === 'complete') {
    return res.status(409).json({ error: 'That match already has a result — undo it first to change it.' });
  }
  if (![match.team_a_id, match.team_b_id].includes(winnerId)) {
    return res.status(400).json({ error: 'That team is not in this match.' });
  }

  // Written as GAMES rather than straight onto the match, because the series is
  // now the thing that decides a match and a winner recorded around it would be
  // a bracket that disagrees with its own scoresheet. A forfeit is the whole
  // series conceded, so it is exactly the games it takes to win one, with no
  // map on any of them — nothing was played.
  const { toWin } = require('../shared/series.cjs');
  const need = toWin(match.best_of);
  const games = Array.from({ length: need }, (_, i) => ({
    tournament_id: t.id,
    match_id: match.id,
    game_number: i + 1,
    winner_team_id: winnerId,
    decided_at: new Date().toISOString(),
    decided_by: `${req.user?.username || 'organizer'} (awarded)`,
  }));

  const { error } = await supabase.from('match_games')
    .upsert(games, { onConflict: 'match_id,game_number' });
  if (error) {
    console.error('awarded result write failed:', error.message);
    return res.status(500).json({ error: 'Could not record that result.' });
  }

  const out = await recompute(t, key, req.user?.username);
  if (out.error) return res.status(out.code || 500).json({ error: out.error });

  await audit(req.user, 'bracket.result', key, { winner: winnerId, awarded: true, games: need });
  res.json({
    ok: true,
    reset: out.result?.reset,
    champion: out.result?.champion,
    eliminated: out.result?.eliminated,
    ...(await bracketState(t.id)),
  });
});

organizerRouter.post('/undo', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const rows = await readMatches(t.id);
  const decided = rows
    .filter((r) => r.status === 'complete' && r.decided_by !== 'bye' && r.decided_at)
    .sort((a, b) => new Date(b.decided_at) - new Date(a.decided_at));
  if (!decided.length) return res.status(409).json({ error: 'No results to undo.' });

  const last = decided[0];

  // Everything this result could have fed. Clearing only the match itself would
  // leave the team it advanced sitting in the next round with nothing behind
  // them — a bracket that reads as though they got there on their own.
  const downstream = new Set([last.key]);
  let grew = true;
  while (grew) {
    grew = false;
    rows.forEach((r) => {
      if (downstream.has(r.key)) return;
      const feeds = ['slot_a', 'slot_b'].some((s) => r[s]?.of && downstream.has(r[s].of));
      if (feeds) { downstream.add(r.key); grew = true; }
    });
  }

  for (const key of downstream) {
    const isLast = key === last.key;
    const { error } = await supabase.from('matches').update({
      winner_team_id: null, loser_team_id: null, status: 'pending',
      decided_at: null, decided_by: null,
      // The undone match keeps its teams; everything after it loses them,
      // because those teams only got there because of the result being undone.
      ...(isLast ? {} : { team_a_id: null, team_b_id: null }),
    }).eq('tournament_id', t.id).eq('key', key);
    if (error) {
      console.error('undo failed:', error.message);
      return res.status(500).json({ error: 'The bracket is half-undone — reload it.' });
    }
  }

  try {
    await settle(t.id);
  } catch (err) {
    console.error(err.message);
  }

  // The games as well. A match whose result is cleared while its games still
  // say 2-0 is a match that the very next recompute would decide all over
  // again — undo would appear to do nothing.
  const { error: gErr } = await supabase.from('match_games').delete().eq('match_id', last.id);
  if (gErr) console.warn(`undo left games behind on ${last.key}: ${gErr.message}`);

  await audit(req.user, 'bracket.undo', last.key, { winner: last.winner_team_id, cleared: downstream.size });
  res.json({ ok: true, undone: last.key, cleared: downstream.size, ...(await bracketState(t.id)) });
});

organizerRouter.delete('/', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  // Same guard as the draft's reset: the tournament's own name, typed. This
  // erases every result in the tournament.
  if (String(req.body?.confirm ?? '').trim() !== t.name) {
    return res.status(400).json({ error: `Type the tournament's name exactly — "${t.name}" — to clear the bracket.` });
  }

  const { error } = await supabase.from('matches').delete().eq('tournament_id', t.id);
  if (error) return res.status(500).json({ error: 'Could not clear the bracket.' });

  await audit(req.user, 'bracket.clear', null, null);
  res.json({ ok: true, exists: false, matches: [], teams: [] });
});

module.exports = { router, organizerRouter, bracketState, settle };
