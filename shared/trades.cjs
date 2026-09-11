// shared/trades.cjs — is this trade one the tournament can actually make?
//
// Pure, and the only place the rules live. The route does the reads and the
// writes; every refusal comes from here, so the message an organizer sees at
// the top of the form and the message the server gives back are the same
// sentence — and a rule added here is enforced in both places at once.
//
// ── WHAT THIS DELIBERATELY DOES NOT REFUSE ──────────────────────────────────
// Lopsided trades. Two-for-one leaves one roster a player short and the other a
// player long, and that is a real thing organizers do — covering a no-show, or
// undoing a draft that went wrong. The manual roster add already declines to
// enforce roster_size for the same reason (teams.js), and refusing here would
// send people back to editing rows by hand, which is the thing this replaces.
//
// The sizes are RETURNED instead, before and after, so the consequence is on
// screen in advance rather than discovered on the bracket.

const { VIA_CAPTAIN } = require('./roster.cjs');

/**
 * @param moves    [{ signup_id, from_team_id, to_team_id }] as the form sent them
 * @param rosters  Map of team id -> [{ id, player_name, via, playing }]
 * @param teams    [{ id, name }] — the two teams in the trade
 *
 * Returns { ok, errors, moves, sizes }:
 *
 *   errors  every problem, not the first. A trade is built as a whole — six
 *           players picked across two rosters — and reporting one refusal per
 *           attempt is six round trips through the same form.
 *   moves   the same moves with the names and `via` filled in from the roster,
 *           which is what gets written to the trades table. Never taken from
 *           the request body: a name in a body is a claim, and this one ends up
 *           in a permanent record.
 *   sizes   per team, `before` and `after`, so the form can say what this does
 *           to both rosters before anybody presses the button.
 */
function validateTrade(moves, rosters, teams) {
  const errors = [];
  const list = Array.isArray(moves) ? moves : [];
  const byTeam = rosters instanceof Map ? rosters : new Map();
  const teamList = (teams || []).filter(Boolean);
  const nameOf = new Map(teamList.map((t) => [t.id, t.name]));

  if (teamList.length !== 2) {
    errors.push('A trade needs two teams.');
  } else if (teamList[0].id === teamList[1].id) {
    errors.push('A team cannot trade with itself.');
  }

  if (list.length === 0) {
    errors.push('Pick at least one player to move.');
  }

  // One player, one move. Sending somebody twice — from a double click, or from
  // picking them on both sides — would write two moves, and the second would
  // either fail or quietly undo the first depending on the order they applied.
  const seen = new Set();
  const duplicated = new Set();
  list.forEach((m) => {
    if (!m?.signup_id) return;
    if (seen.has(m.signup_id)) duplicated.add(m.signup_id);
    seen.add(m.signup_id);
  });

  const resolved = [];

  list.forEach((m, i) => {
    const where = `Move ${i + 1}`;
    const from = m?.from_team_id;
    const to = m?.to_team_id;

    if (!m?.signup_id || !from || !to) {
      errors.push(`${where} is missing a player or a team.`);
      return;
    }

    if (from === to) {
      errors.push(`${where}: that player is already on that team.`);
      return;
    }

    // Both ends have to be in the trade. Moving somebody to a third team is a
    // different operation with different consequences for a third roster
    // nobody in this form is looking at.
    if (teamList.length === 2 && (!nameOf.has(from) || !nameOf.has(to))) {
      errors.push(`${where}: both teams have to be the two teams in this trade.`);
      return;
    }

    const roster = byTeam.get(from) || [];
    const member = roster.find((p) => p.id === m.signup_id);

    // THE check that matters. A roster read a minute ago and a trade submitted
    // now are two different moments, and in between somebody can have been
    // moved by another organizer, cut, or traded already.
    if (!member) {
      errors.push(
        `${where}: that player is not on ${nameOf.get(from) || 'that team'} — `
        + 'the rosters may have changed since this page loaded.'
      );
      return;
    }

    // A captain is on their roster BECAUSE they captain it (migration 008).
    // Moving the row would leave team_captains pointing at somebody who plays
    // for another team, and the captain seat is the thing that decides who may
    // draft, who may edit the comp, and whose Discord account is trusted for
    // that team. Unseat them first — that is a decision with its own endpoint
    // and its own consequences, not a side effect of a trade.
    if (member.via === VIA_CAPTAIN) {
      errors.push(
        `${member.player_name} captains ${nameOf.get(from) || 'that team'} — `
        + 'remove the captain seat before trading them.'
      );
      return;
    }

    if (duplicated.has(m.signup_id)) {
      errors.push(`${member.player_name} is in this trade twice.`);
      return;
    }

    resolved.push({
      signup_id: m.signup_id,
      player_name: member.player_name,
      from_team_id: from,
      from_team: nameOf.get(from) || null,
      to_team_id: to,
      to_team: nameOf.get(to) || null,
      via: member.via,
      // Recorded because it is the fact that makes this trade the only way to
      // move them — a drafted player cannot be removed from a roster at all.
      was_drafted: member.via === 'draft',
    });
  });

  return {
    ok: errors.length === 0,
    // Deduplicated: the same sentence twice (two captains in one trade, say)
    // reads as a page repeating itself rather than as two problems.
    errors: [...new Set(errors)],
    moves: resolved,
    sizes: rosterSizes(teamList, byTeam, resolved),
  };
}

/**
 * What each roster looks like before and after.
 *
 * Counts EVERYBODY on the roster, playing or not, because that is what the
 * roster page shows and what the trade changes. The compensation pick's
 * playing/non-playing split (migration 028) is a separate question and is not
 * re-asked here — a trade moves a person, not their willingness to play.
 */
function rosterSizes(teams, rosters, moves) {
  return (teams || []).map((team) => {
    const before = (rosters.get(team.id) || []).length;
    const out = moves.filter((m) => m.from_team_id === team.id).length;
    const into = moves.filter((m) => m.to_team_id === team.id).length;
    return {
      team_id: team.id,
      name: team.name,
      before,
      after: before - out + into,
      out,
      in: into,
    };
  });
}

/**
 * One line saying what happened, for the audit log and the history list.
 *
 * Written from the MOVES rather than from the two team names, because a
 * lopsided trade reads wrong otherwise: "A traded with B" says nothing about
 * two players going one way and none coming back.
 */
function describeTrade(moves) {
  const list = moves || [];
  if (list.length === 0) return 'nothing moved';

  const bySide = new Map();
  list.forEach((m) => {
    const key = `${m.from_team || m.from_team_id} → ${m.to_team || m.to_team_id}`;
    if (!bySide.has(key)) bySide.set(key, []);
    bySide.get(key).push(m.player_name);
  });

  return [...bySide].map(([way, names]) => `${names.join(', ')} ${way}`).join('; ');
}

module.exports = { validateTrade, rosterSizes, describeTrade };
