// In-app notifications plus an optional Teams or Slack webhook. Never throws: a failed alert must not fail the agent run.

const WEBHOOK_HOSTS = ['hooks.slack.com', '.webhook.office.com', '.logic.azure.com', '.powerplatform.com'];

export function webhookAllowed(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && WEBHOOK_HOSTS.some((h) => (h.startsWith('.') ? u.hostname.endsWith(h) : u.hostname === h));
  } catch {
    return false;
  }
}

async function postWebhook(url, title, body, link) {
  if (!webhookAllowed(url)) return;
  const text = `${title}\n${body}\n${link}`;
  const payload = new URL(url).hostname === 'hooks.slack.com'
    ? { text }
    : { type: 'message', text, attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: { type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', weight: 'Bolder', wrap: true, text: title }, { type: 'TextBlock', wrap: true, text: body }], actions: [{ type: 'Action.OpenUrl', title: 'Open in Arete', url: link }] } }] };
  await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) });
}

// to = { roles: ['admin','approver'], users: [uuid] }. The person who triggered the event is not notified.
export async function notify(ctx, idea, kind, title, body, to, origin) {
  try {
    const ids = new Set((to.users || []).filter(Boolean));
    if (to.roles?.length) {
      const { data } = await ctx.supabase.from('org_members').select('user_id').eq('org_id', idea.org_id).in('role', to.roles);
      for (const m of data || []) ids.add(m.user_id);
    }
    ids.delete(ctx.user.id);
    const text = String(body || '').slice(0, 600);
    if (ids.size) {
      const { error } = await ctx.supabase.from('notifications').insert([...ids].map((user_id) => ({ org_id: idea.org_id, user_id, idea_id: idea.id, kind, title, body: text })));
      if (error) console.error('notify insert failed', error.message);
    }
    const { data: s } = await ctx.supabase.from('org_settings').select('settings').eq('org_id', idea.org_id).maybeSingle();
    if (s?.settings?.webhook_url) await postWebhook(s.settings.webhook_url, title, text, `${origin || ''}/?idea=${idea.id}`);
  } catch (e) {
    console.error('notify failed', e?.message);
  }
}
