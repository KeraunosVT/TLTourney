-- 008_rosters.sql — who actually plays for a team.
--
-- Run in the Supabase SQL editor AFTER 007. Safe to re-run.
--
-- `team_captains` says who RUNS a team. This says who PLAYS for it, and a
-- captain is both — seating one puts them on their own roster, which is what
-- stops them turning up in the pool of players every captain is trying to
-- draft.
--
-- One table for everybody on a roster, however they got there, rather than a
-- captains-plus-drafted union computed at read time. The union is the thing
-- that goes wrong: every query that asks "is this player taken" has to
-- remember both halves, and the one that forgets is the one that lets a
-- captain be drafted by somebody else.
--
-- Constraints go in guarded blocks, for the reason 006 and 007 document.

create table if not exists team_players (
  id             uuid primary key default gen_random_uuid(),

  tournament_id  uuid not null references tournaments(id) on delete cascade,
  team_id        uuid not null,
  signup_id      uuid not null references player_signups(id) on delete cascade,

  -- How they got here. 'captain' rows are written by seating a captain and
  -- removed by unseating one; 'draft' rows will be written by the draft.
  -- Recorded rather than inferred, because "should unseating this captain take
  -- them off the roster" has a different answer depending on it.
  via            text not null default 'draft',

  -- Filled in by the draft; null for a captain, who was never picked.
  draft_round    int,
  draft_pick     int,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'team_players_via_valid') then
    alter table team_players
      add constraint team_players_via_valid check (via in ('captain', 'draft', 'manual'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'team_players_once_per_team') then
    alter table team_players
      add constraint team_players_once_per_team unique (team_id, signup_id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'team_players_team_tournament') then
    alter table team_players
      add constraint team_players_team_tournament
      foreign key (team_id, tournament_id) references teams (id, tournament_id) on delete cascade;
  end if;
end $$;

-- THE constraint. One person plays for one team, and the database is what
-- guarantees it — not the check in whichever route happens to run first. It is
-- also what the draft will lean on: two captains clicking the same player at
-- the same instant produce one roster row and one error, not two picks.
create unique index if not exists team_players_one_team_per_person
  on team_players (tournament_id, signup_id);

create index if not exists team_players_team_idx on team_players (team_id, via);

drop trigger if exists team_players_touch on team_players;
create trigger team_players_touch
  before update on team_players
  for each row execute function touch_updated_at();

-- ── Put the captains already seated onto their rosters ──────────────────────
-- Idempotent: re-running adds nobody twice.
insert into team_players (tournament_id, team_id, signup_id, via)
select tc.tournament_id, tc.team_id, tc.signup_id, 'captain'
  from team_captains tc
on conflict (team_id, signup_id) do nothing;

-- Check — every captain should appear here, and nobody twice:
--   select t.name, p.via, s.player_name
--     from team_players p
--     join teams t on t.id = p.team_id
--     join player_signups s on s.id = p.signup_id
--    order by t.seed, p.via, s.player_name;
