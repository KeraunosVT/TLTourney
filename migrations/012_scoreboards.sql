-- 012_scoreboards.sql — what happened in each match.
--
-- Run in the Supabase SQL editor AFTER 011. Safe to re-run.
--
-- One row per player per match, read off the in-game scoreboard. This is the
-- table every per-player number in the tournament is computed from.
--
-- ── THE ONE IDEA WORTH UNDERSTANDING ────────────────────────────────────────
-- A scoreboard gives a NAME. Everything downstream wants a PERSON.
--
-- The obvious design keys stats on player_name and joins by name at read time.
-- That fails quietly and constantly: OCR misreads a character, somebody plays
-- under a slightly different name, two people pick the same name across
-- servers. The profile comes back short and nothing says why — which is
-- exactly the bug Gear-Gap's playerStats.js was written to explain rather than
-- prevent.
--
-- So the name is resolved ONCE, by a human, at review time, and stored as
-- `signup_id`. Every aggregate afterwards keys off that id and cannot drift. A
-- row nobody could match keeps its name, gets a null signup_id, and is counted
-- as unmatched rather than silently attributed to the wrong person.

create table if not exists player_match_stats (
  id             uuid primary key default gen_random_uuid(),

  tournament_id  uuid not null references tournaments(id) on delete cascade,
  -- Deleting a match takes its scoreboard with it. Correct here, unlike on the
  -- bracket's own team columns: these rows describe that match and nothing else.
  match_id       uuid not null references matches(id) on delete cascade,

  -- WHO this is, once somebody has said so. Null means the review could not
  -- place them — an opponent's guild, a spectator, a name too mangled to match.
  -- ON DELETE SET NULL: if a signup is removed the statistics stay, they just
  -- stop being attributed.
  signup_id      uuid references player_signups(id) on delete set null,
  team_id        uuid,

  -- The scoreboard exactly as it was read, kept even after signup_id is set.
  -- This is the evidence: when somebody disputes a number, the answer is the
  -- row as it came off the screenshot, not a tidied version of it.
  rank           int,
  weapon_1       text,
  weapon_2       text,
  guild_name     text,
  player_name    text not null,
  team_color     text,

  kills          int    not null default 0,
  assists        int    not null default 0,
  -- bigint, not int. A single good night is a few million damage; a tournament
  -- total across a dozen matches clears int4's 2.1 billion without much
  -- trouble, and the overflow would arrive as an error in the middle of
  -- committing a scoreboard.
  damage_dealt   bigint not null default 0,
  damage_taken   bigint not null default 0,
  healing        bigint not null default 0,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'pms_team_color_valid') then
    alter table player_match_stats add constraint pms_team_color_valid
      check (team_color is null or team_color in ('Yellow', 'Red', ''));
  end if;

  -- Negative kills are a misread, not a result. Cheap to state, and it catches
  -- an OCR row that would otherwise drag a player's totals down for a season.
  if not exists (select 1 from pg_constraint where conname = 'pms_stats_not_negative') then
    alter table player_match_stats add constraint pms_stats_not_negative
      check (kills >= 0 and assists >= 0 and damage_dealt >= 0
             and damage_taken >= 0 and healing >= 0);
  end if;

  -- THE one that protects the aggregates. Without it, uploading the same
  -- scoreboard twice doubles every number on it, and the totals stay perfectly
  -- plausible while being exactly wrong.
  --
  -- On (match, signup) rather than (match, name): two rows in one match CAN
  -- share a name — that is the whole reason names are not the key — but one
  -- PERSON cannot appear twice on one scoreboard. Partial, because unmatched
  -- rows all have a null signup_id and there may be many of them.
  if not exists (select 1 from pg_indexes
                 where schemaname = 'public' and indexname = 'pms_one_row_per_player_per_match') then
    create unique index pms_one_row_per_player_per_match
      on player_match_stats (match_id, signup_id) where signup_id is not null;
  end if;
end $$;

create index if not exists pms_match_idx on player_match_stats (match_id);
create index if not exists pms_player_idx on player_match_stats (tournament_id, signup_id);

-- Case-insensitive name lookup, for the auto-match at review time.
create index if not exists pms_name_idx
  on player_match_stats (tournament_id, lower(player_name));

drop trigger if exists player_match_stats_touch on player_match_stats;
create trigger player_match_stats_touch
  before update on player_match_stats
  for each row execute function touch_updated_at();

-- ── Was a scoreboard entered? ───────────────────────────────────────────────
-- On `matches`, so the bracket can show which results still need one without
-- counting rows in another table for every match on screen.
alter table matches
  add column if not exists scoreboard_at timestamptz;

comment on column matches.scoreboard_at is
  'When a scoreboard was last committed for this match. Null = result recorded but no stats yet.';

-- Check — coverage, and who is still unmatched:
--   select m.key, m.scoreboard_at is not null as has_stats, count(s.id) as rows,
--          count(*) filter (where s.signup_id is null) as unmatched
--     from matches m left join player_match_stats s on s.match_id = m.id
--    group by m.key, m.scoreboard_at order by m.key;
