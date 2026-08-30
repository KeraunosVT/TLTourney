// Predictions — call the matches before they are played.
//
// Open to anyone with a session, players and viewers alike: the point of it is
// the people watching, and most of them will never appear on a roster.
//
// ONE CLICK IS A WHOLE PREDICTION. Each team shows its scorelines as separate
// buttons — "2 — 0", "2 — 1" — rather than a team toggle plus a scoreline
// toggle. A two-part control has a half-finished state, and a half-finished
// prediction either has to be stored (and scored as something nobody chose) or
// silently discarded when the page closes. Neither is worth the saved pixel.
//
// The buttons here decide what the browser draws and nothing more. Every pick
// is re-checked against the clock on the server, which is the only place the
// window is really enforced.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api, { errorMessage } from '../api';
import { Panel, Pill, Button, Empty, Note } from '../components/ui';
import { useAuth } from '../auth';
import { whenShort, toLocalInput, fromLocalInput } from '../lib/clock';
import { scorelineLabel, MAX_OPTIONS } from '@shared/predictions.cjs';

export default function Predictions() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [table, setTable] = useState(null);
  const [tab, setTab] = useState('picks');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);      // the key being saved
  const [banner, setBanner] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data: d } = await api.get('/api/predictions');
      setData(d);
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err, 'Could not load the predictions.') });
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTable = useCallback(async () => {
    try {
      const { data: d } = await api.get('/api/predictions/standings');
      setTable(d);
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err, 'Could not load the standings.') });
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (tab === 'standings') loadTable(); }, [tab, loadTable]);

  // Every write returns the whole overview, so the crowd split, your card and
  // the totals all move together. Refetching them separately is how a page ends
  // up showing a pick that is not in the percentages under it.
  async function pick(key, teamId, loserGames) {
    setBusy(key);
    setBanner(null);
    try {
      const { data: d } = await api.put('/api/predictions/match', {
        key, team_id: teamId, loser_games: loserGames,
      });
      setData(d);
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
      // A refusal is usually the window having closed while the page sat open.
      // Reloading turns a stale card into an honest one.
      load();
    } finally {
      setBusy(null);
    }
  }

  async function clear(key) {
    setBusy(key);
    setBanner(null);
    try {
      const { data: d } = await api.delete('/api/predictions/match', { data: { key } });
      setData(d);
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
      load();
    } finally {
      setBusy(null);
    }
  }

  async function answer(questionId, optionId) {
    setBusy(questionId);
    setBanner(null);
    try {
      const { data: d } = await api.put('/api/predictions/answer', {
        question_id: questionId, option_id: optionId,
      });
      setData(d);
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
      load();
    } finally {
      setBusy(null);
    }
  }

  // ── Organizer ─────────────────────────────────────────────────────────────
  // All three take the same shape: send it, take the whole overview back, and
  // let the page redraw from one snapshot rather than patching a row in place.
  async function organizerCall(fn, label) {
    setBanner(null);
    try {
      const { data: d } = await fn();
      setData(d.ok ? d : d);
      if (label) setBanner({ tone: 'good', text: label(d) });
      return true;
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
      return false;
    }
  }

  const createQuestion = (body) => organizerCall(
    () => api.post('/api/organizer/predictions/question', body),
    () => 'Question posted.',
  );

  const editQuestion = (body) => organizerCall(
    () => api.put('/api/organizer/predictions/question', body),
  );

  const settleQuestion = (body) => organizerCall(
    () => api.post('/api/organizer/predictions/question/settle', body),
    (d) => (d.paid === null || d.paid === undefined
      ? 'Question updated.'
      : `Settled — ${d.paid} ${d.paid === 1 ? 'person' : 'people'} called it.`),
  );

  const removeQuestion = (id, force) => organizerCall(
    () => api.delete('/api/organizer/predictions/question', { data: { id, force } }),
    () => 'Question removed.',
  );

  async function pickChampion(teamId) {
    setBusy('champion');
    setBanner(null);
    try {
      const { data: d } = await api.put('/api/predictions/champion', { team_id: teamId });
      setData(d);
    } catch (err) {
      setBanner({ tone: 'bad', text: errorMessage(err) });
      load();
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <div className="p-8 text-sm text-ash">Loading…</div>;

  const matches = data?.matches || [];
  const me = data?.me;
  const scoring = data?.scoring || {};

  // Four groups, in the order somebody actually wants them: what you can still
  // do something about, then what is riding, then what is done. Fixtures with
  // no teams yet go last — they are a promise, not a task.
  const open = matches.filter((m) => m.window?.open)
    .sort((a, b) => (a.scheduled_at || '9999').localeCompare(b.scheduled_at || '9999'));
  const riding = matches.filter((m) => !m.window?.open && !m.window?.pending && !m.series?.decided);
  const settled = matches.filter((m) => m.series?.decided).reverse();
  const pending = matches.filter((m) => m.window?.pending);

  return (
    <div className="px-6 py-7 max-w-[1100px] mx-auto">
      <header className="flex items-end justify-between gap-5 flex-wrap mb-4">
        <div>
          <h1 className="font-display text-[27px]">Predictions</h1>
          <p className="text-ash text-sm mt-1.5 max-w-[70ch]">
            {scoring.winner} points for calling the winner, {scoring.scoreline} more for the exact
            scoreline, {scoring.champion} for the champion. Questions are worth whatever they say.
            Picks lock when the match starts.
          </p>
        </div>
        {me && (
          <div className="flex items-center gap-2">
            <Pill tone="quiet">#{me.rank} of {data.players}</Pill>
            <Pill tone="good">{me.points} pts</Pill>
          </div>
        )}
      </header>

      {banner && <div className="mb-4 max-w-[900px]"><Note tone={banner.tone}>{banner.text}</Note></div>}

      <div className="flex gap-1 mb-4">
        {[['picks', 'Your picks'], ['standings', 'Standings']].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-3 py-1.5 rounded text-[13px] border ${
              tab === id ? 'border-crimson bg-crimson/10 text-bone' : 'border-line text-ash hover:text-bone'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'standings' ? (
        <Standings table={table} />
      ) : (
        <>
          <Champion
            champion={data?.champion}
            teams={data?.teams || []}
            busy={busy === 'champion'}
            onPick={pickChampion}
          />

          {/* Questions come before the matches. They are the ones somebody sat
              down and wrote, they are usually the ones with a deadline, and a
              new one appearing at the bottom of a long list of fixtures is a
              new one nobody answers. */}
          <Questions
            questions={data?.questions || []}
            canEdit={!!user?.isOrganizer}
            defaultPoints={scoring.question}
            busy={busy}
            onAnswer={answer}
            onCreate={createQuestion}
            onEdit={editQuestion}
            onSettle={settleQuestion}
            onRemove={removeQuestion}
          />

          {matches.length === 0 && (
            <Empty>
              Nothing to predict yet — the matches appear here as soon as the bracket is drawn.
              {' '}<Link to="/bracket" className="text-crimsonbright underline underline-offset-2">See the bracket</Link>
            </Empty>
          )}

          <Group title="Open" subtitle="Pick, or change your mind, until the match starts">
            {open.map((m) => (
              <Match key={m.key} m={m} busy={busy === m.key} onPick={pick} onClear={clear} />
            ))}
            {open.length === 0 && matches.length > 0 && (
              <p className="text-[13px] text-ash px-1 py-2">Nothing open right now.</p>
            )}
          </Group>

          {riding.length > 0 && (
            <Group title="Locked" subtitle="Being played, or waiting on a result">
              {riding.map((m) => <Match key={m.key} m={m} locked />)}
            </Group>
          )}

          {settled.length > 0 && (
            <Group title="Settled">
              {settled.map((m) => <Match key={m.key} m={m} locked />)}
            </Group>
          )}

          {pending.length > 0 && (
            <Group title="Later" subtitle="These open once both teams are known">
              {pending.map((m) => (
                <div key={m.key} className="px-4 py-2.5 border-b border-line/50 last:border-b-0 flex items-center gap-3">
                  <span className="text-[12.5px] text-ash w-[150px] shrink-0">{m.label}</span>
                  <span className="text-[12.5px] text-ash">{m.window?.reason}</span>
                </div>
              ))}
            </Group>
          )}
        </>
      )}
    </div>
  );
}

const Group = ({ title, subtitle, children }) => (
  <Panel title={title} subtitle={subtitle} className="mb-4">
    <div className="flex flex-col">{children}</div>
  </Panel>
);

// ── Questions somebody wrote ────────────────────────────────────────────────
function Questions({ questions, canEdit, defaultPoints, busy, onAnswer, onCreate, onEdit, onSettle, onRemove }) {
  const [asking, setAsking] = useState(false);

  if (!questions.length && !canEdit) return null;

  return (
    <Panel
      title="Questions"
      subtitle={questions.length ? undefined : 'Nothing asked yet'}
      className="mb-4"
      right={canEdit && (
        <button
          onClick={() => setAsking((x) => !x)}
          className="text-[12px] text-crimsonbright hover:text-bone underline underline-offset-2"
        >
          {asking ? 'cancel' : 'ask a question'}
        </button>
      )}
    >
      {asking && (
        <Ask
          defaultPoints={defaultPoints}
          onCancel={() => setAsking(false)}
          onCreate={async (body) => { if (await onCreate(body)) setAsking(false); }}
        />
      )}

      <div className="flex flex-col">
        {questions.map((q) => (
          <QuestionCard
            key={q.id}
            q={q}
            canEdit={canEdit}
            busy={busy === q.id}
            onAnswer={onAnswer}
            onEdit={onEdit}
            onSettle={onSettle}
            onRemove={onRemove}
          />
        ))}
      </div>

      {!questions.length && !asking && canEdit && (
        <p className="px-4 py-3 text-[13px] text-ash">
          Anything worth arguing about: does the grand final go to a reset, which team tops the
          damage chart, how many games the final runs.
        </p>
      )}
    </Panel>
  );
}

function QuestionCard({ q, canEdit, busy, onAnswer, onEdit, onSettle, onRemove }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(null);
  const [tools, setTools] = useState(false);

  // Fetched on demand rather than with the page: the breakdown is names, it is
  // only legible one question at a time, and most questions are never expanded.
  async function reveal() {
    setOpen((x) => !x);
    if (rows || open) return;
    try {
      const { data: d } = await api.get(`/api/predictions/question/${q.id}/answers`);
      setRows(d.rows || []);
    } catch (err) {
      setRows([]);
    }
  }

  const settled = !!q.correct_option_id && !q.void;
  const label = (id) => (q.options.find((o) => o.id === id)?.label ?? '—');

  return (
    <div className={`px-4 py-3 border-b border-line/50 last:border-b-0 ${busy ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-3 flex-wrap mb-2">
        <span className="text-[14px] flex-1 min-w-[200px]">{q.prompt}</span>

        <span className="text-[11.5px] text-ash whitespace-nowrap">{q.points} pts</span>

        {q.window?.open && q.closes_at && (
          <span className="text-[11.5px] text-ash whitespace-nowrap">closes {whenShort(q.closes_at)}</span>
        )}

        {q.void && <Pill tone="quiet">void</Pill>}

        {/* What it turned out to be worth. A miss says so — silence would read
            as "not scored yet". */}
        {q.mine?.settled && (
          <span className={`text-[11.5px] uppercase tracking-[0.1em] whitespace-nowrap ${
            q.mine.correct ? 'text-verdigris' : 'text-ash/60'
          }`}>
            {q.mine.correct ? `+${q.mine.points}` : 'missed'}
          </span>
        )}
      </div>

      <div className="flex gap-1.5 flex-wrap">
        {q.options.map((o) => {
          const mine = q.mine?.option_id === o.id;
          const right = settled && q.correct_option_id === o.id;
          const share = q.split?.find((s) => s.option_id === o.id);

          return (
            <button
              key={o.id}
              disabled={!q.window?.open || busy}
              onClick={() => onAnswer(q.id, o.id)}
              className={`px-3 py-1.5 rounded border text-[13px] transition-colors ${
                right
                  ? 'border-verdigris/70 bg-verdigris/10 text-bone'
                  : mine
                    ? 'border-crimson bg-crimson/[0.12] text-bone'
                    : 'border-line text-ash'
              } ${q.window?.open && !busy ? 'hover:text-bone hover:border-ash/50' : 'cursor-default'}`}
            >
              {o.label}
              {share?.count > 0 && (
                <span className="text-[11px] text-ash ml-2">{share.pct}%</span>
              )}
              {right && <span className="text-[11px] text-verdigris ml-2">correct</span>}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-3 flex-wrap mt-2">
        <span className="text-[11.5px] text-ash">
          {q.answered} answer{q.answered === 1 ? '' : 's'}
          {q.right !== null && q.right !== undefined && (
            <span className="text-verdigris"> · {q.right} got it right</span>
          )}
        </span>

        {!q.window?.open && (
          <button
            onClick={reveal}
            className="text-[11.5px] text-ash hover:text-bone underline underline-offset-2"
          >
            {open ? 'hide who' : 'who called it'}
          </button>
        )}

        {q.window?.open && !q.closes_at && (
          <span className="text-[11.5px] text-ash/60">open until it is settled</span>
        )}

        {canEdit && (
          <button
            onClick={() => setTools((x) => !x)}
            className="ml-auto text-[11.5px] text-crimsonbright hover:text-bone underline underline-offset-2"
          >
            {tools ? 'done' : 'settle'}
          </button>
        )}
      </div>

      {open && <Who rows={rows} />}

      {tools && canEdit && (
        <Settle q={q} label={label} onEdit={onEdit} onSettle={onSettle} onRemove={onRemove} />
      )}
    </div>
  );
}

/** Who answered what, right answers first. */
function Who({ rows }) {
  if (!rows) return <div className="mt-2 text-[12px] text-ash">Loading…</div>;
  if (!rows.length) return <div className="mt-2 text-[12px] text-ash">Nobody answered this one.</div>;

  return (
    <div className="mt-2 border-t border-line/60 pt-2 flex flex-wrap gap-x-4 gap-y-1">
      {rows.map((r, i) => (
        <span key={`${r.name}-${i}`} className="text-[12px]">
          <span className={r.correct ? 'text-verdigris' : 'text-ash'}>{r.name}</span>
          {r.is_me && <span className="text-crimsonbright text-[10px] ml-1">you</span>}
          <span className="text-ash/60 text-[11px] ml-1.5">{r.option}</span>
        </span>
      ))}
    </div>
  );
}

/** The organizer's controls for one question. */
function Settle({ q, label, onEdit, onSettle, onRemove }) {
  const [closesAt, setClosesAt] = useState(toLocalInput(q.closes_at));

  return (
    <div className="mt-3 border-t border-line pt-3 flex flex-col gap-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[12px] text-ash w-[110px]">Correct answer</span>
        <select
          className="bg-panelup border border-line rounded px-2 py-1 text-[12.5px] w-[220px]
                     outline-none focus:border-crimson"
          value={q.correct_option_id || ''}
          onChange={(e) => onSettle({ id: q.id, correct_option_id: e.target.value || null })}
        >
          <option value="">— not settled —</option>
          {q.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>

        {/* Voiding beats deleting, and says so. A voided question keeps
            everybody's answer on record and scores nobody. */}
        <button
          onClick={() => onSettle({ id: q.id, void: !q.void })}
          className="text-[11.5px] text-ash hover:text-bone underline underline-offset-2"
        >
          {q.void ? 'un-void' : 'void it'}
        </button>

        <button
          onClick={() => {
            const force = q.answered > 0
              && window.confirm(`${q.answered} answered this. Deleting removes their answers — void it instead?\n\nOK deletes it anyway.`);
            onRemove(q.id, q.answered > 0 ? force : false);
          }}
          className="text-[11.5px] text-crimsonbright hover:text-bone underline underline-offset-2"
        >
          delete
        </button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[12px] text-ash w-[110px]">Closes</span>
        <input
          type="datetime-local"
          className="field-input py-1 text-[12.5px] w-auto"
          value={closesAt}
          onChange={(e) => setClosesAt(e.target.value)}
        />
        <Button
          variant="ghost"
          className="text-[12px] py-1"
          onClick={() => onEdit({ id: q.id, closes_at: fromLocalInput(closesAt) || '' })}
        >
          Save
        </Button>
        {q.closes_at && (
          <span className="text-[11.5px] text-ash">now {whenShort(q.closes_at)}</span>
        )}
      </div>

      {q.correct_option_id && !q.void && (
        <p className="text-[11.5px] text-verdigris">
          Settled on “{label(q.correct_option_id)}”. Changing it moves the points.
        </p>
      )}
    </div>
  );
}

/** Writing a new one. */
function Ask({ defaultPoints, onCreate, onCancel }) {
  const [prompt, setPrompt] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [points, setPoints] = useState(defaultPoints || 10);
  const [closesAt, setClosesAt] = useState('');
  const [saving, setSaving] = useState(false);

  const setOption = (i, v) => setOptions((prev) => prev.map((x, n) => (n === i ? v : x)));

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await onCreate({
        prompt,
        options: options.map((label) => ({ label })),
        points: Number(points),
        closes_at: fromLocalInput(closesAt) || null,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="px-4 py-3 border-b border-line bg-panelup/40 flex flex-col gap-2.5">
      <input
        className="field-input py-1.5 text-[13.5px]"
        placeholder="Does the grand final go to a reset?"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        maxLength={200}
        autoFocus
      />

      <div className="flex flex-wrap gap-2">
        {options.map((o, i) => (
          <input
            key={i}
            className="field-input py-1 text-[12.5px] w-[180px]"
            placeholder={`Option ${i + 1}`}
            value={o}
            onChange={(e) => setOption(i, e.target.value)}
            maxLength={60}
          />
        ))}
        {options.length < MAX_OPTIONS && (
          <button
            type="button"
            onClick={() => setOptions((prev) => [...prev, ''])}
            className="text-[12px] text-ash hover:text-bone underline underline-offset-2"
          >
            add an option
          </button>
        )}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-2">
          <span className="text-[12px] text-ash">Worth</span>
          <input
            type="number"
            min={1}
            max={100}
            className="field-input py-1 text-[12.5px] w-[70px]"
            value={points}
            onChange={(e) => setPoints(e.target.value)}
          />
          <span className="text-[12px] text-ash">points</span>
        </label>

        <label className="flex items-center gap-2">
          <span className="text-[12px] text-ash">Closes</span>
          <input
            type="datetime-local"
            className="field-input py-1 text-[12.5px] w-auto"
            value={closesAt}
            onChange={(e) => setClosesAt(e.target.value)}
          />
        </label>
        {/* No closing time is a real answer, not a blank to be filled: plenty
            of questions close when somebody knows the answer, not at a time
            anybody can name in advance. */}
        <span className="text-[11.5px] text-ash/60">leave blank to close it by hand</span>
      </div>

      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>{saving ? 'Posting…' : 'Post it'}</Button>
        <Button variant="ghost" type="button" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

// ── One match ───────────────────────────────────────────────────────────────
function Match({ m, busy, locked, onPick, onClear }) {
  const [who, setWho] = useState(null);
  const [showing, setShowing] = useState(false);
  const mine = m.mine;
  const sides = [
    { team: m.team_a, wins: m.series?.winsA ?? 0 },
    { team: m.team_b, wins: m.series?.winsB ?? 0 },
  ];

  return (
    <div className={`px-4 py-3 border-b border-line/50 last:border-b-0 ${busy ? 'opacity-60' : ''}`}>
      <div className="flex items-center gap-3 flex-wrap mb-2">
        <Link to={`/match/${m.key}`} className="text-[12.5px] text-ash hover:text-bone w-[150px] shrink-0 truncate">
          {m.label}
        </Link>

        {m.scheduled_at && (
          <span className="text-[12px] text-ash">
            {m.window?.open ? 'locks ' : ''}{whenShort(m.scheduled_at)}
          </span>
        )}

        {m.series?.decided && (
          <span className="mono text-[13px]">{m.series.winsA} — {m.series.winsB}</span>
        )}

        {/* What it was worth, once it is worth anything. A miss says so rather
            than saying nothing, which would read as "not scored yet". */}
        {mine?.settled && (
          <span className={`text-[11.5px] uppercase tracking-[0.1em] ${
            mine.points > 0 ? 'text-verdigris' : 'text-ash/60'
          }`}>
            {mine.points > 0 ? `+${mine.points}${mine.exact ? ' · exact' : ''}` : 'missed'}
          </span>
        )}

        {locked && !mine && (
          <span className="text-[11.5px] text-ash/60 uppercase tracking-[0.1em]">no pick</span>
        )}

        {!m.window?.open && !m.series?.decided && (
          <span className="text-[12px] text-ash">{m.window?.reason}</span>
        )}

        {m.window?.open && mine && onClear && (
          <button
            onClick={() => onClear(m.key)}
            className="ml-auto text-[11.5px] text-ash hover:text-bone underline underline-offset-2"
          >
            clear
          </button>
        )}
      </div>

      <div className="flex gap-2 flex-wrap">
        {sides.map(({ team, wins }) => {
          if (!team) return null;
          const picked = mine?.team_id === team.id;
          const won = m.series?.decided && m.series.winner_team_id === team.id;

          return (
            <div
              key={team.id}
              className={`flex-1 min-w-[240px] rounded border px-3 py-2 ${
                picked ? 'border-crimson bg-crimson/[0.07]' : 'border-line'
              }`}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <span className={`text-[13.5px] truncate ${won ? 'text-verdigris' : ''}`}>
                  {team.name}
                </span>
                {team.tag && <span className="text-[11px] text-ash">{team.tag}</span>}
                {m.series?.decided && <span className="mono text-[12px] text-ash ml-auto">{wins}</span>}
              </div>

              {m.window?.open ? (
                <div className="flex gap-1.5">
                  {(m.options || []).map((n) => {
                    const on = picked && mine?.loser_games === n;
                    return (
                      <button
                        key={n}
                        disabled={busy}
                        onClick={() => onPick(m.key, team.id, n)}
                        className={`mono text-[12.5px] px-2.5 py-1 rounded border transition-colors ${
                          on
                            ? 'border-crimson bg-crimson/20 text-bone'
                            : 'border-line text-ash hover:text-bone hover:border-ash/50'
                        }`}
                        title={`${team.name} to win ${scorelineLabel(m.best_of, n)}`}
                      >
                        {scorelineLabel(m.best_of, n)}
                      </button>
                    );
                  })}
                </div>
              ) : (
                picked && (
                  <span className="mono text-[12.5px] text-crimsonbright">
                    your pick · {scorelineLabel(m.best_of, mine.loser_games)}
                  </span>
                )
              )}
            </div>
          );
        })}
      </div>

      <Crowd crowd={m.crowd} a={m.team_a} b={m.team_b} />

      {/* Only once it is locked. While picks are still open, showing who has
          called what turns the match into a poll people copy. */}
      {!m.window?.open && m.crowd?.total > 0 && (
        <div className="mt-1.5">
          <button
            onClick={async () => {
              setShowing((x) => !x);
              if (who || showing) return;
              try {
                const { data: d } = await api.get(`/api/predictions/match/${m.key}/picks`);
                setWho(d.rows || []);
              } catch {
                setWho([]);
              }
            }}
            className="text-[11.5px] text-ash hover:text-bone underline underline-offset-2"
          >
            {showing ? 'hide who' : 'who called it'}
          </button>

          {showing && (
            who === null
              ? <div className="mt-1.5 text-[12px] text-ash">Loading…</div>
              : (
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                  {who.map((r, i) => {
                    const team = [m.team_a, m.team_b].find((t) => t?.id === r.team_id);
                    return (
                      <span key={`${r.name}-${i}`} className="text-[12px]">
                        <span className={r.correct ? 'text-verdigris' : 'text-ash'}>{r.name}</span>
                        {r.is_me && <span className="text-crimsonbright text-[10px] ml-1">you</span>}
                        <span className="text-ash/60 text-[11px] ml-1.5">
                          {team?.tag || team?.name} {scorelineLabel(m.best_of, r.loser_games)}
                        </span>
                        {r.settled && r.points > 0 && (
                          <span className="text-verdigris text-[10px] ml-1">+{r.points}</span>
                        )}
                      </span>
                    );
                  })}
                </div>
              )
          )}
        </div>
      )}
    </div>
  );
}

// ── How the room called it ──────────────────────────────────────────────────
// Counts, never names. The same bar goes on the broadcast, where there is no
// session and so nobody who could have agreed to being named.
function Crowd({ crowd, a, b }) {
  if (!crowd || !crowd.total) {
    return <div className="mt-2 text-[11.5px] text-ash/60">No picks yet</div>;
  }

  return (
    <div className="mt-2">
      <div className="flex h-[6px] rounded overflow-hidden bg-panelup">
        {/* Crimson against bone rather than two team colours: teams do not have
            colours here, and picking two arbitrary ones would look like they
            meant something. */}
        <div className="bg-crimson" style={{ width: `${crowd.pct_a}%` }} />
        <div className="bg-bone/40" style={{ width: `${crowd.pct_b}%` }} />
      </div>
      <div className="flex justify-between text-[11px] text-ash mt-1">
        <span>{crowd.pct_a}% {a?.tag || a?.name}</span>
        <span>{crowd.total} pick{crowd.total === 1 ? '' : 's'}</span>
        <span>{b?.tag || b?.name} {crowd.pct_b}%</span>
      </div>
    </div>
  );
}

// ── The champion pick ───────────────────────────────────────────────────────
function Champion({ champion, teams, busy, onPick }) {
  if (!champion) return null;
  const mine = champion.mine;
  const counts = new Map((champion.crowd || []).map((c) => [c.team_id, c.count]));
  const decided = champion.decided;

  const subtitle = champion.window?.open
    ? `Worth ${champion.points} points. Locks when the first game of the tournament is played.`
    : champion.window?.reason;

  return (
    <Panel title="Champion" subtitle={subtitle} className="mb-4">
      <div className="p-4">
        {decided && (
          <p className="text-[13px] mb-3">
            {decided.name} won it.{' '}
            {mine && (
              <span className={mine.team_id === decided.id ? 'text-verdigris' : 'text-ash'}>
                {mine.team_id === decided.id
                  ? `You called it — +${champion.points}.`
                  : 'You picked somebody else.'}
              </span>
            )}
          </p>
        )}

        {champion.window?.open ? (
          <div className="flex flex-wrap gap-2">
            {teams.map((t) => {
              const on = mine?.team_id === t.id;
              const n = counts.get(t.id) || 0;
              return (
                <button
                  key={t.id}
                  disabled={busy}
                  onClick={() => onPick(t.id)}
                  className={`px-3 py-1.5 rounded border text-[13px] transition-colors ${
                    on ? 'border-crimson bg-crimson/[0.12] text-bone' : 'border-line text-ash hover:text-bone'
                  }`}
                >
                  {t.name}
                  {n > 0 && <span className="text-[11px] text-ash ml-2">{n}</span>}
                </button>
              );
            })}
            {teams.length === 0 && <span className="text-[13px] text-ash">No teams yet.</span>}
          </div>
        ) : (
          !decided && (
            <p className="text-[13px] text-ash">
              {mine
                ? <>You picked <span className="text-bone">{teams.find((t) => t.id === mine.team_id)?.name || 'a team'}</span>.</>
                : 'You did not make a champion pick.'}
            </p>
          )
        )}
      </div>
    </Panel>
  );
}

// ── The table ───────────────────────────────────────────────────────────────
function Standings({ table }) {
  if (!table) return <div className="p-6 text-sm text-ash">Loading…</div>;
  const rows = table.rows || [];

  if (rows.length === 0) {
    return <Empty>Nobody has made a prediction yet. Be the first.</Empty>;
  }

  return (
    <Panel
      title="Standings"
      subtitle="Ties share a rank"
      right={<span className="text-xs text-ash">{rows.length} playing</span>}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-ash text-[11px] uppercase tracking-[0.12em] border-b border-line">
              <th className="text-left font-normal px-4 py-2 w-[60px]">#</th>
              <th className="text-left font-normal px-4 py-2">Name</th>
              <th className="text-right font-normal px-4 py-2">Points</th>
              <th className="text-right font-normal px-4 py-2">Correct</th>
              <th className="text-right font-normal px-4 py-2">Exact</th>
              <th className="text-right font-normal px-4 py-2">Questions</th>
              <th className="text-right font-normal px-4 py-2 whitespace-nowrap">Champion</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={`${r.name}-${i}`}
                className={`border-b border-line/40 last:border-b-0 ${r.is_me ? 'bg-crimson/[0.07]' : ''}`}
              >
                <td className="px-4 py-2 mono text-ash">{r.rank}</td>
                <td className="px-4 py-2 truncate max-w-[260px]">
                  {r.name}
                  {r.is_me && <span className="text-[11px] text-crimsonbright ml-2">you</span>}
                </td>
                <td className="px-4 py-2 text-right mono">{r.points}</td>
                <td className="px-4 py-2 text-right mono text-ash">{r.correct}</td>
                <td className="px-4 py-2 text-right mono text-ash">{r.exact}</td>
                {/* Right out of answered, because "3" on its own cannot be
                    read — three of three is a different person to three of
                    eleven. */}
                <td className="px-4 py-2 text-right mono text-ash">
                  {r.answers ? `${r.questions_correct}/${r.answers}` : '—'}
                </td>
                <td className="px-4 py-2 text-right">
                  {r.champion_hit
                    ? <span className="text-verdigris text-[12px]">+{r.champion_points}</span>
                    : <span className="text-ash/50 text-[12px]">{r.champion_team_id ? 'picked' : '—'}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
