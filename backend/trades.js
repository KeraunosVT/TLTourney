// backend/trades.js — moving players between rosters.
//
// Organizers only; mounted under requireOrganizer in server.js. There is no
// captain-facing half of this on purpose. A captain proposing and a captain
// accepting is a negotiation, and negotiations happen in Discord where they
// already happen; what the app owes them is that the agreed result is applied
// once, correctly, by somebody who can see both rosters.
//
// ── THE ONE WAY TO MOVE A DRAFTED PLAYER ────────────────────────────────────
// teams.js refuses to delete a drafted player's roster row, and is right to:
// draft.js's reconcile() would see a pick with no roster row, call it a crash,
// and write the row back within seconds. So a trade never deletes. It UPDATES
// team_id, which leaves the pick with a roster row the whole time and gives
// reconcile nothing to repair.
//
// ── WHY THE INTENT IS WRITTEN FIRST ─────────────────────────────────────────
// Applying a trade is several writes and PostgREST gives no transaction across
// them. A crash halfway leaves one roster short and the other long, both of
// them looking entirely normal — so the trades row goes in FIRST, as 'pending',
// carrying every move. If the writes then fail they are rolled back and the row
// is marked 'failed'; if the process dies before either, the row is still there
// saying what was meant to happen. See migration 033 and verify.sql.
const express = require('express');
const { supabase, currentTournament, audit } = require('./db');
const { rostersByTeam, draftUnderWay, DRAFT_FROZEN, conflictMessage } = require('./teams');
const { validateTrade, describeTrade } = require('../shared/trades.cjs');

const organizerRouter = express.Router();

const TRADE_COLS = 'id, team_a_id, team_b_id, moves, status, note, made_by, created_at, applied_at';

/** The two teams named in the body, read from THIS tournament or not at all. */
async function teamsFor(tournamentId, aId, bId) {
  const ids = [aId, bId].filter(Boolean);
  if (ids.length !== 2) return null;

  const { data } = await supabase.from('teams')
    .select('id, name, tag').eq('tournament_id', tournamentId).in('id', ids);

  if ((data || []).length !== 2) return null;
  // In the order they were asked for, so "team A" on screen is team A here —
  // `.in()` returns whatever order the database feels like.
  return [data.find((t) => t.id === aId), data.find((t) => t.id === bId)];
}

// ── History ─────────────────────────────────────────────────────────────────
// Newest first. Includes failed and pending rows rather than only applied ones:
// a trade that did not go through is a thing somebody tried to do, and hiding
// it makes a half-applied one invisible on the one page that would show it.
organizerRouter.get('/', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.json({ trades: [] });

  const { data, error } = await supabase.from('trades').select(TRADE_COLS)
    .eq('tournament_id', t.id).order('created_at', { ascending: false }).limit(100);

  if (error) {
    if (/schema cache|does not exist|relation/i.test(error.message)) {
      return res.status(503).json({
        error: 'The trades table is missing — run migrations/033_trades.sql in the '
          + 'Supabase SQL editor, then migrations/verify.sql.',
      });
    }
    console.error('trade history read failed:', error.message);
    return res.status(500).json({ error: 'Could not read the trades.' });
  }

  res.json({
    trades: (data || []).map((x) => ({ ...x, summary: describeTrade(x.moves) })),
  });
});

// ── Make one ────────────────────────────────────────────────────────────────
organizerRouter.post('/', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  // The same freeze the rest of the roster edits use. A draft in progress is
  // handing out picks against roster sizes it read when it started; moving a
  // player between two teams mid-draft changes both of those numbers under it.
  if (await draftUnderWay(t.id)) return res.status(409).json({ error: DRAFT_FROZEN });

  const teams = await teamsFor(t.id, req.body?.team_a_id, req.body?.team_b_id);
  if (!teams) return res.status(404).json({ error: 'Both teams have to be teams in this tournament.' });

  let rosters;
  try {
    rosters = await rostersByTeam(t.id);
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: 'Could not read the rosters.' });
  }

  // Every rule lives in shared/trades.cjs, so this is the same answer the form
  // gave before the button was pressed.
  const check = validateTrade(req.body?.moves, rosters, teams);
  if (!check.ok) return res.status(400).json({ error: check.errors[0], errors: check.errors });

  const note = String(req.body?.note || '').trim().slice(0, 280) || null;

  // ── 1. The intent, before anything moves ──────────────────────────────────
  const { data: trade, error: tradeErr } = await supabase.from('trades').insert({
    tournament_id: t.id,
    team_a_id: teams[0].id,
    team_b_id: teams[1].id,
    moves: check.moves,
    status: 'pending',
    note,
    // The username, the way draft.js records who made a pick. Never the
    // Discord id as a fallback: this is rendered in the history list, and an id
    // there is a number nobody can read standing where a name should be.
    made_by: req.user?.username || null,
  }).select(TRADE_COLS).single();

  if (tradeErr || !trade) {
    if (/schema cache|does not exist|relation/i.test(tradeErr?.message || '')) {
      return res.status(503).json({
        error: 'The trades table is missing — run migrations/033_trades.sql in the '
          + 'Supabase SQL editor, then migrations/verify.sql.',
      });
    }
    console.error('trade record failed:', tradeErr?.message);
    return res.status(500).json({ error: 'Could not record the trade.' });
  }

  const ids = check.moves.map((m) => m.signup_id);

  // ── 2. Empty their party seats ────────────────────────────────────────────
  // Not optional and not cosmetic: team_party_slots has a foreign key on
  // (team_id, signup_id) into team_players, so the move in step 3 would be
  // REFUSED by the database while a seat still points at the old pairing.
  //
  // It is also the right thing to do on its own. A traded player is not in
  // their old team's comp any more, and leaving the seat filled would show a
  // party with somebody in it who plays for the other side.
  //
  // The rows are read before they are deleted so a rollback can put them back;
  // nothing else in the app remembers where somebody was sitting.
  const { data: seats } = await supabase.from('team_party_slots')
    .select('tournament_id, team_id, signup_id, party_index, slot_index')
    .eq('tournament_id', t.id).in('signup_id', ids);

  const { error: seatErr } = await supabase.from('team_party_slots')
    .delete().eq('tournament_id', t.id).in('signup_id', ids);

  if (seatErr) {
    console.error('trade could not clear party seats:', seatErr.message);
    await supabase.from('trades').update({ status: 'failed' }).eq('id', trade.id);
    return res.status(500).json({
      error: 'Could not empty the party seats of the players being traded, so nothing was moved.',
    });
  }

  // ── 3. Move them ──────────────────────────────────────────────────────────
  const applied = [];
  let failure = null;
  const movedAt = new Date().toISOString();

  for (const move of check.moves) {
    // What the row said before, so a rollback restores it rather than blanking
    // it — a player traded twice has a real earlier `traded_from_team_id`.
    const { data: before } = await supabase.from('team_players')
      .select('traded_from_team_id, traded_at')
      .eq('tournament_id', t.id).eq('signup_id', move.signup_id).maybeSingle();

    // Scoped to the team they are supposed to be LEAVING. If another organizer
    // moved them a second ago this matches nothing, and a trade built against a
    // stale roster stops here instead of dragging somebody off a third team.
    const { data: updated, error } = await supabase.from('team_players')
      .update({
        team_id: move.to_team_id,
        traded_from_team_id: move.from_team_id,
        traded_at: movedAt,
      })
      .eq('tournament_id', t.id)
      .eq('signup_id', move.signup_id)
      .eq('team_id', move.from_team_id)
      .select('id');

    if (error) {
      failure = conflictMessage(error) || `Could not move ${move.player_name}.`;
      console.error(`trade move failed (${move.player_name}):`, error.message);
      break;
    }
    if (!updated || updated.length === 0) {
      failure = `${move.player_name} is no longer on ${move.from_team || 'that team'} — `
        + 'somebody changed the rosters while this trade was being made. Nothing was moved.';
      break;
    }

    applied.push({ ...move, prior: before || { traded_from_team_id: null, traded_at: null } });
  }

  // ── 4. If any of it failed, put it all back ───────────────────────────────
  if (failure) {
    const stuck = [];
    for (const move of applied) {
      const { error } = await supabase.from('team_players')
        .update({
          team_id: move.from_team_id,
          traded_from_team_id: move.prior.traded_from_team_id,
          traded_at: move.prior.traded_at,
        })
        .eq('tournament_id', t.id).eq('signup_id', move.signup_id);
      if (error) {
        console.error(`TRADE ROLLBACK FAILED for ${move.player_name}:`, error.message);
        stuck.push(move.player_name);
      }
    }

    // Seats come back only if everybody did. Re-seating somebody on a team they
    // are now stuck off would violate the same foreign key that made step 2
    // necessary.
    if (stuck.length === 0 && seats?.length) {
      const { error: reseatErr } = await supabase.from('team_party_slots').insert(seats);
      if (reseatErr) console.warn('trade rollback could not restore party seats:', reseatErr.message);
    }

    // 'pending' is left deliberately when the rollback did not finish: the row
    // is the only remaining record of who is where, and verify.sql looks for
    // exactly this.
    await supabase.from('trades')
      .update({ status: stuck.length ? 'pending' : 'failed' }).eq('id', trade.id);

    await audit(req.user, 'trade.failed', trade.id, {
      reason: failure, rolled_back: applied.length, stuck,
    });

    return res.status(stuck.length ? 500 : 409).json({
      error: stuck.length
        ? `${failure} ${stuck.join(', ')} could not be put back — this trade is half-applied. `
          + 'Check the rosters before doing anything else.'
        : failure,
      trade_id: trade.id,
    });
  }

  // ── 5. It happened ────────────────────────────────────────────────────────
  const { data: done } = await supabase.from('trades')
    .update({ status: 'applied', applied_at: movedAt })
    .eq('id', trade.id).select(TRADE_COLS).single();

  const summary = describeTrade(check.moves);
  await audit(req.user, 'trade.apply', trade.id, {
    summary,
    teams: teams.map((x) => x.name),
    players: check.moves.length,
    seats_emptied: seats?.length || 0,
    note,
  });

  res.json({
    trade: { ...(done || trade), status: 'applied', summary },
    sizes: check.sizes,
    // Worth saying rather than leaving to be discovered: their old team's comp
    // now has an empty seat where they were.
    seatsEmptied: seats?.length || 0,
  });
});

module.exports = { organizerRouter };
