-- 019_draft_is_mock.sql — is this draft the real one, or a rehearsal?
--
-- Run in the Supabase SQL editor AFTER 018. Safe to re-run.
--
-- A mock draft is indistinguishable from the real one, and that is the problem.
-- It uses the same teams, the same captains, the same pool and the same clock —
-- because a rehearsal that runs on different machinery rehearses nothing. So
-- the only thing separating "we are practising" from "this is the draft your
-- roster is decided by" is whether somebody said so in Discord beforehand, and
-- on the night that is not enough: captains join late, get the DM, and start
-- picking their real roster into a draft that is about to be thrown away.
--
-- One boolean, written when the draft STARTS rather than set on the tournament,
-- because the same tournament runs both — a mock on Tuesday and the real one on
-- Saturday, with the same teams and the same pool in between.
--
-- Defaults FALSE, so a draft started by an older build, or by anything that
-- does not know about this column, is treated as real. That is the safe
-- direction to be wrong in: a real draft mislabelled as a rehearsal invites
-- everybody to stop taking it seriously, while a mock mislabelled as real
-- costs an apology and a reset.
alter table drafts
  add column if not exists is_mock boolean not null default false;

-- Check — what the current draft thinks it is:
--   select status, is_mock, current_pick, rounds from drafts;
