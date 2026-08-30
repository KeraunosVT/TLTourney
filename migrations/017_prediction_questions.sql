-- 017_prediction_questions.sql — questions an organizer writes.
--
-- Run in the Supabase SQL editor AFTER 016. Safe to re-run.
--
-- 016 predicts matches: the same question, over and over, scored by the
-- bracket. This is everything else worth asking. "Does the grand final go to a
-- reset?" "Which team tops the damage chart?" "How many games does the final
-- run?" Written by an organizer, answered by anyone, settled by hand.
--
-- MULTIPLE CHOICE, always, and that is a deliberate limit rather than a first
-- version. A free-text answer has to be graded by a person: "HAM", "The
-- Hamstars" and "hamstars" are one answer typed three ways, and somebody has to
-- rule on that at midnight with the stream still running. Fixed options make
-- "who got it right" mechanical — a fact, not a judgement call.

create table if not exists prediction_questions (
  id             uuid primary key default gen_random_uuid(),
  tournament_id  uuid not null references tournaments(id) on delete cascade,

  prompt         text not null,

  -- [{ id: 'o1', label: 'Yes' }, …] — 2 to 8 of them.
  --
  -- A jsonb array rather than an options table because an option has no life of
  -- its own: it is never queried, never joined to, and never exists apart from
  -- the question that lists it. What it does need is a STABLE id, so that
  -- relabelling "Hamstars" to "The Hamstars" does not orphan the answers
  -- already given to it — the API assigns ids and never reuses one.
  options        jsonb not null default '[]'::jsonb,

  -- What getting it right is worth. Per question, because these are not all the
  -- same size: calling the reset is not the same bet as naming the champion's
  -- top healer.
  points         int not null default 10,

  -- When answering stops. NULL means "open until an organizer settles it",
  -- which is right for a question whose moment is not on a schedule.
  closes_at      timestamptz,

  -- The answer, once there is one. NULL means unsettled, and an unsettled
  -- question scores nobody — not even zero.
  correct_option_id text,

  -- The situation never arose, so there is no right answer and nobody scores.
  -- Separate from correct_option_id rather than a magic value in it, because
  -- voiding has to beat an answer left over from before somebody changed their
  -- mind about it.
  void           boolean not null default false,

  created_by     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'prediction_questions_points_range') then
    alter table prediction_questions add constraint prediction_questions_points_range
      check (points >= 1 and points <= 100);
  end if;

  -- Two to eight. One option is not a question, and nine is a form nobody
  -- reads. The app says the same thing in words; this is what stops a direct
  -- write from producing a question that cannot be answered.
  if not exists (select 1 from pg_constraint where conname = 'prediction_questions_option_count') then
    alter table prediction_questions add constraint prediction_questions_option_count
      check (jsonb_typeof(options) = 'array'
             and jsonb_array_length(options) between 2 and 8);
  end if;
end $$;

create index if not exists prediction_questions_tournament_idx
  on prediction_questions (tournament_id, created_at);

drop trigger if exists prediction_questions_touch on prediction_questions;
create trigger prediction_questions_touch
  before update on prediction_questions
  for each row execute function touch_updated_at();

-- ── The answers ─────────────────────────────────────────────────────────────
create table if not exists question_answers (
  id             uuid primary key default gen_random_uuid(),
  tournament_id  uuid not null references tournaments(id) on delete cascade,
  question_id    uuid not null references prediction_questions(id) on delete cascade,

  discord_id     text not null,
  display_name   text not null,

  -- The id of the chosen option, from the question's own jsonb list. Not a
  -- foreign key — there is no options table to point at — so the app checks it
  -- against the question on the way in, and answerSplit ignores an option that
  -- has since been removed rather than counting it into a total.
  option_id      text not null,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

do $$ begin
  -- One answer per person per question. The same rule 016 puts on match picks,
  -- and for the same reason: without it, changing your answer inserts a second
  -- row and the standings count both.
  if not exists (select 1 from pg_constraint where conname = 'question_answers_one_per_person') then
    alter table question_answers add constraint question_answers_one_per_person
      unique (question_id, discord_id);
  end if;
end $$;

create index if not exists question_answers_question_idx on question_answers (question_id);
create index if not exists question_answers_person_idx on question_answers (tournament_id, discord_id);

drop trigger if exists question_answers_touch on question_answers;
create trigger question_answers_touch
  before update on question_answers
  for each row execute function touch_updated_at();

-- Check — every question, how it was answered, and who was right:
--   select q.prompt, a.display_name, a.option_id,
--          (a.option_id = q.correct_option_id) as correct
--     from question_answers a
--     join prediction_questions q on q.id = a.question_id
--    order by q.created_at, correct desc nulls last, a.display_name;
--
-- Check — an answer that arrived after its question closed:
--   select q.prompt, a.display_name, a.updated_at, q.closes_at
--     from question_answers a join prediction_questions q on q.id = a.question_id
--    where q.closes_at is not null and a.updated_at > q.closes_at;
