-- 009_shotcall.sql — "are you willing to shotcall for a team?"
--
-- Run in the Supabase SQL editor AFTER 008. Safe to re-run.
--
-- ── WHY THIS IS NULLABLE AND HAS NO DEFAULT ─────────────────────────────────
-- The same reasoning as migration 002, and it matters more here than it looks.
--
-- `boolean not null default false` would be the obvious column, and it would
-- silently write "no, I won't shotcall" onto every signup already filed — by
-- people who were never shown the question. That is not a missing answer, it is
-- a WRONG answer, and it reads identically to one somebody gave on purpose.
-- The first person harmed is the captain who drafts a party with no shotcaller
-- in it because the board told them nobody was willing.
--
-- Null means "never asked". The form sends a real true or false from now on —
-- an unticked box is a genuine no — so the only nulls that can exist are the
-- rows that predate this column, and the queue flags them so an organizer can
-- see who still needs asking.
alter table player_signups
  add column if not exists wants_shotcall boolean;

comment on column player_signups.wants_shotcall is
  'Willing to shotcall. NULL = filed before the question existed; do not read a null as "no".';

-- Captains filling eight parties want to find these people quickly, and a
-- partial index keeps it to the rows that said yes.
create index if not exists player_signups_shotcall_idx
  on player_signups (tournament_id) where wants_shotcall;

-- Check — nulls here are people to go and ask, not people who declined:
--   select count(*) filter (where wants_shotcall)        as yes,
--          count(*) filter (where wants_shotcall = false) as no,
--          count(*) filter (where wants_shotcall is null) as never_asked
--     from player_signups;
