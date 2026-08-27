// /pool — the available players, on their own.
//
// The same panel that forms the right-hand rail of /watch, given a whole window
// instead of a rail. Kept alongside the rail rather than replaced by it, because
// they are not the same job: the rail is part of the broadcast, and this is for
// a second monitor, a second OBS source, or a viewer who wants to read the list
// properly rather than glance at it.
//
// Sized in PIXELS. /watch is a fixed 16:9 scene so viewport units suit it; this
// opens at whatever size somebody dragged it to, and vh typography in a narrow
// window is unreadable. Same component, different em.
import PoolPanel from '../components/PoolPanel';
import { useCountdown, mmss } from '../lib/clock';
import { useStreamDraft } from '../lib/stream';

export default function Pool() {
  const { state, failed } = useStreamDraft(true);

  const d = state?.draft;
  const left = useCountdown(d?.deadline, d?.serverTime);

  if (!state) {
    return (
      <div className="min-h-screen grid place-items-center p-8">
        <p className="text-sm text-ash text-center max-w-[42ch] leading-relaxed">
          {failed || 'Loading…'}
        </p>
      </div>
    );
  }

  const onClock = (state.teams || []).find((t) => t.id === d?.onClock);

  return (
    <div className="fixed inset-0 flex flex-col bg-ink text-bone">
      {/* Whose pick it is, so the window is self-sufficient. Somebody reading
          this list should not have to look back at the scene to know what is
          happening in the draft it belongs to. */}
      <div className="px-4 py-2 border-b border-line bg-panel/70 flex items-center gap-3 text-[12.5px] shrink-0">
        {d?.status === 'live' ? (
          <>
            <span className="mono text-ash tabular-nums shrink-0">R{d.round}·P{d.currentPick}</span>
            <span className="truncate">{onClock?.name || '—'}</span>
            <span className={`mono ml-auto tabular-nums shrink-0 ${
              left !== null && left <= 30 ? 'text-crimsonbright' : 'text-ash'
            }`}>
              {mmss(left)}
            </span>
          </>
        ) : (
          <span className="text-ash">
            {d?.status === 'complete' ? 'The draft is complete.'
              : d?.status === 'paused' ? 'The draft is paused.'
                : 'The draft has not started.'}
          </span>
        )}
      </div>

      <PoolPanel
        className="flex-1"
        pool={state.pool}
        poolCount={state.poolCount}
        scarcity={state.scarcity}
        style={{ fontSize: '15px' }}
      />
    </div>
  );
}
