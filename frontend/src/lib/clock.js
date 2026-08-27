// The pick clock, as the browser sees it.
//
// The countdown is computed from the SERVER's idea of now, not the browser's. A
// machine whose clock is forty seconds fast would otherwise show forty seconds
// wrong — confidently, in 96px type, on a live stream — and there is no way for
// a viewer to tell. Every draft response carries `serverTime` alongside the
// deadline for exactly this; the difference between the two clocks is measured
// when the response lands and applied to every tick afterwards.
//
// It is deliberately not re-derived on every render: the skew is captured once
// per fetch and held, so the number counts down smoothly between polls instead
// of jumping each time a response arrives.
import { useEffect, useRef, useState } from 'react';

/**
 * Seconds left on the clock, ticking. Null when nothing is running.
 *
 * @param deadline   ISO string from drafts.pick_deadline, or null
 * @param serverTime ISO string of when the server answered
 */
export function useCountdown(deadline, serverTime) {
  const skew = useRef(0);
  const [, tick] = useState(0);

  // How far this browser's clock is ahead of the server's. Measured on arrival,
  // so it also absorbs the request's own latency — which biases the countdown a
  // few hundred milliseconds SHORT, which is the right direction to be wrong in
  // for a deadline.
  useEffect(() => {
    if (!serverTime) return;
    skew.current = Date.now() - new Date(serverTime).getTime();
  }, [serverTime]);

  // 4Hz. Fast enough that the seconds change on the second rather than up to a
  // second late, cheap enough to leave running.
  useEffect(() => {
    if (!deadline) return undefined;
    const id = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [deadline]);

  if (!deadline) return null;
  const left = (new Date(deadline).getTime() - (Date.now() - skew.current)) / 1000;
  return Math.max(0, left);
}

/** 102 → "1:42". Always mm:ss, because a bare "102" is not a time. */
export function mmss(seconds) {
  if (seconds === null || seconds === undefined) return '—:—';
  const s = Math.ceil(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 55680 → "15h 28m". For a draft length nobody wants read out in seconds. */
export function humanDuration(seconds) {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}
