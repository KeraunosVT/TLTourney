-- 020_party_template_v2.sql — party 2 stops being a second objective party.
--
-- Run in the Supabase SQL editor AFTER 019. Safe to re-run.
--
-- 005 gave party 2 the objective party's shape — 'Flex (2-2-2)', two Tanks and
-- two Tank / DPS. It is an ordinary Flex now, matching the template the
-- organizers actually drafted against:
--
--   1  Objective / Main   Tank  Tank      Tank / DPS  Tank / DPS  Healer  Healer
--   2  Flex               Tank  Any Role  DPS         DPS         Healer  Healer
--   3  Flex               Tank  Any Role  DPS         DPS         Healer  Healer
--   4  Flex               Tank  Any Role  DPS         DPS         Healer  Healer
--   5  Flex               Tank  Any Role  DPS         DPS         Healer  Healer
--   6  Flex               Tank  Any Role  DPS         DPS         Healer  Healer
--   7  3 DPS              Tank  DPS       DPS         DPS         Healer  Healer
--   8  3 DPS              Tank  DPS       DPS         DPS         Healer  Healer
--
-- Still 8 parties of 6, so roster_size does not move and neither does the draft
-- — this changes the SHAPE of the 48 starters, not how many there are.
--
-- ── HEALER, NOT SUPPORT ─────────────────────────────────────────────────────
-- The source this was transcribed from labels the last two rows of every party
-- "Support". They are stored as 'Healer' here, and that is not a slip.
--
-- player_signups.role is CHECK-constrained to ('Tank', 'DPS', 'Healer') by 002,
-- and the signup form offers those three. A slot type named 'Support' matches
-- no role any player can hold, so roleDemand would count it toward nothing, the
-- readiness panel would report a requirement no signup can satisfy, and the
-- slot would sit empty forever with nothing on screen explaining why. verify.sql
-- asserts the template contains no 'Support' precisely to catch this.
--
-- ── What moves ──────────────────────────────────────────────────────────────
-- Party 2 gives up one compulsory Tank and two Tank / DPS, and gains two
-- compulsory DPS and one Any Role. Per team:
--
--   Tank     min 10 → 9    max 17 → 16
--   DPS      min 14 → 16   max 22 → 23
--   Healer   min 16 → 16   max 21 → 21   (unchanged)
--   flexible      8 → 7
--
-- So the pool needs slightly fewer tanks and two more DPS a team than it did.
-- At four teams that is 8 more DPS on the readiness panel the moment this runs.

update tournaments
   set party_template = '[
    {"name":"Objective / Main","slots":["Tank","Tank","Tank / DPS","Tank / DPS","Healer","Healer"]},
    {"name":"Flex","slots":["Tank","Any Role","DPS","DPS","Healer","Healer"]},
    {"name":"Flex","slots":["Tank","Any Role","DPS","DPS","Healer","Healer"]},
    {"name":"Flex","slots":["Tank","Any Role","DPS","DPS","Healer","Healer"]},
    {"name":"Flex","slots":["Tank","Any Role","DPS","DPS","Healer","Healer"]},
    {"name":"Flex","slots":["Tank","Any Role","DPS","DPS","Healer","Healer"]},
    {"name":"3 DPS","slots":["Tank","DPS","DPS","DPS","Healer","Healer"]},
    {"name":"3 DPS","slots":["Tank","DPS","DPS","DPS","Healer","Healer"]}
  ]'::jsonb
 -- Unfinished seasons only. An archived tournament was PLAYED on its template,
 -- and rewriting it would make the record describe parties that never took the
 -- field. Same reasoning as 018's sub_count guard.
 where status <> 'complete';

-- Check — the shape, and that no slot names a role no player can hold:
--   select jsonb_array_length(party_template) as parties,
--          (select sum(jsonb_array_length(p->'slots'))
--             from jsonb_array_elements(party_template) p) as starters,
--          party_template::text not like '%Support%' as no_support_slots
--     from tournaments order by created_at;
