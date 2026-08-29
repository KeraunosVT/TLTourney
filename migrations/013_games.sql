-- 013_games.sql — a match is a series of games.
--
-- Run in the Supabase SQL editor AFTER 012. Safe to re-run.
--
-- Until now a bracket match had one winner and one scoreboard. It is best of
-- three, which means up to three games, each on its own map, each producing its
-- own scoreboard — and the match's winner is whoever wins two of them.
--
-- This is not a cosmetic addition. `player_match_stats` had a unique index on
-- (match_id, signup_id), so a second game's rows would have been REFUSED by the
-- database rather than double-counted. That constraint was doing its job: it
-- forced this table to exist rather than letting three games silently pile into
-- one scoreboard.

create table if not exists match_games (
  id             uuid primary key default gen_random_uuid(),

  tournament_id  uuid not null references tournaments(id) on delete cascade,
  match_id       uuid not null references matches(id) on delete cascade,

  -- 1, 2, 3. Not "game 1 of 3" — how many are played depends on who wins.
  game_number    int not null,

  -- Free text on purpose. The map pool changes between seasons and a fixed
  -- list in a migration is a list that goes stale in a schema. The form offers
  -- whatever has already been used in this tournament as suggestions, so it
  -- converges on consistent spelling without ever refusing a new name.
  map            text,

  winner_team_id uuid,

  -- When this game's scoreboard was committed. Matches the column 012 put on
  -- `matches`, which now means "the series has a scoreboard somewhere" and is
  -- kept in step by the backend.
  scoreboard_at  timestamptz,

  decided_at     timestamptz,
  decided_by     text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

do $$ begin
  -- A game number belongs to one game. Without this, recording game 2 twice
  -- produces two game 2s and the series count is silently wrong.
  if not exists (select 1 from pg_constraint where conname = 'match_games_number_unique') then
    alter table match_games add constraint match_games_number_unique
      unique (match_id, game_number);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'match_games_number_range') then
    alter table match_games add constraint match_games_number_range
      check (game_number between 1 and 9);
  end if;
end $$;

create index if not exists match_games_match_idx on match_games (match_id, game_number);

drop trigger if exists match_games_touch on match_games;
create trigger match_games_touch
  before update on match_games
  for each row execute function touch_updated_at();

-- ── How long a series is ────────────────────────────────────────────────────
-- On the match, not the tournament, so a grand final can be best of five while
-- the rounds before it are best of three.
alter table matches
  add column if not exists best_of int not null default 3;

do $$ begin
  -- ODD ONLY. An even series can be drawn, and a bracket has no way to record
  -- a draw or advance one — the match would simply never resolve.
  if not exists (select 1 from pg_constraint where conname = 'matches_best_of_odd') then
    alter table matches add constraint matches_best_of_odd
      check (best_of >= 1 and best_of <= 9 and best_of % 2 = 1);
  end if;
end $$;

-- ── Scoreboards belong to a game ────────────────────────────────────────────
alter table player_match_stats
  add column if not exists game_id uuid references match_games(id) on delete cascade;

-- The old index refused a second scoreboard for the same match, which is
-- exactly what a best-of-three needs. Replaced by the same rule one level down:
-- one row per player per GAME.
drop index if exists pms_one_row_per_player_per_match;

create unique index if not exists pms_one_row_per_player_per_game
  on player_match_stats (game_id, signup_id) where signup_id is not null and game_id is not null;

create index if not exists pms_game_idx on player_match_stats (game_id);

-- match_id stays alongside game_id. It is denormalised and it earns it: every
-- per-player query asks "which matches did they play", and walking back through
-- match_games to answer that would be a join on every leaderboard read.

-- ── Existing matches get a game 1 ───────────────────────────────────────────
-- Anything already decided keeps its result, as a one-game series, so a bracket
-- part-way through does not lose what has been played. Idempotent.
insert into match_games (tournament_id, match_id, game_number, winner_team_id, decided_at, decided_by)
select m.tournament_id, m.id, 1, m.winner_team_id, m.decided_at, m.decided_by
  from matches m
 where m.winner_team_id is not null
on conflict (match_id, game_number) do nothing;

update player_match_stats s
   set game_id = g.id
  from match_games g
 where g.match_id = s.match_id and g.game_number = 1 and s.game_id is null;

-- Check — the series so far:
--   select m.key, m.best_of, g.game_number, g.map, t.name as won_by
--     from matches m
--     left join match_games g on g.match_id = m.id
--     left join teams t on t.id = g.winner_team_id
--    order by m.bracket, m.round, m.idx, g.game_number;
