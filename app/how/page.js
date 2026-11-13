'use client';
import { useCallback, useEffect, useState } from 'react';
import { supabase, api, STAGES, label, when } from '../../lib/client';
import { AGENT_DEFS, FIXED_GUARDRAILS, DEFAULT_SETTINGS } from '../../lib/defaults';

const CASE_COUNTS = { capture: 4, scope: 2, evaluate: 1, judge: 2, rank: 1, commit: 1, watch: 2 };
const lines = (t) => t.split('\n').map((x) => x.trim()).filter(Boolean);
const List = ({ items }) => <ul style={{ margin: '2px 0 8px', paddingLeft: 18 }}>{items.map((x, i) => <li key={i}>{x}</li>)}</ul>;
const H3 = ({ children }) => <h3 style={{ marginTop: 12 }}>{children}</h3>;

function AgentCard({ stage, n, row, admin, save, ev, runs }) {
  const def = AGENT_DEFS[stage];
  const savedIns = row?.instructions || def.instructions;
  const savedRules = (row?.rules || []).join('\n');
  const [ins, setIns] = useState(savedIns);
  const [rules, setRules] = useState(savedRules);
  useEffect(() => { setIns(savedIns); setRules(savedRules); }, [savedIns, savedRules]);
  const dirty = ins !== savedIns || rules !== savedRules;
  return (
    <div className="card">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>{n}. {def.name}</h2>
        {row && <span className="badge amber">Customized</span>}
        {ev && <span className={`badge ${ev.passed === ev.total ? 'green' : 'red'}`}>Evals {ev.passed}/{ev.total}</span>}
        <span className="badge">{runs || 0} runs</span>
      </div>
      <p style={{ marginTop: 6 }}>{def.purpose}</p>
      <details>
        <summary className="small" style={{ cursor: 'pointer', color: 'var(--accent)' }}>Details, instructions and rules</summary>
        <H3>Memory it reads</H3><List items={def.reads} />
        <H3>What it writes to the idea record</H3><List items={def.writes} />
        <H3>Fixed rules (enforced in code, not editable)</H3><List items={def.fixed} />
        <label>Instructions (the agent's standing brief)</label>
        <textarea value={ins} readOnly={!admin} onChange={(e) => setIns(e.target.value)} style={{ minHeight: 150 }} />
        <label>Workspace rules for this agent, one per line</label>
        <textarea value={rules} readOnly={!admin} onChange={(e) => setRules(e.target.value)} style={{ minHeight: 70 }} placeholder="Example: Always state the payback period in months." />
        {admin && (
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn" disabled={!dirty} onClick={() => save(stage, ins, lines(rules))}>Save</button>
            {row && <button className="btn ghost" onClick={() => save(stage, def.instructions, [])}>Reset to default</button>}
          </div>
        )}
      </details>
    </div>
  );
}

export default function How() {
  const [session, setSession] = useState(undefined);
  const [d, setD] = useState(null);
  const [s, setS] = useState(DEFAULT_SETTINGS);
  const [guards, setGuards] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState(null);
  const [evalBusy, setEvalBusy] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, x) => setSession(x));
    return () => sub.subscription.unsubscribe();
  }, []);

  const userId = session?.user?.id;
  const load = useCallback(async () => {
    if (!userId) return;
    const [m, a, st, mem, ev, runs, judge, wu, ch] = await Promise.all([
      supabase.from('org_members').select('role, orgs(id, name)').eq('user_id', userId).limit(1).maybeSingle(),
      supabase.from('agent_configs').select('*'),
      supabase.from('org_settings').select('settings').maybeSingle(),
      supabase.from('org_memory').select('*').order('created_at'),
      supabase.from('eval_runs').select('*').order('created_at', { ascending: false }).limit(60),
      supabase.from('stage_runs').select('stage, agent').limit(5000),
      supabase.from('stage_runs').select('output').eq('stage', 'judge').order('created_at', { ascending: false }).limit(40),
      supabase.from('watch_updates').select('rag, escalate, assessment, ideas(title)').order('created_at', { ascending: false }).limit(60),
      supabase.from('config_changes').select('*').order('created_at', { ascending: false }).limit(15),
    ]);
    const settings = { ...DEFAULT_SETTINGS, ...(st.data?.settings || {}) };
    const latest = {};
    for (const r of ev.data || []) if (!latest[r.stage]) latest[r.stage] = r;
    const counts = {};
    for (const r of runs.data || []) if (!/^Human/.test(r.agent)) counts[r.stage] = (counts[r.stage] || 0) + 1;
    setD({ org: m.data?.orgs, role: m.data?.role, cfgs: Object.fromEntries((a.data || []).map((r) => [r.stage, r])), settings, memory: mem.data || [], evals: latest, counts, judge: (judge.data || []).map((r) => r.output), updates: wu.data || [], changes: ch.data || [] });
    setS(settings);
    setGuards(settings.guardrails.join('\n'));
  }, [userId]);
  useEffect(() => { load(); }, [load]);

  if (session === undefined) return <div className="wrap"><p className="muted">Loading…</p></div>;
  if (!session) return <div className="wrap"><div className="card">Please <a href="/">sign in</a> first, then come back to this page.</div></div>;
  if (!d?.org) return <div className="wrap"><p className="muted">Loading…</p></div>;

  const admin = d.role === 'admin';
  const flash = (text, err) => { setMsg({ text, err }); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const logChange = (area, before, after) => supabase.from('config_changes').insert({ org_id: d.org.id, area, before, after });

  async function saveAgent(stage, instructions, rules) {
    const def = AGENT_DEFS[stage];
    const text = instructions.trim();
    if (text.length < 40) return flash('Instructions are too short to be a usable brief.', true);
    const before = d.cfgs[stage] ? { instructions: d.cfgs[stage].instructions, rules: d.cfgs[stage].rules } : null;
    const isDefault = text === def.instructions && !rules.length;
    const after = isDefault ? null : { instructions: text === def.instructions ? null : text, rules };
    const { error } = isDefault
      ? await supabase.from('agent_configs').delete().eq('org_id', d.org.id).eq('stage', stage)
      : await supabase.from('agent_configs').upsert({ org_id: d.org.id, stage, ...after, updated_at: new Date().toISOString() });
    if (error) return flash(error.message, true);
    await logChange(`Agent: ${def.name}`, before, after);
    flash(`${def.name} ${isDefault ? 'reset to default' : 'saved'}. The change applies from its next run. Re-run the evals to check its score.`);
    load();
  }

  async function saveSettings(area, next) {
    const clean = { ...next, confidence_weight: Math.min(1, Math.max(0, Number(next.confidence_weight) || 0)), min_confidence_for_commit: Math.min(100, Math.max(0, Math.round(Number(next.min_confidence_for_commit) || 0))), watch_tolerance_pct: Math.min(50, Math.max(0, Math.round(Number(next.watch_tolerance_pct) || 0))) };
    const { error } = await supabase.from('org_settings').upsert({ org_id: d.org.id, settings: clean, updated_at: new Date().toISOString() });
    if (error) return flash(error.message, true);
    await logChange(area, d.settings, clean);
    flash(`${area} saved. The change applies from the next agent run.`);
    load();
  }

  async function addNote() {
    const text = note.trim();
    if (text.length < 3) return;
    const { error } = await supabase.from('org_memory').insert({ org_id: d.org.id, note: text });
    if (error) return flash(error.message, true);
    await logChange('Memory: note added', null, { note: text });
    setNote('');
    load();
  }
  async function removeNote(n) {
    const { error } = await supabase.from('org_memory').delete().eq('id', n.id);
    if (error) return flash(error.message, true);
    await logChange('Memory: note removed', { note: n.note }, null);
    load();
  }

  async function runAllEvals() {
    setMsg(null);
    for (const stage of STAGES) {
      setEvalBusy(stage);
      try {
        await api('/api/evals', { stage });
      } catch (e) {
        setEvalBusy(null);
        load();
        return flash(`Evals stopped at the ${AGENT_DEFS[stage].name}: ${e.message}`, true);
      }
      await load();
    }
    setEvalBusy(null);
  }

  const j = d.judge.filter((o) => o?.evaluate_score != null && o?.score != null);
  const avgCut = j.length ? Math.round(j.reduce((t, o) => t + (o.evaluate_score - o.score), 0) / j.length) : null;
  const verdicts = d.judge.reduce((t, o) => ({ ...t, [o?.verdict]: (t[o?.verdict] || 0) + 1 }), {});
  const rag = d.updates.reduce((t, u) => ({ ...t, [u.rag]: (t[u.rag] || 0) + 1 }), {});
  const lessons = d.updates.flatMap((u) => (u.assessment?.lessons || []).map((l) => `${l} (from "${u.ideas?.title}")`));
  const evalRows = STAGES.map((st) => d.evals[st]).filter(Boolean);
  const passed = evalRows.reduce((t, r) => t + r.passed, 0);
  const total = evalRows.reduce((t, r) => t + r.total, 0);
  const set = (k) => (e) => setS({ ...s, [k]: e.target.value });

  return (
    <div className="wrap">
      <h1>How it works</h1>
      <p className="muted">{d.org.name}. This page is the live configuration of the system, not a description of it. {admin ? 'Anything you save here changes how the agents behave from their next run.' : 'Only workspace admins can change it.'}</p>
      {msg && <div className={msg.err ? 'err' : 'note'}>{msg.text}</div>}

      <div className="card">
        <h2>The flow</h2>
        <p>An idea moves through up to seven stages. Each stage has one agent with a narrow job. Every agent reads the shared idea record, adds its part, and logs what it did. The idea type decides which stages apply. A person decides at Commit.</p>
        <p className="small muted" style={{ margin: 0 }}>{STAGES.map(label).join(' → ')}</p>
      </div>

      <h2 style={{ margin: '18px 0 10px' }}>Agents</h2>
      {STAGES.map((st, i) => <AgentCard key={st} stage={st} n={i + 1} row={d.cfgs[st]} admin={admin} save={saveAgent} ev={d.evals[st]} runs={d.counts[st]} />)}

      <div className="card">
        <h2>Governance</h2>
        <H3>Fixed</H3>
        <List items={['Approval, rejection and return for rework are decided by a person with the admin or approver role.', 'Each idea type sets its own stages, scoring criteria, weights and approver (see Idea types on the Pipeline page).', 'Score = weighted average of 1 to 5 criterion scores, scaled to 100. The Judge\'s scores replace the Evaluate agent\'s.', 'Configuration can only be changed by an admin, and every change is recorded below.']} />
        <H3>Settings</H3>
        <label>When does a progress update escalate to the approver?</label>
        <select value={s.escalate_on} disabled={!admin} onChange={set('escalate_on')}>
          <option value="agent">The Watch agent decides (never on a green update)</option>
          <option value="red">Only when the status is red</option>
          <option value="amber">Whenever the status is amber or red</option>
        </select>
        <label>When the Scope agent finds a duplicate</label>
        <select value={s.duplicate_action} disabled={!admin} onChange={set('duplicate_action')}>
          <option value="block">Stop the idea until a person reviews it</option>
          <option value="flag">Record the finding and let the idea continue</option>
        </select>
        <label>How much the Judge's confidence discounts the score when ranking (0 = not at all, 1 = fully)</label>
        <input type="number" min="0" max="1" step="0.1" value={s.confidence_weight} disabled={!admin} onChange={set('confidence_weight')} style={{ maxWidth: 120 }} />
        <label>Minimum Judge confidence (0 to 100) before a decision pack can be prepared. 0 turns this off.</label>
        <input type="number" min="0" max="100" value={s.min_confidence_for_commit} disabled={!admin} onChange={set('min_confidence_for_commit')} style={{ maxWidth: 120 }} />
        <label>On-track tolerance for the Watch agent: percent away from plan that still counts as green</label>
        <input type="number" min="0" max="50" value={s.watch_tolerance_pct} disabled={!admin} onChange={set('watch_tolerance_pct')} style={{ maxWidth: 120 }} />
        {admin && <div style={{ marginTop: 12 }}><button className="btn" onClick={() => saveSettings('Governance', { ...s, guardrails: d.settings.guardrails })}>Save governance settings</button></div>}
      </div>

      <div className="card">
        <h2>Guardrails</h2>
        <H3>Built in (enforced in code or always added to every agent, not editable)</H3>
        <List items={FIXED_GUARDRAILS} />
        <H3>Workspace guardrails</H3>
        <p className="small muted">One per line. These are added to every agent's instructions.</p>
        <textarea value={guards} readOnly={!admin} onChange={(e) => setGuards(e.target.value)} style={{ minHeight: 90 }} placeholder="Example: Never recommend reducing safety or compliance staffing." />
        {admin && <div style={{ marginTop: 10 }}><button className="btn" onClick={() => saveSettings('Guardrails', { ...d.settings, guardrails: lines(guards).slice(0, 20) })}>Save workspace guardrails</button></div>}
      </div>

      <div className="card">
        <h2>Memory</h2>
        <List items={['Idea record: each agent reads what the earlier agents wrote on the same idea. Nothing is carried in an agent between runs.', 'Portfolio: the Scope and Rank agents see the titles, summaries and scores of the other ideas in this workspace.', 'Lessons learned: lessons the Watch agent records on tracked and closed ideas are given to the Scope and Evaluate agents on every new idea.', 'Workspace knowledge: the notes below are given to the Scope and Evaluate agents alongside the lessons.']} />
        <H3>Workspace knowledge ({d.memory.length})</H3>
        {d.memory.map((n) => (
          <div className="row" key={n.id} style={{ marginBottom: 6, alignItems: 'flex-start' }}>
            <span className="grow">{n.note}</span>
            {admin && <button className="btn danger" style={{ padding: '2px 8px' }} onClick={() => removeNote(n)}>Remove</button>}
          </div>
        ))}
        {admin && (
          <>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} style={{ minHeight: 60 }} placeholder="Example: Our hurdle rate is a 24 month payback. ERP integrations here have always taken at least twice the vendor estimate." />
            <div style={{ marginTop: 8 }}><button className="btn" onClick={addNote}>Add note</button></div>
          </>
        )}
        <H3>Lessons learned so far ({lessons.length})</H3>
        {lessons.length ? <details><summary className="small" style={{ cursor: 'pointer', color: 'var(--accent)' }}>Show lessons</summary><List items={lessons.slice(0, 40)} /></details> : <p className="muted small">None yet. They appear once tracked ideas receive progress updates.</p>}
      </div>

      <div className="card">
        <h2>Evals</h2>
        <p>Thirteen fixed test cases with pass or fail checks written in code. They run the agents with this workspace's current instructions, rules and guardrails, so you can edit an agent and see whether its score holds.</p>
        <p><b>{total ? `Latest score: ${passed} of ${total} passed` : 'Not run yet in this workspace.'}</b></p>
        <div className="scroll">
          <table>
            <thead><tr><th>Agent</th><th>Cases</th><th>Latest</th><th>Run</th></tr></thead>
            <tbody>
              {STAGES.map((st) => {
                const r = d.evals[st];
                return (
                  <tr key={st}>
                    <td>{AGENT_DEFS[st].name}{evalBusy === st ? ' (running…)' : ''}</td>
                    <td>{CASE_COUNTS[st]}</td>
                    <td>{r ? <span className={`badge ${r.passed === r.total ? 'green' : 'red'}`}>{r.passed}/{r.total}</span> : ''}</td>
                    <td className="small muted">{r ? `${when(r.created_at)}${r.customized ? ' · customized' : ''}` : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {evalRows.length > 0 && (
          <details style={{ marginTop: 8 }}>
            <summary className="small" style={{ cursor: 'pointer', color: 'var(--accent)' }}>Case-by-case results</summary>
            {evalRows.map((r) => r.details.map((c, i) => (
              <p key={r.id + i} className="small" style={{ margin: '6px 0' }}><span className={`badge ${c.pass ? 'green' : 'red'}`}>{c.pass ? 'Pass' : 'Fail'}</span> <b>{AGENT_DEFS[r.stage].name}:</b> {c.name}. <span className="muted">{c.detail}</span></p>
            )))}
          </details>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" disabled={!!evalBusy} onClick={runAllEvals}>{evalBusy ? 'Running evals…' : 'Run all evals'}</button>
          <span className="small muted">Makes 13 agent calls and takes a minute or two.</span>
        </div>
        <H3>From real use in this workspace</H3>
        <List items={[
          `Judge: ${d.judge.length} recent reviews${avgCut != null ? `, cutting the Evaluate score by ${avgCut} points on average` : ''}. Verdicts: ${Object.entries(verdicts).map(([k, v]) => `${v} ${k}`).join(', ') || 'none yet'}.`,
          `Watch: ${d.updates.length} progress updates assessed: ${rag.green || 0} green, ${rag.amber || 0} amber, ${rag.red || 0} red; ${d.updates.filter((u) => u.escalate).length} escalated.`,
        ]} />
      </div>

      <div className="card">
        <h2>Change history</h2>
        {d.changes.length === 0 && <p className="muted small">No configuration changes yet. This workspace is running on defaults.</p>}
        {d.changes.map((c) => (
          <p key={c.id} className="small" style={{ margin: '6px 0' }}><b>{c.area}</b> {c.after === null ? 'reset or removed' : 'changed'} by {c.changed_by_email || 'an admin'} · <span className="muted">{when(c.created_at)}</span></p>
        ))}
      </div>
    </div>
  );
}
