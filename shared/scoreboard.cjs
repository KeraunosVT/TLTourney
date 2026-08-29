// shared/scoreboard.cjs — turning scoreboard rows into people, and people into
// numbers.
//
// Everything here is pure. The Gemini read is in backend/ingest.js and the
// database work is in backend/results.js; this is the part in between, which is
// the part that can be wrong without anybody noticing.
//
// Adapted from Gear-Gap's playerStats.js. The shape is the same and the reason
// for it is worth keeping — aggregation pulled out of the route so it can be
// tested — but the SPLIT is different. Gear-Gap divides rows into "our guild"
// and "everyone else" by guild name. A tournament match has two known teams
// with known rosters, and the interesting division is which of them a row
// belongs to, decided once at review time and stored as an id.

const { classify } = require('./classes.cjs');

// ── Matching a name to a person ─────────────────────────────────────────────
/**
 * Normalise an in-game name for comparison.
 *
 * Deliberately gentle. Case and surrounding whitespace are noise and always
 * safe to drop. Everything else is kept, because Throne & Liberty names are
 * full of characters that matter: `Blond凶`, `メMomo`, `龍𝓛𝓤𝓒𝓗𝓞` are real
 * names in this tournament's pool, and stripping "non-standard" characters
 * would collapse distinct players into each other — which is worse than
 * failing to match, because a failed match is visible and a wrong one is not.
 *
 * Internal whitespace is collapsed rather than removed: OCR routinely reads
 * `z e r o` with inconsistent spacing, and `zero` should not become the same
 * string as a genuinely different name.
 */
const normalizeName = (name) => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Attach each scoreboard row to a rostered player, where that can be done
 * safely.
 *
 * @param rows    scoreboard rows, each with a `player_name`
 * @param roster  [{ id, player_name, team_id }] — everyone on either team
 *
 * Returns rows with `signup_id`, `team_id` and `match_note` filled in.
 *
 * THREE outcomes, and the third is the one that earns this function:
 *
 *   matched     exactly one rostered player has that name
 *   unmatched   nobody does — an opponent, a spectator, a mangled read
 *   ambiguous   MORE THAN ONE does, so it is left unmatched on purpose
 *
 * Two people genuinely can pick the same name (migration 001 says so, and
 * declines to stop them). Guessing between them would attribute a night's
 * statistics to the wrong person with nothing on screen to suggest a choice
 * was ever made. Left for the human, who can see both rosters.
 */
function linkRows(rows, roster) {
  const byName = new Map();
  (roster || []).forEach((p) => {
    const key = normalizeName(p.player_name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(p);
  });

  return (rows || []).map((r) => {
    const candidates = byName.get(normalizeName(r.player_name)) || [];
    if (candidates.length === 1) {
      return { ...r, signup_id: candidates[0].id, team_id: candidates[0].team_id, match_note: 'matched' };
    }
    return {
      ...r,
      signup_id: null,
      team_id: null,
      match_note: candidates.length > 1 ? 'ambiguous' : 'unmatched',
    };
  });
}

/** How the review went, for the line above the table. */
function linkSummary(linked) {
  const rows = linked || [];
  return {
    total: rows.length,
    matched: rows.filter((r) => r.signup_id).length,
    unmatched: rows.filter((r) => !r.signup_id && r.match_note !== 'ambiguous').length,
    ambiguous: rows.filter((r) => r.match_note === 'ambiguous').length,
  };
}

// ── Which side was which ────────────────────────────────────────────────────
/**
 * Work out which of the two teams played Yellow and which played Red.
 *
 * The scoreboard splits everybody into two colours, and until now that column
 * was stored and used for nothing — each row's team came from whichever roster
 * its NAME matched. That is backwards. A scoreboard row belongs to a side
 * because of the side it was on, and the name only says which person it is.
 *
 * Reading it the other way round costs the case that actually matters: a
 * mismatched or mis-OCR'd name silently put somebody on the wrong team, and
 * nothing on the page disagreed with itself.
 *
 * The mapping is INFERRED by vote rather than assumed, because nothing on the
 * screenshot says "Yellow is The Hamstars" — only the players do. Every
 * confidently matched row is a vote for its colour belonging to its roster's
 * team, and the majority wins. The organizer can override it either way.
 *
 * Returns { sides: { Yellow, Red }, votes, confident }.
 */
function inferSides(rows, roster) {
  const teamOf = new Map((roster || []).map((p) => [p.id, p.team_id]));
  const votes = { Yellow: {}, Red: {} };

  (rows || []).forEach((r) => {
    const colour = r.team_color;
    const team = teamOf.get(r.signup_id);
    if (!votes[colour] || !team) return;
    votes[colour][team] = (votes[colour][team] || 0) + 1;
  });

  const winner = (colour) => {
    const tally = Object.entries(votes[colour]);
    if (!tally.length) return null;
    tally.sort((a, b) => b[1] - a[1]);
    // A tie is not an answer. Two teams with equal votes for one colour means
    // the read is too confused to guess from, and guessing would put half a
    // roster on the wrong side.
    if (tally.length > 1 && tally[0][1] === tally[1][1]) return null;
    return tally[0][0];
  };

  let Yellow = winner('Yellow');
  let Red = winner('Red');

  // Both colours cannot be the same team. If the votes say so, the weaker
  // reading loses its answer rather than both being wrong.
  if (Yellow && Yellow === Red) {
    const yStrength = votes.Yellow[Yellow] || 0;
    const rStrength = votes.Red[Red] || 0;
    if (yStrength >= rStrength) Red = null; else Yellow = null;
  }

  // One side known is enough to place the other, since a match has exactly two.
  const teams = [...new Set([...teamOf.values()].filter(Boolean))];
  if (teams.length === 2) {
    if (Yellow && !Red) Red = teams.find((t) => t !== Yellow) || null;
    if (Red && !Yellow) Yellow = teams.find((t) => t !== Red) || null;
  }

  return {
    sides: { Yellow, Red },
    votes,
    confident: !!(Yellow && Red && Yellow !== Red),
  };
}

/**
 * Put every row on the side its COLOUR says, and flag the rows that argue.
 *
 * `team_id` now comes from the colour. Where the matched person's roster
 * disagrees with it, the row is flagged rather than quietly corrected: one of
 * the two readings is wrong — a misread colour or a misread name — and which
 * one it is takes a human looking at the screenshot.
 */
function applySides(rows, sides, roster) {
  const teamOf = new Map((roster || []).map((p) => [p.id, p.team_id]));

  return (rows || []).map((r) => {
    const fromColour = sides?.[r.team_color] || null;
    const fromRoster = teamOf.get(r.signup_id) || null;
    const conflict = !!(fromColour && fromRoster && fromColour !== fromRoster);

    return {
      ...r,
      // Colour first. A row with no readable colour keeps whatever the name
      // gave it, which is better than nothing and is visible as "no side".
      team_id: fromColour || fromRoster,
      side_conflict: conflict,
      match_note: conflict ? 'side-conflict' : r.match_note,
    };
  });
}

/** Candidates for a row: only the side it played on, when that is known. */
function candidatesFor(row, roster, sides) {
  const team = sides?.[row.team_color] || null;
  if (!team) return roster || [];
  return (roster || []).filter((p) => p.team_id === team);
}

// ── Many screenshots, one scoreboard ────────────────────────────────────────
/**
 * Merge the pages of a paginated scoreboard into a single set of rows.
 *
 * A 50v50 shows a dozen rows at a time, so a full board is ten screenshots, and
 * people overlap them deliberately so nothing falls between two shots. Merging
 * them is therefore the normal case, not an edge one.
 *
 * KEYED ON RANK, NOT ON NAME. Gear-Gap's version dedupes by lowercase name,
 * which is the obvious choice and is wrong here for the same reason names are
 * not identity anywhere else in this file: two players genuinely can share one,
 * and merging by name would silently fuse them into a single row with one set
 * of statistics. The scoreboard's own rank is unique down the whole board and
 * stable across pages, so it is the key; a row with no readable rank falls back
 * to its name, because half a key beats none.
 *
 * Nothing is silently discarded:
 *   · identical duplicates collapse, and are counted
 *   · the same rank with DIFFERENT numbers keeps the first and says so — an
 *     OCR misread of a stat, which somebody should look at
 *   · the same rank with different NAMES keeps BOTH rows, because that is a
 *     misread rank and dropping either would lose a player entirely
 *
 * @param pages [{ name, players }] — one entry per uploaded file
 */
function mergePages(pages) {
  const seen = new Map();
  const rows = [];
  const conflicts = [];
  let duplicates = 0;

  const STATS = ['kills', 'assists', 'damage_dealt', 'damage_taken', 'healing'];

  (pages || []).forEach((page) => {
    (page.players || []).forEach((p) => {
      const rank = Number(p.rank);
      const key = Number.isInteger(rank) && rank > 0
        ? `r:${rank}`
        : `n:${normalizeName(p.player_name)}`;

      const prior = seen.get(key);
      if (!prior) {
        seen.set(key, { row: p, from: page.name });
        rows.push(p);
        return;
      }

      // Same slot, different person: a misread rank. Keep both and let the
      // review decide — dropping one loses a player from the record entirely.
      if (normalizeName(prior.row.player_name) !== normalizeName(p.player_name)) {
        conflicts.push(
          `Rank ${rank} reads as "${prior.row.player_name}" in ${prior.from} and `
          + `"${p.player_name}" in ${page.name} — both kept, delete whichever is wrong.`
        );
        rows.push(p);
        return;
      }

      const differs = STATS.filter((f) => Number(prior.row[f] || 0) !== Number(p[f] || 0));
      if (differs.length) {
        conflicts.push(
          `${p.player_name} appears in ${prior.from} and ${page.name} with different `
          + `${differs.join(', ')} — kept the first, check it.`
        );
      } else {
        duplicates += 1;
      }
    });
  });

  rows.sort((a, b) => (Number(a.rank) || 9999) - (Number(b.rank) || 9999));
  return { rows, duplicates, conflicts };
}

// ── One player's history ────────────────────────────────────────────────────
const num = (v) => {
  // bigint columns can arrive as strings from PostgREST when they are large
  // enough, and `undefined + 3` is NaN forever after. Both are silent.
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const EMPTY_TOTALS = { kills: 0, assists: 0, damage_dealt: 0, damage_taken: 0, healing: 0 };

/**
 * Everything one player did across the tournament.
 *
 * @param rows  their player_match_stats rows, each with an embedded `match`
 *              ({ id, key, bracket, round, label, scheduled_at }) — may be null.
 */
function playerProfile(rows) {
  const totals = { ...EMPTY_TOTALS };
  const classCount = {};
  const history = [];
  let orphaned = 0;

  (rows || []).forEach((r) => {
    // The match embed is a left join, so a row whose match has been deleted
    // arrives with null here rather than being absent. Reading `.key` off it
    // throws, and in Gear-Gap exactly this 500'd an entire profile over one
    // orphaned row. Counted instead, so a short history explains itself.
    const m = r.match;
    if (!m) { orphaned += 1; return; }

    totals.kills += num(r.kills);
    totals.assists += num(r.assists);
    totals.damage_dealt += num(r.damage_dealt);
    totals.damage_taken += num(r.damage_taken);
    totals.healing += num(r.healing);

    const cls = classify(r.weapon_1, r.weapon_2);
    classCount[cls] = (classCount[cls] || 0) + 1;

    history.push({
      match_id: m.id,
      key: m.key,
      label: m.label || null,
      bracket: m.bracket,
      round: m.round,
      played_at: m.scheduled_at || r.created_at || null,
      rank: r.rank,
      weapon_1: r.weapon_1,
      weapon_2: r.weapon_2,
      class: cls,
      kills: num(r.kills),
      assists: num(r.assists),
      damage_dealt: num(r.damage_dealt),
      damage_taken: num(r.damage_taken),
      healing: num(r.healing),
    });
  });

  // Most recent first. A match with no date sorts last rather than to the top,
  // which is what `new Date(null)` would do — that is the epoch, and it would
  // put an undated match ahead of everything.
  history.sort((a, b) => {
    if (!a.played_at && !b.played_at) return (b.key || '').localeCompare(a.key || '');
    if (!a.played_at) return 1;
    if (!b.played_at) return -1;
    return new Date(b.played_at) - new Date(a.played_at);
  });

  const played = history.length;
  return {
    ...totals,
    matches: played,
    history,
    // Guarded, not because a crash would be bad but because 0/0 is NaN, and NaN
    // renders as "NaN" on a leaderboard and sorts unpredictably against numbers.
    avg_kills: played ? totals.kills / played : 0,
    avg_assists: played ? totals.assists / played : 0,
    avg_damage: played ? totals.damage_dealt / played : 0,
    avg_taken: played ? totals.damage_taken / played : 0,
    avg_healing: played ? totals.healing / played : 0,
    classes: Object.entries(classCount)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    orphaned,
  };
}

// ── Everybody, ranked ───────────────────────────────────────────────────────
/**
 * The tournament leaderboard.
 *
 * @param rows    every player_match_stats row with a signup_id
 * @param people  Map of signup id -> { player_name, team_id, role }
 *
 * Rows with no signup_id are DROPPED, not bucketed into an "unknown" entry.
 * They are opponents and misreads; a leaderboard line called "unmatched" with
 * the summed damage of forty strangers is not a fact about anybody.
 */
function leaderboard(rows, people) {
  const by = new Map();

  (rows || []).forEach((r) => {
    if (!r.signup_id) return;
    if (!by.has(r.signup_id)) {
      const who = people?.get?.(r.signup_id) || {};
      by.set(r.signup_id, {
        signup_id: r.signup_id,
        player_name: who.player_name || r.player_name,
        team_id: who.team_id ?? r.team_id ?? null,
        role: who.role || null,
        matches: 0,
        classes: {},
        ...EMPTY_TOTALS,
      });
    }
    const e = by.get(r.signup_id);
    e.matches += 1;
    e.kills += num(r.kills);
    e.assists += num(r.assists);
    e.damage_dealt += num(r.damage_dealt);
    e.damage_taken += num(r.damage_taken);
    e.healing += num(r.healing);
    const cls = classify(r.weapon_1, r.weapon_2);
    e.classes[cls] = (e.classes[cls] || 0) + 1;
  });

  return [...by.values()].map((e) => ({
    ...e,
    // The class they played MOST, not the one from their latest match — a
    // healer who flexed to DPS once is still a healer.
    main_class: Object.entries(e.classes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || null,
    classes: Object.entries(e.classes).map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    avg_kills: e.matches ? e.kills / e.matches : 0,
    avg_damage: e.matches ? e.damage_dealt / e.matches : 0,
    avg_healing: e.matches ? e.healing / e.matches : 0,
  }));
}

// Columns a leaderboard can be sorted by, and how. Named here rather than in the
// page so the server can sort the same way the client labels it.
const SORTS = {
  damage_dealt: { label: 'Damage', total: true },
  healing: { label: 'Healing', total: true },
  kills: { label: 'Kills', total: true },
  assists: { label: 'Assists', total: true },
  damage_taken: { label: 'Damage taken', total: true },
  avg_damage: { label: 'Damage / match', total: false },
  avg_healing: { label: 'Healing / match', total: false },
  avg_kills: { label: 'Kills / match', total: false },
  matches: { label: 'Matches', total: true },
};

const isSort = (key) => Object.prototype.hasOwnProperty.call(SORTS, key);

/** Sort descending by a known column, with a stable tiebreak on name. */
function rank(entries, by = 'damage_dealt') {
  const key = isSort(by) ? by : 'damage_dealt';
  return [...(entries || [])].sort(
    (a, b) => (b[key] || 0) - (a[key] || 0) || a.player_name.localeCompare(b.player_name)
  );
}

module.exports = {
  normalizeName, linkRows, linkSummary, mergePages, inferSides, applySides, candidatesFor,
  playerProfile, leaderboard, rank, SORTS, isSort,
};
