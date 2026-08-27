// backend/signups.js — a player's own signup: read it, file it, withdraw it.
//
// Everything here is scoped to req.user.id. There is no route that takes a
// discord_id, which is what makes "file a signup as someone else" not a thing
// this app can be asked to do.
const express = require('express');
const { supabase, currentTournament, audit } = require('./db');
const { validateSignup, NIGHTS } = require('./validateSignup');
const { sendDM } = require('./discord');
const { WEAPONS, WEAPONS_FOR, CLASS_NAMES } = require('../shared/classes.cjs');
const { ROLES, POSITIONS } = require('../shared/roles.cjs');

const router = express.Router();

// Only rendered into the DM when it's a real link. APP_URL is `/` in local
// development, and "you can edit it at /" is worse than saying nothing.
const APP_URL = process.env.APP_URL || '';
const SITE_LINK = /^https?:\/\//i.test(APP_URL) ? APP_URL.replace(/\/+$/, '') : null;

/**
 * The confirmation DM — a receipt, quoting back what was actually stored.
 *
 * Deliberately quotes the SAVED row rather than what was submitted. The
 * validator reorders positions and nights into canonical order and drops
 * duplicates, so this is the one message that shows the player what the
 * tournament will actually see. If it doesn't match what they think they
 * entered, that is the discrepancy worth surfacing, not hiding.
 */
function receipt(t, s) {
  const lines = [
    `📋 Signup received for **${t.name}**.`,
    '',
    `**${s.player_name}** — ${s.role || 'no role given'}`,
    `Classes: ${(s.classes || []).join(' · ') || 'none given'}`,
  ];
  if ((s.positions || []).length) lines.push(`Positions: ${s.positions.join(', ')}`);
  if ((s.nights || []).length) lines.push(`Nights: ${s.nights.join(', ')}`);
  if (s.wants_captain) lines.push('You put your name down to captain.');
  if (s.wants_shotcall) lines.push('You said you\'re willing to shotcall.');

  lines.push('');
  lines.push(
    "An organizer checks it over before you're on the draft board — you'll get another DM either way."
  );
  if (SITE_LINK) lines.push(`Change anything while signups are open: ${SITE_LINK}`);

  return lines.join('\n');
}

/**
 * Should filing this signup send a confirmation DM?
 *
 * True only when the row ENTERS the review queue. Pulled out as its own
 * function because the condition is the whole feature: get it wrong one way and
 * a player is DM'd every time they touch their entry, get it wrong the other
 * and somebody who withdrew and came back is never told their signup landed.
 */
const entersQueue = (previousStatus, nextStatus) =>
  nextStatus === 'pending' && previousStatus !== 'pending';

// Fields the player is allowed to see about their own signup. `decision_note`
// is included on purpose: being told why you were turned down is the difference
// between fixing it and resubmitting the same thing.
const MINE = 'id, player_name, classes, role, positions, nights, notes, wants_captain, wants_shotcall, status, decision_note, created_at, updated_at';

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
// One shape, always — tournament or no tournament.
//
// This used to return a bare `{ tournament: null }` when nothing was running.
// That object is TRUTHY on the client, so the page passed its `pool &&` guard,
// rendered the pool panel, and died on `pool.counts.total` — taking the whole
// page down before it could show the "no tournament is running" message that
// would have explained the problem. A route with two shapes is a route with
// two contracts, and callers only ever remember one of them.
const emptyPool = () => ({
  tournament: null,
  counts: { total: 0, approved: 0, pending: 0 },
  weapons: WEAPONS.map((w) => ({ weapon: w, count: 0 })),
  classes: [],
  roles: ROLES.map((role) => ({ role, count: 0 })),
  positions: POSITIONS.map((position) => ({ position, count: 0 })),
});

router.get('/pool', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.json(emptyPool());

  const { data, error } = await supabase
    .from('player_signups')
    .select('status, classes, role, positions')
    .eq('tournament_id', t.id);

  if (error) {
    console.error('pool read failed:', error.message);
    return res.status(500).json({ error: 'Could not read the pool.' });
  }

  const rows = data || [];
  const approved = rows.filter((r) => r.status === 'approved');

  // Class demand. Counted TWICE over, because the two counts answer different
  // questions and conflating them misleads:
  //   · `count`  — anyone who lists it at all, i.e. who could be asked to play it
  //   · `mains`  — people whose FIRST pick it is, i.e. who actually plays it
  // A class ten people list as a third option is not a class ten people play.
  const classCount = {};
  const mainCount = {};
  approved.forEach((r) => {
    (r.classes || []).forEach((c, i) => {
      classCount[c] = (classCount[c] || 0) + 1;
      if (i === 0) mainCount[c] = (mainCount[c] || 0) + 1;
    });
  });

  // Role and position spread. A row filed before migration 002 has a null role
  // and an empty positions array; those are skipped rather than counted as a
  // zero, so the totals describe people who actually answered.
  const roleCount = {};
  const positionCount = {};
  approved.forEach((r) => {
    if (r.role) roleCount[r.role] = (roleCount[r.role] || 0) + 1;
    (r.positions || []).forEach((p) => { positionCount[p] = (positionCount[p] || 0) + 1; });
  });

  // Weapon demand still works, derived rather than stored: every class IS a
  // weapon pair, so the roster's weapon spread falls out of the class picks.
  // Counted on mains only — a player's third-choice class says little about
  // what they'll actually bring.
  const weaponCount = {};
  Object.entries(mainCount).forEach(([cls, n]) => {
    (WEAPONS_FOR[cls] || []).forEach((w) => { weaponCount[w] = (weaponCount[w] || 0) + n; });
  });

  res.json({
    tournament: {
      name: t.name,
      status: t.status,
      roster_size: t.roster_size,
      party_count: t.party_count,
      party_size: t.party_size,
      sub_count: t.sub_count,
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
    // Role spread: the number an organizer checks before closing signups,
    // because a pool of sixty with four healers in it cannot field ten teams
    // however many people are in it.
    roles: ROLES.map((role) => ({ role, count: roleCount[role] || 0 })),
    positions: POSITIONS.map((position) => ({ position, count: positionCount[position] || 0 })),
    classes: CLASS_NAMES
      .map((class_name) => ({
        class_name,
        count: classCount[class_name] || 0,
        mains: mainCount[class_name] || 0,
      }))
      .filter((c) => c.count > 0)
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
    classes: value.classes,
    role: value.role,
    positions: value.positions,
  });

  // ── The confirmation DM ───────────────────────────────────────────────────
  // Sent when the signup ENTERS the queue, not on every save. This route is
  // the same one a later edit goes through, so DMing unconditionally would send
  // an identical confirmation to somebody who came back to fix a typo — and a
  // confirmation that arrives four times is one nobody reads the fifth time.
  //
  // A withdrawn or rejected signup coming back does count: it is a fresh
  // submission going through the queue again, and the player should be told it
  // landed. Editing a signup that is already pending or approved does not.
  //
  // Never fails the signup. sendDM doesn't throw, and a closed DM inbox must
  // not be the reason a signup doesn't save — the row is already written by
  // this point, and it is the row that counts.
  const dm = entersQueue(existing?.status, nextStatus)
    ? await sendDM(req.user.id, receipt(t, data))
    : null;

  res.json({ signup: data, created: !existing, dm });
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
  res.json({
    // Each class with the weapon pair it is, so a caller can label a pick
    // without shipping the whole lookup table to do it.
    classes: CLASS_NAMES.map((name) => ({ name, weapons: WEAPONS_FOR[name] || [] })),
    weapons: WEAPONS,
    roles: ROLES,
    positions: POSITIONS,
    nights: NIGHTS,
    maxClasses: 3,
  });
});

module.exports = { router, receipt, entersQueue };
