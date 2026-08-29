-- 014_map_bans.sql — one map ban per team, per match.
--
-- Run in the Supabase SQL editor AFTER 013. Safe to re-run.
--
-- Eleven maps, two bans, nine left for a best of three.
--
-- Two columns rather than a bans table, because there are exactly two and they
-- are asymmetric — each belongs to a named side of this match, and "whose ban
-- was that" is the question people ask. A table would store the same two facts
-- with a join to answer it. If bans ever become two each, this becomes a table.

alter table matches
  add column if not exists ban_a text,
  add column if not exists ban_b text;

comment on column matches.ban_a is
  'The map team A banned. Free text by design — the real list lives in shared/maps.cjs, and a copy of it pasted into a CHECK here would drift from the one the app validates against.';

do $$ begin
  -- Both teams banning the same map wastes a ban and leaves ten maps in play
  -- when the rules say nine. Refused rather than tidied, because which of the
  -- two teams gets to keep the ban is not a decision a database should make.
  if not exists (select 1 from pg_constraint where conname = 'matches_bans_differ') then
    alter table matches add constraint matches_bans_differ
      check (ban_a is null or ban_b is null or ban_a <> ban_b);
  end if;
end $$;

-- Check — the bans and what was played on:
--   select m.key, m.ban_a, m.ban_b, g.game_number, g.map
--     from matches m left join match_games g on g.match_id = m.id
--    where m.ban_a is not null or m.ban_b is not null
--    order by m.bracket, m.round, m.idx, g.game_number;
