// backend/parties.js — who sits where, once a team is drafted.
//
// ⚠️  THE SAME RULE AS backend/board.js, and it covers READS TOO: `team_id`
// comes from the caller's captaincy and NEVER from the request body or the URL.
// There is no team id to tamper with, so "can I read team 4's comp" is not a
// question this file can get wrong.
//
// A comp IS competitive information. The first version of this file let any
// signed-in user read every team's, on the reasoning that a comp is the thing
// captains screenshot into Discord — which confuses "shared when its captain
// chooses to post it" with "readable by the opposition while it is being
// built". They are opposites. Knowing which six an opponent has put in their
// objective party is worth as much as knowing their draft board, and that is
// the thing this app is most careful about.
//
// ORGANIZERS SEE EVERYTHING, and that is the one place this differs from
// board.js, which exempts nobody. A draft board is a private working note that
// nothing official ever needs to read; a comp is the team that takes the field,
// and an organizer checking a fielded party against the template has to be able
// to look at it. If that is not wanted, the branch is `visibleTeams` below and
// removing it makes this identical to the board's rule.
//
// A signed-in player who captains nothing sees NO comps, including their own
// team's. That is stricter than it needs to be for their own side and is the
// safe direction: sixty-six people who can each screenshot a comp is not a
// secret, and "let a player see the party they are in" is a different feature
// with a different blast radius.
const express = require('express');
const { supabase, currentTournament, audit } = require('./db');
const { captaincyFor, rostersByTeam } = require('./teams');
const { canFill, startersPerTeam } = require('../shared/parties.cjs');

const router = express.Router();

const SEAT = 'signup_id, party_index, slot_index';

const template = (t) => (Array.isArray(t.party_template) ? t.party_template : []);

/**
 * The slot type at one seat, or null if the template has no such seat.
 *
 * Every placement is checked through this rather than against a party count
 * and a party size, because the template is the only thing that knows a party
 * can have been resized. A seat that does not exist is refused here rather
 * than written and then rendered nowhere.
 */
function slotTypeAt(tpl, partyIndex, slotIndex) {
  const party = tpl[partyIndex];
  if (!party) return null;
  return (party.slots || [])[slotIndex] ?? null;
}

// Every seating for one team, in reading order.
async function seatsFor(tournamentId, teamId) {
  const { data, error } = await supabase
    .from('team_party_slots').select(SEAT)
    .eq('tournament_id', tournamentId).eq('team_id', teamId)
    .order('party_index', { ascending: true }).order('slot_index', { ascending: true });
  if (error) throw new Error(`party slots read failed: ${error.message}`);
  return data || [];
}

// A unique violation here is one of exactly two things, and they need
// different sentences — "they are already somewhere" and "that seat is taken"
// send a captain to different places on the board.
function conflictMessage(error) {
  const detail = `${error.message || ''} ${error.details || ''}`;
  if (/party_slots_one_seat_per_player/.test(detail)) return 'They are already in a party — move them rather than adding them twice.';
  if (/party_slots_one_player_per_seat/.test(detail)) return 'Somebody is already in that seat — the board has moved since you loaded it.';
  if (/party_slots_on_the_roster/.test(detail)) return 'They are not on your roster.';
  return null;
}

/**
 * Which teams' comps this caller may read.
 *
 * Pure, and exported for the test, because it is the one function in this file
 * where being wrong is a leak rather than a bug — and the first version of it
 * WAS wrong, returning every team to everybody. A rule that only exists inside
 * a route handler is a rule with no test holding it in place.
 *
 * Organizers see all; a captain sees the one they captain; everybody else sees
 * none. Note the `mine?.id` guard: without it, a non-captain would match every
 * team whose id is undefined — which is none of them today, and would be all
 * of them the day `teams` is called with a partial row.
 */
function visibleTeamsFor(allTeams, mine, user) {
  if (user?.isOrganizer) return allTeams;
  if (!mine?.id) return [];
  return allTeams.filter((x) => x.id === mine.id);
}

/**
 * The caller's own team, or null.
 *
 * Read from the database on the request, not from the session, for the reason
 * captaincyFor documents: a captain swapped mid-tournament loses the ability to
 * rearrange a comp on their next request rather than whenever a cookie expires.
 */
async function myTeam(req, t) {
  const held = await captaincyFor(req.user?.id, t.id);
  return held[0] || null;
}

// ── Read: the comps you are allowed to see ──────────────────────────────────
// Your own if you captain one, all of them if you are an organizer, none
// otherwise. `?team=` FILTERS that set — it never widens it, which is why the
// filter is applied after the scoping below and not in the query.
router.get('/', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.json({ tournament: null, teams: [] });

  const tpl = template(t);

  try {
    const [teamsRes, rosters, mine] = await Promise.all([
      supabase.from('teams').select('id, name, tag, seed').eq('tournament_id', t.id)
        .order('seed', { ascending: true, nullsFirst: false }),
      rostersByTeam(t.id),
      myTeam(req, t),
    ]);
    if (teamsRes.error) throw new Error(teamsRes.error.message);

    // THE SCOPE. Everything below works from this list and never from the
    // full one, so a team that is not in here cannot leak through a later
    // step — including through `?team=`, which filters this and cannot reach
    // past it.
    const visibleTeams = visibleTeamsFor(teamsRes.data || [], mine, req.user);

    const wanted = req.query.team ? String(req.query.team) : null;
    const teams = visibleTeams.filter((x) => !wanted || x.id === wanted);

    // Deliberately the same answer for "no such team" and "not yours": a 403
    // would confirm the id names a real team, which is a thing an opponent
    // could go fishing for.
    if (wanted && teams.length === 0) return res.status(404).json({ error: 'Team not found.' });

    // Seats for the visible teams only. Reading them all and filtering after
    // would work today and would be the line somebody deletes later.
    const visibleIds = visibleTeams.map((x) => x.id);
    const { data: allSeats, error: seatErr } = visibleIds.length
      ? await supabase.from('team_party_slots').select(`team_id, ${SEAT}`)
        .eq('tournament_id', t.id).in('team_id', visibleIds)
      : { data: [], error: null };
    if (seatErr) throw new Error(seatErr.message);

    const byTeam = new Map();
    (allSeats || []).forEach((s) => {
      if (!byTeam.has(s.team_id)) byTeam.set(s.team_id, []);
      byTeam.get(s.team_id).push(s);
    });

    res.json({
      tournament: { name: t.name, partyCount: t.party_count, partySize: t.party_size },
      template: tpl,
      starters: startersPerTeam(tpl),
      // Which team, if any, this caller may rearrange. The page uses it to
      // decide whether to render a builder or a read-only comp; the server
      // does not trust it for anything.
      editableTeamId: mine?.id || null,
      teams: teams.map((x) => {
        const roster = rosters.get(x.id) || [];
        const seats = byTeam.get(x.id) || [];
        const seated = new Set(seats.map((s) => s.signup_id));
        return {
          ...x,
          seats,
          roster,
          // Derived, never stored: on the roster and in no seat. One
          // representation of "on the bench" means there is nothing to fall
          // out of step.
          bench: roster.filter((m) => !seated.has(m.id)),
        };
      }),
    });
  } catch (err) {
    console.error('parties read failed:', err.message);
    res.status(500).json({ error: 'Could not read the parties.' });
  }
});

// ── Write: seat somebody, or empty a seat ───────────────────────────────────
// One seat per request. A whole-board PUT was the alternative and it loses to
// this on the thing that actually happens: two captains — a captain and a
// co-captain — with the board open at once. Sending 48 seats means the last
// save wins and silently reverts the other person's work; sending one seat
// means they collide only if they touch the SAME seat, and the unique index
// turns that into an error rather than a quiet overwrite.
router.put('/slot', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const mine = await myTeam(req, t);
  if (!mine) return res.status(403).json({ error: 'Only a team\'s captains can arrange its parties.' });

  const partyIndex = Number(req.body?.party_index);
  const slotIndex = Number(req.body?.slot_index);
  if (!Number.isInteger(partyIndex) || !Number.isInteger(slotIndex)
      || partyIndex < 0 || slotIndex < 0) {
    return res.status(400).json({ error: 'That is not a seat.' });
  }

  const tpl = template(t);
  const type = slotTypeAt(tpl, partyIndex, slotIndex);
  if (!type) return res.status(400).json({ error: 'That seat is not in the party template.' });

  // Clearing a seat. Deliberately not an error when it was already empty: the
  // board sends this on a drag OUT of a party, and a captain who drops
  // somebody back where they came from should not get a red banner for it.
  if (req.body?.signup_id === null || req.body?.signup_id === undefined) {
    const { error } = await supabase.from('team_party_slots').delete()
      .eq('team_id', mine.id).eq('party_index', partyIndex).eq('slot_index', slotIndex);
    if (error) {
      console.error('party slot clear failed:', error.message);
      return res.status(500).json({ error: 'Could not empty that seat.' });
    }
    await audit(req.user, 'party.clear', mine.id, { party: partyIndex + 1, slot: slotIndex + 1 });
    return res.json({ ok: true, seats: await seatsFor(t.id, mine.id) });
  }

  const signupId = String(req.body.signup_id);

  // On THIS team's roster — checked against the table rather than trusted, so
  // the error is a sentence rather than a foreign key violation.
  const { data: member } = await supabase
    .from('team_players').select('signup_id, player:player_signups (player_name, role)')
    .eq('team_id', mine.id).eq('signup_id', signupId).maybeSingle();
  if (!member) return res.status(400).json({ error: 'They are not on your roster.' });

  // THE RULE THE TEMPLATE EXISTS FOR. A slot type names the roles that may
  // fill it, and refusing here rather than warning is the one place this app
  // enforces rather than advises — because unlike a readiness figure, which is
  // a forecast about people who have not signed up yet, this is a fact about
  // eight parties that either can be fielded or cannot.
  //
  // A player with no role recorded is allowed anywhere. They are a data gap,
  // not a declared mismatch, and blocking them would strand somebody on the
  // bench for a question they were never asked.
  const role = member.player?.role || null;
  if (role && !canFill(type, role)) {
    return res.status(409).json({
      error: `${member.player?.player_name || 'That player'} is a ${role}, and party `
        + `${partyIndex + 1} seat ${slotIndex + 1} is a ${type} seat.`,
    });
  }

  // Upsert on the SEAT, so dropping somebody onto an occupied seat replaces
  // the occupant rather than erroring — that is what the gesture means. Their
  // own previous seat is cleared first, because one player is in one seat and
  // the unique index would otherwise refuse the move.
  const { error: leaveErr } = await supabase.from('team_party_slots').delete()
    .eq('team_id', mine.id).eq('signup_id', signupId);
  if (leaveErr) {
    console.error('party slot vacate failed:', leaveErr.message);
    return res.status(500).json({ error: 'Could not move them.' });
  }

  const { error } = await supabase.from('team_party_slots')
    .upsert({
      tournament_id: t.id, team_id: mine.id, signup_id: signupId,
      party_index: partyIndex, slot_index: slotIndex,
    }, { onConflict: 'team_id,party_index,slot_index' });

  if (error) {
    const msg = conflictMessage(error);
    if (msg) return res.status(409).json({ error: msg });
    console.error('party slot write failed:', error.message);
    return res.status(500).json({ error: 'Could not seat them.' });
  }

  await audit(req.user, 'party.seat', mine.id, {
    party: partyIndex + 1, slot: slotIndex + 1, player: member.player?.player_name,
  });
  res.json({ ok: true, seats: await seatsFor(t.id, mine.id) });
});

// ── Write: bench somebody, wherever they are ────────────────────────────────
// Addressed by PLAYER rather than by seat, because that is what the gesture
// has: a card dragged out of a party and onto the bench knows who it is, and
// making the page work out which seat it left is a second chance to get it
// wrong when the board is stale.
router.put('/bench', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const mine = await myTeam(req, t);
  if (!mine) return res.status(403).json({ error: 'Only a team\'s captains can arrange its parties.' });

  const signupId = String(req.body?.signup_id || '');
  if (!signupId) return res.status(400).json({ error: 'Which player?' });

  const { error } = await supabase.from('team_party_slots').delete()
    .eq('team_id', mine.id).eq('signup_id', signupId);
  if (error) {
    console.error('party bench failed:', error.message);
    return res.status(500).json({ error: 'Could not bench them.' });
  }

  await audit(req.user, 'party.bench', mine.id, { signup_id: signupId });
  res.json({ ok: true, seats: await seatsFor(t.id, mine.id) });
});

// ── Write: empty the whole board ────────────────────────────────────────────
// Start again. Guarded by nothing, deliberately: unlike a draft reset this
// destroys no history and costs a few minutes of dragging to undo, and a
// confirm dialog on a cheap action is how people learn to click through them.
router.delete('/', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const mine = await myTeam(req, t);
  if (!mine) return res.status(403).json({ error: 'Only a team\'s captains can arrange its parties.' });

  const { error } = await supabase.from('team_party_slots').delete().eq('team_id', mine.id);
  if (error) {
    console.error('party clear failed:', error.message);
    return res.status(500).json({ error: 'Could not clear the parties.' });
  }

  await audit(req.user, 'party.clear_all', mine.id, { team: mine.name });
  res.json({ ok: true, seats: [] });
});

module.exports = { router, slotTypeAt, visibleTeamsFor, conflictMessage };
