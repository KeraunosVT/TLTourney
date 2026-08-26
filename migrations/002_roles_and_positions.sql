-- 002_roles_and_positions.sql — what you do in a fight, and where you stand.
--
-- Run in the Supabase SQL editor AFTER 001. Safe to re-run.
--
-- ── WHY BOTH COLUMNS ALLOW "NOT ANSWERED" ───────────────────────────────────
-- Signups already exist by the time this runs, and they were filed by people
-- who were never asked either question. There are exactly two honest options:
-- refuse to add the columns until every row is updated, or let existing rows
-- say "not set".
--
-- What is NOT an option is backfilling a default. Stamping every pre-existing
-- signup 'DPS' would put a role on a healer's row that reads exactly like an
-- answer they gave — and the first person harmed by it is the captain who
-- drafts on it. A null is visibly missing; a wrong default is invisibly wrong.
--
-- The form requires both fields from now on, so anyone editing their signup
-- fills them in on the way through, and the approval queue flags the rows that
-- still haven't been.

-- ── Role: Tank, DPS or Healer. One per signup. ──────────────────────────────
alter table player_signups
  add column if not exists role text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'player_signups_role_valid') then
    alter table player_signups
      add constraint player_signups_role_valid
      check (role is null or role in ('Tank', 'DPS', 'Healer'));
  end if;
end $$;

-- ── Positions: where you stand. Many per signup. ────────────────────────────
-- Empty array means "not answered", the same as a null role. The upper bound is
-- checked; the lower bound is not, because 0 is the legacy state.
alter table player_signups
  add column if not exists positions text[] not null default '{}';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'player_signups_positions_count') then
    alter table player_signups
      add constraint player_signups_positions_count
      check (coalesce(array_length(positions, 1), 0) <= 4);
  end if;
end $$;

-- "Who can run killsquad?" is an array containment test, same as the class
-- lookup in 001, and a btree index cannot serve it.
create index if not exists player_signups_positions_idx
  on player_signups using gin (positions);

-- Roles are asked the other way round — "how many healers do we have" — which
-- is a plain equality scan, so btree is right here and gin would be wrong.
create index if not exists player_signups_role_idx
  on player_signups (tournament_id, role);

-- ── Who still needs to answer ───────────────────────────────────────────────
-- Run this after applying, to see which signups predate these fields. They are
-- not broken; they are just incomplete, and their owners re-filling them is the
-- only correct way to populate them.
--
--   select player_name, discord_username, status
--   from player_signups
--   where role is null or coalesce(array_length(positions, 1), 0) = 0;
