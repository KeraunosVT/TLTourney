-- 010_draft.sql — the live snake draft.
--
-- Run in the Supabase SQL editor AFTER 009. Safe to re-run.
--
-- Two tables. `drafts` is the state of the one draft a tournament has — where
-- the clock is, whose turn it is, how long a pick gets. `draft_picks` is the
-- record of what happened, one row per pick, and it is also the CONCURRENCY
-- CONTROL for the whole thing.
--
-- There is deliberately no make_pick() stored procedure, which is what the
-- original plan called for. The race it was meant to prevent — two people
-- claiming the same pick at the same instant — is already prevented by
-- draft_picks_number_unique below, because only one row can ever be pick #14.
-- A function would add a second place for the pick rules to live, in a language
-- with no tests around it, to solve a problem a unique index already solves.

-- ── The draft's state ───────────────────────────────────────────────────────
-- One row per tournament, hence the primary key on tournament_id: a tournament
-- has exactly one draft, and "which draft" is never a question anybody has to
-- answer.
create table if not exists drafts (
  tournament_id  uuid primary key references tournaments(id) on delete cascade,

  status         text not null default 'pending',

  -- The soft clock. Seconds a captain gets before the pick is made for them.
  pick_seconds   int not null default 120,

  -- 1-based, and it counts PAST the end: when the last pick is made this
  -- becomes total+1 and status becomes 'complete'. Storing "the next pick to be
  -- made" rather than "the last one made" means the on-the-clock lookup is the
  -- same arithmetic at the start of the draft as in the middle of it.
  current_pick   int not null default 1,

  -- THE clock, and it lives here rather than in a setTimeout. A redeploy in the
  -- middle of draft night loses every timer in the process; it does not lose a
  -- row. The server re-arms from this on the next request that reads the draft.
  pick_deadline  timestamptz,

  -- Team ids in seed order, frozen when the draft starts. Snapshotted rather
  -- than read live from teams.seed, because an organizer fixing a seed typo in
  -- round 9 must not silently rewrite whose turn it has been for nine rounds.
  order_snapshot jsonb not null default '[]'::jsonb,

  -- Rounds this draft will run — roster_size minus the players already on each
  -- roster when it started. Frozen for the same reason as the order.
  rounds         int not null default 0,

  -- Why the draft stopped, when it stopped itself. See the stall guard in
  -- backend/draft.js: a deadline that expired long ago means nobody was
  -- watching, and firing thirty auto-picks into an empty room is worse than
  -- stopping and saying so.
  paused_reason  text,

  started_at     timestamptz,
  completed_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'drafts_status_valid') then
    alter table drafts add constraint drafts_status_valid
      check (status in ('pending', 'live', 'paused', 'complete'));
  end if;

  -- The floor is 15s, not 1s: below that the clock expires while the page is
  -- still loading and every pick is an auto-pick. The ceiling is 30 minutes,
  -- which is already a long enough stall to want the pause button instead.
  if not exists (select 1 from pg_constraint where conname = 'drafts_pick_seconds_range') then
    alter table drafts add constraint drafts_pick_seconds_range
      check (pick_seconds between 15 and 1800);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'drafts_current_pick_positive') then
    alter table drafts add constraint drafts_current_pick_positive
      check (current_pick >= 1);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'drafts_rounds_positive') then
    alter table drafts add constraint drafts_rounds_positive
      check (rounds >= 0);
  end if;
end $$;

drop trigger if exists drafts_touch on drafts;
create trigger drafts_touch
  before update on drafts
  for each row execute function touch_updated_at();

-- ── The picks ───────────────────────────────────────────────────────────────
create table if not exists draft_picks (
  id             uuid primary key default gen_random_uuid(),

  tournament_id  uuid not null references tournaments(id) on delete cascade,
  team_id        uuid not null,
  signup_id      uuid not null references player_signups(id) on delete cascade,

  pick_number    int not null,
  round          int not null,

  -- True when the clock made it, not a person. Worth recording: an auto-pick is
  -- the one a captain will want to argue about afterwards, and "the site picked
  -- for you at 11:04pm because your clock ran out" is a better answer than a
  -- pick that looks identical to one they made.
  auto           boolean not null default false,
  made_by        text,

  -- The board entries this pick deleted, kept so an undo can put them back.
  -- Drafting a player removes them from every captain's board (see addToRoster)
  -- — which is correct, and irreversible unless the rows are kept somewhere.
  -- Undo happens exactly when something went wrong on stream, and it should not
  -- cost four other captains their ranking of that player.
  -- Shape: [{ team_id, tier, rank, note }]
  cleared_entries jsonb not null default '[]'::jsonb,

  created_at     timestamptz not null default now()
);

do $$ begin
  -- THE MUTEX. Only one row can be pick #14 of this tournament, so two captains
  -- clicking at the same instant produce one pick and one 409 — not two picks,
  -- and not a pick that quietly overwrites another.
  if not exists (select 1 from pg_constraint where conname = 'draft_picks_number_unique') then
    alter table draft_picks add constraint draft_picks_number_unique
      unique (tournament_id, pick_number);
  end if;

  -- The backstop for team_players_one_team_per_person. Both are needed: this
  -- one refuses a second PICK of the same player, that one refuses a second
  -- ROSTER row, and a pick is written before the roster row it produces.
  if not exists (select 1 from pg_constraint where conname = 'draft_picks_player_once') then
    alter table draft_picks add constraint draft_picks_player_once
      unique (tournament_id, signup_id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'draft_picks_team_tournament') then
    alter table draft_picks add constraint draft_picks_team_tournament
      foreign key (team_id, tournament_id) references teams (id, tournament_id) on delete cascade;
  end if;
end $$;

-- "What just happened" is the most-read query on draft night — the ticker on
-- the stream view asks for it every couple of seconds.
create index if not exists draft_picks_recent_idx
  on draft_picks (tournament_id, pick_number desc);

-- ── Give the running tournament a draft row ─────────────────────────────────
-- Idempotent. The backend creates one on demand too, so this is only here to
-- make the row visible in the table editor before the first request.
insert into drafts (tournament_id)
select id from tournaments where status <> 'complete'
on conflict (tournament_id) do nothing;

-- Check — the draft's state and the picks so far:
--   select status, current_pick, rounds, pick_seconds, pick_deadline,
--          jsonb_array_length(order_snapshot) as teams
--     from drafts;
--
--   select p.pick_number, p.round, t.name as team, s.player_name, p.auto
--     from draft_picks p
--     join teams t on t.id = p.team_id
--     join player_signups s on s.id = p.signup_id
--    order by p.pick_number;
