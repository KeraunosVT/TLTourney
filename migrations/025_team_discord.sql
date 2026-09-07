-- 025_team_discord.sql — each team's own Discord, and the four that exist.
--
-- Run in the Supabase SQL editor AFTER 024. Safe to re-run.
--
-- A drafted player's next question is "where do I go", and until now the answer
-- was for somebody to notice the pick and message them by hand. This is the
-- column behind the DM that answers it: backend/draft.js messages a player when
-- they are drafted, with their new team's invite in it.
--
-- Nullable, and staying that way. A team without an invite still drafts; its
-- players get the DM without a link rather than no DM at all, because "you were
-- drafted by Team Snoopy" is worth sending on its own.
--
-- ── Validated in code, not here ─────────────────────────────────────────────
-- The CHECK below only pins the scheme. Whether a URL is a Discord INVITE is
-- decided by shared/invites.cjs, which the Teams form and the API both call —
-- the rule that matters is the HOST, because this link goes out in a DM from
-- the tournament bot to somebody expecting exactly that message. That is the
-- most trusted link this app sends, and an arbitrary destination inside it is a
-- phishing template with the bot's name on it. Expressed as a SQL regex it
-- would be a third copy of the rule, disagreeing with the other two the first
-- time it changed.

alter table teams
  add column if not exists discord_url text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'teams_discord_url_https') then
    alter table teams add constraint teams_discord_url_https
      check (discord_url is null or discord_url like 'https://%');
  end if;
end $$;

-- ── The four teams that exist ───────────────────────────────────────────────
-- Matched BY NAME, which is the only handle available from a migration — the
-- ids are generated. Names are editable (a team can be renamed from the Teams
-- page), so this is a one-time seed rather than anything to rely on: it sets a
-- link where there is none and never overwrites one.
--
-- Scoped to the running season for the same reason every backfill since 018 is:
-- an archived tournament's teams are history and their invites have expired.
--
-- If a name here does not match, that team simply gets no link and the field is
-- on the Teams page — check the verify query at the bottom rather than assuming
-- it worked.
update teams t
   set discord_url = v.url
  from (values
    ('Team Snoopy',     'https://discord.gg/S2KsfEesB'),
    ('EGIRL GAP',       'https://discord.gg/4zAhxvPWK'),
    ('Unc'' Graveyard', 'https://discord.gg/SqJnD5VGz'),
    ('The Hamstars',    'https://discord.gg/DnxFdnPT4')
  ) as v(name, url)
 where t.name = v.name
   and t.discord_url is null
   and exists (select 1 from tournaments o
                where o.id = t.tournament_id and o.status <> 'complete');

-- Check — WHICH TEAMS GOT ONE, and which did not. Run this: a name that did not
-- match is silent above and would only show up on draft night as a player
-- asking where to go.
--   select t.name, coalesce(t.discord_url, '— none —') as invite
--     from teams t
--     join tournaments o on o.id = t.tournament_id
--    where o.status <> 'complete'
--    order by t.seed;
