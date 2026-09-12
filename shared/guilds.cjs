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
/** A fresh accumulator, shaped the way a guild is. */
const bucket = (name) => ({
  name, rows: 0, people: new Set(), spellings: new Set(), byTeam: new Map(), ...EMPTY,
});

function guildTally(rows, aliases) {
  const by = new Map();
  // Which guilds each player's rows claim. One person cannot be in two guilds
  // on one night, so two entries here is a misread — see `conflicts` below.
  const claims = new Map();

  // The rows whose guild never read, accumulated exactly like a guild rather
  // than counted. They are not a guild and must never sort among them — but
  // they are a real set of players with real numbers, and "how many turned up
  // with nothing in that column" is a question the tally should be able to
  // answer with more than a total.
  const nobody = bucket('Guildless');

  // One row into one bucket. Shared by the guilds and by the guildless, so the
  // two can never drift into counting differently — a guildless bar drawn from
  // rows beside guild bars drawn from people would be a chart comparing two
  // different things without saying so.
  const add = (e, r, who) => {
    e.rows += 1;
    e.people.add(who);
    if (String(r.guild_name || '').trim()) e.spellings.add(normalizeGuild(r.guild_name));

    // PEOPLE PER TEAM, not rows per team. These sat beside `players` as though
    // they were the same kind of number, and counted rows — so on a night where
    // every team played once they agreed, and on the next night the segments
    // summed to twice the bar. A Set per team, for the reason `people` is one.
    if (r.team_id) {
      if (!e.byTeam.has(r.team_id)) e.byTeam.set(r.team_id, new Set());
      e.byTeam.get(r.team_id).add(who);
    }
    e.kills += num(r.kills);
    e.assists += num(r.assists);
    e.damage_dealt += num(r.damage_dealt);
    e.damage_taken += num(r.damage_taken);
    e.healing += num(r.healing);
  };

  (rows || []).forEach((r) => {
    const name = canonicalGuild(r.guild_name, aliases);
    const who = r.signup_id || `name:${guildKey(r.player_name)}`;

    // No guild read. Counted in full, and deliberately NOT recorded as a claim:
    // an unread column is an absence, and it cannot disagree with the rows that
    // do name a guild.
    if (!name) { add(nobody, r, who); return; }

    const key = name.toLowerCase();
    if (!by.has(key)) by.set(key, bucket(name));

    // Keyed the way the tally itself is keyed — on the lowercased canonical
    // name. Keying on the display name would call `Gear Gap` and `gear gap` two
    // guilds here while counting them as one above, and report a disagreement
    // the tally does not have.
    if (!claims.has(who)) {
      claims.set(who, { player_name: r.player_name, guilds: new Map(), spellings: new Set() });
    }
    const claim = claims.get(who);
    claim.guilds.set(key, name);
    claim.spellings.add(normalizeGuild(r.guild_name));

    add(by.get(key), r, who);
  });

  const finish = ({ people, spellings, byTeam, ...e }) => ({
    ...e,
    players: people.size,
    spellings: [...spellings].sort(),
    byTeam: Object.fromEntries([...byTeam].map(([team, who]) => [team, who.size])),
    // Somebody TRADED mid-season played for two teams, so the per-team counts
    // can add up to more than `players`. Rare and real, and said out loud
    // because a stacked bar drawn from byTeam would otherwise silently run
    // past the length of its own bar.
    playedForTwo: [...people].filter(
      (p) => [...byTeam.values()].filter((who) => who.has(p)).length > 1
    ).length,
  });

  const guilds = [...by.values()]
    .map(finish)
    .sort((a, b) => b.players - a.players || b.kills - a.kills || a.name.localeCompare(b.name));

  // ── The players whose own rows disagree ───────────────────────────────────
  // The best evidence there is that two spellings are one guild, and it costs
  // one pass. A player appears on one scoreboard per game; if game 1 says MILK
  // and game 2 says MILK&deg;, that is not two guilds — one person cannot be in
  // two on one night. It is the same trailing-glyph misread the alias table
  // exists for, caught by the data arguing with itself rather than by somebody
  // noticing two similar names in a list of thirty.
  //
  // Deliberately AFTER aliasing, so a pair already folded together never
  // appears: an alias that is doing its job produces one name here, and what is
  // left is the aliases nobody has written yet.
  const conflicts = [...claims.values()]
    .filter((c) => c.guilds.size > 1)
    .map((c) => ({
      player_name: c.player_name,
      guilds: [...c.guilds.values()].sort(),
      // The raw spellings behind them — the thing to paste into an alias row.
      spellings: [...c.spellings].sort(),
    }))
    .sort((a, b) => a.player_name.localeCompare(b.player_name));

  return {
    guilds,
    // OUTSIDE `guilds`, not sorted among them. Guildless is not a guild, and a
    // caller ranking guilds by size must never be able to hand back "Guildless"
    // as the fourth biggest. Null when every row named one, so a page can leave
    // the bar off entirely rather than drawing an empty one.
    guildless: nobody.rows > 0 ? finish(nobody) : null,
    // The row count, kept as it was — the pages that only wanted a footnote
    // still read this, and it is the same number as guildless.rows.
    noGuild: nobody.rows,
    conflicts,
  };
}

module.exports = { normalizeGuild, guildKey, aliasMap, canonicalGuild, guildTally };
