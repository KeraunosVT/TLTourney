-- 029_seeding_best_of_one.sql — a seeding fixture is a single game.
--
-- Run in the Supabase SQL editor AFTER 028. Safe to re-run.
--
-- 026 drew the seeding stage but said nothing about series length, so every
-- fixture took matches.best_of's column default of 3 (migration 013). Six
-- fixtures at best-of-three is EIGHTEEN games to decide a seeding order —
-- more play than the double-elimination bracket those seeds feed into.
--
-- One game each: six games for the stage, and the long series kept for where
-- they decide something. The grand final stays at five (026); everything in
-- between stays at the default three.
--
-- The generator sets this on new draws (SEEDING_BEST_OF in shared/bracket.cjs).
-- This is for a stage that was ALREADY drawn — redrawing would also fix it, but
-- a redraw deletes and recreates every fixture and takes any schedule or map
-- bans already set on them with it.
--
-- ── Only where nothing has been played ──────────────────────────────────────
-- Shortening a series that has games recorded against it is how a 2-0 becomes
-- a decided match retroactively, or a played game ends up hanging off a series
-- that no longer has room for it. If a seeding match has already been played,
-- it keeps the length it was played under and this leaves it alone — check the
-- query at the bottom for any it skipped.
update matches m
   set best_of = 1
  from tournaments o
 where o.id = m.tournament_id
   and o.status <> 'complete'
   and m.bracket = 'RR'
   and m.best_of <> 1
   and m.status <> 'complete'
   and not exists (select 1 from match_games g where g.match_id = m.id);

-- Check — every seeding fixture and its length. All should read 1:
--   select m.key, m.best_of, m.status,
--          (select count(*) from match_games g where g.match_id = m.id) as games
--     from matches m
--     join tournaments o on o.id = m.tournament_id
--    where o.status <> 'complete' and m.bracket = 'RR'
--    order by m.round, m.idx;
--
-- And the whole season's shape, which is the one worth reading once:
--   select bracket, count(*) as matches, min(best_of) as bo_min, max(best_of) as bo_max
--     from matches m
--     join tournaments o on o.id = m.tournament_id
--    where o.status <> 'complete'
--    group by bracket order by bracket;
--
-- For four teams that should read RR 6 (bo 1), W 3 (bo 3), L 2 (bo 3), GF 1 (bo 5).
