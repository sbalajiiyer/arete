'use client';
import { useCallback, useEffect, useState } from 'react';
import { supabase, when } from '../../lib/client';
import { DEFAULT_SETTINGS } from '../../lib/defaults';

const ROLES = [
  ['submitter', 'Submitter', 'Captures ideas and follows their own'],
  ['member', 'Analyst', 'Runs the agents on any idea and posts progress updates'],
  ['approver', 'Approver', 'Everything an analyst can, plus approve, return or reject'],
  ['admin', 'Admin', 'Everything, plus team, idea types and How it works settings'],
];
const roleName = (r) => ROLES.find((x) => x[0] === r)?.[1] || r;

export default function Team() {
  const [session, setSession] = useState(undefined);
  const [d, setD] = useState(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('submitter');
  const [hook, setHook] = useState('');
  const [selfBlock, setSelfBlock] = useState(false);
  const [newKey, setNewKey] = useState(null);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, x) => setSession(x));
    return () => sub.subscription.unsubscribe();
  }, []);

  const userId = session?.user?.id;
  const load = useCallback(async () => {
    if (!userId) return;
    const me = await supabase.from('org_members').select('role, orgs(id, name)').eq('user_id', userId).limit(1).maybeSingle();
    const [members, invites, st, key] = await Promise.all([
      supabase.from('org_members').select('user_id, email, role, created_at').order('created_at'),
      supabase.from('invitations').select('*').is('accepted_at', null).order('created_at', { ascending: false }),
      supabase.from('org_settings').select('settings').maybeSingle(),
      supabase.from('intake_keys').select('created_at').maybeSingle(),
    ]);
    const settings = { ...DEFAULT_SETTINGS, ...(st.data?.settings || {}) };
    setD({ org: me.data?.orgs, role: me.data?.role, members: members.data || [], invites: invites.data || [], settings, keyAt: key.data?.created_at });
    setHook(settings.webhook_url || '');
    setSelfBlock(!!settings.block_self_approval);
  }, [userId]);
  useEffect(() => { load(); }, [load]);

  if (session === undefined) return <div className="wrap"><p className="muted">Loading…</p></div>;
  if (!session) return <div className="wrap"><div className="card">Please <a href="/">sign in</a> first, then come back to this page.</div></div>;
  if (!d?.org) return <div className="wrap"><p className="muted">Loading…</p></div>;

  const admin = d.role === 'admin';
  const flash = (text, err) => { setMsg({ text, err }); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const done = (error, ok) => { if (error) flash(error.message, true); else { flash(ok); load(); } };
  const link = (inv) => `${window.location.origin}/?invite=${inv.token}`;
  const log = (area, before, after) => supabase.from('config_changes').insert({ org_id: d.org.id, area, before, after });

  async function invite(e) {
    e.preventDefault();
    const address = email.trim().toLowerCase();
    if (d.members.some((m) => (m.email || '').toLowerCase() === address)) return flash('That person is already in this workspace.', true);
    const { error } = await supabase.from('invitations').insert({ org_id: d.org.id, email: address, role });
    if (!error) { await log('Team: invited', null, { email: address, role }); setEmail(''); }
    done(error, `Invitation created for ${address}. Copy the link below and send it to them; Arete does not send email yet.`);
  }
  async function copy(inv) {
    try { await navigator.clipboard.writeText(link(inv)); flash('Invitation link copied.'); } catch { flash(link(inv)); }
  }
  async function changeRole(m, next) {
    const { error } = await supabase.from('org_members').update({ role: next }).eq('org_id', d.org.id).eq('user_id', m.user_id);
    if (!error) await log('Team: role changed', { email: m.email, role: m.role }, { email: m.email, role: next });
    done(error, `${m.email || 'Member'} is now ${roleName(next)}.`);
  }
  async function remove(m) {
    if (!window.confirm(`Remove ${m.email || 'this member'} from ${d.org.name}?`)) return;
    const { error } = await supabase.from('org_members').delete().eq('org_id', d.org.id).eq('user_id', m.user_id);
    if (!error) await log('Team: member removed', { email: m.email, role: m.role }, null);
    done(error, 'Member removed.');
  }
  async function revoke(inv) {
    const { error } = await supabase.from('invitations').delete().eq('id', inv.id);
    done(error, 'Invitation revoked.');
  }
  async function saveSettings() {
    const url = hook.trim();
    if (url && !/^https:\/\/(hooks\.slack\.com|[^/]+\.(webhook\.office\.com|logic\.azure\.com|powerplatform\.com))(\/|:)/.test(url)) return flash('Use a Slack incoming webhook or a Microsoft Teams workflow webhook address.', true);
    const next = { ...d.settings, webhook_url: url, block_self_approval: selfBlock };
    const { error } = await supabase.from('org_settings').upsert({ org_id: d.org.id, settings: next, updated_at: new Date().toISOString() });
    if (!error) await log('Workspace settings', { webhook: !!d.settings.webhook_url, block_self_approval: d.settings.block_self_approval }, { webhook: !!url, block_self_approval: selfBlock });
    done(error, 'Workspace settings saved.');
  }
  async function rotate() {
    if (d.keyAt && !window.confirm('Creating a new key stops the old one working. Continue?')) return;
    const { data, error } = await supabase.rpc('rotate_intake_key');
    if (error) return flash(error.message, true);
    setNewKey(data);
    load();
  }

  return (
    <div className="wrap">
      <h1>Team</h1>
      <p className="muted">{d.org.name}. {admin ? 'Invite people, set what each can do, and connect alerts and intake.' : 'Only admins can change the team.'}</p>
      {msg && <div className={msg.err ? 'err' : 'note'} style={{ wordBreak: 'break-all' }}>{msg.text}</div>}

      <div className="card scroll">
        <h2>Members ({d.members.length})</h2>
        <table>
          <thead><tr><th>Person</th><th>Role</th><th>Joined</th><th></th></tr></thead>
          <tbody>
            {d.members.map((m) => (
              <tr key={m.user_id}>
                <td>{m.email || 'Unknown'}{m.user_id === userId ? ' (you)' : ''}</td>
                <td>{admin && m.user_id !== userId ? (
                  <select value={m.role} onChange={(e) => changeRole(m, e.target.value)} style={{ minWidth: 110 }}>{ROLES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                ) : roleName(m.role)}</td>
                <td className="small muted">{when(m.created_at)}</td>
                <td>{admin && m.user_id !== userId && <button className="btn danger" style={{ padding: '2px 8px' }} onClick={() => remove(m)}>Remove</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="out" style={{ marginTop: 10 }}><dl>{ROLES.map(([k, l, what]) => <div key={k}><dt>{l}</dt><dd>{what}</dd></div>)}</dl></div>
      </div>

      {admin && (
        <div className="card">
          <h2>Invite someone</h2>
          <form onSubmit={invite}>
            <label>Email</label>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            <label>Role</label>
            <select value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.map(([k, l, what]) => <option key={k} value={k}>{l}: {what}</option>)}</select>
            <div style={{ marginTop: 12 }}><button className="btn">Create invitation</button></div>
          </form>
          <p className="small muted" style={{ marginTop: 10 }}>The invitation is tied to that email address and lasts 7 days. If they are new, they join this workspace when they create their account with that address.</p>
          {d.invites.length > 0 && <h3 style={{ marginTop: 12 }}>Pending invitations</h3>}
          {d.invites.map((inv) => (
            <div className="row" key={inv.id} style={{ marginBottom: 8 }}>
              <span className="grow">{inv.email} · {roleName(inv.role)} <span className="small muted">· expires {when(inv.expires_at)}</span></span>
              <button className="btn ghost" style={{ padding: '2px 8px' }} onClick={() => copy(inv)}>Copy link</button>
              <button className="btn danger" style={{ padding: '2px 8px' }} onClick={() => revoke(inv)}>Revoke</button>
            </div>
          ))}
        </div>
      )}

      {admin && (
        <div className="card">
          <h2>Alerts and approvals</h2>
          <p className="small muted">Everyone gets alerts in their Arete inbox. Add a webhook to also post them to a Teams or Slack channel.</p>
          <label>Teams workflow or Slack incoming webhook address</label>
          <input type="url" placeholder="https://" value={hook} onChange={(e) => setHook(e.target.value)} />
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--ink)', fontSize: 15, marginTop: 14 }}>
            <input type="checkbox" checked={selfBlock} onChange={(e) => setSelfBlock(e.target.checked)} style={{ width: 'auto' }} />
            Stop people deciding on ideas they submitted themselves
          </label>
          <div style={{ marginTop: 12 }}><button className="btn" onClick={saveSettings}>Save</button></div>
        </div>
      )}

      {admin && (
        <div className="card">
          <h2>Intake from other tools</h2>
          <p>Any tool that can send a web request can submit raw text to this workspace: a Teams workflow, an email forwarding rule, a form. The Capture agent turns it into idea records and analysts are alerted.</p>
          <p className="small muted">{d.keyAt ? `An intake key was created ${when(d.keyAt)}. It cannot be shown again.` : 'No intake key yet.'}</p>
          <button className="btn" onClick={rotate}>{d.keyAt ? 'Replace the intake key' : 'Create an intake key'}</button>
          {newKey && (
            <div className="note" style={{ marginTop: 12, wordBreak: 'break-all' }}>
              <b>Copy this key now. It will not be shown again.</b>
              <p className="mono" style={{ minHeight: 0, margin: '8px 0' }}>{newKey}</p>
              <p className="small" style={{ margin: 0 }}>Send a POST request to <b>{window.location.origin}/api/intake</b> with the header <b>x-intake-key</b> set to the key and a JSON body such as {'{"text": "the request", "sender": "name or email", "subject": "optional"}'}.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
