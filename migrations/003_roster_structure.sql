-- 003_roster_structure.sql — a team is 8 parties of 6, plus 12 subs.
--
-- Run in the Supabase SQL editor AFTER 002. Safe to re-run.
--
-- ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
-- 001 shipped `roster_size int not null default 6 check (roster_size between 1
-- and 20)`. That was written against a guess — a team of six — and it is not
-- merely a bad default, it is a CHECK that makes the real number unstorable.
-- Setting a roster of 60 failed at the database, and the API refused it before
-- the database got the chance.
--
-- ── WHY roster_size IS NOW GENERATED ────────────────────────────────────────
-- The roster has structure: 8 parties x 6 players, plus 12 substitutes. 60 is
-- not an independent fact, it is the arithmetic of the other three, and storing
-- it as its own editable column means it can disagree with them. A tournament
-- reading "60" beside "8 parties of 6 and 20 subs" is a number nobody can act
-- on, and nothing in the app would flag it.
--
-- Generated columns cannot be altered into existence, so the column is dropped
-- and recreated. The tournaments table holds one row and nothing references
-- roster_size by foreign key, so this costs nothing.

-- ── The parts ───────────────────────────────────────────────────────────────
alter table tournaments
  add column if not exists party_count int not null default 8
    check (party_count between 1 and 24);

alter table tournaments
  add column if not exists party_size int not null default 6
    check (party_size between 1 and 12);

alter table tournaments
  add column if not exists sub_count int not null default 12
    check (sub_count between 0 and 60);

-- ── The total, derived ──────────────────────────────────────────────────────
-- Dropping the column takes its old `between 1 and 20` CHECK with it, which is
-- the constraint that made 60 impossible.
alter table tournaments drop column if exists roster_size;

alter table tournaments
  add column roster_size int
  generated always as (party_count * party_size + sub_count) stored;

-- ── Bring the existing tournament to the real numbers ───────────────────────
-- The seeded row was created with the wrong defaults. These are the defaults
-- above, applied explicitly so a tournament created before this migration ends
-- up identical to one created after it.
update tournaments
   set party_count = 8,
       party_size  = 6,
       sub_count   = 12
 where party_count is distinct from 8
    or party_size  is distinct from 6
    or sub_count   is distinct from 12;

-- After this, `select name, party_count, party_size, sub_count, roster_size
-- from tournaments;` should read 8 / 6 / 12 / 60.
