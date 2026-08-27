// backend/draft.js — the live snake draft.
//
// Three routers, and the difference between them is the whole security model:
//
//   publicRouter    — no session at all. What OBS points a browser source at.
//                     Read-only, and deliberately carries nothing that isn't
//                     already public: teams, rosters, picks, the clock. No
//                     boards, no Discord ids, no pool list.
//   router          — signed in. Adds the pool, and for a captain, their board
//                     and their pick button.
//   organizerRouter — start, pause, undo, pick-for, reset.
//
// THE CLOCK IS A ROW, NOT A TIMER. `drafts.pick_deadline` is the truth; the
// in-process setTimeout below is only an optimisation that makes an expiry
// prompt rather than lazy. Every read runs the clock forward before answering,
// so a redeploy at 9pm on draft night resumes on the next request instead of
// leaving the room staring at a frozen countdown.
//
// There is no SSE stream, which the original plan called for. The stream view
// needs a smooth countdown, and a smooth countdown is computed on the client
// from a deadline — it does not need a server push. What is actually pushed is
// a pick every minute or two. A 2s poll of a small JSON document delivers that
// perfectly well, survives proxies that buffer text/event-stream, survives a
// redeploy without a reconnect dance, and works if this ever runs on more than
// one instance. SSE would be a second transport to keep working for no gain
// anybody watching could see.
const express = require('express');
const { supabase, currentTournament, audit } = require('./db');
const { sendDM } = require('./discord');
const {
  captaincyFor, captainsByTeam, rostersByTeam, rosteredIds, addToRoster, conflictMessage,
} = require('./teams');
const { slotFor, teamOnClock, totalPicks, upcoming, nextPickFor, worstCaseSeconds } = require('../shared/draftOrder.cjs');
const { autoPick } = require('../shared/autopick.cjs');
const { tierMeta } = require('../shared/board.cjs');
const { rosterProgress } = require('../shared/roster.cjs');
const { roleDemand } = require('../shared/parties.cjs');
const { ROLES } = require('../shared/roles.cjs');

// How late a deadline may be before the draft stops itself instead of picking.
//
// A clock that expired forty seconds ago is a captain who stepped away — pick
// for them, that is what the clock is for. A clock that expired forty minutes
// ago is the site having been down, or the room having gone to bed. Firing
// thirty auto-picks into an empty room turns a recoverable outage into a draft
// nobody agrees with, and it does it in the ten seconds after the site comes
// back up, before anyone can reach the pause button.
const STALL_GRACE_MS = 5 * 60 * 1000;

// Auto-picks one request will make before handing back. Several deadlines can
// genuinely be due at once — three captains all away — but a request that sits
// there resolving twenty of them is a request that times out.
const MAX_AUTO_PER_PASS = 5;

// What a captain needs to know about somebody they are deciding whether to
// draft. `notes` is what the player wrote about themselves at signup — "can
// flex healer", "only free after 9" — and it is the single most useful thing on
// this list that nothing else conveys.
//
// ⚠️  This select reaches PUBLIC responses through the picks feed, so nothing
// here goes out unredacted. `casting` and `feedPlayer` below name the fields
// that may leave the building; anything not in them stops at a session.
const PLAYER = 'id, player_name, discord_username, role, classes, positions, nights, notes, wants_shotcall';
const TEAM = 'id, name, tag, seed';

const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

// ── The draft row ───────────────────────────────────────────────────────────
async function draftRow(tournamentId, { create = true } = {}) {
  const { data, error } = await supabase
    .from('drafts').select('*').eq('tournament_id', tournamentId).maybeSingle();
  if (error) throw new Error(`draft read failed: ${error.message}`);
  if (data || !create) return data || null;

  // Created on demand rather than relied on from the migration's seed insert,
  // so a tournament made after 010 ran still has a draft to look at.
  const { data: made, error: insErr } = await supabase
    .from('drafts').insert({ tournament_id: tournamentId }).select('*').single();
  if (insErr) {
    // Two requests racing to create it: the primary key means one wins, and the
    // loser just reads what the winner wrote.
    const { data: again } = await supabase
      .from('drafts').select('*').eq('tournament_id', tournamentId).maybeSingle();
    if (again) return again;
    throw new Error(`draft create failed: ${insErr.message}`);
  }
  return made;
}

/**
 * Turn a read failure into something actionable.
 *
 * The one that will actually happen is 010 not having been run: every draft
 * page then fails identically and says "could not read the draft", which sends
 * whoever is looking at the code rather than at the SQL editor. Same shape as
 * the hint in /api/health, and for the same reason.
 */
function readFailure(res, err, what) {
  console.error(`${what} failed:`, err.message);
  if (/schema cache|does not exist|relation/i.test(err.message)) {
    return res.status(503).json({
      error: 'The draft tables are missing — run migrations/010_draft.sql in the '
        + 'Supabase SQL editor, then migrations/verify.sql.',
    });
  }
  return res.status(500).json({ error: 'Could not read the draft.' });
}

const order = (d) => (Array.isArray(d.order_snapshot) ? d.order_snapshot : []);
const total = (d) => totalPicks(order(d).length, d.rounds);
const deadlineFrom = (seconds) => new Date(Date.now() + seconds * 1000).toISOString();

// ── The clock ───────────────────────────────────────────────────────────────
// One in-flight clock run per tournament. Without it, six people watching the
// stream all arrive a millisecond after a deadline and all six try to make the
// same auto-pick — the unique index means only one lands, but the other five
// each cost a failed insert and a re-read for nothing.
const clockLocks = new Map();

async function runClock(t, draft) {
  const pending = clockLocks.get(t.id);
  if (pending) {
    await pending.catch(() => {});
    return (await draftRow(t.id)) || draft;
  }

  const job = (async () => {
    let d = draft;
    for (let n = 0; n < MAX_AUTO_PER_PASS; n++) {
      if (d.status !== 'live' || !d.pick_deadline) return d;

      const late = Date.now() - new Date(d.pick_deadline).getTime();
      if (late < 0) return d;                       // still on the clock
      if (late > STALL_GRACE_MS) return stall(t, d, late);

      const next = await autoPickNow(t, d);
      if (!next) return d;
      d = next;
    }
    return d;
  })();

  clockLocks.set(t.id, job);
  try {
    return await job;
  } finally {
    clockLocks.delete(t.id);
  }
}

async function stall(t, d, late) {
  const mins = Math.max(1, Math.round(late / 60000));
  const reason = `The clock ran out ${mins} minute${mins === 1 ? '' : 's'} ago and nothing picked, `
    + 'so the draft paused itself rather than auto-picking through a room nobody was in. '
    + 'Resume when everyone is back.';

  const { data } = await supabase.from('drafts')
    .update({ status: 'paused', pick_deadline: null, paused_reason: reason })
    .eq('tournament_id', t.id).eq('status', 'live')
    .select('*').maybeSingle();

  if (data) console.warn(`draft stalled and paused itself (${mins}m late)`);
  return data || d;
}

async function autoPickNow(t, d) {
  const teamId = teamOnClock(order(d), d.current_pick);
  if (!teamId) return null;

  const choice = await chooseAuto(t, d, teamId);
  if (!choice) {
    const { data } = await supabase.from('drafts')
      .update({
        status: 'paused',
        pick_deadline: null,
        paused_reason: 'There is nobody left in the approved pool to pick. '
          + 'Approve more signups, or end the draft here.',
      })
      .eq('tournament_id', t.id).eq('status', 'live')
      .select('*').maybeSingle();
    return data || null;
  }

  const result = await makePick(t, d, {
    teamId, signupId: choice.signupId, auto: true, reason: choice.reason,
  });
  // A failure here is almost always a captain having beaten the clock by
  // milliseconds, which is a good outcome, not an error. Re-read and move on.
  if (result.error) return draftRow(t.id);
  return result.draft;
}

/** Who the clock picks for this team. See shared/autopick.cjs for the order. */
async function chooseAuto(t, d, teamId) {
  const [boardRes, poolRes, rosters, taken] = await Promise.all([
    supabase.from('draft_board_entries').select('signup_id, tier, rank').eq('team_id', teamId),
    supabase.from('player_signups').select('id, player_name, role')
      .eq('tournament_id', t.id).eq('status', 'approved')
      .order('player_name', { ascending: true }),
    rostersByTeam(t.id),
    rosteredIds(t.id),
  ]);
  if (poolRes.error) throw new Error(`autopick pool read failed: ${poolRes.error.message}`);

  const pool = (poolRes.data || []).filter((p) => !taken.has(p.id));
  const board = (boardRes.data || []).filter((e) => !taken.has(e.signup_id));
  const template = Array.isArray(t.party_template) ? t.party_template : [];

  return autoPick(board, pool, rosters.get(teamId) || [], roleDemand(template, 1));
}

// ── Prompt expiry ───────────────────────────────────────────────────────────
// The row is the truth; this only makes the expiry happen ON the second rather
// than on whichever request comes next. Re-armed by every read, which is what
// gets the timer back after a redeploy.
const timers = new Map();

function armTimer(t, d) {
  const existing = timers.get(t.id);
  if (d.status !== 'live' || !d.pick_deadline) {
    if (existing) { clearTimeout(existing.handle); timers.delete(t.id); }
    return;
  }
  if (existing && existing.at === d.pick_deadline) return;   // already armed for this one
  if (existing) clearTimeout(existing.handle);

  const wait = Math.max(250, new Date(d.pick_deadline).getTime() - Date.now() + 250);
  const handle = setTimeout(async () => {
    timers.delete(t.id);
    try {
      const fresh = await currentTournament();
      if (!fresh) return;
      const row = await draftRow(fresh.id, { create: false });
      if (row) armTimer(fresh, await runClock(fresh, row));
    } catch (err) {
      console.warn('draft clock tick failed:', err.message);
    }
  }, wait);

  // Don't hold the process open for a deadline five minutes out.
  if (handle.unref) handle.unref();
  timers.set(t.id, { handle, at: d.pick_deadline });
}

/** Read the draft, run the clock forward, re-arm the timer. */
async function liveDraft(t) {
  const row = await draftRow(t.id);
  if (!row) return null;
  const d = await runClock(t, row);
  armTimer(t, d);
  return d;
}

// ── Making a pick ───────────────────────────────────────────────────────────
/**
 * The one function that writes a pick — captain, organizer and clock all come
 * through here.
 *
 * Order of operations, and each step is load-bearing:
 *   1. claim the pick NUMBER    — unique index, so two clicks make one pick
 *   2. put them on the roster   — via addToRoster, which clears every board
 *   3. advance the clock        — guarded on the pick number we just made
 *
 * If step 2 fails the pick row from step 1 is deleted again, because a pick
 * that didn't put anybody on a roster is not a pick — it is a gap the draft
 * would step straight over.
 *
 * Returns { pick, draft, player, reason } or { error, code }.
 */
async function makePick(t, d, { teamId, signupId, auto = false, madeBy = null, reason = null }) {
  if (d.status !== 'live') {
    return { error: 'The draft is not running.', code: 409 };
  }
  const seats = order(d);
  if (d.current_pick > total(d)) {
    return { error: 'Every pick has already been made.', code: 409 };
  }

  const slot = slotFor(seats.length, d.current_pick);
  const onClock = seats[slot.seatIndex];
  if (onClock !== teamId) {
    return { error: 'It is not that team\'s pick.', code: 409 };
  }

  // The player must be an approved signup here. Checked rather than trusted,
  // for the same reason the board checks it: a pick with nobody behind it is a
  // roster slot that can never be filled or explained.
  const { data: player, error: pErr } = await supabase
    .from('player_signups').select(PLAYER + ', status, discord_id')
    .eq('id', signupId || '00000000-0000-0000-0000-000000000000')
    .eq('tournament_id', t.id).maybeSingle();
  if (pErr) return { error: 'Could not check that player.', code: 500 };
  if (!player) return { error: 'That player is not in this tournament.', code: 400 };
  if (player.status !== 'approved') {
    return { error: `${player.player_name} is not an approved signup.`, code: 400 };
  }

  // 1. Claim the pick number. THE mutex — see migrations/010.
  const { data: pick, error: insErr } = await supabase.from('draft_picks').insert({
    tournament_id: t.id,
    team_id: teamId,
    signup_id: signupId,
    pick_number: d.current_pick,
    round: slot.round,
    auto,
    made_by: madeBy,
  }).select('*').single();

  if (insErr) {
    const detail = `${insErr.message || ''} ${insErr.details || ''}`;
    if (/draft_picks_number_unique/.test(detail)) {
      return { error: 'That pick was just made — the board has already moved on.', code: 409 };
    }
    if (/draft_picks_player_once/.test(detail)) {
      return { error: `${player.player_name} has already been drafted.`, code: 409 };
    }
    console.error('pick insert failed:', insErr.message);
    return { error: 'Could not save that pick.', code: 500 };
  }

  // 2. Onto the roster, and off every board. One door — see teams.addToRoster.
  const { error: rosterErr, cleared } = await addToRoster(t.id, teamId, signupId, 'draft', {
    draft_round: slot.round,
    draft_pick: pick.pick_number,
  });
  if (rosterErr) {
    await supabase.from('draft_picks').delete().eq('id', pick.id);
    const msg = conflictMessage(rosterErr);
    console.error('pick roster insert failed:', rosterErr.message);
    return { error: msg || 'Could not put them on the roster, so the pick was not made.', code: msg ? 409 : 500 };
  }

  // Remember what the pick cost other captains' boards, so an undo can give it
  // back. Not fatal: a pick that happened must not be reported as failed
  // because a bookkeeping column didn't save.
  if (cleared?.length) {
    const { error: noteErr } = await supabase
      .from('draft_picks').update({ cleared_entries: cleared }).eq('id', pick.id);
    if (noteErr) console.warn(`pick ${pick.pick_number} did not record its cleared board entries: ${noteErr.message}`);
  }

  // 3. Advance. The cached snapshot is thrown away first, so the captain who
  // just picked sees their own pick on the very next poll rather than up to a
  // second later — which on the clock is the difference between "did that
  // work?" and knowing.
  const draft = await advance(t, d, pick.pick_number);
  invalidate(t.id);
  armTimer(t, draft);

  return { pick, draft, player, reason, cleared: cleared || [] };
}

async function advance(t, d, justMade) {
  const done = justMade + 1 > total(d);
  const patch = done
    ? {
      current_pick: justMade + 1,
      status: 'complete',
      pick_deadline: null,
      paused_reason: null,
      completed_at: new Date().toISOString(),
    }
    : {
      current_pick: justMade + 1,
      pick_deadline: deadlineFrom(d.pick_seconds),
      paused_reason: null,
    };

  const { data, error } = await supabase.from('drafts').update(patch)
    .eq('tournament_id', t.id)
    .eq('current_pick', justMade)      // nobody advances the same pick twice
    .select('*').maybeSingle();

  if (error) console.error('draft advance failed:', error.message);
  return data || (await draftRow(t.id));
}

// ── Assembling what everyone sees ───────────────────────────────────────────
/**
 * A roster member, with their Discord identity taken off.
 *
 * rostersByTeam selects discord_id and discord_username because the teams page
 * needs them. This does not, and the PUBLIC route is built from the same
 * snapshot — an unauthenticated endpoint listing a hundred and fifty people's
 * Discord ids is a scrape waiting to happen, and no part of a broadcast needs
 * one. Stripped here, once, rather than remembered at each of two call sites.
 */
const shown = (m) => ({
  id: m.id,
  player_name: m.player_name,
  role: m.role,
  classes: m.classes,
  positions: m.positions,
  via: m.via,
  draft_round: m.draft_round,
  draft_pick: m.draft_pick,
});

// How much of each roster travels with the state.
//
// A full roster is sixty players; eight teams of those, sent to every viewer
// every two seconds, is a megabyte a second of a broadcast re-reading names
// nothing on screen is showing. Neither page renders more than the last handful
// — the draft page shows a count, the stream shows the newest few — so the
// count comes from `progress`, computed over everybody, and only the recent
// picks travel. The full rosters live on the teams page, which asks for them.
/**
 * A player as the pool and the picks feed show them.
 *
 * The allow-list that keeps two things off every unauthenticated response:
 *
 *   discord_username — a hundred and fifty of these on an open endpoint is a
 *                      scrape, and no broadcast needs one.
 *   notes            — free text somebody wrote for the organizers. People
 *                      explain shift patterns and health in these. They are for
 *                      captains and organizers, and they do not go on a stream.
 *
 * Written as a pick-list rather than a delete-list on purpose: a column added to
 * player_signups later is excluded by default instead of being published by
 * whoever forgot this file existed.
 */
const casting = (p) => ({
  id: p.id,
  player_name: p.player_name,
  role: p.role,
  classes: p.classes,
  positions: p.positions,
  wants_shotcall: p.wants_shotcall,
});

// A pick, for the feed both pages render. Redacted through `casting` — the feed
// is on the public route, and it was quietly carrying discord_username until
// this existed.
const feedPlayer = (row) => ({
  pick_number: row.pick_number,
  round: row.round,
  team_id: row.team_id,
  auto: row.auto,
  created_at: row.created_at,
  player: casting(row.player),
});

const RECENT_PER_TEAM = 8;

const recentPicks = (members) => [...members]
  .filter((m) => m.draft_pick != null)
  .sort((a, b) => b.draft_pick - a.draft_pick)
  .slice(0, RECENT_PER_TEAM)
  .map(shown);

async function assembleState(t, d) {
  const [teamsRes, picksRes, byCaptain, rosters] = await Promise.all([
    supabase.from('teams').select(TEAM).eq('tournament_id', t.id)
      .order('seed', { ascending: true, nullsFirst: false }),
    supabase.from('draft_picks')
      .select(`pick_number, round, team_id, auto, made_by, created_at, player:player_signups (${PLAYER})`)
      .eq('tournament_id', t.id)
      .order('pick_number', { ascending: false }).limit(20),
    captainsByTeam(t.id),
    rostersByTeam(t.id),
  ]);

  if (teamsRes.error) throw new Error(`draft teams read failed: ${teamsRes.error.message}`);
  if (picksRes.error) throw new Error(`draft picks read failed: ${picksRes.error.message}`);

  const seats = order(d);
  const teams = (teamsRes.data || []).map((x) => {
    const members = rosters.get(x.id) || [];
    return {
      ...x,
      captains: (byCaptain.get(x.id) || []).map((c) => ({ player_name: c.player_name, label: c.label })),
      // Named `recent`, not `roster` — it is the newest few picks, and calling a
      // truncated list a roster is how somebody later renders eight players and
      // believes that is the team.
      recent: recentPicks(members),
      progress: rosterProgress(members, t.roster_size),
      // Where they sit in the frozen order. -1 for a team that isn't in this
      // draft at all, which can only happen if one was created after it started
      // — blocked, but better shown than hidden.
      slot: seats.indexOf(x.id),
    };
  });

  const onClock = d.status === 'live' || d.status === 'paused'
    ? teamOnClock(seats, d.current_pick)
    : null;
  const here = slotFor(seats.length, d.current_pick);

  // How many of each role every team still HAS to find, added up. Paired with
  // how many are left in the pool this is the scarcity story a commentator
  // wants — "four tanks left and three teams still need two each" is a thing to
  // say; "137 available" is not.
  //
  // Against the per-team minimum, not the maximum: the floor is the number
  // below which a roster genuinely cannot be fielded, and the flexible slots
  // have no single answer. See shared/parties.cjs.
  const perTeam = roleDemand(Array.isArray(t.party_template) ? t.party_template : [], 1);
  const needs = {};
  ROLES.forEach((role) => {
    needs[role] = teams.reduce((sum, x) => {
      const have = (x.progress.byRole.find((r) => r.role === role) || {}).have || 0;
      return sum + Math.max(0, (perTeam[role]?.min ?? 0) - have);
    }, 0);
  });

  return {
    tournament: { name: t.name, status: t.status, rosterSize: t.roster_size },
    draft: {
      status: d.status,
      pickSeconds: d.pick_seconds,
      currentPick: d.current_pick,
      totalPicks: total(d),
      rounds: d.rounds,
      round: here?.round ?? null,
      pickInRound: here?.pickInRound ?? null,
      deadline: d.pick_deadline,
      // The client counts down from (deadline - serverTime), not from its own
      // clock. A machine ten seconds fast would otherwise show ten seconds
      // wrong on stream, and be certain about it.
      serverTime: new Date().toISOString(),
      pausedReason: d.paused_reason || null,
      startedAt: d.started_at,
      completedAt: d.completed_at,
      onClock,
      onDeck: upcoming(seats, d.current_pick + 1, 5, d.rounds),
      order: seats,
    },
    teams,
    needs,
    picks: (picksRes.data || []).filter((p) => p.player).map(feedPlayer),
  };
}

// ── One read, however many people are watching ──────────────────────────────
// Draft night is the only time this app has an audience: every captain has the
// draft page open, and every stream viewer is polling /watch every two seconds.
// Without this, forty viewers is forty times seven queries every two seconds,
// all returning the same bytes — and the site gets slow at precisely the moment
// it is being broadcast.
//
// The PROMISE is cached, not the result, which also collapses the burst of
// requests that arrive together in the same instant into a single database
// read. A rejected promise caches too and expires with the rest; the next
// window retries.
const SNAPSHOT_MS = 1200;
const snapshots = new Map();

function invalidate(tournamentId) {
  snapshots.delete(tournamentId);
}

async function snapshot(t, d) {
  const hit = snapshots.get(t.id);
  if (hit && Date.now() - hit.at < SNAPSHOT_MS) return hit.job;

  const job = (async () => {
    const [state, taken, poolRes] = await Promise.all([
      assembleState(t, d),
      rosteredIds(t.id),
      supabase.from('player_signups').select(PLAYER)
        .eq('tournament_id', t.id).eq('status', 'approved')
        .order('player_name', { ascending: true }),
    ]);
    if (poolRes.error) throw new Error(`draft pool read failed: ${poolRes.error.message}`);
    return { state, taken, pool: (poolRes.data || []).filter((p) => !taken.has(p.id)) };
  })();

  snapshots.set(t.id, { at: Date.now(), job });
  return job;
}

/**
 * Stamp the moment of sending onto a snapshot that may be up to a second old.
 *
 * serverTime is what the browser measures its own clock skew against, so it has
 * to be the truth about NOW rather than the truth about when this payload was
 * built. Getting this wrong would make every countdown on the stream run up to
 * a second slow, consistently, and look entirely plausible while doing it.
 */
const stamped = (state) => ({
  ...state,
  draft: { ...state.draft, serverTime: new Date().toISOString() },
});

// ── Public: the stream view ─────────────────────────────────────────────────
// No session. Mounted before requireAuth in server.js, deliberately: an OBS
// browser source has no cookie, and neither does anybody who opens the link
// from the stream.
//
// Everything here is already public — team rosters and draft picks are the
// thing being broadcast. What is NOT here, ever: draft boards, and any Discord
// identity at all.
//
// The available-player list IS here, on request, because a commentator cannot
// call a draft without knowing who is left — and every name in it is an in-game
// character name that gets read aloud the moment that player is picked. The
// line drawn is bulk DISCORD identity, not character names: `casting` strips
// discord_username, which a hundred and fifty of on an open endpoint is a
// scrape, and which no commentator needs.
const publicRouter = express.Router();

publicRouter.get('/', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.json({ tournament: null, draft: null, teams: [], picks: [] });

  try {
    const d = await liveDraft(t);
    if (!d) return res.json({ tournament: null, draft: null, teams: [], picks: [] });

    const { state, pool } = await snapshot(t, d);

    // How many are left of each role, against how many the teams still have to
    // find. Three numbers, so everybody gets them.
    const scarcity = ROLES.map((role) => ({
      role,
      available: pool.filter((p) => p.role === role).length,
      needed: state.needs?.[role] ?? 0,
    }));

    // ── Sending a hundred and fifty names twice a second, but only once ────
    //
    // The pool changes when a pick is made, which is every couple of MINUTES.
    // The clock changes every couple of seconds. Sending both at the clock's
    // rate is twenty kilobytes a poll per viewer to re-deliver a list that is
    // identical to the one already on screen.
    //
    // So the pool carries a version, and a caller that already holds that
    // version says so with `have`. It gets everything else and no list, and
    // keeps rendering the copy it has.
    //
    // The version is the pick number and the pool size, which between them
    // move on every event that changes who is available: a pick, and an
    // organizer approving or withdrawing somebody mid-draft. An organizer
    // EDITING a player's classes mid-draft is not covered and will show stale
    // until the next pick — a trade taken deliberately for a version that
    // costs nothing to compute.
    const poolVersion = `${d.current_pick}.${pool.length}`;
    const wantsPool = req.query.pool === '1' || req.query.pool === 'true';
    const held = String(req.query.have || '');

    res.json({
      ...stamped(state),
      poolCount: pool.length,
      poolVersion,
      scarcity,
      ...(wantsPool && held !== poolVersion && { pool: pool.map(casting) }),
    });
  } catch (err) {
    readFailure(res, err, 'public draft read');
  }
});

// ── Signed in: the captain's side ───────────────────────────────────────────
const router = express.Router();

router.get('/', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.json({ tournament: null, draft: null, teams: [], picks: [] });

  try {
    const d = await liveDraft(t);
    if (!d) return res.json({ tournament: null, draft: null, teams: [], picks: [] });

    const [{ state, taken, pool }, seatsHeld] = await Promise.all([
      snapshot(t, d),
      // NOT cached, and deliberately: captaincy is the permission this page's
      // pick button hangs off, and a captain swapped a minute ago must lose it
      // on their next request rather than on the next cache window.
      captaincyFor(req.user?.id, t.id),
    ]);
    const mine = seatsHeld[0] || null;

    let you = null;
    let board = [];
    if (mine) {
      const seats = order(d);
      const next = nextPickFor(seats, mine.id, d.current_pick, d.rounds);
      you = {
        teamId: mine.id,
        name: mine.name,
        label: mine.label,
        onClock: state.draft.onClock === mine.id,
        nextPick: next,
        // "Three picks away" is what a captain actually plans against — the
        // absolute pick number tells them nothing without counting.
        picksAway: next === null ? null : next - d.current_pick,
      };

      // Their board, best first, with anybody already gone filtered out. This
      // is the point of having built one: on the clock, the top of this list is
      // the answer.
      const { data: entries } = await supabase
        .from('draft_board_entries')
        .select(`signup_id, tier, rank, note, player:player_signups (${PLAYER})`)
        .eq('team_id', mine.id)
        .order('tier', { ascending: true }).order('rank', { ascending: true });

      // The Avoid pile is left out. On the board page it earns its place —
      // "we already decided against them" is information. Here the list is
      // titled "best available" and is what a captain reads top-down with a
      // clock running, so a name they ruled out has no business in it. It is
      // still in the pool below, if they change their mind.
      board = (entries || [])
        .filter((e) => e.player && !taken.has(e.signup_id) && !tierMeta(e.tier)?.exclude)
        .map((e) => ({ ...e.player, ...e, signup_id: e.signup_id }));
    }

    // Signup notes and Discord handles go to the people who have a decision to
    // make with them — captains and organizers. /draft is open to every signed-
    // in player, and a spectator watching their own name come off the list has
    // no business reading a hundred and fifty people's notes.
    const privileged = !!mine || req.user?.isOrganizer;

    res.json({
      ...stamped(state),
      you,
      board,
      pool: privileged ? pool : pool.map(casting),
      poolCount: pool.length,
      // So the page knows whether it is showing everything, rather than
      // guessing from whether a field happens to be populated.
      full: privileged,
    });
  } catch (err) {
    readFailure(res, err, 'draft read');
  }
});

// ── A captain makes their pick ──────────────────────────────────────────────
// The team comes from the caller's captaincy, never from the body — the same
// rule the board follows, and for the same reason: with no team id to tamper
// with there is no "can I pick for team 4" to get wrong.
router.post('/pick', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const seatsHeld = await captaincyFor(req.user?.id, t.id);
  if (!seatsHeld.length) return res.status(403).json({ error: 'Only a team\'s captains can pick for it.' });
  const mine = seatsHeld[0];

  const d = await liveDraft(t);
  if (!d) return res.status(409).json({ error: 'There is no draft.' });
  if (d.status === 'paused') {
    return res.status(409).json({ error: 'The draft is paused — an organizer has to resume it.' });
  }

  // A stale page. Refused rather than applied: without this, a click made two
  // minutes ago lands as the pick that is on the clock NOW, which is a
  // different pick, possibly in a different round.
  const expected = req.body?.expected_pick;
  if (expected !== undefined && Number(expected) !== d.current_pick) {
    return res.status(409).json({ error: 'The draft has moved on since this page loaded — it refreshed itself.' });
  }

  const result = await makePick(t, d, {
    teamId: mine.id,
    signupId: req.body?.signup_id,
    madeBy: req.user?.username || null,
  });
  if (result.error) return res.status(result.code || 409).json({ error: result.error });

  await audit(req.user, 'draft.pick', mine.id, {
    pick: result.pick.pick_number, round: result.pick.round,
    team: mine.name, player: result.player.player_name,
  });
  res.json({ ok: true, pick: result.pick, player: result.player });
});

// ── Organizer ───────────────────────────────────────────────────────────────
const organizerRouter = express.Router();

/**
 * Why this draft can't start yet.
 *
 * Pure, and exported for the test. Every check here is one that produces a
 * QUIETLY UNFAIR draft rather than a broken one — the failure mode is a draft
 * that runs happily to the end and gives one team an extra player, which
 * nobody notices until the rosters are compared afterwards.
 *
 * @param rosterSize how many players a full roster holds
 * @param teams      [{ name, seed, rosterCount, captainCount }]
 */
function startProblems(rosterSize, teams) {
  const problems = [];
  const names = (list) => list.map((x) => x.name).join(', ');

  if (teams.length < 2) {
    problems.push('A draft needs at least two teams.');
    return { problems, rounds: 0 };
  }

  const unseeded = teams.filter((x) => !x.seed);
  if (unseeded.length) {
    problems.push(`${names(unseeded)} ${unseeded.length === 1 ? 'has' : 'have'} no seed. `
      + 'The seed order is the draft order, so every team needs one.');
  }

  const leaderless = teams.filter((x) => x.captainCount === 0);
  if (leaderless.length) {
    problems.push(`${names(leaderless)} ${leaderless.length === 1 ? 'has' : 'have'} no captain — `
      + 'nobody could pick, and every one of their picks would be made by the clock.');
  }

  // The unfair one. A snake gives every team the same NUMBER of picks, so a
  // team that starts with two captains and one that starts with one finish a
  // player apart — and the draft will run to the end without complaining.
  const counts = [...new Set(teams.map((x) => x.rosterCount))];
  if (counts.length > 1) {
    const spread = teams.map((x) => `${x.name} ${x.rosterCount}`).join(', ');
    problems.push(`The teams do not start level (${spread}). Every team gets the same number `
      + 'of picks, so they would finish that far apart. Even up the captains first.');
  }

  const start = counts.length === 1 ? counts[0] : Math.max(...counts, 0);
  const rounds = rosterSize - start;
  if (rounds <= 0) {
    problems.push(`A roster is ${rosterSize} and the teams already hold ${start} — there is nothing to draft.`);
  }

  return { problems, rounds: Math.max(0, rounds) };
}

organizerRouter.get('/', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament();
  if (!t) return res.json({ draft: null });

  try {
    const d = await liveDraft(t);
    if (!d) return res.json({ draft: null });

    const { state } = await snapshot(t, d);
    const check = startProblems(
      t.roster_size,
      // progress.filled, NOT recent.length — `recent` is the truncated list
      // that travels to the page, and counting it would report every team as
      // holding eight players and refuse to start a draft that was fine.
      state.teams.map((x) => ({
        name: x.name, seed: x.seed,
        rosterCount: x.progress.filled, captainCount: x.captains.length,
      }))
    );

    const picks = totalPicks(state.teams.length, d.rounds || check.rounds);
    res.json({
      ...stamped(state),
      canStart: check.problems.length === 0,
      problems: check.problems,
      plan: {
        rounds: d.rounds || check.rounds,
        picks,
        // The number nobody works out in advance, and the one that decides
        // whether draft night is an evening or a weekend.
        worstCaseSeconds: worstCaseSeconds(state.teams.length, d.rounds || check.rounds, d.pick_seconds),
      },
    });
  } catch (err) {
    readFailure(res, err, 'organizer draft read');
  }
});

organizerRouter.post('/start', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const t = await currentTournament({ fresh: true });
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const d = await draftRow(t.id);
  if (d.status === 'live') return res.status(409).json({ error: 'The draft is already running.' });
  if (d.status === 'paused') return res.status(409).json({ error: 'The draft is paused — resume it rather than starting it again.' });

  const { count } = await supabase.from('draft_picks')
    .select('id', { count: 'exact', head: true }).eq('tournament_id', t.id);
  if (count > 0) {
    return res.status(409).json({
      error: `There are already ${count} picks on record. Reset the draft before starting a new one.`,
    });
  }

  const [teamsRes, byCaptain, rosters] = await Promise.all([
    supabase.from('teams').select(TEAM).eq('tournament_id', t.id)
      .order('seed', { ascending: true, nullsFirst: false }),
    captainsByTeam(t.id),
    rostersByTeam(t.id),
  ]);
  if (teamsRes.error) return res.status(500).json({ error: 'Could not read the teams.' });

  const teams = teamsRes.data || [];
  const check = startProblems(t.roster_size, teams.map((x) => ({
    name: x.name, seed: x.seed,
    rosterCount: (rosters.get(x.id) || []).length,
    captainCount: (byCaptain.get(x.id) || []).length,
  })));
  if (check.problems.length) return res.status(409).json({ error: check.problems[0], problems: check.problems });

  const seconds = req.body?.pick_seconds === undefined ? d.pick_seconds : Number(req.body.pick_seconds);
  if (!Number.isInteger(seconds) || seconds < 15 || seconds > 1800) {
    return res.status(400).json({ error: 'The pick clock is a whole number of seconds, 15 to 1800.' });
  }

  const snapshot = teams.map((x) => x.id);   // already in seed order
  const { data, error } = await supabase.from('drafts').update({
    status: 'live',
    order_snapshot: snapshot,
    rounds: check.rounds,
    pick_seconds: seconds,
    current_pick: 1,
    pick_deadline: deadlineFrom(seconds),
    paused_reason: null,
    started_at: new Date().toISOString(),
    completed_at: null,
  }).eq('tournament_id', t.id).select('*').single();

  if (error) {
    console.error('draft start failed:', error.message);
    return res.status(500).json({ error: 'Could not start the draft.' });
  }

  invalidate(t.id);

  armTimer(t, data);
  await audit(req.user, 'draft.start', null, {
    teams: teams.length, rounds: check.rounds, picks: totalPicks(teams.length, check.rounds), pick_seconds: seconds,
  });

  // Tell the captains it has begun, and where they sit. Non-fatal, like every
  // DM in this app: the draft is running whether or not Discord cooperates.
  for (const [teamId, list] of byCaptain) {
    const seatIndex = snapshot.indexOf(teamId);
    for (const c of list) {
      if (!c.discord_id) continue;
      sendDM(c.discord_id, `🏁 The **${t.name}** draft has started. `
        + `**${teams.find((x) => x.id === teamId)?.name}** picks ${ordinal(seatIndex + 1)} of ${teams.length}, `
        + `${check.rounds} rounds, ${seconds}s a pick.`);
    }
  }

  res.json({ ok: true, draft: data });
});

organizerRouter.post('/pause', async (req, res) => {
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const note = String(req.body?.reason ?? '').trim().slice(0, 200) || null;
  const { data, error } = await supabase.from('drafts')
    .update({ status: 'paused', pick_deadline: null, paused_reason: note })
    .eq('tournament_id', t.id).eq('status', 'live').select('*').maybeSingle();

  if (error) return res.status(500).json({ error: 'Could not pause the draft.' });
  if (!data) return res.status(409).json({ error: 'The draft is not running.' });

  invalidate(t.id);

  armTimer(t, data);
  await audit(req.user, 'draft.pause', null, { at_pick: data.current_pick, reason: note });
  res.json({ ok: true, draft: data });
});

// Resume gives the clock back in full, not the remainder. Whatever stopped the
// draft cost the team on the clock some of their time, and there is no way to
// know how much of it they were actually looking at their board for.
organizerRouter.post('/resume', async (req, res) => {
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const d = await draftRow(t.id);
  if (d.status !== 'paused') return res.status(409).json({ error: 'The draft is not paused.' });

  const { data, error } = await supabase.from('drafts')
    .update({ status: 'live', pick_deadline: deadlineFrom(d.pick_seconds), paused_reason: null })
    .eq('tournament_id', t.id).eq('status', 'paused').select('*').maybeSingle();

  if (error || !data) return res.status(500).json({ error: 'Could not resume the draft.' });

  invalidate(t.id);

  armTimer(t, data);
  await audit(req.user, 'draft.resume', null, { at_pick: data.current_pick });
  res.json({ ok: true, draft: data });
});

// ── Undo ────────────────────────────────────────────────────────────────────
// Takes back the most recent pick, whoever made it. Restores the board entries
// it deleted, which is the half that would otherwise be gone for good.
organizerRouter.post('/undo', async (req, res) => {
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const { data: last } = await supabase.from('draft_picks')
    .select(`*, player:player_signups (player_name)`)
    .eq('tournament_id', t.id)
    .order('pick_number', { ascending: false }).limit(1).maybeSingle();
  if (!last) return res.status(409).json({ error: 'No picks have been made.' });

  const d = await draftRow(t.id);

  // The roster row first: while it exists the player is still taken, so a race
  // here fails closed rather than briefly offering somebody who is on a team.
  const { error: rmErr } = await supabase.from('team_players').delete()
    .eq('tournament_id', t.id).eq('signup_id', last.signup_id).eq('via', 'draft');
  if (rmErr) {
    console.error('undo roster remove failed:', rmErr.message);
    return res.status(500).json({ error: 'Could not take them off the roster — nothing was undone.' });
  }

  const { error: delErr } = await supabase.from('draft_picks').delete().eq('id', last.id);
  if (delErr) {
    console.error('undo pick delete failed:', delErr.message);
    return res.status(500).json({ error: 'They are off the roster but the pick is still recorded — reload and try again.' });
  }

  // Give the other captains their board entries back.
  const cleared = Array.isArray(last.cleared_entries) ? last.cleared_entries : [];
  if (cleared.length) {
    const { error: reErr } = await supabase.from('draft_board_entries').upsert(
      cleared.map((e) => ({
        tournament_id: t.id, team_id: e.team_id, signup_id: last.signup_id,
        tier: e.tier, rank: e.rank, note: e.note ?? null,
      })),
      { onConflict: 'team_id,signup_id' }
    );
    if (reErr) console.warn(`undo could not restore board entries for pick ${last.pick_number}: ${reErr.message}`);
  }

  const wasComplete = d.status === 'complete';
  const { data: draft } = await supabase.from('drafts').update({
    current_pick: last.pick_number,
    status: wasComplete ? 'live' : d.status,
    completed_at: null,
    pick_deadline: (wasComplete || d.status === 'live') ? deadlineFrom(d.pick_seconds) : null,
    paused_reason: d.status === 'paused' ? d.paused_reason : null,
  }).eq('tournament_id', t.id).select('*').single();

  invalidate(t.id);

  armTimer(t, draft);
  await audit(req.user, 'draft.undo', last.team_id, {
    pick: last.pick_number, player: last.player?.player_name, restored_board_entries: cleared.length,
  });
  res.json({ ok: true, draft, undone: { pick: last.pick_number, player: last.player?.player_name } });
});

// ── Pick on somebody's behalf ───────────────────────────────────────────────
// The team IS in the body here, and that is the difference from the captain's
// route: an organizer picking for an absent captain has to be able to say whose
// pick it is. Audited with their name on it.
organizerRouter.post('/pick', async (req, res) => {
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const d = await liveDraft(t);
  if (!d) return res.status(409).json({ error: 'There is no draft.' });
  const result = await makePick(t, d, {
    teamId: req.body?.team_id,
    signupId: req.body?.signup_id,
    madeBy: `${req.user?.username} (organizer)`,
  });
  if (result.error) return res.status(result.code || 409).json({ error: result.error });

  await audit(req.user, 'draft.pick_for', req.body?.team_id, {
    pick: result.pick.pick_number, player: result.player.player_name,
  });
  res.json({ ok: true, pick: result.pick, player: result.player });
});

organizerRouter.put('/settings', async (req, res) => {
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  const seconds = Number(req.body?.pick_seconds);
  if (!Number.isInteger(seconds) || seconds < 15 || seconds > 1800) {
    return res.status(400).json({ error: 'The pick clock is a whole number of seconds, 15 to 1800.' });
  }

  const d = await draftRow(t.id);
  const patch = { pick_seconds: seconds };
  // Shortening the clock mid-draft must not leave the team on the clock with a
  // deadline longer than the new setting — and lengthening it should give them
  // the extra. Either way the current pick is re-timed from now.
  if (d.status === 'live') patch.pick_deadline = deadlineFrom(seconds);

  const { data, error } = await supabase.from('drafts').update(patch)
    .eq('tournament_id', t.id).select('*').single();
  if (error) return res.status(500).json({ error: 'Could not save that.' });

  invalidate(t.id);

  armTimer(t, data);
  await audit(req.user, 'draft.settings', null, patch);
  res.json({ ok: true, draft: data });
});

// ── Reset ───────────────────────────────────────────────────────────────────
// Throws the whole draft away: every pick, and every roster row those picks
// created. Captains stay on their rosters — they were never drafted.
//
// Guarded by the tournament's own name typed back, not a checkbox. This is the
// one button on the site that destroys work, and on draft night it sits three
// inches from Pause.
organizerRouter.post('/reset', async (req, res) => {
  const t = await currentTournament();
  if (!t) return res.status(409).json({ error: 'No tournament is running.' });

  if (String(req.body?.confirm ?? '').trim() !== t.name) {
    return res.status(400).json({
      error: `Type the tournament's name exactly — "${t.name}" — to reset the draft.`,
    });
  }

  const { count } = await supabase.from('draft_picks')
    .select('id', { count: 'exact', head: true }).eq('tournament_id', t.id);

  const { error: rmErr } = await supabase.from('team_players').delete()
    .eq('tournament_id', t.id).eq('via', 'draft');
  if (rmErr) return res.status(500).json({ error: 'Could not clear the drafted players.' });

  const { error: pkErr } = await supabase.from('draft_picks').delete().eq('tournament_id', t.id);
  if (pkErr) return res.status(500).json({ error: 'Rosters are cleared but the picks are not — try again.' });

  const { data, error } = await supabase.from('drafts').update({
    status: 'pending', current_pick: 1, pick_deadline: null, paused_reason: null,
    order_snapshot: [], rounds: 0, started_at: null, completed_at: null,
  }).eq('tournament_id', t.id).select('*').single();
  if (error) return res.status(500).json({ error: 'Could not reset the draft.' });

  invalidate(t.id);

  armTimer(t, data);
  await audit(req.user, 'draft.reset', null, { picks_removed: count || 0 });
  res.json({ ok: true, draft: data, removed: count || 0 });
});

module.exports = { publicRouter, router, organizerRouter, startProblems };
