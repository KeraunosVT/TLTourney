-- 032_guild_aliases.sql — one guild, however the scoreboard spelled it.
--
-- Run in the Supabase SQL editor AFTER 031. Safe to re-run.
--
-- PASTE THIS AS UTF-8. The seed rows below contain a degree sign, and a paste
-- that mangles it inserts an alias that will never match anything — which is
-- the one failure this file cannot detect for you, because a wrong alias looks
-- exactly like a right one.
--
-- ── The problem ─────────────────────────────────────────────────────────────
-- player_match_stats.guild_name is filled in on every upload, straight from
-- Gemini's read of the scoreboard. Guild names in Throne & Liberty are full of
-- trailing glyphs — MILK°, JAILEDシ, Lotus花粉, Big Chillinツ — and a trailing
-- glyph is exactly what an OCR pass drops, doubles, or turns into something
-- else. One guild came off two committed boards as THREE names:
--
--   MILK°  11 players    MILK  4 players    MILK*  1 player
--
-- Nothing about those three rows says they are one guild. Counting them apart
-- undercounts a guild by two thirds and shows it three times in a list, which
-- is not a wrong number anybody notices — it is three plausible small ones.
--
-- ── Why this is a table and not a fix to the data ───────────────────────────
-- The obvious alternative is to UPDATE the sixteen rows to say MILK and move
-- on. Refused, for the reason 012 gives for the whole block those columns sit
-- in: guild_name is EVIDENCE. It is the scoreboard as it was read, and when
-- somebody disputes a number the answer has to be the row as it came off the
-- screenshot rather than a tidied version somebody edited afterwards with no
-- record of having done it.
--
-- So the raw spelling stays, and this table says what it COUNTS AS. Resolution
-- happens at read time (shared/guilds.cjs); a correction here re-counts every
-- board ever uploaded, and is itself undoable by deleting a row.
--
-- ── Not scoped to a tournament ──────────────────────────────────────────────
-- Every other table in this schema hangs off tournament_id, and this one
-- deliberately does not. A guild is a real organisation that outlives a season:
-- MILK° is MILK in the spring tournament and in the next one, and making
-- somebody re-enter the same alias per season would guarantee that by season
-- three the two lists disagree. There is nothing tournament-specific about how
-- a name is spelled.

-- ── The table ───────────────────────────────────────────────────────────────
create table if not exists guild_aliases (
  id          uuid primary key default gen_random_uuid(),

  -- The spelling as it comes off a scoreboard — including whatever the read
  -- made of the trailing glyph. Stored exactly, matched case-insensitively.
  alias       text not null,

  -- What it counts as. Free text on purpose: there is no guilds table and this
  -- does not need one — the canonical name IS the identity, the same way a
  -- team's name is. A guilds table would need maintaining by somebody, and the
  -- only thing it would add is a second place for the name to be wrong.
  canonical   text not null,

  -- Why. An alias is a claim that two names are one guild, made by a person
  -- from something they knew; six months later nobody remembers which, and an
  -- unexplained alias is indistinguishable from a mistake.
  note        text,
  created_by  text,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

do $$ begin
  -- ONE ROW PER ALIAS, case- and padding-insensitively. Without this, `MILK°`
  -- and `milk°` are two rows that can point at two different canonical names,
  -- and which one wins depends on row order — so the same board would tally
  -- differently on two reads with nothing having changed.
  if not exists (select 1 from pg_indexes
                 where schemaname = 'public' and indexname = 'guild_aliases_one_per_alias') then
    create unique index guild_aliases_one_per_alias
      on guild_aliases (lower(btrim(alias)));
  end if;

  -- An alias that points at itself is a no-op that reads like a rule, and it
  -- is the shape a cycle starts as. Refused outright.
  if not exists (select 1 from pg_constraint where conname = 'guild_aliases_not_self') then
    alter table guild_aliases
      add constraint guild_aliases_not_self
      check (lower(btrim(alias)) <> lower(btrim(canonical)));
  end if;

  -- Neither half may be blank. An empty alias would match every row whose
  -- guild never read and quietly attribute all of them to one guild.
  if not exists (select 1 from pg_constraint where conname = 'guild_aliases_not_blank') then
    alter table guild_aliases
      add constraint guild_aliases_not_blank
      check (btrim(alias) <> '' and btrim(canonical) <> '');
  end if;
end $$;

drop trigger if exists guild_aliases_touch on guild_aliases;
create trigger guild_aliases_touch
  before update on guild_aliases
  for each row execute function touch_updated_at();

-- ── The aliases we know about ───────────────────────────────────────────────
-- Confirmed by the organizer against the two boards committed so far. Seeded
-- here rather than left as a chore, because a table nobody fills in is a
-- feature nobody has.
insert into guild_aliases (alias, canonical, note, created_by)
values
  ('MILK°', 'MILK', 'OCR keeps the degree sign from the guild''s own tag; same guild.', 'migration 032'),
  ('MILK*', 'MILK', 'The degree sign read as an asterisk on one page.', 'migration 032')
on conflict do nothing;

-- ── CHAINS ARE NOT FOLLOWED ─────────────────────────────────────────────────
-- Resolution is ONE HOP: A -> B, and if B is itself an alias of C, the answer
-- stays B. Following chains means either a loop check on every lookup or a
-- lookup that can hang, to serve a case nobody has ever needed — two names for
-- one guild is the whole problem, and a name for a name for a name is somebody
-- having entered the same guild twice.
--
-- It is a data error rather than an impossibility, so it is findable. This
-- should always be empty:
--
--   select a.alias, a.canonical as points_at, b.canonical as which_is_itself_an_alias
--     from guild_aliases a
--     join guild_aliases b on lower(btrim(b.alias)) = lower(btrim(a.canonical));

-- Check — what is mapped, and what it changes. The second query is the one
-- worth running after adding an alias, because it says how many rows moved:
--   select alias, canonical, note from guild_aliases order by canonical, alias;
--
--   select coalesce(a.canonical, btrim(s.guild_name)) as guild,
--          count(*) as rows,
--          count(distinct s.signup_id) as players,
--          string_agg(distinct btrim(s.guild_name), ' · ') as spellings
--     from player_match_stats s
--     left join guild_aliases a
--       on lower(btrim(a.alias)) = lower(btrim(s.guild_name))
--    where btrim(coalesce(s.guild_name, '')) <> ''
--    group by 1
--    order by rows desc;
--
-- Spellings on the boards that are NOT aliased and appear only once or twice —
-- the candidates for the next alias, and the reason to look is that a one-row
-- guild is exactly what a misread name looks like:
--   select btrim(s.guild_name) as spelling, count(*) as rows
--     from player_match_stats s
--     left join guild_aliases a
--       on lower(btrim(a.alias)) = lower(btrim(s.guild_name))
--    where a.id is null and btrim(coalesce(s.guild_name, '')) <> ''
--    group by 1 having count(*) <= 2
--    order by 2 desc, 1;
