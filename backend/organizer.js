// backend/organizer.js — the approval queue and the tournament's own settings.
//
// Mounted behind requireOrganizer, so every route here already knows the caller
// runs the tournament. Each decision is audit-logged and DMed.
const express = require('express');
const { supabase, currentTournament, invalidateTournament, audit } = require('./db');
const { sendDM, listRoles, fetchMember, botConfigured } = require('./discord');
const { resizeTemplate, templateFits, SLOT_NAMES } = require('../shared/parties.cjs');

const router = express.Router();

// The organizer sees everything a player wrote, plus who they are on Discord.
const FULL = 'id, discord_id, discord_username, player_name, classes, role, positions, nights, '
  + 'notes, wants_captain, wants_shotcall, status, decision_note, decided_by, decided_at, created_at, updated_at';

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
      ? `✅ Your signup for **${t.name}** is approved — you're on the draft board as **${data.player_name}** — ${data.role || 'role not set'}, ${(data.classes || []).join(', ')}.`
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
    .select('id, discord_id, player_name, classes, role')
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
      await sendDM(row.discord_id, `✅ Your signup for **${t.name}** is approved — you're on the draft board as **${row.player_name}** — ${row.role || 'role not set'}, ${(row.classes || []).join(', ')}.`);
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
    // Archiving is the one status change that alters what the SITE is pointing
    // at, so it is the one that asks. Every other transition is reversible with
    // another click; this one hands the app to a different tournament.
    if (req.body.status === 'complete' && String(req.body.confirm ?? '').trim() !== t.name) {
      return res.status(400).json({
        error: `Type the season's name exactly — "${t.name}" — to archive it.`,
      });
    }
    patch.status = req.body.status;
  }
  if (req.body?.signups_close_at !== undefined) {
    patch.signups_close_at = req.body.signups_close_at || null;
  }
  // roster_size is NOT writable — it is generated in the database as
  // party_count * party_size + sub_count (migration 003). Accepting it here
  // would let the total disagree with the parts it is supposed to be the sum
  // of, and nothing downstream could tell which of the two was meant.
  if (req.body?.roster_size !== undefined) {
    return res.status(400).json({
      error: 'Roster size is worked out from the parties and subs — set party_count, party_size or sub_count instead.',
    });
  }

  const STRUCTURE = {
    party_count: [1, 24, 'Parties per team'],
    party_size: [1, 12, 'Players per party'],
    sub_count: [0, 60, 'Substitutes'],
  };
  for (const [key, [lo, hi, label]] of Object.entries(STRUCTURE)) {
    if (req.body?.[key] === undefined) continue;
    const n = Number(req.body[key]);
    if (!Number.isInteger(n) || n < lo || n > hi) {
      return res.status(400).json({ error: `${label} must be a whole number between ${lo} and ${hi}.` });
    }
    patch[key] = n;
  }
  // An explicit template, if one was sent. Validated slot by slot: a slot type
  // the app does not know is a slot nothing can ever fill, and it would sit
  // there looking like a normal requirement.
  if (req.body?.party_template !== undefined) {
    const tpl = req.body.party_template;
    if (!Array.isArray(tpl) || tpl.length === 0) {
      return res.status(400).json({ error: 'A party template is a list of parties.' });
    }
    for (const party of tpl) {
      if (!Array.isArray(party?.slots) || party.slots.length === 0) {
        return res.status(400).json({ error: 'Every party needs at least one slot.' });
      }
      const bad = party.slots.find((x) => !SLOT_NAMES.includes(x));
      if (bad) return res.status(400).json({ error: `"${bad}" is not a slot type.` });
    }
    patch.party_template = tpl.map((p) => ({
      name: String(p.name || 'Party').slice(0, 40),
      slots: p.slots,
    }));
  }

  // THE TEMPLATE AND THE NUMBERS MOVE TOGETHER, always.
  //
  // roster_size is generated from party_count * party_size + sub_count, and
  // every role requirement is counted off the template. Changing one without
  // the other leaves two descriptions of one thing that disagree — and only
  // half of that is caught by a constraint, so party_size could be changed on
  // its own and silently leave a 52-player roster beside a template describing
  // 48 starters.
  const nextCount = patch.party_count ?? t.party_count;
  const nextSize = patch.party_size ?? t.party_size;
  const base = patch.party_template ?? t.party_template;
  if (!templateFits(base, nextCount, nextSize)) {
    patch.party_template = resizeTemplate(base, nextCount, nextSize);
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

/**
 * Start a new season.
 *
 * Only when nothing is running, and that guard is the whole safety of it:
 * currentTournament picks the OLDEST unfinished tournament, so creating one
 * beside a live season would leave the new row invisible until the old one was
 * archived — a button that appears to do nothing, then does something
 * surprising a month later.
 *
 * Everything but the name defaults: 8 parties of 6 plus 12 subs, and the party
 * template that matches. Status is 'setup', not 'signups', so signups open when
 * an organizer says so rather than the instant the row exists.
 */
router.post('/tournament', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });

  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'The season needs a name.' });
  if (name.length > 80) return res.status(400).json({ error: 'Names are 80 characters or fewer.' });

  const { data: running } = await supabase
    .from('tournaments').select('id, name, status')
    .neq('status', 'complete').order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (running) {
    return res.status(409).json({
      error: `"${running.name}" is still running. Archive it before starting a new season — `
        + 'two unfinished tournaments and the site would keep showing the older one.',
    });
  }

  const { data, error } = await supabase
    .from('tournaments').insert({ name, status: 'setup' }).select('*').single();
  if (error) {
    console.error('tournament create failed:', error.message);
    return res.status(500).json({ error: 'Could not create that season.' });
  }

  invalidateTournament();
  await audit(req.user, 'tournament.create', data.id, { name });
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

// ── Is the sign-in role actually grantable? ─────────────────────────────────
// Discord reports "bot lacks Manage Roles" and "bot's role is below the target
// role" with the same 50013, so a failing grant sends people to check the one
// that was already fine. This answers both questions directly, by comparing
// positions in the role list rather than by attempting a grant on a real member.
router.get('/hierarchy', async (req, res) => {
  const roleId = (process.env.DISCORD_VERIFIED_ROLE_ID || '').trim();
  if (!botConfigured) {
    return res.json({ ok: false, reason: 'No bot token is configured.' });
  }
  if (!roleId) {
    return res.json({ ok: true, enabled: false, reason: 'DISCORD_VERIFIED_ROLE_ID is empty — no role is granted on sign-in.' });
  }

  try {
    const roles = await listRoles();
    const target = roles.find((r) => r.id === roleId);
    if (!target) {
      return res.json({
        ok: false, enabled: true, roleId,
        reason: `No role with ID ${roleId} exists in this server. Check DISCORD_VERIFIED_ROLE_ID.`,
      });
    }

    // The bot's own roles aren't in listRoles() output (that's every role in
    // the server), so read the bot's member object to find which it holds.
    // A bot's user ID is its application ID, which is DISCORD_CLIENT_ID.
    const botUserId = (process.env.DISCORD_CLIENT_ID || '').trim();
    if (!botUserId) {
      return res.json({
        ok: false, enabled: true, role: target,
        reason: 'DISCORD_CLIENT_ID is not set, so the bot\'s own rank can\'t be looked up.',
      });
    }
    const me = await fetchMember(botUserId);
    if (me.status !== 200) {
      return res.json({
        ok: false, enabled: true, role: target,
        reason: 'Could not read the bot\'s own member record — is the bot actually in this server?',
      });
    }
    const botRoles = roles.filter((r) => (me.member.roles || []).includes(r.id));
    const botTop = botRoles.reduce((hi, r) => (!hi || r.position > hi.position ? r : hi), null);

    if (!botTop) {
      return res.json({
        ok: false, enabled: true, role: target,
        reason: 'The bot holds no roles at all, so it sits below everything. Re-invite it with the Manage Roles permission.',
      });
    }
    if (botTop.position <= target.position) {
      return res.json({
        ok: false, enabled: true, role: target, botTopRole: botTop,
        reason: `The bot's highest role ("${botTop.name}", position ${botTop.position}) is NOT above `
          + `"${target.name}" (position ${target.position}). Drag the bot's role higher in `
          + 'Server Settings → Roles — grants will fail until you do.',
      });
    }

    res.json({
      ok: true, enabled: true, role: target, botTopRole: botTop,
      reason: `"${botTop.name}" outranks "${target.name}" — grants should work.`,
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

module.exports = router;
