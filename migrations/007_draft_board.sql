-- 007_draft_board.sql — each team's private pre-draft board.
--
-- Run in the Supabase SQL editor AFTER 006. Safe to re-run.
--
-- One row per player a captain has placed. A player who has not been placed
-- simply has no row — the pool is "approved signups minus what's on my board",
-- which means a board never has to be initialised, migrated when signups
-- arrive, or cleaned up when one is withdrawn.
--
-- Keyed on TEAM, not on captain: a team's two captains share one board. They
-- are drafting one roster between them, and two private boards that disagree is
-- the exact failure this is meant to prevent.
--
-- ⚠️  PRIVACY. There is no row-level security here — the backend holds the
-- service key and RLS would not apply to it anyway. Confidentiality is enforced
-- in backend/board.js, which derives team_id from the caller's captaincy and
-- NEVER from the request body. Anything added here that reads this table must
-- do the same.
--
-- Constraints are added through guarded blocks rather than inline in the
-- CREATE, for the reason 006 documents: `create table if not exists` does
-- nothing at all to a table that already exists, constraints included.

create table if not exists draft_board_entries (
  id             uuid primary key default gen_random_uuid(),

  tournament_id  uuid not null references tournaments(id) on delete cascade,
  -- No single-column FK to teams; the composite one below covers it and keeps
  -- PostgREST from having two relationships to choose between.
  team_id        uuid not null,

  -- CASCADE: if a signup is deleted outright, the boards that ranked them lose
  -- the row rather than pointing at nothing.
  signup_id      uuid not null references player_signups(id) on delete cascade,

  -- 1..5 best to worst, 6 = Avoid. See shared/board.cjs, which is where these
  -- numbers are named — this CHECK and that file have to be changed together.
  tier           smallint not null,

  -- Order INSIDE the tier, low first. Deliberately not unique: ranks are
  -- rewritten 0..n-1 whenever a tier is reordered, and a unique index would
  -- make every reorder collide midway through, exactly as team seeds do.
  rank           int not null default 0,

  -- Why this player is where they are. The thing a captain actually wants at
  -- 11pm on draft night.
  note           text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

do $$ begin
  -- A player appears once on a board. Without this, "move to Tier 2" can leave
  -- the Tier 4 row behind and the player shows up twice.
  if not exists (select 1 from pg_constraint where conname = 'draft_board_one_per_player') then
    alter table draft_board_entries
      add constraint draft_board_one_per_player unique (team_id, signup_id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'draft_board_tier_check') then
    alter table draft_board_entries
      add constraint draft_board_tier_check check (tier between 1 and 6);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'draft_board_note_len') then
    alter table draft_board_entries
      add constraint draft_board_note_len check (note is null or length(note) <= 300);
  end if;

  -- The board's team must belong to the tournament the row claims.
  if not exists (select 1 from pg_constraint where conname = 'draft_board_team_tournament') then
    alter table draft_board_entries
      add constraint draft_board_team_tournament
      foreign key (team_id, tournament_id) references teams (id, tournament_id) on delete cascade;
  end if;
end $$;

-- The read the board page does, in the order it wants them.
create index if not exists draft_board_team_idx
  on draft_board_entries (team_id, tier, rank);

drop trigger if exists draft_board_touch on draft_board_entries;
create trigger draft_board_touch
  before update on draft_board_entries
  for each row execute function touch_updated_at();

-- Check:
--   select t.name, b.tier, b.rank, s.player_name, s.role
--     from draft_board_entries b
--     join teams t on t.id = b.team_id
--     join player_signups s on s.id = b.signup_id
--    order by t.name, b.tier, b.rank;
