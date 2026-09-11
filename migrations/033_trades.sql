-- 033_trades.sql — moving players between rosters, on the record.
--
-- Run in the Supabase SQL editor AFTER 032. Safe to re-run.
--
-- ── What a trade is, and what it is not ─────────────────────────────────────
-- Organizers can already add somebody to a roster and remove a MANUAL add
-- (teams.js). What they cannot do is move a DRAFTED player, and that refusal is
-- correct where it is: deleting a drafted player's roster row does not remove
-- them, because draft.js's reconcile() sees a pick with no roster row, calls it
-- a crash, and writes the row straight back. The player reappears a few seconds
-- later with no error and no visible cause.
--
-- A trade sidesteps that entirely by never deleting the roster row. It UPDATES
-- team_id, so the pick keeps its roster row and reconcile has nothing to
-- repair — which is also why a trade can move a drafted player and a manual
-- removal cannot.
--
-- ── The pick stays where it was made ────────────────────────────────────────
-- draft_picks is NOT rewritten. It is the record of a captain choosing that
-- player at that moment, which is a thing that really happened, and a trade
-- afterwards does not unhappen it. So Picks and the draft feed keep saying
-- "The Hamstars took Keraunos at 3.05" forever, and this table is what says he
-- plays for somebody else now. Every roster read in the app comes from
-- team_players (rostersByTeam), never from draft_picks, so the two disagreeing
-- about the present is not a bug — it is one being history and one being now.
--
-- ── Why the moves are stored rather than derived ────────────────────────────
-- The roster rows say where everybody IS. Nothing in them says how they got
-- there, and "why is this player on that team" is the question a trade creates.
-- Stored as they were made, with names alongside the ids, so deleting a signup
-- a season later leaves the history readable instead of a row of dead uuids.

-- ── The trades ──────────────────────────────────────────────────────────────
create table if not exists trades (
  id             uuid primary key default gen_random_uuid(),

  tournament_id  uuid not null references tournaments(id) on delete cascade,

  -- The two rosters involved. Not a foreign key to teams on purpose: deleting a
  -- team should not delete the record of what it traded away, and the moves
  -- below carry the team NAMES for exactly the same reason.
  team_a_id      uuid not null,
  team_b_id      uuid not null,

  -- [{ signup_id, player_name, from_team_id, from_team, to_team_id, to_team,
  --    via, was_drafted }] — one entry per player, in the order they were sent.
  moves          jsonb not null default '[]'::jsonb,

  -- 'pending' from the instant the row is written until every move has landed.
  --
  -- THE POINT OF THIS COLUMN. A trade is several writes and PostgREST has no
  -- transaction across them, so a process that dies halfway leaves one roster
  -- short and the other long with nothing on any page saying so — the exact
  -- silent-wrongness the rest of this schema is built to avoid. Writing the
  -- intent FIRST means a half-applied trade is a row that says what was meant
  -- to happen and did not, rather than an inconsistency nobody can reconstruct.
  --
  -- backend/trades.js rolls its own moves back on failure and marks the row
  -- 'failed'. A row left 'pending' is therefore a process that died mid-trade;
  -- verify.sql has the query, and the moves column says exactly who to put back.
  status         text not null default 'pending',

  note           text,
  made_by        text,

  created_at     timestamptz not null default now(),
  applied_at     timestamptz,
  updated_at     timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'trades_status_valid') then
    alter table trades
      add constraint trades_status_valid check (status in ('pending', 'applied', 'failed'));
  end if;

  -- A team cannot trade with itself. It is a no-op that would still write
  -- history and still empty both players' party seats.
  if not exists (select 1 from pg_constraint where conname = 'trades_two_teams') then
    alter table trades add constraint trades_two_teams check (team_a_id <> team_b_id);
  end if;

  -- A trade with nobody in it is a click that recorded nothing.
  if not exists (select 1 from pg_constraint where conname = 'trades_not_empty') then
    alter table trades
      add constraint trades_not_empty check (jsonb_array_length(moves) > 0);
  end if;
end $$;

create index if not exists trades_tournament_idx on trades (tournament_id, created_at desc);

drop trigger if exists trades_touch on trades;
create trigger trades_touch
  before update on trades
  for each row execute function touch_updated_at();

-- ── Where a traded player came from ─────────────────────────────────────────
-- On the roster row itself, not only in the trades table, because the question
-- is asked of a ROSTER: reading down one team, "why is this drafted player on a
-- team that never picked them" wants an answer in the row rather than a join
-- somebody has to think to make.
--
-- `via` is deliberately NOT changed to 'trade'. Two reasons, and the second is
-- the one that bites:
--
--   · 'draft' is still true — that IS how they entered the tournament's rosters,
--     and the round and pick on the row are still the pick that was made.
--   · teams.js refuses to delete a roster row whose via is 'draft', precisely
--     because reconcile() would write it back. A traded player with via='trade'
--     would become deletable again, and deleting them would resurrect them on
--     their ORIGINAL team a few seconds later.
alter table team_players
  add column if not exists traded_from_team_id uuid;

alter table team_players
  add column if not exists traded_at timestamptz;

-- Check — the trades made, newest first:
--   select t.created_at, t.status, t.made_by,
--          a.name as team_a, b.name as team_b,
--          jsonb_array_length(t.moves) as players
--     from trades t
--     left join teams a on a.id = t.team_a_id
--     left join teams b on b.id = t.team_b_id
--    order by t.created_at desc;
--
-- Who moved, and which way. One row per player per trade:
--   select t.created_at, m->>'player_name' as player,
--          m->>'from_team' as left_team, m->>'to_team' as joined
--     from trades t, jsonb_array_elements(t.moves) m
--    where t.status = 'applied'
--    order by t.created_at desc;
--
-- A HALF-APPLIED TRADE. Should always be empty — a row here is a process that
-- died mid-trade, and `moves` says who was supposed to end up where. Compare it
-- against team_players before touching anything:
--   select * from trades where status = 'pending' and created_at < now() - interval '1 minute';
--
-- Roster rows that say they were traded from a team they are still on. The
-- application never writes this; it would mean a move that recorded itself and
-- did not happen:
--   select r.* from team_players r where r.traded_from_team_id = r.team_id;
