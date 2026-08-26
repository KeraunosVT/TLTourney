// backend/organizer.js — the approval queue and the tournament's own settings.
//
// Mounted behind requireOrganizer, so every route here already knows the caller
// runs the tournament. Each decision is audit-logged and DMed.
const express = require('express');
const { supabase, currentTournament, invalidateTournament, audit } = require('./db');
const { sendDM, listRoles, botConfigured } = require('./discord');

const router = express.Router();

// The organizer sees everything a player wrote, plus who they are on Discord.
const FULL = 'id, discord_id, discord_username, player_name, weapon_1, weapon_2, class_name, '
  + 'gear_level, nights, notes, wants_captain, status, decision_note, decided_by, decided_at, '
  + 'created_at, updated_at';

// ── The whole pool ──────────────────────────────────────────────────────────
// Not paged. A tournament pool is hundreds of rows at the outside, and paging a
// queue you are meant to work through top to bottom makes it easy to leave a
// page unread. If this ever needs paging it needs `fetchAll` — see the note in
// Gear-Gap's pagedRead.js about PostgREST's silent 1,000-row cap.
router.get('/signups', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.json({ tournament: null, signups: [] });

  const { data, error } = await supabase
    .from('player_signups')
    .select(FULL)
    .eq('tournament_id', t.id)
    // Pending first — that's the work. Then oldest-submitted, so the queue is
    // first-come-first-served rather than whoever happens to sort highest.
    .order('created_at', { ascending: true });

  if (error) {
    console.error('organizer signups read failed:', error.message);
    return res.status(500).json({ error: 'Could not read signups.' });
  }

  const rows = data || [];
  const rank = { pending: 0, approved: 1, rejected: 2, withdrawn: 3 };
  rows.sort((a, b) => (rank[a.status] - rank[b.status])
    || new Date(a.created_at) - new Date(b.created_at));

  res.json({
    tournament: t,
    signups: rows,
    counts: {
      pending: rows.filter((r) => r.status === 'pending').length,
      approved: rows.filter((r) => r.status === 'approved').length,
      rejected: rows.filter((r) => r.status === 'rejected').length,
      withdrawn: rows.filter((r) => r.status === 'withdrawn').length,
    },
    dm: botConfigured,
  });
});

// ── Decide one signup ───────────────────────────────────────────────────────
// POST /signups/:id/decision  { decision: 'approved' | 'rejected', note?: string }
//
// The decision is applied conditionally on the row still being in the state the
// organizer saw. Two organizers working the queue at once is the normal case,
// not an edge case, and without the guard the second click silently overwrites
// the first — an approval quietly becoming a rejection with nothing said.
router.post('/signups/:id/decision', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });

  const { decision, note } = req.body || {};
  if (decision !== 'approved' && decision !== 'rejected') {
    return res.status(400).json({ error: 'Decision must be "approved" or "rejected".' });
  }
  const cleanNote = String(note ?? '').trim().slice(0, 500) || null;
  if (decision === 'rejected' && !cleanNote) {
    // A rejection with no reason gets resubmitted unchanged, and the organizer
    // gets to do the same work twice.
    return res.status(400).json({ error: 'Give a reason — it gets sent to the player.' });
  }

  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const { data: before, error: readErr } = await supabase
    .from('player_signups')
    .select(FULL)
    .eq('id', req.params.id)
    .eq('tournament_id', t.id)
    .maybeSingle();

  if (readErr) {
    console.error('decision read failed:', readErr.message);
    return res.status(500).json({ error: 'Could not read that signup.' });
  }
  if (!before) return res.status(404).json({ error: 'Signup not found.' });
  if (before.status === 'withdrawn') {
    return res.status(409).json({ error: 'That player withdrew — there is nothing to decide.' });
  }

  const { data, error } = await supabase
    .from('player_signups')
    .update({
      status: decision,
      decision_note: cleanNote,
      decided_by: req.user.username,
      decided_at: new Date().toISOString(),
    })
    .eq('id', req.params.id)
    .eq('status', before.status)   // the concurrency guard
    .select(FULL)
    .maybeSingle();

  if (error) {
    console.error('decision write failed:', error.message);
    return res.status(500).json({ error: 'Could not save that decision.' });
  }
  if (!data) {
    return res.status(409).json({
      error: 'Someone else decided this one first — reload the queue.',
    });
  }

  await audit(req.user, `signup.${decision}`, data.id, {
    player_name: data.player_name,
    discord_id: data.discord_id,
    note: cleanNote,
  });

  // DM last, and never fatally: the decision is already made and recorded. A
  // closed DM inbox must not turn a successful approval into an error.
  const dm = await sendDM(
    data.discord_id,
    decision === 'approved'
      ? `✅ Your signup for **${t.name}** is approved — you're on the draft board as **${data.player_name}** (${data.class_name}).`
      : `❌ Your signup for **${t.name}** wasn't accepted.\n> ${cleanNote}\nYou can fix it and submit again while signups are open.`
  );

  res.json({ signup: data, dm });
});

// ── Bulk approve ────────────────────────────────────────────────────────────
// The queue's realistic shape: fifty signups, forty-eight of them fine. Each is
// still applied with its own guard, so a row someone else just decided is
// reported rather than steamrolled.
router.post('/signups/approve-all', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const { data: pending, error } = await supabase
    .from('player_signups')
    .select('id, discord_id, player_name, class_name')
    .eq('tournament_id', t.id)
    .eq('status', 'pending');

  if (error) {
    console.error('approve-all read failed:', error.message);
    return res.status(500).json({ error: 'Could not read the queue.' });
  }

  const decidedAt = new Date().toISOString();
  let approved = 0; let skipped = 0;
  for (const row of pending || []) {
    const { data } = await supabase
      .from('player_signups')
      .update({ status: 'approved', decided_by: req.user.username, decided_at: decidedAt, decision_note: null })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    if (data) {
      approved += 1;
      await sendDM(row.discord_id, `✅ Your signup for **${t.name}** is approved — you're on the draft board as **${row.player_name}** (${row.class_name}).`);
    } else {
      skipped += 1;
    }
  }

  await audit(req.user, 'signup.approve_all', null, { approved, skipped });
  res.json({ approved, skipped });
});

// ── Tournament settings ─────────────────────────────────────────────────────
// Opening and closing signups is the one control that matters right now: it is
// what freezes the pool before a draft.
router.put('/tournament', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament({ fresh: true });
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const patch = {};
  if (typeof req.body?.name === 'string') {
    const name = req.body.name.trim();
    if (!name) return res.status(400).json({ error: 'The tournament needs a name.' });
    patch.name = name.slice(0, 80);
  }
  if (typeof req.body?.status === 'string') {
    const allowed = ['setup', 'signups', 'draft', 'live', 'complete'];
    if (!allowed.includes(req.body.status)) {
      return res.status(400).json({ error: `Status must be one of: ${allowed.join(', ')}.` });
    }
    patch.status = req.body.status;
  }
  if (req.body?.signups_close_at !== undefined) {
    patch.signups_close_at = req.body.signups_close_at || null;
  }
  if (req.body?.roster_size !== undefined) {
    const n = Number(req.body.roster_size);
    if (!Number.isInteger(n) || n < 1 || n > 20) {
      return res.status(400).json({ error: 'Roster size is a whole number between 1 and 20.' });
    }
    patch.roster_size = n;
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nothing to change.' });

  const { data, error } = await supabase
    .from('tournaments').update(patch).eq('id', t.id).select('*').single();

  if (error) {
    console.error('tournament update failed:', error.message);
    return res.status(500).json({ error: 'Could not save that.' });
  }

  invalidateTournament();
  await audit(req.user, 'tournament.update', t.id, patch);
  res.json({ tournament: data });
});

// ── Setup helper ────────────────────────────────────────────────────────────
// The tournament server's roles, so you can read the ID for
// DISCORD_ADMIN_ROLE_IDS off the running app instead of turning on developer
// mode and right-clicking through Discord.
router.get('/roles', async (req, res) => {
  try {
    res.json({ roles: await listRoles(), configured: botConfigured });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
