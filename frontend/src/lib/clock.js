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

// ── Wall-clock times ────────────────────────────────────────────────────────
// Everything the app stores is an instant (timestamptz). Everything a person
// reads is a wall clock in THEIR timezone, with the zone named — a tournament
// spread across a continent argues about "8pm" otherwise, and only finds out
// who was right when somebody turns up an hour late.
//
// These lived in three pages before this. Three copies of a date formatter is
// three chances for one of them to quietly drop the timezone.

/** An instant, in the reader's own time. */
export function whenLocal(iso) {
  if (!iso) return 'not set';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'an invalid date';
  return d.toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

/** The same, short enough for a bracket card. No zone — the page says it once. */
export function whenShort(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/**
 * An instant → the value a `datetime-local` input wants.
 *
 * Deliberately NOT toISOString().slice(0,16), which is the obvious one-liner
 * and is wrong: that is UTC, so the input would show a time hours away from
 * the one that was set. Built from the local getters instead.
 */
export function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** And back. A `datetime-local` value is local wall-clock; Date reads it as such. */
export function fromLocalInput(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 55680 → "15h 28m". For a draft length nobody wants read out in seconds. */
export function humanDuration(seconds) {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/**
 * Time until something, at the resolution somebody actually wants it.
 *
 * "2h 14m" an hour out, "4:37" in the last stretch. Two formats rather than
 * one because they answer different questions: far away, nobody is counting
 * seconds and a ticking mm:ss is noise on a broadcast; close in, the seconds
 * are the whole point and "0m" is useless.
 *
 * Lives here beside the other two rather than in the page that needed it,
 * because a fourth private copy of "how long is that" is a fourth chance to
 * round it differently.
 */
export function countdownLabel(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds <= 0) return 'now';
  return seconds < 600 ? mmss(seconds) : humanDuration(seconds);
}
