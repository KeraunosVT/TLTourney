// backend/board.js — a captain's private pre-draft board.
//
// ⚠️  THE PRIVACY RULE, and it is one line: `team_id` comes from the caller's
// captaincy, NEVER from the request body or the URL. Every read and every write
// below is filtered by the team the signed-in user actually captains, which is
// looked up on this request against the database.
//
// There is no team id to tamper with, so there is no "can I read team 4's
// board" to get wrong. Any route added here must derive the team the same way.
// Organizers are not exempt: an organizer who is not a captain gets 403 like
// anyone else, because "only visible to them" was the requirement and a
// privacy promise with an admin bypass is not one.
const express = require('express');
const { supabase, currentTournament } = require('./db');
const { captaincyFor } = require('./teams');
const { roleDemand } = require('../shared/parties.cjs');
const { TIERS, isTier, tierMeta, coverage, MIN_TIER, MAX_TIER } = require('../shared/board.cjs');

const router = express.Router();

const ENTRY = 'id, signup_id, tier, rank, note';

// The player behind each entry. One FK from draft_board_entries to
// player_signups, so the embed is unambiguous.
const ENTRY_WITH_PLAYER = `${ENTRY}, player:player_signups (
  id, player_name, discord_username, role, classes, positions, nights, notes
)`;

const POOL = 'id, player_name, discord_username, role, classes, positions, nights, notes, wants_captain';

// ── The gate ────────────────────────────────────────────────────────────────
// Captaincy is read fresh on every request rather than taken from the session,
// so a captain swapped an hour ago loses the board on their next click instead
// of keeping it until a seven-day cookie expires.
async function requireCaptain(req, res, next) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const seats = await captaincyFor(req.user?.id, t.id);
  if (seats.length === 0) {
    return res.status(403).json({ error: 'Draft boards belong to team captains.' });
  }

  // One team per person is a unique index in the database, so there is never a
  // second seat to disambiguate between.
  req.tournament = t;
  req.team = seats[0];
  next();
}

router.use(requireCaptain);

// ── Read the board ──────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const [entriesRes, poolRes] = await Promise.all([
    supabase.from('draft_board_entries').select(ENTRY_WITH_PLAYER)
      .eq('team_id', req.team.id)
      .order('tier', { ascending: true }).order('rank', { ascending: true }),
    supabase.from('player_signups').select(POOL)
      .eq('tournament_id', req.tournament.id).eq('status', 'approved')
      .order('player_name', { ascending: true }),
  ]);

  if (entriesRes.error || poolRes.error) {
    console.error('board read failed:', (entriesRes.error || poolRes.error).message);
    return res.status(500).json({ error: 'Could not load your board.' });
  }

  const entries = (entriesRes.data || []).filter((e) => e.player);
  const placed = new Set(entries.map((e) => e.signup_id));

  const template = Array.isArray(req.tournament.party_template) ? req.tournament.party_template : [];

  res.json({
    team: req.team,
    tiers: TIERS,
    // Flattened: the player's fields sit alongside the entry's, because every
    // consumer wants both and nothing wants them apart.
    entries: entries.map((e) => ({ ...e.player, ...e, id: e.id, signup_id: e.signup_id })),
    // Everyone approved who isn't on the board yet.
    pool: (poolRes.data || []).filter((p) => !placed.has(p.id)),
    coverage: coverage(
      entries.map((e) => ({ tier: e.tier, role: e.player.role })),
      roleDemand(template, 1)
    ),
  });
});

// ── Place or move a player ──────────────────────────────────────────────────
// One call for both: dropping a new player into a tier and moving an existing
// one between tiers are the same write, and splitting them would only mean the
// page has to know which it is doing.
router.put('/entry', async (req, res) => {
  const tier = req.body?.tier;
  if (!isTier(tier)) {
    return res.status(400).json({ error: `A tier is a whole number from ${MIN_TIER} to ${MAX_TIER}.` });
  }

  // The player must be an approved signup in this tournament. Checked rather
  // than trusted: without it a captain could rank somebody who never signed up,
  // and the draft would offer a name with nobody behind it.
  const { data: signup, error: sErr } = await supabase
    .from('player_signups').select('id, status, player_name')
    .eq('id', req.body?.signup_id || '00000000-0000-0000-0000-000000000000')
    .eq('tournament_id', req.tournament.id).maybeSingle();
  if (sErr) return res.status(500).json({ error: 'Could not check that player.' });
  if (!signup) return res.status(400).json({ error: 'That player is not in this tournament.' });
  if (signup.status !== 'approved') {
    return res.status(400).json({ error: `${signup.player_name} is not an approved signup.` });
  }

  // Land at the bottom of the destination tier. Appending never disturbs an
  // order the captain already set, which is what you want when you are adding
  // forty people in a sitting.
  const { data: last } = await supabase
    .from('draft_board_entries').select('rank')
    .eq('team_id', req.team.id).eq('tier', tier)
    .order('rank', { ascending: false }).limit(1).maybeSingle();

  const { data, error } = await supabase
    .from('draft_board_entries')
    .upsert({
      tournament_id: req.tournament.id,
      team_id: req.team.id,
      signup_id: signup.id,
      tier,
      rank: (last?.rank ?? -1) + 1,
    }, { onConflict: 'team_id,signup_id' })
    .select(ENTRY).single();

  if (error) {
    console.error('board place failed:', error.message);
    return res.status(500).json({ error: 'Could not save that.' });
  }
  res.json({ entry: data });
});

// ── Take a player off the board ─────────────────────────────────────────────
router.delete('/entry/:signupId', async (req, res) => {
  const { error } = await supabase
    .from('draft_board_entries').delete()
    .eq('team_id', req.team.id).eq('signup_id', req.params.signupId);

  if (error) {
    console.error('board remove failed:', error.message);
    return res.status(500).json({ error: 'Could not remove that.' });
  }
  res.json({ ok: true });
});

// ── Reorder one tier ────────────────────────────────────────────────────────
// Takes the whole tier in its new order and rewrites ranks 0..n-1. Sending the
// full list rather than a "move up" instruction means a stale page cannot
// silently reorder something else: the ids are checked against what is
// actually in that tier, and a mismatch is refused rather than half-applied.
router.post('/reorder', async (req, res) => {
  const tier = req.body?.tier;
  if (!isTier(tier)) return res.status(400).json({ error: 'Which tier?' });

  const order = Array.isArray(req.body?.order) ? req.body.order : null;
  if (!order) return res.status(400).json({ error: 'Send the player ids in their new order.' });

  const { data: current, error: readErr } = await supabase
    .from('draft_board_entries').select('signup_id')
    .eq('team_id', req.team.id).eq('tier', tier);
  if (readErr) return res.status(500).json({ error: 'Could not read that tier.' });

  const known = new Set((current || []).map((r) => r.signup_id));
  if (order.length !== known.size || order.some((id) => !known.has(id))) {
    return res.status(409).json({ error: 'That tier has changed since the page loaded — reload it.' });
  }

  // No unique index on rank, so these can be written straight through — none of
  // the park-in-negatives dance the team seeds need.
  for (let i = 0; i < order.length; i++) {
    const { error } = await supabase.from('draft_board_entries').update({ rank: i })
      .eq('team_id', req.team.id).eq('signup_id', order[i]);
    if (error) {
      console.error('board reorder failed:', error.message);
      return res.status(500).json({ error: 'That tier is half-reordered — reload and try again.' });
    }
  }
  res.json({ ok: true });
});

// ── Note on a player ────────────────────────────────────────────────────────
router.put('/note', async (req, res) => {
  const note = String(req.body?.note ?? '').trim().slice(0, 300) || null;

  const { data, error } = await supabase
    .from('draft_board_entries').update({ note })
    .eq('team_id', req.team.id).eq('signup_id', req.body?.signup_id || '')
    .select(ENTRY).maybeSingle();

  if (error) {
    console.error('board note failed:', error.message);
    return res.status(500).json({ error: 'Could not save that note.' });
  }
  if (!data) return res.status(404).json({ error: 'That player is not on your board.' });
  res.json({ entry: data });
});

module.exports = { router, requireCaptain, tierMeta };
