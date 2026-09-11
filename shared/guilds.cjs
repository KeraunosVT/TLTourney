// shared/guilds.cjs — one guild, however the scoreboard spelled it.
//
// Pure, and deliberately the only place a guild name is turned into a guild.
// The alias rows come from `guild_aliases` (migration 032); the resolving
// happens HERE, at read time, and never on the way in.
//
// ── WHY NOT ON THE WAY IN ───────────────────────────────────────────────────
// Canonicalising during ingest would be less code and is wrong twice over.
//
// The review table shows a reviewer what the screenshot said, beside the
// screenshot; rewriting MILK° to MILK before they see it means the page and the
// picture disagree and the page is the one that looks right. And guild_name is
// the evidence column — 012 says so about the whole block it sits in — so the
// stored row has to stay the row as it was read.
//
// Resolving at read time also makes an alias RETROACTIVE and reversible: adding
// one re-counts every board ever uploaded, and deleting it puts them back.
// Baking it in at ingest would fix only the uploads that came after, and the
// boards already committed would keep whatever the read happened to produce.

/**
 * Tidy a guild name for comparison, without changing what it says.
 *
 * The same gentleness as scoreboard.cjs's `normalizeName`, and for the same
 * reason: these names are `MILK°`, `JAILEDシ`, `Lotus花粉`, `ABG Garden っ`.
 * Stripping "non-standard" characters to make matching easier would fold
 * genuinely different guilds into each other, and a wrong merge is invisible
 * where a missed one is merely a name too many in a list.
 */
const normalizeGuild = (name) => String(name || '').trim().replace(/\s+/g, ' ');

/** The comparison key: case and internal spacing are noise, glyphs are not. */
const guildKey = (name) => normalizeGuild(name).toLowerCase();

/**
 * Turn `guild_aliases` rows into the map `canonicalGuild` wants.
 *
 * Last writer wins on a duplicate key, which cannot happen through the database
 * — `guild_aliases_one_per_alias` is a unique index on lower(btrim(alias)) —
 * but can happen to a caller that merged two lists by hand.
 */
function aliasMap(rows) {
  const map = new Map();
  (rows || []).forEach((r) => {
    const from = guildKey(r.alias);
    const to = normalizeGuild(r.canonical);
    // A self-alias is refused by the database too. Dropped rather than stored,
    // because storing it makes every lookup of that name a pointless hop.
    if (!from || !to || from === to.toLowerCase()) return;
    map.set(from, to);
  });
  return map;
}

/**
 * What this spelling COUNTS AS.
 *
 * @param name     the guild as the scoreboard read it
 * @param aliases  Map from `aliasMap`, or null for "no aliases known"
 *
 * Three outcomes:
 *   an alias        → the canonical name, in the casing the alias row stores
 *   anything else   → the name itself, tidied but otherwise untouched
 *   nothing at all  → null
 *
 * NULL, not 'Unknown'. A row whose guild never read is a row with no guild, and
 * bucketing those under a word makes a guild out of a failure to read one —
 * with a player count that would put it mid-table.
 *
 * ONE HOP. If the canonical name is itself an alias, that is not followed; see
 * migration 032 for why, and for the query that finds those rows.
 */
function canonicalGuild(name, aliases) {
  const key = guildKey(name);
  if (!key) return null;
  return aliases?.get?.(key) || normalizeGuild(name);
}

const EMPTY = { kills: 0, assists: 0, damage_dealt: 0, damage_taken: 0, healing: 0 };

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Every guild that has appeared on a scoreboard, and how much of it there is.
 *
 * @param rows     player_match_stats rows — guild_name, team_id, signup_id,
 *                 player_name and the five stat columns
 * @param aliases  Map from `aliasMap`
 *
 * Returns { guilds, noGuild, spellings }:
 *
 *   guilds     biggest first, each with `players`, `rows`, `byTeam` and totals.
 *   noGuild    rows whose guild column never read. COUNTED, NOT LISTED as a
 *              guild — the same rule the leaderboard applies to rows with no
 *              player, and for the same reason: it is not a fact about anybody.
 *   spellings  per guild, the raw spellings that fed it. This is what makes an
 *              alias checkable after the fact: a guild whose `spellings` holds
 *              three entries is either three aliases working or one mistake.
 *
 * PLAYERS AND ROWS ARE DIFFERENT NUMBERS. A best-of-three puts one player on
 * three rows, and counting rows would say a guild fielded three times the
 * people it did. Players are counted by signup_id where there is one and by
 * name where there is not, so an unmatched row still counts as somebody rather
 * than as nobody.
 */
function guildTally(rows, aliases) {
  const by = new Map();
  let noGuild = 0;

  (rows || []).forEach((r) => {
    const name = canonicalGuild(r.guild_name, aliases);
    if (!name) { noGuild += 1; return; }

    const key = name.toLowerCase();
    if (!by.has(key)) {
      by.set(key, {
        name,
        rows: 0,
        people: new Set(),
        spellings: new Set(),
        byTeam: new Map(),
        ...EMPTY,
      });
    }

    const e = by.get(key);
    e.rows += 1;
    e.people.add(r.signup_id || `name:${guildKey(r.player_name)}`);
    e.spellings.add(normalizeGuild(r.guild_name));
    if (r.team_id) e.byTeam.set(r.team_id, (e.byTeam.get(r.team_id) || 0) + 1);
    e.kills += num(r.kills);
    e.assists += num(r.assists);
    e.damage_dealt += num(r.damage_dealt);
    e.damage_taken += num(r.damage_taken);
    e.healing += num(r.healing);
  });

  const guilds = [...by.values()]
    .map(({ people, spellings, byTeam, ...e }) => ({
      ...e,
      players: people.size,
      spellings: [...spellings].sort(),
      byTeam: Object.fromEntries(byTeam),
    }))
    .sort((a, b) => b.players - a.players || b.kills - a.kills || a.name.localeCompare(b.name));

  return { guilds, noGuild };
}

module.exports = { normalizeGuild, guildKey, aliasMap, canonicalGuild, guildTally };
