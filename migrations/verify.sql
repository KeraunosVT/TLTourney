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
--
-- ── ONE RULE FOR NEW ROWS, and it is not obvious ────────────────────────────
-- A check that names a column DIRECTLY fails at PARSE time when that column is
-- missing, and a parse error aborts the WHOLE sweep — so the one situation
-- this file exists for, a half-applied database, is the one where it returns
-- nothing at all instead of a list of what is missing. It reported
-- `column "streams" does not exist` and not one of the other 111 rows.
--
-- So a check that reads DATA out of a column added by a migration is written
-- in two parts:
--
--   select 'NNN · the thing',
--          exists (select 1 from information_schema.columns
--                  where table_schema = 'public' and table_name = 'x'
--                    and column_name = 'y')
--          and not exists (select 1 from x t where to_jsonb(t)->>'y' ...)
--
-- `to_jsonb(t)->>'y'` parses whether or not the column exists (it is a lookup
-- in a jsonb value, not a column reference) and comes back NULL when it does
-- not, and the guard in front turns that into a plain `false` rather than a
-- vacuous `true`. Checks that only read the CATALOG — information_schema,
-- pg_constraint, pg_indexes, to_regclass — need none of this and stay as they
-- are.
--
-- A missing TABLE has no such workaround: nothing lets you name a table that
-- is not there. Those checks live at the bottom of the file as queries to run
-- by hand once the migration is applied.

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
-- 003 set this to 12 subs / 60. 018 raised it to 18 / 66, so the numbers are
-- asserted there instead — the generated-column rule above is what 003 is
-- actually responsible for, and it is unchanged.
-- ── 018 ────────────────────────────────────────────────────────────────────
select '018 · new seasons default to 18 subs',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'tournaments'
                 and column_name = 'sub_count' and column_default = '18')
union all
-- The RUNNING season, matched the way currentTournament matches it: oldest
-- unfinished. Deliberately not `order by created_at limit 1` over the whole
-- table, which is what this line used to be — once a season is archived that
-- picks the archived one, which 018 correctly leaves on 12, and this would
-- read false on a database that is entirely correct.
select '018 · the running season is 8 x 6 + 18 = 66',
       (select party_count = 8 and party_size = 6 and sub_count = 18 and roster_size = 66
          from tournaments where status <> 'complete' order by created_at limit 1)
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
-- ON THE PLAYER, NOT ON THE PAIR. This matched (team_id, signup_id) until 033,
-- which was the same thing while the only way onto a roster was being picked
-- for it. A TRADE moves team_players.team_id and deliberately leaves
-- draft_picks alone — the pick is the record of a captain choosing somebody at
-- that moment, which a later trade does not unhappen — so the pair stops
-- matching for every traded player and this row went red on a database where
-- nothing was wrong.
--
-- What it is actually for is narrower and still checked: a pick with NO roster
-- row anywhere is a player who is on the record as drafted and on nobody's
-- roster — still in the pool, and draftable a second time by another team.
-- That is what reconcile() repairs, and it keys on the signup alone too.
--
-- The team mismatch a trade creates is checked below, under 033, where an
-- UNEXPLAINED one is still caught.
select '010 · every pick has a matching roster row',
       not exists (
         select 1 from draft_picks p
          where not exists (
            select 1 from team_players tp
             where tp.signup_id = p.signup_id
               and tp.tournament_id = p.tournament_id))
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
--
-- SUPERSEDED BY 013, which is why this line does not simply check that 012's
-- index is there. A match became a series of GAMES, so the rule moved one level
-- down — pms_one_row_per_player_per_game — and 013 dropped this one, because
-- refusing a second scoreboard per match is exactly wrong for a best of three.
--
-- This line used to assert the old index still existed, and 013's line below
-- asserts it is gone. The two contradicted each other, so the sheet reported a
-- failure on every correctly migrated database from 013 onward. It now checks
-- what actually has to be true: the old rule is gone AND the rule that replaced
-- it is in place. Written as one line rather than deleted, the way 004's
-- captain index is, so that reading the sheet in order does not leave anybody
-- thinking the protection was quietly abandoned.
select '012 · the per-match scoreboard rule was replaced by 013''s per-game one',
       not exists (select 1 from pg_indexes
                   where schemaname = 'public' and indexname = 'pms_one_row_per_player_per_match')
       and exists (select 1 from pg_indexes
                   where schemaname = 'public' and indexname = 'pms_one_row_per_player_per_game')
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
-- ── 014 + 015 ──────────────────────────────────────────────────────────────
-- 014's single ban per side became a list per side in 015, and 015 drops the
-- old columns. Both halves are checked: the new shape is there AND the old one
-- is gone, because two columns describing one fact is how they come to disagree.
select '015 · matches.bans_a and bans_b',
       (select count(*) = 2 from information_schema.columns
         where table_schema = 'public' and table_name = 'matches'
           and column_name in ('bans_a', 'bans_b')
           and data_type = 'ARRAY')
union all
select '015 · 014''s single-ban columns are gone',
       not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'matches'
                      and column_name in ('ban_a', 'ban_b'))
union all
-- At most four across the match, and no map banned by both sides — which wastes
-- a ban and leaves the pool one bigger than the rules say.
select '015 · the ban count and overlap are constrained',
       exists (select 1 from pg_constraint where conname = 'matches_bans_sane')
union all
-- A ban entered after a game was played can strand it on a map that is now
-- banned. The app reports it; this is how you find any that were left.
select '015 · no game is played on a banned map',
       not exists (select 1 from match_games g
                   join matches m on m.id = g.match_id
                   where g.map is not null
                     and g.map = any (m.bans_a || m.bans_b))
union all
-- The rules say two to four. Nothing enforces the floor on the way in — a match
-- part way through its bans has one — so a match that is COMPLETE with fewer
-- than two is the case worth finding after the fact.
select '015 · every played match banned at least two',
       not exists (select 1 from matches m
                   where m.status = 'complete' and m.kind = 'match'
                     and cardinality(m.bans_a) + cardinality(m.bans_b) < 2)
union all
-- ── 016 ────────────────────────────────────────────────────────────────────
select '016 · predictions and champion_picks exist',
       (select count(*) = 2 from information_schema.tables
         where table_schema = 'public'
           and table_name in ('predictions', 'champion_picks'))
union all
-- The integrity of the whole game. Without it, changing a pick inserts a second
-- row and the standings count both, so anyone who changed their mind scores
-- twice — and nothing on any screen would look wrong.
select '016 · one prediction per person per match',
       exists (select 1 from pg_constraint where conname = 'predictions_one_per_match')
union all
select '016 · one champion pick per person',
       exists (select 1 from pg_constraint where conname = 'champion_picks_one_per_person')
union all
-- A scoreline the match could not have produced. The app checks this against
-- each match's own best_of, which a CHECK cannot reach; this is the same rule
-- applied after the fact, where the join is available.
select '016 · no prediction of an impossible scoreline',
       not exists (select 1 from predictions p
                   join matches m on m.id = p.match_id
                   where p.loser_games >= (m.best_of / 2) + 1)
union all
-- A pick that landed after its match started would be a hole in the lock. Only
-- checkable where a kickoff time was set, which is the case that matters: an
-- unscheduled match locks on its first game row instead, and that has no
-- timestamp to compare against.
-- The anti-cheat row: somebody changing their pick once they can see how the
-- game is going. It reads updated_at, which is "when this row last changed" and
-- not "when its owner last saved it" — so an organizer repairing data trips it
-- exactly like a late edit would.
--
-- 035 added corrected_at for that, and a stamped row is excluded here. The
-- to_jsonb form is the two-part rule at the top of this file: before 035 the
-- column does not exist, the expression is NULL, `is null` holds, and every row
-- is still checked — so this reads the same as it always did until the
-- migration lands. A repair that is not recorded is still caught.
select '016 · no pick was saved after kickoff',
       not exists (select 1 from predictions p
                   join matches m on m.id = p.match_id
                   where m.scheduled_at is not null
                     and p.updated_at > m.scheduled_at
                     and to_jsonb(p)->>'corrected_at' is null)
union all
-- And a correction says who made it and why — 035's constraint enforces the
-- three fields travelling together, this proves none got in another way.
select '035 · every corrected prediction names who corrected it',
       not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'predictions'
                     and column_name = 'corrected_at')
       or not exists (select 1 from predictions p
                      where to_jsonb(p)->>'corrected_at' is not null
                        and (to_jsonb(p)->>'corrected_by' is null
                          or to_jsonb(p)->>'corrected_why' is null))
union all
-- ── 017 ────────────────────────────────────────────────────────────────────
select '017 · prediction_questions and question_answers exist',
       (select count(*) = 2 from information_schema.tables
         where table_schema = 'public'
           and table_name in ('prediction_questions', 'question_answers'))
union all
select '017 · one answer per person per question',
       exists (select 1 from pg_constraint where conname = 'question_answers_one_per_person')
union all
select '017 · every question has 2 to 8 options',
       exists (select 1 from pg_constraint where conname = 'prediction_questions_option_count')
union all
-- An answer pointing at an option the question no longer lists. It would score
-- nobody and vanish from the split, which is indistinguishable from never
-- having answered — the API refuses to remove a chosen option, and this is how
-- you find any that slipped past it.
select '017 · every answer points at an option that still exists',
       not exists (
         select 1 from question_answers a
           join prediction_questions q on q.id = a.question_id
          where not exists (select 1 from jsonb_array_elements(q.options) o
                             where o->>'id' = a.option_id))
union all
-- A settled question whose correct answer is not one of its own options pays
-- nobody and looks settled.
select '017 · a settled question names one of its own options',
       not exists (
         select 1 from prediction_questions q
          where q.correct_option_id is not null
            and not exists (select 1 from jsonb_array_elements(q.options) o
                             where o->>'id' = q.correct_option_id))
union all
select '017 · no answer was saved after its question closed',
       not exists (select 1 from question_answers a
                   join prediction_questions q on q.id = a.question_id
                   where q.closes_at is not null and a.updated_at > q.closes_at)
union all
-- ── 019 ────────────────────────────────────────────────────────────────────
select '019 · drafts.is_mock exists and defaults to false',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'drafts'
                 and column_name = 'is_mock' and column_default = 'false')
union all
-- ── 020 ────────────────────────────────────────────────────────────────────
-- Party 2 stopped being a second objective party. Asserted by its SHAPE rather
-- than its name: 'Flex' is a name three other parties already carry, while
-- "no second party demanding two compulsory tanks" is the thing that changed.
select '020 · party 2 is an ordinary Flex',
       (select party_template->1->'slots' = '["Tank","Any Role","DPS","DPS","Healer","Healer"]'::jsonb
          from tournaments where status <> 'complete' order by created_at limit 1)
union all
-- ── 021 ────────────────────────────────────────────────────────────────────
select '021 · sub_slots is pinned to sub_count by a constraint',
       exists (select 1 from pg_constraint where conname = 'tournaments_sub_slots_count')
union all
-- The constraint above guarantees the LENGTH. This is the composition, which
-- nothing enforces and which is the number captains actually draft against.
-- 021 set 4/10/4; 024 moved two seats from damage to healing. The composition
-- is asserted there instead, since that is the migration that owns it now.
select '024 · the running bench is 4 tank, 8 dps, 6 healer',
       coalesce((select
              (select count(*) from jsonb_array_elements_text(to_jsonb(t)->'sub_slots') s
                where s = 'Tank') = 4
          and (select count(*) from jsonb_array_elements_text(to_jsonb(t)->'sub_slots') s
                where s = 'DPS') = 8
          and (select count(*) from jsonb_array_elements_text(to_jsonb(t)->'sub_slots') s
                where s = 'Healer') = 6
         from tournaments t where t.status <> 'complete'
         order by t.created_at limit 1), false)
union all
-- The cap is enforced in backend/draft.js, so nothing here prevents an
-- over-drafted roster — but 024 can land on a team that went over under the
-- OLD numbers, and those rosters need a manual fix rather than another pick.
-- This is how you find them.
-- Scoped to the RUNNING season. An archived tournament was played under
-- whatever numbers applied then, and failing this row for a season that is
-- already over would be a permanent red line nobody can clear.
select '024 · no team is over a role ceiling',
       not exists (
         select 1 from team_players r
           join teams tm on tm.id = r.team_id
           join tournaments o on o.id = tm.tournament_id
           join player_signups p on p.id = r.signup_id
          where p.role is not null
            and o.status <> 'complete'
          group by r.team_id, p.role
         having (p.role = 'Tank' and count(*) > 20)
             or (p.role = 'DPS' and count(*) > 31)
             or (p.role = 'Healer' and count(*) > 27))
union all
-- Same trap as the party template, and worth asserting separately because the
-- bench is edited through a different field: a bench slot naming a role no
-- signup can hold is a seat that stays empty forever.
select '021 · the bench says Healer, not Support',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'tournaments'
                 and column_name = 'sub_slots')
       and not exists (select 1 from tournaments t
                        where to_jsonb(t)->>'sub_slots' like '%Support%')
union all
-- ── 022 ────────────────────────────────────────────────────────────────────
select '022 · team_party_slots table',
       to_regclass('public.team_party_slots') is not null
union all
select '022 · one player sits in one seat',
       exists (select 1 from pg_constraint where conname = 'party_slots_one_seat_per_player')
union all
select '022 · one seat holds one player',
       exists (select 1 from pg_constraint where conname = 'party_slots_one_player_per_seat')
union all
-- THE constraint, and the reason this is a table rather than a jsonb layout on
-- the team. Without it a comp can name somebody who was cut an hour ago.
select '022 · a seated player is on the roster (FK, cascading)',
       exists (select 1 from pg_constraint where conname = 'party_slots_on_the_roster')
union all
-- ── 023 ────────────────────────────────────────────────────────────────────
select '023 · tournaments.streams exists and is an array',
       exists (select 1 from pg_constraint where conname = 'tournaments_streams_is_array')
union all
-- THE one that matters. These links are served by /api/tournament, which sits
-- above requireAuth, and rendered as anchors to the public — so anything but
-- https in here is a live `javascript:` href waiting to be clicked. The API
-- refuses them (shared/streams.cjs); this proves nothing got in another way.
select '023 · every stream link is https',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'tournaments'
                 and column_name = 'streams')
       and not exists (select 1 from tournaments t,
                            jsonb_array_elements(to_jsonb(t)->'streams') s
                        where s->>'url' is null or s->>'url' not like 'https://%')
union all
-- ── 025 ────────────────────────────────────────────────────────────────────
select '025 · teams.discord_url exists',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'teams'
                 and column_name = 'discord_url')
union all
select '025 · the https constraint is on it',
       exists (select 1 from pg_constraint where conname = 'teams_discord_url_https')
union all
-- THE one that matters, and the reason the host is checked in code rather than
-- left to the CHECK above. This link is sent BY THE BOT to a player who has
-- just been drafted and is expecting the message — the most trusted link this
-- app emits. Anything that is not a Discord invite in this column is a
-- phishing link with the tournament's name on it.
--
-- Mirrors shared/invites.cjs: discord.gg with a path, or discord.com and
-- discordapp.com under /invite/. Deliberately anchored with '://' so
-- 'https://discord.gg.evil.com/x' fails here the way it fails there.
select '025 · every team invite is a real Discord invite',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'teams'
                 and column_name = 'discord_url')
       and not exists (
         select 1 from teams t
          where to_jsonb(t)->>'discord_url' is not null
            and to_jsonb(t)->>'discord_url' !~ '^https://([a-z0-9-]+\.)*discord\.gg/.+'
            and to_jsonb(t)->>'discord_url' !~ '^https://([a-z0-9-]+\.)*discord(app)?\.com/invite/.+')
union all
-- Not a schema fact — a READINESS one, and the row to look at before a draft
-- rather than after. A team with no invite still drafts; its players just get
-- the DM without a link, and nobody finds out until somebody asks where to go.
-- Reads false with the team named in the query below it.
select '025 · every team in the running season has an invite',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'teams'
                 and column_name = 'discord_url')
       and not exists (
         select 1 from teams t
           join tournaments o on o.id = t.tournament_id
          where o.status <> 'complete' and to_jsonb(t)->>'discord_url' is null)
union all
-- ── 026 ────────────────────────────────────────────────────────────────────
-- The CHECK has to admit 'RR' before a seeding fixture can be written at all.
-- Read out of the constraint's own definition rather than by trying an insert.
select '026 · matches accepts a seeding stage',
       exists (select 1 from pg_constraint
               where conname = 'matches_bracket_valid'
                 and pg_get_constraintdef(oid) like '%''RR''%')
union all
-- "If drawn" on purpose. A season before its seeding stage exists is not a
-- broken database, and a row that sits red for three weeks is a row people
-- stop reading.
select '026 · the seeding stage, if drawn, is every pair exactly once',
       coalesce((
         select (select count(*) from matches m
                  where m.tournament_id = o.id and m.bracket = 'RR') in (
                  0,
                  (select count(*) * (count(*) - 1) / 2 from teams t
                    where t.tournament_id = o.id))
           from tournaments o where o.status <> 'complete'
          order by o.created_at limit 1), true)
union all
select '026 · the drawn bracket uses the NEW final (bo5, no reset) — false means it predates 026',
       coalesce((
         select (select count(*) from matches m
                  where m.tournament_id = o.id and m.bracket = 'GF') in (0, 1)
            and not exists (select 1 from matches m
                             where m.tournament_id = o.id and m.key = 'GF2-0'
                               and m.kind <> 'void')
            and not exists (select 1 from matches m
                             where m.tournament_id = o.id and m.bracket = 'GF'
                               and m.best_of <> 5)
           from tournaments o where o.status <> 'complete'
          order by o.created_at limit 1), true)
union all
-- ── 027 ────────────────────────────────────────────────────────────────────
select '027 · match_weapons table',
       to_regclass('public.match_weapons') is not null
union all
select '027 · one screenshot per team per match',
       exists (select 1 from pg_constraint where conname = 'match_weapons_one_per_team')
union all
-- The bucket is where the bytes actually live. The table can exist without it
-- and every upload would then fail at the storage call, not the insert.
select '027 · the weapons storage bucket exists',
       exists (select 1 from storage.buckets where id = 'weapons')
union all
-- PRIVATE. A public bucket would make every team's comp readable by URL for
-- the rest of time, which is the opposite of why the API signs these.
select '027 · and it is private',
       exists (select 1 from storage.buckets where id = 'weapons' and public = false)
union all
-- ── 028 ────────────────────────────────────────────────────────────────────
select '028 · team_players.playing exists',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'team_players'
                 and column_name = 'playing')
union all
select '028 · drafts carries the compensation pick',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'drafts'
                 and column_name = 'comp_team_id')
       and exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'drafts'
                     and column_name = 'comp_after_pick')
union all
-- Both or neither. One without the other reads as "no compensation" while
-- actually being a half-applied rule.
select '028 · the compensation columns are paired by a constraint',
       exists (select 1 from pg_constraint where conname = 'drafts_comp_pair')
union all
-- THE ONE TO READ, and it has already earned its place: 028 first looked for
-- 'Zaels' when the signup says 'Zael', matched nothing, reported success, and
-- this row is what caught it. 028 marks by TEAM NAME and PLAYER NAME, because a
-- migration has no ids — so a rename, a stray space, or the apostrophe in
-- another team's name makes it match nothing, silently. That surfaces on draft
-- night as a team that never gets its extra pick.
select '028 · exactly one rostered member is marked not playing',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'team_players'
                 and column_name = 'playing')
       and (select count(*) from team_players r
              join tournaments o on o.id = r.tournament_id
             where o.status <> 'complete'
               and to_jsonb(r)->>'playing' = 'false') = 1
union all
-- The draft refuses to start if two teams are short, because only one pick can
-- be inserted. This is that rule, checked against the data rather than trusted
-- to the code that enforces it.
select '028 · no team is short more than one playing member',
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'team_players'
                 and column_name = 'playing')
       and not exists (
         select 1 from team_players r
           join tournaments o on o.id = r.tournament_id
          where o.status <> 'complete' and to_jsonb(r)->>'playing' = 'false'
          group by r.team_id having count(*) > 1)
union all
-- ── 030 ────────────────────────────────────────────────────────────────────
select '030 · touch_updated_at has a pinned search_path',
       exists (select 1 from pg_proc p
                 join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'touch_updated_at'
                  and p.proconfig is not null
                  and array_to_string(p.proconfig, ',') like '%search_path%')
union all
-- ── 031 ────────────────────────────────────────────────────────────────────
-- rls_auto_enable is an EVENT TRIGGER function, not an RPC. The API roles never
-- needed to call it — an event trigger is fired by the trigger manager and does
-- not consult EXECUTE — so this is the grant going away, not a capability.
--
-- READ FALSE UNTIL 034, and 031 was not the reason. Neither role ever held a
-- direct grant: both inherited EXECUTE from PUBLIC, which is the default on any
-- new function, and 031's role-scoped revokes had nothing to remove.
-- has_function_privilege answers for privileges however they are held, so this
-- row stayed red while the migration meant to satisfy it had applied cleanly.
-- 034 revokes from PUBLIC, which is what this has always been testing for.
select '031 · the API roles cannot execute rls_auto_enable',
       not exists (
         select 1 from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           join pg_roles r on r.rolname in ('anon', 'authenticated')
          where n.nspname = 'public' and p.proname = 'rls_auto_enable'
            and has_function_privilege(r.oid, p.oid, 'EXECUTE'))
union all
-- And the trigger it belongs to is still armed. This is the half that MATTERS:
-- revoking the grant must not have been mistaken for disabling the thing, and a
-- function with no trigger attached has never been enabling RLS on anything.
-- Reads true when there is no such function at all, so a database that never
-- had it is not failed for it — the RLS row below is the real test either way.
select '031 · rls_auto_enable is still attached to an event trigger',
       not exists (select 1 from pg_proc p
                     join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = 'rls_auto_enable')
       or exists (select 1 from pg_event_trigger e
                    join pg_proc p on p.oid = e.evtfoid
                   where p.proname = 'rls_auto_enable' and e.evtenabled <> 'D')
union all
-- ── 032 ────────────────────────────────────────────────────────────────────
select '032 · guild_aliases table',
       to_regclass('public.guild_aliases') is not null
union all
-- THE one that keeps a tally deterministic. Without it, `MILK°` and `milk°` are
-- two rows that can point at two different guilds, and which one wins depends
-- on the order they come back in — so the same board tallies differently on two
-- reads with nothing having changed.
select '032 · one row per alias, case-insensitively',
       exists (select 1 from pg_indexes
               where schemaname = 'public' and indexname = 'guild_aliases_one_per_alias')
union all
select '032 · an alias cannot point at itself, and neither half can be blank',
       exists (select 1 from pg_constraint where conname = 'guild_aliases_not_self')
       and exists (select 1 from pg_constraint where conname = 'guild_aliases_not_blank')
union all
-- Resolution is ONE HOP (shared/guilds.cjs), so an alias whose canonical name
-- is itself an alias resolves to a name that is not the answer — silently, and
-- only for the guilds in the chain. Written the two-part way because it reads
-- DATA out of a table a half-applied database may not have.
select '032 · no alias points at another alias',
       to_regclass('public.guild_aliases') is null
       or not exists (select 1 from guild_aliases a
                        join guild_aliases b
                          on lower(btrim(b.alias)) = lower(btrim(a.canonical)))
union all
-- ── 033 ────────────────────────────────────────────────────────────────────
select '033 · trades table',
       to_regclass('public.trades') is not null
union all
select '033 · a trade has two different teams and somebody in it',
       exists (select 1 from pg_constraint where conname = 'trades_two_teams')
       and exists (select 1 from pg_constraint where conname = 'trades_not_empty')
       and exists (select 1 from pg_constraint where conname = 'trades_status_valid')
union all
select '033 · team_players records where a traded player came from',
       (select count(*) = 2 from information_schema.columns
         where table_schema = 'public' and table_name = 'team_players'
           and column_name in ('traded_from_team_id', 'traded_at'))
union all
-- NO HALF-APPLIED TRADES. backend/trades.js writes the row as 'pending', moves
-- the players, then marks it 'applied' — and rolls back and marks it 'failed'
-- if any move fails. A row still 'pending' a minute later is a process that
-- died mid-trade: one roster is short and the other long, both look normal, and
-- this row's `moves` column is the only record of what was meant to happen.
--
-- The minute's grace is for a trade being applied at the moment this runs.
select '033 · no trade is stuck half-applied',
       to_regclass('public.trades') is null
       or not exists (select 1 from trades
                       where status = 'pending'
                         and created_at < now() - interval '1 minute')
union all
-- A roster row claiming it was traded from the team it is still on. Nothing in
-- the application writes that; it would mean a move that recorded itself and
-- did not happen. Guarded because the column arrives with 033.
select '033 · nobody was traded from the team they are on',
       not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'team_players'
                     and column_name = 'traded_from_team_id')
       or not exists (select 1 from team_players r
                      where to_jsonb(r)->>'traded_from_team_id' is not null
                        and to_jsonb(r)->>'traded_from_team_id' = r.team_id::text)
union all
-- A trade must never have moved a captain: they are on that roster BECAUSE they
-- captain it, and moving the row would leave team_captains pointing at somebody
-- playing for the other team. shared/trades.cjs refuses it; this proves nothing
-- got in another way.
-- The half of 010's old check that a trade does NOT excuse. A player whose
-- roster team differs from the team that drafted them must carry the trade that
-- moved them; without one, the mismatch is a roster row somebody edited by hand
-- or a move that half happened, which is exactly what 010 used to catch.
--
-- Written the two-part way: traded_from_team_id arrives with 033, and naming a
-- missing column directly would abort the whole sweep.
select '033 · every drafted player on another team was traded there',
       not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'team_players'
                     and column_name = 'traded_from_team_id')
       or not exists (
         select 1 from draft_picks p
           join team_players tp
             on tp.signup_id = p.signup_id and tp.tournament_id = p.tournament_id
          where tp.team_id <> p.team_id
            and to_jsonb(tp)->>'traded_from_team_id' is null)
union all
select '033 · no captain plays for a team they do not captain',
       not exists (select 1 from team_players r
                     join team_captains c
                       on c.signup_id = r.signup_id and c.tournament_id = r.tournament_id
                    where r.via = 'captain' and c.team_id <> r.team_id)
union all
-- ── The one that is not about a migration ──────────────────────────────────
-- EVERY PUBLIC TABLE SHOULD HAVE RLS ENABLED, and this app makes that free.
--
-- Nothing here ever talks to Supabase as `anon` or `authenticated`: the browser
-- talks to the Express backend, and the backend uses the SERVICE key, which
-- bypasses RLS entirely. So enabling RLS costs this application nothing at all
-- and is the only thing standing between the public PostgREST endpoint and
-- every row in the database.
--
-- A table with RLS on and no policies is exactly right here: the service key
-- still reads and writes it, and anon gets nothing.
select '· every public table has RLS enabled',
       not exists (
         select 1 from pg_tables t
          where t.schemaname = 'public'
            and not exists (
              select 1 from pg_class c
                join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relname = t.tablename
                 and c.relrowsecurity));

-- ── The ones that name names ────────────────────────────────────────────────
-- The checks above are booleans, which is right for a pass/fail sweep and
-- useless once something reads false. Run these to find out WHICH.
--
-- Teams and their invites — 025's seed matches on NAME, so a renamed or
-- mistyped team is silent up there and obvious here:
--
--   select t.seed, t.name, coalesce(t.discord_url, '— none —') as invite
--     from teams t
--     join tournaments o on o.id = t.tournament_id
--    where o.status <> 'complete'
--    order by t.seed nulls last;
--
-- Rosters against the 024 ceilings — Tank 20, DPS 31, Healer 27:
--
--   select tm.name, p.role, count(*) as have
--     from team_players r
--     join teams tm on tm.id = r.team_id
--     join tournaments o on o.id = tm.tournament_id
--     join player_signups p on p.id = r.signup_id
--    where o.status <> 'complete' and p.role is not null
--    group by tm.name, p.role
--    order by tm.name, p.role;
--
-- WHO is not playing, and therefore whose team is owed the extra pick. Run this
-- straight after 028 — the row above says "exactly one" and this says which:
--
--   select tm.name as team, p.player_name, r.via
--     from team_players r
--     join teams tm on tm.id = r.team_id
--     join tournaments o on o.id = tm.tournament_id
--     join player_signups p on p.id = r.signup_id
--    where o.status <> 'complete' and r.playing = false;
--
-- What each team will FIELD, which is the number the compensation pick exists
-- to equalise. Before the draft it is the captains; after it, every row here
-- should read the same:
--
--   select tm.name, count(*) filter (where r.playing) as playing, count(*) as rostered
--     from team_players r
--     join teams tm on tm.id = r.team_id
--     join tournaments o on o.id = tm.tournament_id
--    where o.status <> 'complete'
--    group by tm.name order by tm.name;
--
-- ── 027's data checks, run separately ───────────────────────────────────────
-- Same reason 022's live down here: they name match_weapons directly, and a
-- query naming a table that does not exist fails at PARSE time and would abort
-- the whole sweep rather than reading false.
--
-- Which matches are still missing a weapons screenshot. The one to run on match
-- night — the bracket flags it per card, this is the list:
--
--   select m.key, m.bracket,
--          (w_a.id is not null) as team_a_done,
--          (w_b.id is not null) as team_b_done
--     from matches m
--     join tournaments o on o.id = m.tournament_id
--     left join match_weapons w_a on w_a.match_id = m.id and w_a.team_id = m.team_a_id
--     left join match_weapons w_b on w_b.match_id = m.id and w_b.team_id = m.team_b_id
--    where o.status <> 'complete' and m.kind = 'match'
--      and m.team_a_id is not null and m.team_b_id is not null
--    order by m.bracket, m.round, m.idx;
--
-- Screenshots attached to a team that is no longer in their match. Keying by
-- team rather than by slot makes these visible instead of silently becoming the
-- other team's comp — should be empty:
--
--   select m.key, w.team_id
--     from match_weapons w
--     join matches m on m.id = w.match_id
--    where w.team_id not in (coalesce(m.team_a_id, w.team_id),
--                            coalesce(m.team_b_id, w.team_id));
--
-- Files in the bucket that nothing references. Harmless, but this is how you
-- find them after a match or a tournament has been deleted:
--
--   select o.name from storage.objects o
--    where o.bucket_id = 'weapons'
--      and not exists (select 1 from match_weapons w where w.storage_path = o.name);

-- ── 022's data checks, run separately ───────────────────────────────────────
-- These two name team_party_slots directly, and a query naming a table that
-- does not exist fails at PARSE time — it would abort the whole sweep above
-- rather than reading false, which is exactly backwards for a file whose job
-- is reporting on a half-applied database. A missing COLUMN can be worked
-- around (see the to_jsonb guards above); a missing TABLE cannot.
--
-- So they live here. Run them once 022 has been applied; both should be empty.
--
-- Anybody seated who is not on the roster. The foreign key makes this
-- impossible, and this is how you prove it rather than assume it:
--
--   select s.* from team_party_slots s
--    where not exists (select 1 from team_players r
--                       where r.team_id = s.team_id and r.signup_id = s.signup_id);
--
-- Seatings pointing at a slot the template no longer has — the one corruption
-- the constraints cannot catch, because party_template can be resized after a
-- comp is built. These render nowhere and are invisible in the UI:
--
--   select t.name, s.party_index + 1 as party, s.slot_index + 1 as seat
--     from team_party_slots s
--     join teams t on t.id = s.team_id
--     join tournaments o on o.id = t.tournament_id
--    where s.party_index >= jsonb_array_length(o.party_template)
--       or s.slot_index >= jsonb_array_length(
--            o.party_template->s.party_index->'slots');
