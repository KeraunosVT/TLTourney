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

const COLS = 'id, key, bracket, round, idx, slot_a, slot_b, team_a_id, team_b_id, '
  + 'winner_team_id, loser_team_id, kind, advances, status, is_reset, scheduled_at, '
  + 'decided_at, decided_by, scoreboard_at';

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
  const [rows, teamsRes] = await Promise.all([
    readMatches(tournamentId),
    supabase.from('teams').select(TEAM).eq('tournament_id', tournamentId)
      .order('seed', { ascending: true, nullsFirst: false }),
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
    .map((r) => ({
      ...r,
      label: roundLabel(r, { winnersRounds, losersRounds }),
      team_a: byId.get(r.team_a_id) || null,
      team_b: byId.get(r.team_b_id) || null,
      winner: byId.get(r.winner_team_id) || null,
    }));

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
    counts: {
      total: matches.filter((m) => m.kind === 'match').length,
      complete: matches.filter((m) => m.kind === 'match' && m.status === 'complete').length,
      ready: matches.filter((m) => m.status === 'ready').length,
    },
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
    .from('matches').select('key, status').eq('tournament_id', t.id);
  if (exErr) {
    if (/schema cache|does not exist|relation/i.test(exErr.message)) {
      return res.status(503).json({
        error: 'The bracket table is missing — run migrations/011_bracket.sql first.',
      });
    }
    return res.status(500).json({ error: 'Could not read the existing bracket.' });
  }

  const played = (existing || []).filter((m) => m.status === 'complete' && m.key);
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
  const bySeed = new Map(teams.map((x) => [x.seed, x.id]));
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
 * Record a result.
 *
 * The winner is stated explicitly and is never inferred. Later, when scoreboards
 * are read from screenshots, the colours on the image are a suggestion — a
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

  let rows;
  try {
    rows = await readMatches(t.id);
  } catch (err) {
    return res.status(500).json({ error: 'Could not read the bracket.' });
  }

  const row = rows.find((r) => r.key === key);
  if (!row) return res.status(404).json({ error: 'No such match in this bracket.' });
  if (row.status === 'complete') {
    return res.status(409).json({ error: 'That match already has a result — clear it first to change it.' });
  }

  const result = applyResult(rows.map(toEngine), key, winnerId);
  if (result.error) return res.status(409).json({ error: result.error });

  // The match itself first. If the writes below fail, a recorded result with
  // an un-advanced team is recoverable by re-running settle; an advanced team
  // with no recorded result is a bracket nobody can explain.
  const { error: mErr } = await supabase.from('matches').update({
    winner_team_id: result.winnerId,
    loser_team_id: result.loserId,
    status: 'complete',
    decided_at: new Date().toISOString(),
    decided_by: req.user?.username || null,
  }).eq('tournament_id', t.id).eq('key', key);
  if (mErr) {
    console.error('result write failed:', mErr.message);
    return res.status(500).json({ error: 'Could not record that result.' });
  }

  for (const w of result.writes) {
    const { error } = await supabase.from('matches')
      .update({ [`team_${w.slot}_id`]: w.teamId })
      .eq('tournament_id', t.id).eq('key', w.key);
    if (error) {
      console.error('advance failed:', error.message);
      return res.status(500).json({
        error: 'The result was recorded but the teams did not advance — reload the bracket.',
      });
    }
  }

  try {
    await settle(t.id);
  } catch (err) {
    console.error(err.message);
  }

  await audit(req.user, 'bracket.result', key, {
    winner: result.winnerId, loser: result.loserId,
    eliminated: result.eliminated, reset: result.reset, champion: result.champion,
  });

  res.json({
    ok: true,
    reset: result.reset,
    champion: result.champion,
    eliminated: result.eliminated,
    ...(await bracketState(t.id)),
  });
});

/**
 * Take back the most recent result.
 *
 * Undoing one match means unwinding everything downstream of it, because a team
 * that advanced on this result may already have been written into two more
 * slots. Rather than tracking that, the bracket is rebuilt: clear every result
 * from this match onwards by decision time, then re-seed and re-settle.
 */
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
