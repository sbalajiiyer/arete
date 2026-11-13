'use client';
import { useCallback, useEffect, useState } from 'react';
import { supabase, api, STAGES, label, when } from '../lib/client';
import { Logo } from './logo';

const STATUS_TONE = { approved: 'green', done: 'green', awaiting_approval: 'amber', returned: 'amber', duplicate: 'amber', rejected: 'red' };

function Render({ value }) {
  if (value == null || value === '') return <span className="muted">Not given</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="muted">None</span>;
    return <ul>{value.map((v, i) => <li key={i}><Render value={v} /></li>)}</ul>;
  }
  if (typeof value === 'object') {
    return <dl>{Object.entries(value).map(([k, v]) => <div key={k}><dt>{label(k)}</dt><dd><Render value={v} /></dd></div>)}</dl>;
  }
  return <span>{String(value)}</span>;
}

function Badges({ idea }) {
  return (
    <span className="row" style={{ gap: 4 }}>
      <span className="badge stage">{label(idea.stage)}</span>
      {idea.status !== 'active' && <span className={`badge ${STATUS_TONE[idea.status] || ''}`}>{label(idea.status)}</span>}
      {idea.score != null && <span className="badge">Score {Math.round(idea.score)}</span>}
      {idea.confidence != null && <span className="badge">Confidence {Math.round(idea.confidence)}</span>}
      {idea.rank != null && <span className="badge">Rank {idea.rank}</span>}
      {idea.escalated && <span className="badge red">Escalated</span>}
    </span>
  );
}

function Auth() {
  const [mode, setMode] = useState('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const fn = mode === 'in' ? supabase.auth.signInWithPassword({ email, password }) : supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } });
    const { data, error } = await fn;
    if (error) setMsg({ err: error.message });
    else if (mode === 'up' && !data.session) setMsg({ ok: 'Check your email for a confirmation link, then come back here and sign in.' });
    setBusy(false);
  }
  return (
    <div className="wrap auth">
      <div className="row" style={{ marginBottom: 10 }}><Logo size={44} /><h1 style={{ margin: 0, fontSize: 30, letterSpacing: '0.03em' }}>Arete</h1></div>
      <p className="muted">From idea to outcome. Seven agents do the groundwork and a person makes every decision.</p>
      <form className="card" onSubmit={submit}>
        {msg?.err && <div className="err">{msg.err}</div>}
        {msg?.ok && <div className="note">{msg.ok}</div>}
        <label>Email</label>
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        <label>Password</label>
        <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'in' ? 'current-password' : 'new-password'} />
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn" disabled={busy}>{mode === 'in' ? 'Sign in' : 'Create account'}</button>
          <button type="button" className="btn ghost" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setMsg(null); }}>
            {mode === 'in' ? 'New here? Create an account' : 'I have an account'}
          </button>
        </div>
      </form>
    </div>
  );
}

function NewIdea({ onClose, onDone }) {
  const [kind, setKind] = useState('text');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      let body = { kind, text, url };
      if (kind === 'file') {
        if (!file) throw new Error('Choose a file first.');
        if (file.size > 3000000) throw new Error('That file is over 3 MB. Paste the relevant text instead.');
        const bytes = new Uint8Array(await file.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
        body = { kind, filename: file.name, data: btoa(bin) };
      }
      const { ideas } = await api('/api/capture', body);
      onDone(ideas);
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  }
  return (
    <div className="modal" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="card">
        <h2>Capture ideas</h2>
        <p className="muted small">Give the Capture agent any raw material. It finds each idea in it and creates a structured record.</p>
        <div className="tabs">
          {[['text', 'Paste text'], ['url', 'Web page'], ['file', 'File']].map(([k, l]) => (
            <button key={k} className={`chip ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>{l}</button>
          ))}
        </div>
        {err && <div className="err" style={{ marginTop: 10 }}>{err}</div>}
        {kind === 'text' && (<><label>Notes, an email, a meeting transcript, or a rough idea</label><textarea value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: 170 }} /></>)}
        {kind === 'url' && (<><label>Public web address</label><input type="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} /></>)}
        {kind === 'file' && (<><label>Word (.docx), Excel (.xlsx), .csv, .txt or .md, up to 3 MB</label><input type="file" accept=".docx,.xlsx,.csv,.txt,.md" onChange={(e) => setFile(e.target.files[0] || null)} /></>)}
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn" disabled={busy} onClick={submit}>{busy ? 'Capture agent is reading…' : 'Capture'}</button>
          <button className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function IdeaDetail({ id, role, onBack }) {
  const [idea, setIdea] = useState(null);
  const [runs, setRuns] = useState([]);
  const [updates, setUpdates] = useState([]);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [comment, setComment] = useState('');
  const [note, setNote] = useState('');
  const [pct, setPct] = useState('');

  const load = useCallback(async () => {
    const [i, r, u] = await Promise.all([
      supabase.from('ideas').select('*, idea_types(*)').eq('id', id).maybeSingle(),
      supabase.from('stage_runs').select('*').eq('idea_id', id).order('created_at', { ascending: false }),
      supabase.from('watch_updates').select('*').eq('idea_id', id).order('created_at', { ascending: false }),
    ]);
    setIdea(i.data);
    setRuns(r.data || []);
    setUpdates(u.data || []);
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function act(name, fn) {
    setBusy(name);
    setErr(null);
    try {
      const res = await fn();
      if (res?.warning) setErr(res.warning);
    } catch (e) {
      setErr(e.message);
    }
    await load();
    setBusy(null);
  }

  if (!idea) return <div className="wrap"><p className="muted">Loading…</p></div>;
  const type = idea.idea_types;
  const stages = type.config.stages;
  const next = stages[stages.indexOf(idea.stage) + 1];
  const rec = idea.record || {};
  const canDecide = ['admin', 'approver'].includes(role);
  const canAdvance = next && ['active', 'returned'].includes(idea.status) && next !== 'watch';

  return (
    <div className="wrap">
      <button className="btn ghost" onClick={onBack} style={{ marginBottom: 12 }}>Back to pipeline</button>
      <div className="card">
        <h1>{idea.title}</h1>
        <p className="muted small">{type.name} · captured {when(idea.created_at)} from {rec.source || idea.source_kind}</p>
        <Badges idea={idea} />
        <p style={{ marginTop: 10 }}>{idea.summary}</p>
        <div className="out">
          <dl>
            {type.config.fields.map((f) => (<div key={f.key}><dt>{f.label}</dt><dd><Render value={rec.fields?.[f.key]} /></dd></div>))}
            {rec.missing_info?.length > 0 && (<div><dt>Missing information</dt><dd><Render value={rec.missing_info} /></dd></div>)}
          </dl>
        </div>
      </div>

      {err && <div className="err">{err}</div>}

      <div className="card">
        <h2>Next step</h2>
        <p className="muted small">Path for this type: {stages.map(label).join(' → ')}</p>
        {canAdvance && (
          <button className="btn" disabled={!!busy} onClick={() => act('advance', () => api(`/api/ideas/${id}/advance`))}>
            {busy === 'advance' ? `${label(next)} agent is working…` : `Run the ${label(next)} agent`}
          </button>
        )}
        {idea.status === 'duplicate' && (
          <>
            <p>The Scope agent thinks this duplicates an existing idea. Review its findings below.</p>
            <button className="btn ghost" disabled={!!busy} onClick={() => act('dup', async () => {
              await supabase.from('ideas').update({ status: 'active' }).eq('id', id);
              await supabase.from('stage_runs').insert({ idea_id: id, org_id: idea.org_id, stage: 'scope', agent: 'Human reviewer', summary: 'Marked as not a duplicate; idea continues.', output: {} });
            })}>Not a duplicate, continue</button>
          </>
        )}
        {idea.status === 'awaiting_approval' && (
          <>
            <p>Decision pack ready for <b>{type.config.approver}</b>. A person makes this decision.</p>
            <div className="out"><Render value={rec.commit} /></div>
            {canDecide ? (
              <>
                <label>Comment (shared with the agents if you return it)</label>
                <textarea value={comment} onChange={(e) => setComment(e.target.value)} style={{ minHeight: 70 }} />
                <div className="row" style={{ marginTop: 10 }}>
                  {[['approved', 'Approve', ''], ['returned', 'Return for rework', 'ghost'], ['rejected', 'Reject', 'danger']].map(([d, l, c]) => (
                    <button key={d} className={`btn ${c}`} disabled={!!busy} onClick={() => act(d, () => api(`/api/ideas/${id}/decision`, { decision: d, comment }))}>
                      {busy === d ? 'Recording…' : l}
                    </button>
                  ))}
                </div>
              </>
            ) : <p className="muted">Only approvers can decide.</p>}
          </>
        )}
        {idea.status === 'approved' && idea.stage !== 'watch' && (
          <button className="btn" disabled={!!busy} onClick={() => act('advance', () => api(`/api/ideas/${id}/advance`))}>
            {busy === 'advance' ? 'Watch agent is working…' : 'Set up tracking with the Watch agent'}
          </button>
        )}
        {idea.stage === 'watch' && idea.status !== 'done' && (
          <>
            <p>Approved and being tracked. Post a progress update and the Watch agent will assess it against the plan.</p>
            <label>Progress update</label>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} />
            <label>Percent complete (optional)</label>
            <input type="number" min="0" max="100" value={pct} onChange={(e) => setPct(e.target.value)} style={{ maxWidth: 120 }} />
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn" disabled={!!busy} onClick={() => act('watch', async () => { await api(`/api/ideas/${id}/watch`, { note, percent_complete: pct }); setNote(''); })}>
                {busy === 'watch' ? 'Watch agent is assessing…' : 'Post update'}
              </button>
              <button className="btn ghost" disabled={!!busy} onClick={() => act('close', async () => { await api(`/api/ideas/${id}/watch`, { note, percent_complete: 100, done: true }); setNote(''); })}>
                {busy === 'close' ? 'Closing…' : 'Post as final update and close'}
              </button>
            </div>
          </>
        )}
        {idea.status === 'rejected' && <p>This idea was rejected. Its record stays here for future duplicate checks.</p>}
        {idea.status === 'done' && <p>This idea is closed. Its lessons now feed the Scope and Evaluate agents on future ideas.</p>}
      </div>

      {updates.length > 0 && (
        <div className="card">
          <h2>Progress updates</h2>
          {updates.map((u) => (
            <div className="run" key={u.id} style={{ borderColor: `var(--${u.rag || 'accent'})` }}>
              <div className="row"><span className={`badge ${u.rag}`}>{label(u.rag || 'update')}</span>{u.escalate && <span className="badge red">Escalated</span>}<span className="muted small">{when(u.created_at)}{u.percent_complete != null ? ` · ${u.percent_complete}%` : ''}</span></div>
              <p style={{ margin: '6px 0' }}>{u.note}</p>
              <details><summary>Watch agent assessment</summary><div className="out"><Render value={u.assessment} /></div></details>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h2>Agent trail</h2>
        <p className="muted small">Every agent action and human decision on this idea, newest first. Entries cannot be edited.</p>
        {runs.map((r) => (
          <div className="run" key={r.id}>
            <div className="row"><b>{r.agent}</b><span className="badge stage">{label(r.stage)}</span><span className="muted small">{when(r.created_at)}</span></div>
            <p style={{ margin: '4px 0' }}>{r.summary}</p>
            {Object.keys(r.output || {}).length > 0 && (<details><summary>Full output</summary><div className="out"><Render value={r.output} /></div></details>)}
          </div>
        ))}
      </div>
    </div>
  );
}

function Types({ org, role, types, reload }) {
  const [drafts, setDrafts] = useState({});
  const [msg, setMsg] = useState(null);
  const admin = role === 'admin';
  async function saveType(t) {
    setMsg(null);
    try {
      const config = JSON.parse(drafts[t.id] ?? JSON.stringify(t.config));
      if (!Array.isArray(config.stages) || !Array.isArray(config.fields) || !Array.isArray(config.criteria)) throw new Error('stages, fields and criteria must be lists.');
      const { error } = await supabase.from('idea_types').update({ config }).eq('id', t.id);
      if (error) throw error;
      setMsg({ ok: `Saved "${t.name}".` });
      reload();
    } catch (e) {
      setMsg({ err: `Could not save: ${e.message}` });
    }
  }
  async function addType() {
    const name = window.prompt('Name for the new idea type');
    if (!name || !types[0]) return;
    const { error } = await supabase.from('idea_types').insert({ org_id: org.id, name, description: 'Describe when to use this type.', config: types[0].config });
    setMsg(error ? { err: error.message } : { ok: `Added "${name}" as a copy of "${types[0].name}". Edit its settings below.` });
    reload();
  }
  return (
    <>
      <p className="muted">An idea type tells the agents how to treat one kind of idea: which fields to capture, which stages apply, how to score it, and who approves.</p>
      {msg?.err && <div className="err">{msg.err}</div>}
      {msg?.ok && <div className="note">{msg.ok}</div>}
      {types.map((t) => (
        <div className="card" key={t.id}>
          <h2>{t.name}</h2>
          <p className="muted small">{t.description}</p>
          <p className="small"><b>Path:</b> {t.config.stages.map(label).join(' → ')} · <b>Approver:</b> {t.config.approver}</p>
          <details>
            <summary className="small" style={{ cursor: 'pointer', color: 'var(--accent)' }}>{admin ? 'Edit settings' : 'View settings'}</summary>
            <textarea className="mono" readOnly={!admin} value={drafts[t.id] ?? JSON.stringify(t.config, null, 2)} onChange={(e) => setDrafts({ ...drafts, [t.id]: e.target.value })} style={{ marginTop: 8 }} />
            {admin && <button className="btn" style={{ marginTop: 8 }} onClick={() => saveType(t)}>Save settings</button>}
          </details>
        </div>
      ))}
      {admin && <button className="btn ghost" onClick={addType}>Add an idea type</button>}
    </>
  );
}

export default function Home() {
  const [session, setSession] = useState(undefined);
  const [org, setOrg] = useState(null);
  const [role, setRole] = useState('member');
  const [ideas, setIdeas] = useState([]);
  const [types, setTypes] = useState([]);
  const [tab, setTab] = useState('pipeline');
  const [filter, setFilter] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const userId = session?.user?.id;
  const load = useCallback(async () => {
    if (!userId) return;
    const [m, i, t] = await Promise.all([
      supabase.from('org_members').select('role, orgs(id, name)').eq('user_id', userId).limit(1).maybeSingle(),
      supabase.from('ideas').select('id, title, summary, stage, status, score, confidence, rank, escalated, created_at, idea_types(name)').order('created_at', { ascending: false }).limit(500),
      supabase.from('idea_types').select('*').order('created_at'),
    ]);
    setOrg(m.data?.orgs || null);
    setRole(m.data?.role || 'member');
    setIdeas(i.data || []);
    setTypes(t.data || []);
  }, [userId]);
  useEffect(() => { load(); }, [load]);

  if (session === undefined) return <div className="wrap"><p className="muted">Loading…</p></div>;
  if (!session) return <Auth />;
  if (openId) return <IdeaDetail id={openId} role={role} onBack={() => { setOpenId(null); load(); }} />;

  const shown = filter ? ideas.filter((i) => i.stage === filter) : ideas;
  const ranked = ideas.filter((i) => i.score != null && !['rejected', 'duplicate'].includes(i.status)).sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999) || b.score - a.score);
  const escalated = ideas.filter((i) => i.escalated && i.status !== 'done');
  const waiting = ideas.filter((i) => i.status === 'awaiting_approval');

  return (
    <div className="wrap">
      <div className="top">
        <div className="brand">{org?.name || 'Workspace'}<small>{session.user.email}</small></div>
        <div className="tabs">
          {[['pipeline', 'Pipeline'], ['portfolio', 'Portfolio'], ['types', 'Idea types']].map(([k, l]) => (
            <button key={k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>
          ))}
          <button className="tab" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </div>

      {tab === 'pipeline' && (
        <>
          {notice && <div className="note">{notice}</div>}
          {escalated.length > 0 && <div className="err">{escalated.length} tracked idea(s) escalated by the Watch agent: {escalated.map((i) => i.title).join('; ')}</div>}
          {waiting.length > 0 && <div className="note">{waiting.length} idea(s) waiting for an approval decision.</div>}
          <div className="pipeline">
            {STAGES.map((s) => (
              <button key={s} className={filter === s ? 'on' : ''} onClick={() => setFilter(filter === s ? null : s)}>
                <b>{ideas.filter((i) => i.stage === s).length}</b>{label(s)}
              </button>
            ))}
          </div>
          <div className="row" style={{ marginBottom: 12 }}>
            <button className="btn" onClick={() => setAdding(true)}>Capture ideas</button>
            <span className="muted small">{filter ? `Showing ${label(filter)} · tap the stage again to clear` : `${ideas.length} idea(s) in total`}</span>
          </div>
          {shown.length === 0 && <div className="card muted">{ideas.length ? 'No ideas at this stage.' : 'No ideas yet. Capture your first one from notes, a web page or a file.'}</div>}
          {shown.map((i) => (
            <button className="card idea" key={i.id} onClick={() => setOpenId(i.id)}>
              <div className="row"><b className="grow">{i.title}</b><span className="muted small">{i.idea_types?.name}</span></div>
              <p className="muted small" style={{ margin: '4px 0 8px' }}>{i.summary}</p>
              <Badges idea={i} />
            </button>
          ))}
        </>
      )}

      {tab === 'portfolio' && (
        <div className="card scroll">
          <h2>Portfolio ranking</h2>
          <p className="muted small">Scored ideas, ordered by judged score weighted by the Judge&apos;s confidence. Ranks update each time the Rank agent runs.</p>
          {ranked.length === 0 ? <p className="muted">No scored ideas yet.</p> : (
            <table>
              <thead><tr><th>Rank</th><th>Idea</th><th>Type</th><th>Score</th><th>Confidence</th><th>Stage</th></tr></thead>
              <tbody>
                {ranked.map((i) => (
                  <tr key={i.id} onClick={() => setOpenId(i.id)} style={{ cursor: 'pointer' }}>
                    <td>{i.rank ?? ''}</td><td><b>{i.title}</b></td><td>{i.idea_types?.name}</td><td>{Math.round(i.score)}</td>
                    <td>{i.confidence != null ? Math.round(i.confidence) : ''}</td>
                    <td>{label(i.stage)}{i.status !== 'active' ? ` · ${label(i.status)}` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'types' && org && <Types org={org} role={role} types={types} reload={load} />}

      {adding && (
        <NewIdea
          onClose={() => setAdding(false)}
          onDone={(created) => { setAdding(false); setNotice(`Captured ${created.length} idea(s): ${created.map((c) => c.title).join('; ')}`); load(); }}
        />
      )}
    </div>
  );
}
