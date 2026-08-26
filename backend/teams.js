// backend/teams.js — teams, their captains, and whether the pool can fill them.
//
// Two routers: one anybody signed in may read (teams aren't secret), one behind
// requireOrganizer for everything that changes them.
const express = require('express');
const { supabase, currentTournament, audit } = require('./db');
const { roleDemand, startersPerTeam } = require('../shared/parties.cjs');
const { ROLES } = require('../shared/roles.cjs');

const TEAM = 'id, name, tag, seed, captain_id, created_at, updated_at';

// The captain, embedded. PostgREST resolves this through the captain_id foreign
// key — which is exactly why captain_id points at player_signups rather than
// holding a loose discord_id: the captain's role and classes come along free
// and cannot go stale, because there is only one copy of them.
const TEAM_WITH_CAPTAIN = `${TEAM}, captain:player_signups!teams_captain_id_fkey (
  id, player_name, discord_id, discord_username, role, classes, positions
)`;

// A unique-violation on this table is never a server fault — it is two teams
// given the same seed, the same name, or the same captain. Say which.
function conflictMessage(error) {
  const detail = `${error.message || ''} ${error.details || ''}`;
  if (/teams_seed_unique/.test(detail)) return 'Another team already has that seed.';
  if (/teams_captain_unique/.test(detail)) return 'That player is already captaining another team.';
  if (/teams_name_unique/.test(detail)) return 'A team with that name already exists.';
  return null;
}

// ── Public: the teams ───────────────────────────────────────────────────────
const publicRouter = express.Router();

publicRouter.get('/', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.json({ teams: [] });

  const { data, error } = await supabase
    .from('teams')
    .select(TEAM_WITH_CAPTAIN)
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
  res.json({ teams: data || [] });
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
    supabase.from('teams').select(TEAM_WITH_CAPTAIN).eq('tournament_id', t.id)
      .order('seed', { ascending: true, nullsFirst: false }).order('name', { ascending: true }),
    supabase.from('player_signups')
      .select('id, player_name, discord_id, discord_username, role, classes, positions, wants_captain, status')
      .eq('tournament_id', t.id).eq('status', 'approved'),
  ]);

  if (teamsRes.error || signupsRes.error) {
    console.error('teams page read failed:', (teamsRes.error || signupsRes.error).message);
    return res.status(500).json({ error: 'Could not load the teams page.' });
  }

  const teams = teamsRes.data || [];
  const approved = signupsRes.data || [];
  const takenIds = new Set(teams.map((x) => x.captain_id).filter(Boolean));

  // Volunteers first — they said yes — but everyone approved is offered, since
  // an organizer sometimes needs to ask someone who didn't volunteer.
  const candidates = approved
    .filter((s) => !takenIds.has(s.id))
    .sort((a, b) => (b.wants_captain === true) - (a.wants_captain === true)
      || a.player_name.localeCompare(b.player_name));

  res.json({
    tournament: t,
    teams,
    candidates,
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
    .select(TEAM_WITH_CAPTAIN)
    .single();

  if (error) {
    const msg = conflictMessage(error);
    if (msg) return res.status(409).json({ error: msg });
    console.error('team create failed:', error.message);
    return res.status(500).json({ error: 'Could not create that team.' });
  }

  await audit(req.user, 'team.create', data.id, { name, tag });
  res.json({ team: data });
});

// ── Update: name, tag, seed, captain ────────────────────────────────────────
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

  // Captains are checked against the pool rather than trusted from the body.
  // A captain must be an APPROVED signup in THIS tournament — otherwise the
  // draft can put someone on the clock who was never admitted to it.
  if (req.body?.captain_id !== undefined) {
    if (req.body.captain_id === null) {
      patch.captain_id = null;
    } else {
      const { data: signup, error: sErr } = await supabase
        .from('player_signups').select('id, status, player_name')
        .eq('id', req.body.captain_id).eq('tournament_id', t.id).maybeSingle();
      if (sErr) return res.status(500).json({ error: 'Could not check that player.' });
      if (!signup) return res.status(400).json({ error: 'That player has not signed up for this tournament.' });
      if (signup.status !== 'approved') {
        return res.status(400).json({ error: `${signup.player_name} is not approved yet — approve their signup first.` });
      }
      patch.captain_id = signup.id;
    }
  }

  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to change.' });

  const { data, error } = await supabase
    .from('teams').update(patch)
    .eq('id', req.params.id).eq('tournament_id', t.id)
    .select(TEAM_WITH_CAPTAIN).maybeSingle();

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

module.exports = { publicRouter, organizerRouter, readiness };
