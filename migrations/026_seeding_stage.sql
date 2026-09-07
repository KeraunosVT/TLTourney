-- 026_seeding_stage.sql — a round-robin before the bracket, and a final that
-- ends when it says it will.
--
-- Run in the Supabase SQL editor AFTER 025. Safe to re-run.
--
-- Three rule changes, one migration, because they are one decision about how a
-- season is shaped:
--
--   1. A SEEDING STAGE. Every team plays every other team once, and the table
--      that comes out of it seeds the double-elimination bracket. With four
--      teams that is six matches over three rounds; the generator is written
--      for n, so six teams would be fifteen over five.
--
--   2. THE GRAND FINAL IS BEST OF FIVE. Everything before it stays best of
--      three.
--
--   3. NO BRACKET RESET. The losers-bracket team no longer has to win twice.
--
-- ── What the seeding stage replaces ─────────────────────────────────────────
-- Bracket seeds used to come from teams.seed, which is DRAFT order — the order
-- captains picked in, set before anybody had played a game. That made the
-- reward for a good draft position a good bracket position, compounding an
-- advantage the snake draft exists to spread out. Now teams.seed decides who
-- drafts first and the round-robin decides who plays whom, which are different
-- questions and were never the same one.
--
-- ── One table, not two ──────────────────────────────────────────────────────
-- Seeding matches live in `matches` alongside the bracket, under bracket='RR'.
-- A separate table would have needed its own copy of scheduling, map bans,
-- per-game results, scoreboards and predictions — every one of which already
-- keys off a match id. The CHECK below is the whole schema change.

do $$ begin
  -- Recreated rather than added to: a CHECK cannot be extended in place.
  if exists (select 1 from pg_constraint where conname = 'matches_bracket_valid') then
    alter table matches drop constraint matches_bracket_valid;
  end if;

  alter table matches add constraint matches_bracket_valid
    check (bracket in ('RR', 'W', 'L', 'GF'));
end $$;

-- Seeding matches are ordinary matches in every other respect — they are
-- scheduled, they have map bans, they produce scoreboards. The one thing they
-- do NOT have is a slot to advance into: nobody's win moves anybody, because
-- what they feed is the standings, which are computed rather than stored.
--
-- Nothing is stored for the standings on purpose. A table derived from results
-- and also written down is two answers to one question, and the written one is
-- the one that goes stale the first time a result is corrected.

-- ── The reset match ─────────────────────────────────────────────────────────
-- Not deleted. A bracket already drawn keeps its GF2-0 and keeps working —
-- shared/bracket.cjs only triggers a reset when a reset match is actually
-- present, so old and new brackets both behave correctly from one code path.
-- New brackets simply stop generating one.
--
-- If you want the CURRENT bracket to lose its reset without redrawing, void it
-- by hand — but only before a grand final is played:
--
--   update matches set kind = 'void', status = 'complete'
--    where key = 'GF2-0' and status <> 'complete'
--      and tournament_id = (select id from tournaments
--                            where status <> 'complete'
--                            order by created_at limit 1);

-- Check — the shape of the season, once it is drawn:
--   select bracket, count(*) as matches, min(best_of) as bo_min, max(best_of) as bo_max
--     from matches m
--     join tournaments o on o.id = m.tournament_id
--    where o.status <> 'complete'
--    group by bracket order by bracket;
--
-- For four teams that should read RR 6 (bo 3), W 3, L 2, GF 1 (bo 5).
