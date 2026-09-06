-- 022_party_slots.sql — which of a team's 66 sits in which of its 48 seats.
--
-- Run in the Supabase SQL editor AFTER 021. Safe to re-run.
--
-- party_template says a team fields 8 parties of 6 and what each seat may hold.
-- team_players says who is on the team. Nothing until now said WHO SITS WHERE,
-- so a captain with a full roster still had to work their comp out in a
-- spreadsheet and keep it in step by hand.
--
-- ── One row per FILLED seat ─────────────────────────────────────────────────
-- Empty seats are absent rows, not rows with a null signup_id. A comp part-way
-- through being built is mostly empty seats, and storing them would mean
-- writing 48 rows per team to say almost nothing, then keeping them in step
-- with a party_template that can be resized underneath them.
--
-- The bench is the same idea, and needs no storage at all: a player on
-- team_players with no row here is on the bench. That is why there is no
-- `bench` flag to get out of step with anything — "not seated" has exactly one
-- representation.
--
-- ── The three constraints ARE the feature ───────────────────────────────────
-- A jsonb layout blob on the team was the obvious alternative and it is the
-- one this table exists to avoid. A blob is a second place the roster lives,
-- and nothing in it can stop a comp naming somebody who was never drafted, or
-- who was cut an hour ago, or who is sitting in two seats at once. Each of
-- those is a constraint here instead:
--
--   · one player is in at most one seat        (team_id, signup_id)
--   · one seat holds at most one player        (team_id, party_index, slot_index)
--   · you can only seat somebody ON THE TEAM   FK to team_players
--
-- That last one is the good one. It cascades: cutting a player from a roster
-- empties their seat, with no application code that has to remember to.

create table if not exists team_party_slots (
  id             uuid primary key default gen_random_uuid(),

  tournament_id  uuid not null references tournaments(id) on delete cascade,
  team_id        uuid not null,
  signup_id      uuid not null,

  -- 0-based, indexing party_template and the slots array inside one party.
  -- 0-based because these index arrays; everything a PERSON reads adds one.
  party_index    int not null check (party_index >= 0),
  slot_index     int not null check (slot_index >= 0),

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

do $$ begin
  -- One player, one seat. Moving somebody is an update of their row, not a
  -- second insert, so a fumbled drag cannot leave them in two parties.
  if not exists (select 1 from pg_constraint where conname = 'party_slots_one_seat_per_player') then
    alter table team_party_slots
      add constraint party_slots_one_seat_per_player unique (team_id, signup_id);
  end if;

  -- One seat, one player. Two captains editing at once produce one seating and
  -- one error rather than two rows nobody can tell apart.
  if not exists (select 1 from pg_constraint where conname = 'party_slots_one_player_per_seat') then
    alter table team_party_slots
      add constraint party_slots_one_player_per_seat unique (team_id, party_index, slot_index);
  end if;

  -- THE constraint. A seat can only hold somebody who is actually on this
  -- team's roster, and dropping them from it takes the seating with them.
  -- Leans on team_players_once_per_team from 008.
  if not exists (select 1 from pg_constraint where conname = 'party_slots_on_the_roster') then
    alter table team_party_slots
      add constraint party_slots_on_the_roster
      foreign key (team_id, signup_id) references team_players (team_id, signup_id)
      on delete cascade;
  end if;

  -- And the team belongs to this tournament, the composite way 006/007/008 do
  -- it — so a seating cannot name a team from another season.
  if not exists (select 1 from pg_constraint where conname = 'party_slots_team_tournament') then
    alter table team_party_slots
      add constraint party_slots_team_tournament
      foreign key (team_id, tournament_id) references teams (id, tournament_id) on delete cascade;
  end if;
end $$;

create index if not exists party_slots_team_idx
  on team_party_slots (team_id, party_index, slot_index);

drop trigger if exists party_slots_touch on team_party_slots;
create trigger party_slots_touch
  before update on team_party_slots
  for each row execute function touch_updated_at();

-- Check — a team's comp, readable:
--   select t.name, s.party_index + 1 as party, s.slot_index + 1 as seat, p.player_name, p.role
--     from team_party_slots s
--     join teams t on t.id = s.team_id
--     join player_signups p on p.id = s.signup_id
--    order by t.seed, s.party_index, s.slot_index;
--
-- And the invariant worth watching — nobody seated who is not on the roster.
-- Should always be zero; the FK makes it so, and this is how you prove it:
--   select count(*) from team_party_slots s
--    where not exists (select 1 from team_players r
--                       where r.team_id = s.team_id and r.signup_id = s.signup_id);
