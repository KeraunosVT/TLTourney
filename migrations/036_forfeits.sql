-- 036_forfeits.sql — recording that a match was conceded, and by whom.
--
-- Run in the Supabase SQL editor AFTER 035. Safe to re-run.
--
-- ── What was already possible, and what was missing ─────────────────────────
-- An organizer could already award a match with no games played: POST
-- /api/organizer/bracket/result writes the winning side exactly the number of
-- games it takes to win the series, each with no map on it. That IS a forfeit,
-- mechanically, and it is how every no-show has been recorded so far.
--
-- What it does not do is SAY SO. What lands in the database is a 2–0 whose
-- games have no maps, which is indistinguishable from a series somebody started
-- entering and gave up on halfway. The bracket shows a clean win, the match page
-- shows two blank rows, and the reason — a roster that fell apart, a team that
-- never turned up, a disqualification — exists nowhere except in the memory of
-- whoever clicked it.
--
-- That is the gap this closes. A forfeit is now stated rather than inferred
-- from the absence of maps.
--
-- ── Why on matches and not in the audit log ─────────────────────────────────
-- The audit log already records the action, and it is the right place to answer
-- "who did this and when". It is the wrong place to answer "why does this match
-- look like this", because nothing that renders a match reads it — the bracket
-- card, the match page and the broadcast overlay would all have to join against
-- a log to draw a badge. The fact belongs on the row it describes.
alter table matches
  add column if not exists forfeit_team_id uuid references teams(id) on delete set null;

alter table matches
  add column if not exists forfeit_why text;

alter table matches
  add column if not exists forfeit_at timestamptz;

alter table matches
  add column if not exists forfeit_by text;

do $$ begin
  -- The four travel together or not at all. A forfeit with no reason recorded
  -- is the thing this migration exists to stop being possible — see 035, which
  -- made the same argument about corrections for the same reason: a repair with
  -- no stated cause is a hand-edit with a column in front of it.
  if not exists (select 1 from pg_constraint where conname = 'matches_forfeit_complete') then
    alter table matches
      add constraint matches_forfeit_complete
      check ((forfeit_team_id is null and forfeit_why is null
              and forfeit_at is null and forfeit_by is null)
          or (forfeit_team_id is not null and forfeit_why is not null
              and forfeit_at is not null and forfeit_by is not null));
  end if;
end $$;

do $$ begin
  -- The team that conceded cannot also be the team that won. Cheap to state and
  -- impossible to get right by accident: the API takes the FORFEITING side and
  -- derives the winner, which is the opposite of the award route it replaces,
  -- and inverting those two is the mistake a tired organizer makes at 1am.
  if not exists (select 1 from pg_constraint where conname = 'matches_forfeit_not_winner') then
    alter table matches
      add constraint matches_forfeit_not_winner
      check (forfeit_team_id is null or winner_team_id is null
             or forfeit_team_id <> winner_team_id);
  end if;
end $$;

-- A forfeited match, end to end:
--   select m.key, t.name as conceded, w.name as awarded_to,
--          m.forfeit_why, m.forfeit_by, m.forfeit_at
--     from matches m
--     join teams t on t.id = m.forfeit_team_id
--     left join teams w on w.id = m.winner_team_id
--    order by m.forfeit_at desc;
--
-- Both checks, which should be empty:
--   select key from matches
--    where (forfeit_team_id is null) <> (forfeit_why is null);
--   select key from matches where forfeit_team_id = winner_team_id;
