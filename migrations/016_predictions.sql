-- 016_predictions.sql — viewers and players pick the winners.
--
-- Run in the Supabase SQL editor AFTER 015. Safe to re-run.
--
-- Two tables, because they lock at different times and are answers to different
-- questions: one pick per person per MATCH, and one pick per person per
-- TOURNAMENT for the champion. Folding them together would mean a nullable
-- match_id and a `kind` column, and then a unique index that has to be two
-- partial indexes to say the one thing it needs to say.
--
-- IDENTITY IS THE DISCORD ID, not a signup. Predictions are open to anyone who
-- logs in — viewers included — and most of them will never have signed up to
-- play. There is no users table in this app; the session is the record of who
-- somebody is, so the id off the session is what a pick is keyed on.
--
-- display_name is a SNAPSHOT, rewritten on every save. Discord names change and
-- there is no local user row to join to, so the alternative is a leaderboard
-- calling people by a name they abandoned months ago. The app takes the newest
-- one it has seen.

create table if not exists predictions (
  id             uuid primary key default gen_random_uuid(),

  tournament_id  uuid not null references tournaments(id) on delete cascade,
  match_id       uuid not null references matches(id) on delete cascade,

  discord_id     text not null,
  display_name   text not null,

  -- Who they think wins. A real foreign key, unlike matches.team_a_id: that
  -- column is history and must survive a team being removed, while a prediction
  -- for a team that no longer exists is not a result anybody needs to keep.
  team_id        uuid not null references teams(id) on delete cascade,

  -- How many games the LOSING side takes. 0 or 1 in a best of three — the 2-0
  -- versus 2-1 choice on screen — and 0, 1 or 2 in a best of five.
  --
  -- Stored from the loser's side because that is the only part of a scoreline
  -- that varies: the winner always reaches best_of/2 + 1, so recording both
  -- numbers would be recording one fact twice and inviting them to disagree.
  loser_games    int not null,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

do $$ begin
  -- ONE PICK PER PERSON PER MATCH. This is the whole integrity of the game:
  -- without it, changing a pick inserts a second row and the standings count
  -- both, so anybody who changed their mind scores twice.
  if not exists (select 1 from pg_constraint where conname = 'predictions_one_per_match') then
    alter table predictions add constraint predictions_one_per_match
      unique (match_id, discord_id);
  end if;

  -- A generous ceiling rather than a tight one. The exact bound depends on the
  -- match's best_of, which lives on another table and cannot be reached from a
  -- CHECK; the app validates against it. This is here to catch a number that is
  -- nonsense by any reading.
  if not exists (select 1 from pg_constraint where conname = 'predictions_loser_games_range') then
    alter table predictions add constraint predictions_loser_games_range
      check (loser_games >= 0 and loser_games <= 4);
  end if;
end $$;

-- The two reads the app makes: everybody's picks on one match (the crowd
-- split), and one person's picks across the tournament (their card).
create index if not exists predictions_match_idx on predictions (match_id);
create index if not exists predictions_person_idx on predictions (tournament_id, discord_id);

drop trigger if exists predictions_touch on predictions;
create trigger predictions_touch
  before update on predictions
  for each row execute function touch_updated_at();

-- ── The champion pick ───────────────────────────────────────────────────────
-- One per person per tournament, made before the first game is played and
-- worth more than a single match. Its own table because its lock is the
-- tournament's first game, not any one match's kickoff.
create table if not exists champion_picks (
  id             uuid primary key default gen_random_uuid(),

  tournament_id  uuid not null references tournaments(id) on delete cascade,
  discord_id     text not null,
  display_name   text not null,
  team_id        uuid not null references teams(id) on delete cascade,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'champion_picks_one_per_person') then
    alter table champion_picks add constraint champion_picks_one_per_person
      unique (tournament_id, discord_id);
  end if;
end $$;

create index if not exists champion_picks_tournament_idx on champion_picks (tournament_id);

drop trigger if exists champion_picks_touch on champion_picks;
create trigger champion_picks_touch
  before update on champion_picks
  for each row execute function touch_updated_at();

-- Check — how the room is split on each match that has been picked:
--   select m.key, t.name, count(*)
--     from predictions p
--     join matches m on m.id = p.match_id
--     join teams t on t.id = p.team_id
--    group by m.key, t.name
--    order by m.key, count(*) desc;
--
-- Check — a pick made after its match started would be a hole in the lock:
--   select p.discord_id, m.key, p.created_at, m.scheduled_at
--     from predictions p join matches m on m.id = p.match_id
--    where m.scheduled_at is not null and p.updated_at > m.scheduled_at;
