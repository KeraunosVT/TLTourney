// shared/autopick.cjs — who the clock picks when nobody does.
//
// An auto-pick is not a fallback nobody cares about. It is the pick a captain
// gets when their power went out, and it is the one they will still be talking
// about in three weeks. It has to be defensible.
//
// So the order is: honour their board first, then their roster's needs, and
// only then reach for something arbitrary. A captain who spent an evening
// ranking the pool has already told the site what they wanted; taking the
// alphabetically-first available player instead would be throwing that away at
// the exact moment it was most useful.
//
// Pure — no database, no clock. Everything it needs is handed in, which is what
// lets the whole decision be tested without a draft running.

const { ROLES } = require('./roles.cjs');
const { tierMeta } = require('./board.cjs');

/**
 * Pick for a team that didn't pick for itself.
 *
 * @param board  Their board entries, ALREADY filtered to available players:
 *               [{ signup_id, tier, rank }].
 * @param pool   Available players, in name order: [{ id, player_name, role }].
 * @param roster Who they already have: [{ role }].
 * @param demand roleDemand(template, 1) — the per-role minimum for ONE roster.
 *
 * Returns { signupId, reason } or null when there is nobody left to pick.
 * `reason` is written to be read out: it ends up in the audit log, in the pick
 * feed, and in the DM.
 */
function autoPick(board = [], pool = [], roster = [], demand = {}) {
  if (!pool.length) return null;
  const available = new Set(pool.map((p) => p.id));

  // ── 1. Their board ────────────────────────────────────────────────────────
  // Lowest tier wins, then lowest rank inside it. The Avoid pile is skipped
  // outright: a captain who put somebody there said "not this player", and an
  // auto-pick that hands them exactly that person is worse than one that picks
  // a stranger.
  const ranked = board
    .filter((e) => available.has(e.signup_id) && !tierMeta(e.tier)?.exclude)
    .sort((a, b) => (a.tier - b.tier) || ((a.rank ?? 0) - (b.rank ?? 0)));

  if (ranked.length) {
    const top = ranked[0];
    const meta = tierMeta(top.tier);
    return {
      signupId: top.signup_id,
      reason: `top of your board — ${meta?.label || `tier ${top.tier}`}, #${(top.rank ?? 0) + 1}`,
    };
  }

  // ── 2. The role they are shortest of ──────────────────────────────────────
  // No board, or every player on it is gone. Fall back to the thing the roster
  // itself says: which role has the furthest to go against the minimum one team
  // needs. Biggest shortfall first, because a roster missing four healers and
  // one tank needs a healer more than it needs a tank.
  const have = {};
  ROLES.forEach((r) => { have[r] = 0; });
  roster.forEach((m) => { if (have[m.role] !== undefined) have[m.role] += 1; });

  const shortfalls = ROLES
    .map((role) => ({ role, short: (demand[role]?.min ?? 0) - have[role] }))
    .filter((r) => r.short > 0)
    .sort((a, b) => b.short - a.short || ROLES.indexOf(a.role) - ROLES.indexOf(b.role));

  for (const { role, short } of shortfalls) {
    const match = pool.find((p) => p.role === role);
    if (match) {
      return {
        signupId: match.id,
        reason: `nothing left on your board — you were ${short} short at ${role}`,
      };
    }
  }

  // ── 3. Anybody ────────────────────────────────────────────────────────────
  // Every role is covered, or nobody in the pool plays the role that isn't.
  // Pool order is the caller's; the backend passes it in name order so this is
  // at least stable and explicable rather than whatever the database returned.
  return {
    signupId: pool[0].id,
    reason: 'nothing left on your board and every role covered — first available',
  };
}

module.exports = { autoPick };
