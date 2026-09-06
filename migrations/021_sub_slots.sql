-- 021_sub_slots.sql — the bench gets a shape: 4 Tank, 10 DPS, 4 Healer.
--
-- Run in the Supabase SQL editor AFTER 020. Safe to re-run.
--
-- 018 made the bench 18 players. It did not say what those 18 ARE, so every
-- role figure in the app was computed off the 48 starters while the roster
-- total counted all 66 — two numbers describing one team and disagreeing by a
-- third of it. A captain reading "Healer 16/16, covered" still had 18 picks to
-- make and nothing telling them what to spend those picks on.
--
-- ── Why slots and not three counts ──────────────────────────────────────────
-- The obvious shape is {"Tank": 4, "DPS": 10, "Healer": 4}. This is a LIST of
-- slot types instead — ["Tank","Tank",...] — in exactly the vocabulary a party
-- already uses, because that makes the bench free rather than special:
--
--   · roleDemand takes it unchanged, so the bench gets the same min/max
--     treatment as the starters and nothing needed a second code path.
--   · A bench slot can be 'Any Role', which an organizer genuinely wants when
--     the last few seats are "best player available". Three counts cannot say
--     that at all.
--   · sub_slots is to sub_count what party_template is to party_count, so the
--     rule for keeping them in step is one an organizer has already met.
--
-- ── Kept in step by a CHECK ─────────────────────────────────────────────────
-- party_count is pinned to the template's length by a constraint, and
-- party_size is pinned to nothing — which shared/parties.cjs calls out as the
-- gap that lets a 52-player roster sit beside a template describing 48. This
-- does not repeat that: sub_slots must be exactly sub_count long, enforced.
--
-- The API resizes the bench whenever sub_count moves (resizeSubs, padding with
-- 'Any Role'), so an organizer changing the number in Setup never has to think
-- about this constraint. It is there for everything that is not the API.

alter table tournaments
  add column if not exists sub_slots jsonb not null default
    '["Tank","Tank","Tank","Tank",
      "DPS","DPS","DPS","DPS","DPS","DPS","DPS","DPS","DPS","DPS",
      "Healer","Healer","Healer","Healer"]'::jsonb;

-- ── The running season gets the real bench ──────────────────────────────────
-- Only where it is actually an 18-man bench. A season on some other sub_count
-- falls through to the generic backfill below rather than being handed a
-- 18-slot list that would fail the constraint.
update tournaments
   set sub_slots = '["Tank","Tank","Tank","Tank",
      "DPS","DPS","DPS","DPS","DPS","DPS","DPS","DPS","DPS","DPS",
      "Healer","Healer","Healer","Healer"]'::jsonb
 where status <> 'complete'
   and sub_count = 18;

-- ── Everything else gets an UNCOMMITTED bench of the right length ───────────
-- Archived seasons, and any row whose sub_count is not 18. 'Any Role' rather
-- than a guess, for the reason resizeTemplate pads with it: a slot type is a
-- REQUIREMENT, and inventing one makes a roster read as short of a role that
-- was never asked for. An archived season's real bench composition is not
-- recorded anywhere, and this does not pretend otherwise.
update tournaments
   set sub_slots = coalesce(
         (select jsonb_agg('Any Role'::text) from generate_series(1, sub_count)),
         '[]'::jsonb)
 where jsonb_array_length(sub_slots) <> sub_count;

-- ── Now it can be enforced ──────────────────────────────────────────────────
-- Added after both backfills, so it is applied to rows that already satisfy it.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tournaments_sub_slots_count') then
    alter table tournaments add constraint tournaments_sub_slots_count
      check (jsonb_array_length(sub_slots) = sub_count);
  end if;
end $$;

-- Check — the bench, and that it agrees with the number:
--   select name, sub_count, jsonb_array_length(sub_slots) as slots, sub_slots
--     from tournaments order by created_at;
--
-- A full roster then asks, per team: Tank 13-20, DPS 26-33, Healer 20-25.
-- Those floors total 59; the remaining 7 are the flexible starting slots.
