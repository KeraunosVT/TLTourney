// backend/db.js — the Supabase client, plus the two reads everything needs.
//
// This points at the TLTourney Supabase project, which is a different project
// from the guild app's. The service key bypasses row-level security, so it must
// never reach the browser — every read below happens on the server.
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

if (!supabase) {
  console.warn('⚠️  Supabase is not configured — set SUPABASE_URL and SUPABASE_SERVICE_KEY. Data routes will return 503.');
}

// The tournament the app is currently working on: the oldest one that isn't
// finished. Deliberately not "the newest row" — creating next season's
// tournament shouldn't yank the current one out from under a draft.
//
// Cached briefly. Every request reads it, it changes when an organizer clicks a
// button, and a few seconds of staleness on a status change is invisible.
const CACHE_MS = 5000;
let cached = null;
let cachedAt = 0;

async function currentTournament({ fresh = false } = {}) {
  if (!supabase) return null;
  if (!fresh && cached && Date.now() - cachedAt < CACHE_MS) return cached;

  const { data, error } = await supabase
    .from('tournaments')
    .select('*')
    .neq('status', 'complete')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('currentTournament failed:', error.message);
    return cached; // stale beats nothing; a null here 503s every page
  }
  cached = data || null;
  cachedAt = Date.now();
  return cached;
}

function invalidateTournament() {
  cached = null;
  cachedAt = 0;
}

// Append to the audit log. Never throws: a decision that succeeded must not be
// reported as failed because the log write didn't land.
async function audit(user, action, target, detail) {
  if (!supabase) return;
  try {
    await supabase.from('audit_log').insert({
      actor_id: user?.id || null,
      actor_name: user?.username || null,
      action,
      target: target || null,
      detail: detail || null,
    });
  } catch (err) {
    console.warn('audit write failed:', err.message);
  }
}

module.exports = { supabase, currentTournament, invalidateTournament, audit };
