'use client';
import { useCallback, useEffect, useState } from 'react';
import { supabase, api, when } from '../../lib/client';

const SAMPLE = `title,case,result
Warehouse robotics rollout,"Automate picking at the Leeds distribution centre with 40 mobile robots. Supplier quote of 3.1m covers robots, software and installation. Pilot at one aisle ran for 8 weeks and measured a 22% rise in picks per hour. Payback in 2.6 years on measured labour savings. Site power survey complete.",success
Global CRM replacement,"Replace five regional CRM systems with one platform in 9 months. Budget 4m, based on the vendor's first estimate. Sales teams are expected to adopt the new process at once. Data migration is assumed to be simple. Benefits of 12m a year from better cross-selling, source not stated.",failed
Customer self-service portal,"Build a portal so customers can track orders and raise claims. Expected to cut call volume by 60% in year one, based on a competitor's press release. Cost 900k using the in-house team, who are also committed to two other programmes. No customer research yet.",partial
Energy sub-metering at three plants,"Install sub-meters on the 30 largest machines at three plants to find waste. Fixed-price quote of 240k. A trial on one line found 9% avoidable use, measured over a quarter. Savings estimated at 310k a year from the trial figure. Plant managers have signed off downtime windows.",success
AI demand forecasting,"Use machine learning to forecast demand for all 18,000 products and cut inventory by 30%. No baseline accuracy has been measured. Data sits in four systems with different product codes. Delivery in 6 months by a team to be hired. Budget 1.5m is a top-down allocation.",failed`;

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const at = (names) => head.findIndex((h) => names.includes(h));
  const [t, c, r] = [at(['title', 'project', 'name']), at(['case', 'description', 'business case', 'summary']), at(['result', 'outcome', 'actual'])];
  if (t < 0 || c < 0 || r < 0) return [];
  return rows.slice(1).map((x) => ({ title: (x[t] || '').trim(), case: (x[c] || '').trim(), actual: (x[r] || '').trim().toLowerCase() }));
}

// A project counts as flagged when the Judge would not have let it straight through.
const flagged = (r) => r.verdict !== 'proceed' || Number(r.confidence) < 60;
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : 'n/a');
const fmt = (n, signed) => (typeof n === 'number' ? `${signed && n > 0 ? '+' : ''}${n}%` : 'not known');

function trackOf(ideas) {
  const o = ideas.map((i) => i.record?.outcome).filter(Boolean);
  const avg = (k) => {
    const v = o.map((x) => x[k]).filter((n) => typeof n === 'number');
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  return { n: o.length, cost: avg('cost_variance_pct'), time: avg('schedule_variance_pct'), benefit: avg('benefit_realized_pct') };
}

export default function Backtest() {
  const [session, setSession] = useState(undefined);
  const [role, setRole] = useState(null);
  const [text, setText] = useState('');
  const [runs, setRuns] = useState([]);
  const [closed, setClosed] = useState([]);
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, x) => setSession(x));
    return () => sub.subscription.unsubscribe();
  }, []);

  const userId = session?.user?.id;
  const load = useCallback(async () => {
    if (!userId) return;
    const [me, br, done] = await Promise.all([
      supabase.from('org_members').select('role').eq('user_id', userId).limit(1).maybeSingle(),
      supabase.from('backtest_runs').select('*').order('created_at', { ascending: false }).limit(200),
      supabase.from('ideas').select('id, title, record, idea_types(name)').eq('status', 'done'),
    ]);
    setRole(me.data?.role || 'submitter');
    setRuns(br.data || []);
    setClosed(done.data || []);
  }, [userId]);
  useEffect(() => { load(); }, [load]);

  if (session === undefined) return <div className="wrap"><p className="muted">Loading…</p></div>;
  if (!session) return <div className="wrap"><div className="card">Please <a href="/">sign in</a> first, then come back to this page.</div></div>;
  if (!role) return <div className="wrap"><p className="muted">Loading…</p></div>;

  const canRun = ['admin', 'member'].includes(role);
  const projects = parseCsv(text);
  const bad = projects.filter((p) => !p.title || p.case.length < 40 || !['success', 'partial', 'failed'].includes(p.actual)).length;

  async function run() {
    setMsg(null);
    const batch = crypto.randomUUID();
    let ok = 0;
    for (let i = 0; i < projects.length; i++) {
      setBusy(`Judging ${i + 1} of ${projects.length}: ${projects[i].title}`);
      try {
        await api('/api/backtest', { ...projects[i], batch });
        ok += 1;
      } catch (e) {
        setMsg({ err: true, text: `Stopped at "${projects[i].title}": ${e.message}` });
        break;
      }
      await load();
      if (i < projects.length - 1) await new Promise((r) => setTimeout(r, 4000));
    }
    setBusy(null);
    if (ok === projects.length) setMsg({ text: `Backtest finished: ${ok} project(s) judged.` });
    load();
  }

  async function updateTrack() {
    setMsg(null);
    try {
      let left = 1;
      while (left > 0) {
        setBusy('Working out results against plan for closed ideas…');
        const r = await api('/api/outcomes', {});
        left = r.updated ? r.remaining : 0;
        await load();
      }
      setMsg({ text: 'Track record is up to date.' });
    } catch (e) {
      setMsg({ err: true, text: e.message });
    }
    setBusy(null);
  }

  const batchId = runs[0]?.batch;
  const latest = runs.filter((r) => r.batch === batchId);
  const trouble = latest.filter((r) => r.actual !== 'success');
  const fine = latest.filter((r) => r.actual === 'success');
  const caught = trouble.filter(flagged).length;
  const alarms = fine.filter(flagged).length;
  const track = trackOf(closed);
  const missing = closed.filter((i) => !i.record?.outcome).length;
  const byType = Object.entries(closed.reduce((a, i) => { (a[i.idea_types?.name || 'Other'] ||= []).push(i); return a; }, {}));

  return (
    <div className="wrap">
      <h2 style={{ margin: '4px 0 4px' }}>Backtest and track record</h2>
      <p className="muted" style={{ marginTop: 0 }}>Two checks on whether the agents can be trusted: how the Judge would have ruled on your past projects, and how your finished ideas turned out against their business cases.</p>
      {msg && <div className={msg.err ? 'err' : 'note'}>{msg.text}</div>}
      {busy && <div className="note">{busy}</div>}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Backtest the Judge on past projects</h3>
        <p className="small muted">Paste past projects as they stood when they were approved, with how each one ended. The Judge reviews each case without being told the result. You then see how many troubled projects it would have flagged, and how many good ones it would have held up.</p>
        {canRun ? (
          <>
            <label>Past projects (CSV with columns: title, case, result. Result is success, partial or failed)</label>
            <textarea className="mono" style={{ minHeight: 160 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="title,case,result" />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="primary" disabled={!!busy || !projects.length || bad > 0} onClick={run}>Run backtest{projects.length ? ` on ${projects.length}` : ''}</button>
              <button disabled={!!busy} onClick={() => setText(SAMPLE)}>Use sample projects</button>
              <input type="file" accept=".csv,text/csv" style={{ width: 'auto' }} onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }} />
            </div>
            {text && !projects.length && <p className="small" style={{ color: 'var(--red)' }}>No rows found. The first line must name the columns: title, case, result.</p>}
            {bad > 0 && <p className="small" style={{ color: 'var(--red)' }}>{bad} row(s) need fixing: each needs a title, a case of at least 40 characters, and a result of success, partial or failed.</p>}
            <p className="small muted">Up to 60 projects a day. Describe the case as it was known at approval. Leave out anything learned afterwards, or the test is not fair.</p>
          </>
        ) : <p className="muted">Only admins and analysts can run a backtest. You can see the results below.</p>}
      </div>

      {latest.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Latest backtest <span className="muted small">· {when(latest[0].created_at)} · {latest.length} project(s)</span></h3>
          <div className="row" style={{ gap: 24, marginBottom: 10 }}>
            <div><b style={{ fontSize: 22 }}>{pct(caught, trouble.length)}</b><div className="small muted">Troubled projects flagged ({caught} of {trouble.length})</div></div>
            <div><b style={{ fontSize: 22 }}>{pct(alarms, fine.length)}</b><div className="small muted">Good projects held up ({alarms} of {fine.length})</div></div>
          </div>
          <p className="small muted">Flagged means the Judge said revise or reject, or gave confidence under 60. With few projects these rates are rough; 20 or more gives a fairer picture.</p>
          <div className="scroll">
            <table>
              <thead><tr><th>Project</th><th>What happened</th><th>Judge said</th><th>Confidence</th><th>Main concerns</th></tr></thead>
              <tbody>
                {latest.map((r) => (
                  <tr key={r.id}>
                    <td>{r.title}</td>
                    <td>{r.actual}</td>
                    <td>{r.verdict}{flagged(r) === (r.actual !== 'success') ? ' ✓' : ' ✗'}</td>
                    <td>{r.confidence}</td>
                    <td className="small">{(r.concerns || []).slice(0, 2).join(' · ') || 'None'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Track record of finished ideas</h3>
        <p className="small muted">When an idea is closed, the Watch agent works out cost, schedule and benefits against the approved case. These averages are given to the Evaluate and Judge agents, so new cases are tempered by how past ones really went.</p>
        {track.n === 0 ? <p className="muted">No finished ideas have a recorded result yet.</p> : (
          <div className="scroll">
            <table>
              <thead><tr><th>Idea type</th><th>Finished ideas</th><th>Cost against plan</th><th>Schedule against plan</th><th>Benefits delivered</th></tr></thead>
              <tbody>
                {[['All types', closed], ...byType].map(([name, list]) => {
                  const t = trackOf(list);
                  return t.n ? <tr key={name}><td>{name}</td><td>{t.n}</td><td>{fmt(t.cost, true)}</td><td>{fmt(t.time, true)}</td><td>{fmt(t.benefit)}</td></tr> : null;
                })}
              </tbody>
            </table>
          </div>
        )}
        {missing > 0 && canRun && <div className="row" style={{ marginTop: 8 }}><button disabled={!!busy} onClick={updateTrack}>Work out results for {missing} finished idea(s)</button></div>}
      </div>
    </div>
  );
}
