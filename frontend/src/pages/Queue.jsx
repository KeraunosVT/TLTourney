import { useCallback, useEffect, useMemo, useState } from 'react';
import api, { errorMessage } from '../api';
import { Panel, Pill, Button, Empty, Note } from '../components/ui';

const TABS = [
  ['pending', 'Awaiting review'],
  ['approved', 'On the board'],
  ['rejected', 'Not accepted'],
  ['withdrawn', 'Withdrawn'],
];

export default function Queue() {
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({});
  const [tournament, setTournament] = useState(null);
  const [dmAvailable, setDmAvailable] = useState(true);
  const [tab, setTab] = useState('pending');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);       // id currently being decided
  const [banner, setBanner] = useState(null);
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/api/organizer/signups');
      setRows(data.signups || []);
      setCounts(data.counts || {});
      setTournament(data.tournament || null);
      setDmAvailable(data.dm);
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err, 'Could not load the queue.') });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows
      .filter((r) => r.status === tab)
      .filter((r) => !needle
        || r.player_name.toLowerCase().includes(needle)
        || (r.discord_username || '').toLowerCase().includes(needle)
        || r.class_name.toLowerCase().includes(needle));
  }, [rows, tab, q]);

  async function decide(row, decision) {
    let note = null;
    if (decision === 'rejected') {
      // Required by the server too — a rejection with no reason just gets
      // resubmitted unchanged.
      note = window.prompt(`Why is ${row.player_name} not accepted? This is DMed to them.`);
      if (note === null) return;
      if (!note.trim()) {
        setBanner({ tone: 'bad', text: 'A rejection needs a reason.' });
        return;
      }
    }
    setBusy(row.id);
    setBanner(null);
    try {
      const { data } = await api.post(`/api/organizer/signups/${row.id}/decision`, { decision, note });
      setRows((rs) => rs.map((r) => (r.id === row.id ? data.signup : r)));
      setCounts((c) => ({
        ...c,
        pending: Math.max(0, (c.pending || 0) - 1),
        [decision]: (c[decision] || 0) + 1,
      }));
      setBanner({
        tone: 'good',
        text: `${row.player_name} ${decision === 'approved' ? 'approved' : 'rejected'}.`
          + (data.dm?.ok === false ? ` DM not delivered (${data.dm.reason}) — tell them yourself.` : ''),
      });
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
      // A 409 means someone else got there first; the queue on screen is stale.
      if (err?.response?.status === 409) load();
    } finally {
      setBusy(null);
    }
  }

  async function approveAll() {
    const n = counts.pending || 0;
    if (!n) return;
    if (!window.confirm(`Approve all ${n} pending signups? Each gets a DM.`)) return;
    setBusy('all');
    try {
      const { data } = await api.post('/api/organizer/signups/approve-all');
      setBanner({
        tone: 'good',
        text: `Approved ${data.approved}.` + (data.skipped ? ` ${data.skipped} were already decided by someone else.` : ''),
      });
      await load();
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  async function setStatus(status) {
    const label = status === 'signups' ? 'open signups' : 'close signups';
    if (!window.confirm(`Really ${label}?${status !== 'signups' ? ' Nobody will be able to file or edit an entry.' : ''}`)) return;
    try {
      const { data } = await api.put('/api/organizer/tournament', { status });
      setTournament(data.tournament);
      setBanner({ tone: 'good', text: status === 'signups' ? 'Signups are open.' : 'Signups are closed — the pool is frozen.' });
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
    }
  }

  if (loading) return <div className="p-8 text-sm text-ash">Loading…</div>;

  const open = tournament?.status === 'signups';

  return (
    <div className="px-6 py-7 max-w-[1180px] mx-auto">
      <header className="flex items-end justify-between gap-5 flex-wrap mb-5">
        <div>
          <h1 className="font-display text-[27px]">Approval queue</h1>
          <p className="text-ash text-sm mt-1.5 max-w-[64ch]">
            A signup is invisible to captains until it clears here. {tournament?.name}
            {' · '}
            <span className={open ? 'text-verdigris' : 'text-oxblood'}>
              signups {open ? 'open' : 'closed'}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          {open
            ? <Button variant="ghost" onClick={() => setStatus('draft')}>Close signups</Button>
            : <Button variant="ghost" onClick={() => setStatus('signups')}>Reopen signups</Button>}
          <Button onClick={approveAll} disabled={!counts.pending || busy === 'all'}>
            {busy === 'all' ? 'Approving…' : `Approve all ${counts.pending || 0}`}
          </Button>
        </div>
      </header>

      {!dmAvailable && (
        <div className="mb-4">
          <Note tone="bad">
            No bot token is configured, so decisions aren't being DMed. Players will only find
            out by checking this site. Set <code className="mono">DISCORD_BOT_TOKEN</code> in
            {' '}<code className="mono">backend/.env</code>.
          </Note>
        </div>
      )}
      {banner && <div className="mb-4"><Note tone={banner.tone}>{banner.text}</Note></div>}

      <Panel
        title={null}
        right={null}
      >
        <div className="px-4 py-3 border-b border-line flex items-center justify-between gap-3 flex-wrap">
          <div className="flex gap-1.5 flex-wrap">
            {TABS.map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`px-3 py-1.5 rounded text-xs font-semibold border transition-colors ${
                  tab === key
                    ? 'bg-brass/18 border-brass/60 text-bone'
                    : 'border-line text-ash hover:text-bone hover:border-brass/50'
                }`}
              >
                {label}
                <span className="mono ml-2 text-[11px] text-ash">{counts[key] ?? 0}</span>
              </button>
            ))}
          </div>
          <input
            type="search"
            className="field-input max-w-[220px] py-1.5 text-[13px]"
            placeholder="Search name, Discord or class…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search signups"
          />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                {['Character', 'Discord', 'Class', 'Weapons', 'Gear', 'Nights', 'Filed', ''].map((h, i) => (
                  <th
                    key={h + i}
                    className={`text-left px-3.5 py-2.5 whitespace-nowrap text-[10px] uppercase tracking-[0.1em]
                      font-semibold text-ash border-b border-line bg-panelup/50 ${h === 'Gear' ? 'text-right' : ''}`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <Empty>
                      {q ? 'Nothing matches that search.'
                        : tab === 'pending' ? 'Nothing waiting. Every signup is decided.'
                        : 'Nothing here yet.'}
                    </Empty>
                  </td>
                </tr>
              )}
              {shown.map((r) => (
                <tr key={r.id} className="hover:bg-panelup/60">
                  <td className="px-3.5 py-2.5 border-b border-line/50">
                    <span className="font-medium">{r.player_name}</span>
                    {r.wants_captain && <Pill tone="brass">wants to captain</Pill>}
                    {r.notes && (
                      <div className="text-xs text-ash mt-1 max-w-[40ch] whitespace-normal">{r.notes}</div>
                    )}
                  </td>
                  <td className="px-3.5 py-2.5 border-b border-line/50 text-ash whitespace-nowrap">
                    {r.discord_username || '—'}
                  </td>
                  <td className="px-3.5 py-2.5 border-b border-line/50 whitespace-nowrap">{r.class_name}</td>
                  <td className="px-3.5 py-2.5 border-b border-line/50 text-ash text-xs whitespace-nowrap">
                    {r.weapon_1} · {r.weapon_2}
                  </td>
                  <td className="px-3.5 py-2.5 border-b border-line/50 mono text-right whitespace-nowrap">
                    {r.gear_level.toLocaleString()}
                  </td>
                  <td className="px-3.5 py-2.5 border-b border-line/50 text-ash text-xs whitespace-nowrap">
                    {(r.nights || []).join(' ') || '—'}
                  </td>
                  <td className="px-3.5 py-2.5 border-b border-line/50 text-ash text-xs whitespace-nowrap">
                    {new Date(r.created_at).toLocaleDateString()}
                    {/* An entry edited after it was decided is worth a glance —
                        the organizer approved what it said at the time. */}
                    {r.decided_at && new Date(r.updated_at) > new Date(r.decided_at) && (
                      <span className="block text-brass">edited since</span>
                    )}
                  </td>
                  <td className="px-3.5 py-2.5 border-b border-line/50 text-right whitespace-nowrap">
                    {r.status === 'pending' ? (
                      <>
                        <Button onClick={() => decide(r, 'approved')} disabled={busy === r.id}>Approve</Button>
                        <Button variant="ghost" className="ml-1.5" onClick={() => decide(r, 'rejected')} disabled={busy === r.id}>
                          Reject
                        </Button>
                      </>
                    ) : r.status === 'approved' ? (
                      <Button variant="ghost" onClick={() => decide(r, 'rejected')} disabled={busy === r.id}>
                        Remove from board
                      </Button>
                    ) : r.status === 'rejected' ? (
                      <Button onClick={() => decide(r, 'approved')} disabled={busy === r.id}>Approve after all</Button>
                    ) : (
                      <span className="text-xs text-ash">withdrew</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <p className="text-xs text-ash mt-3">
        Rejecting asks for a reason and DMs it — a signup that vanishes without one just gets
        resubmitted. Every decision is written to the audit log.
      </p>
    </div>
  );
}
