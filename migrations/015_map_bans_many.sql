-- 015_map_bans_many.sql — two to four map bans per match, split between the teams.
--
-- Run in the Supabase SQL editor AFTER 014. Safe to re-run.
--
-- 014 gave each side exactly one ban and said, in its own header comment: "if
-- bans ever become two each, this becomes a table." They have. It does not
-- become a table.
--
-- A LIST PER SIDE, not a bans table. The thing 014 got right is that a ban
-- belongs to a named side of one match, and "whose ban was that" is the question
-- people ask — a table answers it with a join and buys nothing else, because
-- nothing ever queries bans across matches. What changed is only how MANY, and
-- one-to-four is what an array column is for.
--
-- The split is deliberately not fixed at two each. The rule is a number of bans
-- PER MATCH, between two and four, and formats exist where the sides do not get
-- the same count — a higher seed with the extra ban, say. Storing two lists
-- records what actually happened; storing a count per side would be the app
-- deciding a rule that belongs to whoever runs the tournament.

alter table matches
  add column if not exists bans_a text[] not null default '{}',
  add column if not exists bans_b text[] not null default '{}';

-- `add column if not exists` does NOTHING to a column that is already there —
-- not its default, not its nullability. These columns may well already exist,
-- added by hand when the rule changed, and a nullable bans_a is a real
-- difference: every ban count below is written as arithmetic on a list, and
-- arithmetic on NULL is NULL, which passes a CHECK instead of failing it.
--
-- So the shape is stated outright rather than assumed from the add above. All
-- four of these are no-ops when it already holds.
update matches set bans_a = '{}' where bans_a is null;
update matches set bans_b = '{}' where bans_b is null;
alter table matches alter column bans_a set default '{}';
alter table matches alter column bans_b set default '{}';
alter table matches alter column bans_a set not null;
alter table matches alter column bans_b set not null;

comment on column matches.bans_a is
  'The maps team A banned, in the order they banned them. Free text by design — the real list lives in shared/maps.cjs, and a copy of it pasted into a CHECK here would drift from the one the app validates against.';
comment on column matches.bans_b is
  'The maps team B banned. See bans_a.';

-- ── Carrying 014's single bans across ───────────────────────────────────────
-- Guarded and dynamic: after this migration has run once the old columns are
-- gone, and a static reference to ban_a would fail to parse on a re-run even
-- inside an `if exists`. The `where bans_a = '{}'` keeps a second run from
-- undoing bans added since.
do $$ begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'matches'
                and column_name = 'ban_a') then
    execute $q$
      update matches
         set bans_a = case when ban_a is null then '{}'::text[] else array[ban_a] end
       where bans_a = '{}' and ban_a is not null $q$;
    execute $q$
      update matches
         set bans_b = case when ban_b is null then '{}'::text[] else array[ban_b] end
       where bans_b = '{}' and ban_b is not null $q$;
  end if;
end $$;

-- The old shape goes, rather than being left beside the new one. Two columns
-- describing the same fact is how the two of them end up disagreeing, and a
-- reader landing on ban_a has no way to tell it is the dead one.
alter table matches drop constraint if exists matches_bans_differ;
alter table matches drop column if exists ban_a;
alter table matches drop column if exists ban_b;

do $$ begin
  -- Four is the ceiling the rules give. The floor is NOT enforced: a match part
  -- way through its bans has one, and refusing to save that would mean bans
  -- could only ever be entered all at once, correctly, first time.
  --
  -- `not (bans_a && bans_b)` is array overlap — the same map banned by both
  -- sides wastes a ban and leaves the pool one bigger than the rules say. Which
  -- side keeps it is not a decision a database should make, so it is refused
  -- rather than tidied.
  --
  -- Duplicates WITHIN one side's list are not expressible as a CHECK without a
  -- subquery; the API dedupes before it writes.
  if not exists (select 1 from pg_constraint where conname = 'matches_bans_sane') then
    alter table matches add constraint matches_bans_sane check (
      cardinality(bans_a) + cardinality(bans_b) <= 4
      and not (bans_a && bans_b)
      and array_position(bans_a, null) is null
      and array_position(bans_b, null) is null
    );
  end if;
end $$;

-- Check — the bans and what was played on:
--   select m.key, m.bans_a, m.bans_b,
--          cardinality(m.bans_a) + cardinality(m.bans_b) as bans,
--          g.game_number, g.map
--     from matches m left join match_games g on g.match_id = m.id
--    where cardinality(m.bans_a) + cardinality(m.bans_b) > 0
--    order by m.bracket, m.round, m.idx, g.game_number;
