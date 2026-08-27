-- verify.sql — "is this database where the repo thinks it is?"
--
-- Paste into the Supabase SQL editor and run. Every row should say `ok`.
-- Anything reading false means that migration didn't take, in whole or part.
--
-- Safe to run any number of times: it only reads catalog tables and changes
-- nothing. Not a migration — it has no number and never needs applying.
--
-- Add a row here whenever a migration adds a table, column, function or
-- constraint, so this stays the single answer to "did that one land?".

select '001 · tournaments table' as item,
       to_regclass('public.tournaments') is not null as ok
union all
select '001 · player_signups table',
       to_regclass('public.player_signups') is not null
union all
select '001 · audit_log table',
       to_regclass('public.audit_log') is not null
union all
-- The constraint that stops one person filing two signups. Everything else in
-- the signup flow degrades visibly; a duplicate here does not — it just puts
-- the same player on the draft board twice.
select '001 · one signup per person per tournament',
       exists (select 1 from pg_constraint
               where conname = 'player_signups_one_per_person')
union all
select '001 · between 1 and 3 classes',
       exists (select 1 from pg_constraint
               where conname = 'player_signups_class_count')
union all
select '001 · classes column is a text array',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'player_signups'
                 and column_name = 'classes' and data_type = 'ARRAY')
union all
-- Gear level was removed. If this column is still here the old migration ran
-- and the table needs recreating, which the app will not tell you — it just
-- writes rows without it.
select '001 · gear_level is GONE',
       not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'player_signups'
                     and column_name = 'gear_level')
union all
select '001 · updated_at trigger',
       exists (select 1 from pg_trigger
               where tgname = 'player_signups_touch' and not tgisinternal)
union all
select '001 · at least one tournament exists',
       (select count(*) from tournaments) >= 1
union all
-- ── 002 ────────────────────────────────────────────────────────────────────
select '002 · role column',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'player_signups'
                 and column_name = 'role')
union all
select '002 · role is constrained to Tank/DPS/Healer',
       exists (select 1 from pg_constraint where conname = 'player_signups_role_valid')
union all
select '002 · positions column is a text array',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'player_signups'
                 and column_name = 'positions' and data_type = 'ARRAY')
union all
select '002 · positions count is capped',
       exists (select 1 from pg_constraint where conname = 'player_signups_positions_count')
union all
select '002 · positions gin index',
       exists (select 1 from pg_indexes
               where schemaname = 'public' and indexname = 'player_signups_positions_idx')
union all
-- ── 003 ────────────────────────────────────────────────────────────────────
select '003 · roster_size is GENERATED, not editable',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'tournaments'
                 and column_name = 'roster_size' and is_generated = 'ALWAYS')
union all
select '003 · roster is 8 x 6 + 12 = 60',
       (select party_count = 8 and party_size = 6 and sub_count = 12 and roster_size = 60
          from tournaments order by created_at limit 1)
union all
-- ── 004 ────────────────────────────────────────────────────────────────────
select '004 · teams table',
       to_regclass('public.teams') is not null
union all
-- 004's captain index guarded teams.captain_id, and 006 drops both. Asserted
-- GONE rather than deleted, so a database still carrying it — 006 half-applied,
-- or never run — reads false here instead of looking finished.
-- The rule itself lives on as `006 · one person cannot captain two teams`.
select '004 · captain index is GONE (superseded by 006)',
       not exists (select 1 from pg_indexes
                   where schemaname = 'public' and indexname = 'teams_captain_unique')
union all
select '004 · seeds are unique where set',
       exists (select 1 from pg_indexes
               where schemaname = 'public' and indexname = 'teams_seed_unique')
union all
-- ── 005 ────────────────────────────────────────────────────────────────────
-- The one most likely to be half-applied: 004's earlier draft created this
-- column as text[], and `add column if not exists` would not have replaced it.
-- jsonb here is the pass; ARRAY means 005 has not run.
select '005 · party_template is jsonb (NOT text[])',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'tournaments'
                 and column_name = 'party_template' and data_type = 'jsonb')
union all
select '005 · template describes 8 parties',
       (select jsonb_array_length(party_template) = 8 from tournaments order by created_at limit 1)
union all
select '005 · template has 48 starting slots',
       (select (select sum(jsonb_array_length(p->'slots'))
                  from jsonb_array_elements(party_template) p) = 48
          from tournaments order by created_at limit 1)
union all
-- Healer, not Support — the signup form stores Healer, and a slot the form can
-- never satisfy is a slot that silently stays empty forever.
select '005 · template says Healer, not Support',
       (select party_template::text not like '%Support%' from tournaments order by created_at limit 1)
union all
-- ── 006 ────────────────────────────────────────────────────────────────────
select '006 · team_captains table',
       to_regclass('public.team_captains') is not null
union all
-- The half-applied state to watch for: the table created but the old column
-- still there. Two places to read a captain from is worse than one of either,
-- because the app reads the new one and an organizer might edit the old.
select '006 · teams.captain_id is GONE (captains are rows now)',
       not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'teams'
                     and column_name = 'captain_id')
union all
select '006 · a team has at most two captain seats',
       exists (select 1 from pg_constraint where conname = 'team_captains_seat_unique')
union all
select '006 · seat is constrained to 1 or 2',
       exists (select 1 from pg_constraint where conname = 'team_captains_seat_check')
union all
select '006 · one person cannot captain two teams',
       exists (select 1 from pg_indexes
               where schemaname = 'public' and indexname = 'team_captains_one_team_per_person')
union all
-- Without this the denormalised tournament_id can drift from the team's, and
-- the one-team-per-person index above starts guarding the wrong thing.
select '006 · captain rows are pinned to their team''s tournament',
       exists (select 1 from pg_constraint where conname = 'team_captains_team_tournament');
