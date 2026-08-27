// backend/teams.js — teams, their captains, and whether the pool can fill them.
//
// Two routers: one anybody signed in may read (teams aren't secret), one behind
// requireOrganizer for everything that changes them.
const express = require('express');
const { supabase, currentTournament, audit } = require('./db');
const { roleDemand, startersPerTeam } = require('../shared/parties.cjs');
const { ROLES } = require('../shared/roles.cjs');
const { MAX_CAPTAINS_PER_TEAM, isSeat, seatLabel, firstFreeSeat } = require('../shared/captains.cjs');
const { VIA_CAPTAIN, rosterProgress } = require('../shared/roster.cjs');

const TEAM = 'id, name, tag, seed, created_at, updated_at';

// Captains are read as their own query and stitched in below rather than
// embedded in the team select. team_captains reaches teams through a COMPOSITE
// foreign key (team_id, tournament_id) — the thing that stops a captain row
// naming a team in another tournament — and asking PostgREST to embed across
// that is a relationship-inference question with a worse failure mode than one
// extra round trip. The signup embed inside it is a plain single-column FK.
const CAPTAIN_ROWS = `team_id, seat, signup:player_signups (
  id, player_name, discord_id, discord_username, role, classes, positions
)`;

// A unique-violation is never a server fault — it is two teams given the same
// seed or the same name, or a captain being put somewhere they can't go. Say
// which, because the generic message sends an organizer looking at the wrong
// thing entirely.
function conflictMessage(error) {
  const detail = `${error.message || ''} ${error.details || ''}`;
  if (/teams_seed_unique/.test(detail)) return 'Another team already has that seed.';
  if (/teams_name_unique/.test(detail)) return 'A team with that name already exists.';
  if (/team_captains_one_team_per_person/.test(detail)) return 'That player is already captaining another team.';
  if (/team_captains_once_per_team/.test(detail)) return 'They already hold the other seat on this team.';
  if (/team_captains_seat_unique/.test(detail)) return 'Somebody already holds that seat — remove them first.';
  if (/team_players_one_team_per_person/.test(detail)) return 'That player is already on another team.';
  if (/team_players_once_per_team/.test(detail)) return 'They are already on this roster.';
  return null;
}

// Every captain seat in the tournament, keyed by team.
async function captainsByTeam(tournamentId) {
  const { data, error } = await supabase
    .from('team_captains').select(CAPTAIN_ROWS)
    .eq('tournament_id', tournamentId).order('seat', { ascending: true });
  if (error) throw new Error(`captains read failed: ${error.message}`);

  const byTeam = new Map();
  (data || []).forEach((row) => {
    if (!byTeam.has(row.team_id)) byTeam.set(row.team_id, []);
    byTeam.get(row.team_id).push({ seat: row.seat, label: seatLabel(row.seat), ...row.signup });
  });
  return byTeam;
}

const withCaptains = (teams, byTeam) =>
  teams.map((t) => ({ ...t, captains: byTeam.get(t.id) || [] }));

// Everybody on a roster in this tournament, keyed by team.
const ROSTER_ROWS = `team_id, via, draft_round, draft_pick, player:player_signups (
  id, player_name, discord_id, discord_username, role, classes, positions
)`;

async function rostersByTeam(tournamentId) {
  const { data, error } = await supabase
    .from('team_players').select(ROSTER_ROWS).eq('tournament_id', tournamentId);
  if (error) throw new Error(`rosters read failed: ${error.message}`);

  const byTeam = new Map();
  (data || []).filter((r) => r.player).forEach((row) => {
    if (!byTeam.has(row.team_id)) byTeam.set(row.team_id, []);
    byTeam.get(row.team_id).push({
      via: row.via,
      draft_round: row.draft_round,
      draft_pick: row.draft_pick,
      ...row.player,
    });
  });

  // Captains first, then drafted in pick order, then everyone else by name —
  // the order a roster is actually read in.
  byTeam.forEach((list) => list.sort((a, b) => (
    (a.via === VIA_CAPTAIN ? 0 : 1) - (b.via === VIA_CAPTAIN ? 0 : 1)
    || (a.draft_pick ?? 1e9) - (b.draft_pick ?? 1e9)
    || a.player_name.localeCompare(b.player_name)
  )));
  return byTeam;
}

// Every signup already attached to a team, anywhere in the tournament. This is
// the set that must not appear as an available player — to any captain, not
// just their own.
async function rosteredIds(tournamentId) {
  const { data, error } = await supabase
    .from('team_players').select('signup_id').eq('tournament_id', tournamentId);
  if (error) throw new Error(`roster ids read failed: ${error.message}`);
  return new Set((data || []).map((r) => r.signup_id));
}

/**
 * Put a player on a team — the ONLY way anybody joins one.
 *
 * Seating a captain goes through here, and so will every draft pick. That is
 * the point of it existing: joining a roster and disappearing from the boards
 * are one action, and a second code path that does the first without the second
 * leaves a drafted player sitting on four captains' boards looking available.
 * There is no way to add somebody to a team and forget, because there is only
 * one door.
 *
 * Board entries are DELETED rather than flagged. A name a captain cannot pick
 * is not information, it is a line to scroll past on the one night nobody has
 * time to scroll — and the pool it came from is hundreds long.
 *
 * Returns { error } on failure, or { clearedFrom } — the teams whose boards
 * lost an entry, so a caller can say whose plans just changed.
 */
async function addToRoster(tournamentId, teamId, signupId, via, extra = {}) {
  const { error } = await supabase.from('team_players').insert({
    tournament_id: tournamentId, team_id: teamId, signup_id: signupId, via, ...extra,
  });
  if (error) return { error };

  // Deliberately after the insert, and deliberately not fatal. The roster row
  // is the fact; a board is a working note about who to pick. If this delete
  // fails the player is still correctly on the team, and the board page's
  // `taken` flag keeps the stale entry from reading as available until the next
  // successful write clears it.
  const { data, error: clearErr } = await supabase
    .from('draft_board_entries').delete()
    .eq('tournament_id', tournamentId).eq('signup_id', signupId)
    .select('team_id');

  if (clearErr) {
    console.warn(`roster add left board entries behind (signup ${signupId}): ${clearErr.message}`);
    return { clearedFrom: [] };
  }
  return { clearedFrom: (data || []).map((r) => r.team_id) };
}

/**
 * Who an organizer may still put in a captain's seat.
 *
 * Anybody already attached to a team is out — a co-captain, and once the draft
 * runs, a drafted player. Filtering on seat 1 alone would keep offering a
 * team's co-captain to every other team, and the database would then refuse the
 * assignment with a constraint error at the end of the click.
 *
 * Takes the rostered set rather than the captain list, because "already on a
 * team" is the real question and captaincy is only one way to be on one.
 *
 * Volunteers first because they said yes, but everyone approved is offered,
 * since an organizer sometimes has to go and ask someone who didn't.
 *
 * Pure, and exported for the test.
 */
function captainCandidates(approved, rostered) {
  const taken = rostered instanceof Set
    ? rostered
    : new Set((rostered || []).map((c) => c.id).filter(Boolean));
  return approved
    .filter((s) => !taken.has(s.id))
    .sort((a, b) => (b.wants_captain === true) - (a.wants_captain === true)
      || a.player_name.localeCompare(b.player_name));
}

/**
 * Which teams this Discord user captains — THE identity check.
 *
 * Captaincy is not a Discord role and not a session claim. It is a row in
 * team_captains pointing at a player_signups row that carries the discord_id,
 * so it is read from the database on the request that needs it. That matters
 * for the draft: a captain swapped an hour into draft night takes effect on the
 * next request, not whenever a seven-day cookie happens to be reissued.
 */
async function captaincyFor(discordId, tournamentId) {
  if (!supabase || !discordId || !tournamentId) return [];

  // Their signup is the link between the Discord session and the seat.
  const { data: signup } = await supabase
    .from('player_signups').select('id')
    .eq('tournament_id', tournamentId).eq('discord_id', discordId).maybeSingle();
  if (!signup) return [];

  const { data: seats, error } = await supabase
    .from('team_captains').select('team_id, seat')
    .eq('tournament_id', tournamentId).eq('signup_id', signup.id);
  if (error) {
    console.error('captaincy read failed:', error.message);
    return [];
  }
  if (!seats?.length) return [];

  const { data: teams } = await supabase
    .from('teams').select(TEAM).in('id', seats.map((s) => s.team_id));

  return (teams || []).map((t) => {
    const seat = seats.find((s) => s.team_id === t.id);
    return { ...t, seat: seat.seat, label: seatLabel(seat.seat) };
  });
}

// ── Public: the teams ───────────────────────────────────────────────────────
const publicRouter = express.Router();

publicRouter.get('/', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.json({ teams: [] });

  const { data, error } = await supabase
    .from('teams')
    .select(TEAM)
    .eq('tournament_id', t.id)
    // Unseeded teams last rather than first: nullsFirst defaults true on an
    // ascending order in PostgREST, which would put every team still being set
    // up above the ones that are ready.
    .order('seed', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true });

  if (error) {
    console.error('teams read failed:', error.message);
    return res.status(500).json({ error: 'Could not read the teams.' });
  }

  try {
    const [byTeam, rosters] = await Promise.all([captainsByTeam(t.id), rostersByTeam(t.id)]);
    res.json({
      teams: withCaptains(data || [], byTeam).map((x) => ({
        ...x,
        roster: rosters.get(x.id) || [],
        progress: rosterProgress(rosters.get(x.id) || [], t.roster_size),
      })),
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not read the teams.' });
  }
});

// ── Am I a captain? ─────────────────────────────────────────────────────────
// What the draft will gate on, and what the site uses to tell somebody they're
// running a team. Answered from the database, not from the session cookie —
// see captaincyFor.
publicRouter.get('/mine', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.json({ captainOf: [] });
  res.json({ captainOf: await captaincyFor(req.user?.id, t.id) });
});

// ── Organizer ───────────────────────────────────────────────────────────────
const organizerRouter = express.Router();

// Everything an organizer needs on one screen: the teams, who is available to
// captain, and whether the pool can actually fill what has been created.
organizerRouter.get('/', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.json({ tournament: null, teams: [], candidates: [], readiness: null });

  const [teamsRes, signupsRes] = await Promise.all([
    supabase.from('teams').select(TEAM).eq('tournament_id', t.id)
      .order('seed', { ascending: true, nullsFirst: false }).order('name', { ascending: true }),
    supabase.from('player_signups')
      .select('id, player_name, discord_id, discord_username, role, classes, positions, wants_captain, status')
      .eq('tournament_id', t.id).eq('status', 'approved'),
  ]);

  if (teamsRes.error || signupsRes.error) {
    console.error('teams page read failed:', (teamsRes.error || signupsRes.error).message);
    return res.status(500).json({ error: 'Could not load the teams page.' });
  }

  let byTeam;
  let rosters;
  try {
    [byTeam, rosters] = await Promise.all([captainsByTeam(t.id), rostersByTeam(t.id)]);
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: 'Could not load the teams page.' });
  }

  const approved = signupsRes.data || [];
  const teams = withCaptains(teamsRes.data || [], byTeam).map((x) => {
    const members = rosters.get(x.id) || [];
    return { ...x, roster: members, progress: rosterProgress(members, t.roster_size) };
  });

  // Anyone already on a team is not available to captain another one.
  const taken = new Set(teams.flatMap((x) => x.roster).map((m) => m.id));

  res.json({
    tournament: t,
    teams,
    candidates: captainCandidates(approved, taken),
    maxCaptains: MAX_CAPTAINS_PER_TEAM,
    readiness: readiness(t, teams.length, approved),
  });
});

/**
 * Can this pool fill these teams?
 *
 * Reported per role as a range, because two of the five slot types accept more
 * than one role. A single "tanks needed" figure would either count every
 * flexible slot as a tank requirement or none of them, and both are wrong in a
 * way that changes what an organizer does next.
 *
 * `min` is the floor: below it the roster CANNOT be built, whoever volunteers.
 * `max` is the ceiling: past it the extra people can only be substitutes.
 */
function readiness(t, teamCount, approved) {
  const template = Array.isArray(t.party_template) ? t.party_template : [];
  const demand = roleDemand(template, teamCount);

  const have = {};
  ROLES.forEach((r) => { have[r] = 0; });
  let unanswered = 0;
  approved.forEach((s) => {
    if (s.role && have[s.role] !== undefined) have[s.role] += 1;
    else unanswered += 1;
  });

  const rosterSpots = teamCount * (t.roster_size || 0);

  return {
    teams: teamCount,
    rosterSize: t.roster_size,
    starters: teamCount * startersPerTeam(template),
    subs: teamCount * (t.sub_count || 0),
    needed: rosterSpots,
    approved: approved.length,
    short: Math.max(0, rosterSpots - approved.length),
    // Signups filed before migration 002 have no role. Counted separately
    // rather than folded into a role, so the shortfall figures describe people
    // who actually answered.
    unanswered,
    roles: ROLES.map((role) => ({
      role,
      have: have[role],
      min: demand[role].min,
      max: demand[role].max,
      short: Math.max(0, demand[role].min - have[role]),
    })),
  };
}

// ── Create ──────────────────────────────────────────────────────────────────
organizerRouter.post('/', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'The team needs a name.' });
  if (name.length > 40) return res.status(400).json({ error: 'Team names are 40 characters or fewer.' });

  const tag = String(req.body?.tag ?? '').trim().toUpperCase() || null;
  if (tag && tag.length > 6) return res.status(400).json({ error: 'Tags are 6 characters or fewer.' });

  // Seeded on creation, at the end, so a team is never sitting without one and
  // an organizer who doesn't care about order never has to think about it.
  const { data: last } = await supabase
    .from('teams').select('seed').eq('tournament_id', t.id)
    .not('seed', 'is', null).order('seed', { ascending: false }).limit(1).maybeSingle();

  const { data, error } = await supabase
    .from('teams')
    .insert({ tournament_id: t.id, name, tag, seed: (last?.seed || 0) + 1 })
    .select(TEAM)
    .single();

  if (error) {
    const msg = conflictMessage(error);
    if (msg) return res.status(409).json({ error: msg });
    console.error('team create failed:', error.message);
    return res.status(500).json({ error: 'Could not create that team.' });
  }

  await audit(req.user, 'team.create', data.id, { name, tag });
  res.json({ team: { ...data, captains: [] } });
});

// ── Update: name, tag, seed ─────────────────────────────────────────────────
// Captains are NOT edited here — they have their own endpoints below, because
// a captain is a row now and PUTting a team is not the place to be inserting
// and deleting them.
organizerRouter.put('/:id', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const patch = {};

  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'The team needs a name.' });
    patch.name = name.slice(0, 40);
  }
  if (req.body?.tag !== undefined) {
    patch.tag = String(req.body.tag).trim().toUpperCase().slice(0, 6) || null;
  }
  if (req.body?.seed !== undefined) {
    if (req.body.seed === null) {
      patch.seed = null;
    } else {
      const n = Number(req.body.seed);
      if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: 'A seed is a whole number, 1 or higher.' });
      patch.seed = n;
    }
  }

  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to change.' });

  const { data, error } = await supabase
    .from('teams').update(patch)
    .eq('id', req.params.id).eq('tournament_id', t.id)
    .select(TEAM).maybeSingle();

  if (error) {
    const msg = conflictMessage(error);
    if (msg) return res.status(409).json({ error: msg });
    console.error('team update failed:', error.message);
    return res.status(500).json({ error: 'Could not save that.' });
  }
  if (!data) return res.status(404).json({ error: 'Team not found.' });

  await audit(req.user, 'team.update', data.id, patch);
  res.json({ team: data });
});

// ── Captains ────────────────────────────────────────────────────────────────
// Two seats per team. Both seats can do everything a captain can do; the seat
// number is order and a cap, not a permission level. See shared/captains.cjs.

// Seat somebody. `seat` is optional — omitted, they take the lowest free one,
// which is what an organizer filling a team top to bottom actually wants.
organizerRouter.post('/:id/captains', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const { data: team } = await supabase
    .from('teams').select('id, name').eq('id', req.params.id).eq('tournament_id', t.id).maybeSingle();
  if (!team) return res.status(404).json({ error: 'Team not found.' });

  // Checked against the pool rather than trusted from the body. A captain must
  // be an APPROVED signup in THIS tournament — otherwise the draft can put
  // somebody on the clock who was never admitted to it, and the seat has no
  // discord_id behind it to recognise them by.
  const { data: signup, error: sErr } = await supabase
    .from('player_signups').select('id, status, player_name, discord_id')
    .eq('id', req.body?.signup_id || '00000000-0000-0000-0000-000000000000')
    .eq('tournament_id', t.id).maybeSingle();
  if (sErr) return res.status(500).json({ error: 'Could not check that player.' });
  if (!signup) return res.status(400).json({ error: 'That player has not signed up for this tournament.' });
  if (signup.status !== 'approved') {
    return res.status(400).json({ error: `${signup.player_name} is not approved yet — approve their signup first.` });
  }

  const { data: held } = await supabase
    .from('team_captains').select('seat').eq('team_id', team.id);
  const taken = (held || []).map((r) => r.seat);

  let seat;
  if (req.body?.seat === undefined || req.body.seat === null) {
    seat = firstFreeSeat(taken);
    if (seat === null) {
      return res.status(409).json({
        error: `${team.name} already has ${MAX_CAPTAINS_PER_TEAM} captains — remove one first.`,
      });
    }
  } else {
    seat = Number(req.body.seat);
    if (!isSeat(seat)) return res.status(400).json({ error: `A seat is 1 to ${MAX_CAPTAINS_PER_TEAM}.` });
  }

  const { data, error } = await supabase
    .from('team_captains')
    .insert({ tournament_id: t.id, team_id: team.id, signup_id: signup.id, seat })
    .select(CAPTAIN_ROWS).single();

  if (error) {
    const msg = conflictMessage(error);
    if (msg) return res.status(409).json({ error: msg });
    console.error('captain assign failed:', error.message);
    return res.status(500).json({ error: 'Could not make them a captain.' });
  }

  // A captain plays for the team they captain. This is what takes them out of
  // the pool every captain is drafting from — including their own board — and
  // it is written here rather than derived at read time so that "is this player
  // taken" is one question against one table.
  //
  // If this insert fails the seat is already written, so the captain exists
  // without a roster row: they would still be listed as captain but could be
  // drafted by somebody else. Unwound rather than left half-applied.
  const { error: rosterErr, clearedFrom } = await addToRoster(
    t.id, team.id, signup.id, VIA_CAPTAIN
  );
  if (rosterErr) {
    await supabase.from('team_captains').delete()
      .eq('team_id', team.id).eq('signup_id', signup.id);
    console.error('captain roster insert failed:', rosterErr.message);
    const msg = conflictMessage(rosterErr);
    return res.status(msg ? 409 : 500).json({
      error: msg || 'Could not add them to the roster, so the captain seat was not saved.',
    });
  }

  await audit(req.user, 'team.captain.add', team.id, {
    team: team.name, seat, player: signup.player_name, discord_id: signup.discord_id,
    cleared_from_boards: clearedFrom.length,
  });
  res.json({
    captain: { seat, label: seatLabel(seat), ...data.signup },
    // How many captains just lost this name off their board. Worth reporting:
    // an organizer seating somebody late is changing other people's plans.
    clearedFrom: clearedFrom.length,
  });
});

// Unseat somebody. Keyed by their signup id rather than the seat, because
// that's what the button on the row has and it can't unseat the wrong person
// if the page is stale.
organizerRouter.delete('/:id/captains/:signupId', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const { data: row } = await supabase
    .from('team_captains').select('id, seat, signup:player_signups (player_name)')
    .eq('tournament_id', t.id).eq('team_id', req.params.id).eq('signup_id', req.params.signupId)
    .maybeSingle();
  if (!row) return res.status(404).json({ error: 'They are not a captain of that team.' });

  const { error } = await supabase.from('team_captains').delete().eq('id', row.id);
  if (error) {
    console.error('captain remove failed:', error.message);
    return res.status(500).json({ error: 'Could not remove that captain.' });
  }

  // They were on the roster BECAUSE they captain, so unseating takes the roster
  // row with it and puts them back in the available pool. Scoped to via =
  // 'captain' on purpose: if the draft has already placed somebody, that row is
  // a pick and removing a captain's seat must not quietly undo it.
  const { error: rosterErr } = await supabase.from('team_players').delete()
    .eq('team_id', req.params.id).eq('signup_id', req.params.signupId).eq('via', VIA_CAPTAIN);
  if (rosterErr) {
    console.error('captain roster remove failed:', rosterErr.message);
    return res.status(500).json({
      error: 'Seat removed, but they are still on the roster — reload and check.',
    });
  }

  await audit(req.user, 'team.captain.remove', req.params.id, {
    seat: row.seat, player: row.signup?.player_name,
  });
  res.json({ ok: true });
});

// ── Delete ──────────────────────────────────────────────────────────────────
organizerRouter.delete('/:id', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const { data: team } = await supabase
    .from('teams').select('id, name').eq('id', req.params.id).eq('tournament_id', t.id).maybeSingle();
  if (!team) return res.status(404).json({ error: 'Team not found.' });

  const { error } = await supabase.from('teams').delete().eq('id', req.params.id);
  if (error) {
    console.error('team delete failed:', error.message);
    return res.status(500).json({ error: 'Could not delete that team.' });
  }

  await audit(req.user, 'team.delete', team.id, { name: team.name });
  res.json({ ok: true });
});

// ── Reseed ──────────────────────────────────────────────────────────────────
// Takes the full ordered list of team ids and renumbers them 1..N.
//
// Applied in two passes with the seeds parked in negative numbers first. The
// partial unique index means a straight rewrite collides the moment a team
// takes a seed another team still holds — which is every reorder that isn't a
// pure append. Negatives can't collide with the 1..N being written after them.
organizerRouter.post('/reseed', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const order = Array.isArray(req.body?.order) ? req.body.order : null;
  if (!order || order.length === 0) return res.status(400).json({ error: 'Send the team ids in their new order.' });

  const { data: existing } = await supabase.from('teams').select('id').eq('tournament_id', t.id);
  const known = new Set((existing || []).map((x) => x.id));
  if (order.length !== known.size || order.some((id) => !known.has(id))) {
    return res.status(400).json({ error: 'That list does not match the teams that exist — reload the page.' });
  }

  for (let i = 0; i < order.length; i++) {
    const { error } = await supabase.from('teams').update({ seed: -(i + 1) })
      .eq('id', order[i]).eq('tournament_id', t.id);
    if (error) {
      console.error('reseed park failed:', error.message);
      return res.status(500).json({ error: 'Could not reorder the teams.' });
    }
  }
  for (let i = 0; i < order.length; i++) {
    const { error } = await supabase.from('teams').update({ seed: i + 1 })
      .eq('id', order[i]).eq('tournament_id', t.id);
    if (error) {
      console.error('reseed write failed:', error.message);
      return res.status(500).json({ error: 'Teams are half-renumbered — reload and try again.' });
    }
  }

  await audit(req.user, 'team.reseed', null, { count: order.length });
  res.json({ ok: true });
});

module.exports = {
  publicRouter, organizerRouter, readiness,
  captainCandidates, captaincyFor, rostersByTeam, rosteredIds, addToRoster,
};
