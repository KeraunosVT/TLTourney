-- 023_streams.sql — where the season is being broadcast.
--
-- Run in the Supabase SQL editor AFTER 022. Safe to re-run.
--
-- A list of {label, url}, on the tournament. Not a table, and that is the
-- opposite call from 022 — worth saying why, because the two look alike:
--
--   022 needed a table because a party seating REFERENCES a roster row, and the
--   whole point of it was a foreign key that empties a seat when a player is
--   cut. A stream link references nothing. There is no integrity to enforce,
--   no second place the data lives, and nothing to cascade — so a table would
--   buy joins and a migration and give back nothing.
--
-- Same shape as party_template and sub_slots, which are jsonb on this table for
-- the same reason: settings that are read whole, written whole, and point at
-- nothing.
--
-- A LIST rather than one twitch_url column: a season has a main broadcast and
-- then co-streams — a second caster, a team's own POV, another language — and
-- one column means the day somebody adds a co-stream is the day somebody writes
-- a migration.
--
-- ── What is NOT enforced here ───────────────────────────────────────────────
-- The CHECK only pins the shape to an array. Whether an entry is a usable link
-- is decided by shared/streams.cjs, which the Setup form and the API both call,
-- because the rule that matters is "https only" — an organizer's URL is
-- rendered as a link to the public, and `javascript:` in an href runs on click.
-- Expressing that as a SQL CHECK would mean a regex nobody can read, in a third
-- place, disagreeing with the other two the first time it changed.

alter table tournaments
  add column if not exists streams jsonb not null default '[]'::jsonb;

do $$ begin
  if not exists (select 1 where exists (
    select 1 from pg_constraint where conname = 'tournaments_streams_is_array')) then
    alter table tournaments add constraint tournaments_streams_is_array
      check (jsonb_typeof(streams) = 'array');
  end if;
end $$;

-- Check — what the season is pointing at:
--   select name, jsonb_array_length(streams) as streams, streams
--     from tournaments order by created_at;
--
-- And the one that matters, which should always be zero. Anything but https
-- reaching this column means something wrote it without going through
-- normalizeStreams:
--   select name, s->>'url' as bad
--     from tournaments, jsonb_array_elements(streams) s
--    where s->>'url' not like 'https://%';
