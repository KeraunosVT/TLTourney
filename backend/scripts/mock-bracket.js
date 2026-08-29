#!/usr/bin/env node
//
// backend/scripts/mock-bracket.js — draw a bracket, play it to a champion, then
// put everything back.
//
//   npm run mock-bracket           4 teams
//   npm run mock-bracket -- 6      6 teams, so byes get exercised
//
// WHY THIS EXISTS
// shared/bracket.cjs has fifty thousand simulated tournaments behind it, and
// none of them touched a database. Everything BETWEEN the engine and the rows
// — generate, settle's walkover cascade, recompute un-advancing a team that is
// already two rounds along, bans, per-game scoreboards — had never run at all.
// That was exactly the state the draft was in before npm run mock, which found
// four real bugs.
//
// It drives the REAL express handlers, not copies of them, by calling the
// routers with a fake request. So routing, validation and the error paths are
// all in the test; only the session is faked.
//
// It REFUSES to run if any match already exists, so it cannot be the thing that
// destroys a real bracket.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { supabase, currentTournament } = require('../db');
const bracket = require('../bracket');
const results = require('../results');
const { addToRoster, rosteredIds } = require('../teams');
const { MAPS } = require('../../shared/maps.cjs');

const TEAMS = Number(process.argv[2]) || 4;

let failures = 0;
// Set only when the run reaches the end of its checks. Without it, an exception
// inside the try block runs the cleanup in `finally`, finds no FAILED checks,
// and prints PASSED — a rehearsal that reports success after crashing is worse
// than no rehearsal, and this script did exactly that on its second run.
let completed = false;
let crash = null;
const ok = (cond, msg) => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? '✅' : '❌'} ${msg}`);
  return cond;
};
const step = (m) => console.log(`\n── ${m} ${'─'.repeat(Math.max(0, 56 - m.length))}`);

/**
 * Call an express router directly.
 *
 * The routers are plain (req, res, next) functions, so a minimal request is
 * enough to reach the real handler — which is the point. A rehearsal that
 * re-implemented the routes would only prove the re-implementation works.
 */
function call(router, method, url, { body = {}, query = {} } = {}) {
  return new Promise((resolve) => {
    const req = {
      method, url, originalUrl: url, baseUrl: '', path: url.split('?')[0],
      body, query, params: {}, headers: {},
      user: { id: 'mock-organizer', username: 'mock', isOrganizer: true },
    };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; },
      send(b) { resolve({ status: this.statusCode, body: b }); return this; },
    };
    router(req, res, (err) => resolve({ status: 500, body: { error: err?.message || 'no route' } }));
  });
}

const okCall = (r, what) => {
  if (r.status >= 400) throw new Error(`${what}: ${r.body?.error || r.status}`);
  return r.body;
};

(async () => {
  if (!supabase) throw new Error('No database configured — check backend/.env');
  const t = await currentTournament({ fresh: true });
  if (!t) throw new Error('No tournament is running.');

  const { count: existing, error: mErr } = await supabase.from('matches')
    .select('id', { count: 'exact', head: true }).eq('tournament_id', t.id);
  if (mErr) {
    throw new Error(/schema cache|does not exist|relation/i.test(mErr.message)
      ? 'The bracket tables are missing — run migrations 011 to 014 first.'
      : mErr.message);
  }
  if (existing > 0) {
    throw new Error(
      `${existing} matches already exist. This refuses to touch a real bracket — `
      + 'clear it from the Bracket page first if it is finished with.'
    );
  }

  const { data: realTeams } = await supabase.from('teams').select('id, name, seed')
    .eq('tournament_id', t.id);
  const { count: statsBefore } = await supabase.from('player_match_stats')
    .select('id', { count: 'exact', head: true }).eq('tournament_id', t.id);

  // Generate draws EVERY seeded team in the tournament, which is correct — it
  // just means the bracket is bigger than the teams this script made, and the
  // real ones get played too. Their matches are removed with the rest.
  const seededReal = (realTeams || []).filter((x) => x.seed).length;
  const inBracket = TEAMS + seededReal;

  console.log(`Tournament : ${t.name}`);
  console.log(`Mock       : ${TEAMS} teams, best of 3`);
  console.log(`In bracket : ${inBracket} — ${seededReal} real seeded team(s) are drawn too`);
  console.log(`Untouched  : ${statsBefore} stat rows\n`);

  const made = [];
  try {
    // ── Teams ───────────────────────────────────────────────────────────────
    step('Setting up');
    const taken = await rosteredIds(t.id);
    const { data: pool } = await supabase.from('player_signups')
      .select('id, player_name').eq('tournament_id', t.id).eq('status', 'approved')
      .order('player_name', { ascending: true });
    const free = (pool || []).filter((p) => !taken.has(p.id));
    if (free.length < TEAMS * 3) throw new Error(`need ${TEAMS * 3} unrostered approved players, found ${free.length}`);

    let seed = 9000;
    for (let i = 1; i <= TEAMS; i++) {
      const { data, error } = await supabase.from('teams')
        .insert({ tournament_id: t.id, name: `__mockb_${i}__`, seed: seed++ })
        .select('id, name').single();
      if (error) throw new Error(`team create: ${error.message}`);
      made.push(data.id);

      // Three players each, so a scoreboard has names to match against.
      for (let n = 0; n < 3; n++) {
        const who = free.shift();
        if (n === 0) {
          await supabase.from('team_captains')
            .insert({ tournament_id: t.id, team_id: data.id, signup_id: who.id, seat: 1 });
          await addToRoster(t.id, data.id, who.id, 'captain');
        } else {
          await addToRoster(t.id, data.id, who.id, 'manual');
        }
      }
    }
    ok(true, `${TEAMS} teams created, 3 players each`);

    // ── Generate ────────────────────────────────────────────────────────────
    step('Drawing the bracket');
    const drawn = okCall(await call(bracket.organizerRouter, 'POST', '/generate'), 'generate');
    const real = drawn.matches.filter((m) => m.kind === 'match' && !m.is_reset);
    ok(real.length === 2 * inBracket - 2, `${real.length} matches to play, expected ${2 * inBracket - 2}`);
    ok(drawn.matches.some((m) => m.bracket === 'GF' && m.is_reset), 'the reset match exists up front');

    const ready = drawn.matches.filter((m) => m.status === 'ready');
    const byes = drawn.matches.filter((m) => m.kind === 'walkover').length;
    ok(ready.length > 0, `${ready.length} playable immediately, ${byes} bye(s) resolved`);

    // A regenerate over a live bracket must be refused once anything is played.
    const again = await call(bracket.organizerRouter, 'POST', '/generate');
    ok(again.status < 400, 'regenerating an unplayed bracket is allowed');

    // ── Bans ────────────────────────────────────────────────────────────────
    step('Map bans');
    const first = (okCall(await call(bracket.organizerRouter, 'GET', '/'), 'read')).matches
      .find((m) => m.status === 'ready');

    const banned = okCall(await call(bracket.organizerRouter, 'PUT', '/bans',
      { body: { key: first.key, ban_a: MAPS[0], ban_b: MAPS[1] } }), 'bans');
    const afterBan = banned.matches.find((m) => m.key === first.key);
    ok(afterBan.maps_available.length === MAPS.length - 2,
      `${afterBan.maps_available.length} maps left after two bans`);

    const sameBan = await call(bracket.organizerRouter, 'PUT', '/bans',
      { body: { key: first.key, ban_a: MAPS[0], ban_b: MAPS[0] } });
    ok(sameBan.status === 409, `both teams banning one map is refused ("${sameBan.body?.error?.slice(0, 44)}…")`);

    const bannedMap = await call(bracket.organizerRouter, 'POST', '/game',
      { body: { key: first.key, game_number: 1, map: MAPS[0] } });
    ok(bannedMap.status === 409, 'a game cannot be played on a banned map');

    const fakeMap = await call(bracket.organizerRouter, 'POST', '/game',
      { body: { key: first.key, game_number: 1, map: 'Somewhere Else' } });
    ok(fakeMap.status === 400, 'nor on a map that is not in the pool');

    // ── Play it out ─────────────────────────────────────────────────────────
    step('Playing the bracket');
    const losses = {};
    let champion = null;
    let played = 0;

    for (let guard = 0; guard < 200; guard++) {
      const state = okCall(await call(bracket.organizerRouter, 'GET', '/'), 'read');
      if (state.champion) { champion = state.champion.id; break; }

      const m = state.matches.find((x) => x.status === 'ready');
      if (!m) { ok(false, 'nothing is playable and nobody has won'); break; }

      // Seed order decides, so results are reproducible: the team with the
      // lower seed wins, except in the losers bracket, to force a reset.
      const teamA = state.teams.find((x) => x.id === m.team_a_id);
      const teamB = state.teams.find((x) => x.id === m.team_b_id);
      const winner = m.bracket === 'L'
        ? (teamA.seed > teamB.seed ? teamA : teamB)
        : (teamA.seed < teamB.seed ? teamA : teamB);
      const loser = winner.id === teamA.id ? teamB : teamA;

      const avail = m.maps_available || MAPS;
      for (let g = 1; g <= 2; g++) {
        const r = await call(bracket.organizerRouter, 'POST', '/game', {
          body: { key: m.key, game_number: g, map: avail[g % avail.length], winner_team_id: winner.id },
        });
        okCall(r, `game ${g} of ${m.key}`);
      }

      losses[loser.id] = (losses[loser.id] || 0) + 1;
      played += 1;
    }

    ok(!!champion, champion ? `champion decided after ${played} matches` : 'no champion');

    // THE property. Everything else can be wrong in ways that still produce a
    // champion; this cannot.
    const drawn2 = okCall(await call(bracket.organizerRouter, 'GET', '/'), 'read');
    const allTeams = drawn2.teams.filter((x) => x.seed).map((x) => x.id);
    const wrong = allTeams.filter((id) => id !== champion && (losses[id] || 0) !== 2);
    ok(wrong.length === 0,
      `every non-champion lost exactly twice (${allTeams.map((id) => losses[id] || 0).join(', ')})`);

    const finished = okCall(await call(bracket.organizerRouter, 'GET', '/'), 'read');
    ok(finished.counts.complete === finished.counts.total,
      `${finished.counts.complete} of ${finished.counts.total} matches complete `
      + '(the reset only counts if it was forced)');
    ok(!finished.canGenerate, 'and the bracket refuses to be redrawn over results');

    // ── The hard one ────────────────────────────────────────────────────────
    step('Correcting a game in a finished series');
    // A decided match, whose winner went on to play again. Changing game 1 has
    // to un-advance a team that is already further along.
    // kind === 'match', not just complete: a bye is complete too and has only
    // one team, so flipping a "game" in it is meaningless — and the route
    // rightly refuses, which is what crashed this script the first time.
    const target = finished.matches.find(
      (m) => m.bracket === 'W' && m.kind === 'match' && m.status === 'complete' && m.team_a_id && m.team_b_id
    );
    if (!target) throw new Error('no played winners-bracket match to correct');
    const oldWinner = target.winner_team_id;
    const otherSide = target.team_a_id === oldWinner ? target.team_b_id : target.team_a_id;
    const downstream = finished.matches.filter(
      (m) => [m.slot_a?.of, m.slot_b?.of].includes(target.key)
    );
    ok(downstream.length > 0, `${target.key} feeds ${downstream.map((d) => d.key).join(' and ')}`);

    const flipped = okCall(await call(bracket.organizerRouter, 'POST', '/game', {
      body: { key: target.key, game_number: 1, winner_team_id: otherSide },
    }), 'flip game 1');

    const now = flipped.matches.find((m) => m.key === target.key);
    ok(now.series.winsA === 1 && now.series.winsB === 1, `${target.key} is now 1-1 and undecided`);
    ok(now.status !== 'complete', 'so the match is no longer complete');

    const fedNow = flipped.matches.filter((m) => downstream.some((d) => d.key === m.key));
    ok(fedNow.every((m) => m.team_a_id !== oldWinner && m.team_b_id !== oldWinner),
      'and the old winner has been taken out of every match it fed');
    ok(!flipped.champion, 'the tournament no longer has a champion');

    // Put it back and check it re-advances.
    okCall(await call(bracket.organizerRouter, 'POST', '/game', {
      body: { key: target.key, game_number: 1, winner_team_id: oldWinner },
    }), 'restore game 1');
    const restored = okCall(await call(bracket.organizerRouter, 'GET', '/'), 'read');
    ok(restored.matches.find((m) => m.key === target.key).winner_team_id === oldWinner,
      'restoring the game re-decides the match');

    // ── Scheduling ──────────────────────────────────────────────────────────
    step('Scheduling a match');
    const toSchedule = restored.matches.find((m) => m.kind === 'match');
    const when = new Date(Date.now() + 3 * 86400e3);
    when.setSeconds(0, 0);

    const scheduled = okCall(await call(bracket.organizerRouter, 'PUT', '/schedule',
      { body: { key: toSchedule.key, scheduled_at: when.toISOString() } }), 'schedule');
    const withTime = scheduled.matches.find((m) => m.key === toSchedule.key);
    ok(new Date(withTime.scheduled_at).getTime() === when.getTime(),
      `${toSchedule.key} scheduled, and the instant survives the round trip`);

    const badTime = await call(bracket.organizerRouter, 'PUT', '/schedule',
      { body: { key: toSchedule.key, scheduled_at: 'next tuesday' } });
    ok(badTime.status === 400, 'an unparseable time is refused rather than stored as null');

    const cleared = okCall(await call(bracket.organizerRouter, 'PUT', '/schedule',
      { body: { key: toSchedule.key, scheduled_at: null } }), 'clear schedule');
    ok(!cleared.matches.find((m) => m.key === toSchedule.key).scheduled_at, 'and it clears');

    okCall(await call(bracket.organizerRouter, 'PUT', '/schedule',
      { body: { key: toSchedule.key, scheduled_at: when.toISOString() } }), 're-schedule');

    // ── A scoreboard ────────────────────────────────────────────────────────
    step('Committing a scoreboard');
    const scored = restored.matches.find((m) => m.status === 'complete' && m.games?.length);
    const gameNo = scored.games[0].game_number;
    const rosters = await supabase.from('team_players')
      .select('signup_id, team_id, player_signups (player_name)')
      .in('team_id', [scored.team_a_id, scored.team_b_id]);

    const rows = (rosters.data || []).map((r, i) => ({
      signup_id: r.signup_id,
      team_id: r.team_id,
      rank: i + 1,
      weapon_1: 'Staff', weapon_2: 'Wand',
      player_name: r.player_signups.player_name,
      team_color: r.team_id === scored.team_a_id ? 'Yellow' : 'Red',
      kills: 3, assists: 4, damage_dealt: 1_000_000 + i, damage_taken: 500, healing: 250,
    }));

    const committed = okCall(await call(results.organizerRouter, 'POST', `/commit/${scored.key}`,
      { body: { rows, game_number: gameNo } }), 'commit');
    ok(committed.total === rows.length, `${committed.total} rows saved, ${committed.matched} matched`);

    const dupe = await call(results.organizerRouter, 'POST', `/commit/${scored.key}`,
      { body: { rows: [...rows, rows[0]], game_number: gameNo } });
    ok(dupe.status === 409, 'the same player twice on one scoreboard is refused');

    // Committing again must REPLACE, not double. This is what the per-game
    // unique index is protecting and it is invisible when it fails.
    okCall(await call(results.organizerRouter, 'POST', `/commit/${scored.key}`,
      { body: { rows, game_number: gameNo } }), 're-commit');
    const { count: after } = await supabase.from('player_match_stats')
      .select('id', { count: 'exact', head: true }).eq('tournament_id', t.id);
    ok(after === statsBefore + rows.length, `re-committing replaces rather than doubles (${after} rows)`);

    const board = okCall(await call(results.router, 'GET', '/leaderboard', { query: {} }), 'leaderboard');
    const entry = board.entries.find((e) => e.signup_id === rows[0].signup_id);
    ok(!!entry, 'the player appears on the leaderboard');
    ok(entry?.games === 1 && entry?.matches === 1, `one game, one match (got ${entry?.games}/${entry?.matches})`);
    ok(entry?.damage_dealt === rows[0].damage_dealt, 'with the damage they actually did');

    // ── The broadcast scene ─────────────────────────────────────────────────
    step('The stream endpoint');
    const cast = okCall(await call(bracket.streamRouter, 'GET', '/', { query: {} }), 'stream bracket');
    ok(cast.exists && cast.matches.length > 0, `${cast.matches.length} matches on the public route`);
    ok(!!cast.focus, `it picked a match to feature (${cast.focus?.key})`);
    // The featured match is whichever one a viewer would expect — something
    // live, else the most recently decided — which is NOT necessarily the one
    // this script happened to score. Ask for that one by name to check the
    // scoreboard travels with it.
    const cast2 = okCall(await call(bracket.streamRouter, 'GET', '/', { query: { match: scored.key } }),
      'stream bracket ?match=scored');
    ok((cast2.focus?.scoreboard || []).length === rows.length,
      `the scored match carries its scoreboard (${cast2.focus?.scoreboard?.length} rows)`);
    ok(cast2.focus?.scoreboardGame === gameNo, `and says which game it is (${cast2.focus?.scoreboardGame})`);

    // Nothing identifying may reach an unauthenticated route.
    const leaked = new Set();
    const bannedKeys = ['signup_id', 'discord_id', 'discord_username', 'notes'];
    JSON.stringify(cast, (k, v) => { if (bannedKeys.includes(k)) leaked.add(k); return v; });
    ok(leaked.size === 0, leaked.size ? `LEAKED ${[...leaked].join(', ')}` : 'and no identifying fields');

    const named = okCall(await call(bracket.streamRouter, 'GET', '/', { query: { match: toSchedule.key } }),
      'stream bracket ?match=');
    ok(named.focus?.key === toSchedule.key, 'a producer can name the featured match');

    completed = true;
  } catch (err) {
    // Caught rather than propagated, so the cleanup below still runs — leaving
    // a half-played mock bracket on the live database would be the worst
    // possible outcome of a script meant to protect it.
    crash = err;
  } finally {
    // ── Put it back ─────────────────────────────────────────────────────────
    step('Cleaning up');
    const { data: mine } = await supabase.from('matches').select('id').eq('tournament_id', t.id);
    const ids = (mine || []).map((m) => m.id);
    if (ids.length) {
      await supabase.from('player_match_stats').delete().in('match_id', ids);
      await supabase.from('match_games').delete().in('match_id', ids);
      await supabase.from('matches').delete().in('id', ids);
    }
    for (const id of made) {
      await supabase.from('draft_board_entries').delete().eq('team_id', id);
      await supabase.from('team_players').delete().eq('team_id', id);
      await supabase.from('team_captains').delete().eq('team_id', id);
      await supabase.from('teams').delete().eq('id', id);
    }

    const { count: matchesAfter } = await supabase.from('matches')
      .select('id', { count: 'exact', head: true }).eq('tournament_id', t.id);
    const { count: statsAfter } = await supabase.from('player_match_stats')
      .select('id', { count: 'exact', head: true }).eq('tournament_id', t.id);
    const { data: teamsAfter } = await supabase.from('teams').select('name').eq('tournament_id', t.id);

    ok(matchesAfter === 0, 'no matches left');
    ok(statsAfter === statsBefore, `stat rows back to ${statsBefore}`);
    ok(!(teamsAfter || []).some((x) => x.name.startsWith('__mockb_')), 'no mock teams left');
    ok((teamsAfter || []).length === (realTeams || []).length, `${(teamsAfter || []).length} real teams untouched`);

    if (crash) {
      console.log(`\n❌ CRASHED: ${crash.message}`);
      console.log(crash.stack?.split('\n').slice(1, 4).join('\n') || '');
    }
    const passed = failures === 0 && completed && !crash;
    console.log(passed
      ? '\n✅ MOCK BRACKET PASSED — and the database is exactly as it was.'
      : `\n❌ ${failures} check(s) failed${completed ? '' : ', and the run did not finish'}. `
        + 'Read the log above before running a real bracket.');
    process.exit(passed ? 0 : 1);
  }
})().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
