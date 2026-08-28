#!/usr/bin/env node
//
// scripts/mock-draft.js — run a whole draft against the real database, then put
// everything back.
//
//   npm run mock              4 teams, 3 rounds
//   npm run mock -- 6 4       6 teams, 4 rounds
//
// Lives under backend/ so that `require('dotenv')` and the Supabase client
// resolve — the dependencies are installed in backend/node_modules, and Node
// looks for them by walking up from THIS file.
//
// WHY THIS EXISTS
// Every piece of the draft is tested on its own and several are verified
// against live data, but until this script nothing had ever run a draft from
// start to finish. The failures that matter on draft night are between the
// pieces — the clock re-arming, an auto-pick firing, two captains clicking at
// once, an undo giving board entries back — and none of them show up in a unit
// test.
//
// It drives the REAL functions out of backend/draft.js, not a copy of them, so
// a rehearsal that passes is evidence about the code that will actually run.
//
// WHAT IT TOUCHES, AND HOW IT GIVES IT BACK
//   · creates teams named `__mock_n__`, and deletes them at the end
//   · seats captains from approved signups nobody has rostered
//   · sets the round count on the drafts row directly, so a mock is a few
//     rounds rather than fifty-eight, WITHOUT touching tournament settings
//   · resets the draft and restores the drafts row field for field
//
// It REFUSES to run against a draft that is live or paused, so it cannot be
// the thing that ruins the real one.
//
// Board entries are safe: a pick deletes them, and the reset at the end puts
// them back from draft_picks.cleared_entries.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { supabase, currentTournament } = require('../db');
const draft = require('../draft');
const { addToRoster, rostersByTeam, rosteredIds } = require('../teams');
const { teamOnClock, totalPicks, slotFor } = require('../../shared/draftOrder.cjs');

const TEAMS = Number(process.argv[2]) || 4;
const ROUNDS = Number(process.argv[3]) || 3;

let failures = 0;
const ok = (cond, msg) => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? '✅' : '❌'} ${msg}`);
  return cond;
};
const step = (msg) => console.log(`\n── ${msg} ${'─'.repeat(Math.max(0, 58 - msg.length))}`);

(async () => {
  if (!supabase) throw new Error('No database configured — check backend/.env');

  const t = await currentTournament({ fresh: true });
  if (!t) throw new Error('No tournament is running.');

  const before = { tournament: { ...t } };
  const { data: draftBefore } = await supabase.from('drafts').select('*')
    .eq('tournament_id', t.id).maybeSingle();
  before.draft = { ...draftBefore };

  if (draftBefore?.status === 'live' || draftBefore?.status === 'paused') {
    throw new Error(
      `The real draft is ${draftBefore.status}. This script refuses to touch it — `
      + 'reset the draft first if it is finished with.'
    );
  }

  const { count: boardsBefore } = await supabase.from('draft_board_entries')
    .select('id', { count: 'exact', head: true }).eq('tournament_id', t.id);

  console.log(`Tournament : ${t.name}`);
  console.log(`Mock draft : ${TEAMS} teams x ${ROUNDS} rounds = ${TEAMS * ROUNDS} picks`);
  console.log(`Board entries on file: ${boardsBefore} (these must survive)\n`);

  const made = [];
  try {
    // ── Set up ──────────────────────────────────────────────────────────────
    step('Setting up');

    // One captain each, so every team starts level — the draft refuses
    // otherwise, and rightly.
    const rostered = await rosteredIds(t.id);
    const { data: pool } = await supabase.from('player_signups')
      .select('id, player_name, role').eq('tournament_id', t.id).eq('status', 'approved')
      .order('player_name', { ascending: true });

    const free = (pool || []).filter((p) => !rostered.has(p.id));
    const needed = TEAMS + TEAMS * ROUNDS;
    if (free.length < needed) {
      throw new Error(`Need ${needed} unrostered approved players, found ${free.length}.`);
    }

    // Any real team already in the tournament joins the draft too, so it has to
    // be level with the mock ones or the start check refuses everything.
    const { data: realTeams } = await supabase.from('teams').select('id, name, seed')
      .eq('tournament_id', t.id);
    const realRosters = await rostersByTeam(t.id);
    const uneven = (realTeams || []).filter((x) => (realRosters.get(x.id) || []).length !== 1);
    if (uneven.length) {
      throw new Error(
        `${uneven.map((x) => x.name).join(', ')} ${uneven.length === 1 ? 'has' : 'have'} `
        + 'a roster that is not exactly 1 (its captain). Every team must start level. '
        + 'Give it exactly one captain, or delete it, then run this again.'
      );
    }

    let seed = 9000;
    for (let i = 1; i <= TEAMS; i++) {
      const { data, error } = await supabase.from('teams')
        .insert({ tournament_id: t.id, name: `__mock_${i}__`, seed: seed++ })
        .select('id, name').single();
      if (error) throw new Error(`could not create team: ${error.message}`);
      made.push(data.id);

      const captain = free.shift();
      const { error: cErr } = await supabase.from('team_captains')
        .insert({ tournament_id: t.id, team_id: data.id, signup_id: captain.id, seat: 1 });
      if (cErr) throw new Error(`could not seat a captain: ${cErr.message}`);
      await addToRoster(t.id, data.id, captain.id, 'captain');
      console.log(`  ${data.name} — captain ${captain.player_name}`);
    }

    // The round count goes straight onto the drafts row rather than by shrinking
    // roster_size. roster_size is generated from party_count * party_size +
    // sub_count, and party_count is pinned to the length of party_template by
    // `tournaments_template_matches_parties` — so shrinking it means rewriting
    // the template too. The draft reads `rounds`, so none of that is needed:
    // one fewer thing changed on the live tournament is one fewer thing to
    // restore.
    const tuned = { ...t };
    ok(true, `roster size left alone at ${t.roster_size}; the mock runs ${ROUNDS} rounds`);

    // ── Start ───────────────────────────────────────────────────────────────
    step('Starting the draft');

    const { data: allTeams } = await supabase.from('teams').select('id, name, seed')
      .eq('tournament_id', t.id).order('seed', { ascending: true, nullsFirst: false });
    const snapshot = allTeams.map((x) => x.id);
    const names = new Map(allTeams.map((x) => [x.id, x.name]));
    const expected = totalPicks(snapshot.length, ROUNDS);

    await supabase.from('drafts').update({
      status: 'live', order_snapshot: snapshot, rounds: ROUNDS,
      current_pick: 1, pick_seconds: 30,
      pick_deadline: new Date(Date.now() + 30e3).toISOString(),
      paused_reason: null, started_at: new Date().toISOString(), completed_at: null,
    }).eq('tournament_id', t.id);

    ok(true, `${snapshot.length} teams in seed order: ${allTeams.map((x) => x.name).join(' → ')}`);
    ok(expected === snapshot.length * ROUNDS, `${expected} picks to make`);

    // ── The draft ───────────────────────────────────────────────────────────
    step('Drafting');

    const pickedBy = new Map();     // signup id -> team id
    const order = [];               // pick number -> team id
    let autoPicks = 0;
    let raced = false;
    const trace = [];

    for (let guard = 0; guard < expected + 20; guard++) {
      const d = await draft.liveDraft(tuned);
      if (d.status === 'complete') break;
      if (d.status !== 'live') { ok(false, `draft went ${d.status}: ${d.paused_reason}`); break; }

      const onClock = teamOnClock(snapshot, d.current_pick);
      const slot = slotFor(snapshot.length, d.current_pick);
      trace.push(`read cp=${d.current_pick} status=${d.status} upd=${(d.updated_at || '').slice(17, 23)}`);

      // Every fifth pick, let the clock run out instead of picking. This is the
      // path nobody tests by hand because it means sitting and waiting.
      if (d.current_pick % 5 === 0) {
        await supabase.from('drafts')
          .update({ pick_deadline: new Date(Date.now() - 2000).toISOString() })
          .eq('tournament_id', t.id);
        const after = await draft.liveDraft(tuned);
        trace.push(`  auto: cp ${d.current_pick} -> ${after.current_pick}`);
        if (after.current_pick > d.current_pick) {
          autoPicks += 1;
          order[d.current_pick] = onClock;
          continue;
        }
        ok(false, `pick ${d.current_pick} expired but nothing auto-picked`);
        break;
      }

      const takenNow = await rosteredIds(t.id);
      const candidate = free.find((p) => !takenNow.has(p.id));
      if (!candidate) { ok(false, 'ran out of players'); break; }

      // Two captains clicking the same instant, once. Only one may land.
      if (!raced && d.current_pick === 3) {
        raced = true;
        const rival = free.find((p) => p.id !== candidate.id && !takenNow.has(p.id));
        const [x, y] = await Promise.all([
          draft.makePick(tuned, d, { teamId: onClock, signupId: candidate.id, madeBy: 'race-a' }),
          draft.makePick(tuned, d, { teamId: onClock, signupId: rival.id, madeBy: 'race-b' }),
        ]);
        const landed = [x, y].filter((r) => !r.error);
        const refused = [x, y].filter((r) => r.error);
        ok(landed.length === 1 && refused.length === 1,
          `two picks at the same instant → ${landed.length} landed, ${refused.length} refused ("${refused[0]?.error?.slice(0, 44)}…")`);
        order[d.current_pick] = onClock;
        if (landed[0]) pickedBy.set(landed[0].pick.signup_id, onClock);
        continue;
      }

      const r = await draft.makePick(tuned, d, {
        teamId: onClock, signupId: candidate.id, madeBy: 'mock',
      });
      trace.push(`  pick ${d.current_pick} ${r.error ? `ERR ${r.error.slice(0, 30)}` : `ok -> cp=${r.draft?.current_pick}`}`);
      // Losing a race to the clock is the SYSTEM WORKING: the expiry timer got
      // there first, exactly one pick landed, and this one was told so. Read
      // again and carry on rather than treating it as a failure — a rehearsal
      // that aborts on correct behaviour tests nothing.
      if (r.error && /already/i.test(r.error)) {
        trace.push(`  pick ${d.current_pick} lost the race to the clock — retrying`);
        continue;
      }
      if (r.error) {
        const { data: row } = await supabase.from('drafts').select('current_pick, status, pick_deadline, updated_at')
          .eq('tournament_id', t.id).maybeSingle();
        const { data: mx } = await supabase.from('draft_picks').select('pick_number, made_by, auto, created_at')
          .eq('tournament_id', t.id).order('pick_number', { ascending: false }).limit(3);
        ok(false, `pick ${d.current_pick} failed: ${r.error}`);
        console.log(`     drafts row now: current_pick=${row.current_pick} status=${row.status} deadline=${row.pick_deadline}`);
        console.log(`     last picks: ${mx.map((x) => `#${x.pick_number} by ${x.made_by}${x.auto ? ' (auto)' : ''}`).join(', ')}`);
        console.log('     trace:');
        trace.slice(-10).forEach((line) => console.log(`       ${line}`));
        break;
      }
      pickedBy.set(candidate.id, onClock);
      order[d.current_pick] = onClock;

      if (d.current_pick <= 3 || d.current_pick % 7 === 0) {
        console.log(`  R${slot.round} P${d.current_pick}  ${names.get(onClock)} → ${candidate.player_name}`);
      }
    }

    console.log(`  … ${autoPicks} picks made by the clock`);

    // ── Did it come out right? ──────────────────────────────────────────────
    step('Checking the result');

    const done = await draft.draftRow(t.id);
    ok(done.status === 'complete', `draft status is ${done.status}`);
    ok(done.current_pick === expected + 1, `clock finished on ${done.current_pick}, expected ${expected + 1}`);

    const { data: picks } = await supabase.from('draft_picks')
      .select('pick_number, team_id, signup_id, auto').eq('tournament_id', t.id)
      .order('pick_number', { ascending: true });

    ok(picks.length === expected, `${picks.length} picks recorded, expected ${expected}`);
    ok(picks.every((p, i) => p.pick_number === i + 1), 'pick numbers run 1..n with no gaps');
    ok(new Set(picks.map((p) => p.signup_id)).size === picks.length, 'nobody was drafted twice');

    // The snake. Every team gets the same number of picks — the fairness
    // property the whole order exists for.
    const perTeam = {};
    picks.forEach((p) => { perTeam[p.team_id] = (perTeam[p.team_id] || 0) + 1; });
    const counts = [...new Set(Object.values(perTeam))];
    ok(counts.length === 1 && counts[0] === ROUNDS,
      `every team made exactly ${ROUNDS} picks (${Object.values(perTeam).join(', ')})`);

    ok(picks.every((p) => p.team_id === order[p.pick_number]),
      'every pick was made by the team the snake put on the clock');

    const rosters = await rostersByTeam(t.id);
    const sizes = [...rosters.values()].map((r) => r.length);
    ok(new Set(sizes).size === 1 && sizes[0] === ROUNDS + 1,
      `every roster ended at ${ROUNDS + 1} (${sizes.join(', ')})`);

    const everyone = [...rosters.values()].flat().map((m) => m.id);
    ok(new Set(everyone).size === everyone.length, 'nobody is on two rosters');

    // ── Undo ────────────────────────────────────────────────────────────────
    step('Undoing the last pick');

    const lastPick = picks[picks.length - 1];
    const { data: lastRow } = await supabase.from('draft_picks')
      .select('id, cleared_entries').eq('tournament_id', t.id)
      .eq('pick_number', lastPick.pick_number).single();

    await supabase.from('team_players').delete()
      .eq('tournament_id', t.id).eq('signup_id', lastPick.signup_id).eq('via', 'draft');

    // The half that is easy to forget, and the reason the real undo route keeps
    // cleared_entries: deleting the pick throws away the only record of the
    // board entries it removed.
    const undone = Array.isArray(lastRow.cleared_entries) ? lastRow.cleared_entries : [];
    if (undone.length) {
      await supabase.from('draft_board_entries').upsert(
        undone.map((e) => ({
          tournament_id: t.id, team_id: e.team_id, signup_id: lastPick.signup_id,
          tier: e.tier, rank: e.rank, note: e.note ?? null,
        })), { onConflict: 'team_id,signup_id' }
      );
    }
    await supabase.from('draft_picks').delete().eq('id', lastRow.id);
    await supabase.from('drafts').update({
      current_pick: lastPick.pick_number, status: 'live', completed_at: null,
      pick_deadline: new Date(Date.now() + 30e3).toISOString(),
    }).eq('tournament_id', t.id);

    const backOn = await draft.draftRow(t.id);
    ok(backOn.current_pick === lastPick.pick_number && backOn.status === 'live',
      `undo put the clock back on pick ${backOn.current_pick} and the draft live again`);

    const { data: freedAgain } = await supabase.from('team_players').select('id')
      .eq('tournament_id', t.id).eq('signup_id', lastPick.signup_id).maybeSingle();
    ok(!freedAgain, 'the undone player is off the roster and back in the pool');

    // ── Crash recovery, for real ────────────────────────────────────────────
    step('Surviving a crash mid-pick');

    const onClockNow = teamOnClock(snapshot, backOn.current_pick);

    // Genuinely unrostered, read from the database rather than from what this
    // script remembers picking — the clock made three of these picks and this
    // script never saw them. Choosing a player who is already on a team makes
    // the insert below fail on draft_picks_player_once, and then the checks
    // afterwards pass for entirely the wrong reason.
    const stillFree = await rosteredIds(t.id);
    const spare = free.find((p) => !stillFree.has(p.id));
    if (!spare) throw new Error('no unrostered player left for the crash test');

    const crashInsert = await supabase.from('draft_picks').insert({
      tournament_id: t.id, team_id: onClockNow, signup_id: spare.id,
      pick_number: backOn.current_pick, round: slotFor(snapshot.length, backOn.current_pick).round,
      auto: false, made_by: 'mock-crash',
    });
    if (crashInsert.error) throw new Error(`crash setup failed: ${crashInsert.error.message}`);

    // Backdate it. Reconciliation deliberately leaves picks written in the last
    // ten seconds alone — those are in flight, not stuck — so a crash written
    // and read back in the same millisecond is correctly ignored. A real
    // crashed pick is however old the outage was by the time anyone looks.
    await supabase.from('draft_picks')
      .update({ created_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('tournament_id', t.id).eq('pick_number', backOn.current_pick);

    console.log(`  wrote pick ${backOn.current_pick} for ${spare.player_name} a minute ago and "died" before advancing`);

    ok(!stillFree.has(spare.id), `${spare.player_name} was not on any roster before the crash`);

    const repaired = await draft.liveDraft(tuned);
    ok(repaired.current_pick === backOn.current_pick + 1,
      `next read repaired the clock to ${repaired.current_pick}`);
    const { data: rescued } = await supabase.from('team_players').select('id')
      .eq('tournament_id', t.id).eq('signup_id', spare.id).maybeSingle();
    ok(!!rescued, 'and put the half-picked player on their roster');
  } finally {
    // ── Put it all back ─────────────────────────────────────────────────────
    step('Cleaning up');

    // Reset the draft the way the organizer button does, so the board entries
    // every pick deleted are restored from cleared_entries.
    const { data: allPicks } = await supabase.from('draft_picks')
      .select('signup_id, cleared_entries').eq('tournament_id', t.id);
    await supabase.from('team_players').delete().eq('tournament_id', t.id).eq('via', 'draft');
    await supabase.from('draft_picks').delete().eq('tournament_id', t.id);

    const restore = (allPicks || []).flatMap((p) => (Array.isArray(p.cleared_entries) ? p.cleared_entries : [])
      .map((e) => ({
        tournament_id: t.id, team_id: e.team_id, signup_id: p.signup_id,
        tier: e.tier, rank: e.rank, note: e.note ?? null,
      })));
    if (restore.length) {
      await supabase.from('draft_board_entries').upsert(restore, { onConflict: 'team_id,signup_id' });
    }

    for (const id of made) {
      await supabase.from('draft_board_entries').delete().eq('team_id', id);
      await supabase.from('team_players').delete().eq('team_id', id);
      await supabase.from('team_captains').delete().eq('team_id', id);
      await supabase.from('teams').delete().eq('id', id);
    }

    await supabase.from('drafts').update({
      status: before.draft.status, order_snapshot: before.draft.order_snapshot,
      rounds: before.draft.rounds, current_pick: before.draft.current_pick,
      pick_seconds: before.draft.pick_seconds, pick_deadline: before.draft.pick_deadline,
      paused_reason: before.draft.paused_reason,
      started_at: before.draft.started_at, completed_at: before.draft.completed_at,
    }).eq('tournament_id', t.id);

    const { data: tAfter } = await supabase.from('tournaments').select('*').eq('id', t.id).single();
    const { data: dAfter } = await supabase.from('drafts').select('*').eq('tournament_id', t.id).maybeSingle();
    const { data: teamsAfter } = await supabase.from('teams').select('name').eq('tournament_id', t.id);
    const { count: picksAfter } = await supabase.from('draft_picks')
      .select('id', { count: 'exact', head: true }).eq('tournament_id', t.id);
    const { count: boardsAfter } = await supabase.from('draft_board_entries')
      .select('id', { count: 'exact', head: true }).eq('tournament_id', t.id);

    ok(tAfter.roster_size === before.tournament.roster_size, `roster size untouched at ${tAfter.roster_size}`);
    ok(dAfter.status === before.draft.status && dAfter.current_pick === before.draft.current_pick,
      `draft back to ${dAfter.status} on pick ${dAfter.current_pick}`);
    ok(picksAfter === 0, 'no mock picks left');
    ok(!(teamsAfter || []).some((x) => x.name.startsWith('__mock_')), 'no mock teams left');
    ok(boardsAfter === boardsBefore, `board entries: ${boardsBefore} before, ${boardsAfter} after`);

    console.log(
      failures === 0
        ? '\n✅ MOCK DRAFT PASSED — and the database is exactly as it was.'
        : `\n❌ ${failures} check(s) failed. Read the log above before running a real draft.`
    );
    process.exit(failures === 0 ? 0 : 1);
  }
})().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
