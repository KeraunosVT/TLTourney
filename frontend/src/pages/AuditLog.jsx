// /audit — every organizer decision, read back.
//
// The log has always been written. This is the first page that reads it: who
// approved, rejected, seated a captain, added a substitute, drafted, or
// resolved a match, and when. What "who decided this" is unanswerable without
// reproducing the failure, this is where the answer already lives.
//
// Loaded a page at a time on a keyset cursor rather than everything at once —
// the log has no natural end, and a live tournament writes to it constantly,
// so "load everything" would mean re-reading a growing table on every visit.
import { useCallback, useEffect, useState } from 'react';
import api, { errorMessage } from '../api';
import { Panel, Button, Empty, Note } from '../components/ui';
import { whenLocal } from '../lib/clock';

// Action names are dotted (team.roster.add, signup.approved) rather than
// prose, because they are also what a filter box matches against — a name
// that is already a stable token needs no separate display string to keep in
// step with it.
const ACTION_LABELS = {
  'signup.approved': 'Signup approved',
  'signup.rejected': 'Signup rejected',
  'signup.approve_all': 'Bulk-approved signups',
  'tournament.create': 'Season created',
  'tournament.update': 'Tournament settings changed',
  'team.create': 'Team created',
  'team.update': 'Team renamed / reseeded',
  'team.delete': 'Team deleted',
  'team.reseed': 'Teams reseeded',
  'team.captain.add': 'Captain seated',
  'team.captain.remove': 'Captain unseated',
  'team.roster.add': 'Player added to roster',
  'team.roster.remove': 'Player removed from roster',
  'draft.start': 'Draft started',
  'draft.pause': 'Draft paused',
  'draft.resume': 'Draft resumed',
  'draft.pick': 'Pick made',
  'draft.pick_for': 'Pick made for a team',
  'draft.undo': 'Pick undone',
  'draft.settings': 'Draft settings changed',
  'draft.reset': 'Draft reset',
  'bracket.generate': 'Bracket generated',
  'bracket.result': 'Match result recorded',
  'bracket.undo': 'Match result undone',
  'bracket.clear': 'Bracket cleared',
  'bracket.schedule': 'Match scheduled',
  'bracket.best_of': 'Match length changed',
  'bracket.bans': 'Map bans set',
  'bracket.game': 'Game recorded',
  'bracket.game.remove': 'Game removed',
  'scoreboard.commit': 'Scoreboard committed',
  'scoreboard.clear': 'Scoreboard cleared',
  'predictions.question.add': 'Prediction question added',
  'predictions.question.edit': 'Prediction question edited',
  'predictions.question.settle': 'Prediction question settled',
  'predictions.question.remove': 'Prediction question removed',
};

const actionLabel = (a) => ACTION_LABELS[a] || a;

export default function AuditLog() {
  const [rows, setRows] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [banner, setBanner] = useState(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);   // id of the row whose detail is expanded

  const load = useCallback(async (before) => {
    const params = before ? { before } : {};
    const { data } = await api.get('/api/organizer/audit', { params });
    return data;
  }, []);

  const loadFirst = useCallback(async () => {
    setLoading(true);
    setBanner(null);
    try {
      const data = await load();
      setRows(data.rows || []);
      setHasMore(!!data.hasMore);
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err, 'Could not load the audit log.') });
    } finally {
      setLoading(false);
    }
  }, [load]);

  // Loaded once, on mount.
  useEffect(() => { loadFirst(); }, [loadFirst]);

  async function loadMore() {
    const last = rows[rows.length - 1];
    if (!last) return;
    setLoadingMore(true);
    setBanner(null);
    try {
      const data = await load(last.id);
      setRows((r) => [...r, ...(data.rows || [])]);
      setHasMore(!!data.hasMore);
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
    } finally {
      setLoadingMore(false);
    }
  }

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? rows.filter((r) => (
      actionLabel(r.action).toLowerCase().includes(needle)
      || r.action.toLowerCase().includes(needle)
      || (r.actor_name || '').toLowerCase().includes(needle)
      || (r.target || '').toLowerCase().includes(needle)
    ))
    : rows;

  if (loading) return <div className="p-8 text-sm text-ash">Loading…</div>;

  return (
    <div className="px-6 py-7 max-w-[1180px] mx-auto">
      <header className="flex items-end justify-between gap-5 flex-wrap mb-5">
        <div>
          <h1 className="font-display text-[27px]">Audit log</h1>
          <p className="text-ash text-sm mt-1.5 max-w-[64ch]">
            Every decision an organizer has made — approvals, teams, the draft, the bracket,
            scoreboards. Newest first.
          </p>
        </div>
        <input
          type="search"
          className="field-input max-w-[240px] py-1.5 text-[13px]"
          placeholder="Search action, actor or target…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search the audit log"
        />
      </header>

      {banner && <div className="mb-4"><Note tone={banner.tone}>{banner.text}</Note></div>}

      <Panel title={null}>
        {shown.length === 0 ? (
          <Empty>
            {q ? 'Nothing matches that search on the page loaded so far.' : 'Nothing has been logged yet.'}
          </Empty>
        ) : (
          <div className="flex flex-col">
            {shown.map((r) => (
              <AuditRow
                key={r.id}
                row={r}
                expanded={open === r.id}
                onToggle={() => setOpen((o) => (o === r.id ? null : r.id))}
              />
            ))}
          </div>
        )}
      </Panel>

      {hasMore && (
        <div className="mt-4 flex justify-center">
          <Button variant="ghost" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}

      {!hasMore && rows.length > 0 && (
        <p className="text-xs text-ash mt-3 text-center">That's everything.</p>
      )}
    </div>
  );
}

// One entry. The detail is a JSON blob nobody wants staring at them by
// default — it's there for the one time in twenty somebody needs to see
// exactly what changed, not for the other nineteen reads of this page.
function AuditRow({ row, expanded, onToggle }) {
  const hasDetail = row.detail && (typeof row.detail !== 'object' || Object.keys(row.detail).length > 0);
  return (
    <div className="border-b border-line/50 last:border-b-0">
      <button
        onClick={hasDetail ? onToggle : undefined}
        className={`w-full text-left px-4 py-2.5 flex items-start gap-3 flex-wrap ${
          hasDetail ? 'cursor-pointer hover:bg-panelup/60' : 'cursor-default'
        }`}
      >
        <span className="text-[13px] font-medium flex-1 min-w-[200px]">
          {actionLabel(row.action)}
        </span>
        <span className="text-[12px] text-ash whitespace-nowrap">
          {row.actor_name || 'the system'}
        </span>
        {row.target && (
          <span className="mono text-[11px] text-ash whitespace-nowrap max-w-[220px] truncate" title={row.target}>
            {row.target}
          </span>
        )}
        <span className="text-[11px] text-ash whitespace-nowrap">{whenLocal(row.created_at)}</span>
        {hasDetail && (
          <span className="text-[11px] text-ash w-4 text-center">{expanded ? '−' : '+'}</span>
        )}
      </button>
      {expanded && hasDetail && (
        <pre className="mx-4 mb-3 p-3 rounded border border-line bg-panelup/60 text-[11.5px] overflow-x-auto">
          {JSON.stringify(row.detail, null, 2)}
        </pre>
      )}
    </div>
  );
}
