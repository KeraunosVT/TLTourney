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
               where schemaname = 'public' and indexname = 'player_signups_positions_idx');
