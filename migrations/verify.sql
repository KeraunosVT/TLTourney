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
select '001 · weapons must differ',
       exists (select 1 from pg_constraint
               where conname = 'player_signups_distinct_weapons')
union all
select '001 · updated_at trigger',
       exists (select 1 from pg_trigger
               where tgname = 'player_signups_touch' and not tgisinternal)
union all
select '001 · at least one tournament exists',
       (select count(*) from tournaments) >= 1;
