-- 027_weapon_shots.sql — the weapons each team fielded, as a screenshot.
--
-- Run in the Supabase SQL editor AFTER 026. Safe to re-run.
--
-- One image per team per match, for every match in the season — the six seeding
-- fixtures and the bracket alike. It is the record of what a team actually
-- brought, taken before the game and kept afterwards, so a dispute about a comp
-- has something to look at other than memory.
--
-- ── The first image this app KEEPS ──────────────────────────────────────────
-- Scoreboard screenshots already pass through the server, but they are never
-- stored: multer buffers them in memory, Gemini reads them into rows, and the
-- bytes are dropped (see backend/results.js). This is different — the image IS
-- the artefact, so it has to live somewhere.
--
-- SUPABASE STORAGE, not a bytea column. A few megabytes a match through
-- Postgres would be read back on every bracket render and billed as database
-- egress every time; the bucket is served separately and can be cached. The
-- table below stores only the PATH.
--
-- The bucket is PRIVATE. The API mints a short-lived signed URL when it hands
-- a match out, so the images are not enumerable by anyone who guesses a path.
-- Making it public would be one line and would also make every team's comp
-- readable by URL for the rest of time.

-- ── The bucket ──────────────────────────────────────────────────────────────
-- Storage buckets are ordinary rows in Supabase. Created here so the whole
-- setup is in one file rather than half in a dashboard nobody records.
insert into storage.buckets (id, name, public)
values ('weapons', 'weapons', false)
on conflict (id) do nothing;

-- ── The table ───────────────────────────────────────────────────────────────
create table if not exists match_weapons (
  id             uuid primary key default gen_random_uuid(),

  tournament_id  uuid not null references tournaments(id) on delete cascade,
  match_id       uuid not null references matches(id) on delete cascade,

  -- WHICH TEAM, not which side. Storing 'a'/'b' would be one column shorter and
  -- wrong: a match's sides are filled in as the bracket settles, and an undo
  -- can put a different team in slot A. Keyed by team, a screenshot that no
  -- longer belongs to anybody in the match is visible as such; keyed by slot it
  -- would silently become the other team's comp.
  team_id        uuid not null,

  -- Path inside the 'weapons' bucket. The bytes are not here.
  storage_path   text not null,

  -- Who attached it. Organizers only (there is no captain-facing upload), so
  -- this is a short list of people and worth recording — a comp screenshot is
  -- evidence, and evidence with no provenance is an argument waiting to happen.
  uploaded_by    text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

do $$ begin
  -- One per team per match. Re-uploading REPLACES rather than accumulates:
  -- somebody retaking a blurry screenshot should not leave two on the record
  -- with nothing saying which is current.
  if not exists (select 1 from pg_constraint where conname = 'match_weapons_one_per_team') then
    alter table match_weapons
      add constraint match_weapons_one_per_team unique (match_id, team_id);
  end if;

  -- The team belongs to this tournament — the composite pattern 006 onwards
  -- uses, so a screenshot cannot name a team from another season.
  if not exists (select 1 from pg_constraint where conname = 'match_weapons_team_tournament') then
    alter table match_weapons
      add constraint match_weapons_team_tournament
      foreign key (team_id, tournament_id) references teams (id, tournament_id) on delete cascade;
  end if;
end $$;

create index if not exists match_weapons_match_idx on match_weapons (match_id);

drop trigger if exists match_weapons_touch on match_weapons;
create trigger match_weapons_touch
  before update on match_weapons
  for each row execute function touch_updated_at();

-- ── Deleting a row does NOT delete the file ─────────────────────────────────
-- Postgres has no reach into the bucket. backend/bracket.js removes the object
-- before it removes the row, so the normal path leaves nothing behind — but a
-- cascade (a match or a tournament deleted) drops rows without touching
-- storage. Orphans are harmless and cheap; this is how you find them:
--
--   select o.name from storage.objects o
--    where o.bucket_id = 'weapons'
--      and not exists (select 1 from match_weapons w where w.storage_path = o.name);

-- Check — what has been attached, and what is still missing. The second query
-- is the one to run on match night:
--   select m.key, t.name as team, w.created_at, w.uploaded_by
--     from match_weapons w
--     join matches m on m.id = w.match_id
--     join teams t on t.id = w.team_id
--    order by m.bracket, m.round, m.idx;
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
