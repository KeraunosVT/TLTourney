-- 024_sub_slots_v2.sql — the bench moves two seats from damage to healing,
-- and the ceilings stop being advice.
--
-- Run in the Supabase SQL editor AFTER 023. Safe to re-run.
--
-- 021 set the bench to 4 Tank, 10 DPS, 4 Healer. It is now:
--
--   4 Tank, 8 DPS, 6 Healer  = 18
--
-- Still eighteen, so sub_count does not move, roster_size stays 66, and the
-- draft is exactly as long as it was. Only the composition changes.
--
-- ── What this does to the per-role numbers ──────────────────────────────────
-- The 48 starters are untouched, so their floors and ceilings are unchanged:
-- Tank 9-16, DPS 16-23, Healer 16-21, with 7 flexible slots between them.
-- Adding the new bench:
--
--                 before (021)        after (024)
--   Tank          13 - 20             13 - 20     (unchanged)
--   DPS           26 - 33             24 - 31
--   Healer        20 - 25             22 - 27
--
-- The floors still total 59, and 59 + 7 flexible = 66.
--
-- ── The ceilings are now HARD CAPS ─────────────────────────────────────────
-- This is the behavioural change, and it lives in code rather than here:
-- backend/draft.js refuses a pick that would put a team over a role's ceiling,
-- and the auto-picker filters those players out of both the pool and the board
-- so the clock cannot make a pick the same rule would then reject.
--
-- The ceiling is not a preference. It is the number of seats in the template a
-- role can occupy at all — its exclusive slots, the flexible ones it is
-- eligible for, and its share of the bench. Past it there is nowhere to put the
-- player: they cannot start and they cannot sit on the bench. Before this,
-- drafting a 28th healer was allowed and only became visible weeks later, in
-- the party builder, as a roster that would not seat.
--
-- What it does NOT guarantee is a fieldable roster in general. The three
-- ceilings overlap — the flexible slots are counted once for each role that
-- could take them — so they sum to more than 66 and a team can stay under all
-- three and still come up short. See the warning on roleRoom in
-- shared/parties.cjs. This catches the mistake people actually make; it does
-- not solve packing.

update tournaments
   set sub_slots = '["Tank","Tank","Tank","Tank",
      "DPS","DPS","DPS","DPS","DPS","DPS","DPS","DPS",
      "Healer","Healer","Healer","Healer","Healer","Healer"]'::jsonb
 -- Unfinished seasons only, and only a bench that is still the one 021 set. An
 -- organizer who has since tuned it chose those numbers; a migration that
 -- overwrites a deliberate edit is one nobody can re-run safely.
 where status <> 'complete'
   and sub_count = 18
   and sub_slots = '["Tank","Tank","Tank","Tank",
      "DPS","DPS","DPS","DPS","DPS","DPS","DPS","DPS","DPS","DPS",
      "Healer","Healer","Healer","Healer"]'::jsonb;

-- Check — the bench, counted:
--   select name,
--          (select count(*) from jsonb_array_elements_text(sub_slots) s where s = 'Tank')   as tank,
--          (select count(*) from jsonb_array_elements_text(sub_slots) s where s = 'DPS')    as dps,
--          (select count(*) from jsonb_array_elements_text(sub_slots) s where s = 'Healer') as healer,
--          sub_count
--     from tournaments order by created_at;
--
-- And the one worth running the morning after a draft — any team already over
-- a ceiling. Should be empty; if 024 lands mid-draft on a team that had
-- already over-drafted a role under the old numbers, it will not be, and those
-- rosters need a manual fix rather than another pick:
--   select t.name, p.role, count(*) as have
--     from team_players r
--     join teams t on t.id = r.team_id
--     join player_signups p on p.id = r.signup_id
--    where p.role is not null
--    group by t.name, p.role
--   having (p.role = 'Tank'   and count(*) > 20)
--       or (p.role = 'DPS'    and count(*) > 31)
--       or (p.role = 'Healer' and count(*) > 27);
