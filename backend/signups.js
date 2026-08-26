// backend/signups.js — a player's own signup: read it, file it, withdraw it.
//
// Everything here is scoped to req.user.id. There is no route that takes a
// discord_id, which is what makes "file a signup as someone else" not a thing
// this app can be asked to do.
const express = require('express');
const { supabase, currentTournament, audit } = require('./db');
const { validateSignup, NIGHTS } = require('./validateSignup');
const { WEAPONS } = require('../shared/classes.cjs');

const router = express.Router();

// Fields the player is allowed to see about their own signup. `decision_note`
// is included on purpose: being told why you were turned down is the difference
// between fixing it and resubmitting the same thing.
const MINE = 'id, player_name, weapon_1, weapon_2, class_name, gear_level, nights, notes, wants_captain, status, decision_note, created_at, updated_at';

// Signups may only be created or changed while the tournament says so. Once the
// draft opens the pool is frozen — a roster that changes underneath a running
// draft is how a captain ends up having drafted something that no longer exists.
const isOpen = (t) => t?.status === 'signups';

function closedReason(t) {
  if (!t) return 'No tournament is running yet.';
  if (t.status === 'setup') return 'Signups have not opened yet.';
  return 'Signups are closed — the draft has started.';
}

// ── The pool, as numbers ────────────────────────────────────────────────────
// Public to anyone logged in. Counts only, never the roster: before the draft,
// who has signed up is exactly the information captains would like to have
// early, and there is no reason to hand it to them.
router.get('/pool', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.json({ tournament: null });

  const { data, error } = await supabase
    .from('player_signups')
    .select('status, weapon_1, weapon_2, class_name')
    .eq('tournament_id', t.id);

  if (error) {
    console.error('pool read failed:', error.message);
    return res.status(500).json({ error: 'Could not read the pool.' });
  }

  const rows = data || [];
  const approved = rows.filter((r) => r.status === 'approved');

  // Weapon demand, most-signed first. A player deciding what to bring wants to
  // know what's already thick on the ground.
  const weaponCount = {};
  approved.forEach((r) => {
    weaponCount[r.weapon_1] = (weaponCount[r.weapon_1] || 0) + 1;
    weaponCount[r.weapon_2] = (weaponCount[r.weapon_2] || 0) + 1;
  });

  res.json({
    tournament: {
      name: t.name,
      status: t.status,
      roster_size: t.roster_size,
      signups_close_at: t.signups_close_at,
      open: isOpen(t),
    },
    counts: {
      total: rows.filter((r) => r.status !== 'rejected' && r.status !== 'withdrawn').length,
      approved: approved.length,
      pending: rows.filter((r) => r.status === 'pending').length,
    },
    weapons: WEAPONS.map((w) => ({ weapon: w, count: weaponCount[w] || 0 }))
      .sort((a, b) => b.count - a.count),
    classes: Object.entries(
      approved.reduce((acc, r) => { acc[r.class_name] = (acc[r.class_name] || 0) + 1; return acc; }, {})
    ).map(([class_name, count]) => ({ class_name, count }))
      .sort((a, b) => b.count - a.count || a.class_name.localeCompare(b.class_name)),
  });
});

// ── My signup ───────────────────────────────────────────────────────────────
router.get('/mine', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.json({ signup: null, open: false, reason: closedReason(t) });

  const { data, error } = await supabase
    .from('player_signups')
    .select(MINE)
    .eq('tournament_id', t.id)
    .eq('discord_id', req.user.id)
    .maybeSingle();

  if (error) {
    console.error('signup read failed:', error.message);
    return res.status(500).json({ error: 'Could not read your signup.' });
  }

  res.json({
    signup: data || null,
    open: isOpen(t),
    reason: isOpen(t) ? null : closedReason(t),
  });
});

// ── File or update my signup ────────────────────────────────────────────────
// One route for both, because from the player's side it is one action: this is
// what I'm bringing. The unique constraint on (tournament_id, discord_id) makes
// the upsert the honest expression of that.
//
// An edit does NOT send an approved signup back to pending. The organizer
// approved the person, not the loadout, and bouncing someone back to the queue
// for switching a weapon a week out would mean nobody ever updates their entry —
// which leaves captains drafting against stale information, the exact problem
// the form exists to avoid. `updated_at` moves, and the queue shows it.
router.put('/mine', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });

  const t = await currentTournament({ fresh: true });
  if (!isOpen(t)) return res.status(409).json({ error: closedReason(t) });

  const { ok, errors, value } = validateSignup(req.body);
  if (!ok) return res.status(400).json({ error: 'Some details need fixing.', errors });

  const { data: existing } = await supabase
    .from('player_signups')
    .select('id, status')
    .eq('tournament_id', t.id)
    .eq('discord_id', req.user.id)
    .maybeSingle();

  // A withdrawn signup that comes back is a new submission and goes through the
  // queue again. A rejected one likewise — otherwise "rejected" would be a
  // suggestion rather than a decision.
  const nextStatus = !existing || existing.status === 'withdrawn' || existing.status === 'rejected'
    ? 'pending'
    : existing.status;

  const row = {
    tournament_id: t.id,
    discord_id: req.user.id,
    discord_username: req.user.username,
    ...value,
    status: nextStatus,
    // Clear a stale decision when the row re-enters the queue, so the player
    // isn't still being shown last time's rejection reason.
    ...(nextStatus === 'pending' ? { decision_note: null, decided_by: null, decided_at: null } : {}),
  };

  const { data, error } = await supabase
    .from('player_signups')
    .upsert(row, { onConflict: 'tournament_id,discord_id' })
    .select(MINE)
    .single();

  if (error) {
    console.error('signup write failed:', error.message);
    return res.status(500).json({ error: 'Could not save your signup.' });
  }

  await audit(req.user, existing ? 'signup.update' : 'signup.create', data.id, {
    player_name: value.player_name,
    class_name: value.class_name,
    gear_level: value.gear_level,
  });

  res.json({ signup: data, created: !existing });
});

// ── Withdraw ────────────────────────────────────────────────────────────────
// A withdrawal is a status change, not a delete. The row is the record that
// somebody signed up and pulled out, which is worth keeping — and deleting it
// would let the same person re-file repeatedly with no trace.
router.delete('/mine', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });

  const t = await currentTournament({ fresh: true });
  if (!isOpen(t)) return res.status(409).json({ error: closedReason(t) });

  const { data, error } = await supabase
    .from('player_signups')
    .update({ status: 'withdrawn' })
    .eq('tournament_id', t.id)
    .eq('discord_id', req.user.id)
    .select(MINE)
    .maybeSingle();

  if (error) {
    console.error('withdraw failed:', error.message);
    return res.status(500).json({ error: 'Could not withdraw your signup.' });
  }
  if (!data) return res.status(404).json({ error: 'You have no signup to withdraw.' });

  await audit(req.user, 'signup.withdraw', data.id, null);
  res.json({ signup: data });
});

// Reference data for the form — the weapon list and the night names, served
// from the same source the validator checks against, so the form can never
// offer an option the server would reject.
router.get('/options', (req, res) => {
  res.json({ weapons: WEAPONS, nights: NIGHTS });
});

module.exports = router;
