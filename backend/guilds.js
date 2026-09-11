// backend/guilds.js — the alias map, read once and kept for a minute.
//
// The resolving itself is in shared/guilds.cjs, which is pure and tested. This
// is only the read, and the two things the read has to survive.
const { supabase } = require('./db');
const { aliasMap } = require('../shared/guilds.cjs');

// A minute, not the five seconds currentTournament uses. That one changes when
// an organizer clicks a button and is read on every request; this changes when
// somebody notices a misread guild name, which is a thing that happens a few
// times a season.
const CACHE_MS = 60_000;

let cached = null;
let cachedAt = 0;

/**
 * Every alias, as the map shared/guilds.cjs wants.
 *
 * NEVER THROWS, and that is the point. Guild names are a garnish on a page
 * whose job is scoreboards: if this read fails, the right outcome is a match
 * page with unresolved guild spellings on it, not a 500 where a scoreboard
 * used to be.
 *
 * The case that matters is a database where 032 has not been applied — which is
 * every database until somebody runs it, including on the night somebody
 * deploys this. PostgREST answers that with a schema-cache error rather than an
 * empty list, so it is caught here and cached as "no aliases known", which is
 * exactly what such a database means.
 */
async function guildAliases({ fresh = false } = {}) {
  if (!supabase) return new Map();
  if (!fresh && cached && Date.now() - cachedAt < CACHE_MS) return cached;

  const { data, error } = await supabase.from('guild_aliases').select('alias, canonical');

  if (error) {
    // Said once and quietly. A missing table is a migration nobody has run yet,
    // not a fault, and logging it per request would bury the real errors.
    if (!/schema cache|does not exist|relation/i.test(error.message)) {
      console.error('guild alias read failed:', error.message);
    }
    cached = new Map();
    cachedAt = Date.now();
    return cached;
  }

  cached = aliasMap(data || []);
  cachedAt = Date.now();
  return cached;
}

/** For tests and for a route that has just written one. */
const forgetAliases = () => { cached = null; cachedAt = 0; };

module.exports = { guildAliases, forgetAliases };
