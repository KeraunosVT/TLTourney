-- 004_teams.sql — teams, captains, seeds, and the party template.
--
-- Run in the Supabase SQL editor AFTER 003. Safe to re-run.

-- NOTE: the party template lives in 005, not here. An earlier draft of this
-- migration added it as text[] with the wrong shape; 005 replaces it rather
-- than editing this file, because this one has already been applied and
-- `add column if not exists` would silently do nothing to the existing column.

-- ── Teams ───────────────────────────────────────────────────────────────────
create table if not exists teams (
  id             uuid primary key default gen_random_uuid(),
  tournament_id  uuid not null references tournaments(id) on delete cascade,

  name           text not null check (length(btrim(name)) between 1 and 40),
  -- Short form for brackets and scoreboards, where the full name won't fit.
  tag            text check (tag is null or length(btrim(tag)) between 1 and 6),

  -- Draft order and bracket seeding both read this. Nullable while an organizer
  -- is still setting teams up; the draft refuses to start until every team has
  -- one, because snake order IS the seed order.
  seed           int check (seed is null or seed >= 1),

  -- The captain, as their signup. A foreign key rather than a loose discord_id,
  -- so a captain is by construction someone who signed up — and their classes,
  -- role and positions are one join away rather than copied here to go stale.
  -- ON DELETE SET NULL: a team must survive losing its captain rather than
  -- vanishing with them.
  captain_id     uuid references player_signups(id) on delete set null,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- Two teams called the same thing is a data-entry slip, not a decision.
  constraint teams_name_unique unique (tournament_id, name)
);

-- Seeds must be unique WHERE SET. A partial unique index rather than a table
-- constraint, because many teams legitimately have no seed during setup.
create unique index if not exists teams_seed_unique
  on teams (tournament_id, seed) where seed is not null;

-- One person cannot captain two teams. Same partial-index reasoning.
create unique index if not exists teams_captain_unique
  on teams (tournament_id, captain_id) where captain_id is not null;

create index if not exists teams_tournament_idx on teams (tournament_id, seed);

drop trigger if exists teams_touch on teams;
create trigger teams_touch
  before update on teams
  for each row execute function touch_updated_at();

-- Check: 8 parties x 6 = 48 starters, + 12 subs = 60 per team.
--   select name, party_count, party_size, sub_count, roster_size,
--          jsonb_array_length(party_template) as parties
--     from tournaments;
