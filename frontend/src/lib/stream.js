// Reading the draft from the unauthenticated stream route.
//
// Shared by /watch and /pool, which poll the same endpoint and differ only in
// whether they render the player list. Written once because the caching below
// is fiddly enough that two copies of it would drift.
import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';

/**
 * How often to ask, given what the draft is doing. Exported because /draft
 * polls the authed route on the same rule and a second copy of these numbers
 * is a second thing to forget.
 *
 * The server collapses concurrent callers into one database read every 1.2s,
 * so this does NOT scale with how many people are watching — it scales with
 * whether a browser is open at all. Which is why the idle numbers are the ones
 * that matter: a draft runs for an evening, a forgotten tab runs for a month.
 */
export const pollMs = (status) => {
  if (status === 'live') return 2000;
  if (status === 'paused') return 10000;
  // COMPLETE IS IMMUTABLE. Every pick is in, the rosters are final, and the
  // order will never change again — there is nothing to find out. Five minutes
  // rather than stopping outright, because these pages are left open for weeks
  // and one of them is an OBS source: a draft that is reset and re-run has to
  // reach a screen nobody is going to refresh by hand.
  if (status === 'complete') return 300000;
  return 60000;
};

/**
 * How often to re-read the BRACKET, given what it is doing.
 *
 * It was a flat ten seconds — 360 reads an hour to watch something that changes
 * a few times a night, and not at all for most of a season. Every tier below is
 * the same argument the draft's rates are built on: match the rate to how fast
 * the thing can actually change.
 *
 *   no bracket   nothing exists to change until an organizer draws it
 *   champion     the tournament is OVER and the bracket is final
 *   otherwise    a result can land at any moment, and this is the broadcast
 *
 * The middle case is the only one that has to be quick, and it is quick for one
 * reason: /watch's bracket scene is on air. A result recorded during a stream
 * showing up half an hour later is worse than any number of reads.
 */
export const bracketPollMs = (bracket) => {
  if (!bracket?.exists) return 900000;      // 15 min
  if (bracket.champion) return 1800000;     // 30 min — twice an hour, and even that is generous
  return 60000;
};

/**
 * Poll the draft. Returns { state, failed, reload }.
 *
 * When `wantPool` is true, `state.pool` is the list of available players —
 * held locally between changes rather than re-fetched every poll. The server
 * stamps a `poolVersion`; we send back the version of the list we are holding,
 * and it sends a list only when ours is out of date.
 *
 * That turns the steady state from twenty kilobytes every two seconds into
 * roughly nothing, which matters because the pool is now part of the broadcast
 * and every browser watching pays for it.
 */
export function useStreamDraft(wantPool = false) {
  const [state, setState] = useState(null);
  const [failed, setFailed] = useState(null);

  const inFlight = useRef(false);
  const everLoaded = useRef(false);
  const pool = useRef(null);         // the list we are holding
  const poolVersion = useRef(null);  // the version THAT list is, not the latest seen
  const want = useRef(wantPool);

  useEffect(() => { want.current = wantPool; }, [wantPool]);

  const load = useCallback(async () => {
    // A slow response must not stack up behind the poll — draft night keeps
    // this page open for hours, and one stalled request would become twenty.
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const params = new URLSearchParams();
      if (want.current) {
        params.set('pool', '1');
        // Only when we actually hold a list. `poolVersion` tracks the version
        // of the list in hand, NOT the last version the server mentioned — set
        // from the latter, a poll that arrived without a list would make us
        // claim to hold something we don't and we would render a stale pool
        // forever.
        if (pool.current && poolVersion.current) params.set('have', poolVersion.current);
      }
      const qs = params.toString();
      const { data } = await axios.get(`/api/stream/draft${qs ? `?${qs}` : ''}`);

      if (data.pool) {
        pool.current = data.pool;
        poolVersion.current = data.poolVersion ?? null;
      }

      setState({ ...data, pool: want.current ? (data.pool || pool.current) : undefined });
      everLoaded.current = true;
      setFailed(null);
    } catch (err) {
      // A dropped poll is not worth showing on a broadcast — the last good
      // frame stays up and the next poll fixes it. Only a page that has NEVER
      // loaded says anything, and then it says what the server said.
      if (!everLoaded.current) {
        setFailed(err?.response?.data?.error || 'Waiting for the draft…');
      }
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Asking for the pool for the first time should not wait for the next tick.
  useEffect(() => { if (wantPool) load(); }, [wantPool, load]);

  // How often to ask, by what the draft is actually doing.
  //
  // 'live' is the only state where two seconds earns anything: a pick lands
  // every minute or two and the page should show it promptly. Paused is nearly
  // as urgent — it can resume at any moment — but nothing changes while it
  // sits there, so ten seconds is enough to catch the resume.
  //
  // PENDING AND COMPLETE POLL SLOWLY, and that is the change that matters for
  // the bill rather than the page. Neither can change without an organizer
  // pressing something, and these pages are left open for weeks between drafts
  // -- on /watch, on a spare monitor, indefinitely.
  //
  // Complete is the slowest of all because it is the only IMMUTABLE one: every
  // pick is in and the rosters are final, so a poll can learn nothing. It still
  // polls at all only so a draft that is reset and re-run reaches a screen
  // nobody is going to refresh by hand.
  const status = state?.draft?.status;
  useEffect(() => {
    const id = setInterval(load, pollMs(status));
    return () => clearInterval(id);
  }, [status, load]);

  return { state, failed, reload: load };
}
