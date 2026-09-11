-- 035_prediction_corrections.sql — telling a repair apart from a late pick.
--
-- Run in the Supabase SQL editor AFTER 034. Safe to re-run.
--
-- ── The check this exists for ───────────────────────────────────────────────
-- verify.sql's '016 · no pick was saved after kickoff' is an anti-cheat row: it
-- looks for a prediction whose updated_at is later than its match's
-- scheduled_at, which is somebody changing their pick once they know how the
-- game is going.
--
-- It reads updated_at, which is "when this row last changed" and not "when the
-- person who owns it last saved it". Those are the same thing right up until
-- somebody repairs the data — and then a correction made by an organizer is
-- indistinguishable from the exact thing the row is meant to catch.
--
-- That is what happened here. Three predictions were saved as "2 — 1" on
-- seeding fixtures that were best_of 3 at the time; 029 turned those fixtures
-- into best_of 1 eleven minutes later, which made the saved scorelines
-- impossible retroactively, and clamping them to the only legal value bumped
-- updated_at long past a kickoff that had already happened.
--
-- ── Why a column rather than a weaker check ─────────────────────────────────
-- The alternative is to loosen the check until it stops complaining, which
-- would also stop it catching a real late edit — the one thing it is for. A
-- prediction league that cannot prove nobody edited after kickoff has nothing
-- to argue with when somebody says they were cheated.
--
-- So the repair is RECORDED instead. A row with corrected_at set was changed by
-- an organizer and is excluded from the anti-cheat check; every other row is
-- still held to it exactly as before. And because the correction now says who
-- made it, editing somebody else's entry is itself on the record — which is the
-- right bar for touching a person's prediction.
alter table predictions
  add column if not exists corrected_at  timestamptz;

alter table predictions
  add column if not exists corrected_by  text;

alter table predictions
  add column if not exists corrected_why text;

do $$ begin
  -- A correction with no reason is a hand-edit with a column in front of it.
  -- The three fields travel together or not at all.
  if not exists (select 1 from pg_constraint where conname = 'predictions_correction_complete') then
    alter table predictions
      add constraint predictions_correction_complete
      check ((corrected_at is null and corrected_by is null and corrected_why is null)
          or (corrected_at is not null and corrected_by is not null and corrected_why is not null));
  end if;
end $$;

-- ── Stamp the repair that has already happened ──────────────────────────────
-- Narrow on purpose. Only rows that were edited after they were created, only
-- rows whose scoreline is now legal (so the clamp is what touched them), and
-- only rows not already stamped — so re-running this changes nothing and a
-- genuinely late pick made later is never swept up by it.
--
-- This UPDATE fires the touch trigger and moves updated_at again. Harmless:
-- from here the check skips these rows on corrected_at, not on their timestamp.
update predictions p
   set corrected_at  = p.updated_at,
       corrected_by  = 'migration 035',
       corrected_why = 'Scoreline clamped after 029 changed the seeding fixtures '
                       || 'from best of 3 to best of 1 under a saved pick.'
  from matches m
 where m.id = p.match_id
   and p.corrected_at is null
   and p.updated_at > p.created_at
   and m.scheduled_at is not null
   and p.updated_at > m.scheduled_at
   and p.loser_games < (m.best_of / 2) + 1;

-- Check — what was corrected, and why. Expect the rows clamped after 029:
--   select p.display_name, m.key, p.loser_games, p.corrected_by, p.corrected_why
--     from predictions p join matches m on m.id = p.match_id
--    where p.corrected_at is not null
--    order by p.corrected_at;
--
-- THE ONE THAT STILL HAS TO BE EMPTY. A pick changed after kickoff that nobody
-- recorded a correction for — the anti-cheat row, with repairs excluded:
--   select p.display_name, m.key, p.created_at, p.updated_at, m.scheduled_at
--     from predictions p join matches m on m.id = p.match_id
--    where m.scheduled_at is not null
--      and p.updated_at > m.scheduled_at
--      and p.corrected_at is null;
--
-- And no scoreline is impossible any more, which is what started this:
--   select count(*) from predictions p join matches m on m.id = p.match_id
--    where p.loser_games >= (m.best_of / 2) + 1;
