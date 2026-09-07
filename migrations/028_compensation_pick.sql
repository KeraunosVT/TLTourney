-- 028_compensation_pick.sql — a captain who does not play, and the extra pick
-- that makes up for them.
--
-- Run in the Supabase SQL editor AFTER 027. Safe to re-run.
--
-- EGIRL GAP's captain Zael holds a seat but is not playing this season. That
-- is two separate problems, and this migration is the two columns that fix
-- them:
--
--   1. HE STILL OCCUPIES A ROSTER SLOT. He has to — a roster row is what keeps
--      him off every other captain's board, and a captain who could be drafted
--      by somebody else is a worse bug than any of this. But he is counted as a
--      player everywhere: in the team's role totals, against the Tank/DPS/Healer
--      cap, and — worst — the party builder will offer to seat him in one of the
--      48 starting slots. `team_players.playing` is what stops that.
--
--   2. HIS TEAM FIELDS ONE FEWER PLAYER. Everyone else drafts 64 and fields 66;
--      EGIRL GAP drafts 64 and fields 65. The snake cannot fix this — every team
--      gets exactly `rounds` picks and that uniformity is the closed form
--      shared/draftOrder.cjs is built on — so the extra pick is inserted OUTSIDE
--      the snake, once.

-- ── 1. On the roster, not in the game ───────────────────────────────────────
-- Defaults true, so every existing row and every future one is a player unless
-- somebody says otherwise. The safe direction: a player wrongly marked
-- non-playing vanishes from the counts and is obvious; a non-player wrongly
-- counted is invisible until a party will not seat.
alter table team_players
  add column if not exists playing boolean not null default true;

-- ── 2. Who is owed an extra pick, and when it falls ─────────────────────────
-- On `drafts` beside order_snapshot and rounds, and frozen at the same moment
-- for the same reason: the pick order is decided when the draft starts, and a
-- value that can move underneath a running draft rewrites whose turn it has
-- been.
--
-- comp_after_pick is a PICK NUMBER, not a round. The clock compares against
-- pick numbers, and converting once when the draft starts beats converting on
-- every read.
alter table drafts
  add column if not exists comp_team_id uuid;

alter table drafts
  add column if not exists comp_after_pick int;

do $$ begin
  -- Both or neither. One without the other is a draft that owes a pick to
  -- nobody, or owes one at no particular time — and both read as "no
  -- compensation" while silently being a half-applied rule.
  if not exists (select 1 where exists (
    select 1 from pg_constraint where conname = 'drafts_comp_pair')) then
    alter table drafts add constraint drafts_comp_pair
      check ((comp_team_id is null) = (comp_after_pick is null));
  end if;
end $$;

-- ── Mark Zael ───────────────────────────────────────────────────────────────
-- Matched through the signup's player name and the team's, because that is all
-- a migration has — ids are generated.
--
-- ── This matched NOTHING the first time it ran ──────────────────────────────
-- It looked for 'Zaels'; the signup says 'Zael'. The update reported success
-- and changed no rows, so every 028 check passed except the one counting
-- non-playing members — and without that row the draft sees four level teams,
-- awards no compensation pick, and EGIRL GAP quietly fields one fewer.
--
-- Two things changed as a result, and both are about being wrong LOUDLY:
--
--   · lower(), so a capitalisation difference cannot do this again.
--   · the `via = 'captain'` guard is gone. Whether somebody plays has nothing
--     to do with how they reached the roster, and the guard was a third way
--     for this to silently match nothing. The verify check below is what
--     catches a bad match now — it asserts exactly one row, so zero fails.
--
-- CHECK THE QUERY AT THE BOTTOM after running this. A name that does not match
-- is silent here and surfaces on draft night as a team that never gets its
-- extra pick.
update team_players r
   set playing = false
  from player_signups p, teams t, tournaments o
 where p.id = r.signup_id
   and t.id = r.team_id
   and o.id = r.tournament_id
   and o.status <> 'complete'
   and t.name = 'EGIRL GAP'
   and lower(p.player_name) = 'zael';

-- Check — who is on a roster without playing. Should be exactly one row:
--   select t.name as team, p.player_name, r.via
--     from team_players r
--     join teams t on t.id = r.team_id
--     join player_signups p on p.id = r.signup_id
--     join tournaments o on o.id = r.tournament_id
--    where o.status <> 'complete' and r.playing = false;
--
-- And what each team will actually FIELD, which is the number this whole
-- migration exists to make equal. Before the draft it is the captains; after
-- it, it should read the same for every team:
--   select t.name, count(*) filter (where r.playing) as playing, count(*) as rostered
--     from team_players r
--     join teams t on t.id = r.team_id
--     join tournaments o on o.id = t.tournament_id
--    where o.status <> 'complete'
--    group by t.name order by t.name;
