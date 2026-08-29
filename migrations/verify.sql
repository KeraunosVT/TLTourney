-- verify.sql — "is this database where the repo thinks it is?"
--
-- Paste into the Supabase SQL editor and run. Every row should say `ok`.
-- Anything reading false means that migration didn't take, in whole or part.
--
-- Safe to run any number of times: it only reads catalog tables and changes
-- nothing. Not a migration — it has no number and never needs applying.
--
-- Add a row here whenever a migration adds a table, column, function or
-- constraint, so this stays the single answer to "did that one land?".

select '001 · tournaments table' as item,
       to_regclass('public.tournaments') is not null as ok
union all
select '001 · player_signups table',
       to_regclass('public.player_signups') is not null
union all
select '001 · audit_log table',
       to_regclass('public.audit_log') is not null
union all
-- The constraint that stops one person filing two signups. Everything else in
-- the signup flow degrades visibly; a duplicate here does not — it just puts
-- the same player on the draft board twice.
select '001 · one signup per person per tournament',
       exists (select 1 from pg_constraint
               where conname = 'player_signups_one_per_person')
union all
select '001 · between 1 and 3 classes',
       exists (select 1 from pg_constraint
               where conname = 'player_signups_class_count')
union all
select '001 · classes column is a text array',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'player_signups'
                 and column_name = 'classes' and data_type = 'ARRAY')
union all
-- Gear level was removed. If this column is still here the old migration ran
-- and the table needs recreating, which the app will not tell you — it just
-- writes rows without it.
select '001 · gear_level is GONE',
       not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'player_signups'
                     and column_name = 'gear_level')
union all
select '001 · updated_at trigger',
       exists (select 1 from pg_trigger
               where tgname = 'player_signups_touch' and not tgisinternal)
union all
select '001 · at least one tournament exists',
       (select count(*) from tournaments) >= 1
union all
-- ── 002 ────────────────────────────────────────────────────────────────────
select '002 · role column',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'player_signups'
                 and column_name = 'role')
union all
select '002 · role is constrained to Tank/DPS/Healer',
       exists (select 1 from pg_constraint where conname = 'player_signups_role_valid')
union all
select '002 · positions column is a text array',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'player_signups'
                 and column_name = 'positions' and data_type = 'ARRAY')
union all
select '002 · positions count is capped',
       exists (select 1 from pg_constraint where conname = 'player_signups_positions_count')
union all
select '002 · positions gin index',
       exists (select 1 from pg_indexes
               where schemaname = 'public' and indexname = 'player_signups_positions_idx')
union all
-- ── 003 ────────────────────────────────────────────────────────────────────
select '003 · roster_size is GENERATED, not editable',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'tournaments'
                 and column_name = 'roster_size' and is_generated = 'ALWAYS')
union all
select '003 · roster is 8 x 6 + 12 = 60',
       (select party_count = 8 and party_size = 6 and sub_count = 12 and roster_size = 60
          from tournaments order by created_at limit 1)
union all
-- ── 004 ────────────────────────────────────────────────────────────────────
select '004 · teams table',
       to_regclass('public.teams') is not null
union all
-- 004's captain index guarded teams.captain_id, and 006 drops both. Asserted
-- GONE rather than deleted, so a database still carrying it — 006 half-applied,
-- or never run — reads false here instead of looking finished.
-- The rule itself lives on as `006 · one person cannot captain two teams`.
select '004 · captain index is GONE (superseded by 006)',
       not exists (select 1 from pg_indexes
                   where schemaname = 'public' and indexname = 'teams_captain_unique')
union all
select '004 · seeds are unique where set',
       exists (select 1 from pg_indexes
               where schemaname = 'public' and indexname = 'teams_seed_unique')
union all
-- ── 005 ────────────────────────────────────────────────────────────────────
-- The one most likely to be half-applied: 004's earlier draft created this
-- column as text[], and `add column if not exists` would not have replaced it.
-- jsonb here is the pass; ARRAY means 005 has not run.
select '005 · party_template is jsonb (NOT text[])',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'tournaments'
                 and column_name = 'party_template' and data_type = 'jsonb')
union all
select '005 · template describes 8 parties',
       (select jsonb_array_length(party_template) = 8 from tournaments order by created_at limit 1)
union all
select '005 · template has 48 starting slots',
       (select (select sum(jsonb_array_length(p->'slots'))
                  from jsonb_array_elements(party_template) p) = 48
          from tournaments order by created_at limit 1)
union all
-- Healer, not Support — the signup form stores Healer, and a slot the form can
-- never satisfy is a slot that silently stays empty forever.
select '005 · template says Healer, not Support',
       (select party_template::text not like '%Support%' from tournaments order by created_at limit 1)
union all
-- ── 006 ────────────────────────────────────────────────────────────────────
select '006 · team_captains table',
       to_regclass('public.team_captains') is not null
union all
-- The half-applied state to watch for: the table created but the old column
-- still there. Two places to read a captain from is worse than one of either,
-- because the app reads the new one and an organizer might edit the old.
select '006 · teams.captain_id is GONE (captains are rows now)',
       not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'teams'
                     and column_name = 'captain_id')
union all
select '006 · a team has at most two captain seats',
       exists (select 1 from pg_constraint where conname = 'team_captains_seat_unique')
union all
select '006 · seat is constrained to 1 or 2',
       exists (select 1 from pg_constraint where conname = 'team_captains_seat_check')
union all
select '006 · one person cannot captain two teams',
       exists (select 1 from pg_indexes
               where schemaname = 'public' and indexname = 'team_captains_one_team_per_person')
union all
-- Without this the denormalised tournament_id can drift from the team's, and
-- the one-team-per-person index above starts guarding the wrong thing.
select '006 · captain rows are pinned to their team''s tournament',
       exists (select 1 from pg_constraint where conname = 'team_captains_team_tournament')
union all
-- ── 007 ────────────────────────────────────────────────────────────────────
select '007 · draft_board_entries table',
       to_regclass('public.draft_board_entries') is not null
union all
-- Without this, moving a player between tiers can leave the old row behind and
-- the same person appears twice on one board, in two different tiers.
select '007 · a player appears once per board',
       exists (select 1 from pg_constraint where conname = 'draft_board_one_per_player')
union all
select '007 · tier is constrained to 1..6',
       exists (select 1 from pg_constraint where conname = 'draft_board_tier_check')
union all
select '007 · board rows are pinned to their team''s tournament',
       exists (select 1 from pg_constraint where conname = 'draft_board_team_tournament')
union all
select '007 · board updated_at trigger',
       exists (select 1 from pg_trigger where tgname = 'draft_board_touch' and not tgisinternal)
union all
-- Ranks are rewritten 0..n-1 on every reorder, so a unique index here would
-- make each reorder collide partway through. Asserted ABSENT on purpose.
select '007 · rank is NOT unique (reorders rewrite it)',
       not exists (select 1 from pg_indexes
                   where schemaname = 'public'
                     and indexname like '%draft_board%rank%unique%')
union all
-- ── 008 ────────────────────────────────────────────────────────────────────
select '008 · team_players table',
       to_regclass('public.team_players') is not null
union all
-- The one that makes "not available to draft" true rather than merely filtered
-- in the UI. Without it two teams can hold the same player.
select '008 · one person plays for one team',
       exists (select 1 from pg_indexes
               where schemaname = 'public' and indexname = 'team_players_one_team_per_person')
union all
select '008 · via is constrained to captain/draft/manual',
       exists (select 1 from pg_constraint where conname = 'team_players_via_valid')
union all
select '008 · roster rows are pinned to their team''s tournament',
       exists (select 1 from pg_constraint where conname = 'team_players_team_tournament')
union all
-- A seated captain who is not on their own roster would still be offered to
-- every other captain as an available player. This is that check.
select '008 · every seated captain is on their team''s roster',
       not exists (
         select 1 from team_captains tc
          where not exists (
            select 1 from team_players tp
             where tp.team_id = tc.team_id and tp.signup_id = tc.signup_id))
union all
-- ── 009 ────────────────────────────────────────────────────────────────────
select '009 · wants_shotcall column',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'player_signups'
                 and column_name = 'wants_shotcall')
union all
-- NULLABLE is the point. `not null default false` would have written "won't
-- shotcall" onto every signup filed before the question existed — a wrong
-- answer that reads exactly like a given one.
select '009 · wants_shotcall is NULLABLE (null = never asked)',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'player_signups'
                 and column_name = 'wants_shotcall' and is_nullable = 'YES')
union all
select '009 · wants_shotcall has NO default',
       (select column_default is null from information_schema.columns
         where table_schema = 'public' and table_name = 'player_signups'
           and column_name = 'wants_shotcall')
union all
-- ── 010 ────────────────────────────────────────────────────────────────────
select '010 · drafts table',
       to_regclass('public.drafts') is not null
union all
select '010 · draft_picks table',
       to_regclass('public.draft_picks') is not null
union all
-- THE one that makes a live draft safe. Without it, two captains clicking at
-- the same instant both get a pick #14 and the draft silently skips a turn.
select '010 · a pick number can only be claimed once',
       exists (select 1 from pg_constraint where conname = 'draft_picks_number_unique')
union all
select '010 · a player can only be drafted once',
       exists (select 1 from pg_constraint where conname = 'draft_picks_player_once')
union all
select '010 · picks are pinned to their team''s tournament',
       exists (select 1 from pg_constraint where conname = 'draft_picks_team_tournament')
union all
select '010 · draft status is constrained',
       exists (select 1 from pg_constraint where conname = 'drafts_status_valid')
union all
-- Below 15s the clock expires while the page is still loading and every pick
-- becomes an auto-pick.
select '010 · the pick clock has a floor and a ceiling',
       exists (select 1 from pg_constraint where conname = 'drafts_pick_seconds_range')
union all
select '010 · the running tournament has a draft row',
       exists (select 1 from drafts d
               join tournaments t on t.id = d.tournament_id
              where t.status <> 'complete')
union all
-- Undo restores the board entries a pick deleted, and this column is the only
-- place their tier and rank still exist once the pick is made.
select '010 · picks remember the board entries they cleared',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'draft_picks'
                 and column_name = 'cleared_entries' and data_type = 'jsonb')
union all
-- Every pick must have put somebody on a roster. A pick with no roster row is a
-- turn the draft stepped over, and nothing else in the app would report it.
select '010 · every pick has a matching roster row',
       not exists (
         select 1 from draft_picks p
          where not exists (
            select 1 from team_players tp
             where tp.team_id = p.team_id and tp.signup_id = p.signup_id))
union all
-- The pick numbers must be 1..n with no holes. A gap means an undo went half
-- way, and the draft would hand the clock to the wrong team for the rest of the
-- night.
select '010 · pick numbers have no gaps',
       (select coalesce(max(pick_number), 0) = count(*) from draft_picks)
union all
-- ── 011 ────────────────────────────────────────────────────────────────────
select '011 · matches table',
       to_regclass('public.matches') is not null
union all
-- The key IS a match's identity within a tournament. Without this, generating
-- twice silently doubles every round instead of failing.
select '011 · a match key appears once per tournament',
       exists (select 1 from pg_constraint where conname = 'matches_key_unique')
union all
select '011 · bracket is constrained to W/L/GF',
       exists (select 1 from pg_constraint where conname = 'matches_bracket_valid')
union all
select '011 · kind is constrained to match/walkover/void',
       exists (select 1 from pg_constraint where conname = 'matches_kind_valid')
union all
-- A half-applied result would otherwise leave a match reading as finished with
-- nobody having won it — the bracket advances nothing while looking done.
select '011 · a complete match has a winner, and only a complete one does',
       exists (select 1 from pg_constraint where conname = 'matches_winner_iff_complete')
union all
select '011 · a team cannot play itself',
       exists (select 1 from pg_constraint where conname = 'matches_two_sides')
union all
select '011 · slot sources are jsonb',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'matches'
                 and column_name = 'slot_a' and data_type = 'jsonb')
union all
select '011 · matches updated_at trigger',
       exists (select 1 from pg_trigger where tgname = 'matches_touch' and not tgisinternal)
union all
-- Double elimination arithmetic: everybody but the champion loses twice, and
-- every real match produces exactly one loss. A bracket that does not satisfy
-- this was drawn wrong, and it will still run to completion and crown somebody.
select '011 · the drawn bracket has exactly 2n-2 real matches',
       (select count(*) filter (where kind = 'match' and not is_reset)
             = greatest(0, 2 * (select count(*) from teams
                                 where tournament_id = m.tournament_id and seed is not null) - 2)
          from matches m group by m.tournament_id limit 1)
       is not false
union all
-- A winner who was never in the match is the shape of a bad advance.
select '011 · every recorded winner actually played that match',
       not exists (select 1 from matches
                   where winner_team_id is not null
                     and winner_team_id not in (coalesce(team_a_id, winner_team_id),
                                                coalesce(team_b_id, winner_team_id)))
union all
-- ── 012 ────────────────────────────────────────────────────────────────────
select '012 · player_match_stats table',
       to_regclass('public.player_match_stats') is not null
union all
-- THE one that protects every number in the tournament. Without it, uploading
-- the same scoreboard twice doubles everybody's totals — and the totals stay
-- entirely plausible while being exactly wrong.
select '012 · one row per player per match',
       exists (select 1 from pg_indexes
               where schemaname = 'public' and indexname = 'pms_one_row_per_player_per_match')
union all
select '012 · stats cannot be negative',
       exists (select 1 from pg_constraint where conname = 'pms_stats_not_negative')
union all
-- A tournament's damage totals clear int4's 2.1 billion without much trouble,
-- and the overflow would arrive mid-commit.
select '012 · damage and healing are bigint, not int',
       (select count(*) = 3 from information_schema.columns
         where table_schema = 'public' and table_name = 'player_match_stats'
           and column_name in ('damage_dealt', 'damage_taken', 'healing')
           and data_type = 'bigint')
union all
select '012 · matches.scoreboard_at column',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'matches'
                 and column_name = 'scoreboard_at')
union all
-- Statistics are attributed by id, never by name. A row pointing at a signup
-- from another tournament would put somebody else's night on a profile.
select '012 · every attributed row points at a real signup',
       not exists (select 1 from player_match_stats s
                   where s.signup_id is not null
                     and not exists (select 1 from player_signups p
                                      where p.id = s.signup_id
                                        and p.tournament_id = s.tournament_id))
union all
select '012 · a match marked as having a scoreboard has one',
       not exists (select 1 from matches m
                   where m.scoreboard_at is not null
                     and not exists (select 1 from player_match_stats s where s.match_id = m.id))
union all
-- ── 013 ────────────────────────────────────────────────────────────────────
select '013 · match_games table',
       to_regclass('public.match_games') is not null
union all
select '013 · a game number belongs to one game',
       exists (select 1 from pg_constraint where conname = 'match_games_number_unique')
union all
select '013 · matches.best_of column',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'matches'
                 and column_name = 'best_of')
union all
-- An even series can end level, and a bracket has no way to record a draw or
-- advance one — the match would simply never resolve.
select '013 · best_of must be ODD',
       exists (select 1 from pg_constraint where conname = 'matches_best_of_odd')
union all
select '013 · scoreboards hang off a game',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'player_match_stats'
                 and column_name = 'game_id')
union all
-- The old index was per MATCH, which refused game 2's rows outright. Asserted
-- GONE: a database still carrying it cannot store a best-of-three.
select '013 · the per-match scoreboard index is GONE (superseded)',
       not exists (select 1 from pg_indexes
                   where schemaname = 'public' and indexname = 'pms_one_row_per_player_per_match')
union all
select '013 · one row per player per GAME',
       exists (select 1 from pg_indexes
               where schemaname = 'public' and indexname = 'pms_one_row_per_player_per_game')
union all
-- A decided match must agree with its own games, or the bracket says one thing
-- and the scoresheet under it says another.
select '013 · every decided match won its series',
       not exists (
         select 1 from matches m
          where m.winner_team_id is not null
            and (select count(*) from match_games g
                  where g.match_id = m.id and g.winner_team_id = m.winner_team_id)
                < (m.best_of / 2) + 1)
union all
-- ── 014 ────────────────────────────────────────────────────────────────────
select '014 · matches.ban_a and ban_b',
       (select count(*) = 2 from information_schema.columns
         where table_schema = 'public' and table_name = 'matches'
           and column_name in ('ban_a', 'ban_b'))
union all
-- Both teams banning the same map wastes a ban and leaves ten in play when the
-- rules say nine.
select '014 · the two bans must differ',
       exists (select 1 from pg_constraint where conname = 'matches_bans_differ')
union all
-- A ban entered after a game was played can strand it on a map that is now
-- banned. The app reports it; this is how you find any that were left.
select '014 · no game is played on a banned map',
       not exists (select 1 from match_games g
                   join matches m on m.id = g.match_id
                   where g.map is not null and g.map in (m.ban_a, m.ban_b));
