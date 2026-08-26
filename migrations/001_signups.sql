-- 001_signups.sql — tournaments and the player signup pool.
--
-- Run this in the Supabase SQL editor of the TLTourney project. This is a NEW,
-- SEPARATE Supabase project from Gear-Gap: nothing here shares storage with the
-- guild app, and no table below exists over there.
--
-- Safe to re-run: every statement is guarded.

create extension if not exists pgcrypto;

-- ── Tournaments ─────────────────────────────────────────────────────────────
-- One row per tournament. The app works on the single tournament whose status
-- is not 'complete' — multi-tournament is a later screen, not a later migration,
-- which is why every table below already carries tournament_id.
create table if not exists tournaments (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  -- 'signups' is the only status in which a player may create or edit a signup.
  -- Everything else is a read-only pool, which is what stops a roster changing
  -- underneath a draft that is already running.
  status            text not null default 'setup'
                    check (status in ('setup', 'signups', 'draft', 'live', 'complete')),
  signups_close_at  timestamptz,
  roster_size       int  not null default 6 check (roster_size between 1 and 20),
  created_at        timestamptz not null default now()
);

-- ── Player signups ──────────────────────────────────────────────────────────
-- The pool captains draft from. A signup is invisible to captains until an
-- organizer approves it.
create table if not exists player_signups (
  id               uuid primary key default gen_random_uuid(),
  tournament_id    uuid not null references tournaments(id) on delete cascade,

  -- Identity comes from the Discord session, never from the request body —
  -- otherwise anyone could file a signup as anyone else.
  discord_id       text not null,
  discord_username text,

  player_name      text not null check (length(btrim(player_name)) between 1 and 32),

  -- Up to three classes, in preference order: classes[1] is their main.
  -- An ordered array rather than three columns, because "their second class" is
  -- not a different KIND of fact from "their first" — three columns would mean
  -- three sets of null-handling everywhere and a rule about whether class_2 may
  -- be set while class_1 is null.
  --
  -- Membership of the real 45-class list, and de-duplication, are enforced in
  -- backend/validateSignup.js rather than here: a CHECK cannot run a subquery,
  -- so expressing "every element is one of these 45" in SQL means pasting the
  -- list into the schema, where it would drift from shared/weaponClasses.json.
  -- One list, in one place, with tests on it.
  classes          text[] not null,
  nights           text[] not null default '{}',
  notes            text check (notes is null or length(notes) <= 500),
  wants_captain    boolean not null default false,

  status           text not null default 'pending'
                   check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  decision_note    text,
  decided_by       text,
  decided_at       timestamptz,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- One signup per person per tournament. Without this, a double-submitted form
  -- puts the same player on the board twice and two captains can draft them.
  constraint player_signups_one_per_person unique (tournament_id, discord_id),

  -- At least one class, at most three. The count is checkable in SQL even
  -- though membership isn't, and it is the half that protects the draft board:
  -- an empty array would put somebody in the pool playing nothing.
  -- array_length returns NULL, not 0, for an empty array — hence coalesce.
  constraint player_signups_class_count
    check (coalesce(array_length(classes, 1), 0) between 1 and 3)
);

create index if not exists player_signups_tournament_status_idx
  on player_signups (tournament_id, status);

-- "Who can play Ravager?" is the question captains ask of this table, and it is
-- an array containment test — which a btree index cannot serve.
create index if not exists player_signups_classes_idx
  on player_signups using gin (classes);

-- Case-insensitive lookup of an in-game name, for matching scoreboard rows to
-- signups later. Not unique: two people genuinely can pick the same name across
-- servers, and blocking the second one at signup time is not this app's call.
create index if not exists player_signups_name_idx
  on player_signups (tournament_id, lower(player_name));

-- ── Audit log ───────────────────────────────────────────────────────────────
-- Every organizer decision. Approvals and rejections are the actions people
-- argue about afterwards, so they are the ones worth recording.
create table if not exists audit_log (
  id          bigserial primary key,
  actor_id    text,
  actor_name  text,
  action      text not null,
  target      text,
  detail      jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists audit_log_created_idx on audit_log (created_at desc);

-- ── updated_at ──────────────────────────────────────────────────────────────
create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists player_signups_touch on player_signups;
create trigger player_signups_touch
  before update on player_signups
  for each row execute function touch_updated_at();

-- ── Seed the first tournament ───────────────────────────────────────────────
-- Open for signups immediately, so the app has something to point at on first
-- boot. Rename it on the organizer page; delete it if you'd rather start clean.
--
-- roster_size is deliberately NOT set here. It defaults to 6 at this point and
-- migration 003 turns it into a generated column over party_count, party_size
-- and sub_count — naming it in this insert would break the day someone runs
-- these migrations out of order, and the value would be overwritten anyway.
insert into tournaments (name, status)
select 'Season 2 Americas Draft Tournament', 'signups'
where not exists (select 1 from tournaments);
