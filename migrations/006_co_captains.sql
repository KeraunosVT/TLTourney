-- 006_co_captains.sql — two captains per team, not one.
--
-- Run in the Supabase SQL editor AFTER 005. Safe to re-run.
--
-- 004 gave `teams` a single `captain_id`. A second captain could have been a
-- second column, and that is the trap: "is this person already captaining a
-- team" would become an OR across two columns that no index can enforce, and a
-- third captain would mean touching every query again. Captains become rows.
--
-- The existing captain, if any, is carried across as seat 1 before the column
-- is dropped — nothing is lost, and nothing has to be re-entered by hand.
--
-- ⚠️  Every constraint below is added through its own guarded block rather than
-- inline in the CREATE. `create table if not exists` does NOTHING when the
-- table is already there, constraints and all — which is how 004 shipped a
-- party_template of the wrong type that 005 had to go back and replace. If this
-- table exists in some half-built form, the blocks below finish it. Re-running
-- this file is how you make the database match it.

-- Needed by the composite foreign key below, which is what stops a captain row
-- naming a team from a different tournament than the one it claims.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'teams_id_tournament_unique') then
    alter table teams add constraint teams_id_tournament_unique unique (id, tournament_id);
  end if;
end $$;

create table if not exists team_captains (
  id             uuid primary key default gen_random_uuid(),

  -- Denormalised from the team on purpose: it is what makes "one person may
  -- captain at most one team in this tournament" a single unique index instead
  -- of a trigger. The composite FK below keeps it honest.
  tournament_id  uuid not null references tournaments(id) on delete cascade,

  -- No single-column FK to teams: the composite one below already guarantees
  -- the team exists, and declaring both would give PostgREST two relationships
  -- between the same pair of tables to choose between.
  team_id        uuid not null,

  -- The captain, as their signup — same reasoning as 004's captain_id. Their
  -- discord_id lives on that row, and that is how the site recognises them when
  -- they sign in. CASCADE rather than SET NULL: with a row per captain there is
  -- no null to set, and losing the signup means losing the seat, not the team.
  signup_id      uuid not null references player_signups(id) on delete cascade,

  -- 1 = Captain, 2 = Co-captain. Same powers; the number is billing order and
  -- the cap on how many a team may have. See shared/captains.cjs.
  seat           smallint not null,

  created_at     timestamptz not null default now()
);

-- ── The rules, each added only if it isn't there ────────────────────────────
do $$ begin
  -- Two captains, no more. THIS is the cap — not a count in application code.
  if not exists (select 1 from pg_constraint where conname = 'team_captains_seat_check') then
    alter table team_captains add constraint team_captains_seat_check check (seat in (1, 2));
  end if;

  -- A team has one of each seat.
  if not exists (select 1 from pg_constraint where conname = 'team_captains_seat_unique') then
    alter table team_captains add constraint team_captains_seat_unique unique (team_id, seat);
  end if;

  -- ...and the same person cannot hold both of a team's seats.
  if not exists (select 1 from pg_constraint where conname = 'team_captains_once_per_team') then
    alter table team_captains add constraint team_captains_once_per_team unique (team_id, signup_id);
  end if;

  -- The team must belong to the tournament this row claims it does. Without
  -- this the denormalised tournament_id can drift, and the one-team-per-person
  -- index below starts guarding the wrong thing.
  if not exists (select 1 from pg_constraint where conname = 'team_captains_team_tournament') then
    alter table team_captains add constraint team_captains_team_tournament
      foreign key (team_id, tournament_id) references teams (id, tournament_id) on delete cascade;
  end if;
end $$;

-- One person, one team. 004 enforced this with a partial index on teams; with
-- captains as rows it is a plain unique index over a not-null column.
create unique index if not exists team_captains_one_team_per_person
  on team_captains (tournament_id, signup_id);

create index if not exists team_captains_team_idx on team_captains (team_id, seat);

-- ── Carry the old single captain across, then drop the column ───────────────
-- Guarded so a re-run doesn't fail once the column is gone.
do $$ begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'teams' and column_name = 'captain_id'
  ) then
    insert into team_captains (tournament_id, team_id, signup_id, seat)
    select t.tournament_id, t.id, t.captain_id, 1
      from teams t
     where t.captain_id is not null
    on conflict do nothing;

    -- The index went with the column's job.
    drop index if exists teams_captain_unique;
    alter table teams drop column captain_id;
  end if;
end $$;

-- Check — run migrations/verify.sql, or by eye:
--   select t.name, tc.seat, s.player_name, s.discord_id
--     from teams t
--     left join team_captains tc on tc.team_id = t.id
--     left join player_signups s on s.id = tc.signup_id
--    order by t.seed, tc.seat;
