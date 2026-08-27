// Reading the draft from the unauthenticated stream route.
//
// Shared by /watch and /pool, which poll the same endpoint and differ only in
// whether they render the player list. Written once because the caching below
// is fiddly enough that two copies of it would drift.
import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';

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

  const status = state?.draft?.status;
  useEffect(() => {
    const id = setInterval(load, status === 'live' ? 2000 : 10000);
    return () => clearInterval(id);
  }, [status, load]);

  return { state, failed, reload: load };
}
