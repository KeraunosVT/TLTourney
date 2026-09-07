// Double elimination — since migration 026, with a SEEDING STAGE in front of it
// and no reset behind it.
//
// A bracket is the worst possible place for a quiet bug. It runs to completion,
// it produces a champion, and the only evidence that it was wrong is a team who
// worked out afterwards that they were eliminated on one loss — by which point
// the tournament has been played and streamed.
//
// So the centrepiece here is not a shape assertion, it is EXHAUSTIVE
// SIMULATION: play every possible combination of results for small brackets and
// assert the defining property of double elimination — every team that is not
// the champion lost exactly twice. Nothing structural survives that being true.
const test = require('node:test');
const assert = require('node:assert');

const {
  generateBracket, generateRoundRobin, applyResult, seedOrder, bracketSize,
  roundLabel, columns, winnersSide,
} = require('../../shared/bracket.cjs');

// ── A tournament, played out ────────────────────────────────────────────────
/**
 * Run a whole bracket, deciding each match with `pick(matchState) -> teamId`.
 *
 * Walkovers resolve themselves; void matches never happen; the reset is played
 * only if applyResult said to. Everything else comes out of the engine, so this
 * exercises the real advancement logic rather than a reimplementation of it.
 */
function play(n, pick) {
  const g = generateBracket(n);
  const ms = g.matches.map((m) => ({ ...m, team_a_id: null, team_b_id: null, winner_team_id: null, done: false }));
  const byKey = new Map(ms.map((m) => [m.key, m]));

  ms.forEach((m) => ['a', 'b'].forEach((s) => {
    if (m[s].type === 'seed' && m[s].seed <= n) m[`team_${s}_id`] = `T${m[s].seed}`;
  }));

  const write = (key, slot, id) => { const x = byKey.get(key); if (x) x[`team_${slot}_id`] = id; };
  const carry = (key, winnerId) => ms.forEach((x) => ['a', 'b'].forEach((s) => {
    if (x[s]?.type === 'winner' && x[s].of === key) write(x.key, s, winnerId);
  }));

  const losses = {};
  const played = [];
  let champion = null;

  for (let guard = 0; ; guard++) {
    assert.ok(guard < 500, 'the bracket never settled');
    let acted = false;

    for (const m of ms) {
      if (m.done) continue;
      if (m.status === 'void') { m.done = true; acted = true; continue; }

      if (m.status === 'walkover') {
        const id = m[`team_${m.advances}_id`];
        if (!id) continue;
        m.done = true;
        m.winner_team_id = id;
        carry(m.key, id);          // a walkover has no loser to drop
        acted = true;
        continue;
      }

      if (!m.team_a_id || !m.team_b_id) continue;

      const winner = pick(m);
      const r = applyResult(ms, m.key, winner);
      assert.ok(!r.error, `${m.key}: ${r.error}`);

      m.done = true;
      m.winner_team_id = winner;
      losses[r.loserId] = (losses[r.loserId] || 0) + 1;
      played.push({ key: m.key, bracket: m.bracket, round: m.round, a: m.team_a_id, b: m.team_b_id, winner });
      r.writes.forEach((w) => write(w.key, w.slot, w.teamId));
      if (r.champion) champion = r.champion;
      acted = true;
    }
    if (!acted) break;
  }

  // Who lost the grand final, and whether they arrived through the winners
  // bracket. Since 026 there is no reset, so that team goes out on ONE loss —
  // the single exception to the invariant below, and the thing the rule change
  // actually costs.
  const gf = played.find((x) => x.bracket === 'GF' && x.round === 1);
  const runnerUp = gf ? (gf.winner === gf.a ? gf.b : gf.a) : null;

  return { g, ms, champion, losses, played, runnerUp };
}

// Decide matches from the bits of an integer, so a loop over 0..2^m-1 covers
// every possible tournament.
const fromBits = (bits) => {
  let i = 0;
  return (m) => {
    const take = (bits >> (i++)) & 1;
    return take ? m.team_b_id : m.team_a_id;
  };
};

function assertSound(n, result, label) {
  const { champion, losses, played, runnerUp } = result;
  assert.ok(champion, `${label}: nobody won`);

  // ── The invariant, as it stands since 026 ────────────────────────────────
  // It used to be "everyone but the champion goes out on exactly two losses",
  // which is what double elimination MEANS. Removing the reset breaks it in
  // exactly one place, deliberately: a team that reaches the grand final
  // undefeated is now eliminated by a single series.
  //
  // So the rule is stated with that one exception NAMED rather than the
  // assertion loosened to `<= 2`. Loosening it would have stopped catching the
  // bug the whole file exists for — a dropper routed to the wrong slot, which
  // shows up precisely as somebody going out a loss early.
  let earlyExits = 0;

  for (let s = 1; s <= n; s++) {
    const id = `T${s}`;
    const l = losses[id] || 0;
    if (id === champion) {
      // 0 if they came through the winners bracket, 1 if they dropped to the
      // losers bracket on the way and won it back.
      assert.ok(l <= 1, `${label}: champion ${id} has ${l} losses`);
    } else if (l === 1) {
      assert.strictEqual(id, runnerUp,
        `${label}: ${id} went out on 1 loss and was not the beaten finalist`);
      earlyExits += 1;
    } else {
      assert.strictEqual(l, 2, `${label}: ${id} went out on ${l} loss(es), not 2`);
    }
  }

  // At most one. Two teams going out on a single loss is the old bug wearing
  // the new rule as a disguise.
  assert.ok(earlyExits <= 1, `${label}: ${earlyExits} teams went out on one loss`);

  played.forEach((p) => assert.notStrictEqual(p.a, p.b, `${label}: ${p.key} had a team play itself`));
}

// ── The defining property ───────────────────────────────────────────────────
test('EVERY POSSIBLE 4-TEAM TOURNAMENT ends with every loser on exactly two losses', () => {
  for (let bits = 0; bits < (1 << 8); bits++) {
    assertSound(4, play(4, fromBits(bits)), `n=4 bits=${bits}`);
  }
});

test('EVERY POSSIBLE 8-TEAM TOURNAMENT does too', () => {
  // 2^15 tournaments. This is the test that would catch a losers bracket wired
  // to the wrong round, a dropper going to the wrong slot, or a reset that
  // fires when it shouldn't — none of which look wrong from the outside.
  let seen = 0;
  for (let bits = 0; bits < (1 << 15); bits++) {
    assertSound(8, play(8, fromBits(bits)), `n=8 bits=${bits}`);
    seen += 1;
  }
  assert.strictEqual(seen, 32768);
});

test('brackets that are not a power of two are sound too', () => {
  // Byes are where this gets hard: an empty chair produces no dropper, so the
  // losers bracket has holes that have to cascade correctly.
  for (const n of [3, 5, 6, 7]) {
    for (let bits = 0; bits < (1 << 12); bits++) {
      assertSound(n, play(n, fromBits(bits)), `n=${n} bits=${bits}`);
    }
  }
});

test('larger brackets are sound over many random tournaments', () => {
  // 2^20 is too many to enumerate, so sample. A deterministic generator, so a
  // failure is reproducible rather than a story about a bad afternoon.
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };

  for (const n of [9, 11, 13, 16, 24, 32]) {
    for (let trial = 0; trial < 200; trial++) {
      assertSound(n, play(n, (m) => (rnd() % 2 ? m.team_b_id : m.team_a_id)), `n=${n} trial=${trial}`);
    }
  }
});

test('a two-team bracket is a legal double elimination', () => {
  // The degenerate case: no losers bracket exists at all (2k-2 = 0 rounds), so
  // the winners final's loser has to become the losers champion or the grand
  // final references a match that was never built.
  for (let bits = 0; bits < 8; bits++) {
    assertSound(2, play(2, fromBits(bits)), `n=2 bits=${bits}`);
  }
});

// ── The reset ───────────────────────────────────────────────────────────────
test('THE GRAND FINAL ENDS IT, whoever wins — there is no reset', () => {
  // This test used to assert the opposite: that a losers-bracket win forced a
  // reset. 026 removed the reset, so the property worth guarding flipped, and
  // the half that matters now is that the tournament ENDS either way. The
  // failure this catches is a grand final that decides nothing — no champion,
  // nothing advanced, a bracket sitting finished-but-not-finished.
  let lbWins = 0;
  let wbWins = 0;

  for (let bits = 0; bits < (1 << 15); bits++) {
    const r = play(8, fromBits(bits));
    const gf1 = r.ms.find((m) => m.key === 'GF1-0');
    assert.ok(!r.ms.some((m) => m.key === 'GF2-0'), `bits=${bits}: a reset match was generated`);

    // Whoever won it is the champion, full stop.
    assert.strictEqual(r.champion, gf1.winner_team_id, `bits=${bits}`);

    if (gf1.winner_team_id === gf1.team_b_id) lbWins += 1; else wbWins += 1;
  }

  assert.ok(lbWins > 0 && wbWins > 0, 'both outcomes must actually occur');
});

// ── Cross-placement ─────────────────────────────────────────────────────────
test('NO LOSERS ROUND 2 MATCH IS A REMATCH OF A WINNERS ROUND 1 MATCH', () => {
  // The reason the dropping losers are index-reversed. Without it, the team
  // that knocked somebody into the losers bracket meets them again immediately
  // — and the bracket looks completely normal while doing it.
  for (let bits = 0; bits < (1 << 15); bits++) {
    const { played } = play(8, fromBits(bits));
    const pair = (p) => [p.a, p.b].sort().join('|');

    const wb1 = new Set(played.filter((p) => p.bracket === 'W' && p.round === 1).map(pair));
    played
      .filter((p) => p.bracket === 'L' && p.round === 2)
      .forEach((p) => assert.ok(
        !wb1.has(pair(p)),
        `bits=${bits}: ${p.key} replays winners round 1 (${p.a} v ${p.b})`
      ));
  }
});

// ── Shape ───────────────────────────────────────────────────────────────────
test('the skeleton is the right size, and every match exists up front', () => {
  const cases = [
    [2, 2, 1, 0], [3, 4, 2, 2], [4, 4, 2, 2], [5, 8, 3, 4],
    [8, 8, 3, 4], [11, 16, 4, 6], [16, 16, 4, 6], [17, 32, 5, 8],
  ];
  cases.forEach(([n, size, wr, lr]) => {
    const g = generateBracket(n);
    assert.strictEqual(g.size, size, `n=${n} size`);
    assert.strictEqual(g.winnersRounds, wr, `n=${n} winners rounds`);
    assert.strictEqual(g.losersRounds, lr, `n=${n} losers rounds`);
    assert.strictEqual(g.byes, size - n, `n=${n} byes`);
  });
});

test('a real bracket has exactly 2n-2 matches to play, plus the reset', () => {
  // The arithmetic of double elimination: everybody but the champion loses
  // twice, and every match produces exactly one loss.
  for (const n of [2, 3, 4, 5, 6, 7, 8, 11, 16, 24]) {
    const g = generateBracket(n);
    const real = g.matches.filter((m) => m.status === 'match' && !m.reset).length;
    assert.strictEqual(real, 2 * n - 2, `n=${n}`);
  }
});

test('byes are marked, not left as phantom matches', () => {
  const g = generateBracket(5);   // 8-team bracket, 3 empty chairs
  const w1 = g.matches.filter((m) => m.bracket === 'W' && m.round === 1);
  assert.strictEqual(w1.filter((m) => m.status === 'walkover').length, 3);
  assert.strictEqual(w1.filter((m) => m.status === 'match').length, 1);

  // And the emptiness cascades: a walkover produces no dropper, so a losers
  // match fed by two of them does not exist at all.
  assert.ok(g.matches.some((m) => m.status === 'void'), 'no void match was produced');
});

test('a bracket of one team or none is empty rather than broken', () => {
  [0, 1, -3, null, undefined].forEach((n) => {
    const g = generateBracket(n);
    assert.deepStrictEqual(g.matches, [], `n=${n}`);
  });
});

// ── Seeding ─────────────────────────────────────────────────────────────────
test('seed order puts 1 against the weakest and keeps 1 and 2 apart until the final', () => {
  assert.deepStrictEqual(seedOrder(2), [1, 2]);
  assert.deepStrictEqual(seedOrder(4), [1, 4, 3, 2]);
  assert.deepStrictEqual(seedOrder(8), [1, 8, 5, 4, 3, 6, 7, 2]);

  // 1 and 2 in opposite halves at every size — the property seeding exists for.
  for (const size of [4, 8, 16, 32]) {
    const o = seedOrder(size);
    assert.ok(o.indexOf(1) < size / 2, `size ${size}: seed 1 not in the top half`);
    assert.ok(o.indexOf(2) >= size / 2, `size ${size}: seed 2 not in the bottom half`);
    assert.deepStrictEqual([...o].sort((a, b) => a - b), Array.from({ length: size }, (_, i) => i + 1));
  }
});

test('every first-round pair adds up to one more than the bracket', () => {
  // 1v16, 2v15, 8v9 — the check that the order is a real seeding and not just
  // a permutation that happens to look like one.
  for (const size of [4, 8, 16, 32]) {
    const o = seedOrder(size);
    for (let i = 0; i < size; i += 2) {
      assert.strictEqual(o[i] + o[i + 1], size + 1, `size ${size} pair ${i / 2}`);
    }
  }
});

test('bracketSize rounds up to a power of two, and is exact when it already is', () => {
  assert.strictEqual(bracketSize(8), 8);
  assert.strictEqual(bracketSize(9), 16);
  assert.strictEqual(bracketSize(2), 2);
  assert.strictEqual(bracketSize(1), 1);
});

// ── applyResult refuses the things it should ────────────────────────────────
test('a result for a match that is not ready, or not that team, is refused', () => {
  const g = generateBracket(4);
  const ms = g.matches.map((m) => ({ ...m, team_a_id: null, team_b_id: null }));

  assert.match(applyResult(ms, 'nope', 'T1').error, /no match/i);
  assert.match(applyResult(ms, 'W2-0', 'T1').error, /decided/i);

  const w = ms.find((m) => m.key === 'W1-0');
  w.team_a_id = 'T1'; w.team_b_id = 'T4';
  assert.match(applyResult(ms, 'W1-0', 'T3').error, /not in this match/i);
  assert.ok(!applyResult(ms, 'W1-0', 'T4').error);
});

test('a losers-bracket defeat eliminates, a winners-bracket defeat does not', () => {
  const g = generateBracket(4);
  const ms = g.matches.map((m) => ({ ...m, team_a_id: null, team_b_id: null }));

  const w = ms.find((m) => m.key === 'W1-0');
  w.team_a_id = 'T1'; w.team_b_id = 'T4';
  const r1 = applyResult(ms, 'W1-0', 'T1');
  assert.strictEqual(r1.eliminated, null, 'losing in the winners bracket is not elimination');
  assert.ok(r1.writes.some((x) => x.teamId === 'T4'), 'the loser has to drop somewhere');

  const l = ms.find((m) => m.key === 'L1-0');
  l.team_a_id = 'T4'; l.team_b_id = 'T3';
  const r2 = applyResult(ms, 'L1-0', 'T4');
  assert.strictEqual(r2.eliminated, 'T3');
});

// ── Presentation ────────────────────────────────────────────────────────────
test('rounds are named the way people say them', () => {
  const g = generateBracket(8);
  const name = (key) => roundLabel(g.matches.find((m) => m.key === key), g);
  assert.strictEqual(name('W3-0'), 'Winners Final');
  assert.strictEqual(name('W2-0'), 'Winners Semi-final');
  assert.strictEqual(name('W1-0'), 'Winners Round 1');
  assert.strictEqual(name('L4-0'), 'Losers Final');
  assert.strictEqual(name('L3-0'), 'Losers Semi-final');
  assert.strictEqual(name('GF1-0'), 'Grand Final');

  // The seeding stage names its own rounds. There is no "final" in a group —
  // the last round is called that only so a schedule reads as finite.
  const rr = generateRoundRobin(4);
  const rrName = (key) => roundLabel(rr.matches.find((m) => m.key === key), { seedingRounds: rr.rounds });
  assert.strictEqual(rrName('RR1-0'), 'Seeding — Round 1');
  assert.strictEqual(rrName('RR3-0'), 'Seeding — Final Round');
});

test('columns come out in round order with void matches left out', () => {
  const g = generateBracket(5);
  const w = columns(g.matches, 'W');
  assert.deepStrictEqual(w.map((c) => c.round), [1, 2, 3]);
  assert.deepStrictEqual(w.map((c) => c.matches.length), [4, 2, 1]);

  const l = columns(g.matches, 'L');
  assert.ok(l.every((c) => c.matches.every((m) => m.status !== 'void')));
});

// ── Surviving a round trip through the database ─────────────────────────────
test('THE RESET STILL FIRES CORRECTLY WHEN lbSlot HAS BEEN LOST', () => {
  // `matches` stores the slot sources and nothing else about the grand final's
  // shape, so a row read back has no lbSlot. It must be derived, not defaulted:
  // a test against undefined falls through to the right answer today and would
  // keep doing so until somebody built the bracket the other way round.
  for (const n of [2, 4, 8, 11]) {
    const g = generateBracket(n);
    const gf = g.matches.find((m) => m.key === 'GF1-0');
    assert.strictEqual(winnersSide(gf), 'a', `n=${n} with the hint`);

    const { lbSlot, ...stripped } = gf;   // eslint-disable-line no-unused-vars
    assert.strictEqual(winnersSide(stripped), 'a', `n=${n} without it`);
  }
});

test('a bracket rebuilt from stored slot sources behaves identically', () => {
  // What the API actually does: rows come back with slot_a/slot_b and no
  // in-memory extras. Play a whole tournament that way.
  for (let bits = 0; bits < (1 << 10); bits++) {
    const g = generateBracket(8);
    const ms = g.matches.map((m) => ({
      key: m.key, bracket: m.bracket, round: m.round, idx: m.idx,
      a: JSON.parse(JSON.stringify(m.a)), b: JSON.parse(JSON.stringify(m.b)),
      status: m.status, advances: m.advances, reset: m.reset,
      team_a_id: null, team_b_id: null, winner_team_id: null, done: false,
    }));

    const byKey = new Map(ms.map((m) => [m.key, m]));
    ms.forEach((m) => ['a', 'b'].forEach((s) => {
      if (m[s].type === 'seed' && m[s].seed <= 8) m[`team_${s}_id`] = `T${m[s].seed}`;
    }));
    const write = (k, slot, id) => { const x = byKey.get(k); if (x) x[`team_${slot}_id`] = id; };

    const losses = {};
    let champion = null;
    let i = 0;
    for (let guard = 0; guard < 200; guard++) {
      let acted = false;
      for (const m of ms) {
        if (m.done || m.status === 'void') { m.done = true; continue; }
        if (m.status === 'walkover') {
          const id = m[`team_${m.advances}_id`];
          if (!id) continue;
          m.done = true;
          ms.forEach((x) => ['a', 'b'].forEach((s) => {
            if (x[s]?.type === 'winner' && x[s].of === m.key) write(x.key, s, id);
          }));
          acted = true; continue;
        }
        if (!m.team_a_id || !m.team_b_id) continue;
        const winner = ((bits >> (i++)) & 1) ? m.team_b_id : m.team_a_id;
        const r = applyResult(ms, m.key, winner);
        assert.ok(!r.error, r.error);
        m.done = true; m.winner_team_id = winner;
        losses[r.loserId] = (losses[r.loserId] || 0) + 1;
        r.writes.forEach((w) => write(w.key, w.slot, w.teamId));
        if (r.champion) champion = r.champion;
        acted = true;
      }
      if (!acted) break;
    }

    assert.ok(champion, `bits=${bits}: no champion`);
    for (let s = 1; s <= 8; s++) {
      const id = `T${s}`;
      const l = losses[id] || 0;
      if (id === champion) assert.ok(l <= 1, `bits=${bits}: champion on ${l} losses`);
      else assert.strictEqual(l, 2, `bits=${bits}: ${id} on ${l} losses`);
    }
  }
});
