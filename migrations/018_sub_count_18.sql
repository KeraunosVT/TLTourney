-- 018_sub_count_18.sql — six more substitutes per team: 12 → 18.
--
-- Run in the Supabase SQL editor AFTER 017. Safe to re-run.
--
-- A roster was 8 parties of 6 plus 12 subs = 60. It is now 8 parties of 6 plus
-- 18 subs = 66. The STARTING side of a team is untouched: 48 starters, the same
-- party template, the same role requirements. This is bench depth only.
--
-- ── What this changes downstream, none of it obvious from the diff ──────────
--
-- roster_size is a GENERATED column (003), so it follows on its own — there is
-- no second number to keep in step, and that is exactly why it was made
-- generated. But three things read it and all three move:
--
--   · THE DRAFT GETS LONGER. Rounds are roster_size minus what each team
--     already holds (backend/draft.js), so a draft that ran 58 rounds now runs
--     64. With four teams that is 256 picks rather than 232 — and the pick
--     clock multiplies it: at 120s a side, six extra rounds is roughly another
--     fifty minutes on the night.
--
--   · THE POOL HAS TO BE BIGGER. Every team needs 6 more bodies, so the
--     readiness figures on the Teams page ask for 24 more approved signups
--     across four teams, 48 across eight. Nothing breaks if they are not
--     there; the draft simply pauses itself when the pool runs dry, which is
--     a worse way to find out.
--
--   · ROSTER PROGRESS RE-DENOMINATES. Anything showing "41/60" reads "41/66"
--     the moment this lands, including mid-draft. Harmless, but it will look
--     like a team lost ground if somebody is watching when it happens.
--
-- Do NOT run this while a draft is live or paused. The round count is frozen
-- into the drafts row when the draft starts (010), so changing the roster under
-- a running draft leaves every progress bar counting toward a total the draft
-- itself will never reach, and nothing on screen would say why.

-- ── The default, for seasons created from here on ───────────────────────────
-- POST /api/organizer/tournament inserts nothing but a name and a status; every
-- roster number comes from these column defaults. Changing the default IS how a
-- new season gets 18.
alter table tournaments
  alter column sub_count set default 18;

-- ── And the season already running ──────────────────────────────────────────
-- Same shape as 003's backfill, and guarded twice for reasons 003 did not need:
--
--   · `sub_count = 12` — only rows still sitting on the OLD DEFAULT. An
--     organizer who deliberately set 9 or 20 chose that number, and a migration
--     that overwrites a deliberate choice is a migration nobody can trust to
--     re-run.
--
--   · `status <> 'complete'` — an archived season's roster size is history. Its
--     rosters are full at 60 and its bracket was played that way; rewriting the
--     number now would make the record describe a tournament that never
--     happened.
update tournaments
   set sub_count = 18
 where sub_count = 12
   and status <> 'complete';

-- After this, `select name, party_count, party_size, sub_count, roster_size
-- from tournaments order by created_at;` should read 8 / 6 / 18 / 66 for the
-- running season, and leave every archived one on 12 / 60.
