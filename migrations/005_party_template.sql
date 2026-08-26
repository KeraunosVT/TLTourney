-- 005_party_template.sql — the real party template, in the right shape.
--
-- Run in the Supabase SQL editor AFTER 004. Safe to re-run.
--
-- ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
-- An earlier draft of 004 added `party_template text[]` holding one POSITION
-- name per party:
--
--   {"Tank Party","Mainball Melee","Mainball Melee", ... ,"Killsquad"}
--
-- That was written before the tournament's actual template was to hand, and it
-- is wrong in two ways at once. The parties aren't named after positions —
-- they're Objective / Main, Flex and 3 DPS — and, more importantly, a party is
-- not one label. It is six SLOTS, each naming which roles may fill it, and two
-- of the five slot types accept more than one role.
--
-- Flattening that away is exactly what turns "we need between 60 and 108 tanks"
-- into a single number that is wrong in both directions.
--
-- ── WHY DROP RATHER THAN ALTER ──────────────────────────────────────────────
-- The column already exists as text[]. `add column if not exists` would do
-- NOTHING — silently, with no error — leaving the app reading jsonb from a
-- text[] column. There is no data worth keeping in it (it was a placeholder
-- that never described a real tournament), so it goes and comes back correctly
-- typed. Dropping the column takes its CHECK constraint with it.

alter table tournaments drop column if exists party_template;

alter table tournaments
  add column party_template jsonb not null
  default '[
    {"name":"Objective / Main","slots":["Tank","Tank","Tank / DPS","Tank / DPS","Healer","Healer"]},
    {"name":"Flex (2-2-2)","slots":["Tank","Tank","Tank / DPS","Tank / DPS","Healer","Healer"]},
    {"name":"Flex","slots":["Tank","Any Role","DPS","DPS","Healer","Healer"]},
    {"name":"Flex","slots":["Tank","Any Role","DPS","DPS","Healer","Healer"]},
    {"name":"Flex","slots":["Tank","Any Role","DPS","DPS","Healer","Healer"]},
    {"name":"Flex","slots":["Tank","Any Role","DPS","DPS","Healer","Healer"]},
    {"name":"3 DPS","slots":["Tank","DPS","DPS","DPS","Healer","Healer"]},
    {"name":"3 DPS","slots":["Tank","DPS","DPS","DPS","Healer","Healer"]}
  ]'::jsonb;

-- The template must describe exactly as many parties as the tournament has, or
-- the two disagree and every roster count downstream is wrong.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tournaments_template_matches_parties') then
    alter table tournaments
      add constraint tournaments_template_matches_parties
      check (jsonb_typeof(party_template) = 'array'
             and jsonb_array_length(party_template) = party_count);
  end if;
end $$;

-- ── Check ───────────────────────────────────────────────────────────────────
-- Should read 8 parties, 48 starting slots, 60 roster.
--
--   select name,
--          party_count, party_size, sub_count, roster_size,
--          jsonb_array_length(party_template) as parties,
--          (select sum(jsonb_array_length(p->'slots'))
--             from jsonb_array_elements(party_template) p) as starting_slots
--     from tournaments;
